//! Interactive browser WebSocket endpoint.
//!
//! Chrome renders server-side and streams JPEG frames; the renderer paints
//! them and sends back pointer and
//! keyboard input mapped to viewport (CSS-pixel) coordinates. The agent drives
//! the same session through the engine, so its actions render live in the human
//! pane — and the human can take over mid-task.
//!
//! * Client → Server
//!   - `{ "type": "navigate",   "url": "<string>" }`
//!   - `{ "type": "click",      "x": <f64>, "y": <f64>, "button": "left", "clicks": 1 }`
//!   - `{ "type": "type",       "text": "<string>" }`
//!   - `{ "type": "key",        "key": "Enter", "modifiers": 0 }`
//!   - `{ "type": "scroll",     "x": <f64>, "y": <f64>, "dx": <f64>, "dy": <f64> }`
//!   - `{ "type": "switch_tab", "target_id": "<string>" }`
//!   - `{ "type": "new_tab",    "url": "<string>" }`
//!   - `{ "type": "close_tab",  "target_id": "<string>" }`
//!   - `{ "type": "resize",     "width": <u32>, "height": <u32> }`
//!   - `{ "type": "list_tabs" }`
//!   - `{ "type": "ping" }`
//!
//! * Server → Client
//!   - `{ "type": "ready", "session_id": "<uuid>" }`
//!   - `{ "type": "frame", "data": "<base64 jpeg>", "metadata": { ... } }`
//!   - `{ "type": "state", "state": { target_id, url, title } }`
//!   - `{ "type": "tabs",  "tabs": [ { target_id, title, url } ] }`
//!   - `{ "type": "error", "message": "<string>" }`
//!
//! The Chrome process is launched on upgrade and killed when the client
//! disconnects; reattachment is not currently supported.

use std::{path::PathBuf, str::FromStr};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use browser::{MouseButton, PageState, ScreencastMetadata, TabInfo};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::{
    browser_session::{BrowserOutbound, BrowserSpawnConfig},
    AppState,
};

const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 800;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/browser", get(stream_browser))
}

#[derive(Debug, Deserialize)]
struct BrowserQuery {
    /// Initial navigation. Optional; defaults to a blank page.
    url: Option<String>,
    /// Run Chrome headless (no visible window). Defaults to headless; pass
    /// `headless=false` to launch a real, visible Chrome window instead.
    headless: Option<bool>,
    /// Initial screencast viewport.
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InboundFrame {
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Click {
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<String>,
        #[serde(default)]
        clicks: Option<u32>,
    },
    Type {
        text: String,
    },
    Key {
        key: String,
        #[serde(default)]
        modifiers: Option<i64>,
    },
    Scroll {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    SwitchTab {
        target_id: String,
    },
    NewTab {
        #[serde(default)]
        url: Option<String>,
    },
    CloseTab {
        target_id: String,
    },
    Resize {
        width: u32,
        height: u32,
    },
    ListTabs,
    Ping,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutboundFrame<'a> {
    Ready {
        session_id: String,
    },
    Frame {
        data: String,
        metadata: ScreencastMetadata,
    },
    State {
        state: PageState,
    },
    Tabs {
        tabs: Vec<TabInfo>,
    },
    Error {
        message: &'a str,
    },
}

async fn stream_browser(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<BrowserQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_browser_ws(socket, state, params))
}

async fn handle_browser_ws(socket: WebSocket, state: AppState, params: BrowserQuery) {
    let config = BrowserSpawnConfig {
        profile_base_dir: profile_base_dir(),
        headless: params.headless.unwrap_or(true),
        start_url: params.url.filter(|u| !u.trim().is_empty()),
        width: params.width.filter(|w| *w > 0).unwrap_or(DEFAULT_WIDTH),
        height: params.height.filter(|h| *h > 0).unwrap_or(DEFAULT_HEIGHT),
    };

    let session = match state.browser().create(config).await {
        Ok(session) => session,
        Err(err) => {
            send_error_and_close(socket, &format!("failed to launch browser: {err}")).await;
            return;
        }
    };
    let session_id = session.id();

    let mut output_rx = session.subscribe();
    let (mut sender, mut receiver) = socket.split();

    let ready = serde_json::to_string(&OutboundFrame::Ready {
        session_id: session_id.to_string(),
    })
    .unwrap_or_else(|_| r#"{"type":"error","message":"serialize failed"}"#.to_string());
    if sender.send(Message::Text(ready.into())).await.is_err() {
        let _ = state.browser().close(session_id).await;
        return;
    }

    // Paint the current address immediately so the URL bar is correct before
    // the first navigation event arrives.
    if let Ok(state_msg) = session.page_state().await {
        let frame = OutboundFrame::State { state: state_msg };
        if let Ok(json) = serde_json::to_string(&frame) {
            let _ = sender.send(Message::Text(json.into())).await;
        }
    }

    // Outbound pump: session events → WS.
    let outbound = tokio::spawn(async move {
        loop {
            match output_rx.recv().await {
                Ok(event) => {
                    let frame = match event {
                        BrowserOutbound::Frame { data, metadata } => {
                            OutboundFrame::Frame { data, metadata }
                        }
                        BrowserOutbound::State(state) => OutboundFrame::State { state },
                        BrowserOutbound::Tabs(tabs) => OutboundFrame::Tabs { tabs },
                    };
                    let json = match serde_json::to_string(&frame) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if sender.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Inbound pump: WS → engine. Runs on the receiver-owning task so socket
    // close is detected immediately.
    while let Some(msg) = receiver.next().await {
        let Ok(msg) = msg else { break };
        match msg {
            Message::Text(text) => {
                let Ok(frame) = serde_json::from_str::<InboundFrame>(&text) else {
                    continue;
                };
                if !dispatch(&session, frame).await {
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => {}
        }
    }

    outbound.abort();
    let _ = state.browser().close(session_id).await;
}

/// Apply one inbound frame to the session. Returns `false` to close the socket
/// (only on an unrecoverable transport-side condition). Engine-level failures
/// are logged but keep the session alive — a bad click should not kill the tab.
async fn dispatch(
    session: &std::sync::Arc<crate::browser_session::BrowserSession>,
    frame: InboundFrame,
) -> bool {
    match frame {
        InboundFrame::Navigate { url } => warn_on_err("navigate", session.navigate(&url).await),
        InboundFrame::Back => warn_on_err("back", session.go_back().await),
        InboundFrame::Forward => warn_on_err("forward", session.go_forward().await),
        InboundFrame::Click {
            x,
            y,
            button,
            clicks,
        } => {
            let button = button
                .as_deref()
                .and_then(|b| MouseButton::from_str(b).ok())
                .unwrap_or(MouseButton::Left);
            warn_on_err(
                "click",
                session.click(x, y, button, clicks.unwrap_or(1)).await,
            );
        }
        InboundFrame::Type { text } => warn_on_err("type", session.type_text(&text).await),
        InboundFrame::Key { key, modifiers } => {
            warn_on_err("key", session.press_key(&key, modifiers.unwrap_or(0)).await)
        }
        InboundFrame::Scroll { x, y, dx, dy } => {
            warn_on_err("scroll", session.scroll(x, y, dx, dy).await)
        }
        InboundFrame::SwitchTab { target_id } => {
            warn_on_err("switch_tab", session.switch_tab(&target_id).await)
        }
        InboundFrame::NewTab { url } => {
            let url = url.as_deref().unwrap_or("about:blank");
            warn_on_err("new_tab", session.new_tab(url).await.map(|_| ()));
        }
        InboundFrame::CloseTab { target_id } => {
            warn_on_err("close_tab", session.close_tab(&target_id).await)
        }
        InboundFrame::Resize { width, height } => {
            warn_on_err("resize", session.resize(width, height).await)
        }
        InboundFrame::ListTabs => {
            // The reply rides the broadcast channel (the WS sender is owned by
            // the outbound task), so the outbound pump forwards it as `tabs`.
            warn_on_err("list_tabs", session.broadcast_tabs().await);
        }
        InboundFrame::Ping => {}
    }
    true
}

fn warn_on_err(op: &str, result: Result<(), crate::browser_session::BrowserSessionError>) {
    if let Err(e) = result {
        tracing::warn!(op, error = %e, "browser action failed");
    }
}

/// Base directory for automation profiles. Each session creates a private
/// subdirectory beneath this (see [`BrowserSpawnConfig::profile_base_dir`]),
/// because Chrome refuses to share one `--user-data-dir` across processes.
/// Distinct from the user's primary Chrome profile, which the dedicated-launch
/// model deliberately does not touch.
fn profile_base_dir() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join(".chro")
        .join("browser-profiles")
}

async fn send_error_and_close(mut socket: WebSocket, message: &str) {
    let frame = OutboundFrame::Error { message };
    if let Ok(json) = serde_json::to_string(&frame) {
        let _ = socket.send(Message::Text(json.into())).await;
    }
    let _ = SinkExt::close(&mut socket).await;
}
