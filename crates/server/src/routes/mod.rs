//! HTTP route modules.
//!
//! Route organization:
//! - `rpc/`: Domain-split RPC endpoints (projects, tasks, task_runs, sessions, etc.)
//! - `stream_sources`: message sources shared by the WebSocket routes and paired devices
//! - `streams`: WebSocket streams for real-time data (JSON Patch)
//! - `health`: Health check endpoint

use axum::{routing::get, Json, Router};
use serde_json::json;

use crate::{operator, AppState};

pub(crate) mod frontend;
pub(crate) mod rpc;
pub(crate) mod stream_sources;
pub(crate) mod streams;
pub(crate) mod streams_browser;

/// Every API endpoint the server answers, bound to `state`: the operator API
/// (`/v1`), the app's `/rpc` and `/streams`, and `/health`. The HTTP listener
/// adds its origin checks around this; paired devices are dispatched into the
/// same router in-process.
pub(crate) fn api_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .merge(rpc::sessions_router())
        .merge(operator::router(state.clone()))
        .nest("/rpc", rpc::router())
        .nest(
            "/streams",
            streams::router().merge(streams_browser::router()),
        )
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}
