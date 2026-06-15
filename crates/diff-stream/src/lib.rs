pub use log_types::{
    compute_line_change_counts, create_unified_diff, create_unified_diff_hunk, Diff, DiffChangeKind,
};

use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use filesystem::WorktreeEventBatch;
use futures::StreamExt;
use git::{CommitId, DiffTarget, GitService, GitServiceError};
use log_types::LogEntry;
use thiserror::Error;
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};
use tokio_stream::wrappers::{BroadcastStream, ReceiverStream};

const MAX_CUMULATIVE_DIFF_BYTES: usize = 200 * 1024 * 1024;
const DIFF_STREAM_CHANNEL_CAPACITY: usize = 1024;

#[derive(Debug, Error)]
pub enum DiffStreamError {
    #[error(transparent)]
    Git(#[from] GitServiceError),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
}

pub struct DiffStreamHandle {
    stream: futures::stream::BoxStream<'static, Result<LogEntry, io::Error>>,
    watcher_task: Option<JoinHandle<()>>,
}

impl futures::Stream for DiffStreamHandle {
    type Item = Result<LogEntry, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.stream).poll_next(cx)
    }
}

impl Drop for DiffStreamHandle {
    fn drop(&mut self) {
        if let Some(handle) = self.watcher_task.take() {
            handle.abort();
        }
    }
}

impl DiffStreamHandle {
    fn new(
        stream: futures::stream::BoxStream<'static, Result<LogEntry, io::Error>>,
        watcher_task: Option<JoinHandle<()>>,
    ) -> Self {
        Self {
            stream,
            watcher_task,
        }
    }
}

struct DiffWatcherContext {
    git_service: GitService,
    worktree_path: PathBuf,
    base_commit: CommitId,
    cumulative_bytes: Arc<AtomicUsize>,
    full_sent_paths: Arc<std::sync::RwLock<HashSet<String>>>,
    stats_only: bool,
    tx: mpsc::Sender<Result<LogEntry, io::Error>>,
}

impl DiffWatcherContext {
    /// Recompute and stream diffs for the given changed paths. An empty list
    /// forces a full recompute (used when the event stream lagged).
    async fn handle_change(&self, changed_paths: Vec<String>) -> bool {
        let git_service = self.git_service.clone();
        let worktree_path = self.worktree_path.clone();
        let base_commit = self.base_commit;
        let cumulative = self.cumulative_bytes.clone();
        let full_sent = self.full_sent_paths.clone();
        let stats_only = self.stats_only;
        let tx = self.tx.clone();

        match tokio::task::spawn_blocking(move || {
            process_file_changes(
                &git_service,
                &worktree_path,
                &base_commit,
                &changed_paths,
                &cumulative,
                &full_sent,
                stats_only,
            )
        })
        .await
        {
            Ok(Ok(messages)) => send_messages(&tx, messages).await,
            Ok(Err(err)) => {
                tracing::error!("diff processing error: {err}");
                send_error(&tx, err.to_string()).await;
                false
            }
            Err(join_err) => {
                tracing::error!("diff processing task join error: {join_err}");
                send_error(&tx, format!("diff processing task join error: {join_err}")).await;
                false
            }
        }
    }
}

pub async fn create(
    git_service: GitService,
    worktree_path: PathBuf,
    base_commit: CommitId,
    stats_only: bool,
    events: broadcast::Receiver<WorktreeEventBatch>,
) -> Result<DiffStreamHandle, DiffStreamError> {
    // Computing the initial worktree diff is a synchronous git2 operation that
    // can be slow on large changesets. Offload it so opening a diff stream never
    // blocks an async worker thread.
    let initial_diffs = {
        let git_service = git_service.clone();
        let worktree_path = worktree_path.clone();
        tokio::task::spawn_blocking(move || {
            git_service.get_diffs(
                DiffTarget::Worktree {
                    worktree_path: &worktree_path,
                    base_commit,
                },
                None,
            )
        })
        .await??
    };

    let cumulative = Arc::new(AtomicUsize::new(0));
    let full_sent_paths = Arc::new(std::sync::RwLock::new(HashSet::new()));
    let mut entries = Vec::with_capacity(initial_diffs.len());
    for mut diff in initial_diffs {
        apply_stream_omit_policy(&mut diff, &cumulative, stats_only);
        if !diff.content_omitted {
            if let Some(path) = diff.path_key().map(|p| p.to_string()) {
                full_sent_paths.write().unwrap().insert(path);
            }
        }
        entries.push(diff_to_entry(diff));
    }

    let (tx, rx) = mpsc::channel::<Result<LogEntry, io::Error>>(DIFF_STREAM_CHANNEL_CAPACITY);
    if !send_messages(&tx, entries).await {
        return Ok(DiffStreamHandle::new(ReceiverStream::new(rx).boxed(), None));
    }

    let ctx = DiffWatcherContext {
        git_service: git_service.clone(),
        worktree_path: worktree_path.clone(),
        base_commit,
        cumulative_bytes: cumulative.clone(),
        full_sent_paths: full_sent_paths.clone(),
        stats_only,
        tx: tx.clone(),
    };

    let watcher_task = tokio::spawn(async move {
        let mut stream = BroadcastStream::new(events);
        while let Some(result) = stream.next().await {
            match result {
                Ok(batch) => {
                    let changed_paths: Vec<String> = batch
                        .iter()
                        .map(|event| event.relative_path.clone())
                        .filter(|path| !path.is_empty())
                        .collect();
                    if changed_paths.is_empty() {
                        continue;
                    }
                    if !ctx.handle_change(changed_paths).await {
                        return;
                    }
                }
                Err(_lagged) => {
                    // Fell behind the watcher; recompute the full diff so the
                    // client never observes a stale tree.
                    if !ctx.handle_change(Vec::new()).await {
                        return;
                    }
                }
            }
        }
    });

    drop(tx);

    Ok(DiffStreamHandle::new(
        ReceiverStream::new(rx).boxed(),
        Some(watcher_task),
    ))
}

async fn send_messages(
    tx: &mpsc::Sender<Result<LogEntry, io::Error>>,
    messages: Vec<LogEntry>,
) -> bool {
    for msg in messages {
        if tx.send(Ok(msg)).await.is_err() {
            return false;
        }
    }
    true
}

async fn send_error(tx: &mpsc::Sender<Result<LogEntry, io::Error>>, message: String) {
    let _ = tx
        .send(Err(io::Error::other(message)))
        .await;
}

fn diff_to_entry(diff: Diff) -> LogEntry {
    let key = diff
        .path_key()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "unknown".into());
    let patch = serde_json::json!([{
        "op": "add",
        "path": format!("/diffs/{}", escape_json_pointer_segment(&key)),
        "value": { "type": "DIFF", "content": diff }
    }]);
    LogEntry::JsonPatch(patch)
}

fn remove_diff_entry(path: &str) -> LogEntry {
    let patch = serde_json::json!([{
        "op": "remove",
        "path": format!("/diffs/{}", escape_json_pointer_segment(path)),
    }]);
    LogEntry::JsonPatch(patch)
}

fn escape_json_pointer_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

pub fn apply_stream_omit_policy(diff: &mut Diff, sent_bytes: &Arc<AtomicUsize>, stats_only: bool) {
    if stats_only {
        diff.old_content = None;
        diff.new_content = None;
        diff.content_omitted = true;
        return;
    }

    let mut size = 0usize;
    if let Some(ref s) = diff.old_content {
        size += s.len();
    }
    if let Some(ref s) = diff.new_content {
        size += s.len();
    }

    if size == 0 {
        return;
    }

    let current = sent_bytes.load(Ordering::Relaxed);
    if current.saturating_add(size) > MAX_CUMULATIVE_DIFF_BYTES {
        diff.old_content = None;
        diff.new_content = None;
        diff.content_omitted = true;
    } else {
        let _ = sent_bytes.fetch_add(size, Ordering::Relaxed);
    }
}

fn process_file_changes(
    git_service: &GitService,
    worktree_path: &Path,
    base_commit: &CommitId,
    changed_paths: &[String],
    cumulative_bytes: &Arc<AtomicUsize>,
    full_sent_paths: &Arc<std::sync::RwLock<HashSet<String>>>,
    stats_only: bool,
) -> Result<Vec<LogEntry>, DiffStreamError> {
    let filter: Vec<&str> = changed_paths.iter().map(|s| s.as_str()).collect();
    let diffs = git_service.get_diffs(
        DiffTarget::Worktree {
            worktree_path,
            base_commit: *base_commit,
        },
        if filter.is_empty() {
            None
        } else {
            Some(&filter)
        },
    )?;

    let mut messages = Vec::new();
    let mut files_with_diffs = HashSet::new();

    for mut diff in diffs.into_iter() {
        let key = match diff.path_key().map(|p| p.to_string()) {
            Some(path) => path,
            None => continue,
        };
        files_with_diffs.insert(key.clone());
        apply_stream_omit_policy(&mut diff, cumulative_bytes, stats_only);
        if diff.content_omitted {
            if full_sent_paths.read().unwrap().contains(&key) {
                continue;
            }
        } else {
            full_sent_paths.write().unwrap().insert(key.clone());
        }
        messages.push(diff_to_entry(diff));
    }

    for path in changed_paths {
        if !files_with_diffs.contains(path) {
            messages.push(remove_diff_entry(path));
        }
    }

    Ok(messages)
}
