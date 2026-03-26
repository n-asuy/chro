//! Executor session management endpoints.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use db::{
    models::{AgentProfile, ProjectRecord, TaskRecord, TaskRun, TaskSession},
    types::RunStatus,
};
use runtime::canonicalize_path;
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Row, Sqlite};
use uuid::Uuid;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/task-sessions", post(create_executor_session))
        .route(
            "/task-sessions/:id/external",
            patch(update_session_external_id),
        )
        .route("/projects/:project_id/sessions", get(list_project_sessions))
}

/// Router for workspace-scoped session queries (mounted separately).
pub(super) fn sessions_by_workspace_router() -> Router<AppState> {
    Router::<AppState>::new()
        .route("/sessions", get(list_sessions_by_workspace))
        .route("/tasks", get(list_tasks_by_workspace))
}

#[derive(Debug, Serialize)]
struct SessionEnvelope {
    session: ExecutorSessionRecord,
}

#[derive(Debug, Serialize)]
struct SessionsResponse {
    sessions: Vec<SessionSummaryEntry>,
}

#[derive(Debug, Serialize)]
struct TasksResponse {
    tasks: Vec<TaskRecord>,
}

#[derive(Debug, Deserialize)]
struct CreateSessionRequest {
    task_attempt_id: Uuid,
    execution_process_id: Uuid,
    prompt: Option<String>,
}

async fn create_executor_session(
    State(state): State<AppState>,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<Json<SessionEnvelope>, ApiError> {
    let run = TaskRun::get(state.pool(), payload.task_attempt_id).await?;
    let agent_id = AgentProfile::ensure_default_desktop_profile(state.pool()).await?;
    let mut session = TaskSession::new(run.task_id, agent_id, payload.prompt.clone());
    session.task_run_id = Some(payload.execution_process_id);

    sqlx::query(
        "INSERT INTO task_sessions (id, task_id, task_run_id, agent_profile_id, external_session_id, prompt, summary, handoff_from_session_id, worktree_commit, state_snapshot, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)",
    )
    .bind(session.id)
    .bind(session.task_id)
    .bind(session.task_run_id)
    .bind(session.agent_profile_id)
    .bind(session.prompt.clone())
    .bind(session.created_at)
    .bind(session.updated_at)
    .execute(state.pool())
    .await?;

    Ok(Json(SessionEnvelope {
        session: ExecutorSessionRecord::from_session(
            &session,
            payload.task_attempt_id,
            payload.execution_process_id,
        ),
    }))
}

#[derive(Debug, Deserialize)]
struct UpdateExternalSessionRequest {
    session_id: String,
}

async fn update_session_external_id(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateExternalSessionRequest>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("UPDATE task_sessions SET external_session_id = ?, updated_at = ? WHERE id = ?")
        .bind(payload.session_id)
        .bind(Utc::now())
        .bind(id)
        .execute(state.pool())
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct WorkspaceSessionsQuery {
    workspace_path: Option<String>,
    project_id: Option<Uuid>,
}

async fn list_sessions_by_workspace(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceSessionsQuery>,
) -> Result<Json<SessionsResponse>, ApiError> {
    let project_id = if let Some(id) = query.project_id {
        Some(id)
    } else if let Some(path) = &query.workspace_path {
        let normalized = canonicalize_path(path)
            .await
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        let lookup_path = normalized.as_deref().unwrap_or(path);
        ProjectRecord::find_id_by_git_repo_path(state.pool(), lookup_path).await?
    } else {
        None
    };

    let Some(project_id) = project_id else {
        return Ok(Json(SessionsResponse { sessions: vec![] }));
    };

    let sessions = fetch_project_sessions(state.pool(), project_id).await?;
    Ok(Json(SessionsResponse { sessions }))
}

async fn list_tasks_by_workspace(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceSessionsQuery>,
) -> Result<Json<TasksResponse>, ApiError> {
    let project_id = if let Some(id) = query.project_id {
        Some(id)
    } else if let Some(path) = &query.workspace_path {
        let normalized = canonicalize_path(path)
            .await
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        let lookup_path = normalized.as_deref().unwrap_or(path);
        ProjectRecord::find_id_by_git_repo_path(state.pool(), lookup_path).await?
    } else {
        None
    };

    let Some(project_id) = project_id else {
        return Ok(Json(TasksResponse { tasks: vec![] }));
    };

    let tasks = TaskRecord::list_by_project(state.pool(), project_id).await?;
    Ok(Json(TasksResponse { tasks }))
}

async fn list_project_sessions(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<SessionsResponse>, ApiError> {
    let sessions = fetch_project_sessions(state.pool(), project_id).await?;
    Ok(Json(SessionsResponse { sessions }))
}

#[derive(Debug, Serialize)]
struct ExecutorSessionRecord {
    id: Uuid,
    task_attempt_id: Uuid,
    execution_process_id: Uuid,
    session_id: Option<String>,
    prompt: Option<String>,
    summary: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl ExecutorSessionRecord {
    fn from_session(session: &TaskSession, attempt_id: Uuid, execution_process_id: Uuid) -> Self {
        Self {
            id: session.id,
            task_attempt_id: attempt_id,
            execution_process_id,
            session_id: session.external_session_id.clone(),
            prompt: session.prompt.clone(),
            summary: session.summary.clone(),
            created_at: session.created_at,
            updated_at: session.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct SessionSummaryEntry {
    executor_session_id: Uuid,
    session_id: Option<String>,
    prompt: Option<String>,
    summary: Option<String>,
    task_id: Uuid,
    task_title: String,
    task_attempt_id: Uuid,
    execution_process_id: Uuid,
    status: RunStatus,
    exit_code: Option<i32>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

async fn fetch_project_sessions(
    pool: &Pool<Sqlite>,
    project_id: Uuid,
) -> Result<Vec<SessionSummaryEntry>, ApiError> {
    let rows = sqlx::query(
        "SELECT
            ts.id AS session_id,
            ts.external_session_id,
            ts.prompt,
            ts.summary,
            ts.created_at AS session_created_at,
            ts.updated_at AS session_updated_at,
            tr.id AS run_id,
            tr.status AS run_status,
            tr.exit_code,
            t.id AS task_id,
            t.title AS task_title
         FROM task_sessions ts
         JOIN task_runs tr ON ts.task_run_id = tr.id
         JOIN task_records t ON tr.task_id = t.id
         WHERE t.project_id = ?
         ORDER BY ts.created_at DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    let mut sessions = Vec::with_capacity(rows.len());
    for row in rows {
        let session_id: Uuid = row.get("session_id");
        let task_id: Uuid = row.get("task_id");
        let run_id: Uuid = row.get("run_id");
        let status: RunStatus = row.get("run_status");
        let exit_code: Option<i32> = row.get("exit_code");
        let created_at: DateTime<Utc> = row.get("session_created_at");
        let updated_at: DateTime<Utc> = row.get("session_updated_at");

        sessions.push(SessionSummaryEntry {
            executor_session_id: session_id,
            session_id: row.get("external_session_id"),
            prompt: row.get("prompt"),
            summary: row.get("summary"),
            task_id,
            task_title: row.get("task_title"),
            task_attempt_id: run_id,
            execution_process_id: run_id,
            status,
            exit_code,
            created_at,
            updated_at,
        });
    }

    Ok(sessions)
}
