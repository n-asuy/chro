use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use fst::{Map, MapBuilder};
use git2::{Repository, Sort};
use grep_regex::RegexMatcher;
use grep_searcher::{sinks::UTF8, Searcher};
use ignore::WalkBuilder;
use moka::future::Cache;
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

/// Search mode for different use cases
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    TaskForm, // Default: exclude ignored files (clean results)
    Settings, // Include ignored files (for project config like .env)
}

/// Search query parameters
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default)]
    pub mode: SearchMode,
}

/// Search result returned to clients
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub is_file: bool,
    pub match_type: SearchMatchType,
}

/// Type of match for search results
#[derive(Debug, Clone, Serialize)]
pub enum SearchMatchType {
    FileName,
    DirectoryName,
    FullPath,
    ContentMatch,
}

/// Statistics for a single file based on git history
#[derive(Clone, Debug)]
pub struct FileStat {
    /// Index in the commit history (0 = HEAD, 1 = parent of HEAD, ...)
    pub last_index: usize,
    /// Number of times this file was changed in recent commits
    pub commit_count: u32,
    /// Timestamp of the most recent change
    pub last_time: DateTime<Utc>,
}

/// File statistics for a repository
pub type FileStats = HashMap<String, FileStat>;

/// FST-indexed file search result
#[derive(Clone, Debug)]
pub struct IndexedFile {
    pub path: String,
    pub is_file: bool,
    pub match_type: SearchMatchType,
    pub path_lowercase: Arc<str>,
    pub is_ignored: bool,
}

/// Cached repository data with FST index and git stats
#[derive(Clone)]
pub struct CachedRepo {
    pub head_sha: String,
    pub fst_index: Map<Vec<u8>>,
    pub indexed_files: Vec<IndexedFile>,
    pub stats: Arc<FileStats>,
    pub build_ts: Instant,
}

/// Cache miss error
#[derive(Debug)]
pub enum CacheError {
    Miss,
    BuildError(String),
}

#[derive(Debug, Error)]
pub enum FileSearchError {
    #[error("repository does not exist: {0}")]
    RepoMissing(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    Fst(#[from] fst::Error),
    #[error("invalid repository: {0}")]
    InvalidRepository(String),
}

/// Configuration constants for ranking algorithm
const DEFAULT_COMMIT_LIMIT: usize = 100;
const BASE_MATCH_SCORE_FILENAME: i64 = 100;
const BASE_MATCH_SCORE_DIRNAME: i64 = 10;
const BASE_MATCH_SCORE_FULLPATH: i64 = 1;
const RECENCY_WEIGHT: i64 = 2;
const FREQUENCY_WEIGHT: i64 = 1;

/// File search cache with FST indexing
pub struct FileSearchCache {
    cache: Cache<PathBuf, CachedRepo>,
    build_queue: mpsc::UnboundedSender<PathBuf>,
    watchers: DashMap<PathBuf, ()>,
}

impl FileSearchCache {
    pub fn new() -> Self {
        let (build_sender, build_receiver) = mpsc::unbounded_channel();

        let cache = Cache::builder()
            .max_capacity(50)
            .time_to_live(Duration::from_secs(3600))
            .build();

        let cache_for_worker = cache.clone();

        tokio::spawn(async move {
            Self::background_worker(build_receiver, cache_for_worker).await;
        });

        Self {
            cache,
            build_queue: build_sender,
            watchers: DashMap::new(),
        }
    }

    /// Search files in repository using cache
    pub async fn search(
        &self,
        repo_path: &Path,
        query: &str,
        mode: SearchMode,
    ) -> Result<Vec<SearchResult>, CacheError> {
        let repo_path_buf = repo_path.to_path_buf();

        if let Some(cached) = self.cache.get(&repo_path_buf).await {
            if let Ok(head_sha) = get_head_sha(&repo_path_buf) {
                if head_sha == cached.head_sha {
                    return Ok(self.search_in_cache(&cached, repo_path, query, mode, 10));
                }
            }
        }

        if let Err(e) = self.build_queue.send(repo_path_buf) {
            warn!("Failed to enqueue cache build: {}", e);
        }

        Err(CacheError::Miss)
    }

    /// Search within cached index with mode-based filtering, including content search
    fn search_in_cache(
        &self,
        cached: &CachedRepo,
        repo_path: &Path,
        query: &str,
        mode: SearchMode,
        limit: usize,
    ) -> Vec<SearchResult> {
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        let mut seen_paths: HashSet<String> = HashSet::new();

        for indexed_file in &cached.indexed_files {
            if indexed_file.path_lowercase.contains(&query_lower) {
                match mode {
                    SearchMode::TaskForm => {
                        if indexed_file.is_ignored {
                            continue;
                        }
                    }
                    SearchMode::Settings => {}
                }

                seen_paths.insert(indexed_file.path.clone());
                results.push(SearchResult {
                    path: indexed_file.path.clone(),
                    is_file: indexed_file.is_file,
                    match_type: indexed_file.match_type.clone(),
                });
            }
        }

        rerank(&mut results, &cached.stats);
        results.truncate(limit);

        if results.len() < limit {
            let remaining = limit - results.len();
            if let Ok(content_results) = search_content(repo_path, query, remaining * 2) {
                for content_result in content_results {
                    if results.len() >= limit {
                        break;
                    }
                    if !seen_paths.contains(&content_result.path) {
                        seen_paths.insert(content_result.path.clone());
                        results.push(SearchResult {
                            path: content_result.path,
                            is_file: true,
                            match_type: SearchMatchType::ContentMatch,
                        });
                    }
                }
            }
        }

        results
    }

    /// Pre-warm cache for given repository
    pub async fn warm(&self, repo_path: &Path) -> Result<(), FileSearchError> {
        if !repo_path.exists() {
            return Err(FileSearchError::RepoMissing(repo_path.display().to_string()));
        }

        if let Err(e) = self.build_queue.send(repo_path.to_path_buf()) {
            error!("Failed to enqueue repo for warming: {:?} - {}", repo_path, e);
        }
        Ok(())
    }

    /// Setup file watcher for repository HEAD changes
    pub async fn setup_watcher(&self, repo_path: &Path) -> Result<(), String> {
        let repo_path_buf = repo_path.to_path_buf();

        if self.watchers.contains_key(&repo_path_buf) {
            return Ok(());
        }

        let git_dir = repo_path.join(".git");
        if !git_dir.exists() {
            return Err("Not a git repository".to_string());
        }

        let build_queue = self.build_queue.clone();
        let watched_path = repo_path_buf.clone();

        let (tx, mut rx) = mpsc::unbounded_channel();

        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            None,
            move |res: DebounceEventResult| {
                if let Ok(events) = res {
                    for event in events {
                        for path in &event.event.paths {
                            if path.file_name().is_some_and(|name| name == "HEAD") {
                                if let Err(e) = tx.send(()) {
                                    error!("Failed to send HEAD change event: {}", e);
                                }
                                break;
                            }
                        }
                    }
                }
            },
        )
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        debouncer
            .watcher()
            .watch(git_dir.join("HEAD").as_path(), RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch HEAD file: {e}"))?;

        self.watchers.insert(repo_path_buf.clone(), ());

        tokio::spawn(async move {
            let _debouncer = debouncer;
            while rx.recv().await.is_some() {
                info!("HEAD changed for repo: {:?}", watched_path);
                if let Err(e) = build_queue.send(watched_path.clone()) {
                    error!("Failed to enqueue cache refresh: {}", e);
                }
            }
        });

        info!("Setup file watcher for repo: {:?}", repo_path);
        Ok(())
    }

    /// Background worker for cache building
    async fn background_worker(
        mut build_receiver: mpsc::UnboundedReceiver<PathBuf>,
        cache: Cache<PathBuf, CachedRepo>,
    ) {
        while let Some(repo_path) = build_receiver.recv().await {
            match build_repo_cache(&repo_path).await {
                Ok(cached_repo) => {
                    cache.insert(repo_path.clone(), cached_repo).await;
                    info!("Successfully cached repo: {:?}", repo_path);
                }
                Err(e) => {
                    error!("Failed to cache repo {:?}: {}", repo_path, e);
                }
            }
        }
    }

    /// Fallback search without cache (filesystem traversal with content search)
    pub fn search_fallback(
        &self,
        repo_path: &Path,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, FileSearchError> {
        search_combined(repo_path, query, limit)
    }
}

impl Default for FileSearchCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Build cache entry for a repository
async fn build_repo_cache(repo_path: &Path) -> Result<CachedRepo, FileSearchError> {
    info!("Building cache for repo: {:?}", repo_path);

    let head_sha = get_head_sha(repo_path)?;
    let stats = collect_file_stats(repo_path)?;
    let (indexed_files, fst_map) = build_file_index(repo_path)?;

    Ok(CachedRepo {
        head_sha,
        fst_index: fst_map,
        indexed_files,
        stats: Arc::new(stats),
        build_ts: Instant::now(),
    })
}

/// Get HEAD SHA from repository
fn get_head_sha(repo_path: &Path) -> Result<String, FileSearchError> {
    let repo = Repository::open(repo_path)?;
    let head = repo.head()?;
    let oid = head
        .target()
        .ok_or_else(|| FileSearchError::InvalidRepository("HEAD has no target".into()))?;
    Ok(oid.to_string())
}

/// Collect file statistics from git history
fn collect_file_stats(repo_path: &Path) -> Result<FileStats, FileSearchError> {
    let repo = Repository::open(repo_path)?;
    let mut stats: FileStats = HashMap::new();

    let mut revwalk = repo.revwalk()?;
    if revwalk.push_head().is_err() {
        return Ok(stats);
    }
    revwalk.set_sorting(Sort::TIME)?;

    for (commit_index, oid_result) in revwalk.take(DEFAULT_COMMIT_LIMIT).enumerate() {
        let Ok(oid) = oid_result else { continue };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };

        let commit_time = {
            let time = commit.time();
            DateTime::from_timestamp(time.seconds(), 0).unwrap_or_else(Utc::now)
        };

        let Ok(commit_tree) = commit.tree() else {
            continue;
        };

        let parent_tree = if commit.parent_count() == 0 {
            None
        } else {
            commit.parent(0).ok().and_then(|p| p.tree().ok())
        };

        let Ok(diff) = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        else {
            continue;
        };

        let _ = diff.foreach(
            &mut |delta, _progress| {
                if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) {
                    let path_str = path.to_string_lossy().to_string();
                    let stat = stats.entry(path_str).or_insert(FileStat {
                        last_index: commit_index,
                        commit_count: 0,
                        last_time: commit_time,
                    });
                    stat.commit_count += 1;
                }
                true
            },
            None,
            None,
            None,
        );
    }

    Ok(stats)
}

/// Build FST index from filesystem traversal
fn build_file_index(repo_path: &Path) -> Result<(Vec<IndexedFile>, Map<Vec<u8>>), FileSearchError> {
    let mut indexed_files = Vec::new();
    let mut fst_keys = Vec::new();

    let mut builder = WalkBuilder::new(repo_path);
    builder
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .hidden(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git" && name != "node_modules" && name != "target" && name != "dist" && name != "build"
        });

    let walker = builder.build();

    let ignore_walker = WalkBuilder::new(repo_path)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .hidden(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git"
        })
        .build();

    let mut non_ignored_paths = HashSet::new();
    for result in ignore_walker.flatten() {
        if let Ok(relative_path) = result.path().strip_prefix(repo_path) {
            non_ignored_paths.insert(relative_path.to_path_buf());
        }
    }

    for result in walker {
        let entry = result.map_err(|e| {
            FileSearchError::Io(std::io::Error::other(e.to_string()))
        })?;
        let path = entry.path();

        if path == repo_path {
            continue;
        }

        let Ok(relative_path) = path.strip_prefix(repo_path) else {
            continue;
        };
        let relative_path_str = relative_path.to_string_lossy().to_string();
        let relative_path_lower = relative_path_str.to_lowercase();

        if relative_path_lower.is_empty() {
            continue;
        }

        let is_ignored = !non_ignored_paths.contains(relative_path);

        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let match_type = if !file_name.is_empty() {
            SearchMatchType::FileName
        } else if path
            .parent()
            .and_then(|p| p.file_name())
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default()
            != relative_path_lower
        {
            SearchMatchType::DirectoryName
        } else {
            SearchMatchType::FullPath
        };

        let indexed_file = IndexedFile {
            path: relative_path_str,
            is_file: path.is_file(),
            match_type,
            path_lowercase: Arc::from(relative_path_lower.as_str()),
            is_ignored,
        };

        let file_index = indexed_files.len() as u64;
        fst_keys.push((relative_path_lower, file_index));
        indexed_files.push(indexed_file);
    }

    fst_keys.sort_by(|a, b| a.0.cmp(&b.0));
    fst_keys.dedup_by(|a, b| a.0 == b.0);

    let mut fst_builder = MapBuilder::memory();
    for (key, value) in fst_keys {
        fst_builder.insert(&key, value)?;
    }

    let fst_map = fst_builder.into_map();
    Ok((indexed_files, fst_map))
}

/// Re-rank search results based on git history statistics
fn rerank(results: &mut [SearchResult], stats: &FileStats) {
    results.sort_by(|a, b| {
        let score_a = calculate_score(a, stats);
        let score_b = calculate_score(b, stats);
        score_b.cmp(&score_a)
    });
}

/// Calculate relevance score for a search result
fn calculate_score(result: &SearchResult, stats: &FileStats) -> i64 {
    let base_score = match result.match_type {
        SearchMatchType::FileName => BASE_MATCH_SCORE_FILENAME,
        SearchMatchType::DirectoryName => BASE_MATCH_SCORE_DIRNAME,
        SearchMatchType::FullPath => BASE_MATCH_SCORE_FULLPATH,
        SearchMatchType::ContentMatch => BASE_MATCH_SCORE_FULLPATH / 2,
    };

    if let Some(stat) = stats.get(&result.path) {
        let recency_bonus = (100 - stat.last_index.min(99) as i64) * RECENCY_WEIGHT;
        let frequency_bonus = stat.commit_count as i64 * FREQUENCY_WEIGHT;
        base_score * 1000 + recency_bonus * 10 + frequency_bonus
    } else {
        base_score * 1000
    }
}

/// Content match result with line information
#[derive(Debug, Clone, Serialize)]
pub struct ContentSearchResult {
    pub path: String,
    pub line_number: u64,
    pub line_content: String,
}

/// Search for content within files using ripgrep
pub fn search_content(
    repo_path: &Path,
    pattern: &str,
    limit: usize,
) -> Result<Vec<ContentSearchResult>, FileSearchError> {
    if !repo_path.exists() {
        return Err(FileSearchError::RepoMissing(repo_path.display().to_string()));
    }

    let matcher = RegexMatcher::new_line_matcher(&format!("(?i){}", regex::escape(pattern)))
        .map_err(|e| FileSearchError::InvalidRepository(format!("Invalid pattern: {e}")))?;

    let mut results = Vec::new();

    let walker = WalkBuilder::new(repo_path)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git"
                && name != "node_modules"
                && name != "target"
                && name != "dist"
                && name != "build"
        })
        .build();

    for entry in walker.flatten() {
        if results.len() >= limit {
            break;
        }

        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        if is_likely_binary(path) {
            continue;
        }

        let mut searcher = Searcher::new();
        let relative_path = path
            .strip_prefix(repo_path)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let relative_path_clone = relative_path.clone();
        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_num, line| {
                if results.len() < limit {
                    results.push(ContentSearchResult {
                        path: relative_path_clone.clone(),
                        line_number: line_num,
                        line_content: line.trim().to_string(),
                    });
                }
                Ok(results.len() < limit)
            }),
        );
    }

    Ok(results)
}

/// Check if a file is likely binary based on extension
fn is_likely_binary(path: &Path) -> bool {
    let binary_extensions = [
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "pdf", "zip", "tar", "gz", "rar",
        "7z", "exe", "dll", "so", "dylib", "wasm", "mp3", "mp4", "avi", "mov", "wav", "ogg",
        "ttf", "otf", "woff", "woff2", "eot", "db", "sqlite", "lock",
    ];

    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| binary_extensions.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Combined search that checks both filenames and content
pub fn search_combined(
    repo_path: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, FileSearchError> {
    if !repo_path.exists() {
        return Err(FileSearchError::RepoMissing(repo_path.display().to_string()));
    }

    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    let walker = WalkBuilder::new(repo_path)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git"
                && name != "node_modules"
                && name != "target"
                && name != "dist"
                && name != "build"
        })
        .build();

    for entry in walker.flatten() {
        if results.len() >= limit {
            break;
        }

        let path = entry.path();
        if path == repo_path {
            continue;
        }

        if let Ok(relative) = path.strip_prefix(repo_path) {
            let rel_str = relative.to_string_lossy();
            let rel_lower = rel_str.to_lowercase();

            if rel_lower.contains(&query_lower) {
                let file_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();

                let match_type = if file_name.contains(&query_lower) {
                    SearchMatchType::FileName
                } else if path
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().to_lowercase().contains(&query_lower))
                    .unwrap_or(false)
                {
                    SearchMatchType::DirectoryName
                } else {
                    SearchMatchType::FullPath
                };

                let path_str = rel_str.to_string();
                seen_paths.insert(path_str.clone());
                results.push(SearchResult {
                    path: path_str,
                    is_file: path.is_file(),
                    match_type,
                });
            }
        }
    }

    if results.len() < limit {
        let remaining = limit - results.len();
        if let Ok(content_results) = search_content(repo_path, query, remaining * 2) {
            for content_result in content_results {
                if results.len() >= limit {
                    break;
                }
                if !seen_paths.contains(&content_result.path) {
                    seen_paths.insert(content_result.path.clone());
                    results.push(SearchResult {
                        path: content_result.path,
                        is_file: true,
                        match_type: SearchMatchType::ContentMatch,
                    });
                }
            }
        }
    }

    Ok(results)
}
