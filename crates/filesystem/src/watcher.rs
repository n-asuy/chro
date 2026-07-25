//! Shared, per-worktree filesystem watcher.
//!
//! A single recursive watcher is created per canonical worktree root and shared
//! by every consumer (the workspace tree and each diff stream). This collapses
//! what used to be one recursive watcher per subscription into one per worktree.
//!
//! macOS FSEvents cannot exclude subtrees at the kernel level, so ignored paths
//! (`.git`, `node_modules`, `target`, and anything gitignored) are dropped at the
//! earliest possible point: inside the watcher callback, before events ever reach
//! the debounce buffer. Surviving events are coalesced by path over a short window
//! and broadcast as batches, so heavy build/dependency churn no longer drives CPU.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use ignore::{
    gitignore::{Gitignore, GitignoreBuilder},
    WalkBuilder,
};
use notify::{
    Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use thiserror::Error;
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
    time::MissedTickBehavior,
};

/// Window over which raw events are coalesced before broadcasting a batch.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);
/// How often an idle watcher checks whether it still has subscribers.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Broadcast backlog. Each item is a coalesced batch, so this is generous.
const EVENT_CHANNEL_CAPACITY: usize = 256;
/// Raw notify callbacks can outpace an async consumer during a build storm.
/// Bounding this queue keeps that storm from becoming an unbounded heap.
const INGEST_CHANNEL_CAPACITY: usize = 8192;
/// Directories whose churn is never relevant and is dropped before debouncing.
/// `.git` is git's own metadata (never in `.gitignore`); the others are the
/// usual heavy build/dependency trees and act as a fast guard even when a repo
/// forgets to gitignore them.
const HARD_IGNORED_DIRS: [&str; 3] = [".git", "node_modules", "target"];

#[derive(Debug, Error)]
pub enum FilesystemWatcherError {
    #[error(transparent)]
    Notify(#[from] notify::Error),
    #[error(transparent)]
    Ignore(#[from] ignore::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Failed to build gitignore: {0}")]
    GitignoreBuilder(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeEventKind {
    Created,
    Modified,
    Deleted,
}

/// A coalesced change to a single path within a worktree.
#[derive(Debug, Clone)]
pub struct WorktreeEvent {
    pub kind: WorktreeEventKind,
    /// Path relative to the canonical worktree root, using `/` separators.
    pub relative_path: String,
    pub is_dir: bool,
}

/// A batch of coalesced events emitted on one debounce tick. Shared via `Arc`
/// so broadcasting to many subscribers stays cheap.
pub type WorktreeEventBatch = Arc<Vec<WorktreeEvent>>;

struct WatcherEntry {
    sender: broadcast::Sender<WorktreeEventBatch>,
    task: JoinHandle<()>,
    id: u64,
}

/// Owns one recursive watcher per canonical worktree root and hands out
/// broadcast subscriptions. Cloning shares the same underlying registry.
#[derive(Clone, Default)]
pub struct WorktreeWatcherService {
    watchers: Arc<Mutex<HashMap<PathBuf, WatcherEntry>>>,
    next_id: Arc<AtomicU64>,
}

impl WorktreeWatcherService {
    /// Subscribe to change events for `worktree_path`. Reuses an existing
    /// watcher for the same canonical path; otherwise spins one up. Returns
    /// immediately; the (blocking) gitignore scan and watcher registration run
    /// off-thread, so a brand-new subscriber may miss events for a few hundred
    /// milliseconds during setup.
    pub fn subscribe(&self, worktree_path: PathBuf) -> broadcast::Receiver<WorktreeEventBatch> {
        let canonical_root = canonicalize_lossy(&worktree_path);

        let mut watchers = self.watchers.lock().unwrap();

        // Drop a dead entry (its task exited) before reusing the slot.
        if watchers
            .get(&canonical_root)
            .is_some_and(|entry| entry.task.is_finished())
        {
            watchers.remove(&canonical_root);
        }

        if let Some(entry) = watchers.get(&canonical_root) {
            return entry.sender.subscribe();
        }

        let (sender, receiver) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let task = self.spawn_watcher(canonical_root.clone(), id, sender.clone());
        watchers.insert(canonical_root, WatcherEntry { sender, task, id });
        receiver
    }

    fn remove_if_matching(&self, canonical_root: &Path, id: u64) {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers
            .get(canonical_root)
            .is_some_and(|entry| entry.id == id)
        {
            watchers.remove(canonical_root);
        }
    }

    fn spawn_watcher(
        &self,
        canonical_root: PathBuf,
        id: u64,
        sender: broadcast::Sender<WorktreeEventBatch>,
    ) -> JoinHandle<()> {
        let this = self.clone();

        tokio::spawn(async move {
            let (ingest_tx, mut ingest_rx) =
                mpsc::channel::<(WorktreeEventKind, String, PathBuf)>(INGEST_CHANNEL_CAPACITY);
            let overflowed = Arc::new(AtomicBool::new(false));

            let build_root = canonical_root.clone();
            let callback_overflowed = overflowed.clone();
            let watcher = match tokio::task::spawn_blocking(move || {
                build_watcher(&build_root, ingest_tx, callback_overflowed)
            })
            .await
            {
                Ok(Ok(watcher)) => watcher,
                Ok(Err(err)) => {
                    tracing::error!(
                        root = %canonical_root.display(),
                        "failed to build worktree watcher: {err}"
                    );
                    this.remove_if_matching(&canonical_root, id);
                    return;
                }
                Err(join_err) => {
                    tracing::error!("worktree watcher build join error: {join_err}");
                    this.remove_if_matching(&canonical_root, id);
                    return;
                }
            };
            // Keep the watcher alive for as long as this task runs.
            let _watcher = watcher;

            let mut pending: HashMap<String, (WorktreeEventKind, PathBuf)> = HashMap::new();
            let mut flush = tokio::time::interval(DEBOUNCE_WINDOW);
            flush.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut idle = tokio::time::interval(IDLE_POLL_INTERVAL);
            idle.set_missed_tick_behavior(MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    received = ingest_rx.recv() => {
                        match received {
                            Some((kind, relative_path, absolute_path)) => {
                                // Last write wins within the window.
                                pending.insert(relative_path, (kind, absolute_path));
                            }
                            None => break,
                        }
                    }
                    _ = flush.tick() => {
                        let did_overflow = overflowed.swap(false, Ordering::AcqRel);
                        if pending.is_empty() && !did_overflow {
                            continue;
                        }
                        let mut batch: Vec<WorktreeEvent> = pending
                            .drain()
                            .map(|(relative_path, (kind, absolute_path))| WorktreeEvent {
                                kind,
                                is_dir: absolute_path.is_dir(),
                                relative_path,
                            })
                            .collect();
                        if did_overflow {
                            // Empty path is an internal resync marker. Consumers
                            // that maintain derived state perform a full refresh.
                            batch.push(WorktreeEvent {
                                kind: WorktreeEventKind::Modified,
                                relative_path: String::new(),
                                is_dir: true,
                            });
                        }
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

            this.remove_if_matching(&canonical_root, id);
        })
    }

    #[cfg(test)]
    fn watcher_count(&self) -> usize {
        self.watchers.lock().unwrap().len()
    }
}

/// Build a recursive watcher whose callback filters ignored paths before they
/// reach the debounce buffer, forwarding survivors on `ingest_tx`.
fn build_watcher(
    canonical_root: &Path,
    ingest_tx: mpsc::Sender<(WorktreeEventKind, String, PathBuf)>,
    overflowed: Arc<AtomicBool>,
) -> Result<RecommendedWatcher, FilesystemWatcherError> {
    let gitignore = build_gitignore_set(canonical_root)?;
    let root = canonical_root.to_path_buf();

    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            let kind = match event.kind {
                EventKind::Create(_) => WorktreeEventKind::Created,
                EventKind::Modify(_) => WorktreeEventKind::Modified,
                EventKind::Remove(_) => WorktreeEventKind::Deleted,
                // Access / Any / Other carry no actionable change.
                _ => return,
            };

            for absolute_path in event.paths {
                let Ok(relative) = absolute_path.strip_prefix(&root) else {
                    continue;
                };
                if relative.as_os_str().is_empty() || is_ignored(relative, &gitignore) {
                    continue;
                }
                let relative_path = relative.to_string_lossy().replace('\\', "/");
                // Channel only closes once this watcher is dropped; ignore errors.
                if matches!(
                    ingest_tx.try_send((kind, relative_path, absolute_path)),
                    Err(mpsc::error::TrySendError::Full(_))
                ) {
                    overflowed.store(true, Ordering::Release);
                }
            }
        },
        NotifyConfig::default(),
    )?;

    watcher.watch(canonical_root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Collect every `.gitignore` reachable under `root` (skipping ignored dirs) into
/// a single matcher, plus the repo's `.git/info/exclude`.
fn build_gitignore_set(root: &Path) -> Result<Gitignore, FilesystemWatcherError> {
    let mut builder = GitignoreBuilder::new(root);

    WalkBuilder::new(root)
        .follow_links(false)
        .hidden(false)
        .filter_entry(|entry| {
            entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                || entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name == ".gitignore")
        })
        .build()
        .try_for_each(|result| match result {
            Ok(dir_entry) => {
                if !dir_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    builder.add(dir_entry.path());
                }
                Ok(())
            }
            Err(err)
                if err.io_error().is_some_and(|io_err| {
                    io_err.kind() == std::io::ErrorKind::PermissionDenied
                }) =>
            {
                tracing::warn!("Permission denied reading path: {}", err);
                Ok(())
            }
            Err(e) => Err(FilesystemWatcherError::Ignore(e)),
        })?;

    let info_exclude = root.join(".git/info/exclude");
    if info_exclude.exists() {
        builder.add(info_exclude);
    }

    builder
        .build()
        .map_err(|err| FilesystemWatcherError::GitignoreBuilder(err.to_string()))
}

/// Whether `relative` (relative to the worktree root) should be dropped.
fn is_ignored(relative: &Path, gitignore: &Gitignore) -> bool {
    for component in relative.components() {
        if let std::path::Component::Normal(name) = component {
            if name
                .to_str()
                .is_some_and(|n| HARD_IGNORED_DIRS.contains(&n))
            {
                return true;
            }
        }
    }

    // Directory-ness is unknown without a stat; the extension heuristic matches
    // the previous behaviour and avoids a syscall on the hot path.
    let is_dir = relative.extension().is_none();
    gitignore
        .matched_path_or_any_parents(relative, is_dir)
        .is_ignore()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;
    use tokio::time::{sleep, timeout, Duration, Instant};

    async fn wait_for_watcher_count(service: &WorktreeWatcherService, expected: usize) {
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

    async fn next_event(rx: &mut broadcast::Receiver<WorktreeEventBatch>) -> Vec<WorktreeEvent> {
        let batch = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("expected a watcher event batch")
            .expect("watcher receiver should stay open");
        batch.as_ref().clone()
    }

    #[tokio::test]
    async fn watchers_are_shared_per_path_and_reaped_when_idle() {
        let service = WorktreeWatcherService::default();
        let dir = tempdir().unwrap();

        let rx1 = service.subscribe(dir.path().to_path_buf());
        let rx2 = service.subscribe(dir.path().to_path_buf());

        wait_for_watcher_count(&service, 1).await;

        drop(rx1);
        drop(rx2);

        wait_for_watcher_count(&service, 0).await;
    }

    #[tokio::test]
    async fn emits_changes_only_for_the_matching_worktree() {
        let service = WorktreeWatcherService::default();
        let dir1 = tempdir().unwrap();
        let dir2 = tempdir().unwrap();

        let mut rx1 = service.subscribe(dir1.path().to_path_buf());
        let mut rx2 = service.subscribe(dir2.path().to_path_buf());

        wait_for_watcher_count(&service, 2).await;
        sleep(Duration::from_millis(150)).await;

        fs::write(dir1.path().join("alpha.txt"), "hello").unwrap();

        let events = next_event(&mut rx1).await;
        assert!(events.iter().any(|e| e.relative_path == "alpha.txt"
            && matches!(
                e.kind,
                WorktreeEventKind::Created | WorktreeEventKind::Modified
            )));

        assert!(
            timeout(Duration::from_millis(400), rx2.recv())
                .await
                .is_err(),
            "worktree 2 unexpectedly received an event from worktree 1"
        );
    }

    #[tokio::test]
    async fn ignored_directories_do_not_produce_events() {
        let service = WorktreeWatcherService::default();
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("target/debug")).unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();

        let mut rx = service.subscribe(dir.path().to_path_buf());
        wait_for_watcher_count(&service, 1).await;
        sleep(Duration::from_millis(150)).await;

        // Churn inside ignored directories: must be filtered out entirely.
        fs::write(dir.path().join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(dir.path().join("target/debug/app"), "bin").unwrap();
        fs::write(dir.path().join(".git/index"), "idx").unwrap();

        assert!(
            timeout(Duration::from_millis(500), rx.recv())
                .await
                .is_err(),
            "ignored directory churn should not be forwarded"
        );

        // A real source change still comes through on the same watcher.
        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
        let events = next_event(&mut rx).await;
        assert!(events.iter().any(|e| e.relative_path == "main.rs"));
    }

    #[tokio::test]
    async fn rapid_writes_are_coalesced_into_a_batch() {
        let service = WorktreeWatcherService::default();
        let dir = tempdir().unwrap();

        let mut rx = service.subscribe(dir.path().to_path_buf());
        wait_for_watcher_count(&service, 1).await;
        sleep(Duration::from_millis(150)).await;

        for i in 0..5 {
            fs::write(dir.path().join(format!("file_{i}.txt")), "data").unwrap();
        }

        let events = next_event(&mut rx).await;
        // All five distinct files should arrive coalesced; at minimum several
        // share one batch rather than each forcing its own notification.
        let distinct = events
            .iter()
            .map(|e| e.relative_path.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert!(
            distinct.len() >= 2,
            "expected rapid writes to coalesce, got {distinct:?}"
        );
    }
}
