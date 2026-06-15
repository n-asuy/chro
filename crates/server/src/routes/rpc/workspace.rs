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

use crate::{identifiers::resolve_project_id, ApiError, AppState};

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
    Path(identifier): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = resolve_project_id(state.pool(), &identifier).await?;
    let project = ProjectRecord::get(state.pool(), project_id).await?;
    let project_path = PathBuf::from(&project.git_repo_path);
    let events = state
        .runtime()
        .subscribe_workspace_file_events(project_path);
    Ok(ws.on_upgrade(move |socket| handle_file_events_ws(socket, events)))
}

async fn handle_file_events_ws(
    socket: WebSocket,
    events: futures::stream::BoxStream<'static, local_runtime::WorkspaceFileEvent>,
) {
    use local_runtime::WorkspaceFileEventType;

    let (mut sender, mut ws_receiver) = socket.split();
    let mut events = events;

    loop {
        tokio::select! {
            message = ws_receiver.next() => {
                match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
            event = events.next() => {
                match event {
                    Some(event) => {
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
                    None => break,
                }
            }
        }
    }
}
