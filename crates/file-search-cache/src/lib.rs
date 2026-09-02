use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::Instant,
};

use chrono::{DateTime, Utc};
use git2::{Repository, Sort};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, info, warn};
use unicode_normalization::UnicodeNormalization;

mod matcher;
mod query;

use matcher::{
    match_contiguous, match_fuzzy, reference_keys, reference_matches, shorter_path, HISTORY_MAX,
};

/// Search mode for different use cases
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    TaskForm, // Default: exclude ignored files (clean results)
    Settings, // Include ignored files (for project config like .env)
}

/// What a name search should consider and how much of it to return.
///
/// `files_only` is applied before `limit`, which matters: a caller that
/// inserts a file reference and discards directories client-side would
/// otherwise lose result slots to entries it can never use.
#[derive(Debug, Clone, Copy)]
pub struct SearchOptions {
    pub mode: SearchMode,
    pub files_only: bool,
    pub limit: usize,
}

impl SearchOptions {
    pub fn new(limit: usize) -> Self {
        Self {
            mode: SearchMode::default(),
            files_only: false,
            limit,
        }
    }

    pub fn with_mode(mut self, mode: SearchMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn files_only(mut self, files_only: bool) -> Self {
        self.files_only = files_only;
        self
    }

    /// Whether an indexed entry is eligible under these options.
    fn includes(&self, file: &IndexedFile) -> bool {
        if self.files_only && !file.is_file {
            return false;
        }
        !(matches!(self.mode, SearchMode::TaskForm) && file.is_ignored)
    }
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

/// One entry of the per-repository name index.
#[derive(Clone, Debug)]
pub struct IndexedFile {
    pub path: String,
    pub is_file: bool,
    /// Comparison key: NFC-normalized and lowercased relative path. macOS
    /// (APFS/HFS+) hands back decomposed (NFD) names while queries typed in a
    /// webview are precomposed (NFC); comparing normalized keys makes the two
    /// meet. See [`normalize_key`].
    pub path_key: Arc<str>,
    /// Normalized `aliases` declared in the document's frontmatter: the other
    /// names it answers to. Empty for everything but markdown.
    pub alias_keys: Vec<Arc<str>>,
    pub is_ignored: bool,
}

/// Every name-facing fact about one repository root.
///
/// The name side (`NameIndex`) comes from a filesystem walk and changes when
/// files are created, deleted, renamed or re-aliased. The history side
/// (`stats`) comes from git and changes when HEAD moves. They are refreshed
/// independently, so a commit never forces a walk and a file write never
/// forces a revwalk.
pub struct RepoIndex {
    names: Arc<NameIndex>,
    pub stats: Arc<FileStats>,
}

/// The walk product: entries plus the lookups that make link resolution a
/// hash probe instead of a scan over every entry.
struct NameIndex {
    files: Vec<IndexedFile>,
    /// Normalized basename -> positions in `files`.
    by_name: HashMap<Arc<str>, Vec<u32>>,
    /// Normalized frontmatter alias -> positions in `files`.
    by_alias: HashMap<Arc<str>, Vec<u32>>,
    /// The walk hit [`MAX_INDEX_ENTRIES`] and was abandoned. A partial index
    /// would resolve links to the wrong file, so `files` is left empty.
    overflowed: bool,
}

impl RepoIndex {
    pub fn new(files: Vec<IndexedFile>, stats: Arc<FileStats>) -> Self {
        Self::from_walk(
            IndexWalk {
                files,
                overflowed: false,
            },
            stats,
        )
    }

    fn from_walk(walk: IndexWalk, stats: Arc<FileStats>) -> Self {
        let files = if walk.overflowed {
            Vec::new()
        } else {
            walk.files
        };
        let mut by_name: HashMap<Arc<str>, Vec<u32>> = HashMap::new();
        let mut by_alias: HashMap<Arc<str>, Vec<u32>> = HashMap::new();
        for (position, file) in files.iter().enumerate() {
            let position = position as u32;
            let basename = file.path_key.rsplit('/').next().unwrap_or(&file.path_key);
            by_name
                .entry(Arc::from(basename))
                .or_default()
                .push(position);
            for alias in &file.alias_keys {
                by_alias.entry(alias.clone()).or_default().push(position);
            }
        }
        Self {
            names: Arc::new(NameIndex {
                files,
                by_name,
                by_alias,
                overflowed: walk.overflowed,
            }),
            stats,
        }
    }

    /// The same names with fresh git history: what a HEAD move produces.
    pub fn with_stats(&self, stats: Arc<FileStats>) -> Self {
        Self {
            names: self.names.clone(),
            stats,
        }
    }

    pub fn files(&self) -> &[IndexedFile] {
        &self.names.files
    }

    pub fn is_overflowed(&self) -> bool {
        self.names.overflowed
    }

    fn entry_by_path_key(&self, path_key: &str) -> Option<&IndexedFile> {
        let basename = path_key.rsplit('/').next().unwrap_or(path_key);
        self.names
            .by_name
            .get(basename)?
            .iter()
            .map(|&position| &self.names.files[position as usize])
            .find(|file| file.path_key.as_ref() == path_key)
    }
}

/// Canonical comparison key for file-name matching: Unicode NFC normalization
/// followed by full lowercasing. Every name comparison in this crate goes
/// through this single function so index keys and queries can never disagree
/// on normalization form or case folding.
pub fn normalize_key(input: &str) -> String {
    input.nfc().collect::<String>().to_lowercase()
}

#[derive(Debug, Error)]
pub enum FileSearchError {
    #[error("repository does not exist: {0}")]
    RepoMissing(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("invalid repository: {0}")]
    InvalidRepository(String),
}

/// Configuration constants for ranking algorithm
const DEFAULT_COMMIT_LIMIT: usize = 100;
/// Weights for the git-history component. Recency dominates frequency: a file
/// touched in the last commit matters more than one touched often long ago.
const RECENCY_WEIGHT: i64 = 8;
const FREQUENCY_WEIGHT: i64 = 1;
/// Extensions whose frontmatter is read for aliases during an index build.
const ALIAS_BEARING_EXTENSIONS: [&str; 2] = ["md", "markdown"];
/// Entries a single root may contribute before its walk is abandoned. A root
/// past this (a home directory registered as a project, a monorepo with
/// build output checked in) is not something links resolve against; the cap
/// bounds both the walk and the memory an index can take.
pub const MAX_INDEX_ENTRIES: usize = 250_000;
/// Roots indexed at the same time. Cold multi-root probes ask for many
/// indexes at once; this keeps them from saturating the blocking pool.
const BUILD_CONCURRENCY: usize = 2;

/// Which side of a [`RepoIndex`] a request wants rebuilt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rebuild {
    /// Filesystem walk: files appeared, vanished, moved or changed aliases.
    Names,
    /// Git revwalk: HEAD moved.
    History,
    Full,
}

impl Rebuild {
    fn merge(self, other: Rebuild) -> Rebuild {
        if self == other {
            self
        } else {
            Rebuild::Full
        }
    }
}

struct BuildRequest {
    repo: PathBuf,
    scope: Rebuild,
}

type IndexMap = Arc<RwLock<HashMap<PathBuf, Arc<RepoIndex>>>>;

/// Per-root name indexes with watcher-driven freshness.
///
/// Reads never touch the filesystem or git: a warm index is served as-is, and
/// stays served while a rebuild runs in the background. Freshness is the
/// watchers' job (see `invalidate` / `invalidate_history` /
/// `note_worktree_changes`), not something a read re-verifies. A cold read
/// waits for the first build instead of answering from a directory walk, so
/// warm and cold callers can never disagree about what a name resolves to.
pub struct FileSearchCache {
    indexes: IndexMap,
    build_queue: mpsc::Sender<BuildRequest>,
    /// Bumped after every completed build; cold readers wait on it.
    built: watch::Sender<u64>,
}

impl FileSearchCache {
    pub fn new() -> Self {
        // A bounded queue prevents rapid watcher invalidations from retaining
        // an unbounded number of repository paths; the worker coalesces.
        let (build_sender, build_receiver) = mpsc::channel(64);
        let (built, _) = watch::channel(0u64);
        let indexes: IndexMap = Arc::new(RwLock::new(HashMap::new()));

        tokio::spawn(Self::background_worker(
            build_receiver,
            indexes.clone(),
            built.clone(),
        ));

        Self {
            indexes,
            build_queue: build_sender,
            built,
        }
    }

    fn cached(&self, repo_path: &Path) -> Option<Arc<RepoIndex>> {
        self.indexes
            .read()
            .expect("index map poisoned")
            .get(repo_path)
            .cloned()
    }

    fn enqueue(&self, repo_path: &Path, scope: Rebuild) {
        let request = BuildRequest {
            repo: repo_path.to_path_buf(),
            scope,
        };
        match self.build_queue.try_send(request) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(request)) => {
                debug!(repo = %request.repo.display(), "index build queue full; request coalesces with a queued one")
            }
            Err(mpsc::error::TrySendError::Closed(request)) => {
                warn!(repo = %request.repo.display(), "index build queue closed")
            }
        }
    }

    /// The root's index, building it first if this is the root's first
    /// request. Waits only for a cold build; a stale index is returned
    /// immediately while its rebuild runs.
    pub async fn index(&self, repo_path: &Path) -> Arc<RepoIndex> {
        let mut built = self.built.subscribe();
        loop {
            // Mark the current generation seen *before* the lookup so a build
            // that lands between the lookup and the wait still wakes us.
            built.borrow_and_update();
            if let Some(index) = self.cached(repo_path) {
                return index;
            }
            self.enqueue(repo_path, Rebuild::Full);
            if built.changed().await.is_err() {
                // The worker is gone; an empty index answers "nothing here"
                // rather than hanging every caller.
                return Arc::new(RepoIndex::new(Vec::new(), Arc::new(FileStats::new())));
            }
        }
    }

    /// Search files by name/path in a repository.
    ///
    /// This is a pure name/path search: it never falls back to scanning file
    /// contents. Full-text search is a separate, explicit operation
    /// (`search_content_grouped`) so that a known filename resolves instantly
    /// without triggering an expensive repository-wide content scan.
    pub async fn search(
        &self,
        repo_path: &Path,
        query: &str,
        options: SearchOptions,
    ) -> Vec<SearchResult> {
        let index = self.index(repo_path).await;
        search_names_in_index(&index, query, options)
    }

    /// Resolve a file reference (bare name like `note.md`, or a path suffix
    /// like `docs/note.md`) to its repository-relative path.
    pub async fn resolve(&self, repo_path: &Path, reference: &str) -> Option<String> {
        let index = self.index(repo_path).await;
        resolve_name_in_index(&index, reference)
    }

    /// Build the root's index ahead of its first request. A no-op for a root
    /// that already has one.
    pub fn warm(&self, repo_path: &Path) {
        if self.cached(repo_path).is_none() {
            self.enqueue(repo_path, Rebuild::Full);
        }
    }

    /// Rebuild both sides. For the watcher's overflow signal, when it cannot
    /// say what changed.
    pub fn invalidate(&self, repo_path: &Path) {
        self.enqueue(repo_path, Rebuild::Full);
    }

    /// HEAD moved: refresh the git history ranking. The files on disk are the
    /// watcher's concern, so this never walks the tree.
    pub fn invalidate_history(&self, repo_path: &Path) {
        self.enqueue(repo_path, Rebuild::History);
    }

    /// Feed a batch of worktree file events into the freshness logic. Queues a
    /// walk only when the batch can change the name index (create, delete,
    /// rename, ignore-rule change, alias edit); pure content modifications are
    /// ignored.
    ///
    /// A repository nobody has searched yet has no index to keep fresh, so
    /// those batches are dropped instead of triggering speculative builds.
    pub fn note_worktree_changes(&self, repo_path: &Path, changes: &[WorktreeChange]) {
        let Some(index) = self.cached(repo_path) else {
            return;
        };
        if changes_require_rebuild(&index, repo_path, changes) {
            self.enqueue(repo_path, Rebuild::Names);
        }
    }

    async fn background_worker(
        mut requests: mpsc::Receiver<BuildRequest>,
        indexes: IndexMap,
        built: watch::Sender<u64>,
    ) {
        let limiter = Arc::new(Semaphore::new(BUILD_CONCURRENCY));
        while let Some(first) = requests.recv().await {
            // Coalesce everything already waiting: one build per root, with
            // the union of the requested scopes.
            let mut pending: HashMap<PathBuf, Rebuild> = HashMap::new();
            pending.insert(first.repo, first.scope);
            while let Ok(request) = requests.try_recv() {
                pending
                    .entry(request.repo)
                    .and_modify(|scope| *scope = scope.merge(request.scope))
                    .or_insert(request.scope);
            }

            let mut builds = JoinSet::new();
            for (repo, scope) in pending {
                let current = indexes
                    .read()
                    .expect("index map poisoned")
                    .get(&repo)
                    .cloned();
                let limiter = limiter.clone();
                builds.spawn(async move {
                    let _permit = limiter.acquire_owned().await;
                    let build_repo = repo.clone();
                    let index = tokio::task::spawn_blocking(move || {
                        build_index(&build_repo, scope, current)
                    })
                    .await;
                    (repo, index)
                });
            }
            while let Some(joined) = builds.join_next().await {
                match joined {
                    Ok((repo, Ok(index))) => {
                        indexes
                            .write()
                            .expect("index map poisoned")
                            .insert(repo, Arc::new(index));
                        built.send_modify(|generation| *generation += 1);
                    }
                    Ok((repo, Err(error))) => {
                        warn!(repo = %repo.display(), %error, "index build panicked");
                    }
                    Err(error) => warn!(%error, "index build task failed"),
                }
            }
        }
    }
}

impl Default for FileSearchCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Produce the index a request asked for, reusing the untouched side of the
/// current one. Without a current index every scope is a full build.
fn build_index(repo_path: &Path, scope: Rebuild, current: Option<Arc<RepoIndex>>) -> RepoIndex {
    let started = Instant::now();
    let index = match (scope, current) {
        (Rebuild::History, Some(current)) => {
            current.with_stats(Arc::new(collect_file_stats(repo_path)))
        }
        (Rebuild::Names, Some(current)) => {
            RepoIndex::from_walk(walk_index(repo_path), current.stats.clone())
        }
        _ => RepoIndex::from_walk(
            walk_index(repo_path),
            Arc::new(collect_file_stats(repo_path)),
        ),
    };
    info!(
        repo = %repo_path.display(),
        ?scope,
        entries = index.files().len(),
        overflowed = index.is_overflowed(),
        elapsed_ms = started.elapsed().as_millis(),
        "built name index"
    );
    index
}

/// File statistics from recent git history. A root that is not a repository
/// (or has no commits) has no history: every file ranks equally.
fn collect_file_stats(repo_path: &Path) -> FileStats {
    let mut stats: FileStats = HashMap::new();
    let Ok(repo) = Repository::open(repo_path) else {
        return stats;
    };
    let Ok(mut revwalk) = repo.revwalk() else {
        return stats;
    };
    if revwalk.push_head().is_err() || revwalk.set_sorting(Sort::TIME).is_err() {
        return stats;
    }

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

    stats
}

/// The product of a filesystem walk, before it is keyed into a [`RepoIndex`].
struct IndexWalk {
    files: Vec<IndexedFile>,
    overflowed: bool,
}

/// Walk the root into index entries. See [`walk_index_with_limit`].
fn walk_index(repo_path: &Path) -> IndexWalk {
    walk_index_with_limit(repo_path, MAX_INDEX_ENTRIES)
}

/// Walk the root into index entries, giving up past `limit` entries. A root
/// that does not exist or cannot be read yields an empty walk.
fn walk_index_with_limit(repo_path: &Path, limit: usize) -> IndexWalk {
    let mut indexed_files = Vec::new();

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
        if non_ignored_paths.len() > limit {
            return IndexWalk {
                files: Vec::new(),
                overflowed: true,
            };
        }
    }

    for entry in walker.flatten() {
        let path = entry.path();

        if path == repo_path {
            continue;
        }

        let Ok(relative_path) = path.strip_prefix(repo_path) else {
            continue;
        };
        let relative_path_str = relative_path.to_string_lossy().to_string();
        let relative_path_key = normalize_key(&relative_path_str);

        if relative_path_key.is_empty() {
            continue;
        }

        let is_ignored = !non_ignored_paths.contains(relative_path);
        let is_file = path.is_file();

        if indexed_files.len() >= limit {
            return IndexWalk {
                files: Vec::new(),
                overflowed: true,
            };
        }
        indexed_files.push(IndexedFile {
            alias_keys: if is_file && !is_ignored {
                read_alias_keys(path)
            } else {
                Vec::new()
            },
            path: relative_path_str,
            is_file,
            path_key: Arc::from(relative_path_key.as_str()),
            is_ignored,
        });
    }

    IndexWalk {
        files: indexed_files,
        overflowed: false,
    }
}

/// Normalized aliases declared in a markdown document's frontmatter.
///
/// Only the leading `---` block is read (see `document::frontmatter::read_file_properties`),
/// and only for markdown, so indexing a repository of source files costs no
/// extra I/O at all. A file that cannot be read contributes no aliases rather
/// than failing the index build.
fn read_alias_keys(path: &Path) -> Vec<Arc<str>> {
    let is_alias_bearing = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ALIAS_BEARING_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        });
    if !is_alias_bearing {
        return Vec::new();
    }

    let Ok(properties) = document::frontmatter::read_file_properties(path) else {
        return Vec::new();
    };
    document::frontmatter::aliases(&properties)
        .into_iter()
        .map(|alias| Arc::from(normalize_key(&alias).as_str()))
        .collect()
}

/// How much a file's git history argues for it, in `0..=HISTORY_MAX`. Used
/// only to break ties between matches of equal quality — see [`matcher`].
/// A file absent from recent history scores zero rather than being penalized.
fn history_score(path: &str, stats: &FileStats) -> i64 {
    let Some(stat) = stats.get(path) else {
        return 0;
    };
    let recency = (100 - stat.last_index.min(99) as i64) * RECENCY_WEIGHT;
    let frequency = stat.commit_count as i64 * FREQUENCY_WEIGHT;
    (recency + frequency).clamp(0, HISTORY_MAX)
}

/// Order scored results best-first, with the path as a final tiebreak so the
/// output is deterministic regardless of index or walk order.
fn rank(mut scored: Vec<(i64, SearchResult)>, limit: usize) -> Vec<SearchResult> {
    scored.sort_by(|(score_a, a), (score_b, b)| score_b.cmp(score_a).then(a.path.cmp(&b.path)));
    scored.truncate(limit);
    scored.into_iter().map(|(_, result)| result).collect()
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

/// Search a cached repository index by name, ranked by relevance.
///
/// Contiguous matching runs first; fuzzy (subsequence) matching only fills in
/// behind it when the contiguous pass came up short, so a query that matches
/// real names never has those results displaced by scattered ones — and the
/// scan only pays for fuzzy when it would actually change the answer.
fn search_names_in_index(
    index: &RepoIndex,
    query: &str,
    options: SearchOptions,
) -> Vec<SearchResult> {
    let query_key = normalize_key(query);

    let mut scored: Vec<(i64, SearchResult)> = index
        .files()
        .iter()
        .filter(|file| options.includes(file))
        .filter_map(|file| {
            let found = match_contiguous(&file.path_key, &file.alias_keys, &query_key)?;
            Some((
                found.score(history_score(&file.path, &index.stats)),
                SearchResult {
                    path: file.path.clone(),
                    is_file: file.is_file,
                    match_type: found.match_type(),
                },
            ))
        })
        .collect();

    if scored.len() < options.limit {
        let already: HashSet<&str> = scored
            .iter()
            .map(|(_, result)| result.path.as_str())
            .collect();
        let fuzzy: Vec<(i64, SearchResult)> = index
            .files()
            .iter()
            .filter(|file| options.includes(file) && !already.contains(file.path.as_str()))
            .filter_map(|file| {
                let found = match_fuzzy(&file.path_key, &query_key)?;
                Some((
                    found.score(history_score(&file.path, &index.stats)),
                    SearchResult {
                        path: file.path.clone(),
                        is_file: file.is_file,
                        match_type: found.match_type(),
                    },
                ))
            })
            .collect();
        scored.extend(fuzzy);
    }

    rank(scored, options.limit)
}

/// A worktree file event in the minimal shape the freshness logic needs.
/// Mirrors the filesystem watcher's event kinds without depending on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone)]
pub struct WorktreeChange {
    pub kind: WorktreeChangeKind,
    /// Path relative to the repository root, `/`-separated. An empty path is
    /// the watcher's overflow/resync marker.
    pub relative_path: String,
}

/// Whether a batch of worktree events can change the name index.
///
/// Creates and deletes always can. Modifications need a closer look because
/// macOS reports renames as `Modified` on both the old and the new path:
/// - the overflow marker (empty path) means events were dropped, so assume yes;
/// - a `.gitignore` edit changes which entries are `is_ignored`;
/// - a path that no longer exists on disk is the old side of a rename (or a
///   delete reported as modify);
/// - a path missing from the index is the new side of a rename;
/// - anything else is a pure content write and cannot move the index.
fn changes_require_rebuild(
    index: &RepoIndex,
    repo_path: &Path,
    changes: &[WorktreeChange],
) -> bool {
    changes.iter().any(|change| match change.kind {
        WorktreeChangeKind::Created | WorktreeChangeKind::Deleted => true,
        WorktreeChangeKind::Modified => {
            if change.relative_path.is_empty() {
                return true;
            }
            if change.relative_path == ".gitignore" || change.relative_path.ends_with("/.gitignore")
            {
                return true;
            }
            if !repo_path.join(&change.relative_path).exists() {
                return true;
            }
            let key = normalize_key(&change.relative_path);
            let Some(indexed) = index.entry_by_path_key(&key) else {
                // Not in the index: the new side of a rename.
                return true;
            };
            // Editing a note can change its declared aliases, which are part
            // of the index. Re-read the block (cheap: markdown only, and only
            // its head) instead of assuming the write was body-only.
            read_alias_keys(&repo_path.join(&change.relative_path)) != indexed.alias_keys
        }
    })
}

/// Resolve a reference against the index.
///
/// The file's own name is tried before any alias, so a document cannot hijack
/// a link to a real file by declaring its name as an alias. Ignored files
/// never resolve: a link target is vault content, not build output.
fn resolve_name_in_index(index: &RepoIndex, reference: &str) -> Option<String> {
    let names = &index.names;
    let file_at = |position: &u32| &names.files[*position as usize];
    let resolvable = |file: &&IndexedFile| file.is_file && !file.is_ignored;
    let best = |candidates: Option<&Vec<u32>>, accept: &dyn Fn(&IndexedFile) -> bool| {
        candidates?
            .iter()
            .map(file_at)
            .filter(resolvable)
            .filter(|file| accept(file))
            .min_by(|a, b| shorter_path(&a.path_key, &b.path_key))
            .map(|file| file.path.clone())
    };

    // Every key is tried by name before any key is tried by alias: `[[note]]`
    // must land on `note.md` even when another document claims `note` as an
    // alias, and that only holds if the `.md` form is exhausted first.
    let keys = reference_keys(reference);
    for key in &keys {
        let basename = key.rsplit('/').next().unwrap_or(key);
        if let Some(path) = best(names.by_name.get(basename), &|file| {
            reference_matches(&file.path_key, key)
        }) {
            return Some(path);
        }
    }
    for key in &keys {
        if let Some(path) = best(names.by_alias.get(key.as_str()), &|_| true) {
            return Some(path);
        }
    }
    None
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
    fn name_search_does_not_match_on_content() {
        let dir = TempDir::new().unwrap();
        // File name has no "needle"; only its contents do.
        write(&dir, "unrelated.rs", "the needle lives here\n");

        let index = RepoIndex::from_walk(walk_index(dir.path()), Arc::new(FileStats::new()));
        let results = search_names_in_index(&index, "needle", SearchOptions::new(10));
        assert!(
            results.is_empty(),
            "name search must not match on file contents, got {results:?}"
        );
    }

    fn entry(path: &str, is_file: bool, is_ignored: bool, aliases: &[&str]) -> IndexedFile {
        IndexedFile {
            path: path.to_string(),
            is_file,
            path_key: Arc::from(normalize_key(path).as_str()),
            alias_keys: aliases
                .iter()
                .map(|alias| Arc::from(normalize_key(alias).as_str()))
                .collect(),
            is_ignored,
        }
    }

    /// Build a minimal index directly, bypassing git and the filesystem, so
    /// matching and freshness rules can be tested in isolation.
    fn cached_repo(paths: &[(&str, bool)]) -> RepoIndex {
        cached_repo_with_aliases(
            &paths
                .iter()
                .map(|&(p, i)| (p, i, &[][..]))
                .collect::<Vec<_>>(),
        )
    }

    /// As [`cached_repo`], with declared frontmatter aliases per entry.
    fn cached_repo_with_aliases(entries: &[(&str, bool, &[&str])]) -> RepoIndex {
        RepoIndex::new(
            entries
                .iter()
                .map(|(path, is_ignored, aliases)| entry(path, true, *is_ignored, aliases))
                .collect(),
            Arc::new(FileStats::new()),
        )
    }

    #[test]
    fn normalize_key_folds_nfd_to_nfc_and_case() {
        // "が" typed (NFC, U+304C) vs stored decomposed (NFD, か + U+3099).
        assert_eq!(normalize_key("\u{304C}"), normalize_key("\u{304B}\u{3099}"));
        // "É" decomposed vs "é" precomposed.
        assert_eq!(normalize_key("E\u{0301}"), normalize_key("\u{00E9}"));
    }

    #[test]
    fn resolve_matches_nfd_stored_name_with_nfc_reference() {
        // Simulates macOS: the filesystem stores the decomposed form
        // (か + combining voiced mark), the user types the precomposed が.
        let cached = cached_repo(&[("docs/設計か\u{3099}き.md", false)]);
        assert_eq!(
            resolve_name_in_index(&cached, "設計\u{304C}き.md"),
            Some("docs/設計か\u{3099}き.md".to_string()),
        );
    }

    #[test]
    fn resolve_bare_name_prefers_shortest_path() {
        let cached = cached_repo(&[
            ("a/very/deep/note.md", false),
            ("docs/note.md", false),
            ("docs/archive/note.md", false),
        ]);
        assert_eq!(
            resolve_name_in_index(&cached, "note.md"),
            Some("docs/note.md".to_string()),
        );
    }

    #[test]
    fn resolve_path_reference_requires_suffix_boundary() {
        let cached = cached_repo(&[("guides/docs/note.md", false), ("mydocs/note.md", false)]);
        // "docs/note.md" must match a whole trailing path, not "mydocs/...".
        assert_eq!(
            resolve_name_in_index(&cached, "docs/note.md"),
            Some("guides/docs/note.md".to_string()),
        );
    }

    #[test]
    fn resolve_appends_md_for_extensionless_reference() {
        let cached = cached_repo(&[("docs/note.md", false), ("note", false)]);
        // The exact form wins over the .md form when both exist.
        assert_eq!(
            resolve_name_in_index(&cached, "note"),
            Some("note".to_string()),
        );
        let cached = cached_repo(&[("docs/note.md", false)]);
        assert_eq!(
            resolve_name_in_index(&cached, "note"),
            Some("docs/note.md".to_string()),
        );
    }

    #[test]
    fn resolve_skips_ignored_files() {
        let cached = cached_repo(&[("dist/note.md", true), ("src/note.md", false)]);
        assert_eq!(
            resolve_name_in_index(&cached, "note.md"),
            Some("src/note.md".to_string()),
        );
        let only_ignored = cached_repo(&[("dist/note.md", true)]);
        assert_eq!(resolve_name_in_index(&only_ignored, "note.md"), None);
    }

    #[test]
    fn resolve_is_case_insensitive() {
        let cached = cached_repo(&[("docs/README.md", false)]);
        assert_eq!(
            resolve_name_in_index(&cached, "readme.md"),
            Some("docs/README.md".to_string()),
        );
    }

    #[test]
    fn walked_index_resolves_with_the_shortest_path_rule() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a/deep/nested/note.md", "x");
        write(&dir, "docs/note.md", "x");

        let index = RepoIndex::from_walk(walk_index(dir.path()), Arc::new(FileStats::new()));
        assert_eq!(
            resolve_name_in_index(&index, "note"),
            Some("docs/note.md".to_string()),
        );
        assert_eq!(resolve_name_in_index(&index, "absent.md"), None);
    }

    #[test]
    fn a_root_past_the_entry_cap_indexes_nothing() {
        let dir = TempDir::new().unwrap();
        for n in 0..8 {
            write(&dir, &format!("notes/{n}.md"), "x");
        }

        let walk = walk_index_with_limit(dir.path(), 4);
        assert!(walk.overflowed);
        let index = RepoIndex::from_walk(walk, Arc::new(FileStats::new()));
        assert!(index.is_overflowed());
        assert!(
            index.files().is_empty(),
            "a partial index must not resolve anything"
        );
        assert_eq!(resolve_name_in_index(&index, "0.md"), None);
    }

    #[test]
    fn a_missing_root_walks_to_an_empty_index() {
        let walk = walk_index(Path::new("/definitely/not/a/directory"));
        assert!(!walk.overflowed);
        assert!(walk.files.is_empty());
    }

    #[test]
    fn history_refresh_keeps_the_walked_names() {
        let index = cached_repo(&[("note.md", false)]);
        let mut stats = FileStats::new();
        stats.insert(
            "note.md".to_string(),
            FileStat {
                last_index: 0,
                commit_count: 1,
                last_time: Utc::now(),
            },
        );
        let refreshed = index.with_stats(Arc::new(stats));
        assert_eq!(refreshed.files().len(), 1);
        assert_eq!(refreshed.stats.len(), 1);
        assert_eq!(
            resolve_name_in_index(&refreshed, "note"),
            Some("note.md".to_string())
        );
    }

    #[tokio::test]
    async fn cold_reads_wait_for_the_first_build_and_stale_reads_do_not_wait() {
        let dir = TempDir::new().unwrap();
        write(&dir, "docs/note.md", "x");
        let cache = FileSearchCache::new();

        assert_eq!(
            cache.resolve(dir.path(), "note").await,
            Some("docs/note.md".to_string())
        );

        // A structural change queues a rebuild; the read that follows is
        // answered by the index already in hand, never by a walk.
        write(&dir, "docs/other.md", "x");
        cache.note_worktree_changes(
            dir.path(),
            &[change(WorktreeChangeKind::Created, "docs/other.md")],
        );
        let served = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            cache.resolve(dir.path(), "note"),
        )
        .await
        .expect("a warm root answers without waiting for its rebuild");
        assert_eq!(served, Some("docs/note.md".to_string()));

        // And the rebuild lands.
        let mut generation = cache.built.subscribe();
        generation.borrow_and_update();
        while cache.resolve(dir.path(), "other").await.is_none() {
            generation.changed().await.unwrap();
        }
    }

    #[test]
    fn rebuild_scopes_merge_to_a_full_build() {
        assert_eq!(Rebuild::Names.merge(Rebuild::Names), Rebuild::Names);
        assert_eq!(Rebuild::History.merge(Rebuild::History), Rebuild::History);
        assert_eq!(Rebuild::Names.merge(Rebuild::History), Rebuild::Full);
        assert_eq!(Rebuild::Full.merge(Rebuild::Names), Rebuild::Full);
    }

    fn change(kind: WorktreeChangeKind, path: &str) -> WorktreeChange {
        WorktreeChange {
            kind,
            relative_path: path.to_string(),
        }
    }

    #[test]
    fn creates_and_deletes_require_rebuild() {
        let dir = TempDir::new().unwrap();
        let cached = cached_repo(&[("src/main.rs", false)]);
        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Created, "src/new.rs")],
        ));
        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Deleted, "src/main.rs")],
        ));
    }

    #[test]
    fn content_modification_of_indexed_file_does_not_rebuild() {
        let dir = TempDir::new().unwrap();
        write(&dir, "src/main.rs", "fn main() {}");
        let cached = cached_repo(&[("src/main.rs", false)]);
        assert!(!changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, "src/main.rs")],
        ));
    }

    #[test]
    fn rename_reported_as_modified_requires_rebuild() {
        let dir = TempDir::new().unwrap();
        write(&dir, "src/renamed.rs", "fn main() {}");
        let cached = cached_repo(&[("src/original.rs", false)]);

        // Old side: indexed but no longer on disk.
        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, "src/original.rs")],
        ));
        // New side: on disk but not indexed.
        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, "src/renamed.rs")],
        ));
    }

    #[test]
    fn gitignore_edit_and_overflow_marker_require_rebuild() {
        let dir = TempDir::new().unwrap();
        write(&dir, ".gitignore", "dist\n");
        write(&dir, "pkg/.gitignore", "out\n");
        let cached = cached_repo(&[
            (".gitignore", false),
            ("pkg/.gitignore", false),
            ("src/main.rs", false),
        ]);

        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, ".gitignore")],
        ));
        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, "pkg/.gitignore")],
        ));
        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, "")],
        ));
    }

    fn paths_of(results: &[SearchResult]) -> Vec<&str> {
        results.iter().map(|r| r.path.as_str()).collect()
    }

    #[test]
    fn search_ranks_name_matches_above_directory_and_path_matches() {
        let cached = cached_repo(&[
            ("src/note/other.rs", false),
            ("deep/a/b/note.rs", false),
            ("note.rs", false),
        ]);
        let results = search_names_in_index(&cached, "note", SearchOptions::new(10));
        assert_eq!(
            paths_of(&results),
            vec!["note.rs", "deep/a/b/note.rs", "src/note/other.rs"],
            "name match, then the shallower name match, then the directory match"
        );
    }

    #[test]
    fn search_reports_the_match_kind_the_query_actually_hit() {
        let cached = cached_repo(&[("src/note/other.rs", false)]);
        let results = search_names_in_index(&cached, "note", SearchOptions::new(10));
        assert!(matches!(
            results[0].match_type,
            SearchMatchType::DirectoryName
        ));

        let cached = cached_repo(&[("src/note.rs", false)]);
        let results = search_names_in_index(&cached, "note", SearchOptions::new(10));
        assert!(matches!(results[0].match_type, SearchMatchType::FileName));
    }

    #[test]
    fn search_falls_back_to_fuzzy_only_behind_contiguous_matches() {
        let cached = cached_repo(&[
            ("file-search-cache/src/lib.rs", false),
            ("fsc.rs", false),
            ("noise.rs", false),
        ]);
        let results = search_names_in_index(&cached, "fsc", SearchOptions::new(10));
        assert_eq!(
            results[0].path, "fsc.rs",
            "the contiguous match must come first"
        );
        assert!(
            paths_of(&results).contains(&"file-search-cache/src/lib.rs"),
            "the fuzzy acronym match must still be reachable, got {:?}",
            paths_of(&results)
        );
        assert!(!paths_of(&results).contains(&"noise.rs"));
    }

    #[test]
    fn files_only_drops_directories_before_the_limit_applies() {
        let cached = RepoIndex::new(
            vec![
                entry("note", false, false, &[]),
                entry("note.md", true, false, &[]),
            ],
            Arc::new(FileStats::new()),
        );

        let with_dirs = search_names_in_index(&cached, "note", SearchOptions::new(1));
        assert_eq!(
            paths_of(&with_dirs),
            vec!["note"],
            "the directory outranks the file on name-exactness, taking the only slot"
        );

        let files_only =
            search_names_in_index(&cached, "note", SearchOptions::new(1).files_only(true));
        assert_eq!(
            paths_of(&files_only),
            vec!["note.md"],
            "filtering must happen before the limit, not after"
        );
    }

    #[test]
    fn search_matches_frontmatter_aliases() {
        let cached = cached_repo_with_aliases(&[
            ("docs/20260805.md", false, &["Engine Design"][..]),
            ("docs/unrelated.md", false, &[][..]),
        ]);
        let results = search_names_in_index(&cached, "engine design", SearchOptions::new(10));
        assert_eq!(paths_of(&results), vec!["docs/20260805.md"]);
    }

    #[test]
    fn search_ranks_git_history_only_among_equal_matches() {
        let mut stats = FileStats::new();
        stats.insert(
            "b/note.md".to_string(),
            FileStat {
                last_index: 0,
                commit_count: 20,
                last_time: Utc::now(),
            },
        );
        let cached =
            cached_repo(&[("a/note.md", false), ("b/note.md", false)]).with_stats(Arc::new(stats));

        let results = search_names_in_index(&cached, "note", SearchOptions::new(10));
        assert_eq!(
            paths_of(&results),
            vec!["b/note.md", "a/note.md"],
            "equal-quality matches are ordered by git history"
        );
    }

    #[test]
    fn empty_query_lists_the_most_recently_touched_files() {
        let mut stats = FileStats::new();
        stats.insert(
            "rarely.md".to_string(),
            FileStat {
                last_index: 90,
                commit_count: 1,
                last_time: Utc::now(),
            },
        );
        stats.insert(
            "hot.md".to_string(),
            FileStat {
                last_index: 0,
                commit_count: 30,
                last_time: Utc::now(),
            },
        );
        let cached = cached_repo(&[("rarely.md", false), ("hot.md", false), ("cold.md", false)])
            .with_stats(Arc::new(stats));

        let results = search_names_in_index(&cached, "", SearchOptions::new(10));
        assert_eq!(paths_of(&results), vec!["hot.md", "rarely.md", "cold.md"]);
    }

    #[test]
    fn resolve_prefers_a_real_file_name_over_another_file_s_alias() {
        let cached = cached_repo_with_aliases(&[
            ("archive/hijack.md", false, &["note"][..]),
            ("deep/a/b/note.md", false, &[][..]),
        ]);
        assert_eq!(
            resolve_name_in_index(&cached, "note"),
            Some("deep/a/b/note.md".to_string()),
            "an alias must not shadow a file that really has that name",
        );
    }

    #[test]
    fn resolve_falls_back_to_an_alias_when_no_file_has_the_name() {
        let cached = cached_repo_with_aliases(&[
            ("docs/20260805.md", false, &["Engine Design"][..]),
            ("docs/other.md", false, &[][..]),
        ]);
        assert_eq!(
            resolve_name_in_index(&cached, "Engine Design"),
            Some("docs/20260805.md".to_string()),
        );
    }

    #[test]
    fn index_build_reads_aliases_from_markdown_only() {
        let dir = TempDir::new().unwrap();
        write(&dir, "note.md", "---\naliases:\n  - Alpha\n---\nbody\n");
        write(&dir, "code.rs", "---\naliases:\n  - Beta\n---\n");

        let indexed = walk_index(dir.path()).files;
        let alias_of = |name: &str| {
            indexed
                .iter()
                .find(|file| file.path == name)
                .map(|file| file.alias_keys.clone())
                .unwrap()
        };
        assert_eq!(alias_of("note.md"), vec![Arc::from("alpha")]);
        assert!(
            alias_of("code.rs").is_empty(),
            "non-markdown files must cost no frontmatter read"
        );
    }

    #[test]
    fn editing_a_note_s_aliases_requires_rebuild_but_editing_its_body_does_not() {
        let dir = TempDir::new().unwrap();
        write(&dir, "note.md", "---\naliases:\n  - Alpha\n---\nbody\n");
        let cached = cached_repo_with_aliases(&[("note.md", false, &["Alpha"][..])]);

        assert!(!changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, "note.md")],
        ));

        write(&dir, "note.md", "---\naliases:\n  - Alpha\n  - Beta\n---\n");
        assert!(changes_require_rebuild(
            &cached,
            dir.path(),
            &[change(WorktreeChangeKind::Modified, "note.md")],
        ));
    }

    #[test]
    fn name_search_matches_across_normalization_forms() {
        let dir = TempDir::new().unwrap();
        // Write the decomposed form to disk; query with the precomposed form.
        write(&dir, "設計か\u{3099}き.md", "x");
        let index = RepoIndex::from_walk(walk_index(dir.path()), Arc::new(FileStats::new()));
        let results = search_names_in_index(&index, "設計\u{304C}", SearchOptions::new(10));
        assert_eq!(results.len(), 1, "NFC query must match NFD file name");
    }
}
