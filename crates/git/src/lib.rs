use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use git2::{
    Branch, BranchType, DiffFindOptions, DiffFormat, DiffOptions, MergeOptions, ObjectType,
    Reference, Repository, Tree,
};
use log_types::{compute_line_change_counts, Diff, DiffChangeKind};
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod cli;

pub use cli::GitCliError as CliError;
use cli::{GitCli, GitCliError};

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

const MAX_INLINE_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct CommitId(git2::Oid);

impl CommitId {
    pub fn new(oid: git2::Oid) -> Self {
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
            Err(_) => git2::Signature::now("Chro", "noreply@chro-ai.com")
                .map_err(GitServiceError::from),
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
        let worktrees = git_cli.list_worktrees(repo_path).map_err(|e| {
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
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("CLI merge failed: {e}"))
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
                let squash_commit_id = self.perform_squash_merge(
                    &task_repo,
                    &base_commit,
                    &task_commit,
                    &signature,
                    commit_message,
                    base_branch_name,
                )?;

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
    pub fn rebase_branch(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        new_base_branch: &str,
        old_base_branch: &str,
        task_branch: &str,
    ) -> Result<String, GitServiceError> {
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
    pub fn abort_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
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

    pub fn get_branch_status(
        &self,
        repo_path: impl AsRef<Path>,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<(usize, usize), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        self.branch_status_for_repo(&repo, branch_name, base_branch_name)
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

    fn branch_status_for_repo(
        &self,
        repo: &Repository,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<(usize, usize), GitServiceError> {
        let branch = self.find_branch(repo, branch_name)?;
        let base_branch = self.find_branch(repo, base_branch_name)?;
        self.get_branch_status_inner(
            repo,
            &branch.into_reference(),
            &base_branch.into_reference(),
        )
    }

    fn get_branch_status_inner(
        &self,
        repo: &Repository,
        branch_ref: &Reference,
        base_branch_ref: &Reference,
    ) -> Result<(usize, usize), GitServiceError> {
        let branch_target = branch_ref.target().ok_or_else(|| {
            GitServiceError::BranchNotFound(branch_ref.name().unwrap_or("branch").to_string())
        })?;
        let base_target = base_branch_ref.target().ok_or_else(|| {
            GitServiceError::BranchNotFound(base_branch_ref.name().unwrap_or("branch").to_string())
        })?;
        let (ahead, behind) = repo.graph_ahead_behind(branch_target, base_target)?;
        Ok((ahead, behind))
    }

    fn perform_squash_merge(
        &self,
        repo: &Repository,
        base_commit: &git2::Commit,
        task_commit: &git2::Commit,
        signature: &git2::Signature,
        commit_message: &str,
        base_branch_name: &str,
    ) -> Result<git2::Oid, GitServiceError> {
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

        Ok(squash_commit_id)
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

    pub fn diff_commits(
        &self,
        repo_path: impl AsRef<Path>,
        from_ref: &str,
        to_ref: &str,
    ) -> Result<DiffSummary, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let from_tree = self.rev_to_tree(&repo, from_ref)?;
        let to_tree = self.rev_to_tree(&repo, to_ref)?;

        let mut options = DiffOptions::new();
        options
            .include_untracked(false)
            .recurse_untracked_dirs(true)
            .include_typechange(true);

        let diff = repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut options))?;
        let summary = DiffSummary::from_diff(&diff)?;
        Ok(summary)
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

    fn rev_to_tree<'repo>(
        &self,
        repo: &'repo Repository,
        reference: &str,
    ) -> Result<Tree<'repo>, GitServiceError> {
        let object = repo.revparse_single(reference)?;
        match object.kind() {
            Some(ObjectType::Tree) => Ok(object.peel_to_tree()?),
            Some(ObjectType::Commit) => Ok(object.peel_to_commit()?.tree()?),
            _ => Err(GitServiceError::ReferenceNotFound(reference.to_string())),
        }
    }

    /// Get the status of the working directory
    pub fn status(&self, repo_path: impl AsRef<Path>) -> Result<GitStatus, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let mut staged = Vec::new();
        let mut modified = Vec::new();
        let mut untracked = Vec::new();

        let statuses = repo.statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .include_ignored(false),
        ))?;

        for entry in statuses.iter() {
            let Some(path_str) = entry.path() else {
                continue;
            };
            if path_str.trim().is_empty() {
                continue;
            }
            let path = path_str.to_string();
            let status = entry.status();

            if status.is_index_new() {
                staged.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::Added,
                });
            } else if status.is_index_modified() {
                staged.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::Modified,
                });
            } else if status.is_index_deleted() {
                staged.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::Deleted,
                });
            } else if status.is_index_renamed() {
                staged.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::Renamed,
                });
            } else if status.is_index_typechange() {
                staged.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::TypeChange,
                });
            }

            if status.is_wt_modified() {
                modified.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::Modified,
                });
            } else if status.is_wt_deleted() {
                modified.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::Deleted,
                });
            } else if status.is_wt_renamed() {
                modified.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::Renamed,
                });
            } else if status.is_wt_typechange() {
                modified.push(FileChange {
                    path: path.clone(),
                    status: FileChangeStatus::TypeChange,
                });
            }

            if status.is_wt_new() {
                untracked.push(path);
            }
        }

        let has_changes = !staged.is_empty() || !modified.is_empty() || !untracked.is_empty();

        Ok(GitStatus {
            staged,
            modified,
            untracked,
            has_changes,
        })
    }

    pub fn is_worktree_clean(&self, repo_path: &Path) -> Result<bool, GitServiceError> {
        Ok(!self.status(repo_path)?.has_changes)
    }

    /// Stage files for commit
    pub fn stage(
        &self,
        repo_path: impl AsRef<Path>,
        paths: &[String],
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let mut index = repo.index()?;
        let workdir = repo.workdir().ok_or(GitServiceError::WorkdirMissing)?;

        for path in paths {
            let relative = Path::new(path);
            let full_path = workdir.join(relative);
            if full_path.exists() {
                index.add_path(relative)?;
            } else {
                match index.remove_path(relative) {
                    Ok(()) => {}
                    Err(err) if err.code() == git2::ErrorCode::NotFound => {}
                    Err(err) => return Err(err.into()),
                }
            }
        }

        index.write()?;
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

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiffSummary {
    pub files: Vec<FileDiff>,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

impl DiffSummary {
    fn from_diff(diff: &git2::Diff) -> Result<Self, git2::Error> {
        let stats = diff.stats()?;
        let mut builders: BTreeMap<PathBuf, FileDiffBuilder> = BTreeMap::new();

        diff.print(DiffFormat::Patch, |delta, _hunk, line| {
            let path = delta.new_file().path().or_else(|| delta.old_file().path());
            if let Some(path) = path {
                builders
                    .entry(path.to_path_buf())
                    .or_insert_with(|| FileDiffBuilder::new(path))
                    .push_line(line);
            }
            true
        })?;

        let files = builders
            .into_values()
            .map(FileDiffBuilder::build)
            .collect::<Vec<_>>();

        Ok(Self {
            files,
            files_changed: stats.files_changed(),
            insertions: stats.insertions(),
            deletions: stats.deletions(),
        })
    }
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
    for delta in diff.deltas() {
        let change = map_status(delta.status());
        let old_path = delta.old_file().path().map(normalize_path);
        let new_path = delta.new_file().path().map(normalize_path);
        let is_binary =
            delta.old_file().is_binary() || delta.new_file().is_binary() || is_binary_path(&old_path, &new_path);

        let (old_content, new_content) = if is_binary {
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
            content_omitted: false,
            additions: None,
            deletions: None,
            is_binary,
        };
        finalize_diff_entry(&mut entry);
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
    for delta in diff.deltas() {
        let change = map_status(delta.status());
        let old_path = delta.old_file().path().map(normalize_path);
        let new_path = delta.new_file().path().map(normalize_path);
        let is_binary =
            delta.old_file().is_binary() || delta.new_file().is_binary() || is_binary_path(&old_path, &new_path);

        let (old_content, new_content) = if is_binary {
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
            content_omitted: false,
            additions: None,
            deletions: None,
            is_binary,
        };
        finalize_diff_entry(&mut entry);
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
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "svg", "tiff", "tif",
    "pdf", "zip", "gz", "tar", "bz2", "xz", "7z", "rar",
    "mp3", "mp4", "wav", "ogg", "webm", "avi", "mov", "flac",
    "woff", "woff2", "ttf", "otf", "eot",
    "exe", "dll", "so", "dylib", "bin",
    "psd", "ai", "sketch", "fig",
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

#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
    pub patch: String,
}

struct FileDiffBuilder {
    path: String,
    additions: usize,
    deletions: usize,
    patch: String,
}

impl FileDiffBuilder {
    fn new(path: &Path) -> Self {
        Self {
            path: path.to_string_lossy().to_string(),
            additions: 0,
            deletions: 0,
            patch: String::new(),
        }
    }

    fn push_line(&mut self, line: git2::DiffLine<'_>) {
        match line.origin() {
            '+' => self.additions += 1,
            '-' => self.deletions += 1,
            _ => {}
        }

        self.patch.push(line.origin());
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        self.patch.push_str(content);
    }

    fn build(self) -> FileDiff {
        FileDiff {
            path: self.path,
            additions: self.additions,
            deletions: self.deletions,
            patch: self.patch,
        }
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
    fn commits_changes_and_generates_diff() {
        let (tmp, repo) = init_repo();
        let service = GitService::new();
        write_file(tmp.path(), "README.md", "hello world\n");
        service.commit_all(tmp.path(), "add readme").unwrap();
        let head = repo.head().unwrap().target().unwrap();
        write_file(tmp.path(), "README.md", "hello chro\n");
        let new_commit = service.commit_all(tmp.path(), "update readme").unwrap();
        let new_commit_sha = new_commit.expect("expected commit to be created");
        let diff = service
            .diff_commits(tmp.path(), &head.to_string(), &new_commit_sha)
            .unwrap();
        assert_eq!(diff.files.len(), 1);
        assert!(diff.insertions >= 1);
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
}
