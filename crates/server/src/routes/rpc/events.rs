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

    let mut stream = msg_store.history_plus_stream();
    while let Some(entry) = stream.next().await {
        if sender.send(entry.to_ws_message_unchecked()).await.is_err() {
            break;
        }
    }
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
