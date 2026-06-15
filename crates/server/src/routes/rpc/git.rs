//! Git operations endpoints.
//!
//! Two scopes share one set of path-based helpers:
//! - `/projects/:project_id/git/*` runs against the project's main checkout.
//! - `/task-runs/:id/git/*` runs against that run's worktree (session sandbox),
//!   so the Source Control panel reflects the active session's branch — the same
//!   worktree the file tree already roots at.

use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use db::models::{ProjectRecord, TaskRun};
use git::{BranchInfo, DiffTarget, GitService, GitStatus};
use log_types::Diff;
use serde::{Deserialize, Serialize};
use std::path::{Path as StdPath, PathBuf};

use crate::{
    identifiers::{resolve_project_id, resolve_task_run_id},
    ApiError, AppState,
};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        // Project (main checkout) scope.
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
        // Task-run (worktree) scope — mirrors the project routes, minus init.
        .route("/task-runs/:id/git/status", get(run_git_status))
        .route("/task-runs/:id/git/branches", get(run_list_branches))
        .route("/task-runs/:id/git/branch", get(run_current_branch))
        .route("/task-runs/:id/git/stage", post(run_stage_files))
        .route("/task-runs/:id/git/unstage", post(run_unstage_files))
        .route("/task-runs/:id/git/commit", post(run_commit_changes))
        .route("/task-runs/:id/git/diff", get(run_get_diff))
        .route("/task-runs/:id/git/push", post(run_push_changes))
        .route("/task-runs/:id/git/pull", post(run_pull_changes))
        .route("/task-runs/:id/git/discard", post(run_discard_changes))
        .route("/task-runs/:id/git/discard-files", post(run_discard_files))
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
#[serde(rename_all = "camelCase")]
struct BranchListResponse {
    branches: Vec<BranchInfo>,
    is_repository: bool,
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

/// One changed file in the working tree, paired with its full before/after
/// content so the renderer can show only the changed regions (not the whole
/// file). Mirrors the task-run diff stream payload so the same DiffViewerPanel
/// renders both.
#[derive(Debug, Serialize)]
struct WorkingDiffEntry {
    path: String,
    diff: Diff,
}

#[derive(Debug, Serialize)]
struct WorkingDiffResponse {
    diffs: Vec<WorkingDiffEntry>,
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

/// Diff scope. With no `base`, diffs the working tree against HEAD (uncommitted
/// changes only). With a `base` ref, diffs against the merge-base of the current
/// branch and that ref — i.e. ALL changes this branch introduced (committed +
/// uncommitted) — the "all changes" scope.
#[derive(Debug, Default, Deserialize)]
struct DiffQuery {
    base: Option<String>,
}

// --- Path resolution (the only per-scope difference) ---

async fn get_project_path(state: &AppState, identifier: &str) -> Result<PathBuf, ApiError> {
    let project_id = resolve_project_id(state.pool(), identifier).await?;
    let project = ProjectRecord::get(state.pool(), project_id).await?;
    Ok(PathBuf::from(&project.git_repo_path))
}

/// The worktree directory for a task run (its session sandbox). Prefers the
/// container ref, falling back to the recorded workspace path — the same
/// resolution the file-tree entry listing uses to root the run's tree.
async fn get_run_path(state: &AppState, identifier: &str) -> Result<PathBuf, ApiError> {
    Ok(get_run_worktree(state, identifier).await?.0)
}

/// Like `get_run_path`, but also returns the run's branch name (needed to
/// resolve the merge-base for branch-compare diffs).
async fn get_run_worktree(
    state: &AppState,
    identifier: &str,
) -> Result<(PathBuf, Option<String>), ApiError> {
    let run_id = resolve_task_run_id(state.pool(), identifier).await?;
    let run = TaskRun::get(state.pool(), run_id).await?;
    let path = run
        .container_ref
        .or(run.workspace_path)
        .ok_or_else(|| ApiError::BadRequest("task run has no workspace path".into()))?;
    Ok((PathBuf::from(path), run.branch_name))
}

/// Run blocking git work on the blocking thread pool.
///
/// Every git2 / git-subprocess call is synchronous and can take a long time on
/// large repositories (revwalks, status scans, and especially `push`/`pull`
/// network round-trips). Running them inline on an async worker thread starves
/// the runtime: enough concurrent git requests block every worker and the whole
/// server stops making progress (requests hang, stream snapshots never get
/// produced, the UI appears frozen). Every handler routes its git work through
/// here so the async runtime stays responsive.
async fn blocking_git<F, T>(f: F) -> Result<T, ApiError>
where
    F: FnOnce(GitService) -> Result<T, ApiError> + Send + 'static,
    T: Send + 'static,
{
    runtime::perf::spawn_blocking_instrumented("git.rpc", move || f(GitService::new()))
        .await
        .map_err(|e| ApiError::Internal(format!("git task failed to join: {e}")))?
}

// --- Path-based helpers (shared by both scopes) ---

fn status_response(
    git_service: &GitService,
    path: &StdPath,
) -> Result<GitStatusResponse, ApiError> {
    let status = git_service
        .status(path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let current_branch = git_service.get_current_branch(path).ok();
    let (commits_ahead, commits_behind) = git_service.get_remote_status(path).unwrap_or((0, 0));

    Ok(GitStatusResponse {
        status,
        current_branch,
        commits_ahead,
        commits_behind,
    })
}

fn branches_response(
    git_service: &GitService,
    path: &StdPath,
) -> Result<BranchListResponse, ApiError> {
    if !git_service.is_repository(path) {
        return Ok(BranchListResponse {
            branches: Vec::new(),
            is_repository: false,
        });
    }
    let branches = git_service
        .list_branches(path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(BranchListResponse {
        branches,
        is_repository: true,
    })
}

fn current_branch_response(git_service: &GitService, path: &StdPath) -> CurrentBranchResponse {
    CurrentBranchResponse {
        branch: git_service.get_current_branch(path).ok(),
    }
}

fn stage_response(
    git_service: &GitService,
    path: &StdPath,
    paths: &[String],
) -> Result<GitStatusResponse, ApiError> {
    git_service
        .stage(path, paths)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    status_response(git_service, path)
}

fn unstage_response(
    git_service: &GitService,
    path: &StdPath,
    paths: &[String],
) -> Result<GitStatusResponse, ApiError> {
    git_service
        .unstage(path, paths)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    status_response(git_service, path)
}

fn commit_response(
    git_service: &GitService,
    path: &StdPath,
    message: &str,
) -> Result<CommitResponse, ApiError> {
    if message.trim().is_empty() {
        return Err(ApiError::BadRequest("commit message is required".into()));
    }
    let commit_sha = git_service
        .commit_staged(path, message)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(CommitResponse { commit_sha })
}

/// Working-tree diff with full before/after content per file, including
/// untracked files. The diff base depends on `base`:
/// - `None` → against HEAD (uncommitted changes only).
/// - `Some(ref)` → against the merge-base of `branch` and `ref` (ALL changes the
///   branch introduced). Falls back to HEAD if the ref or branch can't resolve.
///
/// Empty when the path is not a repository or has no commit yet.
fn diff_response(
    git_service: &GitService,
    path: &StdPath,
    branch: Option<&str>,
    base: Option<&str>,
) -> Result<WorkingDiffResponse, ApiError> {
    if !git_service.is_repository(path) {
        return Ok(WorkingDiffResponse { diffs: Vec::new() });
    }

    let merge_base = match (base, branch) {
        (Some(base_ref), Some(branch_name)) => {
            git_service.get_base_commit(path, branch_name, base_ref).ok()
        }
        _ => None,
    };
    let base_commit = match merge_base.or_else(|| git_service.head_commit(path).ok()) {
        Some(commit) => commit,
        None => return Ok(WorkingDiffResponse { diffs: Vec::new() }),
    };

    let diffs = git_service
        .get_diffs(
            DiffTarget::Worktree {
                worktree_path: path,
                base_commit,
            },
            None,
        )
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let entries = diffs
        .into_iter()
        .filter_map(|diff| {
            let path = diff.path_key()?.to_string();
            Some(WorkingDiffEntry { path, diff })
        })
        .collect();
    Ok(WorkingDiffResponse { diffs: entries })
}

fn push_response(
    git_service: &GitService,
    path: &StdPath,
) -> Result<GitStatusResponse, ApiError> {
    git_service
        .push(path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    status_response(git_service, path)
}

fn pull_response(
    git_service: &GitService,
    path: &StdPath,
) -> Result<GitStatusResponse, ApiError> {
    git_service
        .pull(path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    status_response(git_service, path)
}

fn discard_response(
    git_service: &GitService,
    path: &StdPath,
) -> Result<GitStatusResponse, ApiError> {
    git_service
        .discard_all(path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    status_response(git_service, path)
}

fn discard_files_response(
    git_service: &GitService,
    path: &StdPath,
    paths: &[String],
) -> Result<GitStatusResponse, ApiError> {
    git_service
        .discard_files(path, paths)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    status_response(git_service, path)
}

// --- Project-scoped handlers ---

async fn get_git_status(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    Ok(Json(blocking_git(move |git| status_response(&git, &path)).await?))
}

async fn list_branches(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<BranchListResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    Ok(Json(
        blocking_git(move |git| branches_response(&git, &path)).await?,
    ))
}

async fn get_current_branch(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<CurrentBranchResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    Ok(Json(
        blocking_git(move |git| Ok(current_branch_response(&git, &path))).await?,
    ))
}

async fn stage_files(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<StageRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    let paths = payload.paths;
    Ok(Json(
        blocking_git(move |git| stage_response(&git, &path, &paths)).await?,
    ))
}

async fn unstage_files(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<UnstageRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    let paths = payload.paths;
    Ok(Json(
        blocking_git(move |git| unstage_response(&git, &path, &paths)).await?,
    ))
}

async fn commit_changes(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<CommitRequest>,
) -> Result<Json<CommitResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    let message = payload.message;
    Ok(Json(
        blocking_git(move |git| commit_response(&git, &path, &message)).await?,
    ))
}

async fn get_diff(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<WorkingDiffResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    let base = query.base;
    Ok(Json(
        blocking_git(move |git| {
            let branch = git.get_current_branch(&path).ok();
            diff_response(&git, &path, branch.as_deref(), base.as_deref())
        })
        .await?,
    ))
}

async fn push_changes(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    Ok(Json(
        blocking_git(move |git| push_response(&git, &path)).await?,
    ))
}

async fn pull_changes(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    Ok(Json(
        blocking_git(move |git| pull_response(&git, &path)).await?,
    ))
}

async fn discard_changes(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    Ok(Json(
        blocking_git(move |git| discard_response(&git, &path)).await?,
    ))
}

async fn discard_files(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<DiscardFilesRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    let paths = payload.paths;
    Ok(Json(
        blocking_git(move |git| discard_files_response(&git, &path, &paths)).await?,
    ))
}

async fn init_repository(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<CurrentBranchResponse>, ApiError> {
    let path = get_project_path(&state, &project_id).await?;
    Ok(Json(
        blocking_git(move |git| {
            git.init_repository(&path)
                .map_err(|e| ApiError::BadRequest(e.to_string()))?;
            Ok(current_branch_response(&git, &path))
        })
        .await?,
    ))
}

// --- Task-run (worktree) scoped handlers ---

async fn run_git_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    Ok(Json(blocking_git(move |git| status_response(&git, &path)).await?))
}

async fn run_list_branches(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BranchListResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    Ok(Json(
        blocking_git(move |git| branches_response(&git, &path)).await?,
    ))
}

async fn run_current_branch(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CurrentBranchResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    Ok(Json(
        blocking_git(move |git| Ok(current_branch_response(&git, &path))).await?,
    ))
}

async fn run_stage_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<StageRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    let paths = payload.paths;
    Ok(Json(
        blocking_git(move |git| stage_response(&git, &path, &paths)).await?,
    ))
}

async fn run_unstage_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<UnstageRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    let paths = payload.paths;
    Ok(Json(
        blocking_git(move |git| unstage_response(&git, &path, &paths)).await?,
    ))
}

async fn run_commit_changes(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<CommitRequest>,
) -> Result<Json<CommitResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    let message = payload.message;
    Ok(Json(
        blocking_git(move |git| commit_response(&git, &path, &message)).await?,
    ))
}

async fn run_get_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<WorkingDiffResponse>, ApiError> {
    let (path, branch) = get_run_worktree(&state, &id).await?;
    let base = query.base;
    Ok(Json(
        blocking_git(move |git| {
            diff_response(&git, &path, branch.as_deref(), base.as_deref())
        })
        .await?,
    ))
}

async fn run_push_changes(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    Ok(Json(
        blocking_git(move |git| push_response(&git, &path)).await?,
    ))
}

async fn run_pull_changes(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    Ok(Json(
        blocking_git(move |git| pull_response(&git, &path)).await?,
    ))
}

async fn run_discard_changes(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    Ok(Json(
        blocking_git(move |git| discard_response(&git, &path)).await?,
    ))
}

async fn run_discard_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<DiscardFilesRequest>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let path = get_run_path(&state, &id).await?;
    let paths = payload.paths;
    Ok(Json(
        blocking_git(move |git| discard_files_response(&git, &path, &paths)).await?,
    ))
}
