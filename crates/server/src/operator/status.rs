//! `GET /v1/status`: which server answers and who the caller is to it.

use axum::{extract::State, Extension};
use db::models::TaskRecord;
use server_contract::{
    api::{CallerView, StatusView},
    CONTRACT_REV,
};

use super::{views::session_ref, Caller, V1Result, V1};
use crate::AppState;

pub(crate) async fn show(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> V1Result<StatusView> {
    let caller = match caller {
        Caller::User => CallerView::User,
        Caller::Agent { task_id, .. } => CallerView::Agent {
            session: session_ref(&TaskRecord::get(state.pool(), task_id).await?),
        },
    };
    let identity = state.identity();
    Ok(V1(StatusView {
        version: env!("CARGO_PKG_VERSION").to_string(),
        contract_rev: CONTRACT_REV.to_string(),
        runtime_id: identity.runtime_id.clone(),
        pid: identity.pid,
        url: identity.url.clone(),
        caller,
    }))
}
