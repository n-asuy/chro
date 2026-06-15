use chrono::{DateTime, Utc};
use log_types::LogEntry;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Sqlite};
use std::mem;
use ts_rs::TS;
use uuid::Uuid;

use crate::slug::generate_slug;
use crate::types::{ExecutionMode, RunStatus, TaskStatus};

/// Task record (core entity)
///
/// Represents a task with its current state, references, and metadata.
/// This is the central entity in the Task-centric design.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-record.ts")]
pub struct TaskRecord {
    pub id: Uuid,
    pub slug: Option<String>,
    pub project_id: Uuid,
    pub parent_task_id: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
    #[serde(default, skip_serializing)]
    #[ts(skip)]
    pub prompt: Option<String>,
    pub status: TaskStatus,
    pub due_at: Option<DateTime<Utc>>,
    pub branch: Option<String>,
    /// Local execution only: worktree path for isolation
    pub worktree_path: Option<String>,
    pub worktree_deleted: bool,
    /// FK to current active session
    pub active_session_id: Option<Uuid>,
    /// Runtime flag: the agent is blocked on an AskUserQuestion approval and is
    /// waiting for the user to answer. Cleared when the question resolves or the
    /// active session ends. Denormalized runtime state mirroring
    /// `active_session_id`; never true while there is no active session.
    pub awaiting_input: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Position within a kanban column (lower = higher). 0 means unordered.
    pub sort_order: i32,
    /// Bare agent kind the task last ran with (e.g. "CLAUDE_CODE", "CODEX").
    /// Denormalized from the latest run's executor so UIs can show the agent
    /// logo without a per-task run lookup. `None` until the first run.
    pub last_executor: Option<String>,
}

impl TaskRecord {
    /// Create a new task
    pub fn new(project_id: Uuid, title: impl Into<String>, description: Option<String>) -> Self {
        Self::new_with_prompt(project_id, title, description, None)
    }

    pub fn new_with_prompt(
        project_id: Uuid,
        title: impl Into<String>,
        description: Option<String>,
        prompt: Option<String>,
    ) -> Self {
        let now = Utc::now();
        let title = title.into();
        let description = normalize_optional_text(description);
        let prompt = normalize_prompt(prompt, &title, description.as_deref());
        Self {
            id: Uuid::new_v4(),
            slug: Some(generate_slug()),
            project_id,
            parent_task_id: None,
            title: title.clone(),
            description,
            prompt,
            status: TaskStatus::Pending,
            due_at: None,
            branch: None,
            worktree_path: None,
            worktree_deleted: false,
            active_session_id: None,
            awaiting_input: false,
            created_at: now,
            updated_at: now,
            sort_order: 0,
            last_executor: None,
        }
    }

    /// Create a new subtask
    pub fn new_subtask(
        project_id: Uuid,
        parent_task_id: Uuid,
        title: impl Into<String>,
        description: Option<String>,
    ) -> Self {
        let mut task = Self::new(project_id, title, description);
        task.parent_task_id = Some(parent_task_id);
        task
    }

    /// Fetch a task by id, returning a row-not-found error if missing.
    pub async fn get(pool: &Pool<Sqlite>, task_id: Uuid) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_records WHERE id = ?")
            .bind(task_id)
            .fetch_one(pool)
            .await
    }

    /// Persist the task record.
    pub async fn insert(&self, pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO task_records (id, slug, project_id, parent_task_id, title, description, prompt, status, due_at, branch, worktree_path, worktree_deleted, active_session_id, created_at, updated_at, sort_order, last_executor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(self.id)
        .bind(&self.slug)
        .bind(self.project_id)
        .bind(self.parent_task_id)
        .bind(&self.title)
        .bind(&self.description)
        .bind(&self.prompt)
        .bind(self.status)
        .bind(self.due_at)
        .bind(&self.branch)
        .bind(&self.worktree_path)
        .bind(if self.worktree_deleted { 1 } else { 0 })
        .bind(self.active_session_id)
        .bind(self.created_at)
        .bind(self.updated_at)
        .bind(self.sort_order)
        .bind(&self.last_executor)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Fetch a task by SQLite rowid.
    pub async fn find_by_rowid(
        pool: &Pool<Sqlite>,
        rowid: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_records WHERE rowid = ?")
            .bind(rowid)
            .fetch_optional(pool)
            .await
    }

    /// Fetch a task by UUID.
    pub async fn find_by_id(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_records WHERE id = ?")
            .bind(task_id)
            .fetch_optional(pool)
            .await
    }

    /// Fetch a task by slug.
    pub async fn find_by_slug(
        pool: &Pool<Sqlite>,
        slug: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_records WHERE slug = ?")
            .bind(slug)
            .fetch_optional(pool)
            .await
    }

    /// Fetch a task by either UUID string or slug.
    pub async fn get_by_identifier(
        pool: &Pool<Sqlite>,
        identifier: &str,
    ) -> Result<Self, sqlx::Error> {
        if let Ok(uuid) = Uuid::parse_str(identifier) {
            return Self::get(pool, uuid).await;
        }
        Self::find_by_slug(pool, identifier)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Return all tasks currently stored.
    pub async fn list_all(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_records")
            .fetch_all(pool)
            .await
    }

    /// Return all tasks for a project, ordered by sort_order ascending
    /// (with fallback to updated_at descending for sort_order = 0).
    pub async fn list_by_project(
        pool: &Pool<Sqlite>,
        project_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM task_records WHERE project_id = ? ORDER BY sort_order ASC, updated_at DESC",
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
    }

    /// Update the `worktree_path` and `worktree_deleted` flags for a task.
    /// When `touch_timestamp` is false, `updated_at` remains unchanged.
    pub async fn update_worktree_state(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        worktree_path: Option<String>,
        worktree_deleted: bool,
        touch_timestamp: bool,
    ) -> Result<(), sqlx::Error> {
        Self::persist_worktree_state(
            pool,
            task_id,
            worktree_path,
            worktree_deleted,
            touch_timestamp,
        )
        .await
    }

    /// Convenience helper to mark a task's worktree as deleted.
    pub async fn mark_worktree_deleted(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        touch_timestamp: bool,
    ) -> Result<(), sqlx::Error> {
        Self::persist_worktree_state(pool, task_id, None, true, touch_timestamp).await
    }

    async fn persist_worktree_state(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        worktree_path: Option<String>,
        worktree_deleted: bool,
        touch_timestamp: bool,
    ) -> Result<(), sqlx::Error> {
        if touch_timestamp {
            sqlx::query(
                "UPDATE task_records
                 SET worktree_path = ?, worktree_deleted = ?, updated_at = datetime('now')
                 WHERE id = ?",
            )
            .bind(worktree_path)
            .bind(if worktree_deleted { 1 } else { 0 })
            .bind(task_id)
            .execute(pool)
            .await?;
        } else {
            sqlx::query(
                "UPDATE task_records
                 SET worktree_path = ?, worktree_deleted = ?
                 WHERE id = ?",
            )
            .bind(worktree_path)
            .bind(if worktree_deleted { 1 } else { 0 })
            .bind(task_id)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Update the git branch associated with the task.
    pub async fn update_branch(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        branch: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE task_records
             SET branch = ?, updated_at = datetime('now')
             WHERE id = ?",
        )
        .bind(branch)
        .bind(task_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Record the bare agent kind the task last ran with (e.g. "CLAUDE_CODE").
    /// Does not touch `updated_at`: this is run-derived metadata and must not
    /// re-order the task list on its own. The row write still fans out through
    /// the SQLite update hook so the tasks stream reflects it live.
    pub async fn set_last_executor(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        executor: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE task_records SET last_executor = ? WHERE id = ?")
            .bind(executor)
            .bind(task_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Toggle the `awaiting_input` flag for a task.
    ///
    /// Set when an AskUserQuestion approval becomes pending and cleared when it
    /// resolves, so the task list / inbox can show a "waiting" indicator instead
    /// of the running spinner. Like `set_last_executor`, this deliberately does
    /// not touch `updated_at`: a question appearing must not re-order the task
    /// list. The row write still fans out through the SQLite update hook so the
    /// tasks stream reflects it live.
    pub async fn set_awaiting_input(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        awaiting: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE task_records SET awaiting_input = ? WHERE id = ?")
            .bind(awaiting)
            .bind(task_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Find task records that are expired (72+ hours since last activity) and eligible for worktree cleanup.
    /// Activity is determined by: task_run completion time, or task_record updated_at.
    /// Excludes tasks with any running executions.
    pub async fn find_expired_for_cleanup(
        pool: &Pool<Sqlite>,
    ) -> Result<Vec<(Uuid, String, String)>, sqlx::Error> {
        // Returns (task_id, worktree_path, git_repo_path)
        sqlx::query_as::<_, (Uuid, String, String)>(
            r#"
            SELECT tr.id, tr.worktree_path, pr.git_repo_path
            FROM task_records tr
            LEFT JOIN task_runs run ON tr.id = run.task_id AND run.completed_at IS NOT NULL
            JOIN project_records pr ON tr.project_id = pr.id
            WHERE tr.worktree_deleted = 0
                AND tr.worktree_path IS NOT NULL
                -- Exclude tasks with any running executions
                AND tr.id NOT IN (
                    SELECT DISTINCT r2.task_id
                    FROM task_runs r2
                    WHERE r2.completed_at IS NULL AND r2.started_at IS NOT NULL
                )
            GROUP BY tr.id, tr.worktree_path, pr.git_repo_path, tr.updated_at
            HAVING datetime('now', '-72 hours') > datetime(
                MAX(
                    CASE
                        WHEN run.completed_at IS NOT NULL THEN run.completed_at
                        ELSE tr.updated_at
                    END
                )
            )
            ORDER BY MAX(
                CASE
                    WHEN run.completed_at IS NOT NULL THEN run.completed_at
                    ELSE tr.updated_at
                END
            ) ASC
            "#,
        )
        .fetch_all(pool)
        .await
    }

    /// Update the status of a task record.
    pub async fn update_status(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        status: TaskStatus,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE task_records
             SET status = ?, updated_at = datetime('now')
             WHERE id = ?",
        )
        .bind(status)
        .bind(task_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update the title of a task record.
    pub async fn update_title(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        title: String,
        prompt: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE task_records
             SET title = ?, prompt = COALESCE(?, prompt), updated_at = datetime('now')
             WHERE id = ?",
        )
        .bind(title)
        .bind(prompt)
        .bind(task_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Batch-update sort_order for a list of task IDs.
    /// Each entry is (task_id, new_sort_order).
    pub async fn reorder(pool: &Pool<Sqlite>, updates: &[(Uuid, i32)]) -> Result<(), sqlx::Error> {
        for (task_id, sort_order) in updates {
            sqlx::query(
                "UPDATE task_records SET sort_order = ?, updated_at = datetime('now') WHERE id = ?",
            )
            .bind(sort_order)
            .bind(task_id)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Permanently delete a task.
    ///
    /// Relies on the underlying schema's cascading foreign keys to remove
    /// dependent rows (task runs, sessions, merges, etc.).
    pub async fn delete(pool: &Pool<Sqlite>, task_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM task_records WHERE id = ?")
            .bind(task_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub fn to_prompt(&self) -> String {
        if let Some(prompt) = self.prompt.as_deref().map(str::trim) {
            if !prompt.is_empty() {
                return prompt.to_string();
            }
        }

        legacy_prompt_from_parts(&self.title, self.description.as_deref())
            .unwrap_or_else(|| self.title.clone())
    }

    pub fn legacy_prompt(&self) -> Option<String> {
        legacy_prompt_from_parts(&self.title, self.description.as_deref())
    }

    pub fn prompt_matches_legacy(&self) -> bool {
        let prompt = match self.prompt.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => value,
            _ => return true,
        };
        match self.legacy_prompt() {
            Some(legacy) => legacy == prompt,
            None => false,
        }
    }
}

fn normalize_optional_text(text: Option<String>) -> Option<String> {
    text.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn legacy_prompt_from_parts(title: &str, description: Option<&str>) -> Option<String> {
    let trimmed_title = title.trim();

    if let Some(trimmed_description) = description.map(str::trim).filter(|value| !value.is_empty())
    {
        if let Some((context_block, trailing)) = split_leading_context_block(trimmed_description) {
            if trailing.is_empty() {
                if is_generated_session_title(trimmed_title) {
                    return Some(context_block.to_string());
                }
                if trimmed_title.is_empty() {
                    return Some(context_block.to_string());
                }
                return Some(format!("{}\n{}", context_block, trimmed_title));
            }

            if trimmed_title.is_empty() {
                return Some(format!("{}\n{}", context_block, trailing));
            }
            return Some(format!(
                "{}\n{}\n{}",
                context_block, trimmed_title, trailing
            ));
        }

        if trimmed_title.is_empty() {
            return Some(trimmed_description.to_string());
        }
        return Some(format!("{}\n{}", trimmed_title, trimmed_description));
    }

    if trimmed_title.is_empty() {
        None
    } else {
        Some(trimmed_title.to_string())
    }
}

fn split_leading_context_block(content: &str) -> Option<(&str, &str)> {
    let rest = content.strip_prefix("<context>")?;
    let end = rest.find("</context>")?;
    let context_end = "<context>".len() + end + "</context>".len();
    let (context_block, trailing) = content.split_at(context_end);
    Some((context_block, trailing.trim_start()))
}

fn is_generated_session_title(title: &str) -> bool {
    let rest = match title.strip_prefix("Session ") {
        Some(value) => value,
        None => return false,
    };

    let bytes = rest.as_bytes();
    bytes.len() == 16
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b' '
        && bytes[13] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13) || byte.is_ascii_digit())
}

fn normalize_prompt(
    prompt: Option<String>,
    title: &str,
    description: Option<&str>,
) -> Option<String> {
    normalize_optional_text(prompt).or_else(|| legacy_prompt_from_parts(title, description))
}

/// Task run (execution history)
///
/// Represents a single execution of a task. Multiple runs can exist per task.
/// Supports both local (worktree) and remote (Northflank Job) execution modes.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-run.ts")]
pub struct TaskRun {
    pub id: Uuid,
    pub slug: Option<String>,
    pub task_id: Uuid,
    pub execution_mode: ExecutionMode,
    pub status: RunStatus,
    pub run_reason: Option<String>,
    pub executor_action: Option<String>,
    pub executor_action_type: Option<String>,
    pub exit_code: Option<i32>,
    pub dropped: bool,
    pub before_head_commit: Option<String>,
    pub after_head_commit: Option<String>,
    pub branch_name: Option<String>,
    pub target_branch: Option<String>,
    pub container_ref: Option<String>,
    pub workspace_path: Option<String>,
    pub executor_label: Option<String>,
    pub resume_session_id: Option<String>,
    pub worktree_deleted: bool,
    // Remote execution fields (nullable)
    pub executor_job_id: Option<String>,
    pub s3_prefix: Option<String>,
    pub logs_uri: Option<String>,
    pub summary_uri: Option<String>,
    pub diffs_prefix: Option<String>,
    pub logs_retrieval_failed: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TaskRun {
    /// Create a new local execution run
    pub fn new_local(task_id: Uuid, run_reason: Option<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            slug: Some(generate_slug()),
            task_id,
            execution_mode: ExecutionMode::Local,
            status: RunStatus::Pending,
            run_reason,
            executor_action: None,
            executor_action_type: None,
            exit_code: None,
            dropped: false,
            before_head_commit: None,
            after_head_commit: None,
            branch_name: None,
            target_branch: None,
            container_ref: None,
            workspace_path: None,
            executor_label: None,
            resume_session_id: None,
            worktree_deleted: false,
            executor_job_id: None,
            s3_prefix: None,
            logs_uri: None,
            summary_uri: None,
            diffs_prefix: None,
            logs_retrieval_failed: false,
            started_at: None,
            completed_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a new remote execution run
    pub fn new_remote(task_id: Uuid, executor_job_id: String, run_reason: Option<String>) -> Self {
        let mut run = Self::new_local(task_id, run_reason);
        run.execution_mode = ExecutionMode::Remote;
        run.executor_job_id = Some(executor_job_id);
        run
    }

    /// Fetch a task run by id.
    pub async fn get(pool: &Pool<Sqlite>, run_id: Uuid) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_runs WHERE id = ?")
            .bind(run_id)
            .fetch_one(pool)
            .await
    }

    /// Persist the task run row.
    pub async fn insert(&self, pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO task_runs (
                id, slug, task_id, execution_mode, status, run_reason, executor_action, executor_action_type,
                exit_code, dropped, before_head_commit, after_head_commit, executor_job_id, s3_prefix,
                logs_uri, summary_uri, diffs_prefix, logs_retrieval_failed, started_at, completed_at,
                created_at, updated_at, branch_name, target_branch, container_ref, workspace_path,
                executor_label, resume_session_id, worktree_deleted
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )",
        )
        .bind(self.id)
        .bind(&self.slug)
        .bind(self.task_id)
        .bind(self.execution_mode)
        .bind(self.status)
        .bind(self.run_reason.clone())
        .bind(self.executor_action.clone())
        .bind(self.executor_action_type.clone())
        .bind(self.exit_code)
        .bind(self.dropped as i32)
        .bind(self.before_head_commit.clone())
        .bind(self.after_head_commit.clone())
        .bind(self.executor_job_id.clone())
        .bind(self.s3_prefix.clone())
        .bind(self.logs_uri.clone())
        .bind(self.summary_uri.clone())
        .bind(self.diffs_prefix.clone())
        .bind(self.logs_retrieval_failed as i32)
        .bind(self.started_at)
        .bind(self.completed_at)
        .bind(self.created_at)
        .bind(self.updated_at)
        .bind(self.branch_name.clone())
        .bind(self.target_branch.clone())
        .bind(self.container_ref.clone())
        .bind(self.workspace_path.clone())
        .bind(self.executor_label.clone())
        .bind(self.resume_session_id.clone())
        .bind(self.worktree_deleted as i32)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Mark run as started
    pub fn start(&mut self) {
        self.status = RunStatus::Running;
        self.started_at = Some(Utc::now());
        self.updated_at = Utc::now();
    }

    /// Mark run as completed
    pub fn complete(&mut self, exit_code: i32) {
        self.status = if exit_code == 0 {
            RunStatus::Completed
        } else {
            RunStatus::Failed
        };
        self.exit_code = Some(exit_code);
        self.completed_at = Some(Utc::now());
        self.updated_at = Utc::now();
    }

    /// Mark run as cancelled
    pub fn cancel(&mut self) {
        self.status = RunStatus::Cancelled;
        self.completed_at = Some(Utc::now());
        self.updated_at = Utc::now();
    }

    /// Fetch a run by SQLite rowid.
    pub async fn find_by_rowid(
        pool: &Pool<Sqlite>,
        rowid: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_runs WHERE rowid = ?")
            .bind(rowid)
            .fetch_optional(pool)
            .await
    }

    /// Fetch a run by UUID.
    pub async fn find_by_id(
        pool: &Pool<Sqlite>,
        run_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(pool)
            .await
    }

    /// Fetch a run by slug.
    pub async fn find_by_slug(
        pool: &Pool<Sqlite>,
        slug: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_runs WHERE slug = ?")
            .bind(slug)
            .fetch_optional(pool)
            .await
    }

    /// Fetch a task run by either UUID string or slug.
    pub async fn get_by_identifier(
        pool: &Pool<Sqlite>,
        identifier: &str,
    ) -> Result<Self, sqlx::Error> {
        if let Ok(uuid) = Uuid::parse_str(identifier) {
            return Self::get(pool, uuid).await;
        }
        Self::find_by_slug(pool, identifier)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Return all runs.
    pub async fn list_all(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_runs")
            .fetch_all(pool)
            .await
    }

    /// Return all runs for a task, ordered by created_at DESC.
    pub async fn list_by_task_id(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    /// Fetch the latest run for a project, if any.
    pub async fn latest_for_project(
        pool: &Pool<Sqlite>,
        project_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        if let Some(run_id) = sqlx::query_scalar::<_, Uuid>(
            "SELECT tr.id AS run_id FROM task_runs tr
             JOIN task_records t ON tr.task_id = t.id
             WHERE t.project_id = ? AND tr.worktree_deleted = 0 AND tr.container_ref IS NOT NULL
             ORDER BY tr.updated_at DESC LIMIT 1",
        )
        .bind(project_id)
        .fetch_optional(pool)
        .await?
        {
            return Ok(Some(Self::get(pool, run_id).await?));
        }
        Ok(None)
    }

    /// Fetch the latest run for a task, if any.
    pub async fn latest_for_task(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        if let Some(run_id) = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM task_runs
             WHERE task_id = ? AND worktree_deleted = 0 AND container_ref IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(task_id)
        .fetch_optional(pool)
        .await?
        {
            return Ok(Some(Self::get(pool, run_id).await?));
        }
        Ok(None)
    }
}

/// Task run logs (local execution only, chunked storage)
///
/// Stores logs in NDJSON format, split into chunks to avoid hitting
/// database size limits. Each chunk is max 10MB.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-run-log.ts")]
pub struct TaskRunLog {
    pub task_run_id: Uuid,
    pub sequence_number: i32,
    pub logs_jsonl: String,
    pub byte_size: i32,
    pub inserted_at: DateTime<Utc>,
}

impl TaskRunLog {
    pub const MAX_CHUNK_BYTES: usize = 10 * 1024 * 1024;

    /// Create a new log chunk
    pub fn new(task_run_id: Uuid, sequence_number: i32, logs_jsonl: String) -> Self {
        Self {
            task_run_id,
            sequence_number,
            byte_size: logs_jsonl.len() as i32,
            logs_jsonl,
            inserted_at: Utc::now(),
        }
    }

    /// Append log entries to a run, chunking automatically.
    pub async fn append_entries(
        pool: &Pool<Sqlite>,
        task_run_id: Uuid,
        entries: &[LogEntry],
    ) -> Result<(), sqlx::Error> {
        if entries.is_empty() {
            return Ok(());
        }

        let mut sequence: i64 = sqlx::query_scalar::<Sqlite, Option<i64>>(
            "SELECT COALESCE(MAX(sequence_number), -1) FROM task_run_logs WHERE task_run_id = ?",
        )
        .bind(task_run_id)
        .fetch_one(pool)
        .await?
        .unwrap_or(-1);

        let mut buffer = String::new();
        for entry in entries {
            let line = entry
                .to_json_line()
                .map_err(|err| sqlx::Error::ColumnDecode {
                    index: "logs_jsonl".into(),
                    source: err.into(),
                })?;

            if buffer.len() + line.len() > Self::MAX_CHUNK_BYTES && !buffer.is_empty() {
                sequence += 1;
                let chunk = mem::take(&mut buffer);
                Self::insert_chunk(pool, task_run_id, sequence, chunk).await?;
            }

            buffer.push_str(&line);
        }

        if !buffer.is_empty() {
            sequence += 1;
            let chunk = mem::take(&mut buffer);
            Self::insert_chunk(pool, task_run_id, sequence, chunk).await?;
        }

        Ok(())
    }

    async fn insert_chunk(
        pool: &Pool<Sqlite>,
        task_run_id: Uuid,
        sequence: i64,
        chunk: String,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO task_run_logs (task_run_id, sequence_number, logs_jsonl, byte_size) VALUES (?, ?, ?, ?)",
        )
        .bind(task_run_id)
        .bind(sequence as i32)
        .bind(&chunk)
        .bind(chunk.len() as i32)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Fetch every log entry for a run.
    pub async fn fetch_entries(
        pool: &Pool<Sqlite>,
        task_run_id: Uuid,
    ) -> Result<Vec<LogEntry>, sqlx::Error> {
        let rows: Vec<TaskRunLog> = sqlx::query_as(
            "SELECT task_run_id, sequence_number, logs_jsonl, byte_size, inserted_at FROM task_run_logs WHERE task_run_id = ? ORDER BY sequence_number ASC",
        )
        .bind(task_run_id)
        .fetch_all(pool)
        .await?;

        let mut entries = Vec::new();
        for row in rows {
            entries.extend(row.parse_entries()?);
        }
        Ok(entries)
    }

    fn parse_entries(&self) -> Result<Vec<LogEntry>, sqlx::Error> {
        let mut parsed = Vec::new();
        for line in self.logs_jsonl.lines() {
            if line.trim().is_empty() {
                continue;
            }

            let entry =
                LogEntry::from_json_line(line).map_err(|err| sqlx::Error::ColumnDecode {
                    index: "logs_jsonl".into(),
                    source: err.into(),
                })?;
            parsed.push(entry);
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_creation() {
        let project_id = Uuid::new_v4();
        let task = TaskRecord::new(project_id, "Test task", Some("Description".to_string()));
        assert_eq!(task.title, "Test task");
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.project_id, project_id);
    }

    #[test]
    fn test_subtask_creation() {
        let project_id = Uuid::new_v4();
        let parent_id = Uuid::new_v4();
        let task = TaskRecord::new_subtask(project_id, parent_id, "Subtask", None);
        assert_eq!(task.parent_task_id, Some(parent_id));
    }

    #[test]
    fn test_to_prompt_uses_stored_prompt_when_present() {
        let task = TaskRecord::new_with_prompt(
            Uuid::new_v4(),
            "fix the bug",
            Some("summary".to_string()),
            Some("<context>\n<file path=\"src/main.ts\" />\n</context>\nfix the bug".to_string()),
        );
        assert_eq!(
            task.to_prompt(),
            "<context>\n<file path=\"src/main.ts\" />\n</context>\nfix the bug"
        );
    }

    #[test]
    fn test_to_prompt_falls_back_to_legacy_prompt() {
        let task = TaskRecord::new(Uuid::new_v4(), "fix the bug", Some("add tests".to_string()));
        assert_eq!(task.to_prompt(), "fix the bug\nadd tests");
    }

    #[test]
    fn test_to_prompt_reconstructs_legacy_context_prompt() {
        let task = TaskRecord::new(
            Uuid::new_v4(),
            "fix the bug",
            Some("<context>\n<file path=\"src/main.ts\" />\n</context>\nadd tests".to_string()),
        );
        assert_eq!(
            task.to_prompt(),
            "<context>\n<file path=\"src/main.ts\" />\n</context>\nfix the bug\nadd tests"
        );
    }

    #[test]
    fn test_to_prompt_reconstructs_context_only_prompt_from_generated_title() {
        let task = TaskRecord::new(
            Uuid::new_v4(),
            "Session 2025-03-01 09:30",
            Some("<context>\n<file path=\"src/main.ts\" />\n</context>".to_string()),
        );
        assert_eq!(
            task.to_prompt(),
            "<context>\n<file path=\"src/main.ts\" />\n</context>"
        );
    }

    #[test]
    fn test_prompt_matches_legacy_when_prompt_is_derived() {
        let task = TaskRecord::new(Uuid::new_v4(), "fix the bug", Some("add tests".to_string()));
        assert!(task.prompt_matches_legacy());
    }

    #[test]
    fn test_prompt_matches_legacy_is_false_for_custom_prompt() {
        let task = TaskRecord::new_with_prompt(
            Uuid::new_v4(),
            "fix the bug",
            Some("add tests".to_string()),
            Some("<context>\n<file path=\"src/main.ts\" />\n</context>\nfix the bug".to_string()),
        );
        assert!(!task.prompt_matches_legacy());
    }

    #[test]
    fn test_local_run_creation() {
        let task_id = Uuid::new_v4();
        let run = TaskRun::new_local(task_id, Some("Initial run".to_string()));
        assert_eq!(run.execution_mode, ExecutionMode::Local);
        assert_eq!(run.status, RunStatus::Pending);
        assert!(run.executor_job_id.is_none());
    }

    #[test]
    fn test_remote_run_creation() {
        let task_id = Uuid::new_v4();
        let run = TaskRun::new_remote(task_id, "job-123".to_string(), None);
        assert_eq!(run.execution_mode, ExecutionMode::Remote);
        assert_eq!(run.executor_job_id, Some("job-123".to_string()));
    }

    #[test]
    fn test_run_lifecycle() {
        let task_id = Uuid::new_v4();
        let mut run = TaskRun::new_local(task_id, None);

        run.start();
        assert_eq!(run.status, RunStatus::Running);
        assert!(run.started_at.is_some());

        run.complete(0);
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.exit_code, Some(0));
        assert!(run.completed_at.is_some());
    }

    #[test]
    fn test_log_chunk_creation() {
        let run_id = Uuid::new_v4();
        let logs = r#"{"level":"info","msg":"test"}\n{"level":"error","msg":"fail"}"#;
        let log = TaskRunLog::new(run_id, 0, logs.to_string());
        assert_eq!(log.sequence_number, 0);
        assert_eq!(log.byte_size, logs.len() as i32);
    }

    #[tokio::test]
    async fn append_and_fetch_logs() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("logs.db");
        let service = crate::DBService::new_with_path(&db_path).await.unwrap();

        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at) VALUES (?, 'proj', '/tmp', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_records (id, project_id, title, created_at, updated_at)
             VALUES (?, ?, 'task', datetime('now'), datetime('now'))",
        )
        .bind(task_id)
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        let mut run = TaskRun::new_local(task_id, None);
        run.id = Uuid::new_v4();
        sqlx::query("INSERT INTO task_runs (id, task_id, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
        .bind(run.id)
        .bind(task_id)
        .execute(service.pool())
        .await
        .unwrap();

        let entries = vec![
            LogEntry::Stdout("hello".into()),
            LogEntry::Stdout("world".into()),
            LogEntry::Finished,
        ];

        TaskRunLog::append_entries(service.pool(), run.id, &entries)
            .await
            .unwrap();
        let stored = TaskRunLog::fetch_entries(service.pool(), run.id)
            .await
            .unwrap();
        assert_eq!(stored.len(), 3);
        assert!(matches!(stored.last(), Some(LogEntry::Finished)));
    }

    #[tokio::test]
    async fn update_status_persists_changes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("status.db");
        let service = crate::DBService::new_with_path(&db_path).await.unwrap();

        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'proj', '/tmp', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_records (id, project_id, title, status, created_at, updated_at)
             VALUES (?, ?, 'task', 'pending', datetime('now'), datetime('now'))",
        )
        .bind(task_id)
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        TaskRecord::update_status(service.pool(), task_id, TaskStatus::Completed)
            .await
            .unwrap();

        let fetched = TaskRecord::find_by_id(service.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fetched.status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn set_awaiting_input_toggles_without_reordering() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("awaiting.db");
        let service = crate::DBService::new_with_path(&db_path).await.unwrap();

        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'proj', '/tmp', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_records (id, project_id, title, status, created_at, updated_at)
             VALUES (?, ?, 'task', 'pending', datetime('now'), datetime('now'))",
        )
        .bind(task_id)
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        // A freshly inserted task defaults to not waiting (column default).
        let fresh = TaskRecord::find_by_id(service.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert!(!fresh.awaiting_input);
        let baseline_updated_at = fresh.updated_at;

        // Marking the task as waiting on a user answer persists...
        TaskRecord::set_awaiting_input(service.pool(), task_id, true)
            .await
            .unwrap();
        let waiting = TaskRecord::find_by_id(service.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert!(waiting.awaiting_input);
        // ...but must not touch updated_at, or a question would reorder the
        // task list / inbox (which is sorted by recency).
        assert_eq!(
            waiting.updated_at, baseline_updated_at,
            "set_awaiting_input must not bump updated_at"
        );

        // Resolving the question clears the flag again.
        TaskRecord::set_awaiting_input(service.pool(), task_id, false)
            .await
            .unwrap();
        let cleared = TaskRecord::find_by_id(service.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert!(!cleared.awaiting_input);
        assert_eq!(
            cleared.updated_at, baseline_updated_at,
            "set_awaiting_input must not bump updated_at"
        );
    }
}
