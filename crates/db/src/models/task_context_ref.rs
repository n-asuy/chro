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

    /// Provenance edge for a session branched off another one.
    ///
    /// `label` is a snapshot of the source title, not a live lookup: the row it
    /// points at can be renamed or deleted without breaking the badge that
    /// renders it. `mode` records whether the conversation was duplicated
    /// natively or degraded to a digest handoff.
    pub fn fork(
        source_task_id: Uuid,
        source_session_id: Option<Uuid>,
        mode: ForkMode,
        anchor: ForkAnchor,
        source_title_snapshot: Option<String>,
    ) -> Self {
        Self {
            kind: "fork".to_string(),
            target_task_id: Some(source_task_id),
            target_session_id: source_session_id,
            path: None,
            branch: None,
            mode: Some(mode.as_str().to_string()),
            label: source_title_snapshot,
            metadata_json: serde_json::to_string(&anchor).ok(),
        }
    }

    /// Provenance edge for a task spawned to carry delegated work.
    ///
    /// Written by the broker on the CHILD task, pointing at the task that
    /// delegated. `label` snapshots the delegating task's title so the badge
    /// survives renames and deletions. The digest push into the child's boot
    /// prompt happens at spawn; this edge only records that it did.
    pub fn delegate(source_task_id: Uuid, source_title_snapshot: Option<String>) -> Self {
        Self {
            kind: "delegate".to_string(),
            target_task_id: Some(source_task_id),
            target_session_id: None,
            path: None,
            branch: None,
            mode: Some("digest".to_string()),
            label: source_title_snapshot,
            metadata_json: None,
        }
    }

    /// Completion report for a delegated task, written by the broker on the
    /// DELEGATING task when a child run finishes.
    ///
    /// Doubles as the outcome-ledger row: `label` snapshots the child's title,
    /// the payload pins the exact run and the commit it produced.
    pub fn handoff(
        child_task_id: Uuid,
        info: HandoffInfo,
        child_title_snapshot: Option<String>,
    ) -> Self {
        Self {
            kind: "handoff".to_string(),
            target_task_id: Some(child_task_id),
            target_session_id: None,
            path: None,
            branch: None,
            mode: Some("digest".to_string()),
            label: child_title_snapshot,
            metadata_json: serde_json::to_string(&info).ok(),
        }
    }
}

/// What a completed delegated run handed back.
///
/// The conversation side (`run_id`) always exists. The git side does not:
/// General chats and non-git projects produce no commit, so `commit` and
/// `branch` are None there.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "handoff-info.ts")]
pub struct HandoffInfo {
    pub run_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// True once this handoff has been pushed into the delegating session (the
    /// barrier wake). Undelivered handoffs accumulate until every delegated
    /// sibling is terminal, then ship together in one wake.
    #[serde(default)]
    pub delivered: bool,
}

/// How the forked session inherits its conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "fork-mode.ts")]
pub enum ForkMode {
    /// The executor duplicated the session (claude `--fork-session`, codex
    /// rollout copy). Full context carries over.
    Native,
    /// The executor cannot duplicate, or the anchor run ended resume-unsafe:
    /// only a digest of the prior conversation carries over.
    Digest,
}

impl ForkMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Digest => "digest",
        }
    }
}

/// The point a fork branched from.
///
/// The conversation side (`run_id`, and the executor's message id when it has
/// one) always exists. The git side does not: General chats and non-git
/// projects have no commit to anchor to, so `commit` is None there.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "fork-anchor.ts")]
pub struct ForkAnchor {
    pub run_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
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

    /// Replace the composer-authored refs of one scope.
    ///
    /// Only kinds the composer can author are cleared. Broker-authored edges
    /// (`fork`, `delegate`, `handoff`) live in the same table but are
    /// provenance the user never edits: a prompt save must not delete the
    /// record of where a session came from or what was handed back to it.
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
                sqlx::query(&format!(
                    "DELETE FROM task_context_refs WHERE task_session_id = ? AND kind IN ({})",
                    COMPOSER_KIND_PLACEHOLDERS
                ))
                .bind(session_id)
                .execute(&mut *transaction)
                .await?;
            }
            (None, Some(run_id)) => {
                sqlx::query(&format!(
                    "DELETE FROM task_context_refs WHERE task_session_id IS NULL AND task_run_id = ? AND kind IN ({})",
                    COMPOSER_KIND_PLACEHOLDERS
                ))
                .bind(run_id)
                .execute(&mut *transaction)
                .await?;
            }
            (None, None) => {
                sqlx::query(&format!(
                    "DELETE FROM task_context_refs WHERE task_id = ? AND task_session_id IS NULL AND task_run_id IS NULL AND kind IN ({})",
                    COMPOSER_KIND_PLACEHOLDERS
                ))
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

    /// Rewrite one edge's payload in place. Broker bookkeeping only (e.g.
    /// marking a handoff delivered); the edge itself never moves or re-keys.
    pub async fn update_metadata(
        pool: &Pool<Sqlite>,
        id: Uuid,
        metadata_json: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE task_context_refs SET metadata_json = ?, updated_at = datetime('now', 'subsec') WHERE id = ?",
        )
        .bind(metadata_json)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
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
        "fork" => "native",
        "delegate" | "handoff" => "digest",
        _ => "link",
    }
}

/// Kinds the composer authors, as a SQL literal list.
///
/// Inlined rather than bound because the values are compile-time constants, and
/// a bound `IN` list would need one placeholder per kind. Keep in sync with the
/// `kind` CHECK constraint: everything there except broker-authored kinds.
const COMPOSER_KIND_PLACEHOLDERS: &str = "'session', 'task', 'file', 'directory', 'skill', 'image'";

/// True for edges the broker writes as provenance, which the composer must
/// never clear.
pub fn is_broker_authored_kind(kind: &str) -> bool {
    matches!(kind, "fork" | "delegate" | "handoff")
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

    /// A prompt save replaces the composer's own refs. It must leave the fork
    /// edge alone: that edge is the only record of where the session came from,
    /// and the user never authored it.
    #[tokio::test]
    async fn replace_for_task_scope_keeps_fork_edge() {
        let temp_dir = tempfile::tempdir().unwrap();
        let service = DBService::new_with_path(temp_dir.path().join("fork-keep.db"))
            .await
            .unwrap();
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
        let source_task_id = Uuid::new_v4();
        for id in [task_id, source_task_id] {
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

        let anchor = ForkAnchor {
            run_id: Uuid::new_v4(),
            message_uuid: None,
            commit: Some("a4f2e1c".to_string()),
        };
        TaskContextRef::insert_for_task(
            pool,
            task_id,
            None,
            None,
            &TaskContextRefInput::fork(
                source_task_id,
                None,
                ForkMode::Native,
                anchor,
                Some("retry policy".to_string()),
            ),
            0,
        )
        .await
        .unwrap();

        // The composer saves a prompt carrying one file ref.
        TaskContextRef::replace_for_task_scope(
            pool,
            task_id,
            None,
            None,
            &[TaskContextRefInput::file("src/main.rs", true, None)],
        )
        .await
        .unwrap();

        let stored = TaskContextRef::list_by_task_id(pool, task_id).await.unwrap();
        let kinds: Vec<&str> = stored.iter().map(|r| r.kind.as_str()).collect();
        assert!(
            kinds.contains(&"fork"),
            "fork edge was dropped by a composer save: {kinds:?}"
        );
        assert!(kinds.contains(&"file"));
        assert_eq!(stored.len(), 2);

        let fork_edge = stored.iter().find(|r| r.kind == "fork").unwrap();
        assert_eq!(fork_edge.mode, "native");
        assert_eq!(fork_edge.label.as_deref(), Some("retry policy"));
        assert_eq!(fork_edge.target_task_id, Some(source_task_id));
        let anchor: ForkAnchor = serde_json::from_str(fork_edge.metadata_json.as_ref().unwrap())
            .expect("anchor round-trips");
        assert_eq!(anchor.commit.as_deref(), Some("a4f2e1c"));
    }

    /// The delegation backbone writes two broker edges: `delegate` on the
    /// child, `handoff` on the parent. Both are lifecycle provenance the
    /// composer never authored, so a prompt save must leave them alone.
    #[tokio::test]
    async fn replace_for_task_scope_keeps_delegate_and_handoff_edges() {
        let temp_dir = tempfile::tempdir().unwrap();
        let service = DBService::new_with_path(temp_dir.path().join("delegate-keep.db"))
            .await
            .unwrap();
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

        let parent_task_id = Uuid::new_v4();
        let child_task_id = Uuid::new_v4();
        for id in [parent_task_id, child_task_id] {
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

        TaskContextRef::insert_for_task(
            pool,
            child_task_id,
            None,
            None,
            &TaskContextRefInput::delegate(parent_task_id, Some("billing revamp".to_string())),
            0,
        )
        .await
        .unwrap();
        let info = HandoffInfo {
            run_id: Uuid::new_v4(),
            commit: Some("b7d9e2f".to_string()),
            branch: Some("ch/a1b2".to_string()),
            delivered: false,
        };
        TaskContextRef::insert_for_task(
            pool,
            parent_task_id,
            None,
            None,
            &TaskContextRefInput::handoff(child_task_id, info, Some("schema migration".to_string())),
            0,
        )
        .await
        .unwrap();

        for task_id in [child_task_id, parent_task_id] {
            TaskContextRef::replace_for_task_scope(
                pool,
                task_id,
                None,
                None,
                &[TaskContextRefInput::file("src/main.rs", true, None)],
            )
            .await
            .unwrap();
        }

        let child_kinds: Vec<String> = TaskContextRef::list_by_task_id(pool, child_task_id)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.kind)
            .collect();
        assert!(
            child_kinds.iter().any(|k| k == "delegate"),
            "delegate edge was dropped by a composer save: {child_kinds:?}"
        );

        let parent_refs = TaskContextRef::list_by_task_id(pool, parent_task_id)
            .await
            .unwrap();
        let handoff_edge = parent_refs
            .iter()
            .find(|r| r.kind == "handoff")
            .expect("handoff edge was dropped by a composer save");
        assert_eq!(handoff_edge.mode, "digest");
        assert_eq!(handoff_edge.target_task_id, Some(child_task_id));
        let round_trip: HandoffInfo =
            serde_json::from_str(handoff_edge.metadata_json.as_ref().unwrap())
                .expect("handoff info round-trips");
        assert_eq!(round_trip.commit.as_deref(), Some("b7d9e2f"));
        assert_eq!(round_trip.branch.as_deref(), Some("ch/a1b2"));
    }
}
