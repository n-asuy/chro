use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use futures::{
    channel::mpsc::{channel, Receiver},
    SinkExt,
};
use ignore::{
    gitignore::{Gitignore, GitignoreBuilder},
    WalkBuilder,
};
pub use notify_debouncer_full::DebouncedEvent;
use notify_debouncer_full::{
    new_debouncer,
    notify::{self, RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer, RecommendedCache,
};
use thiserror::Error;

type DebouncerGuard = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Tuple returned by [`watch_directory`] containing the watcher guard, event receiver
/// and canonicalized watch root.
pub type WatcherComponents = (DebouncerGuard, Receiver<DebounceEventResult>, PathBuf);

#[derive(Debug, Error)]
pub enum FilesystemWatcherError {
    #[error(transparent)]
    Notify(#[from] notify::Error),
    #[error(transparent)]
    Ignore(#[from] ignore::Error),
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("Failed to build gitignore: {0}")]
    GitignoreBuilder(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
}

/// Spin up a gitignore-aware filesystem watcher for the provided `root` directory.
///
/// This mirrors the behaviour of the reference implementation (see docs/ section 03) and is now
/// shared between crates like `diff-stream` and future filesystem APIs.
pub fn watch_directory(root: PathBuf) -> Result<WatcherComponents, FilesystemWatcherError> {
    let canonical_root = canonicalize_lossy(&root);
    let gi_set = Arc::new(build_gitignore_set(&canonical_root)?);
    let (mut tx, rx) = channel(64);

    let gi_clone = gi_set.clone();
    let root_clone = canonical_root.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                let filtered: Vec<DebouncedEvent> = events
                    .into_iter()
                    .filter(|ev| debounced_should_forward(ev, &gi_clone, &root_clone))
                    .collect();
                if !filtered.is_empty() {
                    futures::executor::block_on(async {
                        tx.send(Ok(filtered)).await.ok();
                    });
                }
            }
            Err(errors) => {
                futures::executor::block_on(async {
                    tx.send(Err(errors)).await.ok();
                });
            }
        },
    )?;

    debouncer.watch(&canonical_root, RecursiveMode::Recursive)?;

    Ok((debouncer, rx, canonical_root))
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

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

    Ok(builder
        .build()
        .map_err(|err| FilesystemWatcherError::GitignoreBuilder(err.to_string()))?)
}

fn path_allowed(path: &Path, gi: &Gitignore, canonical_root: &Path) -> bool {
    let canonical_path = canonicalize_lossy(path);
    let relative = match canonical_path.strip_prefix(canonical_root) {
        Ok(rel) => rel,
        Err(_) => return true,
    };
    let is_dir = relative.extension().is_none();
    !gi.matched_path_or_any_parents(relative, is_dir).is_ignore()
}

fn debounced_should_forward(event: &DebouncedEvent, gi: &Gitignore, canonical_root: &Path) -> bool {
    if event.kind.is_access() {
        return false;
    }
    event
        .paths
        .iter()
        .all(|path| path_allowed(path, gi, canonical_root))
}
