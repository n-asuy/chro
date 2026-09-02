//! Incremental, mtime-keyed frontmatter index cache.
//!
//! [`index_project`](crate::index_project) walks the whole project and reads +
//! parses the frontmatter of every matching file on every query. For a large
//! vault that dominates query latency, and the workspace re-queries a `.cbase`
//! whenever its tab is (re)opened. This cache keeps the parsed frontmatter of
//! each file keyed by its absolute path + modification time: a query still
//! walks the tree (a cheap stat-only pass), but only files whose mtime changed
//! are re-read and re-parsed. Unchanged files reuse their cached row.
//!
//! The cache is shared (interior-mutable) so one instance can back every query
//! for a process. Entries are keyed by absolute path, so a single cache serves
//! multiple project roots without collision. A hard entry/byte budget prevents
//! renamed or deleted files from accumulating for the process lifetime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use ignore::WalkBuilder;
use indexmap::IndexMap;
use serde_json::Value as JsonValue;

use crate::error::CbaseError;
use document::frontmatter::read_file_properties;
use crate::glob::DatasetMatcher;
use crate::types::{CbaseDataset, CbaseRow};

/// A file's parsed frontmatter plus the mtime it was parsed at.
#[derive(Clone)]
struct CachedFile {
    modified: Option<SystemTime>,
    modified_at: Option<String>,
    values: IndexMap<String, JsonValue>,
    estimated_bytes: usize,
}

const MAX_CACHED_FILES: usize = 50_000;
const MAX_CACHED_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct CacheState {
    files: HashMap<PathBuf, CachedFile>,
    estimated_bytes: usize,
}

/// Process-wide incremental index cache. Cloneable handle over shared state.
#[derive(Clone, Default)]
pub struct CbaseIndexCache {
    files: std::sync::Arc<Mutex<CacheState>>,
}

impl CbaseIndexCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Walk `root` and return the rows matching `dataset`, re-reading only the
    /// files whose mtime changed since they were last cached.
    pub fn index_project(
        &self,
        root: &Path,
        dataset: &CbaseDataset,
    ) -> Result<Vec<CbaseRow>, CbaseError> {
        let matcher = DatasetMatcher::new(dataset);
        let mut rows: Vec<CbaseRow> = Vec::new();

        let walker = WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(true)
            .git_exclude(true)
            .git_global(false)
            .require_git(false)
            .build();

        for entry in walker.flatten() {
            if entry.file_type().is_none_or(|ft| !ft.is_file()) {
                continue;
            }
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative_path = to_relative_string(relative);
            if relative_path.is_empty()
                || relative
                    .components()
                    .any(|component| component.as_os_str() == ".git")
            {
                continue;
            }
            if !matcher.matches(&relative_path) {
                continue;
            }

            let modified = path.metadata().ok().and_then(|meta| meta.modified().ok());
            let cached = self.get_or_read(path, modified);
            let Some(cached) = cached else {
                continue; // unreadable file, skip (matches index_project)
            };

            rows.push(CbaseRow {
                file_path: relative_path.clone(),
                display_name: document::name::display_name(&relative_path),
                modified_at: cached.modified_at,
                values: cached.values,
            });
        }

        rows.sort_by(|a, b| a.file_path.cmp(&b.file_path));
        Ok(rows)
    }

    /// Reuse the cached parse when the mtime matches; otherwise read + parse and
    /// update the cache. Returns `None` when the file cannot be read.
    fn get_or_read(&self, path: &Path, modified: Option<SystemTime>) -> Option<CachedFile> {
        {
            let state = self.files.lock().unwrap();
            if let Some(entry) = state.files.get(path) {
                // Reuse only when both sides have an mtime and they agree; a
                // missing mtime is treated as "always re-read" for safety.
                if entry.modified.is_some() && entry.modified == modified {
                    return Some(entry.clone());
                }
            }
        }

        // Only the leading frontmatter block is needed; never read the body.
        let values = read_file_properties(path).ok()?;
        let modified_at = modified
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true));
        let estimated_bytes = path.to_string_lossy().len()
            + modified_at.as_ref().map_or(0, String::len)
            + serde_json::to_vec(&values).map_or(0, |encoded| encoded.len());
        let entry = CachedFile {
            modified,
            modified_at,
            values,
            estimated_bytes,
        };
        if estimated_bytes <= MAX_CACHED_BYTES {
            let mut state = self.files.lock().unwrap();
            if let Some(previous) = state.files.remove(path) {
                state.estimated_bytes = state
                    .estimated_bytes
                    .saturating_sub(previous.estimated_bytes);
            }
            state.estimated_bytes = state.estimated_bytes.saturating_add(estimated_bytes);
            state.files.insert(path.to_path_buf(), entry.clone());

            // A bounded cache is preferable to retaining every renamed/deleted
            // file seen over a long-running process. HashMap eviction is
            // intentionally simple here; mtime checks keep refills correct.
            while state.files.len() > MAX_CACHED_FILES || state.estimated_bytes > MAX_CACHED_BYTES {
                let Some(victim) = state.files.keys().next().cloned() else {
                    break;
                };
                if let Some(removed) = state.files.remove(&victim) {
                    state.estimated_bytes = state
                        .estimated_bytes
                        .saturating_sub(removed.estimated_bytes);
                }
            }
        }
        Some(entry)
    }
}



fn to_relative_string(relative: &Path) -> String {
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    fn dataset(include: &[&str]) -> CbaseDataset {
        CbaseDataset {
            include: include.iter().map(|s| s.to_string()).collect(),
            exclude: None,
        }
    }

    #[test]
    fn indexes_then_serves_unchanged_files_from_cache() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "---\ntitle: A\n---\n").unwrap();
        fs::write(root.join("b.md"), "---\ntitle: B\n---\n").unwrap();

        let cache = CbaseIndexCache::new();
        let rows = cache.index_project(root, &dataset(&["**/*.md"])).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].values.get("title"), Some(&json!("A")));

        // Delete the file from disk but keep its mtime-cached row reachable only
        // through the cache: a second index still finds both via the walk, and
        // the unchanged files are served without re-reading. Simplest black-box
        // check: a second call returns identical rows.
        let rows2 = cache.index_project(root, &dataset(&["**/*.md"])).unwrap();
        assert_eq!(rows2.len(), 2);
        assert_eq!(rows2[1].values.get("title"), Some(&json!("B")));
    }

    #[test]
    fn reparses_when_mtime_changes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let file = root.join("a.md");
        fs::write(&file, "---\ntitle: First\n---\n").unwrap();

        let cache = CbaseIndexCache::new();
        let rows = cache.index_project(root, &dataset(&["**/*.md"])).unwrap();
        assert_eq!(rows[0].values.get("title"), Some(&json!("First")));

        // Rewrite with a bumped mtime so the cache must re-read.
        fs::write(&file, "---\ntitle: Second\n---\n").unwrap();
        let later = SystemTime::now() + std::time::Duration::from_secs(2);
        filetime::set_file_mtime(&file, filetime::FileTime::from_system_time(later)).unwrap();

        let rows2 = cache.index_project(root, &dataset(&["**/*.md"])).unwrap();
        assert_eq!(rows2[0].values.get("title"), Some(&json!("Second")));
    }

    #[test]
    fn respects_dataset_glob() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::write(root.join("tasks/x.md"), "---\ntitle: X\n---\n").unwrap();
        fs::write(root.join("other.md"), "---\ntitle: O\n---\n").unwrap();

        let cache = CbaseIndexCache::new();
        let rows = cache
            .index_project(root, &dataset(&["tasks/**/*.md"]))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, "tasks/x.md");
    }
}
