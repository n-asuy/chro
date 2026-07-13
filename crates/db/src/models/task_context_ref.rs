use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Sqlite};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-context-ref.ts")]
pub struct TaskContextRef {
    pub id: Uuid,
    pub task_id: Uuid,
    pub task_session_id: Option<Uuid>,
    pub task_run_id: Option<Uuid>,
    pub kind: String,
    pub target_task_id: Option<Uuid>,
    pub target_session_id: Option<Uuid>,
    pub path: Option<String>,
    pub branch: Option<String>,
    pub mode: String,
    pub label: Option<String>,
    pub metadata_json: Option<String>,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "task-context-ref-input.ts")]
pub struct TaskContextRefInput {
    pub kind: String,
    pub target_task_id: Option<Uuid>,
    pub target_session_id: Option<Uuid>,
    pub path: Option<String>,
    pub branch: Option<String>,
    pub mode: Option<String>,
    pub label: Option<String>,
    pub metadata_json: Option<String>,
}

impl TaskContextRefInput {
    pub fn session(target_task_id: Uuid, branch: Option<String>) -> Self {
        Self {
            kind: "session".to_string(),
            target_task_id: Some(target_task_id),
            target_session_id: None,
            path: None,
            branch,
            mode: Some("transcript".to_string()),
            label: None,
            metadata_json: None,
        }
    }

    pub fn file(path: impl Into<String>, is_file: bool, branch: Option<String>) -> Self {
        Self {
            kind: if is_file { "file" } else { "directory" }.to_string(),
            target_task_id: None,
            target_session_id: None,
            path: Some(path.into()),
            branch,
            mode: Some("link".to_string()),
            label: None,
            metadata_json: None,
        }
    }
}

impl TaskContextRef {
    pub async fn insert_for_task(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        task_session_id: Option<Uuid>,
        task_run_id: Option<Uuid>,
        input: &TaskContextRefInput,
        sort_order: i32,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        let mode = input
            .mode
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_mode_for_kind(&input.kind));
        let now = Utc::now();

        sqlx::query(
            "INSERT INTO task_context_refs (
                id, task_id, task_session_id, task_run_id, kind, target_task_id,
                target_session_id, path, branch, mode, label, metadata_json,
                sort_order, created_at, updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(task_id)
        .bind(task_session_id)
        .bind(task_run_id)
        .bind(&input.kind)
        .bind(input.target_task_id)
        .bind(input.target_session_id)
        .bind(&input.path)
        .bind(&input.branch)
        .bind(mode)
        .bind(&input.label)
        .bind(&input.metadata_json)
        .bind(sort_order)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        Self::get(pool, id).await
    }

    pub async fn replace_for_task_scope(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        task_session_id: Option<Uuid>,
        task_run_id: Option<Uuid>,
        refs: &[TaskContextRefInput],
    ) -> Result<Vec<Self>, sqlx::Error> {
        let mut transaction = pool.begin().await?;
        match (task_session_id, task_run_id) {
            (Some(session_id), _) => {
                sqlx::query("DELETE FROM task_context_refs WHERE task_session_id = ?")
                    .bind(session_id)
                    .execute(&mut *transaction)
                    .await?;
            }
            (None, Some(run_id)) => {
                sqlx::query(
                    "DELETE FROM task_context_refs WHERE task_session_id IS NULL AND task_run_id = ?",
                )
                .bind(run_id)
                .execute(&mut *transaction)
                .await?;
            }
            (None, None) => {
                sqlx::query(
                    "DELETE FROM task_context_refs WHERE task_id = ? AND task_session_id IS NULL AND task_run_id IS NULL",
                )
                .bind(task_id)
                .execute(&mut *transaction)
                .await?;
            }
        }

        let mut inserted = Vec::with_capacity(refs.len());
        for (index, input) in refs.iter().enumerate() {
            let id = Uuid::new_v4();
            let mode = input
                .mode
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(default_mode_for_kind(&input.kind))
                .to_string();
            let now = Utc::now();
            let record = Self {
                id,
                task_id,
                task_session_id,
                task_run_id,
                kind: input.kind.clone(),
                target_task_id: input.target_task_id,
                target_session_id: input.target_session_id,
                path: input.path.clone(),
                branch: input.branch.clone(),
                mode,
                label: input.label.clone(),
                metadata_json: input.metadata_json.clone(),
                sort_order: index as i32,
                created_at: now,
                updated_at: now,
            };

            sqlx::query(
                "INSERT INTO task_context_refs (
                    id, task_id, task_session_id, task_run_id, kind, target_task_id,
                    target_session_id, path, branch, mode, label, metadata_json,
                    sort_order, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(record.id)
            .bind(record.task_id)
            .bind(record.task_session_id)
            .bind(record.task_run_id)
            .bind(&record.kind)
            .bind(record.target_task_id)
            .bind(record.target_session_id)
            .bind(&record.path)
            .bind(&record.branch)
            .bind(&record.mode)
            .bind(&record.label)
            .bind(&record.metadata_json)
            .bind(record.sort_order)
            .bind(record.created_at)
            .bind(record.updated_at)
            .execute(&mut *transaction)
            .await?;
            inserted.push(record);
        }
        transaction.commit().await?;
        Ok(inserted)
    }

    pub async fn get(pool: &Pool<Sqlite>, id: Uuid) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM task_context_refs WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
    }

    pub async fn list_by_task_id(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM task_context_refs WHERE task_id = ? ORDER BY COALESCE(task_session_id, ''), sort_order ASC, created_at ASC",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_referencing_task_id(
        pool: &Pool<Sqlite>,
        target_task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM task_context_refs WHERE target_task_id = ? ORDER BY created_at DESC",
        )
        .bind(target_task_id)
        .fetch_all(pool)
        .await
    }
}

fn default_mode_for_kind(kind: &str) -> &'static str {
    match kind {
        "session" => "transcript",
        _ => "link",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DBService;

    #[tokio::test]
    async fn replace_for_task_scope_stores_ordered_refs() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("refs.db");
        let service = DBService::new_with_path(&db_path).await.unwrap();
        let pool = service.pool();

        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'proj', '/tmp/proj', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(pool)
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        let target_task_id = Uuid::new_v4();
        for id in [task_id, target_task_id] {
            sqlx::query(
                "INSERT INTO task_records (id, project_id, title, status, created_at, updated_at)
                 VALUES (?, ?, 'task', 'pending', datetime('now'), datetime('now'))",
            )
            .bind(id)
            .bind(project_id)
            .execute(pool)
            .await
            .unwrap();
        }

        let refs = vec![
            TaskContextRefInput::session(target_task_id, None),
            TaskContextRefInput::file("src/main.ts", true, Some("feature/x".to_string())),
        ];

        let inserted = TaskContextRef::replace_for_task_scope(pool, task_id, None, None, &refs)
            .await
            .unwrap();
        assert_eq!(inserted.len(), 2);
        assert_eq!(inserted[0].sort_order, 0);
        assert_eq!(inserted[0].mode, "transcript");
        assert_eq!(inserted[1].kind, "file");

        let incoming = TaskContextRef::list_referencing_task_id(pool, target_task_id)
            .await
            .unwrap();
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].task_id, task_id);
    }

    #[tokio::test]
    async fn replace_for_task_scope_restores_old_refs_when_insert_fails() {
        let temp_dir = tempfile::tempdir().unwrap();
        let service = DBService::new_with_path(temp_dir.path().join("refs-rollback.db"))
            .await
            .unwrap();
        let pool = service.pool();
        let project_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path) VALUES (?, 'proj', '/tmp/refs-rollback')",
        )
        .bind(project_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO task_records (id, project_id, title) VALUES (?, ?, 'task')")
            .bind(task_id)
            .bind(project_id)
            .execute(pool)
            .await
            .unwrap();

        let old = TaskContextRefInput::file("old.rs", true, None);
        TaskContextRef::insert_for_task(pool, task_id, None, None, &old, 0)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_bad_ref BEFORE INSERT ON task_context_refs
             WHEN NEW.path = 'bad.rs' BEGIN SELECT RAISE(ABORT, 'forced ref failure'); END",
        )
        .execute(pool)
        .await
        .unwrap();

        let replacement = vec![
            TaskContextRefInput::file("new.rs", true, None),
            TaskContextRefInput::file("bad.rs", true, None),
        ];
        let result =
            TaskContextRef::replace_for_task_scope(pool, task_id, None, None, &replacement).await;
        assert!(result.is_err());

        let stored = TaskContextRef::list_by_task_id(pool, task_id)
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].path.as_deref(), Some("old.rs"));
    }
}
