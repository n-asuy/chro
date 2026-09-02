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
use super::path_link::{PathProbeBatchResponse, PathProbeRequest};
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
        .route("/tasks/:id/exchanges", get(list_task_exchanges))
        .route(
            "/tasks/:id/exchanges/:session_id",
            get(get_task_session_exchange),
        )
        .route(
            "/tasks/:id/pending-question",
            get(get_task_pending_question),
        )
        .route("/tasks/:id/probe-paths", post(probe_task_paths))
}

/// Probe path-like references from this task's conversation against the
/// task's candidate roots. See `path_link` for why link rendering resolves
/// up front, and `task_path_candidates` for why the scope is the task.
async fn probe_task_paths(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(request): Json<PathProbeRequest>,
) -> Result<Json<PathProbeBatchResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let candidates = super::task_runs::task_path_candidates(&state, task_id).await?;
    Ok(Json(
        super::path_link::probe_paths(&state, request, &candidates).await?,
    ))
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

/// Character budget for a turn's prompt preview in the exchange-turn list.
/// The rail renders one line per turn, so shipping full prompts (which can be
/// many KB) would only inflate the payload.
const TURN_PREVIEW_MAX_CHARS: usize = 280;

/// Newest-first cap on the exchange-turn list. Bounds the hover-preview
/// payload for long-lived tasks; older turns are simply not listed.
const TURN_LIST_MAX: usize = 100;

#[derive(Debug, Serialize)]
struct TaskExchangeTurn {
    session_id: Uuid,
    user: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
struct TaskExchangeTurnsResponse {
    turns: Vec<TaskExchangeTurn>,
}

/// List a task's conversation turns (newest first) for the hover preview's
/// history rail. Each turn is a task session that carries a user prompt; the
/// prompt is truncated to a one-line preview and the full exchange is fetched
/// per turn via `get_task_session_exchange`.
async fn list_task_exchanges(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<Json<TaskExchangeTurnsResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let sessions = db::models::TaskSession::list_by_task_id(state.pool(), task_id).await?;
    let turns = sessions
        .iter()
        .rev()
        .filter_map(|session| {
            let prompt = session.prompt.as_deref().map(str::trim)?;
            if prompt.is_empty() {
                return None;
            }
            let user = if prompt.chars().count() > TURN_PREVIEW_MAX_CHARS {
                let truncated: String = prompt.chars().take(TURN_PREVIEW_MAX_CHARS).collect();
                format!("{}…", truncated.trim_end())
            } else {
                prompt.to_owned()
            };
            Some(TaskExchangeTurn {
                session_id: session.id,
                user,
                created_at: session.created_at,
            })
        })
        .take(TURN_LIST_MAX)
        .collect();
    Ok(Json(TaskExchangeTurnsResponse { turns }))
}

/// Return the full user prompt and assistant reply for one conversation turn.
async fn get_task_session_exchange(
    State(state): State<AppState>,
    Path((identifier, session_id)): Path<(String, Uuid)>,
) -> Result<Json<TaskLastMessageResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &identifier).await?;
    let exchange = state
        .runtime()
        .task_session_exchange(task_id, session_id)
        .await?
        .ok_or(ApiError::NotFound)?;
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
