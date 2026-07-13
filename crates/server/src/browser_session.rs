//! Live browser sessions for the browser pane.
//!
//! Each session owns a dedicated Chrome (via the [`browser`] engine), an event
//! pump that turns CDP `Page.screencastFrame`/navigation events into
//! [`BrowserOutbound`] messages, and a broadcast channel the WebSocket layer
//! paints from. Emulation-free:
//! the engine streams JPEG frames produced by Chrome itself, so the renderer
//! only paints pixels and maps pointer coordinates — it never speaks CDP.
//!
//! Each connection owns its own session (no reattach yet):
//! socket close → Chrome killed, no orphaned browsers.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

use browser::{
    Browser, CdpEvent, LaunchConfig, MouseButton, PageState, ScreencastMetadata, TabInfo,
};
use thiserror::Error;
use tokio::{
    sync::{broadcast, Mutex},
    task::JoinHandle,
};
use uuid::Uuid;

const OUTBOUND_BROADCAST_CAPACITY: usize = 256;
const DEFAULT_QUALITY: u32 = 70;

/// Outbound event from the session, broadcast to every connected viewer. The
/// WebSocket layer maps these to its own wire frames, so this type carries no
/// serialization of its own — `Clone` for the broadcast channel is all it owes.
#[derive(Debug, Clone)]
pub enum BrowserOutbound {
    /// A screencast frame: base64 JPEG plus the geometry needed to map clicks.
    Frame {
        data: String,
        metadata: ScreencastMetadata,
    },
    /// The attached page's address changed (navigation, tab switch).
    State(PageState),
    /// The tab list, in reply to a `list_tabs` request or after a tab mutation.
    Tabs(Vec<TabInfo>),
}

#[derive(Debug, Error)]
pub enum BrowserSessionError {
    #[error("browser session not found: {0}")]
    NotFound(Uuid),
    #[error(transparent)]
    Engine(#[from] browser::BrowserError),
}

/// Screencast dimensions, remembered so a tab switch or resize can restart the
/// stream at the right size.
#[derive(Debug, Clone, Copy)]
struct ScreencastDims {
    width: u32,
    height: u32,
    quality: u32,
}

/// How to start a browser session.
#[derive(Debug, Clone)]
pub struct BrowserSpawnConfig {
    /// Base directory under which a per-session profile is created. Each
    /// session gets its own subdirectory: Chrome refuses to run two processes
    /// against one `--user-data-dir`, so a shared profile would make the second
    /// browser tab fail or hijack the first.
    pub profile_base_dir: PathBuf,
    pub headless: bool,
    pub start_url: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// Public handle to a live browser session.
pub struct BrowserSession {
    id: Uuid,
    browser: Arc<Browser>,
    outbound_tx: broadcast::Sender<BrowserOutbound>,
    dims: Arc<StdMutex<ScreencastDims>>,
    /// This session's private profile dir, removed on shutdown.
    profile_dir: PathBuf,
    pump_task: StdMutex<Option<JoinHandle<()>>>,
}

impl BrowserSession {
    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BrowserOutbound> {
        self.outbound_tx.subscribe()
    }

    /// The attached page's current address — painted immediately on connect.
    pub async fn page_state(&self) -> Result<PageState, BrowserSessionError> {
        Ok(self.browser.page_state().await?)
    }

    pub async fn navigate(&self, url: &str) -> Result<(), BrowserSessionError> {
        self.browser.navigate(url).await?;
        Ok(())
    }

    pub async fn go_back(&self) -> Result<(), BrowserSessionError> {
        self.browser.go_back().await?;
        Ok(())
    }

    pub async fn go_forward(&self) -> Result<(), BrowserSessionError> {
        self.browser.go_forward().await?;
        Ok(())
    }

    pub async fn click(
        &self,
        x: f64,
        y: f64,
        button: MouseButton,
        clicks: u32,
    ) -> Result<(), BrowserSessionError> {
        self.browser.click(x, y, button, clicks).await?;
        Ok(())
    }

    pub async fn type_text(&self, text: &str) -> Result<(), BrowserSessionError> {
        self.browser.type_text(text).await?;
        Ok(())
    }

    pub async fn press_key(&self, key: &str, modifiers: i64) -> Result<(), BrowserSessionError> {
        self.browser.press_key(key, modifiers).await?;
        Ok(())
    }

    pub async fn scroll(
        &self,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    ) -> Result<(), BrowserSessionError> {
        self.browser.scroll(x, y, dx, dy).await?;
        Ok(())
    }

    /// List tabs and broadcast them to every viewer (the reply path for a
    /// `list_tabs` request, which has no dedicated response channel).
    pub async fn broadcast_tabs(&self) -> Result<(), BrowserSessionError> {
        let tabs = self.browser.list_tabs().await?;
        let _ = self.outbound_tx.send(BrowserOutbound::Tabs(tabs));
        Ok(())
    }

    /// Switch tabs and restart the screencast on the newly attached page.
    pub async fn switch_tab(&self, target_id: &str) -> Result<(), BrowserSessionError> {
        self.browser.switch_tab(target_id).await?;
        self.restart_screencast().await?;
        self.broadcast_state().await;
        let _ = self.broadcast_tabs().await;
        Ok(())
    }

    pub async fn new_tab(&self, url: &str) -> Result<String, BrowserSessionError> {
        let target_id = self.browser.new_tab(url).await?;
        self.restart_screencast().await?;
        self.broadcast_state().await;
        let _ = self.broadcast_tabs().await;
        Ok(target_id)
    }

    pub async fn close_tab(&self, target_id: &str) -> Result<(), BrowserSessionError> {
        self.browser.close_tab(target_id).await?;
        let _ = self.broadcast_tabs().await;
        Ok(())
    }

    /// Resize the screencast viewport (restart at new dimensions).
    pub async fn resize(&self, width: u32, height: u32) -> Result<(), BrowserSessionError> {
        {
            let mut dims = self.dims.lock().expect("dims mutex poisoned");
            dims.width = width.max(1);
            dims.height = height.max(1);
        }
        self.restart_screencast().await
    }

    async fn restart_screencast(&self) -> Result<(), BrowserSessionError> {
        let dims = *self.dims.lock().expect("dims mutex poisoned");
        // Stop is best-effort: a fresh page may have no active screencast.
        let _ = self.browser.stop_screencast().await;
        self.browser
            .start_screencast(dims.width, dims.height, dims.quality)
            .await?;
        Ok(())
    }

    async fn broadcast_state(&self) {
        if let Ok(state) = self.browser.page_state().await {
            let _ = self.outbound_tx.send(BrowserOutbound::State(state));
        }
    }

    fn shutdown(&self) {
        if let Ok(mut guard) = self.pump_task.lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }
        self.browser.shutdown();
        // Best-effort cleanup of the per-session profile. Chrome may still hold
        // file handles for a moment; on POSIX the unlink succeeds regardless,
        // and a leftover dir is harmless if it doesn't.
        let _ = std::fs::remove_dir_all(&self.profile_dir);
    }
}

impl Drop for BrowserSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Process-wide registry of live browser sessions.
#[derive(Clone, Default)]
pub struct BrowserService {
    inner: Arc<Mutex<HashMap<Uuid, Arc<BrowserSession>>>>,
}

impl BrowserService {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn create(
        &self,
        config: BrowserSpawnConfig,
    ) -> Result<Arc<BrowserSession>, BrowserSessionError> {
        let id = Uuid::new_v4();
        let profile_dir = config.profile_base_dir.join(id.to_string());

        let browser = Arc::new(
            Browser::launch(LaunchConfig {
                user_data_dir: profile_dir.clone(),
                headless: config.headless,
                start_url: config.start_url,
            })
            .await?,
        );

        let dims = Arc::new(StdMutex::new(ScreencastDims {
            width: config.width.max(1),
            height: config.height.max(1),
            quality: DEFAULT_QUALITY,
        }));
        let (outbound_tx, _) = broadcast::channel(OUTBOUND_BROADCAST_CAPACITY);

        // Begin streaming before wiring the pump so the first frames are already
        // queued in Chrome by the time a subscriber attaches.
        {
            let d = *dims.lock().expect("dims mutex poisoned");
            browser
                .start_screencast(d.width, d.height, d.quality)
                .await?;
        }

        let pump_task = spawn_event_pump(Arc::clone(&browser), outbound_tx.clone());

        let session = Arc::new(BrowserSession {
            id,
            browser,
            outbound_tx,
            dims,
            profile_dir,
            pump_task: StdMutex::new(Some(pump_task)),
        });

        self.inner.lock().await.insert(id, Arc::clone(&session));
        Ok(session)
    }

    pub async fn close(&self, id: Uuid) -> Result<(), BrowserSessionError> {
        match self.inner.lock().await.remove(&id) {
            Some(session) => {
                session.shutdown();
                Ok(())
            }
            None => Err(BrowserSessionError::NotFound(id)),
        }
    }

    /// Drop every live session. Used during graceful shutdown.
    pub async fn shutdown_all(&self) {
        let mut sessions = self.inner.lock().await;
        for session in sessions.values() {
            session.shutdown();
        }
        sessions.clear();
    }
}

/// Translate the CDP event stream into [`BrowserOutbound`] messages: screencast
/// frames (ack'd then broadcast) and navigation (re-query address, broadcast).
fn spawn_event_pump(
    browser: Arc<Browser>,
    outbound_tx: broadcast::Sender<BrowserOutbound>,
) -> JoinHandle<()> {
    let mut events = browser.events();
    tokio::spawn(async move {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            handle_event(&browser, &outbound_tx, event).await;
        }
    })
}

async fn handle_event(
    browser: &Arc<Browser>,
    outbound_tx: &broadcast::Sender<BrowserOutbound>,
    event: CdpEvent,
) {
    // Ignore events from a session we are no longer driving (background tab).
    if event
        .session_id
        .as_deref()
        .is_some_and(|sid| sid != browser.session_id())
    {
        return;
    }

    match event.method.as_str() {
        "Page.screencastFrame" => {
            let data = event
                .params
                .get("data")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let metadata = event
                .params
                .get("metadata")
                .cloned()
                .and_then(|m| serde_json::from_value::<ScreencastMetadata>(m).ok())
                .unwrap_or(ScreencastMetadata {
                    offset_top: 0.0,
                    page_scale_factor: 1.0,
                    device_width: 0.0,
                    device_height: 0.0,
                    scroll_offset_x: 0.0,
                    scroll_offset_y: 0.0,
                });

            // Ack first — Chrome stops sending frames until the previous one is
            // acknowledged, so a dropped ack stalls the entire stream.
            if let Some(frame_session) = event.params.get("sessionId").and_then(|v| v.as_i64()) {
                if let Err(e) = browser.ack_screencast(frame_session).await {
                    tracing::warn!(error = %e, "screencast ack failed");
                }
            }

            let _ = outbound_tx.send(BrowserOutbound::Frame { data, metadata });
        }
        "Page.frameNavigated" | "Page.navigatedWithinDocument" | "Page.loadEventFired" => {
            if let Ok(state) = browser.page_state().await {
                let _ = outbound_tx.send(BrowserOutbound::State(state));
            }
        }
        _ => {}
    }
}
