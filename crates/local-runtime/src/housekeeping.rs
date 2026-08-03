use std::{env, path::PathBuf, time::Duration};

use anyhow::Result;
use db::{models::TaskRecord, DBService};
use runtime::Runtime;
use sqlx::Row;
use tokio::{fs as async_fs, time};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::LocalRuntime;

const DEFAULT_INTERVAL: Duration = Duration::from_secs(30 * 60);
const TASK_RUN_QUERY: &str =
    "SELECT id, workspace_path FROM task_runs WHERE workspace_path IS NOT NULL AND worktree_deleted = 0";
const TASK_RECORD_QUERY: &str =
    "SELECT id, worktree_path FROM task_records WHERE worktree_path IS NOT NULL AND worktree_deleted = 0";

pub fn spawn_housekeeping_tasks(runtime: LocalRuntime) {
    tokio::spawn(async move {
        if let Err(err) = run_cycle(&runtime).await {
            warn!(error = %err, "housekeeping startup run failed");
        }

        let mut interval = time::interval(DEFAULT_INTERVAL);
        loop {
            interval.tick().await;
            if let Err(err) = run_cycle(&runtime).await {
                warn!(error = %err, "housekeeping interval run failed");
            }
        }
    });
}

async fn run_cycle(runtime: &LocalRuntime) -> Result<()> {
    let (runs_marked, tasks_marked) = reconcile_db_flags(runtime.db()).await?;
    if runs_marked > 0 || tasks_marked > 0 {
        info!(runs_marked, tasks_marked, "reconciled worktree metadata");
    }

    if !worktree_cleanup_disabled() {
        let removed = cleanup_expired_worktrees(runtime).await?;
        if removed > 0 {
            info!(removed, "removed expired worktrees (72+ hours inactive)");
        } else {
            debug!("no expired worktrees detected");
        }
    } else {
        debug!("worktree cleanup disabled via env");
    }

    match runtime.image().delete_orphaned_images().await {
        Ok(deleted) => {
            if deleted > 0 {
                info!(deleted, "removed orphaned cached images");
            } else {
                debug!("no orphaned images to remove");
            }
        }
        Err(err) => warn!(error = %err, "image cleanup failed"),
    }

    match runtime.db().reclaim_space_if_needed().await {
        Ok(true) => info!("compacted sqlite database after freelist growth"),
        Ok(false) => debug!("sqlite compaction not needed"),
        Err(err) => warn!(error = %err, "sqlite maintenance failed"),
    }

    Ok(())
}

async fn reconcile_db_flags(db: &DBService) -> Result<(u64, u64)> {
    let runs = mark_missing_task_runs(db).await?;
    let tasks = mark_missing_task_records(db).await?;
    Ok((runs, tasks))
}

async fn mark_missing_task_runs(db: &DBService) -> Result<u64> {
    let rows = sqlx::query(TASK_RUN_QUERY).fetch_all(db.pool()).await?;

    let mut updated = 0u64;
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        let path: String = row.try_get("workspace_path")?;
        let path = PathBuf::from(path);
        if async_fs::metadata(&path).await.is_err() {
            sqlx::query(
                "UPDATE task_runs SET worktree_deleted = 1, workspace_path = NULL, updated_at = datetime('now') WHERE id = ?",
            )
            .bind(id)
            .execute(db.pool())
            .await?;
            updated += 1;
        }
    }

    Ok(updated)
}

async fn mark_missing_task_records(db: &DBService) -> Result<u64> {
    let rows = sqlx::query(TASK_RECORD_QUERY).fetch_all(db.pool()).await?;

    let mut updated = 0u64;
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        let path: String = row.try_get("worktree_path")?;
        let path = PathBuf::from(path);
        if async_fs::metadata(&path).await.is_err() {
            TaskRecord::mark_worktree_deleted(db.pool(), id, false).await?;
            updated += 1;
        }
    }

    Ok(updated)
}

/// Cleanup worktrees that have been inactive for 72+ hours.
/// Uses the expiry query from TaskRecord to find candidates.
async fn cleanup_expired_worktrees(runtime: &LocalRuntime) -> Result<usize> {
    let expired = TaskRecord::find_expired_for_cleanup(runtime.db().pool()).await?;

    let mut removed = 0usize;
    for (task_id, worktree_path, git_repo_path) in expired {
        let path = PathBuf::from(&worktree_path);
        let repo_path = PathBuf::from(&git_repo_path);

        match runtime
            .worktree()
            .cleanup_worktree(&path, Some(&repo_path))
            .await
        {
            Ok(_) => {
                TaskRecord::mark_worktree_deleted(runtime.db().pool(), task_id, false).await?;
                removed += 1;
                info!(task_id = %task_id, path = %path.display(), "cleaned up expired worktree");
            }
            Err(err) => {
                warn!(task_id = %task_id, path = %path.display(), error = %err, "failed to cleanup expired worktree");
            }
        }
    }

    Ok(removed)
}

fn worktree_cleanup_disabled() -> bool {
    env::var("DISABLE_WORKTREE_ORPHAN_CLEANUP")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}
