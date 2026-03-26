//! Git operations endpoints for VaultRightPanel.

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use db::models::ProjectRecord;
use git::{BranchInfo, DiffSummary, GitService, GitStatus};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/:project_id/git/status", get(get_git_status))
        .route("/projects/:project_id/git/branches", get(list_branches))
        .route("/projects/:project_id/git/branch", get(get_current_branch))
        .route("/projects/:project_id/git/stage", post(stage_files))
        .route("/projects/:project_id/git/unstage", post(unstage_files))
        .route("/projects/:project_id/git/commit", post(commit_changes))
        .route("/projects/:project_id/git/diff", get(get_diff))
        .route("/projects/:project_id/git/push", post(push_changes))
        .route("/projects/:project_id/git/pull", post(pull_changes))
        .route("/projects/:project_id/git/discard", post(discard_changes))
        .route(
            "/projects/:project_id/git/discard-files",
            post(discard_files),
        )
        .route("/projects/:project_id/git/init", post(init_repository))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusResponse {
    status: GitStatus,
    current_branch: Option<String>,
    commits_ahead: usize,
    commits_behind: usize,
}

#[derive(Debug, Serialize)]
struct BranchListResponse {
    branches: Vec<BranchInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentBranchResponse {
    branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitResponse {
    commit_sha: Option<String>,
}

#[derive(Debug, Serialize)]
struct DiffResponse {
    diff: DiffSummary,
}

#[derive(Debug, Deserialize)]
struct StageRequest {
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct UnstageRequest {
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CommitRequest {
    message: String,
}

#[derive(Debug, Deserialize)]
struct DiscardFilesRequest {
    paths: Vec<String>,
}

async fn get_project_path(state: &AppState, project_id: Uuid) -> Result<PathBuf, ApiError> {
    let project = ProjectRecord::get(state.pool(), project_id).await?;
    Ok(PathBuf::from(&project.git_repo_path))
}

fn build_git_status_response(
    git_service: &GitService,
    project_path: &std::path::Path,
) -> Result<GitStatusResponse, ApiError> {
    let status = git_service
        .status(project_path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let current_branch = git_service.get_current_branch(project_path).ok();
    let (commits_ahead, commits_behind) = git_service
        .get_remote_status(project_path)
        .unwrap_or((0, 0));

    Ok(GitStatusResponse {
        status,
        current_branch,
        commits_ahead,
        commits_behind,
    })
}

async fn get_git_status(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();
    Ok(Json(build_git_status_response(
        &git_service,
        &project_path,
    )?))
}

async fn list_branches(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<BranchListResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    let branches = git_service
        .list_branches(&project_path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    Ok(Json(BranchListResponse { branches }))
}

async fn get_current_branch(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<CurrentBranchResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    let branch = git_service.get_current_branch(&project_path).ok();

    Ok(Json(CurrentBranchResponse { branch }))
}

async fn stage_files(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<StageRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    git_service
        .stage(&project_path, &payload.paths)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(build_git_status_response(
        &git_service,
        &project_path,
    )?))
}

async fn unstage_files(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<UnstageRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    git_service
        .unstage(&project_path, &payload.paths)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(build_git_status_response(
        &git_service,
        &project_path,
    )?))
}

async fn commit_changes(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<CommitRequest>,
) -> Result<Json<CommitResponse>, ApiError> {
    if payload.message.trim().is_empty() {
        return Err(ApiError::BadRequest("commit message is required".into()));
    }

    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    let commit_sha = git_service
        .commit_staged(&project_path, &payload.message)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    Ok(Json(CommitResponse { commit_sha }))
}

async fn get_diff(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<DiffResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    let diff = git_service
        .diff_commits(&project_path, "HEAD", "HEAD")
        .unwrap_or_default();

    Ok(Json(DiffResponse { diff }))
}

async fn push_changes(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    git_service
        .push(&project_path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(build_git_status_response(
        &git_service,
        &project_path,
    )?))
}

async fn pull_changes(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    git_service
        .pull(&project_path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(build_git_status_response(
        &git_service,
        &project_path,
    )?))
}

async fn discard_changes(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    git_service
        .discard_all(&project_path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(build_git_status_response(
        &git_service,
        &project_path,
    )?))
}

async fn init_repository(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<CurrentBranchResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    git_service
        .init_repository(&project_path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let branch = git_service.get_current_branch(&project_path).ok();

    Ok(Json(CurrentBranchResponse { branch }))
}

async fn discard_files(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<DiscardFilesRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let project_path = get_project_path(&state, project_id).await?;
    let git_service = GitService::new();

    git_service
        .discard_files(&project_path, &payload.paths)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(build_git_status_response(
        &git_service,
        &project_path,
    )?))
}
