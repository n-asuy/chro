use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitCliError {
    #[error("git is not available")]
    NotAvailable,
    #[error("git command failed: {0}")]
    CommandFailed(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("failed to parse worktree output: {0}")]
    Parse(String),
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    #[error("push rejected: {0}")]
    PushRejected(String),
    #[error("rebase in progress in this worktree")]
    RebaseInProgress,
}

#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct GitCli;

impl GitCli {
    pub fn new() -> Self {
        Self
    }

    /// Run a git command and return stdout on success
    fn git<I, S>(&self, cwd: &Path, args: I) -> Result<String, GitCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let args: Vec<_> = args.into_iter().collect();
        let output = Command::new("git")
            .current_dir(cwd)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(GitCliError::CommandFailed(stderr));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Legacy run method for compatibility
    pub fn run(&self, cwd: &Path, args: &[&str]) -> Result<(String, String), GitCliError> {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if !output.status.success() {
            return Err(GitCliError::CommandFailed(stderr));
        }
        Ok((stdout, stderr))
    }

    pub fn list_worktrees(&self, repo_path: &Path) -> Result<Vec<WorktreeInfo>, GitCliError> {
        let (stdout, _) = self.run(repo_path, &["worktree", "list", "--porcelain"])?;
        let mut result = Vec::new();
        let mut current_path: Option<PathBuf> = None;
        let mut current_branch: Option<String> = None;
        for line in stdout.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                if let Some(path) = current_path.take() {
                    result.push(WorktreeInfo {
                        path,
                        branch: current_branch.take(),
                    });
                }
                current_path = Some(PathBuf::from(rest.trim()));
                current_branch = None;
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let branch = rest
                    .trim()
                    .trim_start_matches("refs/heads/")
                    .trim_start_matches("refs/remotes/origin/")
                    .to_string();
                current_branch = Some(branch);
            }
        }
        if let Some(path) = current_path.take() {
            result.push(WorktreeInfo {
                path,
                branch: current_branch.take(),
            });
        }
        Ok(result)
    }

    pub fn has_staged_changes(&self, repo_path: &Path) -> Result<bool, GitCliError> {
        let output = Command::new("git")
            .current_dir(repo_path)
            .args(["diff", "--cached", "--quiet"])
            .output()?;
        match output.status.code() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(GitCliError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            )),
        }
    }

    /// Compute the merge base of two refs.
    /// If `git merge-base --fork-point` fails, falls back to regular `merge-base`.
    fn merge_base(&self, worktree_path: &Path, a: &str, b: &str) -> Result<String, GitCliError> {
        let out = self
            .git(worktree_path, ["merge-base", "--fork-point", a, b])
            .unwrap_or(self.git(worktree_path, ["merge-base", a, b])?);
        Ok(out.trim().to_string())
    }

    /// Check if there are any changes (staged, unstaged, or untracked) in the worktree
    pub fn has_changes(&self, repo_path: &Path) -> Result<bool, GitCliError> {
        let (stdout, _) = self.run(repo_path, &["status", "--porcelain"])?;
        Ok(!stdout.trim().is_empty())
    }

    /// Stage all changes (including untracked files)
    pub fn add_all(&self, repo_path: &Path) -> Result<(), GitCliError> {
        self.run(repo_path, &["add", "-A"])?;
        Ok(())
    }

    /// Create a commit with the given message
    pub fn commit(&self, repo_path: &Path, message: &str) -> Result<(), GitCliError> {
        self.run(repo_path, &["commit", "-m", message])?;
        Ok(())
    }

    pub fn merge_squash_commit(
        &self,
        repo_path: &Path,
        base_branch: &str,
        task_branch: &str,
        message: &str,
    ) -> Result<String, GitCliError> {
        self.run(repo_path, &["checkout", base_branch])?;
        self.run(repo_path, &["reset", "--hard", base_branch])?;
        let merge_result = Command::new("git")
            .current_dir(repo_path)
            .args(["merge", "--squash", task_branch])
            .output()?;
        if !merge_result.status.success() {
            let _ = Command::new("git")
                .current_dir(repo_path)
                .args(["merge", "--abort"])
                .status();
            return Err(GitCliError::CommandFailed(
                String::from_utf8_lossy(&merge_result.stderr).to_string(),
            ));
        }
        self.run(repo_path, &["commit", "-m", message])?;
        let (stdout, _) = self.run(repo_path, &["rev-parse", "HEAD"])?;
        Ok(stdout.trim().to_string())
    }

    pub fn update_ref(
        &self,
        repo_path: &Path,
        reference: &str,
        sha: &str,
    ) -> Result<(), GitCliError> {
        self.run(repo_path, &["update-ref", reference, sha])?;
        Ok(())
    }

    /// Return true if there is a rebase in progress in this worktree.
    /// We treat this as true when either of Git's rebase state directories exists:
    /// - rebase-merge (interactive rebase)
    /// - rebase-apply (am-based rebase)
    pub fn is_rebase_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        let rebase_merge = self.git(worktree_path, ["rev-parse", "--git-path", "rebase-merge"])?;
        let rebase_apply = self.git(worktree_path, ["rev-parse", "--git-path", "rebase-apply"])?;
        let rm_exists = std::path::Path::new(rebase_merge.trim()).exists();
        let ra_exists = std::path::Path::new(rebase_apply.trim()).exists();
        Ok(rm_exists || ra_exists)
    }

    /// Return true if a merge is in progress (MERGE_HEAD exists).
    pub fn is_merge_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        match self.git(worktree_path, ["rev-parse", "--verify", "MERGE_HEAD"]) {
            Ok(_) => Ok(true),
            Err(GitCliError::CommandFailed(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Return true if a cherry-pick is in progress (CHERRY_PICK_HEAD exists).
    pub fn is_cherry_pick_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        match self.git(worktree_path, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]) {
            Ok(_) => Ok(true),
            Err(GitCliError::CommandFailed(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Return true if a revert is in progress (REVERT_HEAD exists).
    pub fn is_revert_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        match self.git(worktree_path, ["rev-parse", "--verify", "REVERT_HEAD"]) {
            Ok(_) => Ok(true),
            Err(GitCliError::CommandFailed(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Perform `git rebase --onto <new_base> <old_base>` on <task_branch> in `worktree_path`.
    pub fn rebase_onto(
        &self,
        worktree_path: &Path,
        new_base: &str,
        old_base: &str,
        task_branch: &str,
    ) -> Result<(), GitCliError> {
        if self.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitCliError::RebaseInProgress);
        }
        let merge_base = self
            .merge_base(worktree_path, old_base, task_branch)
            .unwrap_or(old_base.to_string());

        self.git(
            worktree_path,
            ["rebase", "--onto", new_base, &merge_base, task_branch],
        )?;
        Ok(())
    }

    /// Abort an in-progress rebase in this worktree. If no rebase is in progress,
    /// this is a no-op and returns Ok(()).
    pub fn abort_rebase(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_rebase_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["rebase", "--abort"]).map(|_| ())
    }

    /// Quit an in-progress rebase (cleanup metadata without modifying commits).
    /// If no rebase is in progress, it's a no-op.
    pub fn quit_rebase(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_rebase_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["rebase", "--quit"]).map(|_| ())
    }

    pub fn abort_merge(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_merge_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["merge", "--abort"]).map(|_| ())
    }

    pub fn abort_cherry_pick(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_cherry_pick_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["cherry-pick", "--abort"])
            .map(|_| ())
    }

    pub fn abort_revert(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_revert_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["revert", "--abort"]).map(|_| ())
    }

    /// Push commits to remote repository
    pub fn push(&self, repo_path: &Path) -> Result<(), GitCliError> {
        self.run(repo_path, &["push"])?;
        Ok(())
    }

    /// Pull changes from remote repository
    pub fn pull(&self, repo_path: &Path) -> Result<(), GitCliError> {
        self.run(repo_path, &["pull"])?;
        Ok(())
    }

    /// Discard all changes in the working directory (restore to HEAD)
    pub fn discard_all(&self, repo_path: &Path) -> Result<(), GitCliError> {
        self.run(repo_path, &["reset", "HEAD"])?;
        self.run(repo_path, &["checkout", "--", "."])?;
        self.run(repo_path, &["clean", "-fd"])?;
        Ok(())
    }

    /// Discard changes for specific files
    pub fn discard_files(&self, repo_path: &Path, paths: &[&str]) -> Result<(), GitCliError> {
        for path in paths {
            let _ = self.run(repo_path, &["checkout", "--", path]);
        }
        Ok(())
    }

    /// List files currently in a conflicted (unmerged) state in the worktree
    pub fn get_conflicted_files(&self, repo_path: &Path) -> Result<Vec<String>, GitCliError> {
        let (stdout, _) = self.run(repo_path, &["diff", "--name-only", "--diff-filter=U"])?;
        let mut files = Vec::new();
        for line in stdout.lines() {
            let p = line.trim();
            if !p.is_empty() {
                files.push(p.to_string());
            }
        }
        Ok(files)
    }

    /// Get the number of commits ahead/behind the upstream tracking ref.
    pub fn get_remote_status(&self, repo_path: &Path) -> Result<(usize, usize), GitCliError> {
        let result = self.run(
            repo_path,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        );

        match result {
            Ok((stdout, _)) => {
                let parts: Vec<&str> = stdout.split_whitespace().collect();
                if parts.len() >= 2 {
                    let behind = parts[0].parse().unwrap_or(0);
                    let ahead = parts[1].parse().unwrap_or(0);
                    Ok((ahead, behind))
                } else {
                    Ok((0, 0))
                }
            }
            Err(_) => Ok((0, 0)),
        }
    }
}
