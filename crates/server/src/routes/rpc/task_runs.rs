//! Task run (execution) endpoints: CRUD, logs, merge, rebase, diff streaming.

use std::{path::PathBuf, time::Instant};

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use db::{
    models::{ProjectRecord, TaskMerge, TaskRecord, TaskRun},
    types::RunStatus,
};
use executors::ExecutorProfileId;
use futures::{SinkExt, StreamExt};
use log_types::LogEntry;
use runtime::{
    ProjectFileService, Runtime, SendTaskMessageParams, StartExecutionProcessParams,
    StartExecutionSessionParams, TaskMessageMode, TaskService,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::images::{ImageListResponse, ImageResponse};
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
        .route("/tasks/:id/messages", post(send_task_message))
        .route("/tasks/:id/follow-up", post(follow_up_by_task))
        .route(
            "/task-runs/:id/logs",
            get(get_task_run_logs).post(append_task_run_logs),
        )
        .route("/task-runs/:id/diff", get(stream_task_run_diff))
        .route("/tasks/:id/transcript", post(generate_transcript))
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
    let run = TaskService::new(state.runtime())
        .start_execution_process(
            id,
            StartExecutionProcessParams {
                run_reason: payload.run_reason.clone(),
                executor: payload.executor.clone(),
                resume_session_id: payload.resume_session_id.clone(),
            },
        )
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
            "use_worktree": payload.use_worktree,
            "target_branch": payload.target_branch,
            "executor_profile_set": payload.executor_profile_id.is_some(),
        }),
    );

    let result = TaskService::new(state.runtime())
        .start_execution_session(StartExecutionSessionParams {
            prompt: Some(payload.prompt.clone()),
            workspace_path: PathBuf::from(&payload.workspace_path),
            resume_session_id: payload.resume_session_id.clone(),
            force_new_attempt: payload.force_new_attempt,
            task_id: payload.task_id,
            executor_profile_id: payload.executor_profile_id,
            image_ids: payload.image_ids.clone(),
            use_worktree: payload.use_worktree,
            target_branch: payload.target_branch.clone(),
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

#[derive(Debug, Deserialize)]
struct GenerateTranscriptRequest {
    workspace_path: String,
    /// Worktree path where the executor runs (container_ref).
    /// When present and different from workspace_path, the transcript file is
    /// copied there — same pattern as image uploads.
    container_ref: Option<String>,
}

#[derive(Debug, Serialize)]
struct GenerateTranscriptResponse {
    file_path: String,
}

async fn generate_transcript(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(payload): Json<GenerateTranscriptRequest>,
) -> Result<Json<GenerateTranscriptResponse>, ApiError> {
    let task_id = resolve_task_id(state.pool(), &task_id).await?;
    let workspace_path = PathBuf::from(&payload.workspace_path);
    let file_path = state
        .runtime()
        .generate_task_transcript(task_id, &workspace_path)
        .await?;

    // Copy transcript to the worktree (same pattern as image upload).
    if let Some(ref cr) = payload.container_ref {
        let worktree_path = PathBuf::from(&cr);
        if worktree_path != workspace_path {
            if let Err(err) = chro_image::ensure_context_dir(&worktree_path) {
                tracing::warn!("Failed to bootstrap context dir in worktree: {}", err);
            }
            let src = workspace_path.join(&file_path);
            let dst = worktree_path.join(&file_path);
            if let Some(parent) = dst.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(err) = std::fs::copy(&src, &dst) {
                tracing::warn!("Failed to copy transcript to worktree: {}", err);
            }
        }
    }

    Ok(Json(GenerateTranscriptResponse { file_path }))
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
        }),
    );

    let result = TaskService::new(state.runtime())
        .follow_up_execution(id, payload.prompt.clone())
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
            "use_worktree": payload.use_worktree,
            "target_branch": payload.target_branch,
            "executor_profile_set": payload.executor_profile_id.is_some(),
        }),
    );

    let result = TaskService::new(state.runtime())
        .send_task_message(SendTaskMessageParams {
            task_id,
            prompt: payload.prompt.clone(),
            mode: requested_mode.into(),
            executor_profile_id: payload.executor_profile_id,
            image_ids: payload.image_ids.clone(),
            use_worktree: payload.use_worktree,
            target_branch: payload.target_branch.clone(),
        })
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
        }),
    );

    let result = TaskService::new(state.runtime())
        .send_task_message(SendTaskMessageParams {
            task_id,
            prompt: payload.prompt.clone(),
            mode: TaskMessageMode::Auto,
            executor_profile_id: None,
            image_ids: None,
            use_worktree: None,
            target_branch: None,
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
    let root = run
        .container_ref
        .as_deref()
        .or(run.workspace_path.as_deref())
        .ok_or_else(|| ApiError::BadRequest("task run has no workspace path".into()))?;

    let binary_file = ProjectFileService::new(state.runtime(), PathBuf::from(root))
        .read_binary_file(&query.relative_path)
        .await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, binary_file.mime_type)
        .header(header::CONTENT_LENGTH, binary_file.size)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(binary_file.data))
        .unwrap())
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
