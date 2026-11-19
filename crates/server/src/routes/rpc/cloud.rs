//! Session transport endpoints. The instance gateway owns caller authentication;
//! these routes are served by the same protected server as the ordinary RPC API.
use crate::{ApiError, AppState};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use local_runtime::cloud;
use runtime::{Runtime, StartExecutionSessionParams, TaskService};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/cloud/status",
            get(|| async { Json(cloud::status().await) }),
        )
        .route("/cloud/login", post(login))
        .route(
            "/cloud/repositories/:id",
            post(upload).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/cloud/repositories/:id/start", post(start))
        .route("/cloud/runs/:id/snapshot", get(snapshot))
        .route("/cloud/runs/:id/bundle", get(bundle))
        .route("/cloud/runs/:id/diff", get(diff))
}

async fn login() -> Result<Json<Value>, ApiError> {
    cloud::sign_in()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(json!({"signed_in": true})))
}

fn repository_path(state: &AppState, id: Uuid) -> std::path::PathBuf {
    // Per-server DB parent keeps local stand-ins and real instances isolated.
    state.runtime().cloud_repository_root().join(id.to_string())
}

async fn upload(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    bytes: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    let repo = repository_path(&state, id);
    if repo.exists() {
        return Ok(Json(json!({"ready": true})));
    }
    let parent = repo
        .parent()
        .ok_or_else(|| ApiError::BadRequest("Invalid repository path".into()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let temp = tempfile::tempdir_in(parent).map_err(|e| ApiError::Internal(e.to_string()))?;
    let input = temp.path().join("input.bundle");
    tokio::fs::write(&input, bytes)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let cloned = temp.path().join("checkout");
    cloud::git(
        temp.path(),
        &[
            "clone",
            "--",
            input.to_str().unwrap(),
            cloned.to_str().unwrap(),
        ],
    )
    .await
    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    cloud::git(&cloned, &["branch", "cloud-base", "HEAD"])
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    cloud::git(&cloned, &["remote", "remove", "origin"])
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    cloud::git(&cloned, &["config", "user.name", "Chro"])
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    cloud::git(&cloned, &["config", "user.email", "agent@localhost"])
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    tokio::fs::rename(cloned, &repo)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(json!({"ready": true})))
}

#[derive(Deserialize)]
struct Start {
    prompt: String,
    executor_profile_id: executors::ExecutorProfileId,
    resume_session_id: Option<String>,
}

async fn start(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<Start>,
) -> Result<Json<Value>, ApiError> {
    let path = repository_path(&state, id);
    if !path.join(".git").exists() {
        return Err(ApiError::BadRequest("Upload repository first".into()));
    }
    let result = TaskService::new(state.runtime())
        .start_execution_session(StartExecutionSessionParams {
            prompt: Some(body.prompt),
            workspace_path: path,
            executor_profile_id: Some(body.executor_profile_id),
            resume_session_id: body.resume_session_id,
            force_new_attempt: None,
            task_id: None,
            image_ids: None,
            use_worktree: Some(false),
            target_branch: None,
            selected_skill_ids: vec![],
            context_refs: vec![],
            execution_location: None,
        })
        .await?;
    Ok(Json(json!({"run_id": result.task_run.id})))
}

#[derive(Deserialize)]
struct LogCursor {
    #[serde(default)]
    cursor: u64,
}

async fn snapshot(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<LogCursor>,
) -> Result<Json<Value>, ApiError> {
    let run = db::models::TaskRun::get(state.pool(), id).await?;
    let (logs, log_cursor, caught_up) = state
        .runtime()
        .cloud_log_page(id, query.cursor)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let approvals = state
        .runtime()
        .approvals()
        .pending()
        .await
        .into_iter()
        .filter(|p| p.task_run_id == id)
        .collect::<Vec<_>>();
    // A terminal status precedes auto-commit. Wait for the worker to leave its
    // registry before advertising a result that is ready to download.
    let settled = !state.runtime().cloud_run_active(id).await;
    Ok(Json(
        json!({"logs": logs, "log_cursor": log_cursor, "status": run.status, "settled": settled && caught_up, "approvals": approvals}),
    ))
}

async fn bundle(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Vec<u8>, ApiError> {
    let run = db::models::TaskRun::get(state.pool(), id).await?;
    if state.runtime().cloud_run_active(id).await {
        return Err(ApiError::BadRequest("Cloud result is still running".into()));
    }
    let path = run
        .workspace_path
        .ok_or_else(|| ApiError::BadRequest("Missing run workspace".into()))?;
    cloud::repository_bundle(std::path::Path::new(&path))
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))
}

async fn diff(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let run = db::models::TaskRun::get(state.pool(), id).await?;
    let path = run
        .workspace_path
        .ok_or_else(|| ApiError::BadRequest("Missing run workspace".into()))?;
    let git = state.runtime().git().clone();
    let diffs = tokio::task::spawn_blocking(move || -> Result<_, git::GitServiceError> {
        let path = std::path::Path::new(&path);
        let base = git.get_base_commit(path, "cloud-base", "cloud-base")?;
        git.get_diffs(
            git::DiffTarget::Worktree {
                worktree_path: path,
                base_commit: base,
            },
            None,
        )
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?
    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let mut values = serde_json::Map::new();
    for diff in diffs {
        if let Some(key) = diff.path_key() {
            values.insert(key.to_string(), json!({"type": "DIFF", "content": diff}));
        }
    }
    Ok(Json(
        json!({"entry": {"type": "json_patch", "payload": [{"op": "add", "path": "/diffs", "value": values}]}, "settled": !state.runtime().cloud_run_active(id).await}),
    ))
}
