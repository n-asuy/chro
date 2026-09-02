//! Feature-flag registry endpoint.
//!
//! Exposes each flag's resolved value for this installation. The renderer
//! reads those values to gate features; it never owns the list of flags.
//!
//! Only the key and the resolved value cross this boundary. Ownership,
//! lifecycle status, rollout owner and retire-by dates are internal operating
//! metadata: they belong to the registry and `FLAGS.md`, and shipping them to
//! a window a user can open turns a private ledger into product surface.

use axum::{routing::get, Json, Router};
use serde::Serialize;

use crate::AppState;

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/flags/registry", get(get_flag_registry))
}

#[derive(Debug, Serialize)]
struct FlagView {
    key: &'static str,
    /// Whether this installation has the flag, before any local opt-out.
    enabled: bool,
}

#[derive(Debug, Serialize)]
struct FlagRegistryResponse {
    flags: Vec<FlagView>,
}

async fn get_flag_registry() -> Json<FlagRegistryResponse> {
    let resolved = analytics::flags::resolve_all().await;

    let flags = analytics::flags::registry()
        .into_iter()
        .map(|meta| FlagView {
            key: meta.key,
            enabled: resolved
                .get(meta.key)
                .copied()
                .unwrap_or(meta.default_enabled),
        })
        .collect();

    Json(FlagRegistryResponse { flags })
}
