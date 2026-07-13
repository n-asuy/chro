//! HTTP route modules.
//!
//! Route organization:
//! - `rpc/`: Domain-split RPC endpoints (projects, tasks, task_runs, sessions, etc.)
//! - `streams`: SSE streams for real-time data (JSON Patch)
//! - `health`: Health check endpoint

use axum::{routing::get, Json, Router};
use serde_json::json;

use crate::AppState;

pub(crate) mod frontend;
pub(crate) mod rpc;
pub(crate) mod streams;
pub(crate) mod streams_browser;

pub(crate) fn rpc_router() -> Router<AppState> {
    rpc::router()
}

pub(crate) fn sessions_router() -> Router<AppState> {
    rpc::sessions_router()
}

pub(crate) fn health_router() -> Router<AppState> {
    Router::<AppState>::new().route("/health", get(health))
}

pub(crate) fn streams_router() -> Router<AppState> {
    streams::router().merge(streams_browser::router())
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}
