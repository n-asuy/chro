use std::{collections::HashMap, sync::Arc};

use approvals::{ApprovalResolvedData, ApprovalWaiter, Approvals, CreateApprovalRequest};
use db::{models::TaskRecord, DBService};
use events::MsgStore;
use executors::{ExecutorApprovalError, ExecutorApprovalService, QuestionStatus};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Bridges runtime approval storage with the executor approval interface.
pub struct ExecutorApprovalBridge {
    approvals: Approvals<MsgStore>,
    task_run_id: Uuid,
    /// Owning task, resolved once at construction. `None` only if the run row
    /// could not be read; the awaiting-input flag is then skipped (the approval
    /// flow itself is unaffected).
    task_id: Option<Uuid>,
    db: DBService,
    waiters: Mutex<HashMap<String, ApprovalWaiter>>,
}

impl ExecutorApprovalBridge {
    pub fn new(
        approvals: Approvals<MsgStore>,
        task_run_id: Uuid,
        task_id: Option<Uuid>,
        db: DBService,
    ) -> Arc<Self> {
        Arc::new(Self {
            approvals,
            task_run_id,
            task_id,
            db,
            waiters: Mutex::new(HashMap::new()),
        })
    }

    /// Mark (or clear) the owning task as waiting on a user answer. Best-effort:
    /// a DB hiccup here must not break the approval round-trip, so failures are
    /// logged and swallowed. The session-end cleanup in the container clears the
    /// flag unconditionally, so a missed clear here cannot strand the spinner.
    async fn set_awaiting_input(&self, awaiting: bool) {
        let Some(task_id) = self.task_id else {
            return;
        };
        if let Err(error) = TaskRecord::set_awaiting_input(self.db.pool(), task_id, awaiting).await
        {
            tracing::warn!(
                %task_id,
                awaiting,
                %error,
                "failed to update awaiting_input flag"
            );
        }
    }

    async fn create_internal(
        &self,
        tool_name: &str,
        tool_input: serde_json::Value,
    ) -> Result<String, ExecutorApprovalError> {
        let (request, waiter) = self
            .approvals
            .create_with_waiter(CreateApprovalRequest {
                task_run_id: self.task_run_id,
                tool_name: tool_name.to_string(),
                tool_input,
            })
            .await
            .map_err(ExecutorApprovalError::request_failed)?;

        self.waiters.lock().await.insert(request.id.clone(), waiter);
        Ok(request.id)
    }

    async fn wait_internal(
        &self,
        approval_id: &str,
        cancel: CancellationToken,
    ) -> Result<ApprovalResolvedData, ExecutorApprovalError> {
        let waiter = self
            .waiters
            .lock()
            .await
            .remove(approval_id)
            .ok_or_else(|| {
                ExecutorApprovalError::request_failed(format!(
                    "approval waiter not found: {}",
                    approval_id
                ))
            })?;

        tokio::select! {
            _ = cancel.cancelled() => Err(ExecutorApprovalError::Cancelled),
            resolved = waiter => resolved.map_err(|_| ExecutorApprovalError::request_failed("approval waiter dropped")),
        }
    }
}

#[async_trait::async_trait]
impl ExecutorApprovalService for ExecutorApprovalBridge {
    async fn create_tool_approval(&self, tool_name: &str) -> Result<String, ExecutorApprovalError> {
        self.create_internal(tool_name, serde_json::Value::Null)
            .await
    }

    async fn create_question_approval(
        &self,
        tool_name: &str,
        tool_input: serde_json::Value,
    ) -> Result<String, ExecutorApprovalError> {
        let approval_id = self.create_internal(tool_name, tool_input).await?;
        // The agent is now blocked until the user answers; surface that as a
        // "waiting" state instead of the running spinner.
        self.set_awaiting_input(true).await;
        Ok(approval_id)
    }

    async fn wait_tool_approval(
        &self,
        approval_id: &str,
        cancel: CancellationToken,
    ) -> Result<approvals::ApprovalStatus, ExecutorApprovalError> {
        let resolved = self.wait_internal(approval_id, cancel).await?;
        Ok(resolved.status)
    }

    async fn wait_question_answer(
        &self,
        approval_id: &str,
        cancel: CancellationToken,
    ) -> Result<QuestionStatus, ExecutorApprovalError> {
        // The wait is over regardless of outcome (answered, timed out, or
        // cancelled), so the task is no longer waiting on the user.
        let result = self.wait_internal(approval_id, cancel).await;
        self.set_awaiting_input(false).await;
        let resolved = result?;
        if let Some(answers) = resolved.answers {
            return Ok(QuestionStatus::Answered { answers });
        }
        match resolved.status {
            approvals::ApprovalStatus::TimedOut => Ok(QuestionStatus::TimedOut),
            _ => Err(ExecutorApprovalError::request_failed(
                "unexpected non-question approval response",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approvals::{ApprovalResponse, ApprovalStatus};
    use tokio::sync::RwLock;

    /// Insert a project + task + run so the bridge has a real task row to flag.
    /// Returns `(task_id, task_run_id)`.
    async fn seed_task(db: &DBService) -> (Uuid, Uuid) {
        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'proj', '/tmp', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(db.pool())
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_records (id, project_id, title, created_at, updated_at)
             VALUES (?, ?, 'task', datetime('now'), datetime('now'))",
        )
        .bind(task_id)
        .bind(project_id)
        .execute(db.pool())
        .await
        .unwrap();

        let run_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_runs (id, task_id, created_at, updated_at)
             VALUES (?, ?, datetime('now'), datetime('now'))",
        )
        .bind(run_id)
        .bind(task_id)
        .execute(db.pool())
        .await
        .unwrap();

        (task_id, run_id)
    }

    fn build_bridge(
        db: &DBService,
        task_run_id: Uuid,
        task_id: Uuid,
    ) -> (Arc<ExecutorApprovalBridge>, Approvals<MsgStore>) {
        let msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>> =
            Arc::new(RwLock::new(HashMap::new()));
        let approvals = Approvals::new(msg_stores);
        let bridge =
            ExecutorApprovalBridge::new(approvals.clone(), task_run_id, Some(task_id), db.clone());
        (bridge, approvals)
    }

    async fn awaiting_input(db: &DBService, task_id: Uuid) -> bool {
        TaskRecord::get(db.pool(), task_id)
            .await
            .unwrap()
            .awaiting_input
    }

    #[tokio::test]
    async fn plain_tool_approval_does_not_mark_awaiting_input() {
        let tmp = tempfile::tempdir().unwrap();
        let db = DBService::new_with_path(tmp.path().join("tool.db"))
            .await
            .unwrap();
        let (task_id, run_id) = seed_task(&db).await;
        let (bridge, _approvals) = build_bridge(&db, run_id, task_id);

        // Regular tool approvals (Bash, Edit, ...) block the agent too, but the
        // "waiting for you" indicator is reserved for AskUserQuestion, so the
        // flag must stay clear here.
        bridge.create_tool_approval("Bash").await.unwrap();

        assert!(!awaiting_input(&db, task_id).await);
    }

    #[tokio::test]
    async fn question_approval_sets_then_clears_awaiting_input() {
        let tmp = tempfile::tempdir().unwrap();
        let db = DBService::new_with_path(tmp.path().join("question.db"))
            .await
            .unwrap();
        let (task_id, run_id) = seed_task(&db).await;
        let (bridge, approvals) = build_bridge(&db, run_id, task_id);

        let approval_id = bridge
            .create_question_approval("AskUserQuestion", serde_json::json!({ "questions": [] }))
            .await
            .unwrap();
        assert!(
            awaiting_input(&db, task_id).await,
            "a pending question must mark the task as awaiting input"
        );

        // Resolving it (oneshot buffers, so responding before the wait is fine).
        let mut answers = HashMap::new();
        answers.insert("Which?".to_string(), "Option A".to_string());
        approvals
            .respond(
                &approval_id,
                ApprovalResponse {
                    status: ApprovalStatus::Approved,
                    answers: Some(answers),
                },
            )
            .await
            .unwrap();

        let status = bridge
            .wait_question_answer(&approval_id, CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(status, QuestionStatus::Answered { .. }));
        assert!(
            !awaiting_input(&db, task_id).await,
            "resolving the question must clear awaiting_input"
        );
    }
}
