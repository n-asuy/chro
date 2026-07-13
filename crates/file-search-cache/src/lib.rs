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
use ignore::WalkBuilder;
use moka::future::Cache;
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

mod query;

/// Search mode for different use cases
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    TaskForm, // Default: exclude ignored files (clean results)
    Settings, // Include ignored files (for project config like .env)
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

    /// Search files by name/path in a repository using the cached index.
    ///
    /// This is a pure name/path search: it never falls back to scanning file
    /// contents. Full-text search is a separate, explicit operation
    /// (`search_content_grouped`) so that a known filename resolves instantly
    /// without triggering an expensive repository-wide content scan.
    pub async fn search(
        &self,
        repo_path: &Path,
        query: &str,
        mode: SearchMode,
        limit: usize,
    ) -> Result<Vec<SearchResult>, CacheError> {
        let repo_path_buf = repo_path.to_path_buf();

        if let Some(cached) = self.cache.get(&repo_path_buf).await {
            if let Ok(head_sha) = get_head_sha(&repo_path_buf) {
                if head_sha == cached.head_sha {
                    return Ok(search_names_in_cache(&cached, query, mode, limit));
                }
            }
        }

        if let Err(e) = self.build_queue.send(repo_path_buf) {
            warn!("Failed to enqueue cache build: {}", e);
        }

        Err(CacheError::Miss)
    }

    /// Pre-warm cache for given repository
    pub async fn warm(&self, repo_path: &Path) -> Result<(), FileSearchError> {
        if !repo_path.exists() {
            return Err(FileSearchError::RepoMissing(
                repo_path.display().to_string(),
            ));
        }

        if let Err(e) = self.build_queue.send(repo_path.to_path_buf()) {
            error!(
                "Failed to enqueue repo for warming: {:?} - {}",
                repo_path, e
            );
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
            name != ".git"
                && name != "node_modules"
                && name != "target"
                && name != "dist"
                && name != "build"
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
        let entry =
            result.map_err(|e| FileSearchError::Io(std::io::Error::other(e.to_string())))?;
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

/// Longest snippet (in bytes) kept verbatim before a match window is applied.
const MAX_SNIPPET_BYTES: usize = 240;
/// Bytes of leading context kept before the first match when windowing.
const SNIPPET_LEAD_BYTES: usize = 32;

/// A single matching line within a file, with highlight ranges.
#[derive(Debug, Clone, Serialize)]
pub struct LineMatch {
    /// 1-based line number.
    pub line_number: u64,
    /// Display snippet for the line (trailing newline stripped, possibly windowed).
    pub line_content: String,
    /// `[start, end)` match ranges as UTF-16 code-unit offsets into `line_content`,
    /// so a JavaScript client can slice `line_content` directly for highlighting.
    pub ranges: Vec<[u32; 2]>,
}

/// Content-search hit: one file with its matching lines grouped together.
#[derive(Debug, Clone, Serialize)]
pub struct FileContentHit {
    pub path: String,
    pub matches: Vec<LineMatch>,
}

/// Full-text search across file contents using the boolean query language,
/// grouped by file.
///
/// The query supports `AND`/`OR`/`-`/`()`, `"phrases"`, `/regex/`, the field
/// prefixes `file:`/`path:`/`content:`/`tag:`, `line:(…)` scoping, and
/// `match-case:`/`ignore-case:` (see [`query`]). `case_sensitive` sets the
/// default when a term has no explicit case operator: `Some(true/false)` forces
/// it, `None` applies smart-case. Each returned file carries up to
/// `max_lines_per_file` matching lines; scanning stops after `max_files` files
/// have matched. Queries that only test names/paths skip reading file contents.
pub fn search_content_grouped(
    repo_path: &Path,
    pattern: &str,
    case_sensitive: Option<bool>,
    max_files: usize,
    max_lines_per_file: usize,
) -> Result<Vec<FileContentHit>, FileSearchError> {
    if !repo_path.exists() {
        return Err(FileSearchError::RepoMissing(
            repo_path.display().to_string(),
        ));
    }

    let compiled = query::CompiledQuery::parse(pattern, case_sensitive)
        .map_err(|e| FileSearchError::InvalidRepository(e.0))?;

    if compiled.is_empty() || max_files == 0 || max_lines_per_file == 0 {
        return Ok(Vec::new());
    }

    let mut hits: Vec<FileContentHit> = Vec::new();

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
        if hits.len() >= max_files {
            break;
        }

        let path = entry.path();
        if !path.is_file() || is_likely_binary(path) {
            continue;
        }

        let relative_path = path
            .strip_prefix(repo_path)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        // Name/path-only queries never touch file contents.
        if !compiled.reads_content {
            if compiled.evaluate(&relative_path, &[]).is_some() {
                hits.push(FileContentHit {
                    path: relative_path,
                    matches: Vec::new(),
                });
            }
            continue;
        }

        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue, // unreadable or non-UTF-8: treat as no match
        };
        let lines: Vec<&str> = content.lines().collect();
        let Some(highlights) = compiled.evaluate(&relative_path, &lines) else {
            continue;
        };

        let mut matches: Vec<LineMatch> = Vec::new();
        for (line_number, mut ranges) in highlights {
            if matches.len() >= max_lines_per_file {
                break;
            }
            let Some(line) = lines.get((line_number - 1) as usize) else {
                continue;
            };
            merge_ranges(&mut ranges);
            let (snippet, utf16_ranges) = build_snippet(line, &ranges);
            matches.push(LineMatch {
                line_number,
                line_content: snippet,
                ranges: utf16_ranges,
            });
        }

        hits.push(FileContentHit {
            path: relative_path,
            matches,
        });
    }

    Ok(hits)
}

/// Sort byte ranges by start and merge overlapping/adjacent ones, so the
/// snippet builder and client highlighter can walk them with a single cursor.
fn merge_ranges(ranges: &mut Vec<(usize, usize)>) {
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for &(s, e) in ranges.iter() {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    *ranges = merged;
}

/// Snap `index` down to the nearest UTF-8 char boundary of `s`.
fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    index = index.min(s.len());
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// Snap `index` up to the nearest UTF-8 char boundary of `s`.
fn ceil_char_boundary(s: &str, mut index: usize) -> usize {
    index = index.min(s.len());
    while index < s.len() && !s.is_char_boundary(index) {
        index += 1;
    }
    index
}

/// Count UTF-16 code units in `s` up to byte offset `end` (a char boundary).
fn utf16_offset(s: &str, end: usize) -> u32 {
    s[..end].encode_utf16().count() as u32
}

/// Build a display snippet from a raw matched line and its byte-range matches.
///
/// The trailing newline is stripped and leading whitespace trimmed. Long lines
/// are windowed around the first match with ellipses, and every match range is
/// converted to UTF-16 offsets relative to the final snippet string.
fn build_snippet(line: &str, byte_ranges: &[(usize, usize)]) -> (String, Vec<[u32; 2]>) {
    let line = line.trim_end_matches(['\n', '\r']);
    let trimmed = line.trim_start();
    let left_off = line.len() - trimmed.len();

    // Shift ranges into the left-trimmed coordinate space, dropping any that the
    // trim consumed entirely.
    let shifted: Vec<(usize, usize)> = byte_ranges
        .iter()
        .filter_map(|&(s, e)| {
            let s = s.saturating_sub(left_off);
            let e = e.saturating_sub(left_off);
            (e > s).then_some((s, e))
        })
        .collect();

    let needs_window = trimmed.len() > MAX_SNIPPET_BYTES;
    let (win_start, win_end) = if needs_window {
        let first = shifted.first().map_or(0, |r| r.0);
        let start = floor_char_boundary(trimmed, first.saturating_sub(SNIPPET_LEAD_BYTES));
        let end = ceil_char_boundary(trimmed, start + MAX_SNIPPET_BYTES);
        (start, end)
    } else {
        (0, trimmed.len())
    };
    let window = &trimmed[win_start..win_end];

    let lead = if win_start > 0 { "…" } else { "" };
    let trail = if win_end < trimmed.len() { "…" } else { "" };
    // A leading ellipsis is one UTF-16 code unit (U+2026); shift ranges past it.
    let lead_units = lead.encode_utf16().count() as u32;

    let ranges: Vec<[u32; 2]> = shifted
        .iter()
        .filter_map(|&(s, e)| {
            let s = s.max(win_start);
            let e = e.min(win_end);
            if e <= s {
                return None;
            }
            let s = utf16_offset(window, s - win_start) + lead_units;
            let e = utf16_offset(window, e - win_start) + lead_units;
            Some([s, e])
        })
        .collect();

    (format!("{lead}{window}{trail}"), ranges)
}

/// Check if a file is likely binary based on extension
fn is_likely_binary(path: &Path) -> bool {
    let binary_extensions = [
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "pdf", "zip", "tar", "gz", "rar",
        "7z", "exe", "dll", "so", "dylib", "wasm", "mp3", "mp4", "avi", "mov", "wav", "ogg", "ttf",
        "otf", "woff", "woff2", "eot", "db", "sqlite", "lock",
    ];

    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| binary_extensions.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Filter a cached repository index by name/path substring, ranked by relevance.
fn search_names_in_cache(
    cached: &CachedRepo,
    query: &str,
    mode: SearchMode,
    limit: usize,
) -> Vec<SearchResult> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for indexed_file in &cached.indexed_files {
        if !indexed_file.path_lowercase.contains(&query_lower) {
            continue;
        }
        if matches!(mode, SearchMode::TaskForm) && indexed_file.is_ignored {
            continue;
        }
        results.push(SearchResult {
            path: indexed_file.path.clone(),
            is_file: indexed_file.is_file,
            match_type: indexed_file.match_type.clone(),
        });
    }

    rerank(&mut results, &cached.stats);
    results.truncate(limit);
    results
}

/// Name/path search by walking the filesystem, for use when no cache is warm.
///
/// Pure name search: it never scans file contents. Full-text search is the
/// separate `search_content_grouped` operation.
pub fn search_combined(
    repo_path: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, FileSearchError> {
    if !repo_path.exists() {
        return Err(FileSearchError::RepoMissing(
            repo_path.display().to_string(),
        ));
    }

    let query_lower = query.to_lowercase();
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

                results.push(SearchResult {
                    path: rel_str.to_string(),
                    is_file: path.is_file(),
                    match_type,
                });
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Slice a snippet by a UTF-16 range the way a JavaScript client would, so
    /// tests assert on what the client actually highlights.
    fn highlight(snippet: &str, range: [u32; 2]) -> String {
        let units: Vec<u16> = snippet.encode_utf16().collect();
        String::from_utf16(&units[range[0] as usize..range[1] as usize]).unwrap()
    }

    #[test]
    fn snippet_strips_newline_and_trims_leading_whitespace() {
        // Raw line as the searcher yields it: leading indent + trailing newline.
        let raw = "    let foo = 1;\n";
        // "foo" occupies bytes 8..11 in the raw line.
        let (snippet, ranges) = build_snippet(raw, &[(8, 11)]);
        assert_eq!(snippet, "let foo = 1;");
        assert_eq!(ranges, vec![[4, 7]]);
        assert_eq!(highlight(&snippet, ranges[0]), "foo");
    }

    #[test]
    fn snippet_ranges_are_utf16_offsets() {
        // A 2-code-unit astral char precedes the match; JS slices by UTF-16.
        let raw = "😀 foo bar";
        // "foo" is at bytes 5..8 ('😀'=4 bytes, ' '=1).
        let (snippet, ranges) = build_snippet(raw, &[(5, 8)]);
        assert_eq!(snippet, "😀 foo bar");
        assert_eq!(highlight(&snippet, ranges[0]), "foo");
    }

    #[test]
    fn snippet_windows_long_lines_around_first_match() {
        let prefix = "x".repeat(400);
        let raw = format!("{prefix}NEEDLE tail");
        let match_start = prefix.len();
        let (snippet, ranges) = build_snippet(&raw, &[(match_start, match_start + 6)]);
        assert!(snippet.starts_with('…'), "windowed snippet should lead with ellipsis");
        assert!(snippet.len() < raw.len(), "snippet should be shorter than the raw line");
        assert_eq!(ranges.len(), 1);
        assert_eq!(highlight(&snippet, ranges[0]), "NEEDLE");
    }

    fn write(dir: &TempDir, rel: &str, contents: &str) {
        let path = dir.path().join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn content_search_groups_lines_by_file() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "fn alpha() {}\nlet needle = 1;\nneedle again\n");
        write(&dir, "b.rs", "no match here\n");

        let hits = search_content_grouped(dir.path(), "needle", None, 10, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.rs");
        assert_eq!(hits[0].matches.len(), 2);
        assert_eq!(hits[0].matches[0].line_number, 2);
        assert_eq!(hits[0].matches[1].line_number, 3);
    }

    #[test]
    fn content_search_is_smart_case() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "Needle\nneedle\n");

        // Lowercase query matches case-insensitively.
        let lower = search_content_grouped(dir.path(), "needle", None, 10, 10).unwrap();
        assert_eq!(lower[0].matches.len(), 2);

        // A query with an uppercase letter becomes case-sensitive.
        let upper = search_content_grouped(dir.path(), "Needle", None, 10, 10).unwrap();
        assert_eq!(upper[0].matches.len(), 1);
        assert_eq!(upper[0].matches[0].line_number, 1);
    }

    #[test]
    fn content_search_case_override_beats_smart_case() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "Needle\nneedle\n");

        // Force case-sensitive on an all-lowercase query.
        let sensitive =
            search_content_grouped(dir.path(), "needle", Some(true), 10, 10).unwrap();
        assert_eq!(sensitive[0].matches.len(), 1);
        assert_eq!(sensitive[0].matches[0].line_number, 2);

        // Force case-insensitive on a mixed-case query.
        let insensitive =
            search_content_grouped(dir.path(), "Needle", Some(false), 10, 10).unwrap();
        assert_eq!(insensitive[0].matches.len(), 2);
    }

    #[test]
    fn content_search_respects_caps() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "hit\nhit\nhit\n");
        write(&dir, "b.rs", "hit\n");
        write(&dir, "c.rs", "hit\n");

        let capped_files = search_content_grouped(dir.path(), "hit", None, 2, 10).unwrap();
        assert_eq!(capped_files.len(), 2);

        let capped_lines = search_content_grouped(dir.path(), "hit", None, 10, 2).unwrap();
        let a = capped_lines.iter().find(|h| h.path == "a.rs").unwrap();
        assert_eq!(a.matches.len(), 2);
    }

    #[test]
    fn name_search_does_not_fall_back_to_content() {
        let dir = TempDir::new().unwrap();
        // File name has no "needle"; only its contents do.
        write(&dir, "unrelated.rs", "the needle lives here\n");

        let results = search_combined(dir.path(), "needle", 10).unwrap();
        assert!(
            results.is_empty(),
            "name search must not match on file contents, got {results:?}"
        );
    }
}
