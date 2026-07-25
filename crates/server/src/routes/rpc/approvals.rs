//! Approval workflow endpoints.

use approvals::{
    ApprovalActor, ApprovalPendingInfo, ApprovalRequest, ApprovalResponse, ApprovalStatus,
    CreateApprovalRequest,
};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use db::models::{TaskRecord, TaskRun};
use runtime::Runtime;
use serde::Serialize;

use crate::{identifiers::resolve_task_id, ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/approvals",
            get(list_pending_approvals).post(create_approval_request),
        )
        .route("/approvals/:id", get(get_approval))
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

/// Full view of a single approval: the request (present while pending, so the
/// CLI can render `tool_input`) plus the current status.
#[derive(Debug, Serialize)]
struct ApprovalDetailResponse {
    request: Option<ApprovalRequest>,
    status: ApprovalStatus,
}

async fn list_pending_approvals(
    State(state): State<AppState>,
) -> Result<Json<ApprovalsListResponse>, ApiError> {
    let mut pending = state.runtime().approvals().pending().await;
    // The approval service has no database, so enrich each entry with its
    // owning task here. Pending counts are tiny; a couple of lookups each is
    // cheap and lets the CLI show task slugs instead of raw run ids.
    for info in &mut pending {
        if let Ok(Some(run)) = TaskRun::find_by_id(state.pool(), info.task_run_id).await {
            info.task_id = Some(run.task_id);
            if let Ok(Some(task)) = TaskRecord::find_by_id(state.pool(), run.task_id).await {
                info.task_slug = task.slug;
            }
        }
    }
    Ok(Json(ApprovalsListResponse { pending }))
}

async fn create_approval_request(
    State(state): State<AppState>,
    Json(payload): Json<CreateApprovalRequest>,
) -> Result<Json<ApprovalRequest>, ApiError> {
    let request = state.runtime().approvals().create(payload).await?;
    Ok(Json(request))
}

async fn get_approval(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ApprovalDetailResponse>, ApiError> {
    let approvals = state.runtime().approvals();
    match approvals.status(&id).await {
        Some(status) => {
            let request = approvals.request(&id).await;
            Ok(Json(ApprovalDetailResponse { request, status }))
        }
        None => Err(ApiError::NotFound),
    }
}

async fn respond_to_approval(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ApprovalResponse>,
) -> Result<Json<ApprovalStatusResponse>, ApiError> {
    // Governance rule 1: an agent cannot approve a run belonging to its own
    // task. Suspended-run mechanics make this unusual, but enforce it
    // structurally so a crafted `--from` or a parallel run of the same task
    // cannot self-authorize. Human (`User`) responses are unrestricted.
    if let ApprovalActor::Agent { task } = &payload.responded_by {
        if let Some(request) = state.runtime().approvals().request(&id).await {
            if let Some(run) = TaskRun::find_by_id(state.pool(), request.task_run_id).await? {
                let actor_task_id = resolve_task_id(state.pool(), task).await?;
                if run.task_id == actor_task_id {
                    return Err(ApiError::BadRequest(
                        "an agent cannot approve a run belonging to its own task".into(),
                    ));
                }
            }
        }
    }

    let status = state.runtime().approvals().respond(&id, payload).await?;
    Ok(Json(ApprovalStatusResponse { status }))
}
