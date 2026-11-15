//! Global event streaming endpoints.

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use log_types::UiEventKind;
use runtime::Runtime;
use serde::Deserialize;
use serde_json::Value;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/events", get(stream_app_events))
        .route("/events/ui", post(trigger_ui_event))
}

async fn stream_app_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let msg_store = state.runtime().events().msg_store().clone();
    ws.on_upgrade(move |socket| handle_app_events_ws(socket, msg_store))
}

async fn handle_app_events_ws(socket: WebSocket, msg_store: std::sync::Arc<events::MsgStore>) {
    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let mut stream = app_events(&msg_store);
    while let Some(entry) = stream.next().await {
        if sender.send(entry.to_ws_message_unchecked()).await.is_err() {
            break;
        }
    }
}

/// The app event bus: UI events only.
///
/// The global store also carries every database change patch, which each
/// data stream filters and snapshots on its own. The desktop listens here only
/// for UI events, and forwarding the rest made it clone and patch a document
/// nobody reads on every database write. History is kept so an event raised
/// before the window connected (a tray "open settings") still arrives.
fn app_events(
    msg_store: &events::MsgStore,
) -> futures::stream::BoxStream<'static, log_types::LogEntry> {
    msg_store
        .history_plus_stream()
        .filter(|entry| futures::future::ready(matches!(entry, log_types::LogEntry::UiEvent(_))))
        .boxed()
}

#[derive(Debug, Deserialize)]
struct UiEventRequest {
    kind: UiEventKind,
    #[serde(default)]
    data: Option<Value>,
}

async fn trigger_ui_event(
    State(state): State<AppState>,
    Json(payload): Json<UiEventRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .runtime()
        .events()
        .emit_ui_event(payload.kind, payload.data);
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use log_types::{LogEntry, UiEventPayload};

    #[tokio::test]
    async fn only_ui_events_reach_the_app_event_bus() {
        let store = events::MsgStore::new();
        store.push(LogEntry::JsonPatch(serde_json::json!([
            { "op": "replace", "path": "/tasks", "value": {} }
        ])));
        let open_settings = LogEntry::UiEvent(UiEventPayload::new(UiEventKind::OpenSettings, None));
        store.push(open_settings.clone());

        let first = app_events(&store).next().await;

        assert_eq!(first, Some(open_settings));
    }
}
