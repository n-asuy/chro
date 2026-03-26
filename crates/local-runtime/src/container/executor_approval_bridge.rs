use std::{collections::HashMap, sync::Arc};

use approvals::{ApprovalResolvedData, ApprovalWaiter, Approvals, CreateApprovalRequest};
use events::MsgStore;
use executors::{ExecutorApprovalError, ExecutorApprovalService, QuestionStatus};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Bridges runtime approval storage with the executor approval interface.
pub struct ExecutorApprovalBridge {
    approvals: Approvals<MsgStore>,
    task_run_id: Uuid,
    waiters: Mutex<HashMap<String, ApprovalWaiter>>,
}

impl ExecutorApprovalBridge {
    pub fn new(approvals: Approvals<MsgStore>, task_run_id: Uuid) -> Arc<Self> {
        Arc::new(Self {
            approvals,
            task_run_id,
            waiters: Mutex::new(HashMap::new()),
        })
    }

    async fn create_internal(&self, tool_name: &str) -> Result<String, ExecutorApprovalError> {
        let (request, waiter) = self
            .approvals
            .create_with_waiter(CreateApprovalRequest {
                task_run_id: self.task_run_id,
                tool_name: tool_name.to_string(),
                tool_input: serde_json::Value::Null,
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
        self.create_internal(tool_name).await
    }

    async fn create_question_approval(
        &self,
        tool_name: &str,
        _question_count: usize,
    ) -> Result<String, ExecutorApprovalError> {
        self.create_internal(tool_name).await
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
        let resolved = self.wait_internal(approval_id, cancel).await?;
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
