use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;
use uuid::Uuid;

/// Task template (reusable task definitions)
///
/// Templates can be global (project_id = NULL) or project-specific.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-template.ts")]
pub struct TaskTemplate {
    pub id: Uuid,
    pub project_id: Option<Uuid>,
    pub template_name: String,
    pub title: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TaskTemplate {
    /// Create a new global template
    pub fn new_global(
        template_name: impl Into<String>,
        title: impl Into<String>,
        description: Option<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            project_id: None,
            template_name: template_name.into(),
            title: title.into(),
            description,
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a new project-specific template
    pub fn new_project(
        project_id: Uuid,
        template_name: impl Into<String>,
        title: impl Into<String>,
        description: Option<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            project_id: Some(project_id),
            template_name: template_name.into(),
            title: title.into(),
            description,
            created_at: now,
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_global_template() {
        let template = TaskTemplate::new_global(
            "daily-standup",
            "Daily Standup",
            Some("Daily team sync".to_string()),
        );
        assert!(template.project_id.is_none());
        assert_eq!(template.template_name, "daily-standup");
    }

    #[test]
    fn test_project_template() {
        let project_id = Uuid::new_v4();
        let template = TaskTemplate::new_project(project_id, "code-review", "Code Review", None);
        assert_eq!(template.project_id, Some(project_id));
    }
}
