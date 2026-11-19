//! WebSocket streaming endpoints for real-time data updates.
//!
//! Each route resolves its [`StreamSource`] (answering resolution failures
//! as HTTP errors before the upgrade) and pumps it into the socket. The
//! sources themselves, shared with paired devices, live in `stream_sources`.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::Deserialize;

use super::stream_sources::{serve_ws, StreamSource};
use crate::{ApiError, AppState};

/// Create the streams router with all WebSocket endpoints.
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/tasks", get(stream_tasks))
        .route("/session-list", get(stream_session_list))
        .route("/tasks/:task_id/runs", get(stream_task_runs))
        .route("/tasks/:task_id/sessions", get(stream_task_sessions))
        .route("/tasks/:task_id/queue", get(stream_session_queue))
        .route("/task-runs/:id/logs", get(stream_task_run_logs))
        .route("/task-runs/:id/repo-events", get(stream_run_repo_events))
        .route(
            "/projects/:project_id/repo-events",
            get(stream_project_repo_events),
        )
        .route("/task-drafts", get(stream_task_drafts))
}

/// Upgrade to a socket that carries `source`.
pub(crate) fn upgrade(
    ws: WebSocketUpgrade,
    state: AppState,
    source: StreamSource,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        let end = source.ws_end();
        serve_ws(socket, source.open(state), end).await;
    })
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
    let source = StreamSource::tasks(&state, params.project_id.as_deref()).await?;
    Ok(upgrade(ws, state, source))
}

async fn stream_session_list(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::session_list(&params)?;
    Ok(upgrade(ws, state, source))
}

async fn stream_task_runs(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::task_runs(&state, &task_id).await?;
    Ok(upgrade(ws, state, source))
}

async fn stream_task_sessions(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::task_sessions(&state, &task_id).await?;
    Ok(upgrade(ws, state, source))
}

async fn stream_session_queue(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::session_queue(&state, &task_id).await?;
    Ok(upgrade(ws, state, source))
}

async fn stream_task_drafts(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(params): Query<StreamProjectQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::task_drafts(&state, &params.project_id).await?;
    Ok(upgrade(ws, state, source))
}

async fn stream_task_run_logs(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::task_run_logs(&state, &id).await?;
    Ok(upgrade(ws, state, source))
}

async fn stream_run_repo_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::run_repo_events(&state, &id).await?;
    Ok(upgrade(ws, state, source))
}

async fn stream_project_repo_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let source = StreamSource::project_repo_events(&state, &project_id).await?;
    Ok(upgrade(ws, state, source))
}
