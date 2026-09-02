use std::{
    fs,
    path::{Path, PathBuf},
};

use git2::{
    Branch, BranchType, DiffFindOptions, DiffOptions, MergeOptions, Reference, Repository,
};
use log_types::{compute_line_change_counts, Diff, DiffChangeKind};
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod cli;
pub mod decorated_tree;

use cli::{GitCli, GitCliError};
pub use decorated_tree::{
    build_changed_files_tree, build_git_decorations, ChangedFileNode, DecorationStatus,
    GitDecorations, NodeKind,
};

#[derive(Debug, Error)]
pub enum GitServiceError {
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    GitCLI(#[from] GitCliError),
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("invalid repository: {0}")]
    InvalidRepository(String),
    #[error("branch '{0}' not found")]
    BranchNotFound(String),
    #[error("reference '{0}' not found")]
    ReferenceNotFound(String),
    #[error("merge conflicts: {0}")]
    MergeConflicts(String),
    #[error("branches diverged: {0}")]
    BranchesDiverged(String),
    #[error("nothing to merge: {0}")]
    NothingToMerge(String),
    #[error("{0} has uncommitted changes: {1}")]
    WorktreeDirty(String, String),
    #[error("repository has no working directory")]
    WorkdirMissing,
    #[error("repository has no HEAD commit")]
    HeadMissing,
    #[error("rebase in progress; resolve or abort it before retrying")]
    RebaseInProgress,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictOp {
    Rebase,
    Merge,
    CherryPick,
    Revert,
}

/// High-level helper for performing Git operations needed by Chro services.
#[derive(Debug, Clone, Default)]
pub struct GitService;

/// Upper bound for the combined before/after snapshots of one file. The UI can
/// fetch/open the file separately; embedding larger snapshots makes both JSON
/// serialization and renderer-side diff parsing disproportionately expensive.
const MAX_INLINE_DIFF_BYTES: usize = 512 * 1024;
/// Bound aggregate inline content returned by a single diff computation.
const MAX_CUMULATIVE_INLINE_DIFF_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct CommitId(git2::Oid);

impl CommitId {
    fn new(oid: git2::Oid) -> Self {
        Self(oid)
    }

    pub fn as_oid(&self) -> git2::Oid {
        self.0
    }
}

#[derive(Clone, Copy, Debug)]
pub enum DiffTarget<'a> {
    Worktree {
        worktree_path: &'a Path,
        base_commit: CommitId,
    },
    Commit {
        repo_path: &'a Path,
        commit_sha: &'a str,
    },
}

impl GitService {
    pub fn new() -> Self {
        Self
    }

    pub fn is_repository(&self, path: impl AsRef<Path>) -> bool {
        Repository::open(path.as_ref()).is_ok()
    }

    fn ensure_cli_commit_identity(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let cfg = repo.config()?;
        let has_name = cfg.get_string("user.name").is_ok();
        let has_email = cfg.get_string("user.email").is_ok();
        if !(has_name && has_email) {
            let mut cfg = repo.config()?;
            cfg.set_str("user.name", "Chro")?;
            cfg.set_str("user.email", "noreply@chro-ai.com")?;
        }
        Ok(())
    }

    fn signature_with_fallback<'repo>(
        &self,
        repo: &'repo Repository,
    ) -> Result<git2::Signature<'repo>, GitServiceError> {
        match repo.signature() {
            Ok(sig) => Ok(sig),
            Err(_) => {
                git2::Signature::now("Chro", "noreply@chro-ai.com").map_err(GitServiceError::from)
            }
        }
    }

    pub fn init_repository(&self, path: &Path) -> Result<(), GitServiceError> {
        let repo = Repository::init(path)?;
        let sig = self.signature_with_fallback(&repo)?;
        let mut index = repo.index()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])?;
        Ok(())
    }

    /// Create `branch` pointing at `commit` unless it already exists.
    ///
    /// Unlike [`Self::ensure_branch_exists`], the base is a commit-ish rather
    /// than a branch name: forking a session branches from the exact commit its
    /// anchor run ended on, which usually has no branch of its own.
    /// Resolve a revision (a commit sha, a branch name, `HEAD`, ...) to a
    /// concrete commit sha, or None if it does not resolve in this repo.
    ///
    /// Used to pin a fork's anchor: a source's `after`/`before` commit or its
    /// branch tip all name the same durable object, and any that still
    /// resolves is a valid floor even after the source's worktree is gone.
    pub fn resolve_commit_sha(&self, repo_path: impl AsRef<Path>, rev: &str) -> Option<String> {
        let repo = self.open_repo(repo_path).ok()?;
        let object = repo.revparse_single(rev).ok()?;
        let commit = object.peel_to_commit().ok()?;
        Some(commit.id().to_string())
    }

    pub fn ensure_branch_exists_at_commit(
        &self,
        repo_path: impl AsRef<Path>,
        branch: &str,
        commit: &str,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        if repo.find_branch(branch, BranchType::Local).is_ok() {
            return Ok(());
        }
        let object = repo
            .revparse_single(commit)
            .map_err(|_| GitServiceError::ReferenceNotFound(commit.to_string()))?;
        let commit = object
            .peel_to_commit()
            .map_err(|_| GitServiceError::ReferenceNotFound(object.id().to_string()))?;
        repo.branch(branch, &commit, false)?;
        Ok(())
    }

    pub fn ensure_branch_exists(
        &self,
        repo_path: impl AsRef<Path>,
        branch: &str,
        base_branch: Option<&str>,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        if repo.find_branch(branch, BranchType::Local).is_ok() {
            return Ok(());
        }

        let base_commit = if let Some(base) = base_branch {
            self.resolve_branch_commit(&repo, base)?
        } else {
            self.resolve_head_commit(&repo)?
        };

        repo.branch(branch, &base_commit, false)?;
        Ok(())
    }

    pub fn get_current_branch(
        &self,
        repo_path: impl AsRef<Path>,
    ) -> Result<String, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let head = repo.head()?;
        if head.is_branch() {
            let shorthand = head.shorthand().ok_or(GitServiceError::HeadMissing)?;
            Ok(shorthand.to_string())
        } else {
            Err(GitServiceError::HeadMissing)
        }
    }

    /// Commit all changes (staged, modified, and untracked files) if any exist.
    /// Returns Ok(Some(oid)) if a commit was made, Ok(None) if no changes to commit.
    pub fn commit_all(
        &self,
        repo_path: impl AsRef<Path>,
        message: &str,
    ) -> Result<Option<String>, GitServiceError> {
        let path = repo_path.as_ref();
        let git_cli = GitCli::new();

        let has_changes = git_cli
            .has_changes(path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))?;

        if !has_changes {
            return Ok(None);
        }

        git_cli
            .add_all(path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git add failed: {e}")))?;

        self.ensure_cli_commit_identity(path)?;

        git_cli
            .commit(path, message)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git commit failed: {e}")))?;

        let repo = self.open_repo(path)?;
        let head = repo.head()?;
        let oid = head.target().ok_or(GitServiceError::HeadMissing)?;

        Ok(Some(oid.to_string()))
    }

    /// Commit only staged changes if any exist.
    /// Returns Ok(Some(oid)) if a commit was made, Ok(None) if nothing is staged.
    pub fn commit_staged(
        &self,
        repo_path: impl AsRef<Path>,
        message: &str,
    ) -> Result<Option<String>, GitServiceError> {
        let path = repo_path.as_ref();
        let git_status = self.status(path)?;
        if git_status.staged.is_empty() {
            return Ok(None);
        }

        let git_cli = GitCli::new();
        self.ensure_cli_commit_identity(path)?;
        git_cli
            .commit(path, message)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git commit failed: {e}")))?;

        let repo = self.open_repo(path)?;
        let head = repo.head()?;
        let oid = head.target().ok_or(GitServiceError::HeadMissing)?;

        Ok(Some(oid.to_string()))
    }

    /// Find where a branch is currently checked out
    fn find_checkout_path_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<Option<PathBuf>, GitServiceError> {
        let git_cli = GitCli::new();
        let worktrees = git_cli.list_live_worktrees(repo_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git worktree list failed: {e}"))
        })?;

        for worktree in worktrees {
            if let Some(branch) = &worktree.branch {
                if branch == branch_name {
                    return Ok(Some(worktree.path));
                }
            }
        }
        Ok(None)
    }

    /// A branch that is ahead in commits but identical in content has nothing
    /// left to land: its work already reached the base by another route.
    fn nothing_to_merge_by_content(
        task_branch_name: &str,
        base_branch_name: &str,
    ) -> GitServiceError {
        GitServiceError::NothingToMerge(format!(
            "Cannot merge: task branch '{task_branch_name}' has no changes left to apply to base branch '{base_branch_name}'. Its commits are already contained in the base.",
        ))
    }

    /// Merge changes from a task branch into the base branch.
    pub fn merge_changes(
        &self,
        base_repo_path: &Path,
        task_worktree_path: &Path,
        task_branch_name: &str,
        base_branch_name: &str,
        commit_message: &str,
    ) -> Result<String, GitServiceError> {
        let task_repo = self.open_repo(task_worktree_path)?;
        let base_repo = self.open_repo(base_repo_path)?;

        let (branch_ahead, branch_behind) =
            self.get_branch_status(base_repo_path, task_branch_name, base_branch_name)?;

        if branch_ahead == 0 {
            return Err(GitServiceError::NothingToMerge(format!(
                "Cannot merge: task branch '{task_branch_name}' has no commits ahead of base branch '{base_branch_name}'. There is nothing to merge.",
            )));
        }

        if branch_behind > 0 {
            return Err(GitServiceError::BranchesDiverged(format!(
                "Cannot merge: base branch '{base_branch_name}' is {branch_behind} commits ahead of task branch '{task_branch_name}'. The base branch has moved forward since the task was created.",
            )));
        }

        match self.find_checkout_path_for_branch(base_repo_path, base_branch_name)? {
            Some(base_checkout_path) => {
                let git_cli = GitCli::new();
                if git_cli
                    .has_staged_changes(&base_checkout_path)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git diff --cached failed: {e}"))
                    })?
                {
                    return Err(GitServiceError::WorktreeDirty(
                        base_branch_name.to_string(),
                        "staged changes present".to_string(),
                    ));
                }

                self.ensure_cli_commit_identity(&base_checkout_path)?;
                let sha = git_cli
                    .merge_squash_commit(
                        &base_checkout_path,
                        base_branch_name,
                        task_branch_name,
                        commit_message,
                    )
                    .map_err(|e| match e {
                        GitCliError::NothingToCommit => {
                            Self::nothing_to_merge_by_content(task_branch_name, base_branch_name)
                        }
                        other => {
                            GitServiceError::InvalidRepository(format!("CLI merge failed: {other}"))
                        }
                    })?;

                let task_refname = format!("refs/heads/{task_branch_name}");
                git_cli
                    .update_ref(base_repo_path, &task_refname, &sha)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git update-ref failed: {e}"))
                    })?;

                Ok(sha)
            }
            None => {
                let task_branch = self.find_branch(&task_repo, task_branch_name)?;
                let base_branch = self.find_branch(&task_repo, base_branch_name)?;
                let base_commit = base_branch.get().peel_to_commit()?;
                let task_commit = task_branch.get().peel_to_commit()?;
                let signature = self.signature_with_fallback(&task_repo)?;
                let squash_commit_id = self
                    .perform_squash_merge(
                        &task_repo,
                        &base_commit,
                        &task_commit,
                        &signature,
                        commit_message,
                        base_branch_name,
                    )?
                    .ok_or_else(|| {
                        Self::nothing_to_merge_by_content(task_branch_name, base_branch_name)
                    })?;

                let task_refname = format!("refs/heads/{task_branch_name}");
                base_repo.reference(
                    &task_refname,
                    squash_commit_id,
                    true,
                    "Reset task branch after squash merge",
                )?;

                Ok(squash_commit_id.to_string())
            }
        }
    }

    /// Check that worktree has no uncommitted changes to tracked files.
    /// Untracked files are allowed.
    fn check_worktree_clean(&self, repo: &Repository) -> Result<(), GitServiceError> {
        let statuses = repo.statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(false)
                .include_ignored(false),
        ))?;

        for entry in statuses.iter() {
            let status = entry.status();
            if status.is_index_new()
                || status.is_index_modified()
                || status.is_index_deleted()
                || status.is_index_renamed()
                || status.is_index_typechange()
                || status.is_wt_modified()
                || status.is_wt_deleted()
                || status.is_wt_renamed()
                || status.is_wt_typechange()
            {
                let path = entry.path().unwrap_or("<unknown>");
                return Err(GitServiceError::WorktreeDirty(
                    "worktree".to_string(),
                    format!("uncommitted changes in tracked file: {path}"),
                ));
            }
        }
        Ok(())
    }

    /// Fetch a specific branch from its remote if it's a remote-tracking branch.
    fn fetch_branch_from_remote(
        &self,
        repo: &Repository,
        branch_ref: &Reference,
    ) -> Result<(), GitServiceError> {
        if !branch_ref.is_remote() {
            return Ok(());
        }

        let refname = branch_ref.name().ok_or_else(|| {
            GitServiceError::ReferenceNotFound("branch reference has no name".to_string())
        })?;

        let parts: Vec<&str> = refname
            .strip_prefix("refs/remotes/")
            .unwrap_or(refname)
            .splitn(2, '/')
            .collect();

        if parts.len() < 2 {
            return Ok(());
        }

        let remote_name = parts[0];
        let git_cli = GitCli::new();
        let workdir = repo.workdir().ok_or(GitServiceError::WorkdirMissing)?;

        let _ = git_cli.run(workdir, &["fetch", remote_name]);
        Ok(())
    }

    /// Rebase a worktree branch onto a new base
    /// The worktree that currently has `branch` checked out, if any.
    ///
    /// Git is the source of truth for where a branch lives: a run's recorded
    /// workspace path can drift (reclaimed and re-provisioned worktrees, a
    /// checkout the agent made itself), and acting on the stale record is what
    /// produces "already used by worktree" failures.
    ///
    /// Registrations whose checkout no longer opens are skipped: git keeps
    /// listing them with their branch, and returning one hands the caller a
    /// path that fails with "could not find repository".
    pub fn worktree_for_branch(&self, repo_path: &Path, branch: &str) -> Option<PathBuf> {
        GitCli::new()
            .list_live_worktrees(repo_path)
            .ok()?
            .into_iter()
            .find(|wt| wt.branch.as_deref() == Some(branch))
            .map(|wt| wt.path)
    }

    /// Every worktree path git recognises, minus the ones whose checkout is
    /// gone or broken.
    pub fn live_worktree_paths(&self, repo_path: &Path) -> Result<Vec<PathBuf>, GitServiceError> {
        let worktrees = GitCli::new().list_live_worktrees(repo_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git worktree list failed: {e}"))
        })?;
        Ok(worktrees.into_iter().map(|wt| wt.path).collect())
    }

    /// Drop registrations whose checkout is gone, releasing the branches they
    /// hold. Without this a half-removed worktree keeps its branch reserved
    /// forever and re-provisioning it fails with "already checked out".
    pub fn prune_worktrees(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        GitCli::new().prune_worktrees(repo_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git worktree prune failed: {e}"))
        })
    }

    pub fn rebase_branch(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        new_base_branch: &str,
        old_base_branch: &str,
        task_branch: &str,
    ) -> Result<String, GitServiceError> {
        // Rebase acts on the branch, so it must run where the branch actually
        // is. Prefer git's own answer over the caller's recorded path; fall
        // back to that path only when it is itself on the branch.
        let worktree_path: PathBuf = match self.worktree_for_branch(repo_path, task_branch) {
            Some(path) => path,
            None => {
                let recorded_branch =
                    GitCli::new()
                        .list_live_worktrees(repo_path)
                        .ok()
                        .and_then(|worktrees| {
                            worktrees
                                .into_iter()
                                .find(|wt| wt.path == worktree_path)
                                .and_then(|wt| wt.branch)
                        });
                if recorded_branch.as_deref() != Some(task_branch) {
                    return Err(GitServiceError::InvalidRepository(format!(
                        "no worktree currently has '{task_branch}' checked out, so it cannot be rebased"
                    )));
                }
                worktree_path.to_path_buf()
            }
        };
        let worktree_path = worktree_path.as_path();

        let worktree_repo = Repository::open(worktree_path)?;
        let main_repo = self.open_repo(repo_path)?;

        self.check_worktree_clean(&worktree_repo)?;

        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitServiceError::RebaseInProgress);
        }

        let nbr = Self::find_branch_static(&main_repo, new_base_branch)?.into_reference();
        if nbr.is_remote() {
            self.fetch_branch_from_remote(&main_repo, &nbr)?;
        }

        self.ensure_cli_commit_identity(worktree_path)?;
        match git.rebase_onto(worktree_path, new_base_branch, old_base_branch, task_branch) {
            Ok(()) => {}
            Err(GitCliError::RebaseInProgress) => {
                return Err(GitServiceError::RebaseInProgress);
            }
            Err(GitCliError::CommandFailed(stderr)) => {
                let looks_like_conflict = stderr.contains("could not apply")
                    || stderr.contains("CONFLICT")
                    || stderr.to_lowercase().contains("resolve all conflicts");
                if looks_like_conflict {
                    let attempt_branch = worktree_repo
                        .head()
                        .ok()
                        .and_then(|h| h.shorthand().map(|s| s.to_string()))
                        .unwrap_or_else(|| "(unknown)".to_string());
                    let conflicts = git.get_conflicted_files(worktree_path).unwrap_or_default();
                    let files_part = if conflicts.is_empty() {
                        "".to_string()
                    } else {
                        let mut sample = conflicts.clone();
                        let total = sample.len();
                        sample.truncate(10);
                        let list = sample.join(", ");
                        if total > sample.len() {
                            format!(
                                " Conflicted files (showing {} of {}): {}.",
                                sample.len(),
                                total,
                                list
                            )
                        } else {
                            format!(" Conflicted files: {list}.")
                        }
                    };
                    let msg = format!(
                        "Rebase encountered merge conflicts while rebasing '{attempt_branch}' onto '{new_base_branch}'.{files_part} Resolve conflicts and then continue or abort."
                    );
                    return Err(GitServiceError::MergeConflicts(msg));
                }
                return Err(GitServiceError::InvalidRepository(format!(
                    "Rebase failed: {}",
                    stderr.lines().next().unwrap_or("")
                )));
            }
            Err(e) => {
                return Err(GitServiceError::InvalidRepository(format!(
                    "git rebase failed: {e}"
                )));
            }
        }

        let final_commit = worktree_repo.head()?.peel_to_commit()?;
        Ok(final_commit.id().to_string())
    }

    /// Static version of find_branch for internal use
    fn find_branch_static<'repo>(
        repo: &'repo Repository,
        name: &str,
    ) -> Result<Branch<'repo>, GitServiceError> {
        repo.find_branch(name, BranchType::Local)
            .or_else(|_| repo.find_branch(name, BranchType::Remote))
            .map_err(|_| GitServiceError::BranchNotFound(name.to_string()))
    }

    pub fn is_rebase_in_progress(&self, worktree_path: &Path) -> Result<bool, GitServiceError> {
        let git = GitCli::new();
        git.is_rebase_in_progress(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase state check failed: {e}"))
        })
    }

    pub fn detect_conflict_op(
        &self,
        worktree_path: &Path,
    ) -> Result<Option<ConflictOp>, GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Rebase));
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Merge));
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return Ok(Some(ConflictOp::CherryPick));
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Revert));
        }
        Ok(None)
    }

    /// Abort an in-progress rebase in this worktree (no-op if none).
    fn abort_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.abort_rebase(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase --abort failed: {e}"))
        })
    }

    pub fn abort_conflicts(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            let has_conflicts = !self
                .get_conflicted_files(worktree_path)
                .unwrap_or_default()
                .is_empty();
            if has_conflicts {
                return self.abort_rebase(worktree_path);
            } else {
                return git.quit_rebase(worktree_path).map_err(|e| {
                    GitServiceError::InvalidRepository(format!("git rebase --quit failed: {e}"))
                });
            }
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_merge(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git merge --abort failed: {e}"))
            });
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return git.abort_cherry_pick(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git cherry-pick --abort failed: {e}"))
            });
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_revert(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git revert --abort failed: {e}"))
            });
        }
        Ok(())
    }

    /// Commits `(ahead, behind)` of `branch_name` relative to `base_branch_name`.
    ///
    /// Computed with a single killable `git rev-list --left-right --count` rather
    /// than a libgit2 revwalk: this endpoint is polled for every visible run, and
    /// a libgit2 revwalk on a large history runs on a blocking thread that cannot
    /// be cancelled. The subprocess is timeout-bounded.
    pub fn get_branch_status(
        &self,
        repo_path: impl AsRef<Path>,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<(usize, usize), GitServiceError> {
        Ok(GitCli::new().ahead_behind(repo_path.as_ref(), branch_name, base_branch_name)?)
    }

    pub fn get_base_commit(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<CommitId, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let branch = self.find_branch(&repo, branch_name)?;
        let base_branch = self.find_branch(&repo, base_branch_name)?;
        let oid = repo.merge_base(
            branch.get().peel_to_commit()?.id(),
            base_branch.get().peel_to_commit()?.id(),
        )?;
        Ok(CommitId::new(oid))
    }

    fn perform_squash_merge(
        &self,
        repo: &Repository,
        base_commit: &git2::Commit,
        task_commit: &git2::Commit,
        signature: &git2::Signature,
        commit_message: &str,
        base_branch_name: &str,
    ) -> Result<Option<git2::Oid>, GitServiceError> {
        let mut merge_opts = MergeOptions::new();
        merge_opts.find_renames(true);
        merge_opts.fail_on_conflict(true);
        let mut index = repo.merge_commits(base_commit, task_commit, Some(&merge_opts))?;

        if index.has_conflicts() {
            return Err(GitServiceError::MergeConflicts(
                "Merge failed due to conflicts. Please resolve conflicts manually.".to_string(),
            ));
        }

        let tree_id = index.write_tree_to(repo)?;
        // Mirror of the CLI path: when the merge result matches the base
        // exactly, the branch's work is already there and committing would only
        // add an empty commit. The caller turns this into "nothing to merge".
        if tree_id == base_commit.tree_id() {
            return Ok(None);
        }
        let tree = repo.find_tree(tree_id)?;
        let squash_commit_id = repo.commit(
            None,
            signature,
            signature,
            commit_message,
            &tree,
            &[base_commit],
        )?;

        let refname = format!("refs/heads/{base_branch_name}");
        repo.reference(&refname, squash_commit_id, true, "Squash merge")?;

        Ok(Some(squash_commit_id))
    }

    pub fn head_commit(&self, repo_path: impl AsRef<Path>) -> Result<CommitId, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let head = repo.head()?.target().ok_or(GitServiceError::HeadMissing)?;
        Ok(CommitId::new(head))
    }

    pub fn get_diffs(
        &self,
        target: DiffTarget<'_>,
        path_filter: Option<&[&str]>,
    ) -> Result<Vec<Diff>, GitServiceError> {
        match target {
            DiffTarget::Worktree {
                worktree_path,
                base_commit,
            } => self.diff_worktree(worktree_path, base_commit, path_filter),
            DiffTarget::Commit {
                repo_path,
                commit_sha,
            } => self.diff_commit(repo_path, commit_sha, path_filter),
        }
    }

    fn diff_worktree(
        &self,
        worktree_path: &Path,
        base_commit: CommitId,
        path_filter: Option<&[&str]>,
    ) -> Result<Vec<Diff>, GitServiceError> {
        let repo = self.open_repo(worktree_path)?;
        let base = repo.find_commit(base_commit.as_oid())?;
        let base_tree = base.tree()?;
        let mut diff_options = DiffOptions::new();
        diff_options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_typechange(true);
        if let Some(paths) = path_filter {
            for path in paths {
                diff_options.pathspec(*path);
            }
        }

        let diff =
            repo.diff_tree_to_workdir_with_index(Some(&base_tree), Some(&mut diff_options))?;
        build_worktree_diffs(&repo, &base_tree, &diff)
    }

    fn diff_commit(
        &self,
        repo_path: &Path,
        commit_sha: &str,
        path_filter: Option<&[&str]>,
    ) -> Result<Vec<Diff>, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let commit_oid = git2::Oid::from_str(commit_sha).map_err(|_| {
            GitServiceError::InvalidRepository(format!("Invalid commit SHA: {commit_sha}"))
        })?;
        let commit = repo.find_commit(commit_oid)?;
        let parent = commit.parent(0).map_err(|_| {
            GitServiceError::InvalidRepository(
                "Commit has no parent; cannot diff without a baseline".into(),
            )
        })?;

        let parent_tree = parent.tree()?;
        let commit_tree = commit.tree()?;

        let mut diff_options = DiffOptions::new();
        diff_options.include_typechange(true);
        if let Some(paths) = path_filter {
            for path in paths {
                diff_options.pathspec(*path);
            }
        }

        let mut diff = repo.diff_tree_to_tree(
            Some(&parent_tree),
            Some(&commit_tree),
            Some(&mut diff_options),
        )?;

        let mut find_opts = DiffFindOptions::new();
        diff.find_similar(Some(&mut find_opts))?;

        build_tree_diffs(&repo, &parent_tree, &commit_tree, &diff)
    }

    fn open_repo(&self, path: impl AsRef<Path>) -> Result<Repository, GitServiceError> {
        Ok(Repository::open(path)?)
    }

    fn resolve_branch_commit<'repo>(
        &self,
        repo: &'repo Repository,
        name: &str,
    ) -> Result<git2::Commit<'repo>, GitServiceError> {
        let branch = self.find_branch(repo, name)?;
        let oid = branch
            .get()
            .target()
            .ok_or_else(|| GitServiceError::ReferenceNotFound(name.to_string()))?;
        Ok(repo.find_commit(oid)?)
    }

    fn resolve_head_commit<'repo>(
        &self,
        repo: &'repo Repository,
    ) -> Result<git2::Commit<'repo>, GitServiceError> {
        let head = repo.head()?;
        let target = head.target().ok_or(GitServiceError::HeadMissing)?;
        Ok(repo.find_commit(target)?)
    }

    fn find_branch<'repo>(
        &self,
        repo: &'repo Repository,
        name: &str,
    ) -> Result<Branch<'repo>, GitServiceError> {
        repo.find_branch(name, BranchType::Local)
            .or_else(|_| repo.find_branch(name, BranchType::Remote))
            .map_err(|_| GitServiceError::BranchNotFound(name.to_string()))
    }

    /// Get the status of the working directory
    /// Working-tree status for the Source Control panel.
    ///
    /// Runs through the killable `git status` subprocess (porcelain, untracked
    /// dirs not recursed, `GIT_OPTIONAL_LOCKS=0`) rather than a libgit2 status
    /// scan. libgit2 status refreshes-and-writes the index (taking the index
    /// lock, contending with concurrent stage/commit) and, with
    /// `recurse_untracked_dirs`, crawls huge untracked trees — which is how a
    /// worktree mid-`bun install` produced multi-minute, uncancellable status
    /// calls that froze every session's git UI. The subprocess is bounded by a
    /// timeout and can be killed.
    pub fn status(&self, repo_path: impl AsRef<Path>) -> Result<GitStatus, GitServiceError> {
        let raw = GitCli::new().status_porcelain(repo_path.as_ref())?;
        Ok(parse_porcelain_status(&raw))
    }

    pub fn is_worktree_clean(&self, repo_path: &Path) -> Result<bool, GitServiceError> {
        Ok(!self.status(repo_path)?.has_changes)
    }

    /// Stage files (or whole directories) for commit.
    ///
    /// Routes through the killable `git add` subprocess rather than libgit2's
    /// `Index::add_path`, which rejects directory pathspecs and aborts with
    /// `invalid path: 'crates/'`. `git status` folds untracked directories into
    /// a single entry so it stays instant on huge untracked trees (see
    /// [`GitCli::status_porcelain`]), so the Source Control panel hands back
    /// paths like `crates/`; `git add` recurses those and also stages
    /// deletions, covering every case the per-file libgit2 loop handled plus
    /// the directory case it could not.
    pub fn stage(
        &self,
        repo_path: impl AsRef<Path>,
        paths: &[String],
    ) -> Result<(), GitServiceError> {
        GitCli::new().add_paths(repo_path.as_ref(), paths)?;
        Ok(())
    }

    /// Unstage files from the index
    pub fn unstage(
        &self,
        repo_path: impl AsRef<Path>,
        paths: &[String],
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let head = repo.head()?.peel_to_commit()?;

        for path in paths {
            repo.reset_default(Some(head.as_object()), [Path::new(path)])?;
        }

        Ok(())
    }

    /// Push commits to remote repository
    pub fn push(&self, repo_path: impl AsRef<Path>) -> Result<(), GitServiceError> {
        let git_cli = GitCli::new();
        git_cli.push(repo_path.as_ref())?;
        Ok(())
    }

    /// Pull changes from remote repository
    pub fn pull(&self, repo_path: impl AsRef<Path>) -> Result<(), GitServiceError> {
        let git_cli = GitCli::new();
        git_cli.pull(repo_path.as_ref())?;
        Ok(())
    }

    /// Discard all changes in working directory
    pub fn discard_all(&self, repo_path: impl AsRef<Path>) -> Result<(), GitServiceError> {
        let git_cli = GitCli::new();
        git_cli.discard_all(repo_path.as_ref())?;
        Ok(())
    }

    /// Discard changes for specific files
    pub fn discard_files(
        &self,
        repo_path: impl AsRef<Path>,
        paths: &[String],
    ) -> Result<(), GitServiceError> {
        let git_cli = GitCli::new();
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        git_cli.discard_files(repo_path.as_ref(), &path_refs)?;
        Ok(())
    }

    /// Get commit count ahead/behind remote tracking branch
    pub fn get_remote_status(
        &self,
        repo_path: impl AsRef<Path>,
    ) -> Result<(usize, usize), GitServiceError> {
        let git_cli = GitCli::new();
        let (ahead, behind) = git_cli.get_remote_status(repo_path.as_ref())?;
        Ok((ahead, behind))
    }

    /// List files currently in a conflicted (unmerged) state in the worktree
    pub fn get_conflicted_files(
        &self,
        worktree_path: impl AsRef<Path>,
    ) -> Result<Vec<String>, GitServiceError> {
        let git_cli = GitCli::new();
        git_cli
            .get_conflicted_files(worktree_path.as_ref())
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!("git diff for conflicts failed: {e}"))
            })
    }

    /// List all branches in the repository
    pub fn list_branches(
        &self,
        repo_path: impl AsRef<Path>,
    ) -> Result<Vec<BranchInfo>, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let mut branches = Vec::new();

        let current_branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()));

        for branch_result in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                let is_current = current_branch.as_deref() == Some(name);
                let last_commit_date = branch
                    .get()
                    .peel_to_commit()
                    .ok()
                    .map(|c| c.time().seconds());

                branches.push(BranchInfo {
                    name: name.to_string(),
                    is_current,
                    is_remote: false,
                    last_commit_timestamp: last_commit_date,
                });
            }
        }

        for branch_result in repo.branches(Some(BranchType::Remote))? {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                if name.ends_with("/HEAD") {
                    continue;
                }
                let last_commit_date = branch
                    .get()
                    .peel_to_commit()
                    .ok()
                    .map(|c| c.time().seconds());

                branches.push(BranchInfo {
                    name: name.to_string(),
                    is_current: false,
                    is_remote: true,
                    last_commit_timestamp: last_commit_date,
                });
            }
        }

        branches.sort_by(|a, b| {
            b.last_commit_timestamp
                .unwrap_or(0)
                .cmp(&a.last_commit_timestamp.unwrap_or(0))
        });

        Ok(branches)
    }
}

/// Parse `git status --porcelain=v1 -z` output into a [`GitStatus`].
///
/// Each NUL-separated record is `XY PATH`, where `X` is the index (staged)
/// state and `Y` the worktree state. Rename/copy records carry their source
/// path as the following NUL field, which is consumed and ignored. `??` marks
/// an untracked entry (a directory when untracked dirs are not recursed).
fn parse_porcelain_status(raw: &str) -> GitStatus {
    let mut staged = Vec::new();
    let mut modified = Vec::new();
    let mut untracked = Vec::new();

    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        // A valid record is at least "XY " followed by a path; the trailing
        // empty split after the final NUL falls through here.
        if record.len() < 3 {
            continue;
        }
        let bytes = record.as_bytes();
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let path = record[3..].to_string();

        // Renames/copies append the source path as a separate NUL field.
        if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            let _source = records.next();
        }

        if index == '?' && worktree == '?' {
            untracked.push(path);
            continue;
        }
        if let Some(status) = porcelain_change_status(index) {
            staged.push(FileChange {
                path: path.clone(),
                status,
            });
        }
        if let Some(status) = porcelain_change_status(worktree) {
            modified.push(FileChange { path, status });
        }
    }

    let has_changes = !staged.is_empty() || !modified.is_empty() || !untracked.is_empty();
    GitStatus {
        staged,
        modified,
        untracked,
        has_changes,
    }
}

/// Map a single porcelain status code (index or worktree column) to a
/// [`FileChangeStatus`]. Returns `None` for unmodified (' ') and untracked
/// ('?'), which the caller handles separately.
fn porcelain_change_status(code: char) -> Option<FileChangeStatus> {
    match code {
        'A' => Some(FileChangeStatus::Added),
        'M' => Some(FileChangeStatus::Modified),
        'D' => Some(FileChangeStatus::Deleted),
        'R' => Some(FileChangeStatus::Renamed),
        'C' => Some(FileChangeStatus::Copied),
        'T' => Some(FileChangeStatus::TypeChange),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub last_commit_timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub staged: Vec<FileChange>,
    pub modified: Vec<FileChange>,
    pub untracked: Vec<String>,
    pub has_changes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: FileChangeStatus,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChange,
}

fn build_worktree_diffs(
    repo: &Repository,
    base_tree: &git2::Tree,
    diff: &git2::Diff,
) -> Result<Vec<Diff>, GitServiceError> {
    let workdir = repo
        .workdir()
        .ok_or(GitServiceError::WorkdirMissing)?
        .to_path_buf();
    let mut files = Vec::new();
    let mut cumulative_inline_bytes = 0usize;
    for delta in diff.deltas() {
        let change = map_status(delta.status());
        let old_path = delta.old_file().path().map(normalize_path);
        let new_path = delta.new_file().path().map(normalize_path);
        let is_binary = delta.old_file().is_binary()
            || delta.new_file().is_binary()
            || is_binary_path(&old_path, &new_path);
        let estimated_bytes = delta_inline_bytes(&delta);
        let omit_content = !is_binary
            && (estimated_bytes > MAX_INLINE_DIFF_BYTES
                || cumulative_inline_bytes.saturating_add(estimated_bytes)
                    > MAX_CUMULATIVE_INLINE_DIFF_BYTES);

        let (old_content, new_content) = if is_binary || omit_content {
            (None, None)
        } else {
            let old = match change {
                DiffChangeKind::Added => None,
                _ => read_tree_file(repo, base_tree, delta.old_file().path()),
            };
            let new = match change {
                DiffChangeKind::Deleted => None,
                _ => read_workdir_file(&workdir, delta.new_file().path()),
            };
            (old, new)
        };

        let mut entry = Diff {
            change,
            old_path,
            new_path,
            old_content,
            new_content,
            content_omitted: omit_content,
            additions: None,
            deletions: None,
            is_binary,
        };
        finalize_diff_entry(&mut entry);
        if !entry.content_omitted {
            cumulative_inline_bytes = cumulative_inline_bytes.saturating_add(
                entry.old_content.as_ref().map(|s| s.len()).unwrap_or(0)
                    + entry.new_content.as_ref().map(|s| s.len()).unwrap_or(0),
            );
        }
        files.push(entry);
    }
    Ok(files)
}

fn build_tree_diffs(
    repo: &Repository,
    from_tree: &git2::Tree,
    to_tree: &git2::Tree,
    diff: &git2::Diff,
) -> Result<Vec<Diff>, GitServiceError> {
    let mut files = Vec::new();
    let mut cumulative_inline_bytes = 0usize;
    for delta in diff.deltas() {
        let change = map_status(delta.status());
        let old_path = delta.old_file().path().map(normalize_path);
        let new_path = delta.new_file().path().map(normalize_path);
        let is_binary = delta.old_file().is_binary()
            || delta.new_file().is_binary()
            || is_binary_path(&old_path, &new_path);
        let estimated_bytes = delta_inline_bytes(&delta);
        let omit_content = !is_binary
            && (estimated_bytes > MAX_INLINE_DIFF_BYTES
                || cumulative_inline_bytes.saturating_add(estimated_bytes)
                    > MAX_CUMULATIVE_INLINE_DIFF_BYTES);

        let (old_content, new_content) = if is_binary || omit_content {
            (None, None)
        } else {
            let old = match change {
                DiffChangeKind::Added => None,
                _ => read_tree_file(repo, from_tree, delta.old_file().path()),
            };
            let new = match change {
                DiffChangeKind::Deleted => None,
                _ => read_tree_file(repo, to_tree, delta.new_file().path()),
            };
            (old, new)
        };

        let mut entry = Diff {
            change,
            old_path,
            new_path,
            old_content,
            new_content,
            content_omitted: omit_content,
            additions: None,
            deletions: None,
            is_binary,
        };
        finalize_diff_entry(&mut entry);
        if !entry.content_omitted {
            cumulative_inline_bytes = cumulative_inline_bytes.saturating_add(
                entry.old_content.as_ref().map(|s| s.len()).unwrap_or(0)
                    + entry.new_content.as_ref().map(|s| s.len()).unwrap_or(0),
            );
        }
        files.push(entry);
    }
    Ok(files)
}

fn map_status(status: git2::Delta) -> DiffChangeKind {
    match status {
        git2::Delta::Added => DiffChangeKind::Added,
        git2::Delta::Deleted => DiffChangeKind::Deleted,
        git2::Delta::Renamed => DiffChangeKind::Renamed,
        git2::Delta::Copied => DiffChangeKind::Copied,
        git2::Delta::Typechange => DiffChangeKind::PermissionChange,
        _ => DiffChangeKind::Modified,
    }
}

fn delta_inline_bytes(delta: &git2::DiffDelta<'_>) -> usize {
    let total = delta
        .old_file()
        .size()
        .saturating_add(delta.new_file().size());
    usize::try_from(total).unwrap_or(usize::MAX)
}

fn read_tree_file(repo: &Repository, tree: &git2::Tree, path: Option<&Path>) -> Option<String> {
    let path = path?;
    let entry = tree.get_path(path).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    Some(String::from_utf8_lossy(blob.content()).into_owned())
}

fn read_workdir_file(root: &Path, path: Option<&Path>) -> Option<String> {
    let path = path?;
    let full = root.join(path);
    fs::read_to_string(full).ok()
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "svg", "tiff", "tif", "pdf", "zip",
    "gz", "tar", "bz2", "xz", "7z", "rar", "mp3", "mp4", "wav", "ogg", "webm", "avi", "mov",
    "flac", "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "so", "dylib", "bin", "psd", "ai",
    "sketch", "fig",
];

fn is_binary_path(old_path: &Option<String>, new_path: &Option<String>) -> bool {
    let path = new_path.as_deref().or(old_path.as_deref());
    match path {
        Some(p) => {
            let ext = p.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            BINARY_EXTENSIONS.contains(&ext.as_str())
        }
        None => false,
    }
}

fn finalize_diff_entry(diff: &mut Diff) {
    if diff.content_omitted {
        return;
    }
    let old_len = diff.old_content.as_ref().map(|s| s.len()).unwrap_or(0);
    let new_len = diff.new_content.as_ref().map(|s| s.len()).unwrap_or(0);
    let total = old_len + new_len;
    if total > MAX_INLINE_DIFF_BYTES {
        diff.old_content = None;
        diff.new_content = None;
        diff.content_omitted = true;
        return;
    }

    if diff.old_content.is_some() || diff.new_content.is_some() {
        let (additions, deletions) = compute_line_change_counts(
            diff.old_content.as_deref().unwrap_or(""),
            diff.new_content.as_deref().unwrap_or(""),
        );
        diff.additions = Some(additions);
        diff.deletions = Some(deletions);
    }
}

#[cfg(test)]
impl GitService {
    fn checkout_branch(
        &self,
        repo_path: impl AsRef<Path>,
        branch: &str,
    ) -> Result<(), GitServiceError> {
        use git2::build::CheckoutBuilder;
        let repo = self.open_repo(repo_path)?;
        let (object, reference) = repo.revparse_ext(branch)?;
        repo.checkout_tree(&object, Some(CheckoutBuilder::new().force()))?;

        if let Some(reference) = reference {
            let name = reference
                .name()
                .ok_or_else(|| GitServiceError::ReferenceNotFound(branch.to_string()))?;
            repo.set_head(name)?;
        } else {
            repo.set_head_detached(object.id())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod porcelain_tests {
    use super::*;

    #[test]
    fn parses_porcelain_z_records() {
        // `git status --porcelain=v1 -z`: NUL-separated "XY PATH"; renames carry
        // a trailing NUL-separated source path.
        let raw = concat!(
            "A  staged_add.txt\0",
            " M wt_mod.txt\0",
            "?? untracked_dir/\0",
            "R  renamed_new\0renamed_old\0",
            "MM both.txt\0",
        );
        let status = parse_porcelain_status(raw);

        let staged: Vec<_> = status
            .staged
            .iter()
            .map(|c| (c.path.as_str(), c.status))
            .collect();
        assert_eq!(
            staged,
            vec![
                ("staged_add.txt", FileChangeStatus::Added),
                ("renamed_new", FileChangeStatus::Renamed),
                ("both.txt", FileChangeStatus::Modified),
            ]
        );

        let modified: Vec<_> = status
            .modified
            .iter()
            .map(|c| (c.path.as_str(), c.status))
            .collect();
        assert_eq!(
            modified,
            vec![
                ("wt_mod.txt", FileChangeStatus::Modified),
                ("both.txt", FileChangeStatus::Modified),
            ]
        );

        assert_eq!(status.untracked, vec!["untracked_dir/".to_string()]);
        assert!(status.has_changes);
    }

    #[test]
    fn parses_clean_worktree() {
        let status = parse_porcelain_status("");
        assert!(!status.has_changes);
        assert!(status.staged.is_empty());
        assert!(status.modified.is_empty());
        assert!(status.untracked.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::fs;
    use tempfile::tempdir;

    fn init_repo() -> (tempfile::TempDir, Repository) {
        let tmp = tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        let sig = Signature::now("tester", "tester@example.com").unwrap();
        let tree_id = {
            let mut index = repo.index().unwrap();
            index.write_tree().unwrap()
        };
        {
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .unwrap();
        }
        (tmp, repo)
    }

    fn write_file(root: &Path, name: &str, contents: &str) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// A run's recorded workspace path drifts (worktree reclaimed and
    /// re-provisioned, or the agent checked something else out) while its
    /// branch lives in another worktree. Rebase must follow the branch to its
    /// real worktree instead of failing with git's "already used by worktree".
    #[test]
    fn rebase_follows_the_branch_to_its_actual_worktree() {
        let (tmp, repo) = init_repo();
        let service = GitService::new();
        let root = tmp.path();
        write_file(root, "base.txt", "base\n");
        service.commit_all(root, "base commit").unwrap();
        let base_branch = repo.head().unwrap().shorthand().unwrap().to_string();

        // A task branch with its own commit, living in its own worktree.
        service
            .ensure_branch_exists(root, "ch/task", Some(&base_branch))
            .unwrap();
        let wt_home = tempdir().unwrap();
        let task_wt = wt_home.path().join("task-worktree");
        let added = std::process::Command::new("git")
            .current_dir(root)
            .args(["worktree", "add", task_wt.to_str().unwrap(), "ch/task"])
            .output()
            .unwrap();
        assert!(
            added.status.success(),
            "worktree add failed: {}",
            String::from_utf8_lossy(&added.stderr)
        );
        write_file(&task_wt, "task.txt", "task work\n");
        service.commit_all(&task_wt, "task commit").unwrap();

        // The base moves on, so there is something to rebase onto.
        write_file(root, "base.txt", "base moved\n");
        service.commit_all(root, "base advances").unwrap();

        let held_by = service
            .worktree_for_branch(root, "ch/task")
            .expect("branch lookup should find the worktree holding it");
        assert_eq!(
            held_by.canonicalize().unwrap(),
            task_wt.canonicalize().unwrap()
        );

        // Caller passes the *drifted* path (the main checkout, which is on the
        // base branch) — the old code would try to check ch/task out there.
        let head = service
            .rebase_branch(root, root, &base_branch, &base_branch, "ch/task")
            .expect("rebase should follow the branch to its worktree");
        assert!(!head.is_empty());

        // The rebase landed in the task worktree, and its branch now contains
        // the advanced base.
        let rebased = Repository::open(&task_wt).unwrap();
        assert_eq!(rebased.head().unwrap().shorthand(), Some("ch/task"));
        assert_eq!(
            std::fs::read_to_string(task_wt.join("base.txt")).unwrap(),
            "base moved\n"
        );
        assert!(task_wt.join("task.txt").exists());
        drop(repo);
    }

    /// When no worktree holds the branch at all, rebase refuses in chro's own
    /// words rather than surfacing a git fatal.
    #[test]
    fn rebase_refuses_when_no_worktree_holds_the_branch() {
        let (tmp, repo) = init_repo();
        let service = GitService::new();
        let root = tmp.path();
        write_file(root, "base.txt", "base\n");
        service.commit_all(root, "base commit").unwrap();
        let base_branch = repo.head().unwrap().shorthand().unwrap().to_string();
        service
            .ensure_branch_exists(root, "ch/orphan", Some(&base_branch))
            .unwrap();

        let err = service
            .rebase_branch(root, root, &base_branch, &base_branch, "ch/orphan")
            .expect_err("a branch nobody has checked out cannot be rebased");
        let msg = err.to_string();
        assert!(
            msg.contains("no worktree currently has"),
            "expected chro's own wording, got: {msg}"
        );
        drop(repo);
    }

    /// The worktree holding the branch was half-deleted: the directory is still
    /// there but its `.git` file is gone, so git keeps listing the registration
    /// (as prunable) with the branch attached. Following that listing handed
    /// `Repository::open` a dead path and surfaced a raw libgit2
    /// "could not find repository ...; class=Repository (6); code=NotFound (-3)".
    #[test]
    fn rebase_ignores_a_worktree_whose_checkout_is_dead() {
        let (tmp, repo) = init_repo();
        let service = GitService::new();
        let root = tmp.path();
        write_file(root, "base.txt", "base\n");
        service.commit_all(root, "base commit").unwrap();
        let base_branch = repo.head().unwrap().shorthand().unwrap().to_string();

        service
            .ensure_branch_exists(root, "ch/76fe-vela", Some(&base_branch))
            .unwrap();
        let wt_home = tempdir().unwrap();
        let task_wt = wt_home.path().join("76fe-vela");
        let added = std::process::Command::new("git")
            .current_dir(root)
            .args(["worktree", "add", task_wt.to_str().unwrap(), "ch/76fe-vela"])
            .output()
            .unwrap();
        assert!(added.status.success());

        // Interrupted cleanup: the checkout loses its `.git` file, everything
        // else stays put.
        fs::remove_file(task_wt.join(".git")).unwrap();
        assert!(task_wt.is_dir(), "the residue directory still exists");
        assert!(
            service.worktree_for_branch(root, "ch/76fe-vela").is_none(),
            "a dead checkout is not where the branch lives"
        );

        let err = service
            .rebase_branch(root, &task_wt, &base_branch, &base_branch, "ch/76fe-vela")
            .expect_err("nothing usable holds the branch");
        let msg = err.to_string();
        assert!(
            msg.contains("no worktree currently has"),
            "expected chro's own wording, got: {msg}"
        );
        assert!(
            !msg.contains("could not find repository"),
            "raw libgit2 error leaked to the caller: {msg}"
        );
        drop(repo);
    }

    /// Build a repo where the task branch is genuinely ahead of the base in
    /// commits, yet identical to it in content: its own change also reached the
    /// base independently, and the base was then merged back in. This is what a
    /// rebase-plus-pull leaves behind, and it is the state that made Merge
    /// report a repository error.
    fn repo_with_branch_already_contained(
    ) -> (tempfile::TempDir, tempfile::TempDir, PathBuf, String) {
        let (tmp, repo) = init_repo();
        let service = GitService::new();
        let root = tmp.path();
        write_file(root, "base.txt", "base\n");
        service.commit_all(root, "base commit").unwrap();
        let base_branch = repo.head().unwrap().shorthand().unwrap().to_string();

        service
            .ensure_branch_exists(root, "ch/landed", Some(&base_branch))
            .unwrap();
        let wt_home = tempdir().unwrap();
        let task_wt = wt_home.path().join("task-worktree");
        let added = std::process::Command::new("git")
            .current_dir(root)
            .args(["worktree", "add", task_wt.to_str().unwrap(), "ch/landed"])
            .output()
            .unwrap();
        assert!(added.status.success());

        write_file(&task_wt, "feature.txt", "feature\n");
        service.commit_all(&task_wt, "task commit").unwrap();

        // The same content lands on the base through another route...
        write_file(root, "feature.txt", "feature\n");
        service
            .commit_all(root, "same content, other commit")
            .unwrap();

        // ...and the task branch takes the base back in, so it is no longer
        // behind. Identical additions merge without a conflict.
        let merged = std::process::Command::new("git")
            .current_dir(&task_wt)
            .args(["merge", "--no-edit", &base_branch])
            .output()
            .unwrap();
        assert!(
            merged.status.success(),
            "merge failed: {}",
            String::from_utf8_lossy(&merged.stderr)
        );

        drop(repo);
        (tmp, wt_home, task_wt, base_branch)
    }

    /// Merging a branch whose content is already in the base is a no-op, not a
    /// failure. It must be reported as "nothing to merge" (which the API maps
    /// to 409) rather than as an invalid repository.
    #[test]
    fn merge_reports_nothing_to_merge_when_content_already_landed() {
        let (tmp, _wt_home, task_wt, base_branch) = repo_with_branch_already_contained();
        let service = GitService::new();
        let root = tmp.path();
        let head_before = service.head_commit(root).unwrap().as_oid();

        let err = service
            .merge_changes(root, &task_wt, "ch/landed", &base_branch, "squash merge")
            .expect_err("a content-identical branch has nothing to merge");

        assert!(
            matches!(err, GitServiceError::NothingToMerge(_)),
            "expected NothingToMerge, got: {err:?}"
        );
        assert_eq!(service.head_commit(root).unwrap().as_oid(), head_before);
    }

    /// Same situation, but with the base branch checked out nowhere, which
    /// routes the merge through the in-process (git2) path. That path used to
    /// write an empty commit onto the base instead of refusing.
    #[test]
    fn merge_without_a_base_checkout_also_reports_nothing_to_merge() {
        let (tmp, _wt_home, task_wt, base_branch) = repo_with_branch_already_contained();
        let service = GitService::new();
        let root = tmp.path();

        // Park the main checkout on an unrelated branch so no worktree holds
        // the base branch any more.
        service
            .ensure_branch_exists(root, "ch/parking", Some(&base_branch))
            .unwrap();
        let parked = std::process::Command::new("git")
            .current_dir(root)
            .args(["checkout", "ch/parking"])
            .output()
            .unwrap();
        assert!(parked.status.success());
        let base_before = service.resolve_commit_sha(root, &base_branch);

        let err = service
            .merge_changes(root, &task_wt, "ch/landed", &base_branch, "squash merge")
            .expect_err("a content-identical branch has nothing to merge");

        assert!(
            matches!(err, GitServiceError::NothingToMerge(_)),
            "expected NothingToMerge, got: {err:?}"
        );
        assert_eq!(service.resolve_commit_sha(root, &base_branch), base_before);
    }

    #[test]
    fn resolve_commit_sha_handles_shas_branches_and_misses() {
        let (tmp, repo) = init_repo();
        let service = GitService::new();
        let head = repo.head().unwrap().target().unwrap().to_string();
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();

        // A full sha resolves to itself; a branch name resolves to its tip.
        assert_eq!(
            service.resolve_commit_sha(tmp.path(), &head).as_deref(),
            Some(head.as_str())
        );
        assert_eq!(
            service.resolve_commit_sha(tmp.path(), &branch).as_deref(),
            Some(head.as_str())
        );
        // A revision that names nothing in this repo resolves to None — the
        // signal fork uses to refuse rather than fall back to main.
        assert!(service
            .resolve_commit_sha(tmp.path(), "ch/gone-branch")
            .is_none());
        assert!(service
            .resolve_commit_sha(tmp.path(), "0000000000000000000000000000000000000000")
            .is_none());
        drop(repo);
    }

    #[test]
    fn creates_and_checkout_branch() {
        let (tmp, repo) = init_repo();
        let service = GitService::new();
        service
            .ensure_branch_exists(tmp.path(), "feature/demo", Some("master"))
            .unwrap_or_else(|_| {
                service
                    .ensure_branch_exists(tmp.path(), "feature/demo", Some("main"))
                    .unwrap()
            });
        service.checkout_branch(tmp.path(), "feature/demo").unwrap();
        let current = service.get_current_branch(tmp.path()).unwrap();
        assert!(current == "feature/demo" || current == "master" || current == "main");
        drop(repo);
    }

    #[test]
    fn commits_only_staged_changes() {
        let (tmp, _repo) = init_repo();
        let service = GitService::new();

        write_file(tmp.path(), "staged.txt", "hello staged\n");
        write_file(tmp.path(), "unstaged.txt", "hello unstaged\n");

        service
            .stage(tmp.path(), &["staged.txt".to_string()])
            .unwrap();
        let commit_sha = service.commit_staged(tmp.path(), "commit staged").unwrap();
        assert!(commit_sha.is_some());

        let status = service.status(tmp.path()).unwrap();
        assert!(status.staged.is_empty());
        assert!(status.untracked.contains(&"unstaged.txt".to_string()));
        assert!(!status.untracked.contains(&"staged.txt".to_string()));
    }

    /// `git status` folds an untracked directory into a single `crates/` entry,
    /// and the Source Control panel hands that path straight to `stage`. libgit2's
    /// `Index::add_path` rejected it (`invalid path: 'crates/'`); staging via
    /// `git add` recurses the directory so every file beneath it lands staged.
    #[test]
    fn stages_a_folded_untracked_directory() {
        let (tmp, _repo) = init_repo();
        let service = GitService::new();

        write_file(tmp.path(), "crates/git/src/lib.rs", "// hi\n");
        write_file(tmp.path(), "crates/git/Cargo.toml", "[package]\n");

        let untracked = service.status(tmp.path()).unwrap().untracked;
        assert_eq!(untracked, vec!["crates/".to_string()]);

        service.stage(tmp.path(), &untracked).unwrap();

        let staged: Vec<String> = service
            .status(tmp.path())
            .unwrap()
            .staged
            .into_iter()
            .map(|c| c.path)
            .collect();
        assert!(staged.contains(&"crates/git/src/lib.rs".to_string()));
        assert!(staged.contains(&"crates/git/Cargo.toml".to_string()));
    }

    #[test]
    fn staged_commit_noop_when_nothing_staged() {
        let (tmp, _repo) = init_repo();
        let service = GitService::new();
        write_file(tmp.path(), "README.md", "worktree-only\n");

        let commit_sha = service
            .commit_staged(tmp.path(), "should not commit")
            .unwrap();
        assert!(commit_sha.is_none());
    }

    #[test]
    fn worktree_diffs_include_modified_and_untracked_content() {
        let (tmp, _repo) = init_repo();
        let service = GitService::new();

        write_file(tmp.path(), "README.md", "hello world\n");
        service.commit_all(tmp.path(), "add readme").unwrap();
        let base = service.head_commit(tmp.path()).unwrap();

        // Unstaged modification + a brand-new untracked file.
        write_file(tmp.path(), "README.md", "hello chro\n");
        write_file(tmp.path(), "notes.txt", "fresh\n");

        let diffs = service
            .get_diffs(
                DiffTarget::Worktree {
                    worktree_path: tmp.path(),
                    base_commit: base,
                },
                None,
            )
            .unwrap();
        assert_eq!(diffs.len(), 2);

        let readme = diffs
            .iter()
            .find(|d| d.path_key() == Some("README.md"))
            .expect("README.md diff present");
        assert!(matches!(readme.change, DiffChangeKind::Modified));
        assert_eq!(readme.old_content.as_deref(), Some("hello world\n"));
        assert_eq!(readme.new_content.as_deref(), Some("hello chro\n"));
        assert!(readme.additions.unwrap_or(0) >= 1);

        // git2 surfaces untracked files in a workdir diff as `Untracked`, which
        // `map_status` folds into `Modified` with no base content — the new file
        // therefore reads as all-additions, matching the task-run diff path.
        let notes = diffs
            .iter()
            .find(|d| d.path_key() == Some("notes.txt"))
            .expect("notes.txt diff present");
        assert!(matches!(notes.change, DiffChangeKind::Modified));
        assert_eq!(notes.old_content, None);
        assert_eq!(notes.new_content.as_deref(), Some("fresh\n"));
        assert!(notes.additions.unwrap_or(0) >= 1);
    }

    #[test]
    fn worktree_diff_omits_large_content_before_rendering() {
        let (tmp, _repo) = init_repo();
        let service = GitService::new();

        write_file(tmp.path(), "large.txt", "base\n");
        service.commit_all(tmp.path(), "add large file").unwrap();
        let base = service.head_commit(tmp.path()).unwrap();
        write_file(
            tmp.path(),
            "large.txt",
            &"x".repeat(MAX_INLINE_DIFF_BYTES + 1),
        );

        let diffs = service
            .get_diffs(
                DiffTarget::Worktree {
                    worktree_path: tmp.path(),
                    base_commit: base,
                },
                None,
            )
            .unwrap();
        let large = diffs
            .iter()
            .find(|d| d.path_key() == Some("large.txt"))
            .expect("large diff present");
        assert!(large.content_omitted);
        assert!(large.old_content.is_none());
        assert!(large.new_content.is_none());
    }

    #[test]
    fn worktree_diff_omits_large_untracked_content() {
        let (tmp, _repo) = init_repo();
        let service = GitService::new();
        let base = service.head_commit(tmp.path()).unwrap();
        write_file(
            tmp.path(),
            "generated.log",
            &"x".repeat(MAX_INLINE_DIFF_BYTES + 1),
        );

        let diffs = service
            .get_diffs(
                DiffTarget::Worktree {
                    worktree_path: tmp.path(),
                    base_commit: base,
                },
                None,
            )
            .unwrap();
        let large = diffs
            .iter()
            .find(|d| d.path_key() == Some("generated.log"))
            .expect("large untracked diff present");
        assert!(large.content_omitted);
        assert!(large.new_content.is_none());
    }
}
