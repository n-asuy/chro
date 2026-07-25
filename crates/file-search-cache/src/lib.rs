use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use fst::{Map, MapBuilder};
use git2::{Repository, Sort};
use ignore::WalkBuilder;
use moka::future::Cache;
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
/// Approximate aggregate memory budget for cached repository indexes. Moka's
/// capacity is expressed in KiB via `cached_repo_weight_kib`.
const CACHE_MAX_WEIGHT_KIB: u64 = 128 * 1024;

/// File search cache with FST indexing
pub struct FileSearchCache {
    // Cache values are shared so a lookup does not clone a repository's full
    // FST and path vectors into a second large allocation.
    cache: Cache<PathBuf, Arc<CachedRepo>>,
    build_queue: mpsc::Sender<PathBuf>,
}

impl FileSearchCache {
    pub fn new() -> Self {
        // A bounded queue prevents rapid watcher invalidations from retaining
        // an unbounded number of repository paths.
        let (build_sender, build_receiver) = mpsc::channel(64);

        let cache = Cache::builder()
            .weigher(|_path: &PathBuf, repo: &Arc<CachedRepo>| cached_repo_weight_kib(repo))
            .max_capacity(CACHE_MAX_WEIGHT_KIB)
            .time_to_live(Duration::from_secs(3600))
            .build();

        let cache_for_worker = cache.clone();

        tokio::spawn(async move {
            Self::background_worker(build_receiver, cache_for_worker).await;
        });

        Self {
            cache,
            build_queue: build_sender,
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

        if let Err(mpsc::error::TrySendError::Closed(path)) =
            self.build_queue.try_send(repo_path_buf)
        {
            warn!("Cache build queue closed before enqueuing {:?}", path);
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

        if let Err(mpsc::error::TrySendError::Closed(path)) =
            self.build_queue.try_send(repo_path.to_path_buf())
        {
            error!("Cache build queue closed before warming {:?}", path);
        }
        Ok(())
    }

    /// Queue a rebuild of the repository's index. Called by the git state
    /// watcher when HEAD moves (branch switch, commit), so the next search
    /// hits a fresh cache instead of the slow filesystem fallback.
    pub fn invalidate(&self, repo_path: &Path) {
        if let Err(mpsc::error::TrySendError::Closed(path)) =
            self.build_queue.try_send(repo_path.to_path_buf())
        {
            warn!("Cache build queue closed before invalidating {:?}", path);
        }
    }

    /// Background worker for cache building
    async fn background_worker(
        mut build_receiver: mpsc::Receiver<PathBuf>,
        cache: Cache<PathBuf, Arc<CachedRepo>>,
    ) {
        while let Some(repo_path) = build_receiver.recv().await {
            // Coalesce duplicate invalidations already waiting in the queue.
            let mut pending = HashSet::from([repo_path]);
            while let Ok(path) = build_receiver.try_recv() {
                pending.insert(path);
            }
            for repo_path in pending {
                let build_path = repo_path.clone();
                let built =
                    tokio::task::spawn_blocking(move || build_repo_cache(&build_path)).await;
                match built {
                    Ok(Ok(cached_repo)) => {
                        cache.insert(repo_path.clone(), Arc::new(cached_repo)).await;
                        info!("Successfully cached repo: {:?}", repo_path);
                    }
                    Ok(Err(e)) => {
                        error!("Failed to cache repo {:?}: {}", repo_path, e);
                    }
                    Err(e) => {
                        error!("Cache worker failed for {:?}: {}", repo_path, e);
                    }
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

fn cached_repo_weight_kib(repo: &CachedRepo) -> u32 {
    let indexed_bytes = repo.indexed_files.iter().fold(0usize, |total, file| {
        total
            .saturating_add(std::mem::size_of::<IndexedFile>())
            .saturating_add(file.path.len())
            .saturating_add(file.path_lowercase.len())
    });
    let stats_bytes = repo.stats.iter().fold(0usize, |total, (path, _stat)| {
        total
            .saturating_add(std::mem::size_of::<FileStat>())
            .saturating_add(path.len())
    });
    // The FST stores another compact copy of every lowercase path. Counting
    // path_lowercase a second time is a conservative proxy for that buffer.
    let bytes = indexed_bytes
        .saturating_add(stats_bytes)
        .saturating_add(
            repo.indexed_files
                .iter()
                .map(|file| file.path_lowercase.len())
                .sum::<usize>(),
        )
        .saturating_add(repo.head_sha.len());
    bytes
        .div_ceil(1024)
        .clamp(1, u32::MAX as usize)
        .try_into()
        .unwrap_or(u32::MAX)
}

/// Build cache entry for a repository
fn build_repo_cache(repo_path: &Path) -> Result<CachedRepo, FileSearchError> {
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
    /// Last-modified time as an RFC3339 string, or `None` when unavailable.
    pub modified_at: Option<String>,
}

/// How to order content-search results. `Relevance` is the default; the rest
/// mirror the file-name / path / modified-time axes offered in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchSort {
    #[default]
    Relevance,
    ModifiedDesc,
    ModifiedAsc,
    NameAsc,
    NameDesc,
    PathAsc,
    PathDesc,
}

/// Result of a content search: the top-N rendered hits plus totals describing
/// the full collected set (which may be larger than what is returned).
#[derive(Debug, Clone, Serialize)]
pub struct ContentSearchOutcome {
    pub hits: Vec<FileContentHit>,
    /// Number of files collected before the cap stopped the walk.
    pub total_files: usize,
    /// Total matching lines across collected files (before the per-file cap).
    pub total_line_matches: usize,
    /// True when the walk stopped at the collect cap, so totals are lower bounds.
    pub truncated: bool,
}

/// Upper bound on files collected before sorting, so a broad `content:` query
/// cannot hold the whole repository's highlights in memory. Beyond this the
/// user is better served by narrowing the query than by an exact global order.
const CONTENT_COLLECT_CAP: usize = 500;
/// Generated logs and minified bundles should not be loaded wholesale merely
/// because a live search query changed.
const CONTENT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// A newline-only generated file can turn a modest byte buffer into millions
/// of fat `&str` pointers. Stop constructing the line index before that point.
const CONTENT_MAX_SCANNED_LINES_PER_FILE: usize = 100_000;
/// Preserve enough matching lines for useful relevance sorting while bounding
/// temporary query-evaluation maps for generated files.
const CONTENT_MAX_EVALUATED_LINES_PER_FILE: usize = 1_000;

/// A file that matched, held between the collect and sort stages. Snippets are
/// windowed before storage so one minified line cannot retain a multi-megabyte
/// string for every collected file.
struct RankedHit {
    path: String,
    /// Basename lowercased, precomputed for name sorting.
    name_lower: String,
    /// Whether the file *name* satisfies the query (relevance signal).
    name_match: bool,
    /// Matching line count before the per-file cap (relevance + totals signal).
    match_count: usize,
    modified: Option<DateTime<Utc>>,
    /// Up to `max_lines_per_file` bounded display snippets.
    matches: Vec<LineMatch>,
}

/// Full-text search across file contents using the boolean query language,
/// grouped by file and ordered by `sort`.
///
/// The query supports `AND`/`OR`/`-`/`()`, `"phrases"`, `/regex/`, the field
/// prefixes `file:`/`path:`/`content:`/`tag:`, `line:(…)` scoping, and
/// `match-case:`/`ignore-case:` (see [`query`]). `case_sensitive` sets the
/// default when a term has no explicit case operator: `Some(true/false)` forces
/// it, `None` applies smart-case.
///
/// Files are collected up to [`CONTENT_COLLECT_CAP`], sorted per `sort`, then
/// the top `max_files` are rendered with up to `max_lines_per_file` matching
/// lines each. The returned [`ContentSearchOutcome`] carries totals for the
/// whole collected set and a `truncated` flag when the cap was hit. Queries
/// that only test names/paths skip reading file contents.
pub fn search_content_grouped(
    repo_path: &Path,
    pattern: &str,
    case_sensitive: Option<bool>,
    sort: SearchSort,
    max_files: usize,
    max_lines_per_file: usize,
) -> Result<ContentSearchOutcome, FileSearchError> {
    if !repo_path.exists() {
        return Err(FileSearchError::RepoMissing(
            repo_path.display().to_string(),
        ));
    }

    let compiled = query::CompiledQuery::parse(pattern, case_sensitive)
        .map_err(|e| FileSearchError::InvalidRepository(e.0))?;

    let empty = ContentSearchOutcome {
        hits: Vec::new(),
        total_files: 0,
        total_line_matches: 0,
        truncated: false,
    };
    if compiled.is_empty() || max_files == 0 || max_lines_per_file == 0 {
        return Ok(empty);
    }

    // ---- Stage 1: collect ---------------------------------------------------
    let mut collected: Vec<RankedHit> = Vec::new();
    let mut truncated = false;

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
        if collected.len() >= CONTENT_COLLECT_CAP {
            truncated = true;
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

        let metadata = entry.metadata().ok();
        let modified = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(DateTime::<Utc>::from);
        let name_lower = relative_path
            .rsplit('/')
            .next()
            .unwrap_or(&relative_path)
            .to_lowercase();

        // Name/path-only queries never touch file contents.
        if !compiled.reads_content {
            if compiled.evaluate(&relative_path, &[]).is_some() {
                collected.push(RankedHit {
                    name_match: true,
                    match_count: 0,
                    modified,
                    name_lower,
                    path: relative_path,
                    matches: Vec::new(),
                });
            }
            continue;
        }

        if metadata
            .as_ref()
            .is_some_and(|value| value.len() > CONTENT_MAX_FILE_BYTES)
        {
            truncated = true;
            continue;
        }

        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let mut bytes = Vec::with_capacity(
            metadata
                .as_ref()
                .map(|value| value.len().min(CONTENT_MAX_FILE_BYTES) as usize)
                .unwrap_or(0),
        );
        if file
            .take(CONTENT_MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            continue;
        }
        if bytes.len() > CONTENT_MAX_FILE_BYTES as usize {
            // The file grew beyond the metadata size while this search was
            // running. Preserve the same hard cap in that race.
            truncated = true;
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => continue, // unreadable or non-UTF-8: treat as no match
        };
        let mut lines: Vec<&str> = content
            .lines()
            .take(CONTENT_MAX_SCANNED_LINES_PER_FILE + 1)
            .collect();
        if lines.len() > CONTENT_MAX_SCANNED_LINES_PER_FILE {
            lines.truncate(CONTENT_MAX_SCANNED_LINES_PER_FILE);
            truncated = true;
        }
        let Some((highlights, highlights_truncated)) =
            compiled.evaluate_limited(&relative_path, &lines, CONTENT_MAX_EVALUATED_LINES_PER_FILE)
        else {
            continue;
        };
        truncated |= highlights_truncated;

        let match_count = highlights.len();
        let mut matches = Vec::new();
        for (line_number, mut ranges) in highlights {
            if matches.len() >= max_lines_per_file {
                break;
            }
            let Some(line) = lines.get((line_number - 1) as usize) else {
                continue;
            };
            merge_ranges(&mut ranges);
            let (line_content, ranges) = build_snippet(line, &ranges);
            matches.push(LineMatch {
                line_number,
                line_content,
                ranges,
            });
        }

        collected.push(RankedHit {
            name_match: compiled.matches_name(&relative_path),
            match_count,
            modified,
            name_lower,
            path: relative_path,
            matches,
        });
    }

    let total_files = collected.len();
    let total_line_matches = collected.iter().map(|h| h.match_count).sum();

    // ---- Stage 2: sort ------------------------------------------------------
    sort_ranked(&mut collected, sort);

    // ---- Stage 3: render top-N ---------------------------------------------
    let hits = collected
        .into_iter()
        .take(max_files)
        .map(|hit| FileContentHit {
            path: hit.path,
            matches: hit.matches,
            modified_at: hit.modified.map(|t| t.to_rfc3339()),
        })
        .collect();

    Ok(ContentSearchOutcome {
        hits,
        total_files,
        total_line_matches,
        truncated,
    })
}

/// Order modified times with `None` always last, in the given direction.
/// `desc` = newest first.
fn cmp_modified(
    a: &Option<DateTime<Utc>>,
    b: &Option<DateTime<Utc>>,
    desc: bool,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (Some(x), Some(y)) => {
            if desc {
                y.cmp(x)
            } else {
                x.cmp(y)
            }
        }
        (Some(_), None) => Ordering::Less, // present sorts before missing
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// Sort collected hits per `sort`. Every ordering ends with `path` ascending so
/// the result is deterministic regardless of walk order.
fn sort_ranked(hits: &mut [RankedHit], sort: SearchSort) {
    hits.sort_by(|a, b| {
        let by_path = a.path.cmp(&b.path);
        match sort {
            SearchSort::Relevance => b
                .name_match
                .cmp(&a.name_match)
                .then_with(|| b.match_count.cmp(&a.match_count))
                .then_with(|| cmp_modified(&a.modified, &b.modified, true))
                .then(by_path),
            SearchSort::ModifiedDesc => cmp_modified(&a.modified, &b.modified, true).then(by_path),
            SearchSort::ModifiedAsc => cmp_modified(&a.modified, &b.modified, false).then(by_path),
            SearchSort::NameAsc => a.name_lower.cmp(&b.name_lower).then(by_path),
            SearchSort::NameDesc => b.name_lower.cmp(&a.name_lower).then(by_path),
            SearchSort::PathAsc => by_path,
            SearchSort::PathDesc => b.path.cmp(&a.path),
        }
    });
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
        assert!(
            snippet.starts_with('…'),
            "windowed snippet should lead with ellipsis"
        );
        assert!(
            snippet.len() < raw.len(),
            "snippet should be shorter than the raw line"
        );
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

    /// Set a file's mtime so modified-time ordering is deterministic.
    fn set_mtime(dir: &TempDir, rel: &str, secs_since_epoch: u64) {
        let file = fs::File::options()
            .write(true)
            .open(dir.path().join(rel))
            .unwrap();
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs_since_epoch))
            .unwrap();
    }

    #[test]
    fn content_search_groups_lines_by_file() {
        let dir = TempDir::new().unwrap();
        write(
            &dir,
            "a.rs",
            "fn alpha() {}\nlet needle = 1;\nneedle again\n",
        );
        write(&dir, "b.rs", "no match here\n");

        let out = search_content_grouped(dir.path(), "needle", None, SearchSort::Relevance, 10, 10)
            .unwrap();
        assert_eq!(out.hits.len(), 1);
        assert_eq!(out.hits[0].path, "a.rs");
        assert_eq!(out.hits[0].matches.len(), 2);
        assert_eq!(out.hits[0].matches[0].line_number, 2);
        assert_eq!(out.hits[0].matches[1].line_number, 3);
    }

    #[test]
    fn content_search_is_smart_case() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "Needle\nneedle\n");

        // Lowercase query matches case-insensitively.
        let lower =
            search_content_grouped(dir.path(), "needle", None, SearchSort::Relevance, 10, 10)
                .unwrap();
        assert_eq!(lower.hits[0].matches.len(), 2);

        // A query with an uppercase letter becomes case-sensitive.
        let upper =
            search_content_grouped(dir.path(), "Needle", None, SearchSort::Relevance, 10, 10)
                .unwrap();
        assert_eq!(upper.hits[0].matches.len(), 1);
        assert_eq!(upper.hits[0].matches[0].line_number, 1);
    }

    #[test]
    fn content_search_case_override_beats_smart_case() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "Needle\nneedle\n");

        // Force case-sensitive on an all-lowercase query.
        let sensitive = search_content_grouped(
            dir.path(),
            "needle",
            Some(true),
            SearchSort::Relevance,
            10,
            10,
        )
        .unwrap();
        assert_eq!(sensitive.hits[0].matches.len(), 1);
        assert_eq!(sensitive.hits[0].matches[0].line_number, 2);

        // Force case-insensitive on a mixed-case query.
        let insensitive = search_content_grouped(
            dir.path(),
            "Needle",
            Some(false),
            SearchSort::Relevance,
            10,
            10,
        )
        .unwrap();
        assert_eq!(insensitive.hits[0].matches.len(), 2);
    }

    #[test]
    fn content_search_respects_caps() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "hit\nhit\nhit\n");
        write(&dir, "b.rs", "hit\n");
        write(&dir, "c.rs", "hit\n");

        // max_files caps the returned hits, but totals reflect the whole set.
        let capped_files =
            search_content_grouped(dir.path(), "hit", None, SearchSort::Relevance, 2, 10).unwrap();
        assert_eq!(capped_files.hits.len(), 2);
        assert_eq!(capped_files.total_files, 3);
        assert!(!capped_files.truncated);

        let capped_lines =
            search_content_grouped(dir.path(), "hit", None, SearchSort::Relevance, 10, 2).unwrap();
        let a = capped_lines.hits.iter().find(|h| h.path == "a.rs").unwrap();
        assert_eq!(a.matches.len(), 2);
    }

    #[test]
    fn relevance_ranks_name_matches_then_match_count() {
        let dir = TempDir::new().unwrap();
        // Name contains the term (and one body match): outranks body-only files
        // even though it has the fewest content matches.
        write(&dir, "needle.rs", "needle\n");
        // Most content matches among the body-only files.
        write(&dir, "many.rs", "needle\nneedle\nneedle\n");
        // Fewest content matches.
        write(&dir, "few.rs", "needle\n");

        let out = search_content_grouped(dir.path(), "needle", None, SearchSort::Relevance, 10, 10)
            .unwrap();
        let order: Vec<&str> = out.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(order, vec!["needle.rs", "many.rs", "few.rs"]);
    }

    #[test]
    fn modified_sort_orders_by_mtime_with_none_last() {
        let dir = TempDir::new().unwrap();
        write(&dir, "old.rs", "hit\n");
        write(&dir, "new.rs", "hit\n");
        set_mtime(&dir, "old.rs", 1_000);
        set_mtime(&dir, "new.rs", 2_000);

        let desc =
            search_content_grouped(dir.path(), "hit", None, SearchSort::ModifiedDesc, 10, 10)
                .unwrap();
        let desc_order: Vec<&str> = desc.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(desc_order, vec!["new.rs", "old.rs"]);

        let asc = search_content_grouped(dir.path(), "hit", None, SearchSort::ModifiedAsc, 10, 10)
            .unwrap();
        let asc_order: Vec<&str> = asc.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(asc_order, vec!["old.rs", "new.rs"]);

        // Every content hit carries an RFC3339 modified time.
        assert!(desc.hits.iter().all(|h| h.modified_at.is_some()));
    }

    #[test]
    fn total_line_matches_counts_before_per_file_cap() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.rs", "hit\nhit\nhit\nhit\nhit\n");

        let out =
            search_content_grouped(dir.path(), "hit", None, SearchSort::Relevance, 10, 2).unwrap();
        // Rendered lines are capped at 2, but the total reflects all 5.
        assert_eq!(out.hits[0].matches.len(), 2);
        assert_eq!(out.total_line_matches, 5);
    }

    #[test]
    fn collect_cap_marks_truncated() {
        let dir = TempDir::new().unwrap();
        for i in 0..(CONTENT_COLLECT_CAP + 5) {
            write(&dir, &format!("f{i}.txt"), "hit\n");
        }

        let out =
            search_content_grouped(dir.path(), "hit", None, SearchSort::Relevance, 10, 10).unwrap();
        assert!(out.truncated);
        assert_eq!(out.total_files, CONTENT_COLLECT_CAP);
        assert_eq!(out.hits.len(), 10);
    }

    #[test]
    fn content_search_skips_oversized_files() {
        let dir = TempDir::new().unwrap();
        write(
            &dir,
            "generated.log",
            &format!("needle{}", "x".repeat(CONTENT_MAX_FILE_BYTES as usize)),
        );
        write(&dir, "small.txt", "needle\n");

        let out = search_content_grouped(dir.path(), "needle", None, SearchSort::Relevance, 10, 10)
            .unwrap();
        assert!(out.truncated);
        assert_eq!(out.hits.len(), 1);
        assert_eq!(out.hits[0].path, "small.txt");
    }

    #[test]
    fn content_search_caps_generated_line_indexes() {
        let dir = TempDir::new().unwrap();
        write(
            &dir,
            "many-lines.log",
            &format!(
                "{}needle\n",
                "\n".repeat(CONTENT_MAX_SCANNED_LINES_PER_FILE + 1)
            ),
        );

        let out = search_content_grouped(dir.path(), "needle", None, SearchSort::Relevance, 10, 10)
            .unwrap();
        assert!(out.truncated);
        assert!(out.hits.is_empty());
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
