use std::{
    collections::{HashMap, HashSet, VecDeque},
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

const NORMALIZED_LOG_CACHE_CAPACITY: usize = 32;
const NORMALIZED_LOG_CACHE_BYTES: usize = 32 * 1024 * 1024;

struct CachedNormalizedLog {
    entries: Arc<Vec<LogEntry>>,
    bytes: usize,
}

#[derive(Default)]
struct NormalizedLogReplayCache {
    entries: HashMap<Uuid, CachedNormalizedLog>,
    order: VecDeque<Uuid>,
    total_bytes: usize,
}

impl NormalizedLogReplayCache {
    fn get(&self, task_run_id: &Uuid) -> Option<Arc<Vec<LogEntry>>> {
        self.entries
            .get(task_run_id)
            .map(|cached| cached.entries.clone())
    }

    fn insert(&mut self, task_run_id: Uuid, entries: Vec<LogEntry>) {
        let bytes = entries.iter().fold(0usize, |total, entry| {
            total.saturating_add(entry.approx_bytes())
        });
        if let Some(previous) = self.entries.remove(&task_run_id) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.bytes);
            self.order.retain(|id| id != &task_run_id);
        }

        if bytes > NORMALIZED_LOG_CACHE_BYTES {
            return;
        }

        self.entries.insert(
            task_run_id,
            CachedNormalizedLog {
                entries: Arc::new(entries),
                bytes,
            },
        );
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.order.push_back(task_run_id);

        while self.entries.len() > NORMALIZED_LOG_CACHE_CAPACITY
            || self.total_bytes > NORMALIZED_LOG_CACHE_BYTES
        {
            if let Some(oldest) = self.order.pop_front() {
                if let Some(removed) = self.entries.remove(&oldest) {
                    self.total_bytes = self.total_bytes.saturating_sub(removed.bytes);
                }
            } else {
                break;
            }
        }
    }

    fn remove(&mut self, task_run_id: &Uuid) {
        if let Some(removed) = self.entries.remove(task_run_id) {
            self.total_bytes = self.total_bytes.saturating_sub(removed.bytes);
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
    git_state_watchers: filesystem::GitStateWatcherService,
    /// Repos whose search cache is already invalidated by a git-state
    /// subscription; guards against spawning duplicate listeners.
    search_cache_watches: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
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
        let git_state_watchers = filesystem::GitStateWatcherService::default();
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
            git_state_watchers,
            search_cache_watches: Arc::new(std::sync::Mutex::new(HashSet::new())),
        };

        runtime.start_background_housekeeping();

        // Close the delegation loop from the broker's completion moment: when
        // a run finishes (after its auto-commit), the delegating session gets
        // its handoff edge and wake. Wired here because the container cannot
        // depend on the runtime it lives in.
        {
            let hook_runtime = runtime.clone();
            runtime
                .container
                .set_run_finished_hook(Arc::new(move |run_id| {
                    let hook_runtime = hook_runtime.clone();
                    tokio::spawn(async move {
                        if let Err(err) = runtime::TaskService::new(&hook_runtime)
                            .settle_delegation_handoff(run_id)
                            .await
                        {
                            tracing::warn!(
                                %run_id,
                                error = %err,
                                "delegation handoff settlement failed"
                            );
                        }
                    });
                }))
                .await;
        }

        // Early-wake half of the same loop: when a delegated child suspends on
        // an approval, rouse the delegating session so it can respond. Without
        // this the gated child never completes and the barrier above never
        // fires.
        {
            let hook_runtime = runtime.clone();
            runtime
                .container
                .set_approval_pending_hook(Arc::new(move |run_id, approval_id, tool_name| {
                    let hook_runtime = hook_runtime.clone();
                    tokio::spawn(async move {
                        if let Err(err) = runtime::TaskService::new(&hook_runtime)
                            .notify_delegation_approval_pending(run_id, approval_id, tool_name)
                            .await
                        {
                            tracing::warn!(
                                %run_id,
                                error = %err,
                                "delegation approval-pending wake failed"
                            );
                        }
                    });
                }))
                .await;
        }

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

    fn ensure_search_cache_watch(&self, repo_path: &Path) {
        self.ensure_search_cache_watch_inner(repo_path);
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
        let options = file_search_cache::SearchOptions::new(limit);
        self.ensure_search_cache_watch_inner(repo_path);
        let hits = self
            .file_search_cache
            .search(repo_path, needle, options)
            .await;
        Ok(hits
            .into_iter()
            .map(|hit| PathBuf::from(hit.path))
            .collect())
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
                let len = cached_entries.len();
                return Ok(stream::iter(0..len)
                    .map(move |index| Ok(cached_entries[index].clone()))
                    .boxed());
            }
        }

        let raw_entries = self.container.fetch_logs(task_run_id).await?;
        if raw_entries.is_empty() {
            // Authoritative "no replayable history": end the replay with the
            // protocol's `finished` marker instead of a bare close, so clients
            // can distinguish a genuinely empty run from a stream that died.
            return Ok(stream::iter([Ok(LogEntry::Finished)]).boxed());
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
        //
        // Normalization is CPU-bound and proportional to the log size (up to
        // MAX_RUN_LOG_BYTES), so it runs on the blocking pool: on the async
        // workers, concurrent replays starved live log streams and each other,
        // delaying a replay's first byte by tens of seconds under load.
        let entries = tokio::task::spawn_blocking(move || {
            let mut normalized =
                executor.replay_log_entries(&raw_entries, Path::new(&worktree_path));
            if !normalized
                .last()
                .is_some_and(|e| matches!(e, LogEntry::Finished))
            {
                normalized.push(LogEntry::Finished);
            }

            normalized
                .into_iter()
                .filter(|entry| matches!(entry, LogEntry::JsonPatch(_) | LogEntry::Finished))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|join_error| RuntimeError::Io(std::io::Error::other(join_error)))?;

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

    async fn task_session_exchange(
        &self,
        task_id: Uuid,
        session_id: Uuid,
    ) -> Result<Option<runtime::LastExchange>, RuntimeError> {
        self.task_session_exchange(task_id, session_id).await
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

    /// Raw worktree file change batches (dotfiles included), backed by the
    /// shared per-worktree watcher. Used by notification streams whose
    /// consumers care about dotfile paths too (e.g. `.claude/**` datasets).
    pub fn subscribe_worktree_changes(
        &self,
        worktree_path: PathBuf,
    ) -> tokio::sync::broadcast::Receiver<filesystem::WorktreeEventBatch> {
        self.worktree_watchers.subscribe(worktree_path)
    }

    /// Git metadata state events for the worktree, or `None` when it is not a
    /// git repository. Resolves the git dir with blocking filesystem reads;
    /// call from a blocking-safe context.
    pub fn subscribe_git_state(
        &self,
        worktree_path: &Path,
    ) -> Option<filesystem::GitStateSubscription> {
        self.git_state_watchers.subscribe(worktree_path)
    }

    /// The shared git metadata watcher registry.
    pub fn git_state_watchers(&self) -> &filesystem::GitStateWatcherService {
        &self.git_state_watchers
    }

    /// Keep `repo_path`'s file-search index fresh. On the first call per repo,
    /// spawn two listeners:
    /// - a git-state listener that refreshes the git-history ranking whenever
    ///   HEAD moves (branch switch, commit); the files a switch changes reach
    ///   the index through the worktree listener, so this never walks, and
    /// - a worktree file listener that queues a rebuild when uncommitted
    ///   creates/deletes/renames (or `.gitignore` edits) change the set of
    ///   file names, so a file an agent just wrote is searchable immediately
    ///   instead of after the next commit or cache TTL.
    ///
    /// Exposed on the `Runtime` trait as `ensure_search_cache_watch`; this is
    /// the inherent implementation so internal callers skip dynamic dispatch.
    fn ensure_search_cache_watch_inner(&self, repo_path: &Path) {
        {
            let mut watched = self.search_cache_watches.lock().unwrap();
            if !watched.insert(repo_path.to_path_buf()) {
                return;
            }
        }

        use tokio::sync::broadcast::error::RecvError;

        let cache = self.file_search_cache.clone();
        let watchers = self.git_state_watchers.clone();
        let repo = repo_path.to_path_buf();
        tokio::spawn(async move {
            // Git dir resolution reads the filesystem; keep it off the workers.
            let subscription = tokio::task::spawn_blocking({
                let repo = repo.clone();
                move || watchers.subscribe(&repo)
            })
            .await
            .ok()
            .flatten();
            let Some(mut subscription) = subscription else {
                return;
            };

            loop {
                match subscription.receiver.recv().await {
                    Ok(batch) => {
                        if subscription
                            .relevant_kinds(&batch)
                            .contains(&filesystem::GitStateEventKind::HeadMoved)
                        {
                            cache.invalidate_history(&repo);
                        }
                    }
                    // Events were dropped; assume HEAD may have moved.
                    Err(RecvError::Lagged(_)) => cache.invalidate(&repo),
                    Err(RecvError::Closed) => break,
                }
            }
        });

        let cache = self.file_search_cache.clone();
        let worktree_watchers = self.worktree_watchers.clone();
        let repo = repo_path.to_path_buf();
        tokio::spawn(async move {
            let mut receiver = worktree_watchers.subscribe(repo.clone());
            loop {
                match receiver.recv().await {
                    Ok(batch) => {
                        let changes: Vec<file_search_cache::WorktreeChange> = batch
                            .iter()
                            .map(|event| file_search_cache::WorktreeChange {
                                kind: match event.kind {
                                    filesystem::WorktreeEventKind::Created => {
                                        file_search_cache::WorktreeChangeKind::Created
                                    }
                                    filesystem::WorktreeEventKind::Modified => {
                                        file_search_cache::WorktreeChangeKind::Modified
                                    }
                                    filesystem::WorktreeEventKind::Deleted => {
                                        file_search_cache::WorktreeChangeKind::Deleted
                                    }
                                },
                                relative_path: event.relative_path.clone(),
                            })
                            .collect();
                        cache.note_worktree_changes(&repo, &changes);
                    }
                    // Events were dropped; the index may be stale either way.
                    Err(RecvError::Lagged(_)) => cache.invalidate(&repo),
                    Err(RecvError::Closed) => break,
                }
            }
        });
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

    if event.relative_path.is_empty() {
        return None;
    }

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

#[cfg(test)]
mod load_guard_tests {
    use super::*;

    #[test]
    fn normalized_log_cache_evicts_oldest_run_by_count() {
        let mut cache = NormalizedLogReplayCache::default();
        let ids: Vec<_> = (0..=NORMALIZED_LOG_CACHE_CAPACITY)
            .map(|_| Uuid::new_v4())
            .collect();
        for id in &ids {
            cache.insert(*id, vec![LogEntry::Finished]);
        }

        assert!(cache.get(&ids[0]).is_none());
        assert!(cache.get(ids.last().unwrap()).is_some());
        assert_eq!(cache.entries.len(), NORMALIZED_LOG_CACHE_CAPACITY);
        assert!(cache.total_bytes <= NORMALIZED_LOG_CACHE_BYTES);
    }

    #[test]
    fn normalized_log_cache_rejects_single_oversized_run() {
        let mut cache = NormalizedLogReplayCache::default();
        let id = Uuid::new_v4();
        cache.insert(
            id,
            vec![LogEntry::Stdout("x".repeat(NORMALIZED_LOG_CACHE_BYTES))],
        );

        assert!(cache.get(&id).is_none());
        assert_eq!(cache.total_bytes, 0);
    }

    #[test]
    fn watcher_resync_marker_is_not_exposed_as_a_file() {
        let marker = filesystem::WorktreeEvent {
            kind: filesystem::WorktreeEventKind::Modified,
            relative_path: String::new(),
            is_dir: true,
        };
        assert!(convert_worktree_event(&marker).is_none());
    }
}
