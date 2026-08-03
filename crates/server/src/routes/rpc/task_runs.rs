//! Task run (execution) endpoints: CRUD, logs, merge, rebase, diff streaming.

use std::{path::PathBuf, time::Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use db::{
    models::{ForkMode, ProjectRecord, TaskMerge, TaskRecord, TaskRun},
    types::RunStatus,
};
use executors::ExecutorProfileId;
use filesystem::WorkspaceEntryDetail;
use futures::{SinkExt, StreamExt};
use log_types::LogEntry;
use runtime::{
    ForkWorkspace, ProjectFileService, Runtime, RuntimeError, SendTaskMessageParams,
    StartExecutionProcessParams, StartExecutionSessionParams, TaskMessageMode, TaskService,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::context_refs::{resolve_context_refs, ContextRefRequest};
use super::images::{ImageListResponse, ImageResponse};
use super::asset_response::{stream_asset_response, AssetQuery};
use super::path_resolve::{read_binary_resolving, read_text_resolving, stream_binary_response};
use crate::{
    identifiers::{resolve_project_id, resolve_task_id, resolve_task_run_id},
    perf, ApiError, AppState, MAX_IMAGE_UPLOAD_BYTES,
};

pub(super) fn router() -> Router<AppState> {
    use axum::extract::DefaultBodyLimit;

    Router::new()
        .route("/executions/claude", post(start_execution_session))
        .route("/task-runs", post(create_task_run))
        .route("/task-runs/:id/git", patch(update_task_run_git))
        .route("/task-runs/:id/executions", post(start_execution_process))
        .route("/task-runs/:id/status", patch(update_execution_status))
        .route("/task-runs/:id/cancel", post(cancel_execution))
        .route("/task-runs/:id/follow-up", post(follow_up_execution))
        .route("/task-runs/:id/fork", post(fork_task_run))
        .route("/tasks/:id/fork", post(fork_task_latest))
        .route("/tasks/:id/delegate", post(delegate_task))
        .route("/tasks/:id/messages", post(send_task_message))
        .route("/tasks/:id/follow-up", post(follow_up_by_task))
        .route(
            "/task-runs/:id/logs",
            get(get_task_run_logs).post(append_task_run_logs),
        )
        .route("/task-runs/:id/diff", get(stream_task_run_diff))
        .route("/tasks/:id/transcript", get(get_task_transcript))
        .route("/tasks/:id/cancel", post(cancel_task_execution))
        .route("/tasks/:id/diff", get(get_task_diff))
        .route("/tasks/:id/merge", post(merge_task))
        .route("/tasks/:id/rebase", post(rebase_task))
        .route(
            "/task-runs/:id/worktree-deleted",
            patch(mark_worktree_deleted),
        )
        .route("/task-runs/:id/merge", post(merge_task_run))
        .route("/task-runs/:id/rebase", post(rebase_task_run))
        .route("/task-runs/:id/conflicts/abort", post(abort_conflicts))
        .route("/task-runs/:id/branches", get(list_task_run_branches))
        .route(
            "/task-runs/:id/branch-status",
            get(get_task_run_branch_status),
        )
        .route("/task-runs/:id/with-task", get(get_task_run_with_task))
        .route(
            "/task-runs/:id/images/upload",
            post(upload_task_run_image).layer(DefaultBodyLimit::max(MAX_IMAGE_UPLOAD_BYTES)),
        )
        .route("/task-runs/:id/binary-file", get(read_task_run_binary_file))
        .route(
            "/task-runs/:id/asset/*relative_path",
            get(read_task_run_asset),
        )
        .route("/task-runs/:id/file", get(read_task_run_file))
        .route(
            "/task-runs/:id/absolute-path",
            get(get_task_run_absolute_path),
        )
        .route(
            "/task-runs/:id/reveal-in-finder",
            post(reveal_task_run_in_finder),
        )
        .route("/task-runs/:id/entries", get(list_task_run_entries))
        .route("/task-runs/:id/media", get(list_task_run_media))
        .route(
            "/task-runs/by-session/:session_id",
            get(find_task_run_by_session_handler),
        )
        .route(
            "/projects/:project_id/active-run",
            get(get_latest_active_run),
        )
        .route("/tasks/:id/runs", get(get_task_runs))
        .route("/tasks/:id/images", get(list_task_images))
        .route(
            "/tasks/:id/images/upload",
            post(upload_task_image).layer(DefaultBodyLimit::max(MAX_IMAGE_UPLOAD_BYTES)),
        )
}

#[derive(Debug, Serialize)]
struct TaskRunEnvelope {
    task_run: TaskRun,
}

#[derive(Debug, Serialize)]
struct ExecutionEnvelope {
    execution: ExecutionProcessRecord,
}

#[derive(Debug, Serialize)]
struct TaskRunsResponse {
    runs: Vec<TaskRun>,
}

#[derive(Debug, Deserialize)]
struct CreateTaskRunRequest {
    task_id: Uuid,
    executor: Option<String>,
}

async fn create_task_run(
    State(state): State<AppState>,
    Json(payload): Json<CreateTaskRunRequest>,
) -> Result<Json<TaskRunEnvelope>, ApiError> {
    let run = TaskService::new(state.runtime())
        .create_task_run(payload.task_id, payload.executor)
        .await?;

    Ok(Json(TaskRunEnvelope { task_run: run }))
}

#[derive(Debug, Deserialize)]
struct UpdateGitRequest {
    branch: Option<String>,
    target_branch: Option<String>,
    container_ref: Option<String>,
    workspace_path: Option<String>,
}

async fn update_task_run_git(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
    Json(payload): Json<UpdateGitRequest>,
) -> Result<Json<TaskRunEnvelope>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &identifier).await?;
    let UpdateGitRequest {
        branch,
        target_branch,
        container_ref,
        workspace_path,
    } = payload;
    let run = TaskService::new(state.runtime())
        .update_task_run_git(id, branch, target_branch, container_ref, workspace_path)
        .await?;
    Ok(Json(TaskRunEnvelope { task_run: run }))
}

#[derive(Debug, Deserialize)]
struct StartExecutionProcessRequest {
    task_attempt_id: Uuid,
    run_reason: Option<String>,
    executor: Option<String>,
    resume_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StartExecutionSessionRequest {
    prompt: String,
    workspace_path: String,
    resume_session_id: Option<String>,
    force_new_attempt: Option<bool>,
    task_id: Option<Uuid>,
    executor_profile_id: Option<ExecutorProfileId>,
    image_ids: Option<Vec<Uuid>>,
    /// If false, skip worktree creation and work directly in workspace_path.
    /// Defaults to true for backward compatibility.
    use_worktree: Option<bool>,
    /// Base branch to create the worktree from.
    /// If None, falls back to the current branch of the workspace (then "main").
    target_branch: Option<String>,
    #[serde(default)]
    selected_skill_ids: Vec<String>,
    #[serde(default)]
    context_refs: Vec<ContextRefRequest>,
}

#[derive(Debug, Serialize)]
struct StartExecutionSessionResponse {
    execution_id: Uuid,
    task_run_id: Uuid,
    task_id: Uuid,
    project_id: Uuid,
    executor_session_id: Uuid,
    task_slug: Option<String>,
    task_run_slug: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum TaskMessageRequestMode {
    #[default]
    Auto,
    New,
}

impl From<TaskMessageRequestMode> for TaskMessageMode {
    fn from(value: TaskMessageRequestMode) -> Self {
        match value {
            TaskMessageRequestMode::Auto => TaskMessageMode::Auto,
            TaskMessageRequestMode::New => TaskMessageMode::New,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SendTaskMessageRequest {
    prompt: String,
    #[serde(default)]
    mode: TaskMessageRequestMode,
    executor_profile_id: Option<ExecutorProfileId>,
    image_ids: Option<Vec<Uuid>>,
    use_worktree: Option<bool>,
    target_branch: Option<String>,
    #[serde(default)]
    selected_skill_ids: Vec<String>,
    #[serde(default)]
    context_refs: Vec<ContextRefRequest>,
}

/// Run an execution-start flow on its own task, detached from the HTTP
/// request. When the client aborts the request mid-flight (navigating away or
/// pressing Stop during the create window closes the fetch), axum drops the
/// handler future; without detachment that drop cancels provisioning halfway
/// through (task row inserted, worktree missing, executor never spawned) and
/// strands the session as a zombie. Spawned here, the work always reaches a
/// terminal state; an aborted request only loses the response.
async fn run_detached<T, F>(work: F) -> Result<T, RuntimeError>
where
    F: std::future::Future<Output = Result<T, RuntimeError>> + Send + 'static,
    T: Send + 'static,
{
    match tokio::spawn(work).await {
        Ok(result) => result,
        Err(join_error) => Err(RuntimeError::Other(anyhow::anyhow!(
            "execution start task did not complete: {join_error}"
        ))),
    }
}

fn start_execution_response(
    result: &runtime::ExecutionSessionStart,
) -> StartExecutionSessionResponse {
    StartExecutionSessionResponse {
        execution_id: result.task_run.id,
        task_run_id: result.task_run.id,
        task_id: result.task.id,
        project_id: result.project.id,
        executor_session_id: result.executor_session_id,
        task_slug: result.task.slug.clone(),
        task_run_slug: result.task_run.slug.clone(),
    }
}

async fn start_execution_process(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<StartExecutionProcessRequest>,
) -> Result<Json<ExecutionEnvelope>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let runtime = state.runtime().clone();
    let params = StartExecutionProcessParams {
        run_reason: payload.run_reason.clone(),
        executor: payload.executor.clone(),
        resume_session_id: payload.resume_session_id.clone(),
    };
    let run = run_detached(async move {
        TaskService::new(&runtime)
            .start_execution_process(id, params)
            .await
    })
    .await?;
    Ok(Json(ExecutionEnvelope {
        execution: ExecutionProcessRecord::from_run(&run, payload.task_attempt_id),
    }))
}

async fn start_execution_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<StartExecutionSessionRequest>,
) -> Result<Json<StartExecutionSessionResponse>, ApiError> {
    let request_started_at = Instant::now();
    let request_id = perf::request_id_from_headers(&headers);
    let image_count = payload.image_ids.as_ref().map_or(0, Vec::len);

    perf::record_backend_event(
        "execution_request_received",
        serde_json::json!({
            "request_id": request_id.clone(),
            "kind": "start",
            "task_id": payload.task_id,
            "prompt_chars": payload.prompt.chars().count(),
            "workspace_path": payload.workspace_path,
            "force_new_attempt": payload.force_new_attempt,
            "image_count": image_count,
            "skill_count": payload.selected_skill_ids.len(),
            "context_ref_count": payload.context_refs.len(),
            "use_worktree": payload.use_worktree,
            "target_branch": payload.target_branch,
            "executor_profile_set": payload.executor_profile_id.is_some(),
        }),
    );

    let context_refs =
        resolve_context_refs(state.pool(), &payload.prompt, &payload.context_refs).await?;
    let runtime = state.runtime().clone();
    let params = StartExecutionSessionParams {
        prompt: Some(payload.prompt.clone()),
        workspace_path: PathBuf::from(&payload.workspace_path),
        resume_session_id: payload.resume_session_id.clone(),
        force_new_attempt: payload.force_new_attempt,
        task_id: payload.task_id,
        executor_profile_id: payload.executor_profile_id.clone(),
        image_ids: payload.image_ids.clone(),
        use_worktree: payload.use_worktree,
        target_branch: payload.target_branch.clone(),
        selected_skill_ids: payload.selected_skill_ids.clone(),
        context_refs,
    };
    let result = run_detached(async move {
        TaskService::new(&runtime)
            .start_execution_session(params)
            .await
    })
    .await;

    let result = match result {
        Ok(result) => result,
        Err(err) => {
            perf::record_backend_event(
                "execution_request_failed",
                serde_json::json!({
                    "request_id": request_id,
                    "kind": "start",
                    "duration_ms": perf::elapsed_ms(request_started_at),
                    "error": err.to_string(),
                }),
            );
            return Err(err.into());
        }
    };

    perf::record_backend_event(
        "execution_request_completed",
        serde_json::json!({
            "request_id": request_id,
            "kind": "start",
            "task_id": result.task.id,
            "task_run_id": result.task_run.id,
            "project_id": result.project.id,
            "executor_session_id": result.executor_session_id,
            "duration_ms": perf::elapsed_ms(request_started_at),
        }),
    );

    analytics::capture_nonblocking(
        "execution_started",
        serde_json::json!({
            "is_follow_up": false,
            "prompt_chars": payload.prompt.chars().count(),
            "image_count": image_count,
            "use_worktree": payload.use_worktree.unwrap_or(true),
        }),
    );

    Ok(Json(start_execution_response(&result)))
}

#[derive(Debug, Deserialize)]
struct UpdateStatusRequest {
    status: RunStatus,
    exit_code: Option<i32>,
}

async fn update_execution_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateStatusRequest>,
) -> Result<Json<ExecutionEnvelope>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskService::new(state.runtime())
        .update_execution_status(id, payload.status, payload.exit_code)
        .await?;

    match payload.status {
        RunStatus::Completed => {
            analytics::capture_nonblocking(
                "execution_completed",
                serde_json::json!({ "exit_code": payload.exit_code }),
            );
        }
        RunStatus::Failed => {
            analytics::capture_nonblocking(
                "execution_failed",
                serde_json::json!({ "exit_code": payload.exit_code }),
            );
        }
        _ => {}
    }

    Ok(Json(ExecutionEnvelope {
        execution: ExecutionProcessRecord::from_run(&run, id),
    }))
}

#[derive(Debug, Deserialize)]
struct AppendLogsRequest {
    entries: Vec<LogEntry>,
}

#[derive(Debug, Serialize)]
struct TaskRunLogsResponse {
    entries: Vec<LogEntry>,
}

async fn append_task_run_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<AppendLogsRequest>,
) -> Result<StatusCode, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    if payload.entries.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }

    let _ = TaskRun::get(state.pool(), id).await?;
    state.runtime().append_logs(id, &payload.entries).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_task_run_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TaskRunLogsResponse>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let entries = state.runtime().fetch_logs(id).await?;
    Ok(Json(TaskRunLogsResponse { entries }))
}

#[derive(Debug, Serialize)]
struct TaskTranscriptResponse {
    task_id: Uuid,
    markdown: String,
}

/// Render the markdown transcript for a task without writing to disk. The
/// runtime inlines this content into prompts at execution time, so the
/// desktop UI and CLI both rely on this read-only endpoint.
async fn get_task_transcript(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskTranscriptResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let markdown = state.runtime().task_transcript_markdown(task_id).await?;
    Ok(Json(TaskTranscriptResponse { task_id, markdown }))
}

#[derive(Debug, Deserialize)]
struct TaskRunSelector {
    /// 1-indexed run sequence (chronological). When omitted, the latest run
    /// for the task is used.
    run: Option<u32>,
}

async fn resolve_task_run_for_task(
    state: &AppState,
    task_id: Uuid,
    run: Option<u32>,
) -> Result<TaskRun, ApiError> {
    let mut runs = TaskRun::list_by_task_id(state.pool(), task_id).await?;
    if runs.is_empty() {
        return Err(ApiError::NotFound);
    }
    // list_by_task_id returns DESC; reverse to chronological order.
    runs.reverse();
    let index = match run {
        Some(n) if n >= 1 => (n as usize) - 1,
        Some(_) => {
            return Err(ApiError::BadRequest(
                "run must be a positive 1-indexed sequence".into(),
            ));
        }
        None => runs.len() - 1,
    };
    runs.into_iter().nth(index).ok_or(ApiError::NotFound)
}

async fn cancel_task_execution(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Query(selector): Query<TaskRunSelector>,
) -> Result<StatusCode, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let run = resolve_task_run_for_task(&state, task_id, selector.run).await?;
    state.runtime().cancel_execution(run.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
struct TaskDiffResponse {
    task_id: Uuid,
    task_run_id: Uuid,
    branch_name: Option<String>,
    target_branch: Option<String>,
    status: RunStatus,
    before_head_commit: Option<String>,
    after_head_commit: Option<String>,
}

async fn get_task_diff(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Query(selector): Query<TaskRunSelector>,
) -> Result<Json<TaskDiffResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let run = resolve_task_run_for_task(&state, task_id, selector.run).await?;
    Ok(Json(TaskDiffResponse {
        task_id,
        task_run_id: run.id,
        branch_name: run.branch_name.clone(),
        target_branch: run.target_branch.clone(),
        status: run.status,
        before_head_commit: run.before_head_commit.clone(),
        after_head_commit: run.after_head_commit.clone(),
    }))
}

async fn merge_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Query(selector): Query<TaskRunSelector>,
    Json(payload): Json<MergeTaskRunRequest>,
) -> Result<Json<MergeTaskRunResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let run = resolve_task_run_for_task(&state, task_id, selector.run).await?;
    let result = TaskService::new(state.runtime())
        .merge_task_run(run.id, payload.commit_message)
        .await?;

    Ok(Json(MergeTaskRunResponse {
        merge_commit: result.merge_commit,
        target_branch: result.target_branch,
    }))
}

async fn rebase_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Query(selector): Query<TaskRunSelector>,
    Json(payload): Json<RebaseTaskRunRequest>,
) -> Result<Json<RebaseTaskRunResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let run = resolve_task_run_for_task(&state, task_id, selector.run).await?;
    let outcome = TaskService::new(state.runtime())
        .rebase_task_run(
            run.id,
            payload.new_base_branch.clone(),
            payload.old_base_branch.clone(),
        )
        .await?;

    Ok(Json(RebaseTaskRunResponse {
        success: true,
        new_base_branch: outcome.new_base_branch,
    }))
}

async fn cancel_execution(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    state.runtime().cancel_execution(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct FollowUpRequest {
    prompt: String,
    #[serde(default)]
    selected_skill_ids: Vec<String>,
    #[serde(default)]
    context_refs: Vec<ContextRefRequest>,
}

#[derive(Debug, Deserialize)]
struct ForkRequest {
    /// Omitted for General chats and non-git projects, where there is nothing to
    /// choose: the fork always shares the source directory.
    #[serde(default)]
    workspace: Option<ForkWorkspace>,
}

#[derive(Debug, Serialize)]
struct ForkResponse {
    task: TaskRecord,
    /// `digest` tells the client the conversation could not be duplicated, so it
    /// can say why instead of silently starting a thinner session.
    mode: ForkMode,
}

/// Branch the session at this run into a new task.
///
/// The new task is created idle: forking is not a request, so nothing starts
/// until the user writes the first turn.
async fn fork_task_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ForkRequest>,
) -> Result<Json<ForkResponse>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let outcome = TaskService::new(state.runtime())
        .fork_task(id, payload.workspace.unwrap_or(ForkWorkspace::Same))
        .await?;
    Ok(Json(ForkResponse {
        task: outcome.task,
        mode: outcome.mode,
    }))
}

/// Fork a session from its latest finished run.
///
/// The session-list entry point: it has no anchor to pass, so the server picks
/// the newest one.
async fn fork_task_latest(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ForkRequest>,
) -> Result<Json<ForkResponse>, ApiError> {
    let id = resolve_task_id(state.pool(), &id).await?;
    let outcome = TaskService::new(state.runtime())
        .fork_task_latest(id, payload.workspace.unwrap_or(ForkWorkspace::Same))
        .await?;
    Ok(Json(ForkResponse {
        task: outcome.task,
        mode: outcome.mode,
    }))
}

#[derive(Debug, Deserialize)]
struct DelegateRequest {
    /// The brief for the delegated work; becomes the child session's first
    /// prompt (its boot prompt also carries a digest of the delegating
    /// session).
    prompt: String,
}

#[derive(Debug, Serialize)]
struct DelegateResponse {
    task: TaskRecord,
}

/// Delegate a piece of this session's work to a new session.
///
/// Unlike fork, delegation is a request: the child starts running
/// immediately, and its completion hands back to this session and wakes it.
async fn delegate_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<DelegateRequest>,
) -> Result<Json<DelegateResponse>, ApiError> {
    let id = resolve_task_id(state.pool(), &id).await?;
    let task = TaskService::new(state.runtime())
        .delegate_task(id, payload.prompt, None)
        .await?;
    Ok(Json(DelegateResponse { task }))
}

async fn follow_up_execution(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<FollowUpRequest>,
) -> Result<Json<StartExecutionSessionResponse>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let request_started_at = Instant::now();
    let request_id = perf::request_id_from_headers(&headers);

    perf::record_backend_event(
        "execution_request_received",
        serde_json::json!({
            "request_id": request_id.clone(),
            "kind": "follow_up",
            "task_run_id": id,
            "prompt_chars": payload.prompt.chars().count(),
            "skill_count": payload.selected_skill_ids.len(),
            "context_ref_count": payload.context_refs.len(),
        }),
    );

    let context_refs =
        resolve_context_refs(state.pool(), &payload.prompt, &payload.context_refs).await?;
    let runtime = state.runtime().clone();
    let prompt = payload.prompt.clone();
    let selected_skill_ids = payload.selected_skill_ids.clone();
    let result = run_detached(async move {
        TaskService::new(&runtime)
            .follow_up_execution_with_context_refs(id, prompt, selected_skill_ids, context_refs)
            .await
    })
    .await;

    let result = match result {
        Ok(result) => result,
        Err(err) => {
            perf::record_backend_event(
                "execution_request_failed",
                serde_json::json!({
                    "request_id": request_id,
                    "kind": "follow_up",
                    "task_run_id": id,
                    "duration_ms": perf::elapsed_ms(request_started_at),
                    "error": err.to_string(),
                }),
            );
            return Err(err.into());
        }
    };

    perf::record_backend_event(
        "execution_request_completed",
        serde_json::json!({
            "request_id": request_id,
            "kind": "follow_up",
            "previous_task_run_id": id,
            "task_id": result.task.id,
            "task_run_id": result.task_run.id,
            "project_id": result.project.id,
            "executor_session_id": result.executor_session_id,
            "duration_ms": perf::elapsed_ms(request_started_at),
        }),
    );

    analytics::capture_nonblocking(
        "execution_started",
        serde_json::json!({
            "is_follow_up": true,
            "prompt_chars": payload.prompt.chars().count(),
        }),
    );

    Ok(Json(start_execution_response(&result)))
}

async fn send_task_message(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<SendTaskMessageRequest>,
) -> Result<Json<StartExecutionSessionResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let request_started_at = Instant::now();
    let request_id = perf::request_id_from_headers(&headers);
    let image_count = payload.image_ids.as_ref().map_or(0, Vec::len);
    let requested_mode = payload.mode;

    perf::record_backend_event(
        "execution_request_received",
        serde_json::json!({
            "request_id": request_id.clone(),
            "kind": "task_message",
            "task_id": task_id,
            "requested_mode": requested_mode,
            "prompt_chars": payload.prompt.chars().count(),
            "image_count": image_count,
            "skill_count": payload.selected_skill_ids.len(),
            "context_ref_count": payload.context_refs.len(),
            "use_worktree": payload.use_worktree,
            "target_branch": payload.target_branch,
            "executor_profile_set": payload.executor_profile_id.is_some(),
        }),
    );

    let context_refs =
        resolve_context_refs(state.pool(), &payload.prompt, &payload.context_refs).await?;
    let runtime = state.runtime().clone();
    let params = SendTaskMessageParams {
        task_id,
        prompt: payload.prompt.clone(),
        mode: requested_mode.into(),
        executor_profile_id: payload.executor_profile_id.clone(),
        image_ids: payload.image_ids.clone(),
        use_worktree: payload.use_worktree,
        target_branch: payload.target_branch.clone(),
        selected_skill_ids: payload.selected_skill_ids.clone(),
        context_refs,
    };
    let result =
        run_detached(async move { TaskService::new(&runtime).send_task_message(params).await })
            .await;

    let result = match result {
        Ok(result) => result,
        Err(err) => {
            perf::record_backend_event(
                "execution_request_failed",
                serde_json::json!({
                    "request_id": request_id,
                    "kind": "task_message",
                    "task_id": task_id,
                    "requested_mode": requested_mode,
                    "duration_ms": perf::elapsed_ms(request_started_at),
                    "error": err.to_string(),
                }),
            );
            return Err(err.into());
        }
    };

    perf::record_backend_event(
        "execution_request_completed",
        serde_json::json!({
            "request_id": request_id,
            "kind": "task_message",
            "task_id": result.execution.task.id,
            "task_run_id": result.execution.task_run.id,
            "project_id": result.execution.project.id,
            "executor_session_id": result.execution.executor_session_id,
            "requested_mode": requested_mode,
            "continued_existing_run": result.continued_existing_run,
            "previous_task_run_id": result.previous_task_run_id,
            "duration_ms": perf::elapsed_ms(request_started_at),
        }),
    );

    analytics::capture_nonblocking(
        "execution_started",
        serde_json::json!({
            "is_follow_up": result.continued_existing_run,
            "requested_mode": requested_mode,
            "prompt_chars": payload.prompt.chars().count(),
            "image_count": image_count,
            "use_worktree": payload.use_worktree.unwrap_or(true),
        }),
    );

    Ok(Json(start_execution_response(&result.execution)))
}

async fn follow_up_by_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<FollowUpRequest>,
) -> Result<Json<StartExecutionSessionResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let request_started_at = Instant::now();
    let request_id = perf::request_id_from_headers(&headers);

    perf::record_backend_event(
        "execution_request_received",
        serde_json::json!({
            "request_id": request_id.clone(),
            "kind": "follow_up",
            "task_id": task_id,
            "prompt_chars": payload.prompt.chars().count(),
            "skill_count": payload.selected_skill_ids.len(),
            "context_ref_count": payload.context_refs.len(),
        }),
    );

    let context_refs =
        resolve_context_refs(state.pool(), &payload.prompt, &payload.context_refs).await?;
    let runtime = state.runtime().clone();
    let params = SendTaskMessageParams {
        task_id,
        prompt: payload.prompt.clone(),
        mode: TaskMessageMode::Auto,
        executor_profile_id: None,
        image_ids: None,
        use_worktree: None,
        target_branch: None,
        selected_skill_ids: payload.selected_skill_ids.clone(),
        context_refs,
    };
    let result =
        run_detached(async move { TaskService::new(&runtime).send_task_message(params).await })
            .await;

    let result = match result {
        Ok(result) => result,
        Err(err) => {
            perf::record_backend_event(
                "execution_request_failed",
                serde_json::json!({
                    "request_id": request_id,
                    "kind": "follow_up",
                    "task_id": task_id,
                    "duration_ms": perf::elapsed_ms(request_started_at),
                    "error": err.to_string(),
                }),
            );
            return Err(err.into());
        }
    };

    perf::record_backend_event(
        "execution_request_completed",
        serde_json::json!({
            "request_id": request_id,
            "kind": "follow_up",
            "task_id": result.execution.task.id,
            "task_run_id": result.execution.task_run.id,
            "project_id": result.execution.project.id,
            "executor_session_id": result.execution.executor_session_id,
            "continued_existing_run": result.continued_existing_run,
            "previous_task_run_id": result.previous_task_run_id,
            "duration_ms": perf::elapsed_ms(request_started_at),
        }),
    );

    analytics::capture_nonblocking(
        "execution_started",
        serde_json::json!({
            "is_follow_up": result.continued_existing_run,
            "prompt_chars": payload.prompt.chars().count(),
        }),
    );

    Ok(Json(start_execution_response(&result.execution)))
}

#[derive(Debug, Deserialize)]
struct DiffStreamQuery {
    stats_only: Option<bool>,
}

async fn stream_task_run_diff(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<DiffStreamQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let stats_only = params.stats_only.unwrap_or(false);
    Ok(ws.on_upgrade(move |socket| handle_task_run_diff_ws(socket, state, id, stats_only)))
}

async fn handle_task_run_diff_ws(
    socket: WebSocket,
    state: AppState,
    task_run_id: Uuid,
    stats_only: bool,
) {
    let (mut sender, mut ws_receiver) = socket.split();

    tokio::spawn(async move { while let Some(Ok(_)) = ws_receiver.next().await {} });

    let stream_result = state.runtime().stream_diff(task_run_id, stats_only).await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(%task_run_id, error = %err, "[handle_task_run_diff_ws] failed to create diff stream");
            let error_json = serde_json::json!({"error": err.to_string()}).to_string();
            let _ = sender.send(Message::Text(error_json.into())).await;
            return;
        }
    };

    while let Some(result) = stream.next().await {
        let msg = match result {
            Ok(entry) => entry.to_ws_message_unchecked(),
            Err(err) => {
                let error_json = serde_json::json!({"error": err.to_string()}).to_string();
                Message::Text(error_json.into())
            }
        };
        if sender.send(msg).await.is_err() {
            break;
        }
    }
}

async fn mark_worktree_deleted(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    TaskService::new(state.runtime())
        .mark_worktree_deleted(id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Default)]
struct MergeTaskRunRequest {
    commit_message: Option<String>,
}

#[derive(Debug, Serialize)]
struct MergeTaskRunResponse {
    merge_commit: String,
    target_branch: String,
}

async fn merge_task_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<MergeTaskRunRequest>,
) -> Result<Json<MergeTaskRunResponse>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let result = TaskService::new(state.runtime())
        .merge_task_run(id, payload.commit_message)
        .await?;

    Ok(Json(MergeTaskRunResponse {
        merge_commit: result.merge_commit,
        target_branch: result.target_branch,
    }))
}

#[derive(Debug, Deserialize)]
struct RebaseTaskRunRequest {
    new_base_branch: String,
    old_base_branch: Option<String>,
}

#[derive(Debug, Serialize)]
struct RebaseTaskRunResponse {
    success: bool,
    new_base_branch: String,
}

async fn rebase_task_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<RebaseTaskRunRequest>,
) -> Result<Json<RebaseTaskRunResponse>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let outcome = TaskService::new(state.runtime())
        .rebase_task_run(
            id,
            payload.new_base_branch.clone(),
            payload.old_base_branch.clone(),
        )
        .await?;

    Ok(Json(RebaseTaskRunResponse {
        success: true,
        new_base_branch: outcome.new_base_branch,
    }))
}

async fn abort_conflicts(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    TaskService::new(state.runtime())
        .abort_conflicts(id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
struct BranchListResponse {
    branches: Vec<git::BranchInfo>,
}

async fn list_task_run_branches(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BranchListResponse>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let branches = TaskService::new(state.runtime())
        .list_task_run_branches(id)
        .await?;

    Ok(Json(BranchListResponse { branches }))
}

#[derive(Debug, Serialize)]
struct BranchStatusResponse {
    commits_ahead: Option<usize>,
    commits_behind: Option<usize>,
    target_branch: Option<String>,
    is_rebase_in_progress: bool,
    merges: Vec<TaskMerge>,
    conflicted_files: Vec<String>,
    conflict_op: Option<git::ConflictOp>,
}

async fn get_task_run_branch_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BranchStatusResponse>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let status = TaskService::new(state.runtime())
        .get_task_run_branch_status(id)
        .await?;

    Ok(Json(BranchStatusResponse {
        commits_ahead: status.commits_ahead,
        commits_behind: status.commits_behind,
        target_branch: status.target_branch,
        is_rebase_in_progress: status.is_rebase_in_progress,
        merges: status.merges,
        conflicted_files: status.conflicted_files,
        conflict_op: status.conflict_op,
    }))
}

async fn get_task_runs(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskRunsResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let runs = TaskService::new(state.runtime())
        .list_task_runs(task_id)
        .await?;
    Ok(Json(TaskRunsResponse { runs }))
}

async fn get_latest_active_run(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<TaskRunWithTaskResponse>, ApiError> {
    let project_id = resolve_project_id(state.pool(), &project_id).await?;
    let bundle = TaskService::new(state.runtime())
        .latest_active_run(project_id)
        .await?;

    Ok(Json(TaskRunWithTaskResponse {
        task_run: bundle.run,
        task: bundle.task,
    }))
}

async fn find_task_run_by_session_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<Option<Uuid>>, ApiError> {
    use db::models::TaskSession;
    let run_id = TaskSession::latest_run_id_by_external_session(state.pool(), &session_id).await?;

    Ok(Json(run_id))
}

async fn get_task_run_with_task(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<Json<TaskRunTaskProjectResponse>, ApiError> {
    let run_id = resolve_task_run_id(state.pool(), &run_id).await?;
    let bundle = TaskService::new(state.runtime())
        .fetch_run_task_project(run_id)
        .await?;

    Ok(Json(TaskRunTaskProjectResponse {
        task_run: bundle.run,
        task: bundle.task,
        project: bundle.project,
    }))
}

async fn upload_task_run_image(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    multipart: axum::extract::Multipart,
) -> Result<Json<super::ImageEnvelope>, ApiError> {
    let run_id = resolve_task_run_id(state.pool(), &run_id).await?;
    let run = TaskRun::get(state.pool(), run_id).await?;
    let image = super::process_image_upload(&state, multipart, Some(run.task_id)).await?;

    if let Some(container_ref) = &run.container_ref {
        let worktree_path = PathBuf::from(container_ref);
        if let Err(err) = state
            .runtime()
            .image()
            .copy_images_by_ids_to_worktree(&worktree_path, &[image.id])
            .await
        {
            tracing::warn!("Failed to copy image to worktree: {}", err);
        }
    }

    Ok(Json(super::ImageEnvelope { image }))
}

async fn upload_task_image(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    multipart: axum::extract::Multipart,
) -> Result<Json<super::ImageEnvelope>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let _ = TaskRecord::get(state.pool(), task_id).await?;
    let image = super::process_image_upload(&state, multipart, Some(task_id)).await?;

    if let Some(run) = TaskRun::latest_for_task(state.pool(), task_id).await? {
        if let Some(container_ref) = &run.container_ref {
            let worktree_path = PathBuf::from(container_ref);
            if let Err(err) = state
                .runtime()
                .image()
                .copy_images_by_ids_to_worktree(&worktree_path, &[image.id])
                .await
            {
                tracing::warn!("Failed to copy image to worktree: {}", err);
            }
        }
    }

    Ok(Json(super::ImageEnvelope { image }))
}

async fn list_task_images(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<ImageListResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let _ = TaskRecord::get(state.pool(), task_id).await?;
    let image_service = state.runtime().image();
    let images = image_service.get_task_images(task_id).await?;
    let responses = images
        .into_iter()
        .map(|image| ImageResponse::from_asset(image, image_service))
        .collect();
    Ok(Json(ImageListResponse { images: responses }))
}

#[derive(Debug, Deserialize)]
struct TaskRunFileQuery {
    relative_path: String,
}

/// Resolve a task run to its worktree root plus the project's main-checkout
/// path. The worktree is the actual location reads/writes target; the project
/// root is a secondary candidate so absolute paths emitted by the agent
/// (which often reference the host source checkout) can be normalized.
async fn task_run_path_candidates(
    state: &AppState,
    run: &TaskRun,
) -> Result<(String, Vec<String>), ApiError> {
    let worktree = run
        .container_ref
        .as_deref()
        .or(run.workspace_path.as_deref())
        .ok_or_else(|| ApiError::BadRequest("task run has no workspace path".into()))?
        .to_string();
    let mut candidates = vec![worktree.clone()];
    if let Ok(task) = TaskRecord::get(state.pool(), run.task_id).await {
        if let Ok(project) = ProjectRecord::get(state.pool(), task.project_id).await {
            if !project.git_repo_path.is_empty() && project.git_repo_path != worktree {
                candidates.push(project.git_repo_path);
            }
        }
    }
    // Extend with every other registered project's checkout so a relative path
    // that names a file living in a *different* project (e.g. an asset path
    // shown in this run's conversation) still resolves. The workspace spans all
    // projects, not just this run's own checkout. Reads try candidates in order
    // (see `first_readable_root`); mutations stay confined to the worktree via
    // `resolve_task_run_full_path`, which ignores these extra candidates.
    candidates.extend(workspace_extra_roots(state, &candidates).await);
    Ok((worktree, candidates))
}

/// Every registered project's git checkout root, excluding any already in
/// `existing`. Backs multi-root path resolution: a relative reference with no
/// project identity resolves against the whole workspace of projects. A DB
/// failure degrades to no extra roots (single-project behavior) rather than
/// failing the read.
async fn workspace_extra_roots(state: &AppState, existing: &[String]) -> Vec<String> {
    let projects = match ProjectRecord::list_all(state.pool()).await {
        Ok(projects) => projects,
        Err(error) => {
            tracing::warn!(%error, "failed to list projects for multi-root path resolution");
            return Vec::new();
        }
    };
    let mut roots: Vec<String> = Vec::new();
    for project in projects {
        let root = project.git_repo_path;
        if root.is_empty() || existing.contains(&root) || roots.contains(&root) {
            continue;
        }
        roots.push(root);
    }
    roots
}

async fn read_task_run_binary_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TaskRunFileQuery>,
) -> Result<Response, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let run = TaskRun::get(state.pool(), id).await?;
    let (worktree, candidates) = task_run_path_candidates(&state, &run).await?;
    let candidate_refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
    let service = ProjectFileService::new(state.runtime(), PathBuf::from(&worktree));
    let binary_file =
        read_binary_resolving(&service, &query.relative_path, &candidate_refs).await?;

    stream_binary_response(binary_file, "no-cache").await
}

/// Path-based asset endpoint for HTML preview. See `read_project_asset`.
async fn read_task_run_asset(
    State(state): State<AppState>,
    Path((id, relative_path)): Path<(String, String)>,
    Query(asset_query): Query<AssetQuery>,
) -> Result<Response, ApiError> {
    if relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest("asset path is required".into()));
    }
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskRun::get(state.pool(), id).await?;
    let (worktree, candidates) = task_run_path_candidates(&state, &run).await?;
    let candidate_refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
    let service = ProjectFileService::new(state.runtime(), PathBuf::from(&worktree));
    let binary_file = read_binary_resolving(&service, &relative_path, &candidate_refs).await?;

    stream_asset_response(binary_file, &asset_query).await
}

#[derive(Debug, Serialize)]
struct TaskRunFileEnvelope {
    file: TaskRunFileResponse,
}

#[derive(Debug, Serialize)]
struct TaskRunFileResponse {
    relative_path: String,
    content: String,
    size: u64,
    truncated: bool,
    modified_at: Option<String>,
}

async fn read_task_run_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TaskRunFileQuery>,
) -> Result<Json<TaskRunFileEnvelope>, ApiError> {
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskRun::get(state.pool(), id).await?;
    let (worktree, candidates) = task_run_path_candidates(&state, &run).await?;
    let candidate_refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
    let service = ProjectFileService::new(state.runtime(), PathBuf::from(&worktree));
    let file = read_text_resolving(&service, &query.relative_path, &candidate_refs).await?;

    Ok(Json(TaskRunFileEnvelope {
        file: TaskRunFileResponse {
            relative_path: file.relative_path,
            content: file.content,
            size: file.size,
            truncated: file.truncated,
            modified_at: crate::format_system_time(file.modified),
        },
    }))
}

/// Resolve a worktree-relative path to its absolute location inside the run's
/// worktree, rejecting paths that escape the worktree boundary. Mirrors the
/// project-scoped boundary check in `projects::reveal_in_finder` so a session
/// sandbox row resolves against its own checkout rather than the project root.
async fn resolve_task_run_full_path(
    state: &AppState,
    run: &TaskRun,
    relative_path: &str,
) -> Result<PathBuf, ApiError> {
    let (worktree, _candidates) = task_run_path_candidates(state, run).await?;
    let worktree = PathBuf::from(worktree);
    let full_path = worktree.join(relative_path.trim_start_matches('/'));
    if !full_path.starts_with(&worktree) {
        return Err(ApiError::BadRequest(
            "path is outside worktree boundary".into(),
        ));
    }
    Ok(full_path)
}

#[derive(Debug, Serialize)]
struct TaskRunAbsolutePathResponse {
    absolute_path: String,
}

/// Resolve a worktree-relative path to its absolute on-disk path. Powers the
/// session-sandbox "Copy Absolute Path" action, where the client lacks the
/// worktree root and so cannot join the path itself.
async fn get_task_run_absolute_path(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TaskRunFileQuery>,
) -> Result<Json<TaskRunAbsolutePathResponse>, ApiError> {
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskRun::get(state.pool(), id).await?;
    let full_path = resolve_task_run_full_path(&state, &run, &query.relative_path).await?;

    Ok(Json(TaskRunAbsolutePathResponse {
        absolute_path: full_path.to_string_lossy().into_owned(),
    }))
}

#[derive(Debug, Deserialize)]
struct TaskRunRevealRequest {
    relative_path: String,
}

/// Reveal a worktree-relative path in the platform's file manager. The
/// project-scoped `reveal_in_finder` resolves against the project root, which
/// would point at the wrong checkout for a session sandbox, so this endpoint
/// resolves against the run's worktree instead.
async fn reveal_task_run_in_finder(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<TaskRunRevealRequest>,
) -> Result<StatusCode, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskRun::get(state.pool(), id).await?;
    let full_path = resolve_task_run_full_path(&state, &run, &payload.relative_path).await?;

    let fs_service = filesystem::FilesystemService::new();
    tokio::task::spawn_blocking(move || -> Result<(), filesystem::FilesystemError> {
        fs_service.reveal_in_file_manager(&full_path)
    })
    .await
    .map_err(|e| ApiError::BadRequest(format!("spawn failed: {e}")))?
    .map_err(ApiError::Filesystem)?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct TaskRunEntriesQuery {
    relative_path: Option<String>,
    /// If true, returns the entire tree structure recursively.
    #[serde(default)]
    recursive: bool,
    /// Entry payload detail level: "basic" | "full" (default: "full").
    detail: Option<String>,
}

/// List entries inside a task run's worktree. Mirrors `list_project_entries`
/// but roots the listing at the run's worktree (`container_ref`, falling back
/// to `workspace_path`) so the file tree can browse a session's sandbox rather
/// than the project's main checkout.
async fn list_task_run_entries(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TaskRunEntriesQuery>,
) -> Result<Json<super::projects::ProjectEntriesEnvelope>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskRun::get(state.pool(), id).await?;
    let (worktree, _candidates) = task_run_path_candidates(&state, &run).await?;
    let service = ProjectFileService::new(state.runtime(), PathBuf::from(&worktree));
    let detail = match query.detail.as_deref() {
        None => WorkspaceEntryDetail::Full,
        Some("basic") => WorkspaceEntryDetail::Basic,
        Some("full") => WorkspaceEntryDetail::Full,
        Some(_) => {
            return Err(ApiError::BadRequest(
                "query parameter 'detail' must be 'basic' or 'full'".into(),
            ));
        }
    };
    let entries = if query.recursive {
        service
            .list_entries_recursive(query.relative_path.as_deref(), detail)
            .await?
    } else {
        service
            .list_entries(query.relative_path.as_deref(), detail)
            .await?
    };

    Ok(Json(super::projects::ProjectEntriesEnvelope::from_entries(
        entries,
    )))
}

/// List renderable media inside a task run's worktree for the gallery. Mirrors
/// `list_project_media` but roots at the run's worktree so a session's
/// generated creatives are surfaced rather than the project main checkout.
async fn list_task_run_media(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<super::projects::MediaQuery>,
) -> Result<Json<super::projects::MediaEnvelope>, ApiError> {
    let id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskRun::get(state.pool(), id).await?;
    let (worktree, _candidates) = task_run_path_candidates(&state, &run).await?;
    let service = ProjectFileService::new(state.runtime(), PathBuf::from(&worktree));
    let (items, truncated) = service
        .list_media(super::projects::media_limit(query.limit))
        .await?;
    Ok(Json(super::projects::MediaEnvelope::from_media(
        items, truncated,
    )))
}

#[derive(Debug, Serialize)]
struct TaskRunWithTaskResponse {
    task_run: TaskRun,
    task: TaskRecord,
}

#[derive(Debug, Serialize)]
struct TaskRunTaskProjectResponse {
    task_run: TaskRun,
    task: TaskRecord,
    project: ProjectRecord,
}

#[derive(Debug, Serialize)]
struct ExecutionProcessRecord {
    id: Uuid,
    task_attempt_id: Uuid,
    run_reason: Option<String>,
    status: RunStatus,
    exit_code: Option<i32>,
    executor: Option<String>,
    resume_from_session_id: Option<String>,
    before_head_commit: Option<String>,
    after_head_commit: Option<String>,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl ExecutionProcessRecord {
    fn from_run(run: &TaskRun, attempt_id: Uuid) -> Self {
        Self {
            id: run.id,
            task_attempt_id: attempt_id,
            run_reason: run.run_reason.clone(),
            status: run.status,
            exit_code: run.exit_code,
            executor: run
                .executor_action
                .clone()
                .or_else(|| run.executor_label.clone()),
            resume_from_session_id: run.resume_session_id.clone(),
            before_head_commit: run.before_head_commit.clone(),
            after_head_commit: run.after_head_commit.clone(),
            started_at: run.started_at,
            completed_at: run.completed_at,
            created_at: run.created_at,
            updated_at: run.updated_at,
        }
    }
}
