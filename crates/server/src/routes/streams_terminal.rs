//! Interactive terminal WebSocket endpoint.
//!
//! Emulation happens server-side ([`terminal::Emulator`]); the browser sends
//! keystrokes and paints the grid snapshots it receives back. Input is base64
//! encoded so the wire stays UTF-8 safe and JSON-parseable; output is a
//! structured snapshot, not raw bytes.
//!
//! * Client → Server
//!   - `{ "type": "input",  "data": "<base64>" }`
//!   - `{ "type": "resize", "cols": <u16>, "rows": <u16> }`
//!   - `{ "type": "ping" }`              — optional keepalive
//!
//! * Server → Client
//!   - `{ "type": "ready",    "session_id": "<uuid>" }`
//!   - `{ "type": "snapshot", "snapshot": { cols, rows, cursor, lines } }`
//!   - `{ "type": "exit",     "code": <i32 | null> }`
//!   - `{ "type": "error",    "message": "<string>" }`
//!
//! ## Persistence (live PTY across reconnects)
//!
//! A PTY session outlives any single WebSocket connection. The client may
//! pass `?session_id=<uuid>` to **reattach** to a still-running shell; the
//! server repaints the current screen from the emulator's authoritative
//! grid (`session.snapshot()`) and then resumes live snapshot streaming.
//! When `session_id` is absent or unknown (e.g. after a server restart) a
//! fresh shell is spawned and its new id is returned in the `ready` frame.
//!
//! Socket close is treated as **detach** — the shell keeps running. Only an
//! explicit `kill` frame (tab closed by the user) or the child exiting
//! removes the session.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytes::Bytes;
use db::models::ProjectRecord;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use terminal::TerminalSnapshot;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    pty::{PtyOutbound, PtySession, PtySpawnConfig},
    AppState,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/terminal", get(stream_terminal))
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    /// Existing session to reattach to. When present and still alive the
    /// server repaints from the emulator instead of spawning a new shell.
    session_id: Option<String>,
    /// Project slug or UUID — used to set the PTY cwd to the project's
    /// git repo. Optional; when omitted the shell starts in `$HOME`.
    project_id: Option<String>,
    /// Override the cwd directly (used by callers that already know the
    /// path; takes precedence over `project_id`).
    cwd: Option<String>,
    /// Initial column count. Falls back to 80 when missing or zero.
    cols: Option<u16>,
    /// Initial row count. Falls back to 24 when missing or zero.
    rows: Option<u16>,
    /// Override the shell binary. Falls back to `$SHELL`, then `/bin/bash`
    /// (or `cmd.exe` on Windows).
    shell: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InboundFrame {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Scroll { delta_lines: i32 },
    Ping,
    Kill,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutboundFrame<'a> {
    Ready { session_id: String },
    Snapshot { snapshot: Arc<TerminalSnapshot> },
    Exit { code: Option<i32> },
    Error { message: &'a str },
}

async fn stream_terminal(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<TerminalQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_terminal_ws(socket, state, params))
}

async fn handle_terminal_ws(socket: WebSocket, state: AppState, params: TerminalQuery) {
    let session = match resolve_session(&state, &params).await {
        Ok(session) => session,
        Err(message) => {
            send_error_and_close(socket, &message).await;
            return;
        }
    };
    let session_id = session.id();

    let mut output_rx = session.subscribe();
    let (mut sender, mut receiver) = socket.split();

    let ready = serde_json::to_string(&OutboundFrame::Ready {
        session_id: session_id.to_string(),
    })
    .unwrap_or_else(|_| "{\"type\":\"error\",\"message\":\"serialize failed\"}".to_string());
    if sender.send(Message::Text(ready)).await.is_err() {
        // Client vanished mid-handshake — leave the shell running so a
        // reconnect can reattach. Orphans are reaped on explicit kill,
        // child exit, or server shutdown.
        return;
    }

    // Paint the current grid immediately so the client shows the live screen
    // before any new program output arrives (matters for reattach).
    let initial = OutboundFrame::Snapshot {
        snapshot: session.snapshot(),
    };
    if let Ok(json) = serde_json::to_string(&initial) {
        if sender.send(Message::Text(json)).await.is_err() {
            // Detach; the shell stays alive for a later reconnect.
            return;
        }
    }

    // Outbound pump: PTY → WS.
    let pty_for_outbound = session.clone();
    let outbound_state = state.clone();
    let outbound = tokio::spawn(async move {
        let _keep_session_alive = pty_for_outbound;
        loop {
            match output_rx.recv().await {
                Ok(PtyOutbound::Snapshot(snapshot)) => {
                    let frame = OutboundFrame::Snapshot { snapshot };
                    let json = match serde_json::to_string(&frame) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if sender.send(Message::Text(json)).await.is_err() {
                        // Socket gone → detach. Leave the shell running so a
                        // reconnect can reattach and repaint from the
                        // emulator snapshot.
                        break;
                    }
                }
                Ok(PtyOutbound::Exit(code)) => {
                    let frame = OutboundFrame::Exit { code };
                    if let Ok(json) = serde_json::to_string(&frame) {
                        let _ = sender.send(Message::Text(json)).await;
                    }
                    let _ = SinkExt::close(&mut sender).await;
                    // Process is gone for good — drop it from the registry.
                    let _ = outbound_state.pty().close(session_id).await;
                    break;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Drop on the floor — terminals are inherently lossy
                    // when the consumer falls behind. Continue draining.
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Inbound pump: WS → PTY. Runs on the same task that owns the receiver
    // so we can detect socket close immediately.
    while let Some(msg) = receiver.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            Message::Text(text) => {
                let Ok(frame) = serde_json::from_str::<InboundFrame>(&text) else {
                    continue;
                };
                match frame {
                    InboundFrame::Input { data } => {
                        let Ok(bytes) = B64.decode(data.as_bytes()) else {
                            continue;
                        };
                        if session.write(Bytes::from(bytes)).await.is_err() {
                            break;
                        }
                    }
                    InboundFrame::Resize { cols, rows } => {
                        let _ = session.resize(cols.max(1), rows.max(1));
                    }
                    InboundFrame::Scroll { delta_lines } => {
                        session.scroll(delta_lines);
                    }
                    InboundFrame::Ping => {}
                    InboundFrame::Kill => {
                        // Explicit teardown (tab closed by the user):
                        // terminate the shell and remove the session so it
                        // can no longer be reattached.
                        let _ = state.pty().close(session_id).await;
                        break;
                    }
                }
            }
            Message::Binary(bytes) => {
                // Allow raw binary input as a fast path for paste-heavy
                // workloads. Treated identically to `input`.
                if session.write(Bytes::from(bytes.to_vec())).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    // Socket closed: detach only. The shell keeps running so a reconnect
    // can reattach and repaint. An explicit `kill` already removed the
    // session; a dead child was reaped by the outbound pump.
    outbound.abort();
}

/// Reattach to an existing session when a live `session_id` is supplied,
/// otherwise spawn a fresh shell in the resolved cwd.
async fn resolve_session(
    state: &AppState,
    params: &TerminalQuery,
) -> Result<Arc<PtySession>, String> {
    if let Some(raw) = params.session_id.as_deref() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if let Ok(uuid) = Uuid::parse_str(trimmed) {
                if let Some(session) = state.pty().get(uuid).await {
                    return Ok(session);
                }
                // Unknown / expired id (e.g. after a server restart) —
                // fall through and start a new shell.
            }
        }
    }

    let cwd = resolve_cwd(state, params).await?;
    let config = PtySpawnConfig {
        cwd,
        shell: params.shell.clone(),
        cols: params.cols.filter(|c| *c > 0).unwrap_or(80),
        rows: params.rows.filter(|r| *r > 0).unwrap_or(24),
        env: Vec::new(),
    };
    state
        .pty()
        .create(config)
        .await
        .map_err(|err| format!("failed to start shell: {err}"))
}

async fn resolve_cwd(state: &AppState, params: &TerminalQuery) -> Result<Option<PathBuf>, String> {
    if let Some(cwd) = params.cwd.as_ref() {
        let trimmed = cwd.trim();
        if !trimmed.is_empty() {
            return Ok(Some(PathBuf::from(trimmed)));
        }
    }
    if let Some(project_id) = params.project_id.as_ref() {
        let trimmed = project_id.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let project = ProjectRecord::get_by_identifier(state.pool(), trimmed)
            .await
            .map_err(|e| format!("project lookup failed: {e}"))?;
        return Ok(Some(PathBuf::from(project.git_repo_path)));
    }
    Ok(None)
}

async fn send_error_and_close(mut socket: WebSocket, message: &str) {
    let frame = OutboundFrame::Error { message };
    if let Ok(json) = serde_json::to_string(&frame) {
        let _ = socket.send(Message::Text(json)).await;
    }
    let _ = SinkExt::close(&mut socket).await;
}
