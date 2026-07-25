//! Shared watcher for git metadata (`.git`) state changes.
//!
//! The worktree watcher deliberately drops everything under `.git`, so commits,
//! checkouts, staging, and rebases are invisible to it. This module is the
//! second signal source: one recursive watcher per canonical *common dir*
//! (`.git` of the main repository), shared by every worktree linked to it.
//!
//! A single recursive watch is used on purpose: linked-worktree git dirs live
//! *inside* the common dir (`.git/worktrees/<name>/`), so one watch covers the
//! refs shared by all worktrees plus every per-worktree HEAD/index. High-churn
//! subtrees (`objects/`, `logs/`) and git's transient `*.lock` files are
//! dropped by a whitelist classifier inside the watcher callback, before
//! anything reaches the debounce buffer. This also keeps behaviour correct on
//! backends that do not honour non-recursive watches.
//!
//! Events are scope-tagged: ref changes are `Shared` (a branch tip moving is
//! relevant to every worktree's ahead/behind), while HEAD/index/operation
//! changes are tagged with the owning git dir so subscribers can drop other
//! worktrees' local churn via [`GitStateEvent::applies_to`].

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use notify::{
    Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
    time::MissedTickBehavior,
};

use crate::watcher::FilesystemWatcherError;

/// Window over which raw events are coalesced before broadcasting a batch.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);
/// How often an idle watcher checks whether it still has subscribers.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Broadcast backlog. Each item is a coalesced batch of at most a handful of
/// distinct (kind, scope) pairs, so this is generous.
const EVENT_CHANNEL_CAPACITY: usize = 64;
const INGEST_CHANNEL_CAPACITY: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GitStateEventKind {
    /// HEAD, a ref, or packed-refs changed: commit, checkout, fetch, rebase.
    HeadMoved,
    /// The index changed: staging, unstaging, or a checkout updating it.
    IndexChanged,
    /// An in-progress operation started or finished (`rebase-merge/`,
    /// `rebase-apply/`, `MERGE_HEAD` appeared or disappeared).
    OperationChanged,
}

/// Which worktrees a git state change is relevant to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum GitEventScope {
    /// Shared repository state (refs): relevant to every linked worktree.
    Shared,
    /// State private to one worktree's git dir (HEAD, index, operations).
    Worktree(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GitStateEvent {
    pub kind: GitStateEventKind,
    pub scope: GitEventScope,
}

impl GitStateEvent {
    /// Whether this event is relevant to a subscriber rooted at `git_dir`.
    pub fn applies_to(&self, git_dir: &Path) -> bool {
        match &self.scope {
            GitEventScope::Shared => true,
            GitEventScope::Worktree(owner) => owner == git_dir,
        }
    }
}

/// A batch of coalesced events emitted on one debounce tick.
pub type GitStateEventBatch = Arc<Vec<GitStateEvent>>;

/// A live subscription for one worktree: the shared receiver plus the git dir
/// used to filter scope-tagged events (see [`GitStateEvent::applies_to`]).
pub struct GitStateSubscription {
    pub git_dir: PathBuf,
    pub receiver: broadcast::Receiver<GitStateEventBatch>,
}

impl GitStateSubscription {
    /// The kinds in `batch` that are relevant to this subscription's worktree.
    pub fn relevant_kinds(&self, batch: &GitStateEventBatch) -> HashSet<GitStateEventKind> {
        batch
            .iter()
            .filter(|event| event.applies_to(&self.git_dir))
            .map(|event| event.kind)
            .collect()
    }
}

/// The two directories that define a worktree's git state location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGitDirs {
    /// This worktree's own git dir: `.git` itself for the main worktree, or
    /// `<common>/worktrees/<name>` for a linked worktree (via the gitfile).
    pub git_dir: PathBuf,
    /// The repository-wide git dir holding shared state (refs, packed-refs).
    pub common_dir: PathBuf,
}

/// Resolve `worktree`'s git dir and common dir, following the gitfile
/// (`.git` as a file containing `gitdir: <path>`) and the `commondir` file
/// linked worktrees carry. Returns `None` when `worktree` is not a git
/// worktree at all.
pub fn resolve_git_dirs(worktree: &Path) -> Option<ResolvedGitDirs> {
    let dot_git = worktree.join(".git");
    let metadata = fs::metadata(&dot_git).ok()?;

    let git_dir = if metadata.is_dir() {
        dot_git
    } else {
        let content = fs::read_to_string(&dot_git).ok()?;
        let target = content.strip_prefix("gitdir:")?.trim();
        let target = Path::new(target);
        if target.is_absolute() {
            target.to_path_buf()
        } else {
            worktree.join(target)
        }
    };
    let git_dir = canonicalize_lossy(&git_dir);
    if !git_dir.is_dir() {
        return None;
    }

    let common_dir = match fs::read_to_string(git_dir.join("commondir")) {
        Ok(content) => {
            let target = Path::new(content.trim());
            let absolute = if target.is_absolute() {
                target.to_path_buf()
            } else {
                git_dir.join(target)
            };
            canonicalize_lossy(&absolute)
        }
        Err(_) => git_dir.clone(),
    };

    Some(ResolvedGitDirs {
        git_dir,
        common_dir,
    })
}

struct WatcherEntry {
    sender: broadcast::Sender<GitStateEventBatch>,
    task: JoinHandle<()>,
    id: u64,
}

/// Owns one recursive watcher per canonical common dir and hands out
/// scope-filtering subscriptions per worktree. Cloning shares the registry.
#[derive(Clone, Default)]
pub struct GitStateWatcherService {
    watchers: Arc<Mutex<HashMap<PathBuf, WatcherEntry>>>,
    next_id: Arc<AtomicU64>,
}

impl GitStateWatcherService {
    /// Subscribe to git state events for `worktree_path`. Worktrees sharing a
    /// common dir share one watcher. Returns `None` when the path is not a git
    /// worktree. Watcher registration runs off-thread, so a brand-new
    /// subscriber may miss events for a few hundred milliseconds during setup.
    pub fn subscribe(&self, worktree_path: &Path) -> Option<GitStateSubscription> {
        let dirs = resolve_git_dirs(worktree_path)?;
        let common_dir = dirs.common_dir.clone();

        let mut watchers = self.watchers.lock().unwrap();

        // Drop a dead entry (its task exited) before reusing the slot.
        if watchers
            .get(&common_dir)
            .is_some_and(|entry| entry.task.is_finished())
        {
            watchers.remove(&common_dir);
        }

        let receiver = if let Some(entry) = watchers.get(&common_dir) {
            entry.sender.subscribe()
        } else {
            let (sender, receiver) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
            let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
            let task = self.spawn_watcher(common_dir.clone(), id, sender.clone());
            watchers.insert(common_dir, WatcherEntry { sender, task, id });
            receiver
        };

        Some(GitStateSubscription {
            git_dir: dirs.git_dir,
            receiver,
        })
    }

    fn remove_if_matching(&self, common_dir: &Path, id: u64) {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers.get(common_dir).is_some_and(|entry| entry.id == id) {
            watchers.remove(common_dir);
        }
    }

    fn spawn_watcher(
        &self,
        common_dir: PathBuf,
        id: u64,
        sender: broadcast::Sender<GitStateEventBatch>,
    ) -> JoinHandle<()> {
        let this = self.clone();

        tokio::spawn(async move {
            let (ingest_tx, mut ingest_rx) =
                mpsc::channel::<GitStateEvent>(INGEST_CHANNEL_CAPACITY);
            let overflowed = Arc::new(AtomicBool::new(false));

            let build_dir = common_dir.clone();
            let callback_overflowed = overflowed.clone();
            let watcher = match tokio::task::spawn_blocking(move || {
                build_watcher(&build_dir, ingest_tx, callback_overflowed)
            })
            .await
            {
                Ok(Ok(watcher)) => watcher,
                Ok(Err(err)) => {
                    tracing::error!(
                        common_dir = %common_dir.display(),
                        "failed to build git state watcher: {err}"
                    );
                    this.remove_if_matching(&common_dir, id);
                    return;
                }
                Err(join_err) => {
                    tracing::error!("git state watcher build join error: {join_err}");
                    this.remove_if_matching(&common_dir, id);
                    return;
                }
            };
            // Keep the watcher alive for as long as this task runs.
            let _watcher = watcher;

            let mut pending: HashSet<GitStateEvent> = HashSet::new();
            let mut flush = tokio::time::interval(DEBOUNCE_WINDOW);
            flush.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut idle = tokio::time::interval(IDLE_POLL_INTERVAL);
            idle.set_missed_tick_behavior(MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    received = ingest_rx.recv() => {
                        match received {
                            Some(event) => {
                                pending.insert(event);
                            }
                            None => break,
                        }
                    }
                    _ = flush.tick() => {
                        let did_overflow = overflowed.swap(false, Ordering::AcqRel);
                        if pending.is_empty() && !did_overflow {
                            continue;
                        }
                        if did_overflow {
                            pending.insert(GitStateEvent {
                                kind: GitStateEventKind::HeadMoved,
                                scope: GitEventScope::Shared,
                            });
                            pending.insert(GitStateEvent {
                                kind: GitStateEventKind::IndexChanged,
                                scope: GitEventScope::Shared,
                            });
                            pending.insert(GitStateEvent {
                                kind: GitStateEventKind::OperationChanged,
                                scope: GitEventScope::Shared,
                            });
                        }
                        let batch: Vec<GitStateEvent> = pending.drain().collect();
                        let _ = sender.send(Arc::new(batch));
                    }
                    _ = idle.tick() => {
                        if pending.is_empty()
                            && !overflowed.load(Ordering::Acquire)
                            && sender.receiver_count() == 0
                        {
                            break;
                        }
                    }
                }
            }

            this.remove_if_matching(&common_dir, id);
        })
    }

    #[cfg(test)]
    fn watcher_count(&self) -> usize {
        self.watchers.lock().unwrap().len()
    }
}

/// Build a recursive watcher over the common dir whose callback classifies
/// events through the whitelist before they reach the debounce buffer.
fn build_watcher(
    common_dir: &Path,
    ingest_tx: mpsc::Sender<GitStateEvent>,
    overflowed: Arc<AtomicBool>,
) -> Result<RecommendedWatcher, FilesystemWatcherError> {
    let root = common_dir.to_path_buf();

    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                return;
            }
            for absolute_path in event.paths {
                let Ok(relative) = absolute_path.strip_prefix(&root) else {
                    continue;
                };
                let Some(event) = classify(&root, relative) else {
                    continue;
                };
                // Channel only closes once this watcher is dropped; ignore errors.
                if matches!(
                    ingest_tx.try_send(event),
                    Err(mpsc::error::TrySendError::Full(_))
                ) {
                    overflowed.store(true, Ordering::Release);
                }
            }
        },
        NotifyConfig::default(),
    )?;

    watcher.watch(common_dir, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// Classify a path relative to the common dir into a scoped event, or `None`
/// for irrelevant churn. Whitelist-based: only known git state files produce
/// events; everything else (`objects/`, `logs/`, `*.lock`, temp files) is
/// dropped here, on the watcher callback thread.
fn classify(common_dir: &Path, relative: &Path) -> Option<GitStateEvent> {
    let mut components = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        });
    let first = components.next()?;

    // git writes state files via `<name>.lock` + rename; the lock churn is
    // noise (and, during long operations, a debounce-window flood).
    if relative
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".lock"))
    {
        return None;
    }

    match first {
        // High-churn subtrees, dropped before anything else.
        "objects" | "logs" => None,
        "refs" | "packed-refs" => Some(GitStateEvent {
            kind: GitStateEventKind::HeadMoved,
            scope: GitEventScope::Shared,
        }),
        "worktrees" => {
            let name = components.next()?;
            let rest = components.next()?;
            let git_dir = common_dir.join("worktrees").join(name);
            classify_local(rest).map(|kind| GitStateEvent {
                kind,
                scope: GitEventScope::Worktree(git_dir),
            })
        }
        other => classify_local(other).map(|kind| GitStateEvent {
            kind,
            scope: GitEventScope::Worktree(common_dir.to_path_buf()),
        }),
    }
}

/// Classify a file directly inside one git dir (the main one or a linked
/// worktree's) into a worktree-scoped event kind.
fn classify_local(name: &str) -> Option<GitStateEventKind> {
    match name {
        "HEAD" => Some(GitStateEventKind::HeadMoved),
        "index" => Some(GitStateEventKind::IndexChanged),
        "MERGE_HEAD" | "rebase-merge" | "rebase-apply" => Some(GitStateEventKind::OperationChanged),
        _ => None,
    }
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;
    use tokio::time::{sleep, timeout, Duration, Instant};

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-c")
            .arg("user.email=test@example.com")
            .arg("-c")
            .arg("user.name=test")
            .arg("-c")
            .arg("commit.gpgsign=false")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("failed to run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("file.txt"), "one").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "initial"]);
    }

    async fn wait_for_watcher_count(service: &GitStateWatcherService, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
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

    /// Receive batches until one contains an event of `kind` relevant to the
    /// subscription, or time out.
    async fn expect_kind(subscription: &mut GitStateSubscription, kind: GitStateEventKind) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let batch = timeout(remaining, subscription.receiver.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {kind:?}"))
                .expect("git state receiver should stay open");
            if subscription.relevant_kinds(&batch).contains(&kind) {
                return;
            }
        }
    }

    #[test]
    fn classify_maps_state_files_and_drops_noise() {
        let common = Path::new("/repo/.git");
        let event = |path: &str| classify(common, Path::new(path));

        assert_eq!(
            event("refs/heads/main").map(|e| (e.kind, e.scope)),
            Some((GitStateEventKind::HeadMoved, GitEventScope::Shared))
        );
        assert_eq!(
            event("packed-refs").map(|e| e.kind),
            Some(GitStateEventKind::HeadMoved)
        );
        assert_eq!(
            event("HEAD").map(|e| (e.kind, e.scope)),
            Some((
                GitStateEventKind::HeadMoved,
                GitEventScope::Worktree(common.to_path_buf())
            ))
        );
        assert_eq!(
            event("index").map(|e| e.kind),
            Some(GitStateEventKind::IndexChanged)
        );
        assert_eq!(
            event("worktrees/wt1/index").map(|e| (e.kind, e.scope)),
            Some((
                GitStateEventKind::IndexChanged,
                GitEventScope::Worktree(common.join("worktrees/wt1"))
            ))
        );
        assert_eq!(
            event("worktrees/wt1/rebase-merge/msgnum").map(|e| e.kind),
            Some(GitStateEventKind::OperationChanged)
        );

        assert_eq!(event("index.lock"), None);
        assert_eq!(event("refs/heads/main.lock"), None);
        assert_eq!(event("objects/ab/cdef0123"), None);
        assert_eq!(event("logs/HEAD"), None);
        assert_eq!(event("config"), None);
        assert_eq!(event("FETCH_HEAD"), None);
        assert_eq!(event("worktrees/wt1"), None);
    }

    #[test]
    fn resolves_main_and_linked_worktree_dirs() {
        let dir = tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);

        let main = resolve_git_dirs(&repo).expect("main worktree should resolve");
        assert_eq!(main.git_dir, repo.join(".git"));
        assert_eq!(main.common_dir, repo.join(".git"));

        let linked = root.join("wt1");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "-b",
                "wt1",
            ],
        );
        let resolved = resolve_git_dirs(&linked).expect("linked worktree should resolve");
        assert_eq!(resolved.git_dir, repo.join(".git/worktrees/wt1"));
        assert_eq!(resolved.common_dir, repo.join(".git"));

        assert!(
            resolve_git_dirs(&root).is_none(),
            "non-repo dir resolves to None"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn commit_and_stage_emit_scoped_events() {
        let dir = tempdir().unwrap();
        let repo = dunce::canonicalize(dir.path()).unwrap().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);

        let service = GitStateWatcherService::default();
        let mut subscription = service.subscribe(&repo).expect("repo should subscribe");
        wait_for_watcher_count(&service, 1).await;
        sleep(Duration::from_millis(200)).await;

        std::fs::write(repo.join("file.txt"), "two").unwrap();
        git(&repo, &["add", "."]);
        expect_kind(&mut subscription, GitStateEventKind::IndexChanged).await;

        git(&repo, &["commit", "-q", "-m", "second"]);
        expect_kind(&mut subscription, GitStateEventKind::HeadMoved).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn operation_dirs_toggle_operation_changed() {
        let dir = tempdir().unwrap();
        let repo = dunce::canonicalize(dir.path()).unwrap().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);

        let service = GitStateWatcherService::default();
        let mut subscription = service.subscribe(&repo).expect("repo should subscribe");
        wait_for_watcher_count(&service, 1).await;
        sleep(Duration::from_millis(200)).await;

        std::fs::create_dir(repo.join(".git/rebase-merge")).unwrap();
        expect_kind(&mut subscription, GitStateEventKind::OperationChanged).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn lock_files_do_not_emit() {
        let dir = tempdir().unwrap();
        let repo = dunce::canonicalize(dir.path()).unwrap().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);

        let service = GitStateWatcherService::default();
        let mut subscription = service.subscribe(&repo).expect("repo should subscribe");
        wait_for_watcher_count(&service, 1).await;
        sleep(Duration::from_millis(200)).await;

        std::fs::write(repo.join(".git/index.lock"), "lock").unwrap();
        std::fs::remove_file(repo.join(".git/index.lock")).unwrap();

        assert!(
            timeout(Duration::from_millis(500), subscription.receiver.recv())
                .await
                .is_err(),
            "lock file churn should not be forwarded"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn linked_worktrees_share_one_watcher_and_scope_local_events() {
        let dir = tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt1 = root.join("wt1");
        git(
            &repo,
            &["worktree", "add", "-q", wt1.to_str().unwrap(), "-b", "wt1"],
        );

        let service = GitStateWatcherService::default();
        let mut main_sub = service.subscribe(&repo).expect("main should subscribe");
        let mut linked_sub = service.subscribe(&wt1).expect("linked should subscribe");
        wait_for_watcher_count(&service, 1).await;
        sleep(Duration::from_millis(200)).await;

        // A commit in the linked worktree moves a shared ref: both see it.
        std::fs::write(wt1.join("file.txt"), "linked change").unwrap();
        git(&wt1, &["add", "."]);
        git(&wt1, &["commit", "-q", "-m", "linked commit"]);
        expect_kind(&mut linked_sub, GitStateEventKind::HeadMoved).await;
        expect_kind(&mut main_sub, GitStateEventKind::HeadMoved).await;

        // Staging in the linked worktree is local: tagged with its git dir,
        // so the main worktree's filter drops it.
        std::fs::write(wt1.join("file.txt"), "staged only").unwrap();
        git(&wt1, &["add", "."]);
        expect_kind(&mut linked_sub, GitStateEventKind::IndexChanged).await;

        let deadline = Instant::now() + Duration::from_millis(600);
        while let Ok(Ok(batch)) = timeout(
            deadline.saturating_duration_since(Instant::now()),
            main_sub.receiver.recv(),
        )
        .await
        {
            assert!(
                !main_sub
                    .relevant_kinds(&batch)
                    .contains(&GitStateEventKind::IndexChanged),
                "main worktree should not see the linked worktree's index change"
            );
        }
    }
}
