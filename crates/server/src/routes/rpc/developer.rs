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
        .route("/developer/worktree-cleanup", post(cleanup_worktrees))
}

#[derive(Debug, Serialize)]
struct WorktreeInfoResponse {
    base_dir: String,
    entries: Vec<WorktreeEntryInfo>,
    total_size_bytes: u64,
}

#[derive(Debug, Serialize)]
struct WorktreeEntryInfo {
    path: String,
    name: String,
    size_bytes: u64,
    modified_at: Option<String>,
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

async fn get_worktree_info(
    State(state): State<AppState>,
) -> Result<Json<WorktreeInfoResponse>, ApiError> {
    let worktree_manager = state.runtime().worktree();
    let base_dir = worktree_manager.base_dir().to_path_buf();

    let (entries, total_size) = spawn_blocking(move || {
        let mut entries = Vec::new();
        let mut total_size = 0u64;

        if let Ok(read_dir) = std::fs::read_dir(&base_dir) {
            for prefix_entry in read_dir.flatten() {
                let prefix_path = prefix_entry.path();
                if !prefix_path.is_dir() {
                    continue;
                }

                if let Ok(worktree_dir) = std::fs::read_dir(&prefix_path) {
                    for entry in worktree_dir.flatten() {
                        let path = entry.path();
                        if !path.is_dir() {
                            continue;
                        }

                        let prefix_name = prefix_entry.file_name().to_string_lossy().into_owned();
                        let dir_name = entry.file_name().to_string_lossy().into_owned();
                        let name = format!("{}/{}", prefix_name, dir_name);
                        let size = dir_size(&path);
                        total_size += size;

                        let modified_at = entry
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .map(|t| {
                                chrono::DateTime::<chrono::Utc>::from(t)
                                    .format("%Y-%m-%dT%H:%M:%SZ")
                                    .to_string()
                            });

                        entries.push(WorktreeEntryInfo {
                            path: path.to_string_lossy().into_owned(),
                            name,
                            size_bytes: size,
                            modified_at,
                        });
                    }
                }
            }
        }

        entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

        (entries, total_size)
    })
    .await
    .map_err(|e| RuntimeError::Other(anyhow::anyhow!("spawn_blocking error: {}", e)))?;

    Ok(Json(WorktreeInfoResponse {
        base_dir: worktree_manager.base_dir().to_string_lossy().into_owned(),
        entries,
        total_size_bytes: total_size,
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
            let mut paths = Vec::new();
            if let Ok(read_dir) = std::fs::read_dir(&base_dir) {
                for prefix_entry in read_dir.flatten() {
                    let prefix_path = prefix_entry.path();
                    if !prefix_path.is_dir() {
                        continue;
                    }
                    if let Ok(worktree_dir) = std::fs::read_dir(&prefix_path) {
                        for entry in worktree_dir.flatten() {
                            let path = entry.path();
                            if path.is_dir() {
                                paths.push(path);
                            }
                        }
                    }
                }
            }
            paths
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
