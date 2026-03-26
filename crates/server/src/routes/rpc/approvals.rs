//! Approval workflow endpoints.

use approvals::{
    ApprovalPendingInfo, ApprovalRequest, ApprovalResponse, ApprovalStatus, CreateApprovalRequest,
};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use runtime::Runtime;
use serde::Serialize;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/approvals",
            get(list_pending_approvals).post(create_approval_request),
        )
        .route("/approvals/:id", get(get_approval_status))
        .route("/approvals/:id/respond", post(respond_to_approval))
}

#[derive(Debug, Serialize)]
struct ApprovalsListResponse {
    pending: Vec<ApprovalPendingInfo>,
}

#[derive(Debug, Serialize)]
struct ApprovalStatusResponse {
    status: ApprovalStatus,
}

async fn list_pending_approvals(
    State(state): State<AppState>,
) -> Result<Json<ApprovalsListResponse>, ApiError> {
    let pending = state.runtime().approvals().pending().await;
    Ok(Json(ApprovalsListResponse { pending }))
}

async fn create_approval_request(
    State(state): State<AppState>,
    Json(payload): Json<CreateApprovalRequest>,
) -> Result<Json<ApprovalRequest>, ApiError> {
    let request = state.runtime().approvals().create(payload).await?;
    Ok(Json(request))
}

async fn get_approval_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ApprovalStatusResponse>, ApiError> {
    if let Some(status) = state.runtime().approvals().status(&id).await {
        Ok(Json(ApprovalStatusResponse { status }))
    } else {
        Err(ApiError::NotFound)
    }
}

async fn respond_to_approval(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ApprovalResponse>,
) -> Result<Json<ApprovalStatusResponse>, ApiError> {
    let status = state.runtime().approvals().respond(&id, payload).await?;
    Ok(Json(ApprovalStatusResponse { status }))
}
