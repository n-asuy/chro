use crate::{ExecutionEventStream, ExecutionStartParams};
use async_trait::async_trait;
use diff_stream::DiffStreamError;
use futures::stream::BoxStream;
use log_types::LogEntry;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ContainerError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Git(#[from] git::GitServiceError),
    #[error(transparent)]
    Worktree(#[from] worktree::WorktreeError),
    #[error("task run not found: {0}")]
    TaskRunNotFound(Uuid),
    #[error("execution already running for task run {0}")]
    ExecutionAlreadyRunning(Uuid),
    #[error("execution not running for task run {0}")]
    ExecutionNotRunning(Uuid),
    #[error("bad request: {0}")]
    BadRequest(&'static str),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Diff(#[from] DiffStreamError),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

#[async_trait]
pub trait ContainerService: Send + Sync {
    async fn start_execution(&self, params: ExecutionStartParams) -> Result<(), ContainerError>;

    async fn cancel_execution(&self, task_run_id: Uuid) -> Result<(), ContainerError>;

    async fn cleanup_task_run_artifacts(&self, task_run_id: Uuid) -> Result<(), ContainerError>;

    async fn execution_event_stream(
        &self,
        task_run_id: Uuid,
    ) -> Result<ExecutionEventStream, ContainerError>;

    async fn cleanup_orphan_executions(&self) -> Result<(), ContainerError>;

    async fn stream_diff(
        &self,
        task_run_id: Uuid,
        stats_only: bool,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, ContainerError>;
}
