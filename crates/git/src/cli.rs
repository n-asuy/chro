use std::{
    ffi::{OsStr, OsString},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitCliError {
    #[error("git is not available")]
    NotAvailable,
    #[error("git command failed: {0}")]
    CommandFailed(String),
    /// A commit was asked for with nothing staged. Callers treat this as a
    /// no-op rather than a failure.
    #[error("nothing to commit")]
    NothingToCommit,
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
    #[error("git {0} timed out after {1}s")]
    Timeout(String, u64),
}

/// Read-only git commands (status, diff, rev-list, merge-base, …). Capped low
/// because a healthy read returns in well under a second; a longer run means a
/// pathological worktree (e.g. mid-`bun install`) and we would rather surface a
/// timeout than hang a blocking thread for minutes — the cause of the
/// all-sessions "locked" freeze.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Writes and network ops (commit, checkout, push, pull, fetch). Longer because
/// a legitimate push/pull can take a while, but still bounded so a hung remote
/// or lock can't freeze a thread forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// Cap captured output so a runaway command can't balloon memory.
const MAX_GIT_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy)]
struct GitRunOpts {
    timeout: Duration,
    /// Set `GIT_OPTIONAL_LOCKS=0` so read-only commands don't take the index
    /// lock and contend with concurrent writes (stage/commit/auto-commit).
    /// Off for writes, which need the lock.
    optional_locks_off: bool,
}

impl GitRunOpts {
    fn read() -> Self {
        Self {
            timeout: READ_TIMEOUT,
            optional_locks_off: true,
        }
    }
    fn write() -> Self {
        Self {
            timeout: WRITE_TIMEOUT,
            optional_locks_off: false,
        }
    }
}

struct GitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn read_capped(reader: &mut impl Read) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < MAX_GIT_OUTPUT_BYTES {
                    let room = MAX_GIT_OUTPUT_BYTES - buf.len();
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                // Keep draining past the cap so the child never blocks on a full
                // pipe; we just stop storing the overflow.
            }
            Err(_) => break,
        }
    }
    buf
}

fn render_args(args: &[OsString]) -> String {
    args.iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Run `git` as a killable subprocess with a hard timeout and optional
/// `GIT_OPTIONAL_LOCKS=0`. stdout/stderr are drained on dedicated threads so a
/// large output never deadlocks the timeout poll, and the process is killed if
/// it overruns the deadline. This is the single chokepoint every `GitCli` call
/// routes through, so no git invocation can hang a blocking thread indefinitely.
fn exec_git<I, S>(cwd: &Path, args: I, opts: GitRunOpts) -> Result<GitOutput, GitCliError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args.into_iter().map(|a| a.as_ref().to_os_string()).collect();
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).args(&args);
    if opts.optional_locks_off {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    run_command_capped(cmd, opts.timeout, render_args(&args))
}

/// Spawn `cmd`, capture its output on dedicated drain threads, and enforce a
/// hard timeout by killing the process if it overruns the deadline. The drain
/// threads ensure a large output never deadlocks the timeout poll. `label` names
/// the command in the timeout error. (Split from `exec_git` so the kill-on-
/// timeout machinery is testable without a hanging git invocation.)
fn run_command_capped(
    mut cmd: Command,
    timeout: Duration,
    label: String,
) -> Result<GitOutput, GitCliError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let mut out_pipe = child.stdout.take().expect("stdout piped");
    let mut err_pipe = child.stderr.take().expect("stderr piped");
    let out_handle = std::thread::spawn(move || read_capped(&mut out_pipe));
    let err_handle = std::thread::spawn(move || read_capped(&mut err_pipe));

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_handle.join();
            let _ = err_handle.join();
            return Err(GitCliError::Timeout(label, timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(15));
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(GitOutput {
        status,
        stdout,
        stderr,
    })
}

#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: Option<String>,
}

/// The remote-tracking ref a branch should reconcile with: the branch's
/// configured upstream when one exists, otherwise the same-named
/// `origin/<branch>` ref when it already exists on the remote.
///
/// This is what makes push/pull/ahead-behind work for branches that were never
/// given an upstream — the common case for task-run worktrees, which start on a
/// fresh branch cut from the base with no tracking relationship.
#[derive(Debug, Clone)]
struct EffectiveUpstream {
    /// Short upstream ref, e.g. `origin/ch/562a-job`.
    name: String,
    remote: String,
    branch: String,
    /// `true` when this came from the branch's configured `@{u}`; `false` when
    /// it was inferred from an existing `origin/<branch>` tracking ref.
    is_configured: bool,
}

/// Split a short remote ref (`origin/feature/foo`) into `(remote, branch)` on
/// the first slash. Remote names never contain slashes, so the first segment is
/// the remote and the remainder (which may itself contain slashes) is the
/// branch. Returns `None` when there is no interior slash.
fn split_remote_branch(ref_name: &str) -> Option<(String, String)> {
    let idx = ref_name.find('/')?;
    if idx == 0 || idx == ref_name.len() - 1 {
        return None;
    }
    Some((ref_name[..idx].to_string(), ref_name[idx + 1..].to_string()))
}

#[derive(Debug, Clone, Default)]
pub struct GitCli;

impl GitCli {
    pub fn new() -> Self {
        Self
    }

    /// Run a read-only git command and return stdout on success. Routes through
    /// the hardened `exec_git` chokepoint (timeout + kill + `GIT_OPTIONAL_LOCKS=0`).
    fn git<I, S>(&self, cwd: &Path, args: I) -> Result<String, GitCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = exec_git(cwd, args, GitRunOpts::read())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(GitCliError::CommandFailed(stderr));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Run a git command (used by writes and mixed callers) returning
    /// `(stdout, stderr)`. Routes through the hardened `exec_git` chokepoint with
    /// the longer write timeout and the index lock left enabled.
    pub fn run(&self, cwd: &Path, args: &[&str]) -> Result<(String, String), GitCliError> {
        let output = exec_git(cwd, args.iter().copied(), GitRunOpts::write())?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if !output.status.success() {
            // Git explains some failures on stdout and leaves stderr empty
            // (`commit` with an empty index, most notably). Reporting stderr
            // alone would surface an error with no message at all.
            let detail = if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            return Err(GitCliError::CommandFailed(detail.trim().to_string()));
        }
        Ok((stdout, stderr))
    }

    /// Working-tree status as raw porcelain v1 (`-z`, NUL-separated). Untracked
    /// directories are reported as a single entry rather than recursed into, so
    /// a worktree with a huge untracked tree (e.g. `node_modules` mid-install)
    /// returns instantly instead of crawling hundreds of thousands of files.
    /// `GIT_OPTIONAL_LOCKS=0` (via `git()`) keeps this polled read off the index
    /// lock so it never blocks behind a concurrent stage/commit.
    pub fn status_porcelain(&self, repo_path: &Path) -> Result<String, GitCliError> {
        self.git(
            repo_path,
            [
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
            ],
        )
    }

    /// Commits ahead/behind a base ref, computed with a single killable
    /// `git rev-list --left-right --count <branch>...<base>` instead of a libgit2
    /// revwalk that cannot be cancelled. Returns `(ahead, behind)`.
    pub fn ahead_behind(
        &self,
        repo_path: &Path,
        branch: &str,
        base: &str,
    ) -> Result<(usize, usize), GitCliError> {
        let range = format!("{base}...{branch}");
        let out = self.git(repo_path, ["rev-list", "--left-right", "--count", &range])?;
        // Output is "<behind>\t<ahead>" (left = base side = behind, right =
        // branch side = ahead).
        let mut parts = out.split_whitespace();
        let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok((ahead, behind))
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

    /// Stage the given pathspecs, which may be files or directories. `git add`
    /// recurses into directories, so a folded untracked directory entry (e.g.
    /// `crates/`, the form `git status` reports when untracked dirs are not
    /// recursed) stages every file beneath it; it also records additions,
    /// modifications, and — since Git 2.0 — deletions of tracked files. The
    /// `--` separator stops a path that looks like an option from being
    /// misparsed.
    pub fn add_paths(&self, repo_path: &Path, paths: &[String]) -> Result<(), GitCliError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut args: Vec<&str> = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.run(repo_path, &args)?;
        Ok(())
    }

    /// Create a commit with the given message
    pub fn commit(&self, repo_path: &Path, message: &str) -> Result<(), GitCliError> {
        self.run(repo_path, &["commit", "-m", message])?;
        Ok(())
    }

    /// Remove the commit message `merge --squash` stages for the next commit.
    /// Only called when that commit is not going to happen; failures are not
    /// worth surfacing because the file is advisory.
    fn discard_pending_merge_message(&self, repo_path: &Path) {
        for name in ["SQUASH_MSG", "MERGE_MSG"] {
            if let Ok(raw) = self.git(repo_path, ["rev-parse", "--git-path", name]) {
                let path = Path::new(raw.trim()).to_path_buf();
                let path = if path.is_absolute() {
                    path
                } else {
                    repo_path.join(path)
                };
                let _ = std::fs::remove_file(path);
            }
        }
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
        // A branch can be ahead in commits yet identical in content (its work
        // reached the base by another route, e.g. a rebase or a pull). The
        // squash then stages nothing, and committing would fail with an
        // unrelated-looking error. Report the no-op for what it is, and drop
        // the message `--squash` left behind so the checkout is untouched.
        if !self.has_staged_changes(repo_path)? {
            self.discard_pending_merge_message(repo_path);
            return Err(GitCliError::NothingToCommit);
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
        // `--git-path` output is relative to the worktree for plain repos (only
        // linked worktrees yield absolute paths), so resolve it against the
        // worktree, never the server process's cwd.
        let resolve = |raw: &str| {
            let path = Path::new(raw.trim());
            if path.is_absolute() {
                path.exists()
            } else {
                worktree_path.join(path).exists()
            }
        };
        let rebase_merge = self.git(worktree_path, ["rev-parse", "--git-path", "rebase-merge"])?;
        let rebase_apply = self.git(worktree_path, ["rev-parse", "--git-path", "rebase-apply"])?;
        Ok(resolve(&rebase_merge) || resolve(&rebase_apply))
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
    /// Rebase the branch currently checked out in `worktree_path` onto
    /// `new_base`.
    ///
    /// The branch is never passed as a positional argument: that form makes git
    /// check the branch out first, which fails outright ("already used by
    /// worktree") when the branch lives in a different worktree. Rebasing HEAD
    /// keeps the operation inside the worktree it was invoked on, so it cannot
    /// collide with another checkout. The caller is responsible for invoking
    /// this in the worktree that actually holds the branch.
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

        self.git(worktree_path, ["rebase", "--onto", new_base, &merge_base])?;
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

    /// The current branch name, or `None` when HEAD is detached or unborn.
    fn current_branch(&self, repo_path: &Path) -> Option<String> {
        let out = self
            .git(repo_path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()?;
        let branch = out.trim().to_string();
        if branch.is_empty() {
            None
        } else {
            Some(branch)
        }
    }

    /// Whether `refs/remotes/<remote>/<branch>` exists locally.
    fn remote_tracking_ref_exists(&self, repo_path: &Path, remote: &str, branch: &str) -> bool {
        self.git(
            repo_path,
            [
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{remote}/{branch}"),
            ],
        )
        .is_ok()
    }

    /// Resolve the effective upstream for the current branch (see
    /// [`EffectiveUpstream`]). Returns `None` when the branch has neither a
    /// configured upstream nor a matching `origin/<branch>` tracking ref — i.e.
    /// it has never been published.
    fn resolve_effective_upstream(&self, repo_path: &Path) -> Option<EffectiveUpstream> {
        // 1. The branch's configured upstream, when set.
        if let Ok(out) = self.git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD@{u}"]) {
            let name = out.trim().to_string();
            if !name.is_empty() {
                if let Some((remote, branch)) = split_remote_branch(&name) {
                    return Some(EffectiveUpstream {
                        name,
                        remote,
                        branch,
                        is_configured: true,
                    });
                }
            }
        }

        // 2. Fall back to a same-named origin tracking ref, when it exists.
        let branch = self.current_branch(repo_path)?;
        if self.remote_tracking_ref_exists(repo_path, "origin", &branch) {
            return Some(EffectiveUpstream {
                name: format!("origin/{branch}"),
                remote: "origin".to_string(),
                branch,
                is_configured: false,
            });
        }

        None
    }

    /// The branch's configured push target as `(remote, refspec)`, or `None`
    /// when nothing usable is configured. Respects an explicit
    /// `branch.<name>.{remote,merge}` so PR worktrees that track a contributor
    /// fork push back to that fork instead of `origin`.
    fn configured_push_target(&self, repo_path: &Path) -> Option<(String, String)> {
        let branch = self.current_branch(repo_path)?;
        let remote = self
            .git(repo_path, ["config", "--get", &format!("branch.{branch}.remote")])
            .ok()?
            .trim()
            .to_string();
        let merge_ref = self
            .git(repo_path, ["config", "--get", &format!("branch.{branch}.merge")])
            .ok()?
            .trim()
            .to_string();
        let branch_ref = merge_ref
            .strip_prefix("refs/heads/")
            .unwrap_or(&merge_ref)
            .to_string();
        // `.` is the local remote; a `merge` value without the refs/heads/
        // prefix is not a branch ref we can push to.
        if remote.is_empty() || branch_ref.is_empty() || remote == "." || branch_ref == merge_ref {
            return None;
        }
        // origin must publish under the same branch name; anything else is a
        // legacy mistracking we should not perpetuate.
        if remote == "origin" && branch_ref != branch {
            return None;
        }
        Some((remote, format!("HEAD:{branch_ref}")))
    }

    /// Push commits to the remote, setting upstream on first publish.
    ///
    /// A bare `git push` aborts when the branch has no upstream — exactly the
    /// state of a freshly-cut task-run branch — so we always `--set-upstream`.
    /// The target is the branch's configured push target when one exists,
    /// otherwise `origin HEAD` (publish under the current branch name).
    pub fn push(&self, repo_path: &Path) -> Result<(), GitCliError> {
        let target = self.configured_push_target(repo_path);
        let (remote, refspec) = target.unwrap_or_else(|| ("origin".to_string(), "HEAD".to_string()));
        self.run(repo_path, &["push", "--set-upstream", &remote, &refspec])?;
        Ok(())
    }

    /// Pull changes from the remote, following the effective upstream.
    ///
    /// With a configured upstream (or none at all) we defer to plain `git pull`
    /// so the user's configured pull strategy applies. When the upstream was
    /// only inferred from an existing `origin/<branch>` ref, we pull it
    /// explicitly so the branch reconciles with what push publishes to.
    pub fn pull(&self, repo_path: &Path) -> Result<(), GitCliError> {
        match self.resolve_effective_upstream(repo_path) {
            Some(upstream) if !upstream.is_configured => {
                self.run(repo_path, &["pull", &upstream.remote, &upstream.branch])?;
            }
            _ => {
                self.run(repo_path, &["pull"])?;
            }
        }
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

    /// Commits `(ahead, behind)` the current branch is relative to its
    /// effective upstream (see [`EffectiveUpstream`]). Returns `(0, 0)` when the
    /// branch has never been published, so the Source Control push/pull badges
    /// read zero rather than erroring — while push still works as a first
    /// publish.
    pub fn get_remote_status(&self, repo_path: &Path) -> Result<(usize, usize), GitCliError> {
        let Some(upstream) = self.resolve_effective_upstream(repo_path) else {
            return Ok((0, 0));
        };

        // `HEAD...<upstream>` with --left-right counts left (HEAD, ahead) then
        // right (upstream, behind).
        let result = self.run(
            repo_path,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("HEAD...{}", upstream.name),
            ],
        );

        match result {
            Ok((stdout, _)) => {
                let parts: Vec<&str> = stdout.split_whitespace().collect();
                if parts.len() >= 2 {
                    let ahead = parts[0].parse().unwrap_or(0);
                    let behind = parts[1].parse().unwrap_or(0);
                    Ok((ahead, behind))
                } else {
                    Ok((0, 0))
                }
            }
            Err(_) => Ok((0, 0)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn run_command_capped_kills_on_timeout() {
        // A 5s sleep with a 150ms deadline must be killed and surface a timeout
        // far sooner than its natural runtime — the safety net against the
        // multi-minute git hangs that froze the UI.
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let start = Instant::now();
        let result = run_command_capped(cmd, Duration::from_millis(150), "sleep 5".into());
        assert!(matches!(result, Err(GitCliError::Timeout(_, _))));
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "command was not killed promptly: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn run_command_capped_captures_output() {
        let mut cmd = Command::new("printf");
        cmd.arg("hello");
        let out = run_command_capped(cmd, Duration::from_secs(5), "printf hello".into())
            .expect("printf runs");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello");
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .status()
            .expect("git should be available");
        assert!(status.success(), "git {args:?} failed in {cwd:?}");
    }

    fn write(root: &Path, name: &str, contents: &str) {
        fs::write(root.join(name), contents).unwrap();
    }

    fn rev_parse(cwd: &Path, rev: &str) -> Option<String> {
        let out = Command::new("git")
            .current_dir(cwd)
            .args(["rev-parse", "--verify", "--quiet", rev])
            .output()
            .unwrap();
        if out.status.success() {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            None
        }
    }

    /// A bare "remote" with a `main` branch, plus a working clone that has one
    /// commit pushed and tracking `origin/main`.
    fn remote_and_clone() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        let work = tmp.path().join("work");

        git(tmp.path(), &["init", "--bare", "-b", "main", remote.to_str().unwrap()]);
        fs::create_dir(&work).unwrap();
        git(&work, &["init", "-b", "main"]);
        git(&work, &["config", "user.email", "tester@example.com"]);
        git(&work, &["config", "user.name", "tester"]);
        write(&work, "README.md", "hello\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "init"]);
        git(&work, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&work, &["push", "-u", "origin", "main"]);

        (tmp, remote, work)
    }

    #[test]
    fn push_sets_upstream_for_branch_without_one() {
        let (_tmp, remote, work) = remote_and_clone();
        let cli = GitCli::new();

        // Fresh branch with a commit and no upstream — bare `git push` would
        // abort with "no upstream branch".
        git(&work, &["checkout", "-b", "ch/562a-job"]);
        write(&work, "feature.txt", "feature\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "feature work"]);

        cli.push(&work).expect("first publish should set upstream and succeed");

        // The remote now has the branch, and the local branch tracks it.
        assert!(
            rev_parse(&remote, "refs/heads/ch/562a-job").is_some(),
            "branch published to remote"
        );
        let upstream = cli
            .resolve_effective_upstream(&work)
            .expect("upstream resolved after publish");
        assert_eq!(upstream.name, "origin/ch/562a-job");
        assert!(upstream.is_configured);

        // Nothing diverged, so the badges read zero.
        assert_eq!(cli.get_remote_status(&work).unwrap(), (0, 0));
    }

    #[test]
    fn remote_status_zero_before_publish() {
        let (_tmp, _remote, work) = remote_and_clone();
        let cli = GitCli::new();

        git(&work, &["checkout", "-b", "ch/unpublished"]);
        write(&work, "a.txt", "a\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "local only"]);

        // Never published: no configured upstream, no origin/<branch> ref.
        assert!(cli.resolve_effective_upstream(&work).is_none());
        assert_eq!(cli.get_remote_status(&work).unwrap(), (0, 0));
    }

    #[test]
    fn remote_status_counts_ahead_after_local_commit() {
        let (_tmp, _remote, work) = remote_and_clone();
        let cli = GitCli::new();

        git(&work, &["checkout", "-b", "ch/ahead"]);
        write(&work, "a.txt", "a\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "first"]);
        cli.push(&work).expect("publish");

        // One more local commit that has not been pushed.
        write(&work, "b.txt", "b\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "second"]);

        assert_eq!(cli.get_remote_status(&work).unwrap(), (1, 0));

        // After publishing, ahead returns to zero.
        cli.push(&work).expect("push the new commit");
        assert_eq!(cli.get_remote_status(&work).unwrap(), (0, 0));
    }

    #[test]
    fn remote_status_uses_origin_branch_without_configured_upstream() {
        let (_tmp, remote, work) = remote_and_clone();
        let cli = GitCli::new();

        // Publish a branch, then create a local-only commit and strip the
        // configured upstream so only the origin/<branch> tracking ref remains.
        git(&work, &["checkout", "-b", "ch/inferred"]);
        write(&work, "a.txt", "a\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "published"]);
        cli.push(&work).expect("publish");

        write(&work, "b.txt", "b\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "local only"]);

        // Drop the configured upstream; origin/ch/inferred still exists locally.
        git(&work, &["branch", "--unset-upstream"]);
        assert!(rev_parse(&work, "refs/remotes/origin/ch/inferred").is_some());

        let upstream = cli
            .resolve_effective_upstream(&work)
            .expect("inferred from origin/<branch>");
        assert_eq!(upstream.name, "origin/ch/inferred");
        assert!(!upstream.is_configured);
        assert_eq!(cli.get_remote_status(&work).unwrap(), (1, 0));

        // Push still works (re-sets upstream) and the remote advances.
        cli.push(&work).expect("push with inferred upstream");
        assert_eq!(
            rev_parse(&remote, "refs/heads/ch/inferred"),
            rev_parse(&work, "HEAD")
        );
    }

    /// A branch whose commits are already contained in the base by content
    /// (rebased away, or landed via the remote) squashes into an empty index.
    /// That is "nothing to merge", not a broken repository: `git commit` would
    /// exit non-zero with an empty stderr and the failure would be reported as
    /// an unrelated repository error.
    #[test]
    fn merge_squash_reports_nothing_to_commit_when_branch_is_already_upstream() {
        let (_tmp, _remote, work) = remote_and_clone();
        let cli = GitCli::new();

        // The task branch adds a file...
        git(&work, &["checkout", "-b", "ch/already-landed"]);
        write(&work, "feature.txt", "feature\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "feature work"]);

        // ...and the very same content reaches main independently, so the two
        // branches differ in commits but not in tree.
        git(&work, &["checkout", "main"]);
        write(&work, "feature.txt", "feature\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "same content, other commit"]);

        let before = rev_parse(&work, "HEAD");
        let result = cli.merge_squash_commit(&work, "main", "ch/already-landed", "squash");

        assert!(
            matches!(result, Err(GitCliError::NothingToCommit)),
            "expected NothingToCommit, got {result:?}"
        );
        // The base branch must be left exactly where it was: no empty commit,
        // and no half-prepared commit message waiting in the checkout.
        assert_eq!(rev_parse(&work, "HEAD"), before);
        assert!(!work.join(".git/SQUASH_MSG").exists());
    }

    /// Git reports some failures (`commit` with an empty index above all) on
    /// stdout and leaves stderr empty. Reading stderr alone produced errors
    /// whose text stopped at "git command failed:".
    #[test]
    fn command_failure_reported_on_stdout_keeps_its_message() {
        let (_tmp, _remote, work) = remote_and_clone();
        let cli = GitCli::new();

        let err = cli
            .run(&work, &["commit", "-m", "nothing staged"])
            .expect_err("committing an empty index fails");

        let message = err.to_string();
        assert!(
            message.to_lowercase().contains("nothing to commit"),
            "failure message lost git's explanation: {message}"
        );
    }

    #[test]
    fn split_remote_branch_splits_on_first_slash() {
        assert_eq!(
            split_remote_branch("origin/feature/foo"),
            Some(("origin".to_string(), "feature/foo".to_string()))
        );
        assert_eq!(
            split_remote_branch("origin/main"),
            Some(("origin".to_string(), "main".to_string()))
        );
        assert_eq!(split_remote_branch("main"), None);
        assert_eq!(split_remote_branch("/leading"), None);
        assert_eq!(split_remote_branch("trailing/"), None);
    }
}
