//! Task CRUD and status update endpoints.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, patch, post},
    Json, Router,
};
use db::{
    models::{TaskContextRef, TaskRecord},
    types::TaskStatus,
};
use runtime::{Runtime, TaskService};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::context_refs::{resolve_context_refs, ContextRefRequest};
use crate::{identifiers::resolve_task_id, ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/tasks", post(create_task))
        .route("/tasks/reorder", post(reorder_tasks))
        .route("/tasks/:id/context-refs", get(list_task_context_refs))
        .route("/tasks/:id/referenced-by", get(list_task_referenced_by))
        .route("/tasks/:id", delete(delete_task))
        .route("/tasks/:id/status", patch(update_task_status))
        .route("/tasks/:id/title", patch(update_task_title))
        .route("/tasks/:id/last-message", get(get_task_last_message))
        .route(
            "/tasks/:id/pending-question",
            get(get_task_pending_question),
        )
}

#[derive(Debug, Serialize)]
struct TaskEnvelope {
    task: TaskRecord,
}

#[derive(Debug, Serialize)]
struct TaskContextRefsEnvelope {
    refs: Vec<TaskContextRef>,
}

#[derive(Debug, Deserialize)]
struct CreateTaskRequest {
    project_id: Uuid,
    title: Option<String>,
    description: Option<String>,
    prompt: Option<String>,
    #[serde(default)]
    context_refs: Vec<ContextRefRequest>,
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
        context_refs,
    } = payload;
    let prompt_for_refs = prompt
        .as_deref()
        .or(description.as_deref())
        .unwrap_or_default();
    let context_refs = resolve_context_refs(state.pool(), prompt_for_refs, &context_refs).await?;
    let task = TaskService::new(state.runtime())
        .create_task(project_id, title, description, prompt, context_refs)
        .await?;
    Ok(Json(TaskEnvelope { task }))
}

async fn list_task_context_refs(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<Json<TaskContextRefsEnvelope>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let refs = TaskContextRef::list_by_task_id(state.pool(), task_id).await?;
    Ok(Json(TaskContextRefsEnvelope { refs }))
}

async fn list_task_referenced_by(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<Json<TaskContextRefsEnvelope>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let refs = TaskContextRef::list_referencing_task_id(state.pool(), task_id).await?;
    Ok(Json(TaskContextRefsEnvelope { refs }))
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

#[derive(Debug, Serialize)]
struct TaskLastMessageResponse {
    user: Option<String>,
    assistant: Option<String>,
}

/// Return the most recent user prompt and assistant reply for a task, used by
/// the sidebar to preview the last conversation turn on hover. Either field is
/// `null` when that message type has not been produced yet.
async fn get_task_last_message(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<Json<TaskLastMessageResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let exchange = state.runtime().task_last_exchange(task_id).await?;
    Ok(Json(TaskLastMessageResponse {
        user: exchange.user,
        assistant: exchange.assistant,
    }))
}

#[derive(Debug, Serialize)]
struct TaskPendingQuestionResponse {
    approval: Option<approvals::ApprovalRequest>,
}

/// Return the approval request the task's running agent is currently blocked
/// on, if any (`awaiting_input` on the task record signals its existence).
/// Includes `tool_input`, so the hover preview can show the AskUserQuestion
/// question text without opening the session.
async fn get_task_pending_question(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<Json<TaskPendingQuestionResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let runs = db::models::TaskRun::list_by_task_id(state.pool(), task_id).await?;
    let mut approval = None;
    for run in runs
        .iter()
        .filter(|run| run.status == db::types::RunStatus::Running)
    {
        if let Some(request) = state
            .runtime()
            .approvals()
            .pending_request_for_run(run.id)
            .await
        {
            approval = Some(request);
            break;
        }
    }
    Ok(Json(TaskPendingQuestionResponse { approval }))
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
