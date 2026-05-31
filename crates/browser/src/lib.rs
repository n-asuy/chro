//! Headless browser engine: a thin, native CDP layer over a real Chrome.
//!
//! This is the browser counterpart to the [`terminal`] crate. Where `terminal`
//! owns VTE emulation and emits grid snapshots, this crate owns one CDP
//! WebSocket to Chrome and emits the recipes the renderer/agent drive the page
//! with — navigation, coordinate input, tab management, and a screencast frame
//! stream. It performs no broadcasting and holds no session registry; that
//! lifecycle lives one layer up (the server's `browser_session`), exactly as
//! `pty` wraps `terminal`.
//!
//! The CDP know-how (WS discovery across Chrome 136/144/147, real-page
//! selection, per-session domain enablement, stale-session re-attach, the key
//! descriptor table) is ported from browser-use/browser-harness; the harness
//! itself — its Python CLI, Unix-socket daemon, and self-editing helpers — is
//! deliberately not.

mod discovery;
mod error;
mod launch;
mod protocol;
mod transport;

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::broadcast;

pub use error::{BrowserError, Result};
pub use launch::LaunchConfig;
pub use protocol::{ScreencastMetadata, TabInfo};
pub use transport::{CdpClient, CdpEvent};

use launch::ChromeProcess;
use protocol::{is_internal_url, KeyDescriptor};

/// Mouse button for [`Browser::click`].
#[derive(Debug, Clone, Copy)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

impl MouseButton {
    fn as_cdp(self) -> &'static str {
        match self {
            MouseButton::Left => "left",
            MouseButton::Middle => "middle",
            MouseButton::Right => "right",
        }
    }
}

impl std::str::FromStr for MouseButton {
    type Err = ();
    fn from_str(s: &str) -> std::result::Result<Self, ()> {
        match s {
            "left" => Ok(MouseButton::Left),
            "middle" => Ok(MouseButton::Middle),
            "right" => Ok(MouseButton::Right),
            _ => Err(()),
        }
    }
}

/// A page's current address, used to paint the renderer's URL bar.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PageState {
    pub target_id: String,
    pub url: String,
    pub title: String,
}

/// The flat CDP session + target the engine is currently driving.
#[derive(Clone)]
struct Attached {
    session_id: String,
    target_id: String,
}

/// A live automation browser. Cheap to share behind an `Arc`; all methods take
/// `&self`. Dropping it kills the Chrome process.
pub struct Browser {
    chrome: Mutex<ChromeProcess>,
    cdp: CdpClient,
    attached: Arc<Mutex<Attached>>,
}

impl Browser {
    /// Launch a dedicated Chrome, connect over CDP, and attach to a page.
    pub async fn launch(config: LaunchConfig) -> Result<Self> {
        let chrome = launch::launch(config).await?;
        let ws_url = discovery::resolve_ws_url(chrome.port, &chrome.user_data_dir).await?;
        let cdp = CdpClient::connect(&ws_url).await?;

        let attached = attach_first_page(&cdp).await?;
        let browser = Self {
            chrome: Mutex::new(chrome),
            cdp,
            attached: Arc::new(Mutex::new(attached)),
        };
        Ok(browser)
    }

    /// The underlying CDP connection, for subscribing to the raw event stream
    /// (screencast frames, navigation) one layer up.
    pub fn cdp(&self) -> CdpClient {
        self.cdp.clone()
    }

    /// Subscribe to CDP events. Convenience wrapper over [`CdpClient::events`].
    pub fn events(&self) -> broadcast::Receiver<CdpEvent> {
        self.cdp.events()
    }

    /// The flat CDP session id the engine is currently driving. Used to filter
    /// the event stream to the attached page.
    pub fn session_id(&self) -> String {
        self.attached
            .lock()
            .expect("attached mutex poisoned")
            .session_id
            .clone()
    }

    // --- navigation ---

    /// Navigate the attached page to `url`.
    pub async fn navigate(&self, url: &str) -> Result<()> {
        self.send_page("Page.navigate", json!({ "url": url }))
            .await?;
        Ok(())
    }

    /// Go back one entry in the page's navigation history (no-op at the start).
    pub async fn go_back(&self) -> Result<()> {
        self.navigate_history(-1).await
    }

    /// Go forward one entry in the page's navigation history (no-op at the end).
    pub async fn go_forward(&self) -> Result<()> {
        self.navigate_history(1).await
    }

    /// Move `delta` entries through navigation history via
    /// `Page.navigateToHistoryEntry`. Out-of-range moves are silently ignored,
    /// matching browser back/forward button semantics.
    async fn navigate_history(&self, delta: i64) -> Result<()> {
        let history = self
            .send_page("Page.getNavigationHistory", json!({}))
            .await?;
        let current = history
            .get("currentIndex")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let Some(entries) = history.get("entries").and_then(Value::as_array) else {
            return Ok(());
        };
        let target = current + delta;
        if target < 0 || target as usize >= entries.len() {
            return Ok(());
        }
        let Some(entry_id) = entries[target as usize].get("id").and_then(Value::as_i64) else {
            return Ok(());
        };
        self.send_page(
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry_id }),
        )
        .await?;
        Ok(())
    }

    /// Resolve the attached page's address via `Target.getTargetInfo`
    /// (browser-level — no session id, per the CDP contract).
    pub async fn page_state(&self) -> Result<PageState> {
        let target_id = self
            .attached
            .lock()
            .expect("attached mutex poisoned")
            .target_id
            .clone();
        let result = self
            .cdp
            .send(
                "Target.getTargetInfo",
                json!({ "targetId": target_id }),
                None,
            )
            .await?;
        let info = result.get("targetInfo").cloned().unwrap_or(result);
        Ok(PageState {
            target_id: str_field(&info, "targetId"),
            url: str_field(&info, "url"),
            title: str_field(&info, "title"),
        })
    }

    // --- input (coordinates in CSS pixels) ---

    /// Click at viewport coordinates: a pressed/released pair, matching
    /// browser-harness `click_at_xy`.
    pub async fn click(&self, x: f64, y: f64, button: MouseButton, clicks: u32) -> Result<()> {
        let base = json!({
            "x": x, "y": y, "button": button.as_cdp(), "clickCount": clicks,
        });
        let mut pressed = base.clone();
        pressed["type"] = json!("mousePressed");
        let mut released = base;
        released["type"] = json!("mouseReleased");
        self.send_page("Input.dispatchMouseEvent", pressed).await?;
        self.send_page("Input.dispatchMouseEvent", released).await?;
        Ok(())
    }

    /// Insert text directly. Fast, but bypasses framework key listeners — for
    /// controlled inputs the renderer should send discrete key presses.
    pub async fn type_text(&self, text: &str) -> Result<()> {
        self.send_page("Input.insertText", json!({ "text": text }))
            .await?;
        Ok(())
    }

    /// Press a key with an optional modifier bitfield (1=Alt, 2=Ctrl, 4=Meta,
    /// 8=Shift).
    ///
    /// A printable key sends a `keyDown` carrying `text` then a `keyUp`. A
    /// `keyDown` with `text` already makes Chrome synthesize the keypress and
    /// the character insertion (the same path Puppeteer uses), so we must NOT
    /// also send a separate `char` event — doing both inserts the character
    /// twice (the "double typing" bug). Named keys (Enter, Arrow*, …) carry no
    /// text and just fire keyDown/keyUp with their virtual key code.
    pub async fn press_key(&self, key: &str, modifiers: i64) -> Result<()> {
        let d = KeyDescriptor::resolve(key);
        let mut down = json!({
            "type": "keyDown",
            "key": d.key,
            "code": d.code,
            "modifiers": modifiers,
            "windowsVirtualKeyCode": d.windows_virtual_key_code,
            "nativeVirtualKeyCode": d.windows_virtual_key_code,
        });
        if !d.text.is_empty() {
            down["text"] = json!(d.text);
        }
        self.send_page("Input.dispatchKeyEvent", down).await?;

        let up = json!({
            "type": "keyUp",
            "key": d.key,
            "code": d.code,
            "modifiers": modifiers,
            "windowsVirtualKeyCode": d.windows_virtual_key_code,
            "nativeVirtualKeyCode": d.windows_virtual_key_code,
        });
        self.send_page("Input.dispatchKeyEvent", up).await?;
        Ok(())
    }

    /// Wheel scroll at viewport coordinates.
    pub async fn scroll(&self, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
        self.send_page(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy }),
        )
        .await?;
        Ok(())
    }

    // --- tabs ---

    /// List every page target (browser-level call).
    pub async fn list_tabs(&self) -> Result<Vec<TabInfo>> {
        let result = self.cdp.send("Target.getTargets", json!({}), None).await?;
        let infos = result
            .get("targetInfos")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(infos
            .into_iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
            .filter_map(|t| serde_json::from_value::<TabInfo>(t).ok())
            .collect())
    }

    /// Activate `target_id`, attach to it, and make it the engine's driven page.
    pub async fn switch_tab(&self, target_id: &str) -> Result<()> {
        self.cdp
            .send(
                "Target.activateTarget",
                json!({ "targetId": target_id }),
                None,
            )
            .await?;
        let result = self
            .cdp
            .send(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                None,
            )
            .await?;
        let session_id = str_field(&result, "sessionId");
        if session_id.is_empty() {
            return Err(BrowserError::UnexpectedResponse {
                method: "Target.attachToTarget".into(),
                detail: "missing sessionId".into(),
            });
        }
        self.set_attached(session_id.clone(), target_id.to_string());
        enable_default_domains(&self.cdp, &session_id).await;
        Ok(())
    }

    /// Open a new tab. Created blank then navigated, mirroring browser-harness:
    /// passing the URL to `createTarget` races attach.
    pub async fn new_tab(&self, url: &str) -> Result<String> {
        let result = self
            .cdp
            .send("Target.createTarget", json!({ "url": "about:blank" }), None)
            .await?;
        let target_id = str_field(&result, "targetId");
        if target_id.is_empty() {
            return Err(BrowserError::UnexpectedResponse {
                method: "Target.createTarget".into(),
                detail: "missing targetId".into(),
            });
        }
        self.switch_tab(&target_id).await?;
        if url != "about:blank" {
            self.navigate(url).await?;
        }
        Ok(target_id)
    }

    /// Close a tab (browser-level call).
    pub async fn close_tab(&self, target_id: &str) -> Result<()> {
        self.cdp
            .send("Target.closeTarget", json!({ "targetId": target_id }), None)
            .await?;
        Ok(())
    }

    // --- visual ---

    /// One-shot PNG screenshot of the viewport, base64-encoded (the form CDP
    /// returns and the form image-aware agents consume).
    pub async fn capture_screenshot(&self) -> Result<String> {
        let result = self
            .send_page("Page.captureScreenshot", json!({ "format": "png" }))
            .await?;
        Ok(str_field(&result, "data"))
    }

    /// Begin streaming JPEG frames as `Page.screencastFrame` events. Each frame
    /// MUST be acked via [`Browser::ack_screencast`] or Chrome stops sending.
    pub async fn start_screencast(
        &self,
        max_width: u32,
        max_height: u32,
        quality: u32,
    ) -> Result<()> {
        self.send_page(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": quality,
                "maxWidth": max_width,
                "maxHeight": max_height,
                "everyNthFrame": 1,
            }),
        )
        .await?;
        Ok(())
    }

    /// Stop the screencast.
    pub async fn stop_screencast(&self) -> Result<()> {
        self.send_page("Page.stopScreencast", json!({})).await?;
        Ok(())
    }

    /// Acknowledge a received screencast frame. `frame_session_id` is the
    /// integer carried in the frame event's `sessionId` — distinct from the
    /// flat CDP session.
    pub async fn ack_screencast(&self, frame_session_id: i64) -> Result<()> {
        self.send_page(
            "Page.screencastFrameAck",
            json!({ "sessionId": frame_session_id }),
        )
        .await?;
        Ok(())
    }

    /// Explicit shutdown: kill Chrome. Also runs on drop.
    pub fn shutdown(&self) {
        self.chrome.lock().expect("chrome mutex poisoned").kill();
    }

    // --- internals ---

    fn set_attached(&self, session_id: String, target_id: String) {
        let mut guard = self.attached.lock().expect("attached mutex poisoned");
        guard.session_id = session_id;
        guard.target_id = target_id;
    }

    /// Send a page-scoped command on the current session, re-attaching once if
    /// the session went stale (tab closed/navigated out from under us). Ported
    /// from the daemon's "Session with given id not found" recovery.
    async fn send_page(&self, method: &str, params: Value) -> Result<Value> {
        let session_id = self.session_id();
        match self
            .cdp
            .send(method, params.clone(), Some(&session_id))
            .await
        {
            Ok(value) => Ok(value),
            Err(BrowserError::Protocol { message, .. })
                if message.contains("Session with given id not found") =>
            {
                tracing::warn!(%session_id, "stale CDP session, re-attaching");
                let fresh = attach_first_page(&self.cdp).await?;
                let new_session = fresh.session_id.clone();
                self.set_attached(fresh.session_id, fresh.target_id);
                self.cdp.send(method, params, Some(&new_session)).await
            }
            Err(other) => Err(other),
        }
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Attach to a real page (creating an `about:blank` if none exists), enable the
/// default domains, and return the resulting session/target. Ported from
/// `daemon.py:attach_first_page`.
async fn attach_first_page(cdp: &CdpClient) -> Result<Attached> {
    let result = cdp.send("Target.getTargets", json!({}), None).await?;
    let infos = result
        .get("targetInfos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let real_page = infos.iter().find(|t| {
        t.get("type").and_then(Value::as_str) == Some("page")
            && !is_internal_url(t.get("url").and_then(Value::as_str).unwrap_or(""))
    });

    let target_id = match real_page {
        Some(t) => str_field(t, "targetId"),
        None => {
            // No real page — create one rather than attaching to the omnibox popup.
            let created = cdp
                .send("Target.createTarget", json!({ "url": "about:blank" }), None)
                .await?;
            str_field(&created, "targetId")
        }
    };
    if target_id.is_empty() {
        return Err(BrowserError::NoPage);
    }

    let attach = cdp
        .send(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )
        .await?;
    let session_id = str_field(&attach, "sessionId");
    if session_id.is_empty() {
        return Err(BrowserError::UnexpectedResponse {
            method: "Target.attachToTarget".into(),
            detail: "missing sessionId".into(),
        });
    }

    enable_default_domains(cdp, &session_id).await;
    Ok(Attached {
        session_id,
        target_id,
    })
}

/// Enable Page/DOM/Runtime/Network on a fresh session. Each new flat session
/// starts with all domains disabled, so without this the screencast and
/// navigation events never fire (daemon.py `_enable_default_domains`). Run
/// concurrently so the worst case is one round trip, not four. Best-effort:
/// an individual enable failure is logged, not fatal.
async fn enable_default_domains(cdp: &CdpClient, session_id: &str) {
    let domains = ["Page", "DOM", "Runtime", "Network"];
    let futures = domains.iter().map(|domain| {
        let method = format!("{domain}.enable");
        async move {
            if let Err(e) = cdp.send(&method, json!({}), Some(session_id)).await {
                tracing::warn!(domain, error = %e, "enable domain failed");
            }
        }
    });
    futures_util::future::join_all(futures).await;
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
