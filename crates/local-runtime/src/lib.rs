use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
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
use tokio::{
    sync::{broadcast, RwLock},
    task::JoinHandle,
};
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
const WORKSPACE_FILE_EVENT_CHANNEL_CAPACITY: usize = 256;
const WORKSPACE_WATCHER_IDLE_POLL_INTERVAL: Duration = Duration::from_secs(1);

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

struct WorkspaceWatcherEntry {
    sender: broadcast::Sender<WorkspaceFileEvent>,
    task: JoinHandle<()>,
    watcher_id: u64,
}

#[derive(Clone, Default)]
struct WorkspaceWatcherService {
    watchers: Arc<Mutex<HashMap<PathBuf, WorkspaceWatcherEntry>>>,
    next_watcher_id: Arc<AtomicU64>,
}

impl WorkspaceWatcherService {
    fn subscribe(
        &self,
        workspace_path: PathBuf,
    ) -> Result<broadcast::Receiver<WorkspaceFileEvent>, RuntimeError> {
        let workspace_path = canonicalize_workspace_path(&workspace_path);

        if let Some(receiver) = self.subscribe_existing(&workspace_path) {
            return Ok(receiver);
        }

        let components = filesystem::watch_directory(workspace_path.clone()).map_err(|err| {
            RuntimeError::Other(anyhow::anyhow!(
                "failed to start workspace watcher for {}: {err}",
                workspace_path.display()
            ))
        })?;

        let mut watchers = self.watchers.lock().unwrap();
        self.remove_stale_locked(&mut watchers, &workspace_path);

        if let Some(existing) = watchers.get(&workspace_path) {
            return Ok(existing.sender.subscribe());
        }

        let (sender, _) = broadcast::channel(WORKSPACE_FILE_EVENT_CHANNEL_CAPACITY);
        let receiver = sender.subscribe();
        let watcher_id = self.next_watcher_id.fetch_add(1, Ordering::Relaxed) + 1;
        let task = self.spawn_task(
            workspace_path.clone(),
            watcher_id,
            sender.clone(),
            components,
        );

        watchers.insert(
            workspace_path,
            WorkspaceWatcherEntry {
                sender,
                task,
                watcher_id,
            },
        );

        Ok(receiver)
    }

    fn subscribe_existing(
        &self,
        workspace_path: &Path,
    ) -> Option<broadcast::Receiver<WorkspaceFileEvent>> {
        let mut watchers = self.watchers.lock().unwrap();
        self.remove_stale_locked(&mut watchers, workspace_path);
        watchers
            .get(workspace_path)
            .map(|entry| entry.sender.subscribe())
    }

    fn remove_if_matching(&self, workspace_path: &Path, watcher_id: u64) {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers
            .get(workspace_path)
            .is_some_and(|entry| entry.watcher_id == watcher_id)
        {
            watchers.remove(workspace_path);
        }
    }

    fn remove_if_idle(&self, workspace_path: &Path, watcher_id: u64) -> bool {
        let mut watchers = self.watchers.lock().unwrap();
        let should_remove = watchers.get(workspace_path).is_some_and(|entry| {
            entry.watcher_id == watcher_id && entry.sender.receiver_count() == 0
        });

        if should_remove {
            watchers.remove(workspace_path);
        }

        should_remove
    }

    fn remove_stale_locked(
        &self,
        watchers: &mut HashMap<PathBuf, WorkspaceWatcherEntry>,
        workspace_path: &Path,
    ) {
        let should_remove = watchers
            .get(workspace_path)
            .is_some_and(|entry| entry.task.is_finished());
        if should_remove {
            watchers.remove(workspace_path);
        }
    }

    fn spawn_task(
        &self,
        workspace_path: PathBuf,
        watcher_id: u64,
        sender: broadcast::Sender<WorkspaceFileEvent>,
        components: filesystem::WatcherComponents,
    ) -> JoinHandle<()> {
        use futures::StreamExt;

        let this = self.clone();

        tokio::spawn(async move {
            let (watcher, mut rx, canonical_root) = components;
            let _watcher = watcher;
            let mut idle_check = tokio::time::interval(WORKSPACE_WATCHER_IDLE_POLL_INTERVAL);
            idle_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    result = rx.next() => {
                        let Some(result) = result else {
                            break;
                        };

                        let events = match result {
                            Ok(evts) => evts,
                            Err(errs) => {
                                tracing::warn!(?errs, workspace = %workspace_path.display(), "workspace watcher errors");
                                continue;
                            }
                        };

                        for event in events {
                            if let Some(file_event) = convert_debounced_event(&event, &canonical_root) {
                                let _ = sender.send(file_event);
                            }
                        }
                    }
                    _ = idle_check.tick() => {
                        if this.remove_if_idle(&workspace_path, watcher_id) {
                            break;
                        }
                    }
                }
            }

            this.remove_if_matching(&workspace_path, watcher_id);
        })
    }

    #[cfg(test)]
    fn watcher_count(&self) -> usize {
        self.watchers.lock().unwrap().len()
    }
}

fn canonicalize_workspace_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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
    workspace_watchers: WorkspaceWatcherService,
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
        let container = LocalContainerService::new(
            db.clone(),
            git.clone(),
            msg_stores.clone(),
            config.clone(),
            approvals.clone(),
            logs_dir,
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
            workspace_watchers: WorkspaceWatcherService::default(),
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

    async fn generate_task_transcript(
        &self,
        task_id: Uuid,
        workspace_path: &Path,
    ) -> Result<String, RuntimeError> {
        self.generate_task_transcript(task_id, workspace_path).await
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

    /// Subscribe to workspace file change events.
    pub fn subscribe_workspace_file_events(
        &self,
        workspace_path: PathBuf,
    ) -> Result<broadcast::Receiver<WorkspaceFileEvent>, RuntimeError> {
        self.workspace_watchers.subscribe(workspace_path)
    }
}

fn convert_debounced_event(
    event: &filesystem::DebouncedEvent,
    canonical_root: &Path,
) -> Option<WorkspaceFileEvent> {
    use notify_debouncer_full::notify::EventKind;

    let path = event.paths.first()?;
    let relative_path = path
        .strip_prefix(canonical_root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");

    if relative_path.starts_with('.') || relative_path.contains("/.") {
        return None;
    }

    let is_directory = path.is_dir();

    let event_type = match &event.kind {
        EventKind::Create(_) => WorkspaceFileEventType::Created,
        EventKind::Modify(_) => WorkspaceFileEventType::Modified,
        EventKind::Remove(_) => WorkspaceFileEventType::Deleted,
        EventKind::Any => return None,
        EventKind::Access(_) => return None,
        EventKind::Other => return None,
    };

    Some(WorkspaceFileEvent {
        event_type,
        relative_path,
        is_directory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::time::{sleep, timeout, Duration, Instant};

    async fn wait_for_watcher_count(service: &WorkspaceWatcherService, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(3);

        loop {
            if service.watcher_count() == expected {
                return;
            }

            assert!(
                Instant::now() < deadline,
                "timed out waiting for watcher count {expected}, actual {}",
                service.watcher_count()
            );

            sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn workspace_watchers_are_reused_and_cleaned_up() {
        let service = WorkspaceWatcherService::default();
        let dir = tempdir().unwrap();

        let rx1 = service.subscribe(dir.path().to_path_buf()).unwrap();
        let rx2 = service.subscribe(dir.path().to_path_buf()).unwrap();

        wait_for_watcher_count(&service, 1).await;

        drop(rx1);
        drop(rx2);

        wait_for_watcher_count(&service, 0).await;
    }

    #[tokio::test]
    async fn workspace_watchers_only_emit_events_for_their_workspace() {
        let service = WorkspaceWatcherService::default();
        let dir1 = tempdir().unwrap();
        let dir2 = tempdir().unwrap();

        let mut rx1 = service.subscribe(dir1.path().to_path_buf()).unwrap();
        let mut rx2 = service.subscribe(dir2.path().to_path_buf()).unwrap();

        wait_for_watcher_count(&service, 2).await;
        sleep(Duration::from_millis(100)).await;

        std::fs::write(dir1.path().join("alpha.txt"), "hello").unwrap();

        let event = timeout(Duration::from_secs(3), rx1.recv())
            .await
            .expect("workspace 1 should receive a file event")
            .expect("workspace 1 receiver should stay open");
        assert_eq!(event.relative_path, "alpha.txt");
        assert!(matches!(
            event.event_type,
            WorkspaceFileEventType::Created | WorkspaceFileEventType::Modified
        ));

        assert!(
            timeout(Duration::from_millis(300), rx2.recv())
                .await
                .is_err(),
            "workspace 2 unexpectedly received an event from workspace 1"
        );

        drop(rx1);
        drop(rx2);

        wait_for_watcher_count(&service, 0).await;
    }
}
