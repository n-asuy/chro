use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Sqlite};
use ts_rs::TS;
use uuid::Uuid;

use crate::types::{MergeStatus, MergeType};

/// Task merge (PR/merge tracking)
///
/// Tracks pull requests and merge operations for a task.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-merge.ts")]
pub struct TaskMerge {
    pub id: Uuid,
    pub task_id: Uuid,
    pub merge_type: MergeType,
    pub target_branch_name: Option<String>,
    pub merge_commit: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub pr_status: Option<MergeStatus>,
    pub pr_merged_at: Option<DateTime<Utc>>,
    pub pr_merge_commit_sha: Option<String>,
    pub created_at: DateTime<Utc>,
    pub reverted_at: Option<DateTime<Utc>>,
}

impl TaskMerge {
    pub fn merge_commit(&self) -> Option<&str> {
        self.merge_commit
            .as_deref()
            .or_else(|| self.pr_merge_commit_sha.as_deref())
    }
    /// Create a direct merge record (e.g. squash merge performed locally).
    pub async fn create_direct(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        target_branch_name: impl Into<String>,
        merge_commit: impl Into<String>,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query_as::<_, Self>(
            "INSERT INTO task_merges (
                 id, task_id, merge_type, target_branch_name, merge_commit
             ) VALUES (?, ?, ?, ?, ?)
             RETURNING *",
        )
        .bind(id)
        .bind(task_id)
        .bind(MergeType::Direct)
        .bind(target_branch_name.into())
        .bind(merge_commit.into())
        .fetch_one(pool)
        .await
    }

    /// Create a pull request merge record when a PR is opened against the task branch.
    pub async fn create_pr(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        target_branch_name: impl Into<String>,
        pr_number: i64,
        pr_url: impl Into<String>,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query_as::<_, Self>(
            "INSERT INTO task_merges (
                 id, task_id, merge_type, target_branch_name, pr_number, pr_url, pr_status
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             RETURNING *",
        )
        .bind(id)
        .bind(task_id)
        .bind(MergeType::Pr)
        .bind(target_branch_name.into())
        .bind(pr_number)
        .bind(pr_url.into())
        .bind(MergeStatus::Open)
        .fetch_one(pool)
        .await
    }

    /// Fetch all merge records for a task ordered by recency.
    pub async fn find_by_task(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM task_merges WHERE task_id = ? ORDER BY created_at DESC",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    /// Fetch the most recent merge record for a task.
    pub async fn find_latest_by_task(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM task_merges WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(task_id)
        .fetch_optional(pool)
        .await
    }

    /// Fetch a merge by id.
    pub async fn find_by_id(pool: &Pool<Sqlite>, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_merges WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    /// Update the status of a tracked PR merge.
    pub async fn update_pr_status(
        pool: &Pool<Sqlite>,
        merge_id: Uuid,
        status: MergeStatus,
        merge_commit_sha: Option<String>,
    ) -> Result<Self, sqlx::Error> {
        let should_stamp = matches!(status, MergeStatus::Merged);
        sqlx::query_as::<_, Self>(
            "UPDATE task_merges
             SET pr_status = ?,
                 pr_merge_commit_sha = ?,
                 pr_merged_at = CASE WHEN ? THEN datetime('now','subsec') ELSE pr_merged_at END
             WHERE id = ? AND merge_type = 'pr'
             RETURNING *",
        )
        .bind(status)
        .bind(merge_commit_sha)
        .bind(if should_stamp { 1 } else { 0 })
        .bind(merge_id)
        .fetch_one(pool)
        .await
    }

    /// Mark a direct merge as reverted (used when undoing a merge commit).
    pub async fn mark_reverted(pool: &Pool<Sqlite>, merge_id: Uuid) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "UPDATE task_merges
             SET reverted_at = datetime('now','subsec')
             WHERE id = ? AND merge_type = 'direct' AND reverted_at IS NULL
             RETURNING *",
        )
        .bind(merge_id)
        .fetch_one(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::task::TaskRecord, types::TaskStatus, DBService};
    use tempfile::tempdir;

    async fn setup_context() -> (tempfile::TempDir, Pool<Sqlite>, Uuid) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = DBService::new_with_path(&db_path).await.unwrap();
        let pool = db.pool().clone();

        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'proj', '/tmp/repo', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(&pool)
        .await
        .unwrap();

        let task = TaskRecord::new(project_id, "Task", None);
        sqlx::query(
            "INSERT INTO task_records (id, project_id, parent_task_id, title, description, status, due_at, branch, worktree_path, worktree_deleted, active_session_id, created_at, updated_at)
             VALUES (?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, 0, NULL, datetime('now'), datetime('now'))",
        )
        .bind(task.id)
        .bind(task.project_id)
        .bind(&task.title)
        .bind(TaskStatus::Pending)
        .execute(&pool)
        .await
        .unwrap();

        (dir, pool, task.id)
    }

    #[tokio::test]
    async fn direct_merge_lifecycle() {
        let (_dir, pool, task_id) = setup_context().await;
        let merge = TaskMerge::create_direct(&pool, task_id, "main", "abc123")
            .await
            .unwrap();
        assert_eq!(merge.merge_type, MergeType::Direct);
        assert_eq!(merge.merge_commit.as_deref(), Some("abc123"));

        let listed = TaskMerge::find_by_task(&pool, task_id).await.unwrap();
        assert_eq!(listed.len(), 1);

        let reverted = TaskMerge::mark_reverted(&pool, merge.id).await.unwrap();
        assert!(reverted.reverted_at.is_some());
    }

    #[tokio::test]
    async fn pr_merge_updates_status() {
        let (_dir, pool, task_id) = setup_context().await;
        let merge = TaskMerge::create_pr(&pool, task_id, "main", 42, "https://example.com")
            .await
            .unwrap();
        assert_eq!(merge.pr_status, Some(MergeStatus::Open));

        let updated = TaskMerge::update_pr_status(
            &pool,
            merge.id,
            MergeStatus::Merged,
            Some("deadbeef".into()),
        )
        .await
        .unwrap();
        assert_eq!(updated.pr_status, Some(MergeStatus::Merged));
        assert_eq!(updated.pr_merge_commit_sha.as_deref(), Some("deadbeef"));
        assert!(updated.pr_merged_at.is_some());
    }

    #[tokio::test]
    async fn reverting_pr_merge_fails() {
        let (_dir, pool, task_id) = setup_context().await;
        let merge = TaskMerge::create_pr(&pool, task_id, "main", 1, "url")
            .await
            .unwrap();
        let err = TaskMerge::mark_reverted(&pool, merge.id)
            .await
            .err()
            .unwrap();
        assert!(matches!(err, sqlx::Error::RowNotFound));
    }
}
