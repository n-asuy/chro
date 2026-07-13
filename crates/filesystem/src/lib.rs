use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use ignore::WalkBuilder;
use rayon::prelude::*;
use thiserror::Error;

pub mod watcher;
pub mod workspace;

pub use watcher::{
    FilesystemWatcherError, WorktreeEvent, WorktreeEventBatch, WorktreeEventKind,
    WorktreeWatcherService,
};
pub use workspace::{
    classify_media, MediaEntry, MediaKind, WorkspaceBinaryFile, WorkspaceEntry,
    WorkspaceEntryDetail, WorkspaceEntryType, WorkspaceFile,
};

#[derive(Debug, Clone)]
pub struct RepoCandidate {
    pub path: PathBuf,
    pub score: RepoScore,
}

#[derive(Debug, Clone, Copy)]
pub struct RepoScore {
    pub git_weight: u8,
    pub depth: usize,
}

#[derive(Debug, Clone)]
pub struct FileMatch {
    pub path: PathBuf,
    pub snippet: Option<String>,
}

#[derive(Debug, Error)]
pub enum FilesystemError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("timeout after {0:?}")]
    Timeout(Duration),
    #[error("workspace directory does not exist")]
    WorkspaceMissing,
    #[error("invalid workspace-relative path")]
    InvalidRelativePath,
    #[error("path is outside the workspace root")]
    OutsideWorkspace,
    #[error("target is not a directory")]
    NotDirectory,
    #[error("target is not a file")]
    NotFile,
    #[error("path does not exist")]
    NotFound,
    #[error("directory does not exist")]
    DirectoryDoesNotExist,
    #[error("destination already exists")]
    AlreadyExists,
}

/// Entry in a directory listing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_directory: bool,
    pub is_git_repo: bool,
}

/// Response for directory listing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DirectoryListResponse {
    pub entries: Vec<DirectoryEntry>,
    pub current_path: String,
    pub is_git_repo: bool,
}

/// Utility responsible for filesystem discovery.
#[derive(Debug, Default, Clone)]
pub struct FilesystemService;

impl FilesystemService {
    pub const DEFAULT_MAX_REPOS: usize = 32;
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

    pub fn new() -> Self {
        Self
    }

    /// Get the user's home directory.
    fn get_home_directory() -> PathBuf {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    }

    /// Verify that a path exists and is a directory.
    fn verify_directory(path: &Path) -> Result<(), FilesystemError> {
        if !path.exists() {
            return Err(FilesystemError::DirectoryDoesNotExist);
        }
        if !path.is_dir() {
            return Err(FilesystemError::NotDirectory);
        }
        Ok(())
    }

    /// List entries in a directory. If path is None, lists the home directory.
    pub fn list_directory(
        &self,
        path: Option<String>,
    ) -> Result<DirectoryListResponse, FilesystemError> {
        let path = path
            .map(PathBuf::from)
            .unwrap_or_else(Self::get_home_directory);
        Self::verify_directory(&path)?;

        let entries = fs::read_dir(&path)?;
        let mut directory_entries = Vec::new();

        for entry in entries.flatten() {
            let entry_path = entry.path();
            let metadata = entry.metadata().ok();
            if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') && name != ".." {
                    continue;
                }

                let is_directory = metadata.is_some_and(|m| m.is_dir());
                let is_git_repo = if is_directory {
                    entry_path.join(".git").exists()
                } else {
                    false
                };

                directory_entries.push(DirectoryEntry {
                    name: name.to_string(),
                    path: entry_path,
                    is_directory,
                    is_git_repo,
                });
            }
        }

        directory_entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        let is_git_repo = path.join(".git").exists();

        Ok(DirectoryListResponse {
            entries: directory_entries,
            current_path: path.to_string_lossy().to_string(),
            is_git_repo,
        })
    }

    /// Traverse directories starting at `root` and collect Git repositories.
    pub fn list_git_repositories(
        &self,
        root: impl AsRef<Path>,
        limit: usize,
        timeout: Duration,
    ) -> Result<Vec<RepoCandidate>, FilesystemError> {
        let max = limit.clamp(1, 256);
        let deadline = Instant::now() + timeout;
        let mut repos = Vec::new();

        for entry in WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(false)
            .git_exclude(false)
            .git_global(false)
            .max_depth(Some(6))
            .same_file_system(true)
            .build()
        {
            if Instant::now() >= deadline {
                return Err(FilesystemError::Timeout(timeout));
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                continue;
            }
            if entry.path().file_name() == Some(std::ffi::OsStr::new(".git")) {
                if let Some(repo_root) = entry.path().parent() {
                    repos.push(RepoCandidate {
                        path: repo_root.to_path_buf(),
                        score: RepoScore {
                            git_weight: 10,
                            depth: entry.depth(),
                        },
                    });
                }
            }
            if repos.len() >= max {
                break;
            }
        }

        repos.sort_by_key(|candidate| candidate.score.depth);
        repos.truncate(max);
        Ok(repos)
    }

    /// Search files matching `needle` within `root`.
    pub fn search_files(
        &self,
        root: impl AsRef<Path>,
        needle: &str,
        limit: usize,
    ) -> Result<Vec<FileMatch>, FilesystemError> {
        let root = root.as_ref().to_path_buf();
        let max = limit.clamp(1, 200);
        let walker = WalkBuilder::new(&root)
            .standard_filters(true)
            .max_depth(Some(10))
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|ft| ft.is_file()).unwrap_or(false))
            .map(|entry| entry.into_path())
            .collect::<Vec<_>>();

        let needle_lower = needle.to_ascii_lowercase();
        let mut matches: Vec<FileMatch> = walker
            .par_iter()
            .filter_map(|path| match contains_match(path, &needle_lower) {
                Ok(snippet) => snippet.map(|snippet| FileMatch {
                    path: path.clone(),
                    snippet: Some(snippet),
                }),
                Err(_) => None,
            })
            .collect();
        matches.truncate(max);

        Ok(matches)
    }

    /// Reveal `path` in the platform's file manager.
    ///
    /// - macOS: `open -R <path>` (selects the item in Finder)
    /// - Linux: `xdg-open` on the parent directory
    /// - Windows: `explorer /select,<path>`
    pub fn reveal_in_file_manager(&self, path: impl AsRef<Path>) -> Result<(), FilesystemError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(FilesystemError::NotFound);
        }

        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg("-R").arg(path).spawn()?;
        }

        #[cfg(target_os = "linux")]
        {
            let dir = if path.is_dir() {
                path
            } else {
                path.parent().unwrap_or(path)
            };
            Command::new("xdg-open").arg(dir).spawn()?;
        }

        #[cfg(target_os = "windows")]
        {
            Command::new("explorer")
                .arg(format!("/select,{}", path.display()))
                .spawn()?;
        }

        Ok(())
    }
}

fn contains_match(path: &Path, needle_lower: &str) -> Result<Option<String>, io::Error> {
    let content = fs::read(path)?;
    let haystack = String::from_utf8_lossy(&content);
    let lower = haystack.to_ascii_lowercase();
    if let Some(pos) = lower.find(needle_lower) {
        let start = pos.saturating_sub(80);
        let end = (pos + needle_lower.len() + 80).min(lower.len());
        let snippet = &haystack[start..end];
        return Ok(Some(snippet.trim().to_string()));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn detect_git_repo() {
        let dir = tempdir().unwrap();
        let repo_path = dir.path().join("example");
        fs::create_dir_all(repo_path.join(".git")).unwrap();

        let fs_service = FilesystemService::new();
        let repos = fs_service
            .list_git_repositories(dir.path(), 5, FilesystemService::DEFAULT_TIMEOUT)
            .unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].path, repo_path);
    }

    #[test]
    fn file_search_returns_snippet() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        let mut file = fs::File::create(&file_path).unwrap();
        writeln!(file, "Chro makes agents local").unwrap();

        let fs_service = FilesystemService::new();
        let matches = fs_service.search_files(dir.path(), "Chro", 5).unwrap();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].snippet.as_ref().unwrap().contains("Chro"));
    }
}
