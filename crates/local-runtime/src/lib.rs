use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
};

use approvals::Approvals;
use async_trait::async_trait;
use config::{Config, ConfigService};
use db::types::RunStatus;
use db::DBService;
use events::MsgStore;
use events::{EventResources, EventService};
use executors::{ExecutorConfigs, StandardCodingAgentExecutor};
use file_search_cache::FileSearchCache;
use filesystem::FilesystemService;
use futures::stream::BoxStream;
use futures::{stream, StreamExt};
use git::GitService;
use image::ImageService;
use log_types::LogEntry;
use runtime::{container::ContainerService, MsgStoreMap, Runtime, RuntimeError, RuntimeOptions};
use tokio::sync::RwLock;
use tokio_stream::wrappers::BroadcastStream;
use tracing::info;
use uuid::Uuid;
use worktree::WorktreeManager;

mod container;
mod housekeeping;
pub(crate) mod log_writer;
mod transcript;
use container::LocalContainerService;
use housekeeping::spawn_housekeeping_tasks;

/// Event emitted when a file or directory in the workspace changes.
#[derive(Debug, Clone)]
pub struct WorkspaceFileEvent {
    pub event_type: WorkspaceFileEventType,
    pub relative_path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceFileEventType {
    Created,
    Modified,
    Deleted,
    Renamed,
}

const NORMALIZED_LOG_CACHE_CAPACITY: usize = 128;

#[derive(Default)]
struct NormalizedLogReplayCache {
    entries: HashMap<Uuid, Arc<Vec<LogEntry>>>,
    order: VecDeque<Uuid>,
}

impl NormalizedLogReplayCache {
    fn get(&self, task_run_id: &Uuid) -> Option<Arc<Vec<LogEntry>>> {
        self.entries.get(task_run_id).cloned()
    }

    fn insert(&mut self, task_run_id: Uuid, entries: Vec<LogEntry>) {
        if self.entries.contains_key(&task_run_id) {
            self.order.retain(|id| id != &task_run_id);
        }

        self.entries.insert(task_run_id, Arc::new(entries));
        self.order.push_back(task_run_id);

        while self.entries.len() > NORMALIZED_LOG_CACHE_CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn remove(&mut self, task_run_id: &Uuid) {
        if self.entries.remove(task_run_id).is_some() {
            self.order.retain(|id| id != task_run_id);
        }
    }
}

#[derive(Clone)]
pub struct LocalRuntime {
    user_id: String,
    db: DBService,
    git: GitService,
    worktree: WorktreeManager,
    image: ImageService,
    filesystem: FilesystemService,
    config: Arc<RwLock<Config>>,
    config_service: ConfigService,
    msg_stores: MsgStoreMap,
    events: EventService,
    approvals: Approvals<MsgStore>,
    file_search_cache: Arc<FileSearchCache>,
    normalized_log_cache: Arc<RwLock<NormalizedLogReplayCache>>,
    container: LocalContainerService,
    worktree_watchers: filesystem::WorktreeWatcherService,
}

impl LocalRuntime {
    fn resolve_config_path() -> PathBuf {
        if let Ok(custom_path) = std::env::var("CHRO_CONFIG_PATH") {
            let mut resolved = PathBuf::from(custom_path);
            if resolved.is_dir() {
                resolved.push("config.json");
            }
            return resolved;
        }

        if let Ok(custom_dir) = std::env::var("CHRO_CONFIG_DIR") {
            let mut base = PathBuf::from(custom_dir);
            base.push("config.json");
            return base;
        }

        let mut base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.push("chro");
        base.push("config.json");
        base
    }

    fn infer_executor_kind(executor_label: Option<&str>) -> Option<executors::BaseCodingAgent> {
        use std::borrow::Cow;

        let raw = executor_label?.trim();
        if raw.is_empty() {
            return None;
        }

        let label: Cow<'_, str> = if raw.starts_with('"') {
            match serde_json::from_str::<String>(raw) {
                Ok(decoded) => Cow::Owned(decoded),
                Err(_) => Cow::Borrowed(raw),
            }
        } else {
            Cow::Borrowed(raw)
        };

        let label = label.trim();
        if label.is_empty() {
            return None;
        }

        if label.starts_with('{') {
            if let Ok(profile) = serde_json::from_str::<executors::ExecutorProfileId>(label) {
                return Some(profile.executor);
            }
        }

        let base = label
            .split(':')
            .next()
            .unwrap_or(label)
            .replace('-', "_")
            .to_ascii_lowercase();

        match base.as_str() {
            "claude" | "claude_code" => Some(executors::BaseCodingAgent::ClaudeCode),
            "codex" => Some(executors::BaseCodingAgent::Codex),
            "pi" => Some(executors::BaseCodingAgent::Pi),
            _ => None,
        }
    }

    fn infer_executor_kind_from_logs(entries: &[LogEntry]) -> Option<executors::BaseCodingAgent> {
        let has_codex_marker = entries.iter().any(|entry| match entry {
            LogEntry::Stdout(line) => line.contains("codex/event"),
            _ => false,
        });

        has_codex_marker.then_some(executors::BaseCodingAgent::Codex)
    }
}

#[async_trait]
impl Runtime for LocalRuntime {
    async fn bootstrap(options: RuntimeOptions) -> Result<Self, RuntimeError> {
        let RuntimeOptions { user_id, db_path } = options;
        let event_resources = EventResources::new();

        let resolved_db_path = db_path.clone().unwrap_or_else(|| DBService::default_path());
        let logs_dir = resolved_db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("logs");

        let hook_service = if let Some(ref path) = db_path {
            DBService::new_with_path(path).await?
        } else {
            DBService::new().await?
        };
        let hook = EventService::create_hook(&event_resources, hook_service.clone());
        let db = if let Some(ref path) = db_path {
            DBService::new_with_path_and_hook(path, hook).await?
        } else {
            DBService::new_with_hook(hook).await?
        };

        let git = GitService::new();
        let worktree = WorktreeManager::new(None);
        let image = ImageService::new(db.pool().clone())?;
        let filesystem = FilesystemService::new();
        let config_path = Self::resolve_config_path();
        let config_service = ConfigService::new(config_path);
        let mut config = config_service.load()?;
        let mut config_dirty = false;
        let configs = ExecutorConfigs::get_cached();
        if let Ok(recommended) = configs.get_recommended_executor_profile().await {
            if config.executor_profile != recommended {
                info!(
                    executor = %recommended,
                    "applying recommended executor profile"
                );
                config.executor_profile = recommended;
                config_dirty = true;
            }
        }
        if config_dirty {
            config_service
                .save(config.clone())
                .map_err(RuntimeError::from)?;
        }
        let config = Arc::new(RwLock::new(config));
        let msg_stores = Arc::new(RwLock::new(HashMap::new()));
        let approvals = Approvals::new(msg_stores.clone());
        let file_search_cache = Arc::new(FileSearchCache::new());
        let normalized_log_cache = Arc::new(RwLock::new(NormalizedLogReplayCache::default()));
        let events = EventService::new(db.clone(), event_resources);
        events.hydrate().await?;
        let worktree_watchers = filesystem::WorktreeWatcherService::default();
        let container = LocalContainerService::new(
            db.clone(),
            git.clone(),
            msg_stores.clone(),
            config.clone(),
            approvals.clone(),
            logs_dir,
            worktree_watchers.clone(),
        );
        let runtime = Self {
            user_id,
            db,
            git,
            worktree,
            image,
            filesystem,
            config,
            config_service: config_service.clone(),
            msg_stores,
            events,
            approvals,
            file_search_cache,
            normalized_log_cache,
            container,
            worktree_watchers,
        };

        runtime.start_background_housekeeping();

        Ok(runtime)
    }

    fn user_id(&self) -> &str {
        &self.user_id
    }

    fn config(&self) -> &Arc<RwLock<Config>> {
        &self.config
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn worktree(&self) -> &WorktreeManager {
        &self.worktree
    }

    fn image(&self) -> &ImageService {
        &self.image
    }

    fn filesystem(&self) -> &FilesystemService {
        &self.filesystem
    }

    fn msg_stores(&self) -> &MsgStoreMap {
        &self.msg_stores
    }

    fn events(&self) -> &EventService {
        &self.events
    }

    fn approvals(&self) -> &Approvals<MsgStore> {
        &self.approvals
    }

    fn file_search_cache(&self) -> &Arc<FileSearchCache> {
        &self.file_search_cache
    }

    fn container(&self) -> &(dyn ContainerService + Send + Sync) {
        &self.container
    }

    async fn search_repository(
        &self,
        repo_path: &Path,
        needle: &str,
        limit: usize,
    ) -> Result<Vec<PathBuf>, RuntimeError> {
        use file_search_cache::{CacheError, SearchMode};

        match self
            .file_search_cache
            .search(repo_path, needle, SearchMode::TaskForm)
            .await
        {
            Ok(hits) => Ok(hits
                .into_iter()
                .map(|hit| PathBuf::from(hit.path))
                .collect()),
            Err(CacheError::Miss) => {
                let hits = self
                    .file_search_cache
                    .search_fallback(repo_path, needle, limit)?;
                Ok(hits
                    .into_iter()
                    .map(|hit| PathBuf::from(hit.path))
                    .collect())
            }
            Err(CacheError::BuildError(e)) => Err(RuntimeError::Other(anyhow::anyhow!(
                "Search cache build error: {}",
                e
            ))),
        }
    }

    async fn append_logs(
        &self,
        task_run_id: Uuid,
        entries: &[LogEntry],
    ) -> Result<(), RuntimeError> {
        self.container
            .append_logs(task_run_id, entries)
            .await
            .map_err(RuntimeError::from)?;

        // New logs invalidate any replay cache for this run.
        self.normalized_log_cache.write().await.remove(&task_run_id);
        Ok(())
    }

    async fn fetch_logs(&self, task_run_id: Uuid) -> Result<Vec<LogEntry>, RuntimeError> {
        self.container
            .fetch_logs(task_run_id)
            .await
            .map_err(RuntimeError::from)
    }

    async fn cleanup_task_run_artifacts(&self, task_run_id: Uuid) -> Result<(), RuntimeError> {
        self.container
            .cleanup_task_run_artifacts(task_run_id)
            .await
            .map_err(RuntimeError::from)?;
        self.normalized_log_cache.write().await.remove(&task_run_id);
        Ok(())
    }

    async fn stream_logs(
        &self,
        task_run_id: Uuid,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, RuntimeError> {
        let store = {
            let map = self.msg_stores.read().await;
            map.get(&task_run_id).cloned()
        };

        if let Some(store) = store {
            return Ok(store
                .history_plus_stream()
                .filter(|entry| {
                    futures::future::ready(matches!(
                        entry,
                        LogEntry::JsonPatch(_) | LogEntry::Finished
                    ))
                })
                .map(|entry| Ok(entry))
                .boxed());
        }

        let run = db::models::TaskRun::find_by_id(self.db.pool(), task_run_id)
            .await
            .ok()
            .flatten();
        let is_run_cacheable = run
            .as_ref()
            .map(|task_run| {
                matches!(
                    task_run.status,
                    RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled
                )
            })
            .unwrap_or(false);

        if is_run_cacheable {
            if let Some(cached_entries) = self.normalized_log_cache.read().await.get(&task_run_id) {
                let cached_entries = cached_entries.as_ref().clone();
                return Ok(stream::iter(cached_entries.into_iter().map(Ok)).boxed());
            }
        }

        let raw_entries = self.container.fetch_logs(task_run_id).await?;
        if raw_entries.is_empty() {
            return Ok(stream::empty().boxed());
        }

        let executor_kind_from_logs = Self::infer_executor_kind_from_logs(&raw_entries);

        let worktree_path = run
            .as_ref()
            .and_then(|task_run| task_run.workspace_path.clone())
            .unwrap_or_else(|| ".".to_string());
        let executor_profile_id_from_label = run
            .as_ref()
            .and_then(|task_run| task_run.executor_label.as_deref())
            .and_then(|label| serde_json::from_str::<executors::ExecutorProfileId>(label).ok());
        let executor_label = run
            .as_ref()
            .and_then(|task_run| task_run.executor_label.as_deref());

        let mut executor_kind = executor_profile_id_from_label
            .as_ref()
            .map(|profile| profile.executor)
            .or_else(|| Self::infer_executor_kind(executor_label))
            .unwrap_or(executors::BaseCodingAgent::ClaudeCode);

        if matches!(
            executor_kind_from_logs,
            Some(executors::BaseCodingAgent::Codex)
        ) {
            executor_kind = executors::BaseCodingAgent::Codex;
        }

        let executor_profile_id = executor_profile_id_from_label
            .filter(|profile| profile.executor == executor_kind)
            .unwrap_or_else(|| executors::ExecutorProfileId::new(executor_kind));
        let executor =
            ExecutorConfigs::get_cached().get_coding_agent_or_default(&executor_profile_id);

        // Use synchronous replay to avoid race condition between async normalize
        // task and the stream consumer. The previous approach spawned an async
        // normalize task that raced with push_finished(), causing the normalizer
        // to terminate before producing JsonPatch entries.
        let mut normalized = executor.replay_log_entries(&raw_entries, Path::new(&worktree_path));
        if !normalized
            .last()
            .is_some_and(|e| matches!(e, LogEntry::Finished))
        {
            normalized.push(LogEntry::Finished);
        }

        let entries = normalized
            .into_iter()
            .filter(|entry| matches!(entry, LogEntry::JsonPatch(_) | LogEntry::Finished))
            .collect::<Vec<_>>();

        if is_run_cacheable {
            self.normalized_log_cache
                .write()
                .await
                .insert(task_run_id, entries.clone());
        }

        Ok(stream::iter(entries.into_iter().map(Ok)).boxed())
    }

    async fn task_transcript_markdown(&self, task_id: Uuid) -> Result<String, RuntimeError> {
        self.task_transcript_markdown(task_id).await
    }

    async fn task_last_exchange(
        &self,
        task_id: Uuid,
    ) -> Result<runtime::LastExchange, RuntimeError> {
        self.task_last_exchange(task_id).await
    }
}

impl LocalRuntime {
    fn start_background_housekeeping(&self) {
        spawn_housekeeping_tasks(self.clone());
    }
}

impl LocalRuntime {
    pub async fn append_stdout(
        &self,
        task_run_id: Uuid,
        message: impl AsRef<str>,
    ) -> Result<(), RuntimeError> {
        self.container
            .append_stdout(task_run_id, message)
            .await
            .map_err(RuntimeError::from)?;
        self.normalized_log_cache.write().await.remove(&task_run_id);
        Ok(())
    }

    pub async fn update_config<F>(&self, mutator: F) -> Result<Config, RuntimeError>
    where
        F: FnOnce(&mut Config),
    {
        let mut guard = self.config.write().await;
        mutator(&mut guard);
        let snapshot = guard.clone();
        self.config_service
            .save(snapshot.clone())
            .map_err(RuntimeError::from)?;
        Ok(snapshot)
    }

    pub async fn current_config(&self) -> Config {
        self.config.read().await.clone()
    }

    /// Subscribe to workspace file change events, mapped into the workspace-tree
    /// shape (dotfiles hidden). Backed by the shared per-worktree watcher.
    pub fn subscribe_workspace_file_events(
        &self,
        workspace_path: PathBuf,
    ) -> BoxStream<'static, WorkspaceFileEvent> {
        let receiver = self.worktree_watchers.subscribe(workspace_path);
        BroadcastStream::new(receiver)
            .flat_map(|result| {
                let events = match result {
                    Ok(batch) => batch
                        .iter()
                        .filter_map(convert_worktree_event)
                        .collect::<Vec<_>>(),
                    // Lagged: drop this gap; the next change refreshes the tree.
                    Err(_) => Vec::new(),
                };
                stream::iter(events)
            })
            .boxed()
    }
}

fn convert_worktree_event(event: &filesystem::WorktreeEvent) -> Option<WorkspaceFileEvent> {
    use filesystem::WorktreeEventKind;

    // Hide dotfiles and dot-directories from the workspace tree.
    if event.relative_path.starts_with('.') || event.relative_path.contains("/.") {
        return None;
    }

    let event_type = match event.kind {
        WorktreeEventKind::Created => WorkspaceFileEventType::Created,
        WorktreeEventKind::Modified => WorkspaceFileEventType::Modified,
        WorktreeEventKind::Deleted => WorkspaceFileEventType::Deleted,
    };

    Some(WorkspaceFileEvent {
        event_type,
        relative_path: event.relative_path.clone(),
        is_directory: event.is_dir,
    })
}
