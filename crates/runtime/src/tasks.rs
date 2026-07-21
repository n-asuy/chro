use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use db::{
    models::{
        AgentProfile, ForkAnchor, ForkMode, HandoffInfo, ProjectRecord, TaskContextRef,
        TaskContextRefInput, TaskMerge, TaskRecord, TaskRun, TaskSession,
    },
    types::{RunStatus, TaskStatus},
};
use executors::ExecutorProfileId;
use git::BranchInfo;
use image::ImageService;
use log_types::LogEntry;
use serde::{Deserialize, Serialize};
use serde_json;
use skills::{apply_materialized_skills, SkillRegistry};
use sqlx::{Pool, Sqlite};
use tracing::{info, warn};
use uuid::Uuid;

use worktree::{generate_attempt_branch_name, worktree_dir_name, EnsureOptions};

use config::{chats_dir, render_merge_commit_template, DEFAULT_MERGE_COMMIT_TEMPLATE};

use crate::{
    execution::ExecutionStartParams,
    session_context::{apply_session_context, run_status_label, SessionContextDigest},
    Runtime, RuntimeError,
};

const FOLLOW_UP_MISSING_SESSION_ID_ERROR: &str =
    "cannot follow up because the previous executor session id is not available yet";
const FOLLOW_UP_RESUME_SESSION_RETRY_ATTEMPTS: usize = 10;
const FOLLOW_UP_RESUME_SESSION_RETRY_DELAY_MS: u64 = 200;

#[derive(Debug, Clone)]
pub struct MergeOutcome {
    pub merge_commit: String,
    pub target_branch: String,
}

#[derive(Debug, Clone)]
pub struct TaskRunBranchStatus {
    pub commits_ahead: Option<usize>,
    pub commits_behind: Option<usize>,
    pub target_branch: Option<String>,
    pub is_rebase_in_progress: bool,
    pub merges: Vec<TaskMerge>,
    pub conflicted_files: Vec<String>,
    pub conflict_op: Option<git::ConflictOp>,
}

#[derive(Debug, Clone)]
pub struct RebaseOutcome {
    pub new_base_branch: String,
}

/// Where a forked session does its work.
///
/// Only offered for git projects. General chats and non-git projects always
/// share the source directory, so the caller has nothing to choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkWorkspace {
    /// Keep working in the source's directory.
    Same,
    /// Cut a worktree from the anchor commit, so the branch can diverge without
    /// touching the source's files.
    NewWorktree,
}

#[derive(Debug, Clone)]
pub struct ForkOutcome {
    pub task: TaskRecord,
    /// Whether the conversation will be duplicated or degraded to a digest.
    /// Resolved at fork time so the UI can explain a degrade immediately.
    pub mode: ForkMode,
}

/// How a forked task picks up its source on its very first turn.
///
/// Decided when that turn starts (not at fork time) because it depends on the
/// executor the user chose for it: the same fork resumes natively for its
/// origin executor and degrades to a digest for a different one.
enum ForkStart {
    /// Resume the source session under a new id (`--fork-session` / rollout
    /// copy). Full context carries over live.
    Native { resume_session_id: String },
    /// Inline a digest of the source into the prompt. Used when the executor
    /// cannot duplicate the session, or it was switched, or the source ended
    /// resume-unsafe.
    Digest { source_task_id: Uuid },
}

#[derive(Debug, Clone)]
pub struct TaskRunWithTask {
    pub run: TaskRun,
    pub task: TaskRecord,
}

#[derive(Debug, Clone)]
pub struct TaskRunTaskProject {
    pub run: TaskRun,
    pub task: TaskRecord,
    pub project: ProjectRecord,
}

#[derive(Debug, Clone)]
pub struct ExecutionSessionStart {
    pub task_run: TaskRun,
    pub task: TaskRecord,
    pub project: ProjectRecord,
    pub executor_session_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct StartExecutionSessionParams {
    pub prompt: Option<String>,
    pub workspace_path: PathBuf,
    pub resume_session_id: Option<String>,
    pub force_new_attempt: Option<bool>,
    pub task_id: Option<Uuid>,
    pub executor_profile_id: Option<ExecutorProfileId>,
    pub image_ids: Option<Vec<Uuid>>,
    /// If false, skip worktree creation and work directly in workspace_path.
    /// Defaults to true for backward compatibility.
    pub use_worktree: Option<bool>,
    /// Base branch to create the worktree from.
    /// If None, falls back to the current branch of the workspace (then "main").
    pub target_branch: Option<String>,
    /// Skill IDs selected in the prompt editor. These are materialized into
    /// executor instructions while the stored user prompt remains unchanged.
    pub selected_skill_ids: Vec<String>,
    /// Semantic context references selected with the prompt. These are stored
    /// separately from rendered prompt tags so Chro can traverse provenance.
    pub context_refs: Vec<TaskContextRefInput>,
}

#[derive(Debug, Clone)]
pub struct StartExecutionProcessParams {
    pub run_reason: Option<String>,
    pub executor: Option<String>,
    pub resume_session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMessageMode {
    Auto,
    New,
}

impl Default for TaskMessageMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone)]
pub struct SendTaskMessageParams {
    pub task_id: Uuid,
    pub prompt: String,
    pub mode: TaskMessageMode,
    pub executor_profile_id: Option<ExecutorProfileId>,
    pub image_ids: Option<Vec<Uuid>>,
    pub use_worktree: Option<bool>,
    pub target_branch: Option<String>,
    pub selected_skill_ids: Vec<String>,
    pub context_refs: Vec<TaskContextRefInput>,
}

#[derive(Debug, Clone)]
pub struct TaskMessageStart {
    pub execution: ExecutionSessionStart,
    pub continued_existing_run: bool,
    pub previous_task_run_id: Option<Uuid>,
}

pub struct TaskService<'a, R: Runtime> {
    runtime: &'a R,
    pool: &'a Pool<Sqlite>,
}

impl<'a, R: Runtime> TaskService<'a, R> {
    pub fn new(runtime: &'a R) -> Self {
        Self {
            runtime,
            pool: runtime.db().pool(),
        }
    }

    pub fn runtime(&self) -> &'a R {
        self.runtime
    }

    pub fn pool(&self) -> &'a Pool<Sqlite> {
        self.pool
    }

    fn lifecycle(&self) -> TaskLifecycle<'a> {
        TaskLifecycle::new(self.pool())
    }

    async fn validate_context_refs_for_project(
        &self,
        project_id: Uuid,
        refs: &[TaskContextRefInput],
    ) -> Result<(), RuntimeError> {
        for context_ref in refs {
            if let Some(target_task_id) = context_ref.target_task_id {
                let target = TaskRecord::get(self.pool(), target_task_id).await?;
                if target.project_id != project_id {
                    return Err(RuntimeError::BadRequest(
                        "context ref target task does not belong to the project",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Resolve `kind = "session"` refs into digests for prompt materialization.
    /// Best-effort: any per-ref failure degrades that digest to header-only and
    /// must never block starting the run.
    async fn collect_session_context_digests(
        &self,
        context_refs: &[TaskContextRefInput],
    ) -> Vec<SessionContextDigest> {
        let mut seen: HashSet<Uuid> = HashSet::new();
        let mut digests = Vec::new();
        for context_ref in context_refs {
            if context_ref.kind != "session" {
                continue;
            }
            let Some(target_task_id) = context_ref.target_task_id else {
                continue;
            };
            if !seen.insert(target_task_id) {
                continue;
            }
            digests.push(
                self.session_context_digest(target_task_id, context_ref.branch.clone())
                    .await,
            );
        }
        digests
    }

    async fn session_context_digest(
        &self,
        target_task_id: Uuid,
        ref_branch: Option<String>,
    ) -> SessionContextDigest {
        let mut digest = SessionContextDigest {
            task_id: target_task_id.to_string(),
            title: format!("Task {target_task_id}"),
            branch: ref_branch,
            ..Default::default()
        };

        match TaskRecord::get(self.pool(), target_task_id).await {
            Ok(task) => digest.title = task.title,
            Err(err) => {
                warn!(
                    target_task_id = %target_task_id,
                    error = %err,
                    "session context ref target task not found; emitting pointer-only digest"
                );
                return digest;
            }
        }

        match TaskRun::list_by_task_id(self.pool(), target_task_id).await {
            Ok(runs) => {
                if let Some(latest) = runs.first() {
                    digest.status = Some(run_status_label(latest.status).to_string());
                    if digest.branch.is_none() {
                        digest.branch = latest.branch_name.clone();
                    }
                }
            }
            Err(err) => warn!(
                target_task_id = %target_task_id,
                error = %err,
                "failed to load runs for session context digest"
            ),
        }

        match self.runtime().task_last_exchange(target_task_id).await {
            Ok(exchange) => {
                digest.last_user = exchange.user;
                digest.last_assistant = exchange.assistant;
            }
            Err(err) => warn!(
                target_task_id = %target_task_id,
                error = %err,
                "failed to load last exchange for session context digest"
            ),
        }

        digest
    }

    pub async fn create_task(
        &self,
        project_id: Uuid,
        title: Option<String>,
        description: Option<String>,
        prompt: Option<String>,
        context_refs: Vec<TaskContextRefInput>,
    ) -> Result<TaskRecord, RuntimeError> {
        let prompt = normalize_optional_text(prompt);
        let title = normalize_optional_text(title)
            .or_else(|| prompt.as_deref().map(infer_task_title))
            .ok_or(RuntimeError::BadRequest("title or prompt is required"))?;
        let description = normalize_optional_text(description)
            .or_else(|| prompt.as_deref().and_then(infer_task_description));
        self.validate_context_refs_for_project(project_id, &context_refs)
            .await?;
        let task = TaskRecord::new_with_prompt(project_id, title, description, prompt);
        task.insert(self.pool()).await?;
        if !context_refs.is_empty() {
            TaskContextRef::replace_for_task_scope(self.pool(), task.id, None, None, &context_refs)
                .await?;
        }
        Ok(task)
    }

    /// Branch a session at an anchor run into a new task.
    ///
    /// Fork is a lifecycle operation, not one of the inter-session verbs: it
    /// delivers no payload and wakes nobody. Only its provenance lands on the
    /// relation graph, as a single `fork` edge.
    ///
    /// The new task is created idle. Whoever forked writes the first turn; the
    /// executor's own duplication (`--fork-session` / rollout copy) happens then,
    /// driven by `fork_source` on the session row.
    pub async fn fork_task(
        &self,
        anchor_run_id: Uuid,
        workspace: ForkWorkspace,
    ) -> Result<ForkOutcome, RuntimeError> {
        let anchor_run = TaskRun::get(self.pool(), anchor_run_id).await?;
        let source_task = TaskRecord::get(self.pool(), anchor_run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), source_task.project_id).await?;

        if matches!(anchor_run.status, RunStatus::Running | RunStatus::Pending) {
            return Err(RuntimeError::BadRequest(
                "cannot fork a run that is still executing",
            ));
        }

        // A new worktree needs a commit to branch from, and a git repo to put it
        // in. General chats and non-git projects have neither: they fork the
        // conversation and keep sharing the directory.
        let repo_path = PathBuf::from(&project.git_repo_path);
        let is_git = self.runtime().git().is_repository(&repo_path);
        let workspace = match workspace {
            ForkWorkspace::NewWorktree if !is_git => {
                return Err(RuntimeError::BadRequest(
                    "a git repository is required to continue in a new worktree",
                ))
            }
            other => other,
        };

        // Resolve the code anchor: the exact state the source ended on. The run
        // ledger (after→before) is the durable record; the source branch tip is
        // the same state by another name, covering runs whose ledger predates
        // boundary recording. Whichever still resolves is a real commit that
        // survives the source's worktree being reclaimed — never HEAD, which is
        // the project's default branch (main) and has nothing to do with this
        // session.
        let anchor_commit: Option<String> = if is_git {
            [
                anchor_run.after_head_commit.clone(),
                anchor_run.before_head_commit.clone(),
                anchor_run.branch_name.clone(),
                source_task.branch.clone(),
            ]
            .into_iter()
            .flatten()
            .find_map(|rev| self.runtime().git().resolve_commit_sha(&repo_path, &rev))
        } else {
            None
        };

        // A git session whose anchor no longer resolves (worktree reclaimed and
        // no commit or branch survived) has no honest point to continue from.
        // Refuse rather than silently branching from main.
        if is_git && anchor_commit.is_none() {
            return Err(RuntimeError::BadRequest(
                "this session's checkpoint is gone (its branch and commits were reclaimed); it can no longer be continued",
            ));
        }

        let mode = self.resolve_fork_mode(&anchor_run).await;
        let title = fork_title(&source_task.title);
        let task = TaskRecord::new_with_prompt(source_task.project_id, title, None, None);
        task.insert(self.pool()).await?;

        // "Same" keeps working in the source's live worktree only while it
        // actually exists; the reclaimed case falls through to cutting a fresh
        // worktree from the anchor, so a fork never runs in the project root.
        let reuse_dir = matches!(workspace, ForkWorkspace::Same)
            .then(|| source_task.worktree_path.clone())
            .flatten()
            .filter(|path| Path::new(path).is_dir());

        // Provision the fork's workspace now, so its first turn adopts it
        // instead of cutting a fresh worktree from the target branch (which
        // would silently discard the anchor).
        match reuse_dir {
            Some(shared_dir) if is_git => {
                // Continue in the source's own worktree, on its branch.
                TaskRecord::update_worktree_state(self.pool(), task.id, Some(shared_dir), false, true)
                    .await?;
                TaskRecord::update_branch(self.pool(), task.id, source_task.branch.clone()).await?;
            }
            _ if is_git => {
                // NewWorktree, or a Same whose worktree is gone: cut a fresh
                // worktree from the resolved anchor commit.
                let anchor_commit = anchor_commit
                    .as_deref()
                    .expect("anchor_commit is Some for git forks (refused above otherwise)");
                let branch_name = generate_attempt_branch_name(&task.title, &task.id.to_string());
                self.runtime().git().ensure_branch_exists_at_commit(
                    &repo_path,
                    &branch_name,
                    anchor_commit,
                )?;
                let handle = self
                    .runtime()
                    .worktree()
                    .ensure_worktree(&repo_path, EnsureOptions::new(&branch_name))
                    .await?;
                TaskRecord::update_worktree_state(
                    self.pool(),
                    task.id,
                    Some(handle.path.to_string_lossy().into_owned()),
                    false,
                    true,
                )
                .await?;
                TaskRecord::update_branch(self.pool(), task.id, Some(branch_name)).await?;
            }
            _ => {
                // Non-git / General scratch: no branch to diverge, no main to
                // fly off to. Share the source's directory (or the project root
                // when it has none).
                let shared_dir = source_task
                    .worktree_path
                    .clone()
                    .filter(|path| Path::new(path).is_dir())
                    .unwrap_or_else(|| project.git_repo_path.clone());
                TaskRecord::update_worktree_state(self.pool(), task.id, Some(shared_dir), false, true)
                    .await?;
                TaskRecord::update_branch(self.pool(), task.id, source_task.branch.clone()).await?;
            }
        }

        let anchor = ForkAnchor {
            run_id: anchor_run.id,
            message_uuid: None,
            // The resolved anchor for git forks (survives worktree deletion);
            // None for non-git/scratch, which have no commit.
            commit: anchor_commit.clone(),
        };
        let source_session_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM task_sessions WHERE task_run_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(anchor_run.id)
        .fetch_optional(self.pool())
        .await?;

        let mut refs = vec![TaskContextRefInput::fork(
            source_task.id,
            source_session_id,
            mode,
            anchor,
            Some(source_task.title.clone()),
        )];
        // Carry the source's read context forward: a fork continues the same
        // work, so the files and sessions it was told to look at still apply.
        refs.extend(
            TaskContextRef::list_by_task_id(self.pool(), source_task.id)
                .await?
                .into_iter()
                .filter(|existing| !db::models::is_broker_authored_kind(&existing.kind))
                .map(|existing| TaskContextRefInput {
                    kind: existing.kind,
                    target_task_id: existing.target_task_id,
                    target_session_id: existing.target_session_id,
                    path: existing.path,
                    branch: existing.branch,
                    mode: Some(existing.mode),
                    label: existing.label,
                    metadata_json: existing.metadata_json,
                }),
        );

        for (index, input) in refs.iter().enumerate() {
            TaskContextRef::insert_for_task(self.pool(), task.id, None, None, input, index as i32)
                .await?;
        }

        info!(
            task_id = %task.id,
            source_task_id = %source_task.id,
            anchor_run_id = %anchor_run.id,
            mode = mode.as_str(),
            workspace = ?workspace,
            "forked session"
        );

        Ok(ForkOutcome { task, mode })
    }

    /// Fork a task from its most recent finished run.
    ///
    /// The session-list entry point has no anchor to offer, so "latest" is the
    /// only sensible one; picking an earlier point is what the conversation
    /// entry point is for.
    pub async fn fork_task_latest(
        &self,
        task_id: Uuid,
        workspace: ForkWorkspace,
    ) -> Result<ForkOutcome, RuntimeError> {
        let anchor_run_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM task_runs \
             WHERE task_id = ? AND status NOT IN ('running', 'pending') AND dropped = 0 \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(task_id)
        .fetch_optional(self.pool())
        .await?
        .ok_or(RuntimeError::BadRequest(
            "this session has no finished run to continue from",
        ))?;
        self.fork_task(anchor_run_id, workspace).await
    }

    /// How a forked task should pick up its source on its first turn.
    ///
    /// Returns None once the task has run at least once (the branch already
    /// exists, so later turns resume normally) or when the task was not forked.
    async fn resolve_fork_start(
        &self,
        task: &TaskRecord,
        executor: &ExecutorProfileId,
    ) -> Option<ForkStart> {
        let already_ran: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_runs WHERE task_id = ?")
            .bind(task.id)
            .fetch_one(self.pool())
            .await
            .unwrap_or(1);
        if already_ran > 1 {
            return None;
        }

        let edge = TaskContextRef::list_by_task_id(self.pool(), task.id)
            .await
            .ok()?
            .into_iter()
            .find(|r| r.kind == "fork")?;
        let anchor: ForkAnchor = serde_json::from_str(edge.metadata_json.as_deref()?).ok()?;
        let anchor_run = TaskRun::get(self.pool(), anchor.run_id).await.ok()?;
        // Whatever happens below, the source's work must reach the new session:
        // falling back to a digest is a downgrade, never a fresh start.
        let digest = ForkStart::Digest {
            source_task_id: anchor_run.task_id,
        };

        if edge.mode != ForkMode::Native.as_str() {
            return Some(digest);
        }

        // Resume ids are executor-specific: a claude session id means nothing to
        // codex, which would reject it as an unknown thread. Switching executor
        // on the fork's first turn is a legitimate thing to do, so it degrades to
        // a digest handoff rather than failing.
        if !run_targets_executor(&anchor_run, executor) {
            info!(
                task_id = %task.id,
                anchor_run_id = %anchor.run_id,
                executor = %executor.executor,
                "fork switched executor; carrying a digest instead of duplicating the session"
            );
            return Some(digest);
        }

        match self
            .resolve_resume_session_id_for_follow_up(&anchor_run)
            .await
        {
            Ok(Some(resume_session_id)) => Some(ForkStart::Native { resume_session_id }),
            Ok(None) => Some(digest),
            Err(err) => {
                warn!(
                    task_id = %task.id,
                    anchor_run_id = %anchor.run_id,
                    error = %err,
                    "fork source session could not be resolved; carrying a digest instead"
                );
                Some(digest)
            }
        }
    }

    /// Pick how the fork inherits its conversation.
    ///
    /// Duplicating a session whose last turn died on an API error or a
    /// malformed tool call carries the poison into the copy, so those degrade to
    /// a digest handoff instead.
    async fn resolve_fork_mode(&self, anchor_run: &TaskRun) -> ForkMode {
        if matches!(anchor_run.status, RunStatus::Failed) {
            return ForkMode::Digest;
        }
        match self
            .resolve_resume_session_id_for_follow_up(anchor_run)
            .await
        {
            Ok(Some(_)) => ForkMode::Native,
            Ok(None) => ForkMode::Digest,
            Err(err) => {
                warn!(
                    task_run_id = %anchor_run.id,
                    error = %err,
                    "failed to resolve session id for fork; falling back to digest"
                );
                ForkMode::Digest
            }
        }
    }

    /// Spawn a new session to carry a piece of another session's work.
    ///
    /// Delegation is the request half of the lifecycle-communication backbone:
    /// the delegating task rides into the child's boot prompt as a digest (the
    /// only guaranteed first delivery), a broker-authored `delegate` edge
    /// records the provenance, and the child starts running immediately. The
    /// response half is [`Self::settle_delegation_handoff`], which fires when a
    /// child run completes.
    pub async fn delegate_task(
        &self,
        source_task_id: Uuid,
        prompt: String,
        executor_profile_id: Option<ExecutorProfileId>,
    ) -> Result<TaskRecord, RuntimeError> {
        let prompt = normalize_optional_text(Some(prompt))
            .ok_or(RuntimeError::BadRequest("prompt is required"))?;
        let source_task = TaskRecord::get(self.pool(), source_task_id).await?;
        let project = ProjectRecord::get(self.pool(), source_task.project_id).await?;

        let title = infer_task_title(&prompt);
        let description = infer_task_description(&prompt);
        let task = TaskRecord::new_with_prompt(
            source_task.project_id,
            title,
            description,
            Some(prompt.clone()),
        );
        task.insert(self.pool()).await?;

        TaskContextRef::insert_for_task(
            self.pool(),
            task.id,
            None,
            None,
            &TaskContextRefInput::delegate(source_task.id, Some(source_task.title.clone())),
            0,
        )
        .await?;

        // The child branches from wherever the delegating task currently
        // works: its digest describes that state, so a worktree cut from the
        // project's default branch would contradict what the prompt says.
        let target_branch = source_task.branch.clone();

        let start = self
            .start_execution_session(StartExecutionSessionParams {
                prompt: Some(prompt),
                workspace_path: PathBuf::from(&project.git_repo_path),
                resume_session_id: None,
                force_new_attempt: Some(false),
                task_id: Some(task.id),
                executor_profile_id,
                image_ids: None,
                use_worktree: None,
                target_branch,
                selected_skill_ids: Vec::new(),
                // Spawn-time push: the delegating session rides in as a
                // session ref so the shared digest materialization inlines it
                // into the boot prompt.
                context_refs: vec![TaskContextRefInput::session(
                    source_task.id,
                    source_task.branch.clone(),
                )],
            })
            .await?;

        info!(
            task_id = %task.id,
            source_task_id = %source_task.id,
            task_run_id = %start.task_run.id,
            "delegated work to a new session"
        );

        Ok(TaskRecord::get(self.pool(), task.id).await?)
    }

    /// Close the delegation loop for a finished run: record the handoff on the
    /// delegating task, then run the barrier check.
    ///
    /// The broker calls this after every run completion (post auto-commit, so
    /// the packet can carry the commit). Runs of tasks that were never
    /// delegated settle nothing. Runs that did not complete successfully write
    /// no handoff — but they still count toward the barrier, so a failed
    /// sibling never blocks the wake forever.
    pub async fn settle_delegation_handoff(&self, run_id: Uuid) -> Result<(), RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;
        let child = TaskRecord::get(self.pool(), run.task_id).await?;
        let Some(edge) = TaskContextRef::list_by_task_id(self.pool(), child.id)
            .await?
            .into_iter()
            .find(|r| r.kind == "delegate")
        else {
            return Ok(());
        };
        let Some(parent_task_id) = edge.target_task_id else {
            return Ok(());
        };
        let parent = match TaskRecord::get(self.pool(), parent_task_id).await {
            Ok(parent) => parent,
            Err(err) => {
                warn!(
                    child_task_id = %child.id,
                    parent_task_id = %parent_task_id,
                    error = %err,
                    "delegating task is gone; dropping the handoff"
                );
                return Ok(());
            }
        };

        if run.status == RunStatus::Completed {
            // Completion can be retried (crash between edge and wake, repeated
            // finalizers); one child run must never hand off twice.
            let already_settled = TaskContextRef::list_by_task_id(self.pool(), parent.id)
                .await?
                .into_iter()
                .filter(|r| r.kind == "handoff")
                .filter_map(|r| r.metadata_json)
                .filter_map(|json| serde_json::from_str::<HandoffInfo>(&json).ok())
                .any(|info| info.run_id == run.id);
            if !already_settled {
                // The commit the child's work landed on. Read from the run
                // ledger (recorded at completion), which survives worktree
                // deletion; the workspace HEAD does not. None for non-git
                // workspaces (General chats).
                let commit = run.after_head_commit.clone();
                let info = HandoffInfo {
                    run_id: run.id,
                    commit,
                    branch: run.branch_name.clone(),
                    delivered: false,
                };
                TaskContextRef::insert_for_task(
                    self.pool(),
                    parent.id,
                    None,
                    None,
                    &TaskContextRefInput::handoff(child.id, info, Some(child.title.clone())),
                    0,
                )
                .await?;
            }
        }

        self.try_delegation_barrier_wake(&parent).await
    }

    /// Wake the delegating session once — when every task it delegated has
    /// reached a terminal state.
    ///
    /// One wake per barrier, not per child: the undelivered handoffs
    /// accumulate as edges and ship together in a single packet, which is then
    /// marked delivered. Skipped while the delegating session is mid-turn; the
    /// undelivered edges keep the results safe, and the next settlement (or
    /// barrier re-check) delivers them.
    async fn try_delegation_barrier_wake(&self, parent: &TaskRecord) -> Result<(), RuntimeError> {
        // The barrier: every delegate edge pointing at this parent belongs to
        // a child that is no longer running.
        let child_task_ids: Vec<Uuid> = TaskContextRef::list_referencing_task_id(self.pool(), parent.id)
            .await?
            .into_iter()
            .filter(|r| r.kind == "delegate")
            .map(|r| r.task_id)
            .collect();
        for child_task_id in &child_task_ids {
            let active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM task_runs \
                 WHERE task_id = ? AND status IN ('running', 'pending') AND dropped = 0",
            )
            .bind(child_task_id)
            .fetch_one(self.pool())
            .await?;
            if active > 0 {
                info!(
                    parent_task_id = %parent.id,
                    waiting_on = %child_task_id,
                    "delegation barrier not met; handoff recorded without a wake"
                );
                return Ok(());
            }
        }

        let undelivered: Vec<(TaskContextRef, HandoffInfo)> =
            TaskContextRef::list_by_task_id(self.pool(), parent.id)
                .await?
                .into_iter()
                .filter(|r| r.kind == "handoff")
                .filter_map(|r| {
                    let info: HandoffInfo = serde_json::from_str(r.metadata_json.as_deref()?).ok()?;
                    (!info.delivered).then_some((r, info))
                })
                .collect();
        if undelivered.is_empty() {
            return Ok(());
        }

        let busy: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM task_runs \
             WHERE task_id = ? AND status IN ('running', 'pending') AND dropped = 0",
        )
        .bind(parent.id)
        .fetch_one(self.pool())
        .await?;
        if busy > 0 {
            info!(
                parent_task_id = %parent.id,
                pending_handoffs = undelivered.len(),
                "delegating session is mid-turn; barrier wake deferred"
            );
            return Ok(());
        }

        let mut packets = Vec::with_capacity(undelivered.len());
        for (edge, info) in &undelivered {
            let child_title = edge.label.clone().unwrap_or_else(|| {
                edge.target_task_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "delegated task".to_string())
            });
            let summary = match edge.target_task_id {
                Some(child_task_id) => self
                    .runtime()
                    .task_last_exchange(child_task_id)
                    .await
                    .ok()
                    .and_then(|exchange| exchange.assistant)
                    .filter(|text| !text.trim().is_empty()),
                None => None,
            };
            let workspace_path: Option<String> = sqlx::query_scalar(
                "SELECT workspace_path FROM task_runs WHERE id = ?",
            )
            .bind(info.run_id)
            .fetch_optional(self.pool())
            .await?
            .flatten();
            packets.push(build_handoff_packet(
                &child_title,
                info.branch.as_deref(),
                workspace_path.as_deref(),
                info.commit.as_deref(),
                summary.as_deref(),
            ));
        }
        // Failed children produced no handoff; the delegating session must
        // still learn they are done, or it would reason as if work were
        // pending.
        for child_task_id in &child_task_ids {
            if let Ok(child) = TaskRecord::get(self.pool(), *child_task_id).await {
                if child.status == db::types::TaskStatus::Failed {
                    packets.push(format!(
                        "Task \"{}\" failed and produced no result. Inspect its session if its work is still needed.",
                        child.title
                    ));
                }
            }
        }

        let wake_prompt = build_barrier_wake_prompt(&packets);
        if let Err(err) = self.follow_up_by_task(parent.id, wake_prompt).await {
            warn!(
                parent_task_id = %parent.id,
                error = %err,
                "delegation barrier wake failed; handoffs stay undelivered"
            );
            return Ok(());
        }
        for (edge, info) in undelivered {
            let delivered = HandoffInfo {
                delivered: true,
                ..info
            };
            TaskContextRef::update_metadata(
                self.pool(),
                edge.id,
                serde_json::to_string(&delivered).ok(),
            )
            .await?;
        }
        info!(
            parent_task_id = %parent.id,
            "delegation barrier met; woke the delegating session"
        );
        Ok(())
    }

    pub async fn reorder_tasks(&self, updates: &[(Uuid, i32)]) -> Result<(), RuntimeError> {
        TaskRecord::reorder(self.pool(), updates).await?;
        Ok(())
    }

    pub async fn delete_task(&self, task_id: Uuid) -> Result<(), RuntimeError> {
        let task = TaskRecord::get(self.pool(), task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;
        let runs = TaskRun::list_by_task_id(self.pool(), task.id).await?;
        let mut worktree_paths = HashSet::new();

        for run in &runs {
            if let Some(workspace_path) = run.workspace_path.as_ref() {
                worktree_paths.insert(PathBuf::from(workspace_path));
            }

            if matches!(run.status, RunStatus::Running | RunStatus::Pending) {
                if let Err(err) = self.runtime().cancel_execution(run.id).await {
                    warn!(
                        task_run_id = %run.id,
                        task_id = %task.id,
                        error = ?err,
                        "failed to cancel running execution before delete",
                    );
                }
            }
        }

        TaskRecord::delete(self.pool(), task.id).await?;

        for run in &runs {
            if let Err(err) = self.runtime().cleanup_task_run_artifacts(run.id).await {
                warn!(
                    task_run_id = %run.id,
                    task_id = %task.id,
                    error = ?err,
                    "failed to cleanup task run artifacts after delete",
                );
            }
        }

        for worktree_path in worktree_paths {
            if let Err(err) = self
                .runtime()
                .worktree()
                .cleanup_worktree(&worktree_path, Some(Path::new(&project.git_repo_path)))
                .await
            {
                warn!(
                    task_id = %task.id,
                    path = %worktree_path.display(),
                    error = ?err,
                    "failed to cleanup worktree after task delete",
                );
            }
        }

        if let Err(err) = self.runtime().image().delete_orphaned_images().await {
            warn!(
                task_id = %task.id,
                error = ?err,
                "failed to cleanup orphaned images after task delete",
            );
        }

        Ok(())
    }

    pub async fn update_task_status(
        &self,
        task_id: Uuid,
        status: TaskStatus,
    ) -> Result<TaskRecord, RuntimeError> {
        TaskRecord::update_status(self.pool(), task_id, status).await?;
        let task = TaskRecord::get(self.pool(), task_id).await?;
        Ok(task)
    }

    pub async fn update_task_title(
        &self,
        task_id: Uuid,
        title: String,
    ) -> Result<TaskRecord, RuntimeError> {
        let existing = TaskRecord::get(self.pool(), task_id).await?;
        let prompt = if existing.prompt_matches_legacy() {
            let mut updated = existing.clone();
            updated.title = title.clone();
            updated.legacy_prompt()
        } else {
            None
        };
        TaskRecord::update_title(self.pool(), task_id, title, prompt).await?;
        let task = TaskRecord::get(self.pool(), task_id).await?;
        Ok(task)
    }

    pub async fn create_task_run(
        &self,
        task_id: Uuid,
        executor: Option<String>,
    ) -> Result<TaskRun, RuntimeError> {
        let mut run = TaskRun::new_local(task_id, Some("desktop".to_string()));
        run.executor_label = executor.clone();
        run.executor_action = executor;
        run.insert(self.pool()).await?;
        Ok(run)
    }

    pub async fn update_task_run_git(
        &self,
        run_id: Uuid,
        branch: Option<String>,
        target_branch: Option<String>,
        container_ref: Option<String>,
        workspace_path: Option<String>,
    ) -> Result<TaskRun, RuntimeError> {
        sqlx::query(
            "UPDATE task_runs SET branch_name = COALESCE(?, branch_name), target_branch = COALESCE(?, target_branch), container_ref = COALESCE(?, container_ref), workspace_path = COALESCE(?, workspace_path), worktree_deleted = CASE WHEN ? IS NOT NULL THEN 0 ELSE worktree_deleted END, updated_at = ? WHERE id = ?",
        )
        .bind(branch.clone())
        .bind(target_branch.clone())
        .bind(container_ref.clone())
        .bind(workspace_path.clone())
        .bind(container_ref.clone())
        .bind(Utc::now())
        .bind(run_id)
        .execute(self.pool())
        .await?;

        let run = TaskRun::get(self.pool(), run_id).await?;
        TaskRecord::update_worktree_state(
            self.pool(),
            run.task_id,
            run.workspace_path.clone(),
            run.worktree_deleted,
            true,
        )
        .await?;
        TaskRecord::update_branch(self.pool(), run.task_id, run.branch_name.clone()).await?;
        Ok(run)
    }

    pub async fn list_task_runs(&self, task_id: Uuid) -> Result<Vec<TaskRun>, RuntimeError> {
        let runs = TaskRun::list_by_task_id(self.pool(), task_id).await?;
        Ok(runs)
    }

    pub async fn latest_active_run(
        &self,
        project_id: Uuid,
    ) -> Result<TaskRunWithTask, RuntimeError> {
        let run = TaskRun::latest_for_project(self.pool(), project_id)
            .await?
            .ok_or(RuntimeError::NotFound("active run not found"))?;
        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        Ok(TaskRunWithTask { run, task })
    }

    pub async fn fetch_run_task_project(
        &self,
        run_id: Uuid,
    ) -> Result<TaskRunTaskProject, RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;
        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;
        Ok(TaskRunTaskProject { run, task, project })
    }

    pub async fn start_execution_process(
        &self,
        run_id: Uuid,
        params: StartExecutionProcessParams,
    ) -> Result<TaskRun, RuntimeError> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE task_runs SET status = ?, run_reason = ?, executor_action = COALESCE(?, executor_action), executor_action_type = 'desktop', resume_session_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
        )
        .bind(RunStatus::Running)
        .bind(params.run_reason.clone())
        .bind(params.executor.clone())
        .bind(params.resume_session_id.clone())
        .bind(now)
        .bind(now)
        .bind(run_id)
        .execute(self.pool())
        .await?;

        let run = TaskRun::get(self.pool(), run_id).await?;
        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        self.lifecycle().mark_in_progress(&task).await?;
        Ok(run)
    }

    pub async fn start_execution_session(
        &self,
        params: StartExecutionSessionParams,
    ) -> Result<ExecutionSessionStart, RuntimeError> {
        let StartExecutionSessionParams {
            prompt,
            workspace_path,
            resume_session_id,
            force_new_attempt,
            task_id,
            executor_profile_id,
            image_ids,
            use_worktree,
            target_branch,
            selected_skill_ids,
            context_refs,
        } = params;

        info!(
            prompt = prompt.as_deref().unwrap_or_default(),
            workspace_path = %workspace_path.display(),
            resume_session_id = ?resume_session_id,
            force_new_attempt = ?force_new_attempt,
            task_id = ?task_id,
            "[TaskService::start_execution_session] received request"
        );

        let executor_profile = match executor_profile_id {
            Some(profile) => profile,
            None => {
                let config = self.runtime().config().read().await;
                config.executor_profile.clone()
            }
        };
        let executor_label = serde_json::to_string(&executor_profile)
            .unwrap_or_else(|_| executor_profile.executor.to_string());

        let provided_prompt = prompt.as_ref().and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(value.clone())
            }
        });

        if provided_prompt.is_none() && task_id.is_none() {
            return Err(RuntimeError::BadRequest("prompt is required"));
        }

        if !workspace_path.exists() {
            return Err(RuntimeError::BadRequest("workspace path is invalid"));
        }

        let is_git_repository = {
            let git = self.runtime().git().clone();
            let path = workspace_path.clone();
            tokio::task::spawn_blocking(move || git.is_repository(&path))
                .await
                .map_err(|e| {
                    RuntimeError::Other(anyhow::anyhow!("git is-repository task failed: {e}"))
                })?
        };
        let use_worktree = resolve_use_worktree_mode(is_git_repository, use_worktree);

        let repo_path = workspace_path.clone();
        let repo_path_str = repo_path.to_string_lossy().into_owned();
        // A general-purpose ("scratch") chat runs under the shared chats root
        // rather than a real repo: one hidden "General" project keyed on this
        // path, with each chat isolated in its own per-task subfolder.
        let is_scratch_chat = repo_path == chats_dir();
        let project =
            ProjectRecord::ensure_with_name_hint(self.pool(), &repo_path_str, None).await?;
        self.validate_context_refs_for_project(project.id, &context_refs)
            .await?;

        let requested_task = if let Some(task_id) = task_id {
            let task = TaskRecord::get(self.pool(), task_id).await?;
            if task.project_id != project.id {
                return Err(RuntimeError::BadRequest(
                    "task does not belong to the workspace",
                ));
            }
            Some(task)
        } else {
            None
        };

        let mut reuse_run: Option<TaskRun> = None;
        if force_new_attempt != Some(true) {
            if let Some(ref session_id) = resume_session_id {
                if let Some(existing_run_id) =
                    TaskSession::latest_run_id_by_external_session(self.pool(), session_id).await?
                {
                    reuse_run = Some(TaskRun::get(self.pool(), existing_run_id).await?);
                }
            }
        }

        let (task, run, reused_existing_run) = if let Some(existing) = reuse_run {
            let task = if let Some(task) = &requested_task {
                if task.id == existing.task_id {
                    task.clone()
                } else {
                    TaskRecord::get(self.pool(), existing.task_id).await?
                }
            } else {
                TaskRecord::get(self.pool(), existing.task_id).await?
            };
            if task.project_id != project.id {
                return Err(RuntimeError::BadRequest(
                    "execution run does not belong to the workspace",
                ));
            }
            (task, existing, true)
        } else if let Some(task) = requested_task {
            let mut run = TaskRun::new_local(task.id, Some("codingagent".into()));
            run.executor_label = Some(executor_label.clone());
            run.insert(self.pool()).await?;
            (task, run, false)
        } else {
            let prompt_text = provided_prompt.clone().unwrap_or_default();
            let title = infer_task_title(&prompt_text);
            let description = infer_task_description(&prompt_text);
            let task =
                TaskRecord::new_with_prompt(project.id, title, description, Some(prompt_text));
            task.insert(self.pool()).await?;
            let mut run = TaskRun::new_local(task.id, Some("codingagent".into()));
            run.executor_label = Some(executor_label.clone());
            run.insert(self.pool()).await?;
            (task, run, false)
        };

        // Cache the agent this task ran with so the session tab can show its
        // logo. Stored as the bare agent kind ("CLAUDE_CODE" / "CODEX").
        TaskRecord::set_last_executor(self.pool(), task.id, &executor_profile.executor.to_string())
            .await?;

        if reused_existing_run {
            let execution_prompt = provided_prompt.clone().unwrap_or_else(|| task.to_prompt());
            if execution_prompt.trim().is_empty() {
                return Err(RuntimeError::BadRequest("prompt is required"));
            }

            return self
                .follow_up_execution_with_options(
                    run.id,
                    execution_prompt,
                    None,
                    selected_skill_ids,
                    context_refs,
                    Some(executor_profile.clone()),
                )
                .await;
        }

        // Everything past this point provisions a run row that already exists
        // (worktree creation, session insert, executor spawn). If any step
        // fails, the run must still reach a terminal state: a run left Pending
        // here is a zombie session with no executor, no logs, and an
        // in-progress task that survives restarts.
        let run_id = run.id;
        let owning_task_id = task.id;
        let provision: Result<ExecutionSessionStart, RuntimeError> = async {
        self.lifecycle().mark_in_progress(&task).await?;

        let execution_prompt = provided_prompt.unwrap_or_else(|| task.to_prompt());
        if execution_prompt.trim().is_empty() {
            return Err(RuntimeError::BadRequest("prompt is required"));
        }

        if let Some(ids) = image_ids.as_ref().filter(|items| !items.is_empty()) {
            if let Err(err) = self
                .runtime()
                .image()
                .link_images_to_task(task.id, ids)
                .await
            {
                warn!(
                    task_id = %task.id,
                    error = %err,
                    "failed to link uploaded images to task"
                );
            }
        }

        let (branch_name, target_branch, is_new_branch) = if is_git_repository {
            let resolved_target_branch = if let Some(specified) = target_branch {
                Some(specified)
            } else {
                Some(
                    self.runtime()
                        .git()
                        .get_current_branch(&repo_path)
                        .unwrap_or_else(|_| "main".to_string()),
                )
            };

            let resolved_branch_name = if let Some(ref existing) = run.branch_name {
                Some(existing.clone())
            } else {
                Some(generate_attempt_branch_name(
                    &task.title,
                    &run.id.to_string(),
                ))
            };

            let is_new_branch = run.branch_name.is_none();
            (resolved_branch_name, resolved_target_branch, is_new_branch)
        } else {
            (None, None, false)
        };

        // A task can arrive here with its workspace already provisioned: a fork
        // prepares the directory (and branch) at fork time so the anchor
        // survives. Adopt it instead of cutting a fresh worktree from the
        // target branch.
        let adopted_workspace = task
            .worktree_path
            .clone()
            .filter(|_| run.branch_name.is_none())
            .filter(|path| Path::new(path).is_dir());

        // The adopted workspace comes with the task's own branch (the fork
        // branch, or the shared source branch): the generated attempt branch
        // must not leak into the run row or clobber `task.branch`.
        let branch_name = if adopted_workspace.is_some() {
            task.branch.clone()
        } else {
            branch_name
        };

        let (worktree_path, container_ref) = if let Some(adopted) = adopted_workspace {
            info!(
                task_id = %task.id,
                workspace = %adopted,
                "adopting the task's pre-provisioned workspace"
            );
            (PathBuf::from(&adopted), adopted)
        } else if use_worktree {
            let branch_name = branch_name.as_deref().ok_or(RuntimeError::BadRequest(
                "branch name is required for worktree execution",
            ))?;
            let target_branch = target_branch.as_deref().ok_or(RuntimeError::BadRequest(
                "target branch is required for worktree execution",
            ))?;
            let mut ensure_options =
                EnsureOptions::new(branch_name).with_base_branch(target_branch);
            if is_new_branch {
                ensure_options = ensure_options.create_branch();
            }

            let worktree_handle = self
                .runtime()
                .worktree()
                .ensure_worktree(&repo_path, ensure_options)
                .await?;
            let path = worktree_handle.path.clone();
            let container = path.to_string_lossy().to_string();
            (path, container)
        } else if is_scratch_chat {
            // Isolate each scratch chat in its own per-task subfolder so chats
            // never collide on disk, while all of them stay under the single
            // hidden "General" project keyed on the chats root.
            let path = scratch_chat_dir(&workspace_path, &task.title, &task.id.to_string());
            std::fs::create_dir_all(&path).map_err(|e| {
                RuntimeError::Other(anyhow::anyhow!("failed to create scratch chat dir: {e}"))
            })?;
            let container = path.to_string_lossy().to_string();
            (path, container)
        } else {
            let path = workspace_path.clone();
            let container = path.to_string_lossy().to_string();
            (path, container)
        };

        // Resolve how a forked task's first turn picks up its source before the
        // prompt is built: a digest handoff has to be inlined into that prompt,
        // and that only works if it is decided here rather than after the prompt
        // is already assembled.
        let (resume_session_id, fork_session, fork_context_refs) = match resume_session_id {
            Some(existing) => (Some(existing), false, Vec::new()),
            None => match self.resolve_fork_start(&task, &executor_profile).await {
                Some(ForkStart::Native { resume_session_id }) => {
                    (Some(resume_session_id), true, Vec::new())
                }
                // Carry the source in as a session ref so the shared digest
                // materialization inlines it, exactly like an attached session.
                Some(ForkStart::Digest { source_task_id }) => (
                    None,
                    false,
                    vec![TaskContextRefInput::session(source_task_id, None)],
                ),
                None => (None, false, Vec::new()),
            },
        };
        let context_refs_with_fork: Vec<TaskContextRefInput> = context_refs
            .iter()
            .cloned()
            .chain(fork_context_refs)
            .collect();

        let materialized_skills =
            SkillRegistry::new().materialize(Some(&workspace_path), &selected_skill_ids)?;
        let execution_prompt =
            ImageService::canonicalize_worktree_links(&execution_prompt, &worktree_path);
        let executor_user_prompt = strip_display_skill_context_blocks(&execution_prompt);
        let executor_prompt =
            apply_materialized_skills(&executor_user_prompt, materialized_skills.as_ref());
        let session_digests = self
            .collect_session_context_digests(&context_refs_with_fork)
            .await;
        let executor_prompt = apply_session_context(&executor_prompt, &session_digests);

        if let Err(err) = self
            .runtime()
            .image()
            .copy_task_images_to_worktree(&worktree_path, task.id)
            .await
        {
            warn!(
                task_id = %task.id,
                error = %err,
                "failed to copy task images to worktree"
            );
        }

        sqlx::query(
            "UPDATE task_runs SET branch_name = ?, target_branch = ?, container_ref = ?, workspace_path = ?, resume_session_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(branch_name.clone())
        .bind(target_branch.clone())
        .bind(&container_ref)
        .bind(&container_ref)
        .bind(resume_session_id.clone())
        .bind(run.id)
        .execute(self.pool())
        .await?;

        TaskRecord::update_worktree_state(
            self.pool(),
            task.id,
            Some(container_ref.clone()),
            false,
            true,
        )
        .await?;
        TaskRecord::update_branch(self.pool(), task.id, branch_name.clone()).await?;

        let now = Utc::now();
        sqlx::query(
            "UPDATE task_runs SET status = ?, run_reason = COALESCE(run_reason, ?), executor_action = ?, executor_action_type = 'desktop', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
        )
        .bind(RunStatus::Running)
        .bind(run.run_reason.clone().or(Some("codingagent".into())))
        .bind(&executor_label)
        .bind(now)
        .bind(now)
        .bind(run.id)
        .execute(self.pool())
        .await?;

        let agent_id = AgentProfile::ensure_default_desktop_profile(self.pool()).await?;
        let mut session = TaskSession::new(task.id, agent_id, Some(execution_prompt.clone()));
        session.task_run_id = Some(run.id);

        let handoff_from_session_id: Option<Uuid> = if let Some(ref external_id) = resume_session_id
        {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM task_sessions WHERE external_session_id = ? ORDER BY updated_at DESC LIMIT 1",
            )
            .bind(external_id)
            .fetch_optional(self.pool())
            .await?
        } else {
            None
        };

        sqlx::query(
            "INSERT INTO task_sessions (id, task_id, task_run_id, agent_profile_id, external_session_id, prompt, summary, handoff_from_session_id, worktree_commit, state_snapshot, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, ?)",
        )
        .bind(session.id)
        .bind(session.task_id)
        .bind(session.task_run_id)
        .bind(session.agent_profile_id)
        .bind(&session.prompt)
        .bind(handoff_from_session_id)
        .bind(session.created_at)
        .bind(session.updated_at)
        .execute(self.pool())
        .await?;

        if !context_refs.is_empty() {
            TaskContextRef::replace_for_task_scope(
                self.pool(),
                task.id,
                Some(session.id),
                Some(run.id),
                &context_refs,
            )
            .await?;
        }

        sqlx::query(
            "UPDATE task_records SET active_session_id = ?, awaiting_input = 0, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(session.id)
        .bind(task.id)
        .execute(self.pool())
        .await?;

        self.runtime()
            .start_execution(ExecutionStartParams {
                task_run_id: run.id,
                executor_session_id: session.id,
                prompt: executor_prompt,
                workspace_path: worktree_path.clone(),
                resume_session_id: resume_session_id.clone(),
                fork_session,
                force_new_attempt,
            })
            .await?;

        info!(
            task_run_id = %run.id,
            task_id = %task.id,
            project_id = %project.id,
            executor_session_id = %session.id,
            "[TaskService::start_execution_session] execution started successfully"
        );

        let updated_run = TaskRun::get(self.pool(), run.id).await?;
        Ok(ExecutionSessionStart {
            task_run: updated_run,
            task,
            project,
            executor_session_id: session.id,
        })
        }
        .await;

        match provision {
            Ok(start) => Ok(start),
            Err(err) => {
                self.fail_unlaunched_run(run_id, owning_task_id, &err).await;
                Err(err)
            }
        }
    }

    /// Follow up on an existing execution with a new message.
    ///
    /// This ensures each execution has its own MsgStore, avoiding the
    /// issue where `Finished` entries from previous executions cause
    /// `ClaudeLogProcessor` to break immediately.
    ///
    /// The new TaskRun inherits worktree/branch info from the previous run.
    pub async fn follow_up_execution(
        &self,
        run_id: Uuid,
        prompt: String,
        selected_skill_ids: Vec<String>,
    ) -> Result<ExecutionSessionStart, RuntimeError> {
        self.follow_up_execution_with_options(
            run_id,
            prompt,
            None,
            selected_skill_ids,
            Vec::new(),
            None,
        )
        .await
    }

    pub async fn follow_up_execution_with_context_refs(
        &self,
        run_id: Uuid,
        prompt: String,
        selected_skill_ids: Vec<String>,
        context_refs: Vec<TaskContextRefInput>,
    ) -> Result<ExecutionSessionStart, RuntimeError> {
        self.follow_up_execution_with_options(
            run_id,
            prompt,
            None,
            selected_skill_ids,
            context_refs,
            None,
        )
        .await
    }

    async fn follow_up_execution_with_options(
        &self,
        run_id: Uuid,
        prompt: String,
        image_ids: Option<Vec<Uuid>>,
        selected_skill_ids: Vec<String>,
        context_refs: Vec<TaskContextRefInput>,
        requested_profile: Option<ExecutorProfileId>,
    ) -> Result<ExecutionSessionStart, RuntimeError> {
        if prompt.trim().is_empty() {
            return Err(RuntimeError::BadRequest("prompt is required"));
        }

        let previous_run = TaskRun::get(self.pool(), run_id).await?;
        let task = TaskRecord::get(self.pool(), previous_run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;
        self.validate_context_refs_for_project(project.id, &context_refs)
            .await?;

        let resume_session_id = Some(
            self.resolve_required_resume_session_id_for_follow_up(&previous_run)
                .await?,
        );

        let workspace_path =
            previous_run
                .workspace_path
                .clone()
                .ok_or(RuntimeError::BadRequest(
                    "workspace path missing on task run",
                ))?;
        let workspace_path_buf = PathBuf::from(&workspace_path);
        if !workspace_path_buf.exists() {
            return Err(RuntimeError::BadRequest("workspace path no longer exists"));
        }

        let prompt = ImageService::canonicalize_worktree_links(&prompt, &workspace_path_buf);
        let project_workspace_path = PathBuf::from(&project.git_repo_path);
        let skill_workspace_path =
            if project_workspace_path.is_absolute() && project_workspace_path.exists() {
                project_workspace_path
            } else {
                workspace_path_buf.clone()
            };
        let materialized_skills =
            SkillRegistry::new().materialize(Some(&skill_workspace_path), &selected_skill_ids)?;
        let executor_user_prompt = strip_display_skill_context_blocks(&prompt);
        let executor_prompt =
            apply_materialized_skills(&executor_user_prompt, materialized_skills.as_ref());
        let session_digests = self.collect_session_context_digests(&context_refs).await;
        let executor_prompt = apply_session_context(&executor_prompt, &session_digests);

        if let Some(ids) = image_ids.as_ref().filter(|items| !items.is_empty()) {
            if let Err(err) = self
                .runtime()
                .image()
                .link_images_to_task(task.id, ids)
                .await
            {
                warn!(
                    task_id = %task.id,
                    error = %err,
                    "failed to link uploaded images to task for follow-up"
                );
            }

            if let Err(err) = self
                .runtime()
                .image()
                .copy_images_by_ids_to_worktree(&workspace_path_buf, ids)
                .await
            {
                warn!(
                    task_id = %task.id,
                    error = %err,
                    "failed to copy uploaded images to worktree for follow-up"
                );
            }
        }

        let mut new_run = TaskRun::new_local(task.id, Some("follow-up".to_string()));
        new_run.executor_label = follow_up_executor_label(
            previous_run.executor_label.as_deref(),
            requested_profile.as_ref(),
        );
        new_run.executor_action = previous_run.executor_action.clone();
        new_run.branch_name = previous_run.branch_name.clone();
        new_run.target_branch = previous_run.target_branch.clone();
        new_run.container_ref = previous_run.container_ref.clone();
        new_run.workspace_path = previous_run.workspace_path.clone();
        new_run.resume_session_id = resume_session_id.clone();
        new_run.status = RunStatus::Running;
        new_run.started_at = Some(Utc::now());
        new_run.insert(self.pool()).await?;

        // As in start_execution_session: once the run row exists, any
        // provisioning failure must land the run in a terminal state instead
        // of leaving a Running row with no executor behind it.
        let run_id = new_run.id;
        let owning_task_id = task.id;
        let provision: Result<ExecutionSessionStart, RuntimeError> = async {
        info!(
            new_task_run_id = %new_run.id,
            previous_task_run_id = %run_id,
            task_id = %task.id,
            "[follow_up_execution] created new TaskRun for follow-up"
        );

        let agent_id = AgentProfile::ensure_default_desktop_profile(self.pool()).await?;
        let mut session = TaskSession::new(task.id, agent_id, Some(prompt.clone()));
        session.task_run_id = Some(new_run.id);

        let handoff_from_session_id: Option<Uuid> = if let Some(ref external_id) = resume_session_id
        {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM task_sessions WHERE external_session_id = ? ORDER BY updated_at DESC LIMIT 1",
            )
            .bind(external_id)
            .fetch_optional(self.pool())
            .await?
        } else {
            None
        };

        sqlx::query(
            "INSERT INTO task_sessions (id, task_id, task_run_id, agent_profile_id, external_session_id, prompt, summary, handoff_from_session_id, worktree_commit, state_snapshot, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, ?)",
        )
        .bind(session.id)
        .bind(session.task_id)
        .bind(session.task_run_id)
        .bind(session.agent_profile_id)
        .bind(&session.prompt)
        .bind(handoff_from_session_id)
        .bind(session.created_at)
        .bind(session.updated_at)
        .execute(self.pool())
        .await?;

        if !context_refs.is_empty() {
            TaskContextRef::replace_for_task_scope(
                self.pool(),
                task.id,
                Some(session.id),
                Some(new_run.id),
                &context_refs,
            )
            .await?;
        }

        sqlx::query(
            "UPDATE task_records SET active_session_id = ?, awaiting_input = 0, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(session.id)
        .bind(task.id)
        .execute(self.pool())
        .await?;

        self.lifecycle().mark_in_progress(&task).await?;

        self.runtime()
            .start_execution(ExecutionStartParams {
                task_run_id: new_run.id,
                executor_session_id: session.id,
                prompt: executor_prompt,
                workspace_path: workspace_path_buf.clone(),
                resume_session_id,
                force_new_attempt: Some(false),
                // A follow-up continues this task's own session; only a forked
                // task's first turn branches.
                fork_session: false,
            })
            .await?;

        let updated_run = TaskRun::get(self.pool(), new_run.id).await?;
        Ok(ExecutionSessionStart {
            task_run: updated_run,
            task,
            project,
            executor_session_id: session.id,
        })
        }
        .await;

        match provision {
            Ok(start) => Ok(start),
            Err(err) => {
                self.fail_unlaunched_run(run_id, owning_task_id, &err).await;
                Err(err)
            }
        }
    }

    async fn resolve_resume_session_id_for_follow_up(
        &self,
        previous_run: &TaskRun,
    ) -> Result<Option<String>, RuntimeError> {
        // Prefer the external_session_id captured for this specific run.
        let by_run: Option<String> = sqlx::query_scalar(
            "SELECT external_session_id FROM task_sessions WHERE task_run_id = ? AND external_session_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(previous_run.id)
        .fetch_optional(self.pool())
        .await?
        .flatten();
        if by_run.is_some() {
            return Ok(by_run);
        }

        // Fallback to latest known external_session_id for the task.
        let by_task: Option<String> = sqlx::query_scalar(
            "SELECT external_session_id FROM task_sessions WHERE task_id = ? AND external_session_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(previous_run.task_id)
        .fetch_optional(self.pool())
        .await?
        .flatten();
        if by_task.is_some() {
            return Ok(by_task);
        }

        // Last resort: recover session_id from persisted run logs.
        let entries = self.runtime().fetch_logs(previous_run.id).await?;
        if let Some(session_id) = extract_session_id_from_entries(&entries) {
            if let Err(err) = sqlx::query(
                "UPDATE task_sessions SET external_session_id = ?, updated_at = datetime('now') WHERE task_run_id = ?",
            )
            .bind(&session_id)
            .bind(previous_run.id)
            .execute(self.pool())
            .await
            {
                warn!(
                    task_run_id = %previous_run.id,
                    error = %err,
                    "failed to backfill external_session_id from task run logs"
                );
            }
            return Ok(Some(session_id));
        }

        Ok(None)
    }

    async fn resolve_required_resume_session_id_for_follow_up(
        &self,
        previous_run: &TaskRun,
    ) -> Result<String, RuntimeError> {
        for attempt in 0..=FOLLOW_UP_RESUME_SESSION_RETRY_ATTEMPTS {
            let resume_session_id = self
                .resolve_resume_session_id_for_follow_up(previous_run)
                .await?;
            if let Ok(session_id) = require_follow_up_resume_session_id(resume_session_id) {
                return Ok(session_id);
            }

            if attempt < FOLLOW_UP_RESUME_SESSION_RETRY_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(
                    FOLLOW_UP_RESUME_SESSION_RETRY_DELAY_MS,
                ))
                .await;
            }
        }

        warn!(
            previous_task_run_id = %previous_run.id,
            task_id = %previous_run.task_id,
            "cannot start follow-up because the previous executor session id is unavailable"
        );
        Err(RuntimeError::BadRequest(FOLLOW_UP_MISSING_SESSION_ID_ERROR))
    }

    async fn workspace_path_for_task(&self, task_id: Uuid) -> Result<PathBuf, RuntimeError> {
        let task = TaskRecord::get(self.pool(), task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;
        Ok(PathBuf::from(project.git_repo_path))
    }

    pub async fn send_task_message(
        &self,
        params: SendTaskMessageParams,
    ) -> Result<TaskMessageStart, RuntimeError> {
        let SendTaskMessageParams {
            task_id,
            prompt,
            mode,
            executor_profile_id,
            image_ids,
            use_worktree,
            target_branch,
            selected_skill_ids,
            context_refs,
        } = params;

        match mode {
            TaskMessageMode::New => {
                let execution = self
                    .start_execution_session(StartExecutionSessionParams {
                        prompt: Some(prompt),
                        workspace_path: self.workspace_path_for_task(task_id).await?,
                        resume_session_id: None,
                        force_new_attempt: Some(true),
                        task_id: Some(task_id),
                        executor_profile_id,
                        image_ids,
                        use_worktree,
                        target_branch,
                        selected_skill_ids,
                        context_refs,
                    })
                    .await?;

                Ok(TaskMessageStart {
                    execution,
                    continued_existing_run: false,
                    previous_task_run_id: None,
                })
            }
            TaskMessageMode::Auto => {
                if let Some(latest_run) = TaskRun::latest_for_task(self.pool(), task_id).await? {
                    let previous_task_run_id = latest_run.id;
                    let execution = self
                        .follow_up_execution_with_options(
                            latest_run.id,
                            prompt,
                            image_ids,
                            selected_skill_ids,
                            context_refs,
                            executor_profile_id,
                        )
                        .await?;
                    return Ok(TaskMessageStart {
                        execution,
                        continued_existing_run: true,
                        previous_task_run_id: Some(previous_task_run_id),
                    });
                }

                let execution = self
                    .start_execution_session(StartExecutionSessionParams {
                        prompt: Some(prompt),
                        workspace_path: self.workspace_path_for_task(task_id).await?,
                        resume_session_id: None,
                        force_new_attempt: Some(false),
                        task_id: Some(task_id),
                        executor_profile_id,
                        image_ids,
                        use_worktree,
                        target_branch,
                        selected_skill_ids,
                        context_refs,
                    })
                    .await?;

                Ok(TaskMessageStart {
                    execution,
                    continued_existing_run: false,
                    previous_task_run_id: None,
                })
            }
        }
    }

    /// Follow up on a task using its stable task ID.
    ///
    /// Finds the latest TaskRun for the given task and delegates to
    /// `follow_up_execution`. This avoids the problem where the frontend
    /// must track an ever-changing task_run_id between follow-ups.
    pub async fn follow_up_by_task(
        &self,
        task_id: Uuid,
        prompt: String,
    ) -> Result<ExecutionSessionStart, RuntimeError> {
        self.send_task_message(SendTaskMessageParams {
            task_id,
            prompt,
            mode: TaskMessageMode::Auto,
            executor_profile_id: None,
            image_ids: None,
            use_worktree: None,
            target_branch: None,
            selected_skill_ids: Vec::new(),
            context_refs: Vec::new(),
        })
        .await
        .map(|result| result.execution)
    }

    /// Best-effort terminal transition for a run whose provisioning failed
    /// before the executor launched. Marks the run Failed (which also settles
    /// the task status) and clears the task's live-session pointer so the
    /// sidebar never shows a forever-running session for a run that has no
    /// executor behind it.
    async fn fail_unlaunched_run(&self, run_id: Uuid, task_id: Uuid, err: &RuntimeError) {
        warn!(
            task_run_id = %run_id,
            task_id = %task_id,
            error = %err,
            "execution provisioning failed; marking run as failed"
        );
        if let Err(mark_err) = self
            .update_execution_status(run_id, RunStatus::Failed, None)
            .await
        {
            warn!(
                task_run_id = %run_id,
                error = %mark_err,
                "failed to mark unlaunched run as failed"
            );
        }
        if let Err(clear_err) = sqlx::query(
            "UPDATE task_records SET active_session_id = NULL, awaiting_input = 0, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(task_id)
        .execute(self.pool())
        .await
        {
            warn!(
                task_id = %task_id,
                error = %clear_err,
                "failed to clear active session pointer for unlaunched run"
            );
        }
    }

    pub async fn update_execution_status(
        &self,
        run_id: Uuid,
        status: RunStatus,
        exit_code: Option<i32>,
    ) -> Result<TaskRun, RuntimeError> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE task_runs SET status = ?, exit_code = ?, completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(status)
        .bind(exit_code)
        .bind(now)
        .bind(now)
        .bind(run_id)
        .execute(self.pool())
        .await?;

        let run = TaskRun::get(self.pool(), run_id).await?;
        self.lifecycle()
            .mark_from_run_status(run.task_id, status)
            .await?;
        Ok(run)
    }

    pub async fn merge_task_run(
        &self,
        run_id: Uuid,
        commit_message: Option<String>,
    ) -> Result<MergeOutcome, RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;
        if run.worktree_deleted {
            return Err(RuntimeError::BadRequest(
                "worktree for this run has already been cleaned up",
            ));
        }

        let branch_name = run.branch_name.clone().ok_or(RuntimeError::BadRequest(
            "task run does not have an associated branch",
        ))?;
        let target_branch = run.target_branch.clone().ok_or(RuntimeError::BadRequest(
            "task run is missing target branch information",
        ))?;
        let worktree_path = PathBuf::from(run.container_ref.clone().ok_or(
            RuntimeError::BadRequest("task run is missing worktree metadata"),
        )?);

        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;
        let config = self.runtime().config().read().await;
        let merge_message = build_merge_commit_message(
            &task,
            commit_message,
            config.merge_commit_template.as_deref(),
        );
        drop(config);

        let short = short_id_from_uuid(&task.id);
        let snapshot_message = format!("chore: finalize task {short}");
        // commit_all + merge_changes are blocking git operations (the merge runs
        // a full squash with conflict detection). Offload both to the blocking
        // pool so the merge never stalls the async runtime's worker threads.
        let merge_commit = {
            let git = self.runtime().git().clone();
            let worktree = worktree_path.clone();
            let repo_path = project.git_repo_path.clone();
            let branch = branch_name.clone();
            let target = target_branch.clone();
            tokio::task::spawn_blocking(move || {
                let _ = git.commit_all(&worktree, &snapshot_message);
                git.merge_changes(
                    Path::new(&repo_path),
                    &worktree,
                    &branch,
                    &target,
                    &merge_message,
                )
            })
            .await
            .map_err(|e| RuntimeError::Other(anyhow::anyhow!("git merge task failed: {e}")))?
            .map_err(RuntimeError::from)?
        };

        TaskMerge::create_direct(
            self.pool(),
            task.id,
            target_branch.clone(),
            merge_commit.clone(),
        )
        .await?;
        TaskRecord::update_status(self.pool(), task.id, TaskStatus::Completed).await?;

        sqlx::query(
            "UPDATE task_runs SET after_head_commit = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&merge_commit)
        .bind(run.id)
        .execute(self.pool())
        .await?;

        Ok(MergeOutcome {
            merge_commit,
            target_branch,
        })
    }

    pub async fn rebase_task_run(
        &self,
        run_id: Uuid,
        new_base_branch: String,
        old_base_branch: Option<String>,
    ) -> Result<RebaseOutcome, RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;
        if run.worktree_deleted {
            return Err(RuntimeError::BadRequest(
                "worktree for this run has already been cleaned up",
            ));
        }

        let branch_name = run.branch_name.clone().ok_or(RuntimeError::BadRequest(
            "task run does not have an associated branch",
        ))?;
        let default_target_branch = run.target_branch.clone().ok_or(RuntimeError::BadRequest(
            "task run is missing target branch information",
        ))?;
        let worktree_path = PathBuf::from(run.container_ref.clone().ok_or(
            RuntimeError::BadRequest("task run is missing worktree metadata"),
        )?);
        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;

        let old_base = old_base_branch.unwrap_or(default_target_branch.clone());
        self.runtime()
            .git()
            .rebase_branch(
                Path::new(&project.git_repo_path),
                &worktree_path,
                &new_base_branch,
                &old_base,
                &branch_name,
            )
            .map_err(RuntimeError::from)?;

        sqlx::query(
            "UPDATE task_runs SET target_branch = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&new_base_branch)
        .bind(run.id)
        .execute(self.pool())
        .await?;

        Ok(RebaseOutcome { new_base_branch })
    }

    pub async fn list_task_run_branches(
        &self,
        run_id: Uuid,
    ) -> Result<Vec<BranchInfo>, RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;
        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;
        // Listing branches walks refs via git2; offload it so this frequently
        // polled endpoint never blocks an async worker thread.
        let git = self.runtime().git().clone();
        let repo_path = project.git_repo_path.clone();
        let branches = crate::perf::spawn_blocking_instrumented("git.list_branches", move || {
            git.list_branches(&repo_path)
        })
        .await
        .map_err(|e| RuntimeError::Other(anyhow::anyhow!("git list-branches task failed: {e}")))?
        .map_err(RuntimeError::from)?;
        Ok(branches)
    }

    /// Get the branch status for a task run, returning commits ahead and behind the target branch.
    pub async fn get_task_run_branch_status(
        &self,
        run_id: Uuid,
    ) -> Result<TaskRunBranchStatus, RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;

        let merges = TaskMerge::find_by_task(self.pool(), run.task_id)
            .await
            .unwrap_or_default();

        let branch_name = match &run.branch_name {
            Some(name) => name.clone(),
            None => {
                return Ok(TaskRunBranchStatus {
                    commits_ahead: None,
                    commits_behind: None,
                    target_branch: run.target_branch,
                    is_rebase_in_progress: false,
                    merges,
                    conflicted_files: Vec::new(),
                    conflict_op: None,
                });
            }
        };

        let target_branch = match &run.target_branch {
            Some(target) => target.clone(),
            None => {
                return Ok(TaskRunBranchStatus {
                    commits_ahead: None,
                    commits_behind: None,
                    target_branch: None,
                    is_rebase_in_progress: false,
                    merges,
                    conflicted_files: Vec::new(),
                    conflict_op: None,
                });
            }
        };

        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;

        let worktree_path = run.container_ref.as_ref().map(PathBuf::from);

        // git2 work here (conflict scans plus a graph_ahead_behind revwalk) is
        // synchronous and can take a long time on large repositories. This
        // endpoint is polled frequently for every visible run, so offload the
        // whole block to the blocking pool in a single hop. Running it inline
        // on an async worker thread starves the runtime: enough concurrent
        // polls block every worker and the whole server stops making progress.
        let git = self.runtime().git().clone();
        let repo_path = project.git_repo_path.clone();
        let branch_for_status = branch_name.clone();
        let target_for_status = target_branch.clone();
        let (is_rebase_in_progress, conflicted_files, conflict_op, status) =
            crate::perf::spawn_blocking_instrumented("git.branch_status", move || {
                let (in_rebase, conflicts, op) = match worktree_path.as_deref() {
                    Some(path) => {
                        let in_rebase = git.is_rebase_in_progress(path).unwrap_or(false);
                        let conflicts = git.get_conflicted_files(path).unwrap_or_default();
                        let op = if conflicts.is_empty() {
                            None
                        } else {
                            git.detect_conflict_op(path).unwrap_or(None)
                        };
                        (in_rebase, conflicts, op)
                    }
                    None => (false, Vec::new(), None),
                };
                let status =
                    git.get_branch_status(&repo_path, &branch_for_status, &target_for_status);
                (in_rebase, conflicts, op, status)
            })
            .await
            .map_err(|e| {
                RuntimeError::Other(anyhow::anyhow!("git branch-status task failed: {e}"))
            })?;

        match status {
            Ok((ahead, behind)) => Ok(TaskRunBranchStatus {
                commits_ahead: Some(ahead),
                commits_behind: Some(behind),
                target_branch: Some(target_branch),
                is_rebase_in_progress,
                merges,
                conflicted_files,
                conflict_op,
            }),
            Err(err) => {
                warn!(
                    run_id = %run_id,
                    error = %err,
                    "failed to get branch status"
                );
                Ok(TaskRunBranchStatus {
                    commits_ahead: None,
                    commits_behind: None,
                    target_branch: Some(target_branch),
                    is_rebase_in_progress,
                    merges,
                    conflicted_files,
                    conflict_op,
                })
            }
        }
    }

    /// Abort any in-progress conflict (rebase, merge, cherry-pick, revert) in the task run's worktree.
    pub async fn abort_conflicts(&self, run_id: Uuid) -> Result<(), RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;
        let worktree_path = run
            .container_ref
            .as_ref()
            .map(PathBuf::from)
            .ok_or_else(|| RuntimeError::BadRequest("no worktree path available"))?;

        self.runtime()
            .git()
            .abort_conflicts(&worktree_path)
            .map_err(RuntimeError::from)
    }

    pub async fn mark_worktree_deleted(&self, run_id: Uuid) -> Result<(), RuntimeError> {
        let maybe_task_id =
            sqlx::query_scalar::<_, Uuid>("SELECT task_id FROM task_runs WHERE id = ?")
                .bind(run_id)
                .fetch_optional(self.pool())
                .await?;
        let Some(task_id) = maybe_task_id else {
            return Ok(());
        };

        sqlx::query(
            "UPDATE task_runs SET worktree_deleted = 1, container_ref = NULL, workspace_path = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(Utc::now())
        .bind(run_id)
        .execute(self.pool())
        .await?;

        TaskRecord::mark_worktree_deleted(self.pool(), task_id, true).await?;
        Ok(())
    }
}

struct TaskLifecycle<'a> {
    pool: &'a Pool<Sqlite>,
}

impl<'a> TaskLifecycle<'a> {
    fn new(pool: &'a Pool<Sqlite>) -> Self {
        Self { pool }
    }

    async fn mark_in_progress(&self, task: &TaskRecord) -> Result<(), RuntimeError> {
        if task.status == TaskStatus::InProgress {
            return Ok(());
        }

        TaskRecord::update_status(self.pool, task.id, TaskStatus::InProgress).await?;
        info!(
            task_id = %task.id,
            previous_status = ?task.status,
            "task marked as in-progress after run start"
        );
        Ok(())
    }

    async fn mark_from_run_status(
        &self,
        task_id: Uuid,
        run_status: RunStatus,
    ) -> Result<(), RuntimeError> {
        let next_status = match run_status {
            RunStatus::Completed => Some(TaskStatus::Completed),
            RunStatus::Failed => Some(TaskStatus::Failed),
            RunStatus::Cancelled => Some(TaskStatus::Cancelled),
            _ => None,
        };

        if let Some(status) = next_status {
            TaskRecord::update_status(self.pool, task_id, status).await?;
        }
        Ok(())
    }
}

/// Whether `run` was produced by the same executor the next turn will use.
///
/// Compares only the runtime, not the model or reasoning effort: those can
/// change freely within one executor's session, but a session id never crosses
/// from one executor to another. A run with no label predates labelling and
/// cannot be matched, so it is treated as a mismatch.
fn run_targets_executor(run: &TaskRun, executor: &ExecutorProfileId) -> bool {
    let Some(label) = run.executor_label.as_deref() else {
        return false;
    };
    match serde_json::from_str::<ExecutorProfileId>(label) {
        Ok(profile) => profile.executor == executor.executor,
        // Legacy labels stored the bare executor name rather than a profile.
        Err(_) => label == executor.executor.to_string(),
    }
}

/// Resolve the executor label for a follow-up run.
///
/// The runtime (executor) and variant are fixed by the prior run; a follow-up
/// only lets the user pick a different model / reasoning for the next turn, and
/// only when the request still targets the same runtime. Switching runtimes
/// mid-session is impossible here on purpose (that path is handoff, since resume
/// ids are executor-specific). A `None`/legacy label is carried over verbatim,
/// and a missing model/reasoning in the request keeps the prior value rather
/// than clobbering it with a default.
fn follow_up_executor_label(
    previous_label: Option<&str>,
    requested: Option<&ExecutorProfileId>,
) -> Option<String> {
    let previous_label = previous_label?;
    let Ok(mut profile) = serde_json::from_str::<ExecutorProfileId>(previous_label) else {
        return Some(previous_label.to_string());
    };
    if let Some(req) = requested.filter(|r| r.executor == profile.executor) {
        if req.model.is_some() {
            profile.model = req.model.clone();
        }
        if req.reasoning_effort.is_some() {
            profile.reasoning_effort = req.reasoning_effort.clone();
        }
        if req.speed.is_some() {
            profile.speed = req.speed;
        }
    }
    Some(serde_json::to_string(&profile).unwrap_or_else(|_| previous_label.to_string()))
}

fn infer_task_title(prompt: &str) -> String {
    let text = extract_task_text(prompt);
    if text.is_empty() {
        format!("Session {}", Utc::now().format("%Y-%m-%d %H:%M"))
    } else {
        text.lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or(&text)
            .trim()
            .chars()
            .take(80)
            .collect()
    }
}

fn infer_task_description(prompt: &str) -> Option<String> {
    let text = extract_task_text(prompt);
    if text.is_empty() {
        return None;
    }

    let mut seen_title = false;
    let description = text
        .lines()
        .filter_map(|line| {
            if !seen_title && !line.trim().is_empty() {
                seen_title = true;
                return None;
            }
            Some(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if description.is_empty() {
        None
    } else {
        Some(description)
    }
}

fn extract_task_text(prompt: &str) -> String {
    // Drop image attachments first so a leading image cannot shield the
    // metadata blocks that follow it (otherwise the `<context>` line survives
    // and leaks into the inferred title).
    let without_images = prompt
        .trim()
        .lines()
        .filter(|line| !is_image_markdown_line(line.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    strip_leading_prompt_metadata_blocks(without_images.trim())
        .trim()
        .to_string()
}

fn strip_leading_prompt_metadata_blocks(prompt: &str) -> &str {
    let mut remaining = prompt;
    while let Some((_, after_block)) = take_leading_tag_block(remaining, "<context>", "</context>")
        .or_else(|| take_leading_tag_block(remaining, "<skills_context>", "</skills_context>"))
    {
        remaining = after_block.trim_start();
    }
    remaining
}

fn strip_display_skill_context_blocks(prompt: &str) -> String {
    let mut remaining = prompt.trim_start();
    let mut kept_blocks: Vec<&str> = Vec::new();
    let mut removed_skill_context = false;

    loop {
        if let Some((_, after_block)) =
            take_leading_tag_block(remaining, "<skills_context>", "</skills_context>")
        {
            removed_skill_context = true;
            remaining = after_block.trim_start();
            continue;
        }

        if let Some((block, after_block)) =
            take_leading_tag_block(remaining, "<context>", "</context>")
        {
            kept_blocks.push(block.trim_end());
            remaining = after_block.trim_start();
            continue;
        }

        break;
    }

    if !removed_skill_context {
        return prompt.to_string();
    }

    if kept_blocks.is_empty() {
        return remaining.to_string();
    }

    let prefix = kept_blocks.join("\n\n");
    if remaining.is_empty() {
        prefix
    } else {
        format!("{}\n\n{}", prefix, remaining)
    }
}

fn take_leading_tag_block<'a>(
    prompt: &'a str,
    open_tag: &str,
    close_tag: &str,
) -> Option<(&'a str, &'a str)> {
    let rest = prompt.strip_prefix(open_tag)?;
    let close_start = rest.find(close_tag)?;
    let block_end = open_tag.len() + close_start + close_tag.len();
    Some((&prompt[..block_end], &prompt[block_end..]))
}

fn is_image_markdown_line(line: &str) -> bool {
    line.starts_with("![") && line.contains("](") && line.ends_with(')')
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn short_id_from_uuid(id: &Uuid) -> String {
    id.to_string()
        .split('-')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// Name a forked session after its source, numbering repeats.
///
/// Both reference desktop apps do the same thing rather than inventing a name:
/// the fork is the same work continued, so the title should read that way.
/// One delegated result, rendered for the barrier wake packet.
fn build_handoff_packet(
    child_title: &str,
    branch: Option<&str>,
    workspace_path: Option<&str>,
    commit: Option<&str>,
    summary: Option<&str>,
) -> String {
    let mut packet = format!("Task: \"{child_title}\"\n");
    match (branch, workspace_path) {
        (Some(branch), Some(path)) => {
            packet.push_str(&format!("Branch: {branch} (worktree: {path})\n"))
        }
        (Some(branch), None) => packet.push_str(&format!("Branch: {branch}\n")),
        (None, Some(path)) => packet.push_str(&format!("Workspace: {path}\n")),
        (None, None) => {}
    }
    if let Some(commit) = commit {
        packet.push_str(&format!("Commit: {commit}\n"));
    }
    packet.push_str("Result:\n");
    packet.push_str(summary.unwrap_or("(the task produced no summary)"));
    packet
}

/// The wake prompt the barrier delivers to the delegating session.
///
/// This text is exactly what the woken model reads, and exactly what its
/// conversation shows as the turn's prompt: the surface and the model see the
/// same thing.
fn build_barrier_wake_prompt(packets: &[String]) -> String {
    let header = if packets.len() == 1 {
        "A task you delegated has finished.".to_string()
    } else {
        format!("All {} tasks you delegated have finished.", packets.len())
    };
    format!(
        "{header}\n\n{}\n\nIntegrate these results into your ongoing work: review them, and merge or build on the branches if appropriate.",
        packets.join("\n\n---\n\n"),
    )
}

fn fork_title(source_title: &str) -> String {
    let base = source_title.trim();
    let (stem, next) = match base.rsplit_once(" (") {
        Some((stem, tail)) => match tail.strip_suffix(')').and_then(|n| n.parse::<u32>().ok()) {
            Some(n) => (stem.trim(), n.saturating_add(1)),
            None => (base, 2),
        },
        None => (base, 2),
    };
    format!("{stem} ({next})")
}

fn extract_session_id_from_entries(entries: &[LogEntry]) -> Option<String> {
    entries.iter().rev().find_map(|entry| match entry {
        LogEntry::SessionId(id) if !id.trim().is_empty() => Some(id.clone()),
        _ => None,
    })
}

fn require_follow_up_resume_session_id(session_id: Option<String>) -> Result<String, RuntimeError> {
    match session_id {
        Some(session_id) if !session_id.trim().is_empty() => Ok(session_id),
        _ => Err(RuntimeError::BadRequest(FOLLOW_UP_MISSING_SESSION_ID_ERROR)),
    }
}

fn build_merge_commit_message(
    task: &TaskRecord,
    override_message: Option<String>,
    template: Option<&str>,
) -> String {
    if let Some(message) = override_message {
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let short = short_id_from_uuid(&task.id);
    let tmpl = template.unwrap_or(DEFAULT_MERGE_COMMIT_TEMPLATE);
    let description = task
        .description
        .as_ref()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty())
        .map(String::from);
    render_merge_commit_template(
        tmpl,
        &task.title,
        &task.id.to_string(),
        &short,
        description.as_deref(),
    )
}

fn resolve_use_worktree_mode(is_git_repository: bool, requested: Option<bool>) -> bool {
    if !is_git_repository {
        return false;
    }

    requested.unwrap_or(true)
}

/// Per-task working directory for a scratch chat, nested under the chats root.
/// Keyed on the task id so every run of the same chat reuses one subfolder
/// (resume lands in the same place), while distinct chats never collide.
fn scratch_chat_dir(chats_root: &Path, task_title: &str, task_id: &str) -> PathBuf {
    chats_root.join(worktree_dir_name(task_title, task_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forking a claude session and running its first turn on codex used to hand
    /// codex a claude session id, which it rejects with "no rollout found for
    /// thread id". Cross-executor forks must fall back to a digest instead.
    #[test]
    fn run_targets_executor_rejects_a_different_executor() {
        use executors::executors::BaseCodingAgent;

        let claude = ExecutorProfileId::new(BaseCodingAgent::ClaudeCode);
        let codex = ExecutorProfileId::new(BaseCodingAgent::Codex);

        let mut run = TaskRun::new_local(Uuid::new_v4(), None);
        run.executor_label = Some(serde_json::to_string(&claude).unwrap());

        assert!(run_targets_executor(&run, &claude));
        assert!(!run_targets_executor(&run, &codex));

        // Model / reasoning differences stay within one executor's session.
        let claude_other_model = ExecutorProfileId {
            model: Some("claude-opus-4-8".to_string()),
            ..claude.clone()
        };
        assert!(run_targets_executor(&run, &claude_other_model));

        // Legacy runs stored a bare executor name instead of a profile.
        run.executor_label = Some(claude.executor.to_string());
        assert!(run_targets_executor(&run, &claude));
        assert!(!run_targets_executor(&run, &codex));

        // A run with no label cannot be matched, so it must not be resumed.
        run.executor_label = None;
        assert!(!run_targets_executor(&run, &claude));
    }

    /// The wake packet is the delegating model's entire view of the results,
    /// so every field a handoff has must appear, and every field it lacks must
    /// degrade silently instead of printing an empty line.
    #[test]
    fn barrier_wake_prompt_carries_packets_and_degrades_per_field() {
        let full = build_handoff_packet(
            "DB schema migration",
            Some("ch/a1b2"),
            Some("/worktrees/ch/a1b2"),
            Some("b7d9e2f"),
            Some("Applied the migration and updated the models."),
        );
        assert!(full.contains("Task: \"DB schema migration\""));
        assert!(full.contains("Branch: ch/a1b2 (worktree: /worktrees/ch/a1b2)"));
        assert!(full.contains("Commit: b7d9e2f"));
        assert!(full.contains("Applied the migration and updated the models."));

        // A General-chat child has no git side at all.
        let bare = build_handoff_packet("meeting notes", None, None, None, None);
        assert!(!bare.contains("Branch"));
        assert!(!bare.contains("Commit:"));
        assert!(!bare.contains("Workspace:"));
        assert!(bare.contains("(the task produced no summary)"));

        let single = build_barrier_wake_prompt(&[full.clone()]);
        assert!(single.starts_with("A task you delegated has finished."));
        assert!(single.contains("Integrate these results"));

        let multi = build_barrier_wake_prompt(&[full, bare]);
        assert!(multi.starts_with("All 2 tasks you delegated have finished."));
        assert!(multi.contains("\n\n---\n\n"));
    }

    #[test]
    fn fork_title_numbers_repeated_forks() {
        assert_eq!(fork_title("retry policy"), "retry policy (2)");
        // Forking a fork continues the count rather than nesting suffixes.
        assert_eq!(fork_title("retry policy (2)"), "retry policy (3)");
        assert_eq!(fork_title("retry policy (9)"), "retry policy (10)");
        // A parenthetical that isn't a counter is left intact.
        assert_eq!(fork_title("retry policy (draft)"), "retry policy (draft) (2)");
        assert_eq!(fork_title("  spaced  "), "spaced (2)");
    }

    #[test]
    fn infer_task_title_ignores_leading_context_block() {
        let prompt =
            "<context>\n<file path=\"src/main.rs\" />\n</context>\n\nfix the bug\nmore detail";
        assert_eq!(infer_task_title(prompt), "fix the bug");
    }

    #[test]
    fn infer_task_title_falls_back_when_prompt_only_has_context() {
        let prompt = "<context>\n<file path=\"src/main.rs\" />\n</context>";
        assert!(infer_task_title(prompt).starts_with("Session "));
    }

    #[test]
    fn infer_task_title_ignores_leading_skill_context_block() {
        let prompt = "<skills_context>\n<skill id=\"workspace:.agents/skills:release\" name=\"release\" />\n</skills_context>\n\nfix the release";
        assert_eq!(infer_task_title(prompt), "fix the release");
    }

    #[test]
    fn infer_task_title_ignores_context_and_skill_context_blocks() {
        let prompt = "<context>\n<file path=\"src/main.rs\" />\n</context>\n\n<skills_context>\n<skill id=\"workspace:.agents/skills:release\" name=\"release\" />\n</skills_context>\n\nfix the bug";
        assert_eq!(infer_task_title(prompt), "fix the bug");
    }

    #[test]
    fn infer_task_title_ignores_leading_images() {
        let prompt = "![img.png](.chro-context/img.png)\nfix the bug";
        assert_eq!(infer_task_title(prompt), "fix the bug");
    }

    #[test]
    fn infer_task_title_ignores_context_block_after_leading_image() {
        let prompt =
            "![img.png](.chro-context/img.png)\n<context>\n<file path=\"src/main.rs\" />\n</context>\nfix the bug";
        assert_eq!(infer_task_title(prompt), "fix the bug");
    }

    #[test]
    fn infer_task_title_falls_back_when_only_image_and_context() {
        let prompt = "![img.png](.chro-context/img.png)\n<context>\n<past_session task_id=\"abc\" />\n</context>";
        assert!(infer_task_title(prompt).starts_with("Session "));
    }

    #[test]
    fn infer_task_description_uses_remaining_text_after_title() {
        let prompt = "<context>\n<file path=\"src/main.rs\" />\n</context>\nfix the bug\nadd tests";
        assert_eq!(
            infer_task_description(prompt),
            Some("add tests".to_string())
        );
    }

    #[test]
    fn strip_display_skill_context_blocks_preserves_regular_context() {
        let prompt = "<context>\n<file path=\"src/main.rs\" />\n</context>\n\n<skills_context>\n<skill id=\"workspace:.agents/skills:release\" name=\"release\" />\n</skills_context>\n\nfix the bug";
        assert_eq!(
            strip_display_skill_context_blocks(prompt),
            "<context>\n<file path=\"src/main.rs\" />\n</context>\n\nfix the bug"
        );
    }

    #[test]
    fn strip_display_skill_context_blocks_removes_skill_only_prefix() {
        let prompt = "<skills_context>\n<skill id=\"workspace:.agents/skills:release\" name=\"release\" />\n</skills_context>\n\nfix the bug";
        assert_eq!(strip_display_skill_context_blocks(prompt), "fix the bug");
    }

    #[test]
    fn strip_display_skill_context_blocks_preserves_prompt_without_skill_context() {
        let prompt = "  <context>\n<file path=\"src/main.rs\" />\n</context>\n\nfix the bug";
        assert_eq!(strip_display_skill_context_blocks(prompt), prompt);
    }

    #[test]
    fn extract_session_id_prefers_latest_entry() {
        let entries = vec![
            LogEntry::Stdout("boot".to_string()),
            LogEntry::SessionId("session-1".to_string()),
            LogEntry::SessionId("session-2".to_string()),
            LogEntry::Finished,
        ];
        assert_eq!(
            extract_session_id_from_entries(&entries),
            Some("session-2".to_string())
        );
    }

    #[test]
    fn extract_session_id_none_when_missing() {
        let entries = vec![
            LogEntry::Stdout("boot".to_string()),
            LogEntry::Stderr("warn".to_string()),
            LogEntry::Finished,
        ];
        assert_eq!(extract_session_id_from_entries(&entries), None);
    }

    #[test]
    fn require_follow_up_resume_session_id_accepts_present_id() {
        assert_eq!(
            require_follow_up_resume_session_id(Some("session-1".to_string())).unwrap(),
            "session-1"
        );
    }

    #[test]
    fn require_follow_up_resume_session_id_rejects_missing_id() {
        assert!(matches!(
            require_follow_up_resume_session_id(None),
            Err(RuntimeError::BadRequest(message))
                if message == FOLLOW_UP_MISSING_SESSION_ID_ERROR
        ));
    }

    #[test]
    fn require_follow_up_resume_session_id_rejects_blank_id() {
        assert!(matches!(
            require_follow_up_resume_session_id(Some("   ".to_string())),
            Err(RuntimeError::BadRequest(message))
                if message == FOLLOW_UP_MISSING_SESSION_ID_ERROR
        ));
    }

    #[test]
    fn forces_local_mode_for_non_git_workspace_when_requested() {
        assert!(!resolve_use_worktree_mode(false, Some(true)));
    }

    #[test]
    fn defaults_to_worktree_mode_for_git_workspace() {
        assert!(resolve_use_worktree_mode(true, None));
    }

    #[test]
    fn respects_explicit_local_mode_for_git_workspace() {
        assert!(!resolve_use_worktree_mode(true, Some(false)));
    }

    #[test]
    fn scratch_chat_dir_nests_per_task_subfolder_under_root() {
        let root = Path::new("/tmp/chats");
        let dir = scratch_chat_dir(root, "Plan the launch", "1a2b3c4d");
        assert!(dir.starts_with(root));
        assert_ne!(dir, root);
        // The subfolder carries the slugified title so it is human-scannable.
        assert!(dir.to_string_lossy().contains("plan-the-launch"));
    }

    #[test]
    fn scratch_chat_dir_is_stable_per_task_and_distinct_across_tasks() {
        let root = Path::new("/tmp/chats");
        let a1 = scratch_chat_dir(root, "Plan the launch", "1a2b3c4d");
        let a2 = scratch_chat_dir(root, "Plan the launch", "1a2b3c4d");
        let b = scratch_chat_dir(root, "Plan the launch", "ffeeddcc");
        assert_eq!(a1, a2, "same task id must resolve to the same subfolder");
        assert_ne!(a1, b, "distinct task ids must not collide");
    }
}
