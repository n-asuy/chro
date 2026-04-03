use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use git::GitService;
use once_cell::sync::Lazy;
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

type SharedLock = Arc<AsyncMutex<()>>;
static WORKTREE_LOCKS: Lazy<AsyncMutex<HashMap<PathBuf, SharedLock>>> =
    Lazy::new(|| AsyncMutex::new(HashMap::new()));

/// Default directory used to store Chro worktrees when none is specified.
pub fn default_base_dir() -> PathBuf {
    if let Ok(custom) = env::var("CHRO_WORKTREE_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }

    let mut root = if cfg!(target_os = "linux") {
        PathBuf::from("/var/tmp")
    } else {
        env::temp_dir()
    };

    let dir_name = if cfg!(debug_assertions) {
        "chro-dev"
    } else {
        "chro"
    };

    root.push(dir_name);
    root.push("worktrees");
    root
}

/// Human-friendly slug used for directory and branch names.
pub fn slugify_title(input: &str) -> String {
    let slug = input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = slug.trim_matches('-');
    let collapsed = trimmed
        .split('-')
        .filter(|segment| !segment.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("-");

    if collapsed.is_empty() {
        "task".to_string()
    } else {
        collapsed.chars().take(32).collect()
    }
}

fn short_id(value: &str) -> String {
    let alnum: String = value.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let trimmed = alnum.trim_start_matches('0');
    let slice = trimmed.chars().take(4).collect::<String>();
    if slice.is_empty() {
        "0000".to_string()
    } else {
        slice
    }
}

/// Directory name used for storing a particular attempt's worktree.
pub fn worktree_dir_name(task_title: &str, attempt_id: &str) -> String {
    format!("{}-{}", short_id(attempt_id), slugify_title(task_title))
}

/// Generates a deterministic attempt branch name (e.g. `ch/1a2b-fix-bug`).
pub fn generate_attempt_branch_name(task_title: &str, attempt_id: &str) -> String {
    format!(
        "ch/{short}-{slug}",
        short = short_id(attempt_id),
        slug = slugify_title(task_title)
    )
}

/// Resolves a fully-qualified worktree path inside a base directory.
pub fn resolve_worktree_path(
    base_dir: impl AsRef<Path>,
    task_title: &str,
    attempt_id: &str,
) -> PathBuf {
    base_dir
        .as_ref()
        .join(worktree_dir_name(task_title, attempt_id))
}

/// Parameters for ensuring a worktree exists.
#[derive(Debug, Clone)]
pub struct EnsureOptions {
    pub branch_name: String,
    pub base_branch: Option<String>,
    pub worktree_path: Option<PathBuf>,
    pub create_branch: bool,
}

impl EnsureOptions {
    pub fn new(branch: impl Into<String>) -> Self {
        Self {
            branch_name: branch.into(),
            base_branch: None,
            worktree_path: None,
            create_branch: false,
        }
    }

    pub fn with_base_branch(mut self, branch: impl Into<String>) -> Self {
        self.base_branch = Some(branch.into());
        self
    }

    pub fn with_worktree_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.worktree_path = Some(path.into());
        self
    }

    pub fn create_branch(mut self) -> Self {
        self.create_branch = true;
        self
    }
}

#[derive(Debug)]
pub struct WorktreeHandle {
    pub path: PathBuf,
    pub branch: String,
    pub freshly_created: bool,
}

/// Manager responsible for creating, reusing, and cleaning Chro worktrees.
#[derive(Debug, Clone)]
pub struct WorktreeManager {
    git: GitService,
    base_dir: Arc<PathBuf>,
}

impl Default for WorktreeManager {
    fn default() -> Self {
        Self::new(None)
    }
}

impl WorktreeManager {
    pub fn new(base_dir: Option<PathBuf>) -> Self {
        let dir = base_dir.unwrap_or_else(default_base_dir);
        fs::create_dir_all(&dir).expect("failed to initialize worktree directory");
        Self {
            git: GitService::new(),
            base_dir: Arc::new(dir),
        }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn derive_worktree_path(&self, attempt_id: &str, task_title: &str) -> PathBuf {
        resolve_worktree_path(&*self.base_dir, task_title, attempt_id)
    }

    pub async fn ensure_worktree(
        &self,
        repo_path: impl AsRef<Path>,
        mut options: EnsureOptions,
    ) -> Result<WorktreeHandle, WorktreeError> {
        let repo_path = repo_path.as_ref().to_path_buf();
        if options.branch_name.trim().is_empty() {
            return Err(WorktreeError::InvalidArgument(
                "branch name is required".into(),
            ));
        }

        let requested_path = options.worktree_path.take();
        let mut worktree_path = requested_path
            .clone()
            .unwrap_or_else(|| self.base_dir.join(&options.branch_name));
        let use_default_path = requested_path.is_none();

        if let Some(existing_path) = self
            .find_worktree_for_branch(&repo_path, &options.branch_name)
            .await?
        {
            let existing_normalized =
                canonicalize_if_exists(&existing_path).unwrap_or(existing_path.clone());
            let desired_normalized =
                canonicalize_if_exists(&worktree_path).unwrap_or_else(|| worktree_path.clone());
            if existing_normalized != desired_normalized {
                if use_default_path {
                    tracing::info!(
                        branch = %options.branch_name,
                        existing = %existing_path.display(),
                        desired = %worktree_path.display(),
                        "branch already checked out at different path; reusing existing worktree"
                    );
                    worktree_path = existing_path;
                } else {
                    return Err(WorktreeError::InvalidArgument(format!(
                        "branch `{}` already checked out at {}",
                        options.branch_name,
                        existing_path.display()
                    )));
                }
            }
        }
        let lock = acquire_lock(&worktree_path).await;

        if options.create_branch {
            self.git.ensure_branch_exists(
                &repo_path,
                &options.branch_name,
                options.base_branch.as_deref(),
            )?;
        }

        let ready = self.is_worktree_ready(&repo_path, &worktree_path).await?;
        let freshly_created = if ready {
            false
        } else {
            self.recreate_worktree(&repo_path, &worktree_path, &options.branch_name)
                .await?;
            true
        };

        drop(lock);
        Ok(WorktreeHandle {
            path: worktree_path,
            branch: options.branch_name,
            freshly_created,
        })
    }

    pub async fn cleanup_worktree(
        &self,
        worktree_path: impl AsRef<Path>,
        repo_path: Option<impl AsRef<Path>>,
    ) -> Result<(), WorktreeError> {
        let worktree_path = worktree_path.as_ref().to_path_buf();
        let lock = acquire_lock(&worktree_path).await;

        if !self.is_within_base_dir(&worktree_path) {
            drop(lock);
            return Err(WorktreeError::InvalidArgument(format!(
                "worktree path outside base dir: {}",
                worktree_path.display()
            )));
        }

        let repo = if let Some(path) = repo_path {
            path.as_ref().to_path_buf()
        } else {
            match infer_repo_from_worktree(&worktree_path).await? {
                Some(path) => path,
                None => {
                    if worktree_path.exists() {
                        remove_dir_recursive(&worktree_path).await?;
                    }
                    drop(lock);
                    return Ok(());
                }
            }
        };

        let _ = run_git_command(
            &repo,
            &["worktree", "remove", "--force", path_to_arg(&worktree_path)],
        )
        .await;
        force_remove_metadata(&repo, &worktree_path)?;
        remove_dir_recursive(&worktree_path).await?;

        drop(lock);
        Ok(())
    }

    pub async fn list_registered_worktrees(
        &self,
        repo_path: impl AsRef<Path>,
    ) -> Result<Vec<PathBuf>, WorktreeError> {
        let repo_path = repo_path.as_ref().to_path_buf();
        let output =
            run_git_command_with_output(&repo_path, &["worktree", "list", "--porcelain"]).await?;
        Ok(parse_worktree_list(&output))
    }

    /// Removes every registered worktree that is not part of `keep_paths`.
    pub async fn cleanup_stale_worktrees<I, P>(
        &self,
        repo_path: impl AsRef<Path>,
        keep_paths: I,
    ) -> Result<Vec<PathBuf>, WorktreeError>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let repo_path = repo_path.as_ref().to_path_buf();
        let keep: HashSet<PathBuf> = keep_paths
            .into_iter()
            .filter_map(|p| canonicalize_if_exists(p.as_ref()))
            .collect();
        let registered = self.list_registered_worktrees(&repo_path).await?;
        let mut cleaned = Vec::new();
        for path in registered {
            if keep.contains(&path) {
                continue;
            }
            self.cleanup_worktree(&path, Some(&repo_path)).await?;
            cleaned.push(path);
        }
        Ok(cleaned)
    }

    async fn recreate_worktree(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        branch: &str,
    ) -> Result<(), WorktreeError> {
        if worktree_path.exists() {
            self.cleanup_worktree(worktree_path, Some(repo_path))
                .await?;
        }

        if let Some(existing_path) = self.find_worktree_for_branch(repo_path, branch).await? {
            if existing_path != worktree_path {
                tracing::warn!(
                    branch = %branch,
                    existing = %existing_path.display(),
                    desired = %worktree_path.display(),
                    "branch already checked out at different path; refusing to delete existing worktree"
                );
                return Err(WorktreeError::InvalidArgument(format!(
                    "branch already checked out at {}",
                    existing_path.display()
                )));
            }
        }

        if let Some(parent) = worktree_path.parent() {
            let parent = parent.to_path_buf();
            tokio::task::spawn_blocking(move || fs::create_dir_all(parent))
                .await
                .map_err(|err| WorktreeError::Join(err.to_string()))??;
        }

        run_git_command(
            repo_path,
            &["worktree", "add", path_to_arg(worktree_path), branch],
        )
        .await?;
        Ok(())
    }

    /// Find the path of an existing worktree that has the given branch checked out.
    async fn find_worktree_for_branch(
        &self,
        repo_path: &Path,
        branch: &str,
    ) -> Result<Option<PathBuf>, WorktreeError> {
        let output =
            run_git_command_with_output(repo_path, &["worktree", "list", "--porcelain"]).await?;

        let mut current_path: Option<PathBuf> = None;
        for line in output.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                current_path = Some(PathBuf::from(rest.trim()));
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let wt_branch = rest
                    .trim()
                    .trim_start_matches("refs/heads/")
                    .trim_start_matches("refs/remotes/origin/");
                if wt_branch == branch {
                    return Ok(current_path);
                }
                current_path = None;
            }
        }
        Ok(None)
    }

    async fn is_worktree_ready(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
    ) -> Result<bool, WorktreeError> {
        if !worktree_path.exists() {
            return Ok(false);
        }
        let canonical = match canonicalize_if_exists(worktree_path) {
            Some(path) => path,
            None => return Ok(false),
        };
        let registered = self.list_registered_worktrees(repo_path).await?;
        Ok(registered.iter().any(|entry| entry == &canonical))
    }

    fn is_within_base_dir(&self, path: &Path) -> bool {
        let base_dir = canonicalize_if_exists(self.base_dir.as_ref())
            .unwrap_or_else(|| self.base_dir.as_ref().to_path_buf());
        let candidate = canonicalize_if_exists(path).unwrap_or_else(|| path.to_path_buf());
        candidate.starts_with(&base_dir)
    }
}

#[derive(Debug, Error)]
pub enum WorktreeError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Git(#[from] git::GitServiceError),
    #[error("git command `{command}` failed: {stderr}")]
    GitCommand { command: String, stderr: String },
    #[error("task join error: {0}")]
    Join(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
}

async fn run_git_command(repo_path: &Path, args: &[&str]) -> Result<(), WorktreeError> {
    run_git_command_with_output(repo_path, args)
        .await
        .map(|_| ())
}

async fn run_git_command_with_output(
    repo_path: &Path,
    args: &[&str],
) -> Result<String, WorktreeError> {
    let repo = repo_path.to_path_buf();
    let argv = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let argv_for_cmd = argv.clone();
    let output = tokio::task::spawn_blocking(move || {
        Command::new("git")
            .args(&argv_for_cmd)
            .current_dir(repo)
            .output()
    })
    .await
    .map_err(|err| WorktreeError::Join(err.to_string()))??;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(WorktreeError::GitCommand {
            command: format!("git {}", argv.join(" ")),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
}

fn parse_worktree_list(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(|path| PathBuf::from(path.trim()))
        .filter_map(|path| canonicalize_if_exists(&path))
        .collect()
}

async fn infer_repo_from_worktree(worktree_path: &Path) -> Result<Option<PathBuf>, WorktreeError> {
    if !worktree_path.exists() {
        return Ok(None);
    }

    let worktree = worktree_path.to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        Command::new("git")
            .arg("rev-parse")
            .arg("--git-common-dir")
            .current_dir(worktree)
            .output()
    })
    .await
    .map_err(|err| WorktreeError::Join(err.to_string()))??;

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(None);
    }

    let git_dir = PathBuf::from(stdout);
    if git_dir.ends_with(".git") {
        Ok(git_dir.parent().map(PathBuf::from))
    } else {
        Ok(Some(git_dir))
    }
}

fn force_remove_metadata(repo_path: &Path, worktree_path: &Path) -> Result<(), WorktreeError> {
    let name = worktree_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| WorktreeError::InvalidArgument("worktree path missing file name".into()))?;
    let git_dir = resolve_git_dir(repo_path);
    let metadata_path = git_dir.join("worktrees").join(name);
    if metadata_path.exists() {
        fs::remove_dir_all(metadata_path)?;
    }
    Ok(())
}

fn resolve_git_dir(repo_path: &Path) -> PathBuf {
    let git_dir = repo_path.join(".git");
    if git_dir.is_dir() {
        return git_dir;
    }

    if git_dir.is_file() {
        if let Ok(contents) = fs::read_to_string(&git_dir) {
            if let Some(rest) = contents.lines().find(|line| line.starts_with("gitdir:")) {
                if let Some(path) = rest.split_once(':').map(|(_, value)| value.trim()) {
                    let resolved = PathBuf::from(path);
                    if resolved.is_absolute() {
                        return resolved;
                    }
                    return git_dir
                        .parent()
                        .map(|parent| parent.join(&resolved))
                        .unwrap_or(resolved);
                }
            }
        }
    }

    git_dir
}

fn canonicalize_if_exists(path: &Path) -> Option<PathBuf> {
    if path.exists() {
        path.canonicalize().ok()
    } else {
        None
    }
}

async fn remove_dir_recursive(path: &Path) -> Result<(), WorktreeError> {
    if !path.exists() {
        return Ok(());
    }
    let target = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        if target.exists() {
            fs::remove_dir_all(target)?;
        }
        Ok::<_, io::Error>(())
    })
    .await
    .map_err(|err| WorktreeError::Join(err.to_string()))??;
    Ok(())
}

async fn acquire_lock(path: &Path) -> OwnedMutexGuard<()> {
    let key = path.to_path_buf();
    let lock = {
        let mut map = WORKTREE_LOCKS.lock().await;
        map.entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

fn path_to_arg(path: &Path) -> &str {
    path.to_str().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_handles_symbols() {
        assert_eq!(slugify_title("Hello World!!"), "hello-world");
        assert_eq!(slugify_title("  "), "task");
    }

    #[test]
    fn branch_name_uses_short_id() {
        let name = generate_attempt_branch_name(
            "Implement Feature",
            "123e4567-e89b-12d3-a456-426614174000",
        );
        assert!(name.starts_with("ch/123e"));
    }

    #[test]
    fn resolve_path_uses_base_dir() {
        let base = PathBuf::from("/tmp/worktrees");
        let resolved = resolve_worktree_path(&base, "Fix bug", "abcd-1234");
        assert!(resolved.starts_with(&base));
    }
}
