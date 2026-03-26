//! Workspace file events streaming.
//!
//! Note: File operations have been moved to project-based endpoints in projects.rs.
//! This module only provides WebSocket streaming for file change events.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use db::models::ProjectRecord;
use futures::{SinkExt, StreamExt};
use std::path::PathBuf;
use uuid::Uuid;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/:project_id/file-events",
        get(stream_project_file_events),
    )
}

/// WebSocket endpoint streaming file change events for a specific project.
async fn stream_project_file_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let project = ProjectRecord::get(state.pool(), project_id).await?;
    let project_path = PathBuf::from(&project.git_repo_path);

    state.runtime().start_workspace_watcher(project_path);

    let rx = state.runtime().subscribe_workspace_file_events();
    Ok(ws.on_upgrade(move |socket| handle_file_events_ws(socket, rx)))
}

async fn handle_file_events_ws(
    socket: WebSocket,
    rx: tokio::sync::broadcast::Receiver<local_runtime::WorkspaceFileEvent>,
) {
    use local_runtime::WorkspaceFileEventType;
    use tokio_stream::wrappers::BroadcastStream;

    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let mut stream = BroadcastStream::new(rx);
    while let Some(result) = stream.next().await {
        if let Ok(event) = result {
            let event_type_str = match event.event_type {
                WorkspaceFileEventType::Created => "created",
                WorkspaceFileEventType::Modified => "modified",
                WorkspaceFileEventType::Deleted => "deleted",
                WorkspaceFileEventType::Renamed => "renamed",
            };
            let data = serde_json::json!({
                "event_type": event_type_str,
                "relative_path": event.relative_path,
                "is_directory": event.is_directory,
            })
            .to_string();
            if sender.send(Message::Text(data.into())).await.is_err() {
                break;
            }
        }
    }
}
