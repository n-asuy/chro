//! WebSocket streaming endpoints for real-time data updates.
//!
//! This module provides filtered JSON Patch streams:
//! - Initial snapshot sent on connection
//! - Live filtered updates via JSON Patch (RFC 6902)
//! - Automatic reconnection support on client side

use crate::{identifiers, perf, ApiError, AppState};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use events::EventError;
use futures::{stream::BoxStream, SinkExt, StreamExt};
use log_types::LogEntry;
use runtime::Runtime;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use uuid::Uuid;

type StreamResult = Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, EventError>;
const FIRST_PATCH_STALL_MS: u64 = 15_000;

/// Create the streams router with all WebSocket endpoints.
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/tasks", get(stream_tasks))
        .route("/tasks/:task_id/runs", get(stream_task_runs))
        .route("/tasks/:task_id/sessions", get(stream_task_sessions))
        .route("/task-runs/:id/logs", get(stream_task_run_logs))
        .route("/task-drafts", get(stream_task_drafts))
}

#[derive(Debug, Deserialize)]
struct StreamTasksQuery {
    /// When omitted, the stream spans every project (the cross-project inbox).
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamProjectQuery {
    project_id: String,
}

async fn stream_tasks(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<StreamTasksQuery>,
) -> Result<impl IntoResponse, ApiError> {
    match params.project_id {
        Some(raw) => {
            let project_id = identifiers::resolve_project_id(state.pool(), &raw).await?;
            Ok(ws.on_upgrade(move |socket| handle_stream_tasks_ws(socket, state, project_id)))
        }
        None => Ok(ws.on_upgrade(move |socket| handle_stream_all_tasks_ws(socket, state))),
    }
}

/// Drive a shared snapshot + live-update stream over a websocket, recording perf
/// instrumentation around the initial snapshot.
///
/// These shared streams (`/tasks`, `/tasks/:id/runs`, `/tasks/:id/sessions`,
/// `/task-drafts`) gate the sidebar's loading state: the frontend shows every
/// session as loading until the first message arrives, and force-reconnects if
/// nothing arrives within `FIRST_PATCH_STALL_MS`. The first message is the
/// initial snapshot, which `stream_*_raw` builds with a synchronous DB read.
/// Timing that read (`snapshot_ms`) directly exposes reader-vs-writer lock
/// contention under the `Delete` journal: a slow snapshot (or one that errors
/// with `database is locked`) is the backend cause of an all-sessions-loading
/// flash. The HTTP perf middleware can't see this because the WS upgrade
/// returns `101` before the snapshot runs.
async fn run_shared_stream(
    socket: WebSocket,
    label: &'static str,
    key: Value,
    snapshot: impl std::future::Future<Output = StreamResult>,
) {
    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let opened_at = std::time::Instant::now();
    let first_message_seen = Arc::new(AtomicBool::new(false));

    perf::record_backend_event(
        "shared_stream_opened",
        json!({ "stream": label, "key": key }),
    );

    // Watchdog mirroring the frontend's first-message timeout: if no message is
    // delivered within the same window, the sidebar has already flipped every
    // session to loading. Record it so the stall is attributable to the backend.
    let stall_seen = Arc::clone(&first_message_seen);
    let stall_key = key.clone();
    let stall_timer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(FIRST_PATCH_STALL_MS)).await;
        if !stall_seen.load(Ordering::Relaxed) {
            perf::record_backend_event(
                "shared_stream_stalled",
                json!({ "stream": label, "key": stall_key, "timeout_ms": FIRST_PATCH_STALL_MS }),
            );
        }
    });

    // The snapshot read is the suspected contention point. Time it in isolation.
    let snapshot_started = std::time::Instant::now();
    let stream_result = snapshot.await;
    let snapshot_ms = perf::elapsed_ms(snapshot_started);

    let mut stream = match stream_result {
        Ok(s) => {
            perf::record_backend_event(
                "shared_stream_snapshot_ready",
                json!({ "stream": label, "key": key, "snapshot_ms": snapshot_ms }),
            );
            s
        }
        Err(err) => {
            first_message_seen.store(true, Ordering::Relaxed);
            stall_timer.abort();
            // `database is locked` / SQLITE_BUSY surfaces here when the busy
            // timeout is exhausted instead of merely delaying the read.
            perf::record_backend_event(
                "shared_stream_snapshot_failed",
                json!({ "stream": label, "key": key, "snapshot_ms": snapshot_ms, "error": err.to_string() }),
            );
            tracing::warn!(stream = label, error = %err, "[shared_stream] failed to create stream");
            let error_json = json!({"error": err.to_string()}).to_string();
            let _ = sender.send(Message::Text(error_json)).await;
            return;
        }
    };

    while let Some(result) = stream.next().await {
        let msg = match result {
            Ok(entry) => entry.to_ws_message_unchecked(),
            Err(err) => {
                let error_json = json!({"error": err.to_string()}).to_string();
                Message::Text(error_json)
            }
        };
        if sender.send(msg).await.is_err() {
            break;
        }
        if !first_message_seen.swap(true, Ordering::Relaxed) {
            stall_timer.abort();
            perf::record_backend_event(
                "shared_stream_first_message",
                json!({
                    "stream": label,
                    "key": key,
                    "time_to_first_message_ms": perf::elapsed_ms(opened_at),
                }),
            );
        }
    }
}

async fn handle_stream_all_tasks_ws(socket: WebSocket, state: AppState) {
    run_shared_stream(socket, "all_tasks", json!({}), async move {
        state.runtime().events().stream_all_tasks_raw().await
    })
    .await;
}

async fn handle_stream_tasks_ws(socket: WebSocket, state: AppState, project_id: Uuid) {
    run_shared_stream(
        socket,
        "tasks",
        json!({ "project_id": project_id }),
        async move { state.runtime().events().stream_tasks_raw(project_id).await },
    )
    .await;
}

async fn stream_task_runs(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let task_id = identifiers::resolve_task_id(state.pool(), &task_id).await?;
    Ok(ws.on_upgrade(move |socket| handle_stream_task_runs_ws(socket, state, task_id)))
}

async fn handle_stream_task_runs_ws(socket: WebSocket, state: AppState, task_id: Uuid) {
    run_shared_stream(
        socket,
        "task_runs",
        json!({ "task_id": task_id }),
        async move { state.runtime().events().stream_task_runs_raw(task_id).await },
    )
    .await;
}

async fn stream_task_sessions(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let task_id = identifiers::resolve_task_id(state.pool(), &task_id).await?;
    Ok(ws.on_upgrade(move |socket| handle_stream_task_sessions_ws(socket, state, task_id)))
}

async fn handle_stream_task_sessions_ws(socket: WebSocket, state: AppState, task_id: Uuid) {
    run_shared_stream(
        socket,
        "task_sessions",
        json!({ "task_id": task_id }),
        async move {
            state
                .runtime()
                .events()
                .stream_task_sessions_raw(task_id)
                .await
        },
    )
    .await;
}

async fn stream_task_drafts(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<StreamProjectQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = identifiers::resolve_project_id(state.pool(), &params.project_id).await?;
    Ok(ws.on_upgrade(move |socket| handle_stream_task_drafts_ws(socket, state, project_id)))
}

async fn handle_stream_task_drafts_ws(socket: WebSocket, state: AppState, project_id: Uuid) {
    run_shared_stream(
        socket,
        "task_drafts",
        json!({ "project_id": project_id }),
        async move {
            state
                .runtime()
                .events()
                .stream_task_drafts_raw(project_id)
                .await
        },
    )
    .await;
}

async fn stream_task_run_logs(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let id = identifiers::resolve_task_run_id(state.pool(), &id).await?;
    Ok(ws.on_upgrade(move |socket| handle_stream_task_run_logs_ws(socket, state, id)))
}

async fn handle_stream_task_run_logs_ws(mut socket: WebSocket, state: AppState, task_run_id: Uuid) {
    let stream_opened_at = std::time::Instant::now();
    let first_patch_seen = Arc::new(AtomicBool::new(false));
    let first_patch_seen_for_timer = Arc::clone(&first_patch_seen);
    let stall_timer_task_run_id = task_run_id;
    let stall_timer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(FIRST_PATCH_STALL_MS)).await;
        if !first_patch_seen_for_timer.load(Ordering::Relaxed) {
            perf::record_backend_event(
                "task_run_logs_stream_stalled",
                json!({
                    "task_run_id": stall_timer_task_run_id,
                    "timeout_ms": FIRST_PATCH_STALL_MS,
                }),
            );
        }
    });

    perf::record_backend_event(
        "task_run_logs_stream_opened",
        json!({
            "task_run_id": task_run_id,
        }),
    );

    let stream_result = state.runtime().stream_logs(task_run_id).await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(err) => {
            first_patch_seen.store(true, Ordering::Relaxed);
            stall_timer.abort();
            perf::record_backend_event(
                "task_run_logs_stream_start_failed",
                json!({
                    "task_run_id": task_run_id,
                    "error": err.to_string(),
                }),
            );
            tracing::warn!(%task_run_id, error = %err, "[stream_task_run_logs] failed to create stream");
            let error_json = serde_json::json!({"error": err.to_string()}).to_string();
            let _ = socket.send(Message::Text(error_json.into())).await;
            let _ = SinkExt::close(&mut socket).await;
            return;
        }
    };

    let mut patch_messages = 0usize;
    let mut patch_ops = 0usize;
    let mut finished = false;
    let mut closed_by_client = false;

    loop {
        tokio::select! {
            result = stream.next() => {
                let Some(result) = result else {
                    break;
                };

                let msg = match result {
                    Ok(entry) => {
                        if let LogEntry::JsonPatch(value) = &entry {
                            patch_messages += 1;
                            let (ops, contains_entry_patch) = parse_patch_stats(value);
                            patch_ops += ops;
                            if contains_entry_patch && !first_patch_seen.swap(true, Ordering::Relaxed) {
                                perf::record_backend_event(
                                    "task_run_logs_stream_first_patch",
                                    json!({
                                        "task_run_id": task_run_id,
                                        "time_to_first_patch_ms": perf::elapsed_ms(stream_opened_at),
                                    }),
                                );
                            }
                        } else if matches!(entry, LogEntry::Finished) {
                            finished = true;
                            first_patch_seen.store(true, Ordering::Relaxed);
                            perf::record_backend_event(
                                "task_run_logs_stream_finished",
                                json!({
                                    "task_run_id": task_run_id,
                                    "elapsed_ms": perf::elapsed_ms(stream_opened_at),
                                    "patch_messages": patch_messages,
                                    "patch_ops": patch_ops,
                                }),
                            );
                        }

                        log_entry_to_vk_message(entry)
                    }
                    Err(err) => {
                        perf::record_backend_event(
                            "task_run_logs_stream_error",
                            json!({
                                "task_run_id": task_run_id,
                                "error": err.to_string(),
                            }),
                        );
                        Some(Message::Text(
                            json!({"error": err.to_string()}).to_string().into(),
                        ))
                    }
                };

                if let Some(message) = msg {
                    if socket.send(message).await.is_err() {
                        closed_by_client = true;
                        break;
                    }
                }
            }
            inbound = socket.next() => {
                match inbound {
                    Some(Ok(Message::Close(_))) => {
                        closed_by_client = true;
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => {
                        closed_by_client = true;
                        break;
                    }
                }
            }
        }
    }

    first_patch_seen.store(true, Ordering::Relaxed);
    stall_timer.abort();

    if !finished {
        perf::record_backend_event(
            "task_run_logs_stream_closed",
            json!({
                "task_run_id": task_run_id,
                "elapsed_ms": perf::elapsed_ms(stream_opened_at),
                "patch_messages": patch_messages,
                "patch_ops": patch_ops,
                "reason": if closed_by_client {
                    "client_disconnected"
                } else {
                    "stream_ended_without_finished"
                },
            }),
        );
    }

    // Send a proper close frame so the client sees code 1000 (normal closure)
    // instead of an abnormal TCP drop that triggers reconnection attempts.
    let _ = SinkExt::close(&mut socket).await;
}

fn log_entry_to_vk_message(entry: LogEntry) -> Option<Message> {
    match entry {
        LogEntry::JsonPatch(value) => Some(Message::Text(
            json!({"JsonPatch": value}).to_string().into(),
        )),
        LogEntry::Finished => Some(Message::Text(r#"{"finished":true}"#.into())),
        _ => None,
    }
}

fn parse_patch_stats(value: &Value) -> (usize, bool) {
    let Some(ops) = value.as_array() else {
        return (0, false);
    };

    let mut contains_entry_patch = false;
    for op in ops {
        let Some(path) = op.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(index) = path.strip_prefix("/entries/") else {
            continue;
        };
        if index.parse::<usize>().is_err() {
            continue;
        }
        let action = op.get("op").and_then(Value::as_str);
        if action != Some("remove") {
            contains_entry_patch = true;
            break;
        }
    }

    (ops.len(), contains_entry_patch)
}
