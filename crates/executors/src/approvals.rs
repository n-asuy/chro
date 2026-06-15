use std::fmt;

use approvals::ApprovalStatus;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

/// Errors emitted by executor approval services.
#[derive(Debug, Error)]
pub enum ExecutorApprovalError {
    #[error("executor approval session not registered")]
    SessionNotRegistered,
    #[error("executor approval request failed: {0}")]
    RequestFailed(String),
    #[error("executor approval service unavailable")]
    ServiceUnavailable,
    #[error("executor approval request cancelled")]
    Cancelled,
}

impl ExecutorApprovalError {
    pub fn request_failed<E: fmt::Display>(err: E) -> Self {
        Self::RequestFailed(err.to_string())
    }
}

/// Abstraction for executor approval backends.
#[async_trait]
pub trait ExecutorApprovalService: Send + Sync {
    /// Creates a tool approval request and returns its approval_id.
    async fn create_tool_approval(&self, tool_name: &str) -> Result<String, ExecutorApprovalError>;

    /// Creates a question approval request and returns its approval_id.
    /// `tool_input` is the raw AskUserQuestion input (`{ questions: [...] }`)
    /// so the frontend can render the question flow from the approval record.
    async fn create_question_approval(
        &self,
        tool_name: &str,
        tool_input: serde_json::Value,
    ) -> Result<String, ExecutorApprovalError>;

    /// Waits for a tool approval resolution.
    async fn wait_tool_approval(
        &self,
        approval_id: &str,
        cancel: CancellationToken,
    ) -> Result<ApprovalStatus, ExecutorApprovalError>;

    /// Waits for question answers.
    async fn wait_question_answer(
        &self,
        approval_id: &str,
        cancel: CancellationToken,
    ) -> Result<QuestionStatus, ExecutorApprovalError>;
}

#[derive(Debug, Default)]
pub struct NoopExecutorApprovalService;

#[async_trait]
impl ExecutorApprovalService for NoopExecutorApprovalService {
    async fn create_tool_approval(
        &self,
        _tool_name: &str,
    ) -> Result<String, ExecutorApprovalError> {
        Ok("noop".to_string())
    }

    async fn create_question_approval(
        &self,
        _tool_name: &str,
        _tool_input: serde_json::Value,
    ) -> Result<String, ExecutorApprovalError> {
        Ok("noop".to_string())
    }

    async fn wait_tool_approval(
        &self,
        _approval_id: &str,
        _cancel: CancellationToken,
    ) -> Result<ApprovalStatus, ExecutorApprovalError> {
        Ok(ApprovalStatus::Approved)
    }

    async fn wait_question_answer(
        &self,
        _approval_id: &str,
        _cancel: CancellationToken,
    ) -> Result<QuestionStatus, ExecutorApprovalError> {
        Err(ExecutorApprovalError::ServiceUnavailable)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum QuestionStatus {
    Answered {
        answers: std::collections::HashMap<String, String>,
    },
    TimedOut,
}
