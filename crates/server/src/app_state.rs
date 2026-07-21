use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use local_runtime::LocalRuntime;
use runtime::Runtime;
use serde_json::json;
use sqlx::{Pool, Sqlite};

use crate::browser_session::BrowserService;
use crate::perf;
use crate::routes::rpc::cli_status::LatestReleaseCache;
use crate::routes::rpc::usage::UsageCache;

/// Once-per-process gate for index pre-warming, keyed by canonical repo path.
/// A single warm is enough: afterwards the lazy paths keep each index fresh
/// (the cbase index self-invalidates by mtime; the name-search FST rebuilds on
/// HeadMoved via its git-state subscription).
#[derive(Default)]
pub(crate) struct PrewarmRegistry {
    warmed: Mutex<HashSet<PathBuf>>,
}

impl PrewarmRegistry {
    /// True exactly once per canonical path for the process lifetime.
    pub(crate) fn first_visit(&self, path: &Path) -> bool {
        let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        self.warmed.lock().unwrap().insert(canonical)
    }
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) runtime: LocalRuntime,
    pub(crate) browser: Arc<BrowserService>,
    pub(crate) latest_release_cache: Arc<LatestReleaseCache>,
    pub(crate) usage_cache: Arc<UsageCache>,
    /// Shared incremental frontmatter index reused across `.cbase` queries so
    /// repeated queries (tab re-activation) skip re-reading unchanged files.
    pub(crate) cbase_index: cbase::CbaseIndexCache,
    pub(crate) prewarm: Arc<PrewarmRegistry>,
}

impl AppState {
    pub(crate) fn new(runtime: LocalRuntime) -> Self {
        Self {
            runtime,
            browser: Arc::new(BrowserService::new()),
            latest_release_cache: Arc::new(LatestReleaseCache::new()),
            usage_cache: Arc::new(UsageCache::new()),
            cbase_index: cbase::CbaseIndexCache::new(),
            prewarm: Arc::new(PrewarmRegistry::default()),
        }
    }

    /// Warm the lazy indexes for a project the user just opened, in the
    /// background: the cbase frontmatter index (any later `.cbase` query hits
    /// warm per-file entries) and, for git repos, the name-search FST plus its
    /// HeadMoved invalidation wiring. Best-effort and once per process per
    /// path; never blocks the calling request.
    pub(crate) fn spawn_index_prewarm(&self, repo_path: PathBuf) {
        if !repo_path.is_dir() || !self.prewarm.first_visit(&repo_path) {
            return;
        }

        let runtime = self.runtime.clone();
        let cbase_index = self.cbase_index.clone();
        tokio::spawn(async move {
            let is_git_repo = repo_path.join(".git").exists();
            if is_git_repo {
                runtime.ensure_search_cache_watch(&repo_path);
                if let Err(err) = runtime.file_search_cache().warm(&repo_path).await {
                    tracing::debug!(root = %repo_path.display(), "file-search warm skipped: {err}");
                }
            }

            let started = std::time::Instant::now();
            let walk_root = repo_path.clone();
            let indexed = tokio::task::spawn_blocking(move || {
                let dataset = cbase::CbaseDataset {
                    include: vec!["**/*.md".to_string()],
                    exclude: None,
                };
                cbase_index.index_project(&walk_root, &dataset)
            })
            .await;

            match indexed {
                Ok(Ok(rows)) => {
                    perf::record_backend_event(
                        "index_prewarm",
                        json!({
                            "root": repo_path.display().to_string(),
                            "cbase_files": rows.len(),
                            "cbase_ms": perf::elapsed_ms(started),
                            "fst_enqueued": is_git_repo,
                        }),
                    );
                }
                Ok(Err(err)) => {
                    tracing::debug!(root = %repo_path.display(), "cbase prewarm failed: {err}");
                }
                Err(join_err) => {
                    tracing::debug!("cbase prewarm join error: {join_err}");
                }
            }
        });
    }

    pub(crate) fn cbase_index(&self) -> &cbase::CbaseIndexCache {
        &self.cbase_index
    }

    pub(crate) fn latest_release_cache(&self) -> &Arc<LatestReleaseCache> {
        &self.latest_release_cache
    }

    pub(crate) fn usage_cache(&self) -> &Arc<UsageCache> {
        &self.usage_cache
    }

    pub(crate) fn pool(&self) -> &Pool<Sqlite> {
        self.runtime.db().pool()
    }

    pub(crate) fn runtime(&self) -> &LocalRuntime {
        &self.runtime
    }

    pub(crate) fn browser(&self) -> &Arc<BrowserService> {
        &self.browser
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prewarm_registry_gates_once_per_canonical_path() {
        let registry = PrewarmRegistry::default();
        let dir = tempfile::tempdir().unwrap();

        assert!(registry.first_visit(dir.path()));
        assert!(!registry.first_visit(dir.path()));

        // A non-canonical spelling of the same directory is still deduped.
        let dotted = dir.path().join(".");
        assert!(!registry.first_visit(&dotted));

        let other = tempfile::tempdir().unwrap();
        assert!(registry.first_visit(other.path()));
    }
}
