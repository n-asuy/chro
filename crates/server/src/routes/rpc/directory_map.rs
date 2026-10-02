//! Directory map endpoints.
//!
//! The map is the gitignore-aware tree of a project's main checkout. Each
//! directory in it has a standing agent: the brief file that governs it
//! (`AGENTS.md` or `CLAUDE.md`, inherited from the nearest ancestor when the
//! directory has none), and the ledger of finished tasks addressed to it.

use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{
        ws::{Message, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use db::{
    models::{ProjectRecord, TaskMerge, TaskRecord},
    types::TaskStatus,
};
use runtime::Runtime;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/:project_id/tree", get(project_tree))
        .route(
            "/projects/:project_id/tree-events",
            get(project_tree_events),
        )
        .route(
            "/projects/:project_id/directory-agent",
            get(directory_agent),
        )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeEntryResponse {
    /// Repo-relative path with forward slashes.
    path: String,
    is_file: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeResponse {
    entries: Vec<TreeEntryResponse>,
    /// True when the checkout exceeds the index cap and `entries` is empty.
    overflowed: bool,
}

async fn project_tree(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<TreeResponse>, ApiError> {
    let project = ProjectRecord::get_by_identifier(state.pool(), &project_id).await?;
    let repo_path = PathBuf::from(&project.git_repo_path);
    state.runtime().ensure_search_cache_watch(&repo_path);
    let index = state.runtime().file_search_cache().index(&repo_path).await;
    let mut entries: Vec<TreeEntryResponse> = index
        .files()
        .iter()
        .filter(|file| !file.is_ignored)
        .map(|file| TreeEntryResponse {
            path: file.path.replace('\\', "/"),
            is_file: file.is_file,
        })
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Json(TreeResponse {
        entries,
        overflowed: index.is_overflowed(),
    }))
}

/// Invalidate the UI only after the name index has caught up with disk.
/// Raw filesystem notifications arrive before the asynchronous rebuild and
/// can otherwise cause the UI to fetch and retain the old tree indefinitely.
async fn project_tree_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let project = ProjectRecord::get_by_identifier(state.pool(), &project_id).await?;
    let repo_path = PathBuf::from(project.git_repo_path);
    state.runtime().ensure_search_cache_watch(&repo_path);
    Ok(ws.on_upgrade(move |mut socket| async move {
        let cache = state.runtime().file_search_cache();
        let mut updates = cache.subscribe_updates();
        let mut previous = None;
        loop {
            let index = cache.index(&repo_path).await;
            if previous
                .as_ref()
                .is_none_or(|prev| !Arc::ptr_eq(prev, &index))
            {
                // Also sent on connect/reconnect to cover missed changes.
                if socket.send(Message::Text("updated".into())).await.is_err() {
                    break;
                }
                previous = Some(index);
            }
            tokio::select! {
                changed = updates.changed() => if changed.is_err() { break; },
                message = socket.recv() => match message {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    _ => {},
                },
            }
        }
    }))
}

#[derive(Debug, Deserialize)]
struct DirectoryAgentQuery {
    /// Repo-relative directory; absent or empty is the root.
    path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BriefResponse {
    /// Repo-relative path of the brief file.
    path: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum LedgerOutcome {
    Merged,
    Completed,
    Failed,
    Archived,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerEntryResponse {
    task_id: Uuid,
    slug: Option<String>,
    title: String,
    summary: Option<String>,
    outcome: LedgerOutcome,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryAgentResponse {
    path: String,
    /// The brief file inside this directory, if any.
    brief: Option<BriefResponse>,
    /// The nearest ancestor's brief, governing this directory when `brief` is
    /// absent.
    inherited_brief: Option<BriefResponse>,
    ledger: Vec<LedgerEntryResponse>,
}

async fn directory_agent(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<DirectoryAgentQuery>,
) -> Result<Json<DirectoryAgentResponse>, ApiError> {
    let project = ProjectRecord::get_by_identifier(state.pool(), &project_id).await?;
    let dir =
        git::normalize_home_dir(query.path.as_deref().unwrap_or_default()).ok_or_else(|| {
            ApiError::BadRequest("path must be a repository-relative directory".into())
        })?;

    let repo_path = PathBuf::from(&project.git_repo_path);
    let briefs = {
        let repo_path = repo_path.clone();
        let dir = dir.clone();
        runtime::perf::spawn_blocking_instrumented("directory_agent.briefs", move || {
            (
                find_brief(&repo_path, &dir),
                inherited_brief(&repo_path, &dir),
            )
        })
        .await
        .map_err(|e| ApiError::Internal(format!("brief lookup failed to join: {e}")))?
    };

    let mut ledger = Vec::new();
    for task in TaskRecord::list_by_home_dir(state.pool(), project.id, &dir).await? {
        let Some(outcome) = terminal_outcome(task.status) else {
            continue;
        };
        let merged = TaskMerge::find_latest_by_task(state.pool(), task.id)
            .await?
            .is_some_and(|merge| merge.reverted_at.is_none());
        ledger.push(LedgerEntryResponse {
            task_id: task.id,
            slug: task.slug.clone(),
            title: task.title.clone(),
            summary: task.last_summary.clone(),
            outcome: if merged {
                LedgerOutcome::Merged
            } else {
                outcome
            },
            updated_at: task.updated_at.to_rfc3339(),
        });
    }

    Ok(Json(DirectoryAgentResponse {
        path: dir,
        brief: briefs.0.map(|path| BriefResponse { path }),
        inherited_brief: briefs.1.map(|path| BriefResponse { path }),
        ledger,
    }))
}

/// A finished task's outcome before the merge ledger is consulted; `None`
/// while the task is still pending or running.
fn terminal_outcome(status: TaskStatus) -> Option<LedgerOutcome> {
    match status {
        TaskStatus::Completed => Some(LedgerOutcome::Completed),
        TaskStatus::Failed => Some(LedgerOutcome::Failed),
        // Archiving is expressed as cancellation (see use-archived-sessions).
        TaskStatus::Cancelled => Some(LedgerOutcome::Archived),
        TaskStatus::Pending | TaskStatus::InProgress => None,
    }
}

/// Standing-instruction file names, in precedence order.
const BRIEF_FILE_NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

/// The brief file inside `dir` (repo-relative, `""` for the root), if any.
fn find_brief(repo_path: &FsPath, dir: &str) -> Option<String> {
    let dir_path = if dir.is_empty() {
        repo_path.to_path_buf()
    } else {
        repo_path.join(dir)
    };
    BRIEF_FILE_NAMES
        .iter()
        .find(|name| dir_path.join(name).is_file())
        .map(|name| {
            if dir.is_empty() {
                (*name).to_string()
            } else {
                format!("{dir}/{name}")
            }
        })
}

/// The nearest brief above `dir`, walking towards the root; `None` at the
/// root itself or when no ancestor carries one.
fn inherited_brief(repo_path: &FsPath, dir: &str) -> Option<String> {
    let mut segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    while segments.pop().is_some() {
        if let Some(found) = find_brief(repo_path, &segments.join("/")) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo_with(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for file in files {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "brief").unwrap();
        }
        dir
    }

    #[test]
    fn brief_in_directory_wins_and_agents_precedes_claude() {
        let repo = repo_with(&[
            "CLAUDE.md",
            "apps/desktop/AGENTS.md",
            "apps/desktop/CLAUDE.md",
        ]);
        assert_eq!(
            find_brief(repo.path(), "apps/desktop").as_deref(),
            Some("apps/desktop/AGENTS.md")
        );
        assert_eq!(find_brief(repo.path(), "").as_deref(), Some("CLAUDE.md"));
        assert_eq!(find_brief(repo.path(), "apps"), None);
    }

    #[test]
    fn inherited_brief_is_the_nearest_ancestor() {
        let repo = repo_with(&["CLAUDE.md", "apps/desktop/AGENTS.md"]);
        assert_eq!(
            inherited_brief(repo.path(), "apps/desktop/src/session").as_deref(),
            Some("apps/desktop/AGENTS.md")
        );
        assert_eq!(
            inherited_brief(repo.path(), "apps/desktop").as_deref(),
            Some("CLAUDE.md"),
            "own brief does not count as inherited"
        );
        assert_eq!(inherited_brief(repo.path(), ""), None);
        fs::remove_file(repo.path().join("CLAUDE.md")).unwrap();
        assert_eq!(inherited_brief(repo.path(), "crates/server"), None);
    }

    #[test]
    fn a_directory_named_like_a_brief_is_not_a_brief() {
        let repo = repo_with(&["apps/AGENTS.md/keep"]);
        assert_eq!(find_brief(repo.path(), "apps"), None);
    }

    #[test]
    fn only_finished_tasks_enter_the_ledger() {
        assert_eq!(terminal_outcome(TaskStatus::Pending), None);
        assert_eq!(terminal_outcome(TaskStatus::InProgress), None);
        assert_eq!(
            terminal_outcome(TaskStatus::Cancelled),
            Some(LedgerOutcome::Archived)
        );
        assert_eq!(
            terminal_outcome(TaskStatus::Failed),
            Some(LedgerOutcome::Failed)
        );
    }
}
