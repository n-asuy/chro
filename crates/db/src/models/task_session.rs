use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{FromRow, Pool, Sqlite};
use ts_rs::TS;
use uuid::Uuid;

/// Task session (agent interaction session)
///
/// Represents a session where an agent (human or LLM) works on a task.
/// Sessions can be handed off between agents.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-session.ts")]
pub struct TaskSession {
    pub id: Uuid,
    pub task_id: Uuid,
    pub task_run_id: Option<Uuid>,
    pub agent_profile_id: Uuid,
    pub external_session_id: Option<String>,
    pub prompt: Option<String>,
    pub summary: Option<String>,
    pub handoff_from_session_id: Option<Uuid>,
    pub worktree_commit: Option<String>,
    #[ts(type = "Record<string, unknown> | null")]
    pub state_snapshot: Option<JsonValue>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TaskSession {
    /// Create a new session
    pub fn new(task_id: Uuid, agent_profile_id: Uuid, prompt: Option<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            task_id,
            task_run_id: None,
            agent_profile_id,
            external_session_id: None,
            prompt,
            summary: None,
            handoff_from_session_id: None,
            worktree_commit: None,
            state_snapshot: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a handoff session from another session
    pub fn new_handoff(
        task_id: Uuid,
        agent_profile_id: Uuid,
        from_session_id: Uuid,
        prompt: Option<String>,
    ) -> Self {
        let mut session = Self::new(task_id, agent_profile_id, prompt);
        session.handoff_from_session_id = Some(from_session_id);
        session
    }

    /// Record the one-line outcome summary on the session that executed a run.
    /// A per-session historical record; the latest value is also denormalized
    /// onto the task via `TaskRecord::set_last_summary`.
    pub async fn set_summary_by_run_id(
        pool: &Pool<Sqlite>,
        task_run_id: Uuid,
        summary: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE task_sessions SET summary = ?, updated_at = datetime('now') WHERE task_run_id = ?",
        )
        .bind(summary)
        .bind(task_run_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Return the most recent run id mapped to an external session, if any.
    pub async fn latest_run_id_by_external_session(
        pool: &Pool<Sqlite>,
        external_session_id: &str,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        let run_id = sqlx::query_scalar::<_, Option<Uuid>>(
            "SELECT task_run_id FROM task_sessions WHERE external_session_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(external_session_id)
        .fetch_optional(pool)
        .await?;

        Ok(run_id.flatten())
    }

    /// Fetch a session by SQLite rowid.
    pub async fn find_by_rowid(
        pool: &Pool<Sqlite>,
        rowid: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_sessions WHERE rowid = ?")
            .bind(rowid)
            .fetch_optional(pool)
            .await
    }

    /// Fetch all sessions.
    pub async fn list_all(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_sessions")
            .fetch_all(pool)
            .await
    }

    /// Fetch all sessions for a task, ordered by created_at ascending.
    pub async fn list_by_task_id(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM task_sessions WHERE task_id = ? ORDER BY created_at ASC",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_creation() {
        let task_id = Uuid::new_v4();
        let agent_id = Uuid::new_v4();
        let session = TaskSession::new(task_id, agent_id, Some("Test prompt".to_string()));
        assert_eq!(session.task_id, task_id);
        assert_eq!(session.agent_profile_id, agent_id);
        assert!(session.handoff_from_session_id.is_none());
    }

    #[test]
    fn test_handoff_session() {
        let task_id = Uuid::new_v4();
        let agent_id = Uuid::new_v4();
        let from_session = Uuid::new_v4();
        let session = TaskSession::new_handoff(task_id, agent_id, from_session, None);
        assert_eq!(session.handoff_from_session_id, Some(from_session));
    }
}
