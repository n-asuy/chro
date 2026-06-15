//! Feature-flag registry endpoint.
//!
//! Exposes the code-owned flag registry plus each flag's resolved value for
//! this installation. The renderer reads resolved values (and lets developers
//! override them locally); it never owns the list of flags.

use axum::{routing::get, Json, Router};
use serde::Serialize;

use crate::AppState;

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/flags/registry", get(get_flag_registry))
}

#[derive(Debug, Serialize)]
struct FlagView {
    #[serde(flatten)]
    meta: analytics::flags::FlagMeta,
    /// Effective value before any local developer override is applied.
    resolved_value: bool,
}

#[derive(Debug, Serialize)]
struct FlagRegistryResponse {
    flags: Vec<FlagView>,
}

async fn get_flag_registry() -> Json<FlagRegistryResponse> {
    let resolved = analytics::flags::resolve_all().await;

    let flags = analytics::flags::registry()
        .into_iter()
        .map(|meta| {
            let resolved_value = resolved
                .get(meta.key)
                .copied()
                .unwrap_or(meta.default_enabled);
            FlagView {
                meta,
                resolved_value,
            }
        })
        .collect();

    Json(FlagRegistryResponse { flags })
}
