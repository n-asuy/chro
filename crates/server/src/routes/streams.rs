//! WebSocket streaming endpoints for real-time data updates.
//!
//! This module provides filtered JSON Patch streams:
//! - Initial snapshot sent on connection
//! - Live filtered updates via JSON Patch (RFC 6902)
//! - Automatic reconnection support on client side

use crate::{perf, AppState};
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
    project_id: Uuid,
}

async fn stream_tasks(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<StreamTasksQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_stream_tasks_ws(socket, state, params.project_id))
}

async fn handle_stream_tasks_ws(socket: WebSocket, state: AppState, project_id: Uuid) {
    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let stream_result: StreamResult = state.runtime().events().stream_tasks_raw(project_id).await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(%project_id, error = %err, "[stream_tasks] failed to create stream");
            let error_json = serde_json::json!({"error": err.to_string()}).to_string();
            let _ = sender.send(Message::Text(error_json.into())).await;
            return;
        }
    };

    while let Some(result) = stream.next().await {
        let msg = match result {
            Ok(entry) => entry.to_ws_message_unchecked(),
            Err(err) => {
                let error_json = serde_json::json!({"error": err.to_string()}).to_string();
                Message::Text(error_json.into())
            }
        };
        if sender.send(msg).await.is_err() {
            break;
        }
    }
}

async fn stream_task_runs(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(task_id): Path<Uuid>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_stream_task_runs_ws(socket, state, task_id))
}

async fn handle_stream_task_runs_ws(socket: WebSocket, state: AppState, task_id: Uuid) {
    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let stream_result: StreamResult = state.runtime().events().stream_task_runs_raw(task_id).await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(%task_id, error = %err, "[stream_task_runs] failed to create stream");
            let error_json = serde_json::json!({"error": err.to_string()}).to_string();
            let _ = sender.send(Message::Text(error_json.into())).await;
            return;
        }
    };

    while let Some(result) = stream.next().await {
        let msg = match result {
            Ok(entry) => entry.to_ws_message_unchecked(),
            Err(err) => {
                let error_json = serde_json::json!({"error": err.to_string()}).to_string();
                Message::Text(error_json.into())
            }
        };
        if sender.send(msg).await.is_err() {
            break;
        }
    }
}

async fn stream_task_sessions(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(task_id): Path<Uuid>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_stream_task_sessions_ws(socket, state, task_id))
}

async fn handle_stream_task_sessions_ws(socket: WebSocket, state: AppState, task_id: Uuid) {
    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let stream_result: StreamResult = state
        .runtime()
        .events()
        .stream_task_sessions_raw(task_id)
        .await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(%task_id, error = %err, "[stream_task_sessions] failed to create stream");
            let error_json = serde_json::json!({"error": err.to_string()}).to_string();
            let _ = sender.send(Message::Text(error_json.into())).await;
            return;
        }
    };

    while let Some(result) = stream.next().await {
        let msg = match result {
            Ok(entry) => entry.to_ws_message_unchecked(),
            Err(err) => {
                let error_json = serde_json::json!({"error": err.to_string()}).to_string();
                Message::Text(error_json.into())
            }
        };
        if sender.send(msg).await.is_err() {
            break;
        }
    }
}

async fn stream_task_drafts(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<StreamTasksQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_stream_task_drafts_ws(socket, state, params.project_id))
}

async fn handle_stream_task_drafts_ws(socket: WebSocket, state: AppState, project_id: Uuid) {
    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let stream_result: StreamResult = state
        .runtime()
        .events()
        .stream_task_drafts_raw(project_id)
        .await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(%project_id, error = %err, "[stream_task_drafts] failed to create stream");
            let error_json = serde_json::json!({"error": err.to_string()}).to_string();
            let _ = sender.send(Message::Text(error_json.into())).await;
            return;
        }
    };

    while let Some(result) = stream.next().await {
        let msg = match result {
            Ok(entry) => entry.to_ws_message_unchecked(),
            Err(err) => {
                let error_json = serde_json::json!({"error": err.to_string()}).to_string();
                Message::Text(error_json.into())
            }
        };
        if sender.send(msg).await.is_err() {
            break;
        }
    }
}

async fn stream_task_run_logs(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_stream_task_run_logs_ws(socket, state, id))
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
