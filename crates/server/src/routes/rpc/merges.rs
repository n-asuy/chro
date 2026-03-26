//! Merge record management endpoints (merged from api.rs).

use axum::{
    extract::{Path, State},
    routing::{get, patch, post},
    Json, Router,
};
use db::{
    models::{TaskMerge, TaskRecord},
    types::{MergeStatus, TaskStatus},
};
use serde::{Deserialize, Serialize};
use sqlx::Error as SqlxError;
use uuid::Uuid;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/merges", post(create_merge_record))
        .route("/merges/:id/status", patch(update_merge_status))
        .route("/merges/:id/revert", post(revert_merge_record))
        .route("/tasks/:task_id/merges", get(list_task_merges))
}

#[derive(Debug, Serialize)]
struct MergeEnvelope {
    merge: TaskMerge,
}

#[derive(Debug, Serialize)]
struct MergeListResponse {
    merges: Vec<TaskMerge>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CreateMergeRequest {
    Direct {
        task_id: Uuid,
        target_branch: String,
        merge_commit: String,
    },
    Pr {
        task_id: Uuid,
        target_branch: String,
        pr_number: i64,
        pr_url: String,
    },
}

#[derive(Debug, Deserialize)]
struct UpdateMergeStatusRequest {
    status: MergeStatus,
    merge_commit_sha: Option<String>,
}

async fn list_task_merges(
    State(state): State<AppState>,
    Path(task_id): Path<Uuid>,
) -> Result<Json<MergeListResponse>, ApiError> {
    TaskRecord::get(state.pool(), task_id).await?;
    let merges = TaskMerge::find_by_task(state.pool(), task_id).await?;
    Ok(Json(MergeListResponse { merges }))
}

async fn create_merge_record(
    State(state): State<AppState>,
    Json(payload): Json<CreateMergeRequest>,
) -> Result<Json<MergeEnvelope>, ApiError> {
    let merge = match payload {
        CreateMergeRequest::Direct {
            task_id,
            target_branch,
            merge_commit,
        } => {
            let branch = target_branch.trim();
            let commit = merge_commit.trim();
            if branch.is_empty() {
                return Err(ApiError::BadRequest("target_branch is required".into()));
            }
            if commit.is_empty() {
                return Err(ApiError::BadRequest("merge_commit is required".into()));
            }
            let task = TaskRecord::get(state.pool(), task_id).await?;
            let record = TaskMerge::create_direct(
                state.pool(),
                task.id,
                branch.to_string(),
                commit.to_string(),
            )
            .await?;
            TaskRecord::update_status(state.pool(), task.id, TaskStatus::Completed).await?;
            record
        }
        CreateMergeRequest::Pr {
            task_id,
            target_branch,
            pr_number,
            pr_url,
        } => {
            if target_branch.trim().is_empty() {
                return Err(ApiError::BadRequest("target_branch is required".into()));
            }
            if pr_url.trim().is_empty() {
                return Err(ApiError::BadRequest("pr_url is required".into()));
            }
            let task = TaskRecord::get(state.pool(), task_id).await?;
            TaskMerge::create_pr(
                state.pool(),
                task.id,
                target_branch.trim().to_string(),
                pr_number,
                pr_url.trim().to_string(),
            )
            .await?
        }
    };

    Ok(Json(MergeEnvelope { merge }))
}

async fn update_merge_status(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateMergeStatusRequest>,
) -> Result<Json<MergeEnvelope>, ApiError> {
    let merge = match TaskMerge::update_pr_status(
        state.pool(),
        id,
        payload.status,
        payload.merge_commit_sha,
    )
    .await
    {
        Ok(merge) => merge,
        Err(SqlxError::RowNotFound) => return Err(ApiError::NotFound),
        Err(err) => return Err(ApiError::Sqlx(err)),
    };

    if matches!(payload.status, MergeStatus::Merged) {
        TaskRecord::update_status(state.pool(), merge.task_id, TaskStatus::Completed).await?;
    }

    Ok(Json(MergeEnvelope { merge }))
}

async fn revert_merge_record(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<MergeEnvelope>, ApiError> {
    let merge = match TaskMerge::mark_reverted(state.pool(), id).await {
        Ok(merge) => merge,
        Err(SqlxError::RowNotFound) => return Err(ApiError::NotFound),
        Err(err) => return Err(ApiError::Sqlx(err)),
    };

    let task = TaskRecord::get(state.pool(), merge.task_id).await?;
    if matches!(task.status, TaskStatus::Completed) {
        TaskRecord::update_status(state.pool(), task.id, TaskStatus::InProgress).await?;
    }

    Ok(Json(MergeEnvelope { merge }))
}
