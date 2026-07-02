//! Developer tools: worktree management endpoints.

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use runtime::{Runtime, RuntimeError};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::task::spawn_blocking;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/developer/worktree-info", get(get_worktree_info))
        .route("/developer/worktree-sizes", get(get_worktree_sizes))
        .route("/developer/worktree-cleanup", post(cleanup_worktrees))
}

#[derive(Debug, Serialize)]
struct WorktreeInfoResponse {
    base_dir: String,
    entries: Vec<WorktreeEntryInfo>,
}

#[derive(Debug, Serialize)]
struct WorktreeEntryInfo {
    path: String,
    name: String,
    modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorktreeSizesResponse {
    /// Map of worktree directory path -> total size in bytes on disk.
    sizes: HashMap<String, u64>,
    total_size_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct CleanupWorktreesRequest {
    /// Optional list of specific worktree paths to delete.
    /// If empty or None, deletes ALL worktrees in the base directory.
    paths: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct CleanupWorktreesResponse {
    deleted_count: usize,
    deleted_paths: Vec<String>,
    freed_bytes: u64,
}

/// List worktree directories without computing their on-disk sizes.
///
/// Enumeration is cheap and returns immediately, so the UI can render the list
/// the moment the developer tab opens. Sizes are resolved separately via
/// [`get_worktree_sizes`] because they require a recursive walk of full
/// repository checkouts (which can hold large `node_modules` / `target` trees)
/// and must not gate the appearance of the list.
async fn get_worktree_info(
    State(state): State<AppState>,
) -> Result<Json<WorktreeInfoResponse>, ApiError> {
    let worktree_manager = state.runtime().worktree();
    let base_dir = worktree_manager.base_dir().to_path_buf();

    let entries = spawn_blocking(move || {
        let mut entries: Vec<WorktreeEntryInfo> = list_worktree_dirs(&base_dir)
            .into_iter()
            .map(|dir| WorktreeEntryInfo {
                path: dir.path.to_string_lossy().into_owned(),
                name: dir.name,
                modified_at: dir.modified_at,
            })
            .collect();
        entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        entries
    })
    .await
    .map_err(|e| RuntimeError::Other(anyhow::anyhow!("spawn_blocking error: {}", e)))?;

    Ok(Json(WorktreeInfoResponse {
        base_dir: worktree_manager.base_dir().to_string_lossy().into_owned(),
        entries,
    }))
}

/// Compute the on-disk size of every worktree directory.
///
/// This is the expensive half of the listing, split out from
/// [`get_worktree_info`] so it can run after the list is already on screen.
async fn get_worktree_sizes(
    State(state): State<AppState>,
) -> Result<Json<WorktreeSizesResponse>, ApiError> {
    let base_dir = state.runtime().worktree().base_dir().to_path_buf();

    let (sizes, total_size_bytes) = spawn_blocking(move || {
        let mut sizes = HashMap::new();
        let mut total = 0u64;
        for dir in list_worktree_dirs(&base_dir) {
            let size = dir_size(&dir.path);
            total += size;
            sizes.insert(dir.path.to_string_lossy().into_owned(), size);
        }
        (sizes, total)
    })
    .await
    .map_err(|e| RuntimeError::Other(anyhow::anyhow!("spawn_blocking error: {}", e)))?;

    Ok(Json(WorktreeSizesResponse {
        sizes,
        total_size_bytes,
    }))
}

async fn cleanup_worktrees(
    State(state): State<AppState>,
    Json(payload): Json<CleanupWorktreesRequest>,
) -> Result<Json<CleanupWorktreesResponse>, ApiError> {
    let worktree_manager = state.runtime().worktree();
    let base_dir = worktree_manager.base_dir().to_path_buf();
    let base_dir_normalized = normalize_path(&base_dir);
    let worktree_repo_map = fetch_worktree_repo_map(state.pool()).await?;

    let paths_to_delete: Vec<PathBuf> = match payload.paths {
        Some(paths) if !paths.is_empty() => paths.into_iter().map(PathBuf::from).collect(),
        _ => spawn_blocking(move || {
            list_worktree_dirs(&base_dir)
                .into_iter()
                .map(|dir| dir.path)
                .collect()
        })
        .await
        .map_err(|e| RuntimeError::Other(anyhow::anyhow!("spawn_blocking error: {}", e)))?,
    };

    let mut deleted_count = 0usize;
    let mut deleted_paths = Vec::new();
    let mut freed_bytes = 0u64;

    for path in paths_to_delete {
        if !is_within_base_dir(&base_dir_normalized, &path) {
            tracing::warn!(path = %path.display(), "Skipping worktree cleanup outside base dir");
            continue;
        }

        let size = spawn_blocking({
            let path = path.clone();
            move || dir_size(&path)
        })
        .await
        .unwrap_or(0);

        let normalized_path = normalize_path(&path);
        let repo_path = worktree_repo_map.get(&normalized_path);
        let cleanup_result = state
            .runtime()
            .worktree()
            .cleanup_worktree(&path, repo_path.map(|repo| repo.as_path()))
            .await;

        if cleanup_result.is_ok() {
            deleted_count += 1;
            deleted_paths.push(path.to_string_lossy().into_owned());
            freed_bytes += size;
        } else {
            tracing::warn!(path = %path.display(), "Failed to delete worktree directory");
        }
    }

    Ok(Json(CleanupWorktreesResponse {
        deleted_count,
        deleted_paths,
        freed_bytes,
    }))
}

/// A worktree directory discovered under the base dir.
///
/// The base dir holds a two-level `<prefix>/<dir>` layout. Size is deliberately
/// absent here: enumerating directories is cheap, while sizing them is not.
struct WorktreeDir {
    path: PathBuf,
    name: String,
    modified_at: Option<String>,
}

/// Enumerate every worktree directory under `base_dir` (cheap; no recursion
/// into the directories themselves). Shared by the info, sizes, and cleanup
/// paths so the traversal lives in exactly one place.
fn list_worktree_dirs(base_dir: &Path) -> Vec<WorktreeDir> {
    let mut dirs = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(base_dir) else {
        return dirs;
    };
    for prefix_entry in read_dir.flatten() {
        let prefix_path = prefix_entry.path();
        if !prefix_path.is_dir() {
            continue;
        }
        let prefix_name = prefix_entry.file_name().to_string_lossy().into_owned();
        let Ok(worktree_dir) = std::fs::read_dir(&prefix_path) else {
            continue;
        };
        for entry in worktree_dir.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().into_owned();
            let modified_at = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    chrono::DateTime::<chrono::Utc>::from(t)
                        .format("%Y-%m-%dT%H:%M:%SZ")
                        .to_string()
                });
            dirs.push(WorktreeDir {
                path,
                name: format!("{}/{}", prefix_name, dir_name),
                modified_at,
            });
        }
    }
    dirs
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            } else if path.is_dir() {
                total += dir_size(&path);
            }
        }
    }
    total
}

async fn fetch_worktree_repo_map(
    pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<HashMap<PathBuf, PathBuf>, ApiError> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT DISTINCT tr.container_ref AS worktree_path, pr.git_repo_path
        FROM task_runs tr
        JOIN task_records t ON tr.task_id = t.id
        JOIN project_records pr ON t.project_id = pr.id
        WHERE tr.container_ref IS NOT NULL
        UNION
        SELECT DISTINCT t.worktree_path AS worktree_path, pr.git_repo_path
        FROM task_records t
        JOIN project_records pr ON t.project_id = pr.id
        WHERE t.worktree_path IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut map = HashMap::new();
    for (worktree_path, git_repo_path) in rows {
        let worktree_path = normalize_path(Path::new(&worktree_path));
        map.entry(worktree_path)
            .or_insert_with(|| PathBuf::from(&git_repo_path));
    }

    Ok(map)
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn is_within_base_dir(base_dir: &Path, candidate: &Path) -> bool {
    normalize_path(candidate).starts_with(base_dir)
}
