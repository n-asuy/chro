//! Task CRUD and status update endpoints.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, patch, post},
    Json, Router,
};
use db::{models::TaskRecord, types::TaskStatus};
use runtime::TaskService;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{identifiers::resolve_task_id, ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/tasks", post(create_task))
        .route("/tasks/reorder", post(reorder_tasks))
        .route("/tasks/:id", delete(delete_task))
        .route("/tasks/:id/status", patch(update_task_status))
        .route("/tasks/:id/title", patch(update_task_title))
}

#[derive(Debug, Serialize)]
struct TaskEnvelope {
    task: TaskRecord,
}

#[derive(Debug, Deserialize)]
struct CreateTaskRequest {
    project_id: Uuid,
    title: Option<String>,
    description: Option<String>,
    prompt: Option<String>,
}

async fn create_task(
    State(state): State<AppState>,
    Json(payload): Json<CreateTaskRequest>,
) -> Result<Json<TaskEnvelope>, ApiError> {
    let CreateTaskRequest {
        project_id,
        title,
        description,
        prompt,
    } = payload;
    let task = TaskService::new(state.runtime())
        .create_task(project_id, title, description, prompt)
        .await?;
    Ok(Json(TaskEnvelope { task }))
}

async fn delete_task(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<StatusCode, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    TaskService::new(state.runtime())
        .delete_task(task_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct UpdateTaskStatusRequest {
    status: TaskStatus,
}

async fn update_task_status(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
    Json(payload): Json<UpdateTaskStatusRequest>,
) -> Result<Json<TaskEnvelope>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let task = TaskService::new(state.runtime())
        .update_task_status(task_id, payload.status)
        .await?;
    Ok(Json(TaskEnvelope { task }))
}

#[derive(Debug, Deserialize)]
struct UpdateTaskTitleRequest {
    title: String,
}

async fn update_task_title(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
    Json(payload): Json<UpdateTaskTitleRequest>,
) -> Result<Json<TaskEnvelope>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let task = TaskService::new(state.runtime())
        .update_task_title(task_id, payload.title)
        .await?;
    Ok(Json(TaskEnvelope { task }))
}

#[derive(Debug, Deserialize)]
struct ReorderEntry {
    id: Uuid,
    sort_order: i32,
}

#[derive(Debug, Deserialize)]
struct ReorderTasksRequest {
    tasks: Vec<ReorderEntry>,
}

async fn reorder_tasks(
    State(state): State<AppState>,
    Json(payload): Json<ReorderTasksRequest>,
) -> Result<StatusCode, ApiError> {
    let updates: Vec<(Uuid, i32)> = payload
        .tasks
        .iter()
        .map(|entry| (entry.id, entry.sort_order))
        .collect();
    TaskService::new(state.runtime())
        .reorder_tasks(&updates)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
