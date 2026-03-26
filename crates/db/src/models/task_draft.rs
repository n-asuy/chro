use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Sqlite};
use ts_rs::TS;
use uuid::Uuid;

use crate::types::DraftType;

/// Task draft (prompt drafts, retries, follow-ups)
///
/// Represents a draft prompt or retry attempt for a task.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-draft.ts")]
pub struct TaskDraft {
    pub id: Uuid,
    pub task_id: Uuid,
    pub retry_task_run_id: Option<Uuid>,
    pub draft_type: DraftType,
    pub prompt: Option<String>,
    pub image_ids: Option<String>, // JSON array
    pub queued: bool,
    pub sending: bool,
    pub version: i32,
    pub variant: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TaskDraft {
    /// Create a new initial draft
    pub fn new_initial(task_id: Uuid, prompt: Option<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            task_id,
            retry_task_run_id: None,
            draft_type: DraftType::Initial,
            prompt,
            image_ids: None,
            queued: false,
            sending: false,
            version: 1,
            variant: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a new retry draft
    pub fn new_retry(task_id: Uuid, retry_task_run_id: Uuid, prompt: Option<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            task_id,
            retry_task_run_id: Some(retry_task_run_id),
            draft_type: DraftType::Retry,
            prompt,
            image_ids: None,
            queued: false,
            sending: false,
            version: 1,
            variant: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Mark as queued
    pub fn mark_queued(&mut self) {
        self.queued = true;
        self.updated_at = Utc::now();
    }

    /// Mark as sending
    pub fn mark_sending(&mut self) {
        self.sending = true;
        self.updated_at = Utc::now();
    }

    /// Fetch a draft by SQLite rowid.
    pub async fn find_by_rowid(
        pool: &Pool<Sqlite>,
        rowid: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_drafts WHERE rowid = ?")
            .bind(rowid)
            .fetch_optional(pool)
            .await
    }

    /// Fetch all drafts.
    pub async fn list_all(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_drafts")
            .fetch_all(pool)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_draft() {
        let task_id = Uuid::new_v4();
        let draft = TaskDraft::new_initial(task_id, Some("Test prompt".to_string()));
        assert_eq!(draft.draft_type, DraftType::Initial);
        assert!(draft.retry_task_run_id.is_none());
    }

    #[test]
    fn test_retry_draft() {
        let task_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let draft = TaskDraft::new_retry(task_id, run_id, None);
        assert_eq!(draft.draft_type, DraftType::Retry);
        assert_eq!(draft.retry_task_run_id, Some(run_id));
    }

    #[test]
    fn test_draft_state() {
        let task_id = Uuid::new_v4();
        let mut draft = TaskDraft::new_initial(task_id, None);

        draft.mark_queued();
        assert!(draft.queued);

        draft.mark_sending();
        assert!(draft.sending);
    }
}
