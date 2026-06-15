use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

pub mod container;
pub mod execution;
pub mod perf;
pub mod tasks;
pub mod workspace;

use approvals::Approvals;
use async_trait::async_trait;
use chrono::Utc;
use config::Config;
use db::DBService;
use events::EventService;
use events::MsgStore;
use file_search_cache::FileSearchCache;
use filesystem::FilesystemService;
use futures::stream::BoxStream;
use git::GitService;
use image::ImageService;
use log_types::LogEntry;
use thiserror::Error;
use tokio::sync::RwLock;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;
use worktree::WorktreeManager;

pub use container::{ContainerError, ContainerService};
pub use execution::{ExecutionEvent, ExecutionStartParams};
pub use tasks::{
    ExecutionSessionStart, MergeOutcome, RebaseOutcome, SendTaskMessageParams,
    StartExecutionProcessParams, StartExecutionSessionParams, TaskMessageMode, TaskMessageStart,
    TaskRunBranchStatus, TaskRunTaskProject, TaskRunWithTask, TaskService,
};
pub use workspace::{canonicalize_path, ProjectFileService};

pub type ExecutionEventStream = BroadcastStream<ExecutionEvent>;

#[derive(Debug, Clone)]
pub struct RuntimeOptions {
    pub user_id: String,
    pub db_path: Option<PathBuf>,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            user_id: "local-user".to_string(),
            db_path: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Git(#[from] git::GitServiceError),
    #[error(transparent)]
    Worktree(#[from] worktree::WorktreeError),
    #[error(transparent)]
    Image(#[from] image::ImageError),
    #[error(transparent)]
    Filesystem(#[from] filesystem::FilesystemError),
    #[error(transparent)]
    Config(#[from] config::ConfigError),
    #[error(transparent)]
    Events(#[from] events::EventError),
    #[error(transparent)]
    FileSearch(#[from] file_search_cache::FileSearchError),
    #[error(transparent)]
    Skills(#[from] skills::SkillError),
    #[error(transparent)]
    Container(#[from] container::ContainerError),
    #[error("task run not found: {0}")]
    TaskRunNotFound(Uuid),
    #[error("bad request: {0}")]
    BadRequest(&'static str),
    #[error("not found: {0}")]
    NotFound(&'static str),
    #[error("unsupported operation: {0}")]
    Unsupported(&'static str),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type MsgStoreMap = Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>;

/// The most recent user prompt and assistant reply for a task, used by the
/// sidebar hover preview to show the last conversation turn. Either side is
/// `None` when that message type has not been produced yet.
#[derive(Debug, Default, Clone)]
pub struct LastExchange {
    pub user: Option<String>,
    pub assistant: Option<String>,
}

#[async_trait]
pub trait Runtime: Clone + Send + Sync + 'static {
    /// Bootstrap a runtime using provided options
    async fn bootstrap(options: RuntimeOptions) -> Result<Self, RuntimeError>
    where
        Self: Sized;

    fn user_id(&self) -> &str;

    fn config(&self) -> &Arc<RwLock<Config>>;

    fn db(&self) -> &DBService;

    fn git(&self) -> &GitService;

    fn worktree(&self) -> &WorktreeManager;

    fn image(&self) -> &ImageService;

    fn filesystem(&self) -> &FilesystemService;

    fn msg_stores(&self) -> &MsgStoreMap;

    fn events(&self) -> &EventService;

    fn approvals(&self) -> &Approvals<MsgStore>;

    fn file_search_cache(&self) -> &Arc<FileSearchCache>;

    fn container(&self) -> &(dyn ContainerService + Send + Sync);

    async fn stream_diff(
        &self,
        task_run_id: Uuid,
        stats_only: bool,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, RuntimeError> {
        self.container()
            .stream_diff(task_run_id, stats_only)
            .await
            .map_err(RuntimeError::from)
    }

    async fn search_repository(
        &self,
        repo_path: &Path,
        needle: &str,
        limit: usize,
    ) -> Result<Vec<PathBuf>, RuntimeError>;

    async fn start_execution(&self, params: ExecutionStartParams) -> Result<(), RuntimeError> {
        self.container()
            .start_execution(params)
            .await
            .map_err(RuntimeError::from)
    }

    async fn cancel_execution(&self, task_run_id: Uuid) -> Result<(), RuntimeError> {
        self.container()
            .cancel_execution(task_run_id)
            .await
            .map_err(RuntimeError::from)
    }

    async fn cleanup_task_run_artifacts(&self, task_run_id: Uuid) -> Result<(), RuntimeError> {
        self.container()
            .cleanup_task_run_artifacts(task_run_id)
            .await
            .map_err(RuntimeError::from)
    }

    async fn execution_event_stream(
        &self,
        task_run_id: Uuid,
    ) -> Result<ExecutionEventStream, RuntimeError> {
        self.container()
            .execution_event_stream(task_run_id)
            .await
            .map_err(RuntimeError::from)
    }

    /// Persist log entries for a task run
    async fn append_logs(
        &self,
        task_run_id: Uuid,
        entries: &[LogEntry],
    ) -> Result<(), RuntimeError>;

    /// Fetch entire log history for a task run
    async fn fetch_logs(&self, task_run_id: Uuid) -> Result<Vec<LogEntry>, RuntimeError>;

    /// Stream live log entries (stdout/stderr/json_patch) for a task run
    async fn stream_logs(
        &self,
        task_run_id: Uuid,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, RuntimeError>;

    /// Ensure running executions are reconciled on startup
    async fn cleanup_orphan_executions(&self) -> Result<(), RuntimeError> {
        self.container()
            .cleanup_orphan_executions()
            .await
            .map_err(RuntimeError::from)
    }

    /// Helper to ensure msg store exists for task run
    async fn msg_store_for_run(&self, task_run_id: Uuid) -> Result<Arc<MsgStore>, RuntimeError> {
        let mut map = self.msg_stores().write().await;
        if let Some(store) = map.get(&task_run_id) {
            return Ok(store.clone());
        }
        let store = Arc::new(MsgStore::new());
        map.insert(task_run_id, store.clone());
        Ok(store)
    }

    /// Render the Markdown transcript for an entire task (all runs combined,
    /// chronological order) and return the content. Used by the executor to
    /// inline past sessions into prompts and by the CLI to print transcripts.
    async fn task_transcript_markdown(&self, task_id: Uuid) -> Result<String, RuntimeError>;

    /// Return the most recent user prompt and assistant reply for a task, used
    /// by the sidebar to preview the last conversation turn on hover without
    /// opening the full conversation stream.
    async fn task_last_exchange(
        &self,
        task_id: Uuid,
    ) -> Result<LastExchange, RuntimeError>;

    fn touch_session(&self, session_id: &str) {
        let _ = session_id;
    }

    fn update_last_activity(&self, task_run_id: Uuid) {
        let timestamp = Utc::now();
        tracing::trace!(%task_run_id, %timestamp, "task run activity updated");
    }
}
