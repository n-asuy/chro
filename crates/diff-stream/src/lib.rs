pub use log_types::{
    compute_line_change_counts, create_unified_diff, create_unified_diff_hunk, Diff, DiffChangeKind,
};

use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
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

const MAX_CUMULATIVE_DIFF_BYTES: usize = 16 * 1024 * 1024;
const DIFF_STREAM_CHANNEL_CAPACITY: usize = 1024;

/// How often to re-check for an in-progress rebase to finish, and the ceiling on
/// how long to keep checking before giving up on the forced full recompute.
const REBASE_SETTLE_POLL: Duration = Duration::from_millis(500);
const REBASE_SETTLE_MAX_POLLS: u32 = 40; // 40 * 500ms = 20s ceiling

#[derive(Debug, Error)]
pub enum DiffStreamError {
    #[error(transparent)]
    Git(#[from] GitServiceError),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
}

/// Where a diff stream's base commit comes from. The base is resolved on every
/// recompute (not frozen at stream creation) so that history rewrites in the
/// worktree — most importantly a rebase onto a moved target — re-anchor the
/// diff instead of leaking the base branch's own commits into the run's diff.
#[derive(Clone)]
pub enum BaseSource {
    /// A fixed commit, used for runs with no branch/target (e.g. non-git
    /// projects): the worktree HEAD captured once at stream creation.
    Fixed(CommitId),
    /// The live merge-base of `branch` against `target`, recomputed each pass
    /// from the project repo. Mirrors three-dot `target...branch` semantics and
    /// follows the branch tip after a rebase.
    MergeBase {
        repo_path: PathBuf,
        branch: String,
        target: String,
    },
}

impl BaseSource {
    fn resolve(&self, git_service: &GitService) -> Result<CommitId, GitServiceError> {
        match self {
            BaseSource::Fixed(commit) => Ok(*commit),
            BaseSource::MergeBase {
                repo_path,
                branch,
                target,
            } => git_service.get_base_commit(repo_path, branch, target),
        }
    }

    /// Only a live merge-base can be contaminated by a mid-rebase tree, so the
    /// rebase gate is scoped to that variant.
    fn is_merge_base(&self) -> bool {
        matches!(self, BaseSource::MergeBase { .. })
    }
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
    base: BaseSource,
    /// Last base the client's diff was computed against. When a recompute
    /// resolves a different base (e.g. after a rebase), every file's diff can
    /// change, so the recompute is upgraded to a full pass.
    last_base: Mutex<CommitId>,
    cumulative_bytes: Arc<AtomicUsize>,
    full_sent_paths: Arc<RwLock<HashSet<String>>>,
    /// Diff keys currently present in the client document. Lets a full recompute
    /// emit `remove` for paths that no longer differ from the (possibly moved)
    /// base, which the per-path change list cannot see.
    reported_paths: Arc<RwLock<HashSet<String>>>,
    stats_only: bool,
    /// Guards against spawning more than one rebase-settle poller at a time.
    rebase_poll_active: AtomicBool,
    tx: mpsc::Sender<Result<LogEntry, io::Error>>,
}

impl DiffWatcherContext {
    /// Recompute and stream diffs for the given changed paths. An empty list
    /// forces a full recompute (used when the event stream lagged or the base
    /// moved). Returns false when the receiver is gone and the watcher should
    /// stop.
    async fn handle_change(self: &Arc<Self>, changed_paths: Vec<String>) -> bool {
        // A live merge-base recomputed against a half-rebased worktree would
        // momentarily show the base branch's commits as the run's changes. Skip
        // while a rebase is in progress and arrange a recompute once it settles
        // (Git may clear its metadata without a trailing file event).
        if self.base.is_merge_base() {
            let in_progress = {
                let git = self.git_service.clone();
                let wp = self.worktree_path.clone();
                tokio::task::spawn_blocking(move || git.is_rebase_in_progress(&wp).unwrap_or(false))
                    .await
                    .unwrap_or(false)
            };
            if in_progress {
                self.spawn_rebase_settle_poller();
                return !self.tx.is_closed();
            }
        }

        // Resolve the base for this pass. On failure keep the last known base so
        // a transient git error degrades to a stale-but-consistent diff rather
        // than killing the stream.
        let base_commit = {
            let git_service = self.git_service.clone();
            let base = self.base.clone();
            let resolved = tokio::task::spawn_blocking(move || base.resolve(&git_service))
                .await
                .ok()
                .and_then(Result::ok);
            match resolved {
                Some(commit) => commit,
                None => *self.last_base.lock().unwrap(),
            }
        };

        // A moved base invalidates every path, so force a full recompute.
        let base_moved = {
            let mut last = self.last_base.lock().unwrap();
            let moved = last.as_oid() != base_commit.as_oid();
            *last = base_commit;
            moved
        };
        let full_recompute = base_moved || changed_paths.is_empty();
        let paths = if full_recompute {
            Vec::new()
        } else {
            changed_paths
        };

        let git_service = self.git_service.clone();
        let worktree_path = self.worktree_path.clone();
        let cumulative = self.cumulative_bytes.clone();
        let full_sent = self.full_sent_paths.clone();
        let reported = self.reported_paths.clone();
        let stats_only = self.stats_only;
        let tx = self.tx.clone();

        match tokio::task::spawn_blocking(move || {
            process_file_changes(
                &git_service,
                &worktree_path,
                &base_commit,
                &paths,
                full_recompute,
                &cumulative,
                &full_sent,
                &reported,
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

    /// Poll until an in-progress rebase clears, then force one full recompute so
    /// the post-rebase (re-anchored) diff is delivered even if Git emitted no
    /// trailing file event. At most one poller runs at a time.
    fn spawn_rebase_settle_poller(self: &Arc<Self>) {
        if self
            .rebase_poll_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let ctx = self.clone();
        tokio::spawn(async move {
            for _ in 0..REBASE_SETTLE_MAX_POLLS {
                tokio::time::sleep(REBASE_SETTLE_POLL).await;
                if ctx.tx.is_closed() {
                    break;
                }
                let git = ctx.git_service.clone();
                let wp = ctx.worktree_path.clone();
                let still = tokio::task::spawn_blocking(move || {
                    git.is_rebase_in_progress(&wp).unwrap_or(false)
                })
                .await
                .unwrap_or(false);
                if !still {
                    ctx.rebase_poll_active.store(false, Ordering::Release);
                    ctx.handle_change(Vec::new()).await;
                    return;
                }
            }
            ctx.rebase_poll_active.store(false, Ordering::Release);
        });
    }
}

pub async fn create(
    git_service: GitService,
    worktree_path: PathBuf,
    base: BaseSource,
    stats_only: bool,
    events: broadcast::Receiver<WorktreeEventBatch>,
) -> Result<DiffStreamHandle, DiffStreamError> {
    // Resolve the initial base. Both this and every later recompute go through
    // the same resolver so the diff stays anchored on the live merge-base.
    let base_commit = {
        let git_service = git_service.clone();
        let base = base.clone();
        tokio::task::spawn_blocking(move || base.resolve(&git_service)).await??
    };

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
    let full_sent_paths = Arc::new(RwLock::new(HashSet::new()));
    let reported_paths = Arc::new(RwLock::new(HashSet::new()));
    let mut entries = Vec::with_capacity(initial_diffs.len());
    for mut diff in initial_diffs {
        let key = diff.path_key().map(|p| p.to_string());
        apply_stream_omit_policy(&mut diff, &cumulative, stats_only);
        if let Some(path) = key {
            reported_paths.write().unwrap().insert(path.clone());
            if !diff.content_omitted {
                full_sent_paths.write().unwrap().insert(path);
            }
        }
        entries.push(diff_to_entry(diff));
    }

    let (tx, rx) = mpsc::channel::<Result<LogEntry, io::Error>>(DIFF_STREAM_CHANNEL_CAPACITY);
    if !send_messages(&tx, entries).await {
        return Ok(DiffStreamHandle::new(ReceiverStream::new(rx).boxed(), None));
    }

    let ctx = Arc::new(DiffWatcherContext {
        git_service: git_service.clone(),
        worktree_path: worktree_path.clone(),
        base,
        last_base: Mutex::new(base_commit),
        cumulative_bytes: cumulative.clone(),
        full_sent_paths: full_sent_paths.clone(),
        reported_paths: reported_paths.clone(),
        stats_only,
        rebase_poll_active: AtomicBool::new(false),
        tx: tx.clone(),
    });

    let watcher_task = tokio::spawn(async move {
        let mut stream = BroadcastStream::new(events);
        while let Some(result) = stream.next().await {
            match result {
                Ok(batch) => {
                    let force_full_recompute =
                        batch.iter().any(|event| event.relative_path.is_empty());
                    let changed_paths: Vec<String> = batch
                        .iter()
                        .map(|event| event.relative_path.clone())
                        .filter(|path| !path.is_empty())
                        .collect();
                    if force_full_recompute {
                        if !ctx.handle_change(Vec::new()).await {
                            return;
                        }
                        continue;
                    }
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
    let _ = tx.send(Err(io::Error::other(message))).await;
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

    let reserved = sent_bytes.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        current
            .checked_add(size)
            .filter(|next| *next <= MAX_CUMULATIVE_DIFF_BYTES)
    });
    if reserved.is_err() {
        diff.old_content = None;
        diff.new_content = None;
        diff.content_omitted = true;
    }
}

#[allow(clippy::too_many_arguments)]
fn process_file_changes(
    git_service: &GitService,
    worktree_path: &Path,
    base_commit: &CommitId,
    changed_paths: &[String],
    full_recompute: bool,
    cumulative_bytes: &Arc<AtomicUsize>,
    full_sent_paths: &Arc<RwLock<HashSet<String>>>,
    reported_paths: &Arc<RwLock<HashSet<String>>>,
    stats_only: bool,
) -> Result<Vec<LogEntry>, DiffStreamError> {
    // A full recompute diffs the whole worktree (no path filter); a partial pass
    // filters to the changed paths reported by the watcher.
    let filter: Vec<&str> = changed_paths.iter().map(|s| s.as_str()).collect();
    let diffs = git_service.get_diffs(
        DiffTarget::Worktree {
            worktree_path,
            base_commit: *base_commit,
        },
        if full_recompute { None } else { Some(&filter) },
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
        reported_paths.write().unwrap().insert(key.clone());
        messages.push(diff_to_entry(diff));
    }

    // Emit removals for paths that no longer differ from the base. A partial
    // pass can only speak to the paths it was asked about; a full pass (lag
    // recovery or a moved base) reconciles against every previously reported
    // path, since files can silently drop out of the diff when the base moves.
    let stale: Vec<String> = if full_recompute {
        reported_paths
            .read()
            .unwrap()
            .iter()
            .filter(|path| !files_with_diffs.contains(*path))
            .cloned()
            .collect()
    } else {
        changed_paths
            .iter()
            .filter(|path| !files_with_diffs.contains(*path))
            .cloned()
            .collect()
    };
    if !stale.is_empty() {
        let mut reported = reported_paths.write().unwrap();
        for path in stale {
            reported.remove(&path);
            full_sent_paths.write().unwrap().remove(&path);
            messages.push(remove_diff_entry(&path));
        }
    }

    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::Arc as StdArc;

    fn inline_diff(content: &str) -> Diff {
        Diff {
            change: DiffChangeKind::Modified,
            old_path: Some("file.txt".into()),
            new_path: Some("file.txt".into()),
            old_content: Some(content.into()),
            new_content: None,
            content_omitted: false,
            additions: None,
            deletions: None,
            is_binary: false,
        }
    }

    #[test]
    fn stream_omits_content_that_would_exceed_budget() {
        let sent = Arc::new(AtomicUsize::new(MAX_CUMULATIVE_DIFF_BYTES - 2));
        let mut diff = inline_diff("more");
        apply_stream_omit_policy(&mut diff, &sent, false);
        assert!(diff.content_omitted);
        assert!(diff.old_content.is_none());
        assert_eq!(
            sent.load(Ordering::Relaxed),
            MAX_CUMULATIVE_DIFF_BYTES - 2
        );
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
    }

    /// A repo with an initial commit on `main` and a `feature` branch checked
    /// out, both authored through the git CLI so rebase in tests has an identity.
    fn init_project(dir: &Path) {
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
        write(dir, "base.txt", "base\n");
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "base"]);
        git(dir, &["branch", "-M", "main"]);
        git(dir, &["checkout", "-q", "-b", "feature"]);
    }

    fn empty_reported() -> Arc<RwLock<HashSet<String>>> {
        Arc::new(RwLock::new(HashSet::new()))
    }

    fn diff_keys(messages: &[LogEntry]) -> Vec<(String, String)> {
        // Returns (op, key) pairs for /diffs/<key> patch operations.
        let mut out = Vec::new();
        for msg in messages {
            if let LogEntry::JsonPatch(value) = msg {
                if let Some(ops) = value.as_array() {
                    for op in ops {
                        let (Some(kind), Some(path)) = (
                            op.get("op").and_then(|v| v.as_str()),
                            op.get("path").and_then(|v| v.as_str()),
                        ) else {
                            continue;
                        };
                        if let Some(key) = path.strip_prefix("/diffs/") {
                            out.push((kind.to_string(), key.to_string()));
                        }
                    }
                }
            }
        }
        out
    }

    /// A full recompute must emit `remove` for every previously reported path
    /// that no longer differs from the base — not just paths in the change list.
    /// This is the lag-recovery / moved-base reconciliation the old code missed.
    #[test]
    fn full_recompute_removes_reverted_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        init_project(dir);
        let git_service = GitService::new();
        let base = git_service.get_base_commit(dir, "feature", "main").unwrap();

        // Two uncommitted changes vs the base.
        write(dir, "base.txt", "changed\n");
        write(dir, "new.txt", "added\n");

        let cumulative = Arc::new(AtomicUsize::new(0));
        let full_sent = empty_reported();
        let reported = empty_reported();

        let first = process_file_changes(
            &git_service,
            dir,
            &base,
            &[],
            true,
            &cumulative,
            &full_sent,
            &reported,
            false,
        )
        .unwrap();
        let adds: HashSet<String> = diff_keys(&first)
            .into_iter()
            .filter(|(op, _)| op == "add")
            .map(|(_, k)| k)
            .collect();
        assert!(adds.contains("base.txt") && adds.contains("new.txt"));
        assert_eq!(reported.read().unwrap().len(), 2);

        // Revert both back to the base state on disk.
        write(dir, "base.txt", "base\n");
        std::fs::remove_file(dir.join("new.txt")).unwrap();

        let second = process_file_changes(
            &git_service,
            dir,
            &base,
            &[],
            true,
            &cumulative,
            &full_sent,
            &reported,
            false,
        )
        .unwrap();
        let removes: HashSet<String> = diff_keys(&second)
            .into_iter()
            .filter(|(op, _)| op == "remove")
            .map(|(_, k)| k)
            .collect();
        assert!(
            removes.contains("base.txt") && removes.contains("new.txt"),
            "full recompute must remove both reverted paths, got {removes:?}"
        );
        assert!(reported.read().unwrap().is_empty());
    }

    /// A partial pass only speaks to the paths it was asked about, leaving other
    /// reported diffs untouched.
    #[test]
    fn partial_pass_removes_only_requested_path() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        init_project(dir);
        let git_service = GitService::new();
        let base = git_service.get_base_commit(dir, "feature", "main").unwrap();

        write(dir, "base.txt", "changed\n");
        write(dir, "new.txt", "added\n");
        let cumulative = Arc::new(AtomicUsize::new(0));
        let full_sent = empty_reported();
        let reported = empty_reported();
        process_file_changes(
            &git_service,
            dir,
            &base,
            &[],
            true,
            &cumulative,
            &full_sent,
            &reported,
            false,
        )
        .unwrap();

        // Revert only base.txt; a partial pass scoped to it removes only it.
        write(dir, "base.txt", "base\n");
        let msgs = process_file_changes(
            &git_service,
            dir,
            &base,
            &["base.txt".to_string()],
            false,
            &cumulative,
            &full_sent,
            &reported,
            false,
        )
        .unwrap();
        let removes: Vec<String> = diff_keys(&msgs)
            .into_iter()
            .filter(|(op, _)| op == "remove")
            .map(|(_, k)| k)
            .collect();
        assert_eq!(removes, vec!["base.txt".to_string()]);
        assert!(reported.read().unwrap().contains("new.txt"));
    }

    /// Fold a stream of add/remove patches into the current set of diff keys.
    async fn collect_diff_set(handle: &mut DiffStreamHandle) -> HashSet<String> {
        let mut set = HashSet::new();
        // Drain everything available within a short window; the watcher runs on
        // spawn_blocking so results arrive slightly after the triggering event.
        loop {
            match tokio::time::timeout(Duration::from_millis(400), handle.next()).await {
                Ok(Some(Ok(LogEntry::JsonPatch(value)))) => {
                    if let Some(ops) = value.as_array() {
                        for op in ops {
                            let (Some(kind), Some(path)) = (
                                op.get("op").and_then(|v| v.as_str()),
                                op.get("path").and_then(|v| v.as_str()),
                            ) else {
                                continue;
                            };
                            if let Some(key) = path.strip_prefix("/diffs/") {
                                match kind {
                                    "add" | "replace" => {
                                        set.insert(key.to_string());
                                    }
                                    "remove" => {
                                        set.remove(key);
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        set
    }

    /// The headline regression: after a rebase onto a moved target, the run's
    /// diff must not include the target branch's own commits. A frozen base
    /// (the pre-fix behaviour) would show `main.txt` as the run's change.
    #[tokio::test]
    async fn rebase_does_not_contaminate_diff() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        init_project(&dir);

        // The run's own change, committed on feature.
        write(&dir, "feature.txt", "feature work\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "feature work"]);

        let (tx, rx) = broadcast::channel::<WorktreeEventBatch>(64);
        let mut handle = create(
            GitService::new(),
            dir.clone(),
            BaseSource::MergeBase {
                repo_path: dir.clone(),
                branch: "feature".to_string(),
                target: "main".to_string(),
            },
            false,
            rx,
        )
        .await
        .unwrap();

        let initial = collect_diff_set(&mut handle).await;
        assert!(
            initial.contains("feature.txt") && !initial.contains("main.txt"),
            "initial diff should be just the run's change, got {initial:?}"
        );

        // The target advances with its own commit, then the run rebases onto it.
        git(&dir, &["checkout", "-q", "main"]);
        write(&dir, "main.txt", "target work\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "target work"]);
        git(&dir, &["checkout", "-q", "feature"]);
        git(&dir, &["rebase", "-q", "main"]);

        // A file event triggers a recompute; the base is re-resolved live.
        let batch: WorktreeEventBatch = StdArc::new(vec![filesystem::WorktreeEvent {
            kind: filesystem::WorktreeEventKind::Modified,
            relative_path: "feature.txt".to_string(),
            is_dir: false,
        }]);
        tx.send(batch).unwrap();

        let after = collect_diff_set(&mut handle).await;
        assert!(
            after.contains("feature.txt"),
            "run's change must survive the rebase, got {after:?}"
        );
        assert!(
            !after.contains("main.txt"),
            "target branch commit must not leak into the run's diff, got {after:?}"
        );
    }

    /// While a rebase is in progress the stream must not recompute (a live
    /// merge-base against a half-rebased tree would leak), and once the rebase
    /// metadata clears, the settle poller must deliver a full recompute even
    /// with no further file events.
    #[tokio::test]
    async fn rebase_gate_skips_then_settles() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        init_project(&dir);

        let (tx, rx) = broadcast::channel::<WorktreeEventBatch>(64);
        let mut handle = create(
            GitService::new(),
            dir.clone(),
            BaseSource::MergeBase {
                repo_path: dir.clone(),
                branch: "feature".to_string(),
                target: "main".to_string(),
            },
            false,
            rx,
        )
        .await
        .unwrap();
        assert!(collect_diff_set(&mut handle).await.is_empty());

        // Simulate an in-progress rebase the way Git marks it, then make a
        // change that would normally stream a diff.
        std::fs::create_dir(dir.join(".git/rebase-merge")).unwrap();
        write(&dir, "gated.txt", "written mid-rebase\n");
        let batch: WorktreeEventBatch = StdArc::new(vec![filesystem::WorktreeEvent {
            kind: filesystem::WorktreeEventKind::Created,
            relative_path: "gated.txt".to_string(),
            is_dir: false,
        }]);
        tx.send(batch).unwrap();

        let during = collect_diff_set(&mut handle).await;
        assert!(
            during.is_empty(),
            "no diff may stream while the rebase is in progress, got {during:?}"
        );

        // Rebase finishes; no further file events arrive. The settle poller
        // (500ms cadence) must force the full recompute on its own.
        std::fs::remove_dir(dir.join(".git/rebase-merge")).unwrap();
        let mut settled = HashSet::new();
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(400)).await;
            settled = collect_diff_set(&mut handle).await;
            if !settled.is_empty() {
                break;
            }
        }
        assert!(
            settled.contains("gated.txt"),
            "settle poller must deliver the post-rebase diff, got {settled:?}"
        );
    }
}
