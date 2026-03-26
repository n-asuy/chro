use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;
use uuid::Uuid;

use crate::types::RecurrenceStatus;

/// Task recurrence (scheduled recurring tasks)
///
/// Manages recurring task schedules and tracks the last generated task.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-recurrence.ts")]
pub struct TaskRecurrence {
    pub id: Uuid,
    pub project_id: Uuid,
    pub parent_task_id: Option<Uuid>,
    pub last_task_id: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
    pub image_ids: Option<String>, // JSON array
    pub starts_at: Option<DateTime<Utc>>,
    pub frequency: Option<String>,
    pub interval: Option<i32>,
    pub timezone: Option<String>,
    pub status: RecurrenceStatus,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TaskRecurrence {
    /// Create a new recurrence
    pub fn new(
        project_id: Uuid,
        title: impl Into<String>,
        frequency: impl Into<String>,
        interval: i32,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            project_id,
            parent_task_id: None,
            last_task_id: None,
            title: title.into(),
            description: None,
            image_ids: None,
            starts_at: Some(now),
            frequency: Some(frequency.into()),
            interval: Some(interval),
            timezone: None,
            status: RecurrenceStatus::Active,
            next_run_at: None,
            last_run_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Pause the recurrence
    pub fn pause(&mut self) {
        self.status = RecurrenceStatus::Paused;
        self.updated_at = Utc::now();
    }

    /// Resume the recurrence
    pub fn resume(&mut self) {
        self.status = RecurrenceStatus::Active;
        self.updated_at = Utc::now();
    }

    /// Mark as completed
    pub fn complete(&mut self) {
        self.status = RecurrenceStatus::Completed;
        self.updated_at = Utc::now();
    }

    /// Update after task generation
    pub fn mark_task_generated(&mut self, task_id: Uuid, next_run: DateTime<Utc>) {
        self.last_task_id = Some(task_id);
        self.last_run_at = Some(Utc::now());
        self.next_run_at = Some(next_run);
        self.updated_at = Utc::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recurrence_creation() {
        let project_id = Uuid::new_v4();
        let recurrence = TaskRecurrence::new(project_id, "Daily backup", "daily", 1);
        assert_eq!(recurrence.status, RecurrenceStatus::Active);
        assert_eq!(recurrence.frequency, Some("daily".to_string()));
    }

    #[test]
    fn test_recurrence_lifecycle() {
        let project_id = Uuid::new_v4();
        let mut recurrence = TaskRecurrence::new(project_id, "Test", "weekly", 1);

        recurrence.pause();
        assert_eq!(recurrence.status, RecurrenceStatus::Paused);

        recurrence.resume();
        assert_eq!(recurrence.status, RecurrenceStatus::Active);

        recurrence.complete();
        assert_eq!(recurrence.status, RecurrenceStatus::Completed);
    }

    #[test]
    fn test_task_generation() {
        let project_id = Uuid::new_v4();
        let mut recurrence = TaskRecurrence::new(project_id, "Test", "daily", 1);
        let task_id = Uuid::new_v4();
        let next_run = Utc::now();

        recurrence.mark_task_generated(task_id, next_run);
        assert_eq!(recurrence.last_task_id, Some(task_id));
        assert!(recurrence.last_run_at.is_some());
        assert!(recurrence.next_run_at.is_some());
    }
}
