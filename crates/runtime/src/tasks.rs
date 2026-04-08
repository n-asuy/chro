use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use db::{
    models::{
        AgentProfile, ProjectRecord, TaskMerge, TaskRecord, TaskRun, TaskRunLog, TaskSession,
    },
    types::{RunStatus, TaskStatus},
};
use executors::ExecutorProfileId;
use git::BranchInfo;
use image::ImageService;
use log_types::LogEntry;
use serde::{Deserialize, Serialize};
use serde_json;
use sqlx::{Pool, Sqlite};
use tracing::{info, warn};
use uuid::Uuid;

use worktree::{generate_attempt_branch_name, EnsureOptions};

use config::{render_merge_commit_template, DEFAULT_MERGE_COMMIT_TEMPLATE};

use crate::{execution::ExecutionStartParams, Runtime, RuntimeError};

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

    pub async fn create_task(
        &self,
        project_id: Uuid,
        title: Option<String>,
        description: Option<String>,
        prompt: Option<String>,
    ) -> Result<TaskRecord, RuntimeError> {
        let prompt = normalize_optional_text(prompt);
        let title = normalize_optional_text(title)
            .or_else(|| prompt.as_deref().map(infer_task_title))
            .ok_or(RuntimeError::BadRequest("title or prompt is required"))?;
        let description = normalize_optional_text(description)
            .or_else(|| prompt.as_deref().and_then(infer_task_description));
        let task = TaskRecord::new_with_prompt(project_id, title, description, prompt);
        task.insert(self.pool()).await?;
        Ok(task)
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

        let is_git_repository = self.runtime().git().is_repository(&workspace_path);
        let use_worktree = resolve_use_worktree_mode(is_git_repository, use_worktree);

        let repo_path = workspace_path.clone();
        let repo_path_str = repo_path.to_string_lossy().into_owned();
        let project =
            ProjectRecord::ensure_with_name_hint(self.pool(), &repo_path_str, None).await?;

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

        if reused_existing_run {
            let execution_prompt = provided_prompt.clone().unwrap_or_else(|| task.to_prompt());
            if execution_prompt.trim().is_empty() {
                return Err(RuntimeError::BadRequest("prompt is required"));
            }

            return self.follow_up_execution(run.id, execution_prompt).await;
        }

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

        let (worktree_path, container_ref) = if use_worktree {
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
        } else {
            let path = workspace_path.clone();
            let container = path.to_string_lossy().to_string();
            (path, container)
        };

        let execution_prompt =
            ImageService::canonicalize_worktree_links(&execution_prompt, &worktree_path);

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

        // Copy .chro-context files referenced in the prompt to the worktree.
        // The transcript dump writes to workspace_path, but execution happens in
        // worktree_path. When these differ, the executor cannot read the files.
        if worktree_path != workspace_path {
            copy_context_files_to_worktree(&execution_prompt, &workspace_path, &worktree_path);
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

        sqlx::query(
            "UPDATE task_records SET active_session_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(session.id)
        .bind(task.id)
        .execute(self.pool())
        .await?;

        self.runtime()
            .start_execution(ExecutionStartParams {
                task_run_id: run.id,
                executor_session_id: session.id,
                prompt: execution_prompt.clone(),
                workspace_path: worktree_path.clone(),
                resume_session_id: resume_session_id.clone(),
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
    ) -> Result<ExecutionSessionStart, RuntimeError> {
        self.follow_up_execution_with_options(run_id, prompt, None)
            .await
    }

    async fn follow_up_execution_with_options(
        &self,
        run_id: Uuid,
        prompt: String,
        image_ids: Option<Vec<Uuid>>,
    ) -> Result<ExecutionSessionStart, RuntimeError> {
        if prompt.trim().is_empty() {
            return Err(RuntimeError::BadRequest("prompt is required"));
        }

        let previous_run = TaskRun::get(self.pool(), run_id).await?;
        let task = TaskRecord::get(self.pool(), previous_run.task_id).await?;
        let project = ProjectRecord::get(self.pool(), task.project_id).await?;

        let resume_session_id = self
            .resolve_resume_session_id_for_follow_up(&previous_run)
            .await?;

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
        new_run.executor_label = previous_run.executor_label.clone();
        new_run.executor_action = previous_run.executor_action.clone();
        new_run.branch_name = previous_run.branch_name.clone();
        new_run.target_branch = previous_run.target_branch.clone();
        new_run.container_ref = previous_run.container_ref.clone();
        new_run.workspace_path = previous_run.workspace_path.clone();
        new_run.resume_session_id = resume_session_id.clone();
        new_run.status = RunStatus::Running;
        new_run.started_at = Some(Utc::now());
        new_run.insert(self.pool()).await?;

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

        sqlx::query(
            "UPDATE task_records SET active_session_id = ?, updated_at = datetime('now') WHERE id = ?",
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
                prompt: prompt.clone(),
                workspace_path: workspace_path_buf.clone(),
                resume_session_id,
                force_new_attempt: Some(false),
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
        let entries = TaskRunLog::fetch_entries(self.pool(), previous_run.id).await?;
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
                        .follow_up_execution_with_options(latest_run.id, prompt, image_ids)
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
        })
        .await
        .map(|result| result.execution)
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
        let _ = self
            .runtime()
            .git()
            .commit_all(&worktree_path, &snapshot_message);

        let merge_commit = self
            .runtime()
            .git()
            .merge_changes(
                Path::new(&project.git_repo_path),
                &worktree_path,
                &branch_name,
                &target_branch,
                &merge_message,
            )
            .map_err(RuntimeError::from)?;

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
        let branches = self
            .runtime()
            .git()
            .list_branches(&project.git_repo_path)
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

        let (is_rebase_in_progress, conflicted_files, conflict_op) =
            if let Some(ref path) = worktree_path {
                let in_rebase = self
                    .runtime()
                    .git()
                    .is_rebase_in_progress(path)
                    .unwrap_or(false);
                let conflicts = self
                    .runtime()
                    .git()
                    .get_conflicted_files(path)
                    .unwrap_or_default();
                let op = if conflicts.is_empty() {
                    None
                } else {
                    self.runtime()
                        .git()
                        .detect_conflict_op(path)
                        .unwrap_or(None)
                };
                (in_rebase, conflicts, op)
            } else {
                (false, Vec::new(), None)
            };

        let status = self.runtime().git().get_branch_status(
            &project.git_repo_path,
            &branch_name,
            &target_branch,
        );

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
    let remaining = strip_leading_context_block(prompt.trim());
    remaining
        .lines()
        .filter(|line| !is_image_markdown_line(line.trim()))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn strip_leading_context_block(prompt: &str) -> &str {
    let mut remaining = prompt;
    while let Some(after_context) = remaining.strip_prefix("<context>").and_then(|rest| {
        rest.find("</context>")
            .map(|end| &rest[end + "</context>".len()..])
    }) {
        remaining = after_context.trim_start();
    }
    remaining
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

fn extract_session_id_from_entries(entries: &[LogEntry]) -> Option<String> {
    entries.iter().rev().find_map(|entry| match entry {
        LogEntry::SessionId(id) if !id.trim().is_empty() => Some(id.clone()),
        _ => None,
    })
}

/// Extract `.chro-context/…` relative paths from `<file path="…" />`
/// context tags in the prompt and copy them from `src_root` to `dst_root`.
///
/// This mirrors the image-copy step: the transcript dump is written to the
/// original workspace, but the executor runs inside a worktree that does not
/// share the same directory tree.
fn copy_context_files_to_worktree(prompt: &str, src_root: &Path, dst_root: &Path) {
    let context_dir = image::WORKTREE_IMAGES_DIR;
    let files = extract_context_file_paths(prompt, context_dir);
    if files.is_empty() {
        return;
    }

    if let Err(err) = image::ensure_context_dir(dst_root) {
        warn!(error = %err, "failed to bootstrap context dir in worktree");
        return;
    }

    for relative in &files {
        let src = src_root.join(relative);
        if !src.is_file() {
            continue;
        }
        let dst = dst_root.join(relative);
        if dst.exists() {
            continue;
        }
        if let Some(parent) = dst.parent() {
            if let Err(err) = fs::create_dir_all(parent) {
                warn!(error = %err, path = %parent.display(), "failed to create context dir in worktree");
                continue;
            }
        }
        if let Err(err) = fs::copy(&src, &dst) {
            warn!(
                error = %err,
                src = %src.display(),
                dst = %dst.display(),
                "failed to copy context file to worktree"
            );
        }
    }
}

/// Parse `<file path="…" />` tags and return paths that start with the given
/// context directory prefix.
fn extract_context_file_paths<'a>(prompt: &'a str, context_dir: &str) -> Vec<&'a str> {
    let mut paths = Vec::new();
    let needle = "<file path=\"";
    let mut haystack = prompt;
    while let Some(start) = haystack.find(needle) {
        let after = &haystack[start + needle.len()..];
        if let Some(end) = after.find('"') {
            let path = &after[..end];
            if path.starts_with(context_dir) {
                paths.push(path);
            }
        }
        haystack = &haystack[start + needle.len()..];
    }
    paths
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_context_paths_from_prompt() {
        let prompt = "<context>\n<file path=\".chro-context/sessions/abc.md\" />\n<file path=\"src/main.rs\" />\n</context>\nfix the bug";
        let paths = extract_context_file_paths(prompt, ".chro-context");
        assert_eq!(paths, vec![".chro-context/sessions/abc.md"]);
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
    fn infer_task_title_ignores_leading_images() {
        let prompt = "![img.png](.chro-context/img.png)\nfix the bug";
        assert_eq!(infer_task_title(prompt), "fix the bug");
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
    fn extract_context_paths_empty_when_no_match() {
        let prompt = "just a plain prompt with no context tags";
        let paths = extract_context_file_paths(prompt, ".chro-context");
        assert!(paths.is_empty());
    }

    #[test]
    fn extract_context_paths_multiple() {
        let prompt = "<context>\n<file path=\".chro-context/sessions/a.md\" />\n<file path=\".chro-context/sessions/b.md\" />\n</context>";
        let paths = extract_context_file_paths(prompt, ".chro-context");
        assert_eq!(
            paths,
            vec![".chro-context/sessions/a.md", ".chro-context/sessions/b.md",]
        );
    }

    #[test]
    fn copies_context_files_to_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("workspace");
        let dst = tmp.path().join("worktree");
        let sessions_dir = src.join(".chro-context/sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(sessions_dir.join("run1.md"), "# transcript").unwrap();

        let prompt =
            "<context>\n<file path=\".chro-context/sessions/run1.md\" />\n</context>\ndo the thing";
        copy_context_files_to_worktree(prompt, &src, &dst);

        let copied = dst.join(".chro-context/sessions/run1.md");
        assert!(copied.exists());
        assert_eq!(fs::read_to_string(&copied).unwrap(), "# transcript");

        // .gitignore must be bootstrapped so copied files stay untracked.
        let gitignore = dst.join(".chro-context/.gitignore");
        assert!(gitignore.exists());
        assert_eq!(fs::read_to_string(&gitignore).unwrap(), "*\n");
    }

    #[test]
    fn skip_when_dst_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("workspace");
        let dst = tmp.path().join("worktree");

        let src_sessions = src.join(".chro-context/sessions");
        let dst_sessions = dst.join(".chro-context/sessions");
        fs::create_dir_all(&src_sessions).unwrap();
        fs::create_dir_all(&dst_sessions).unwrap();
        fs::write(src_sessions.join("run1.md"), "new content").unwrap();
        fs::write(dst_sessions.join("run1.md"), "old content").unwrap();

        let prompt = "<context>\n<file path=\".chro-context/sessions/run1.md\" />\n</context>";
        copy_context_files_to_worktree(prompt, &src, &dst);

        assert_eq!(
            fs::read_to_string(dst_sessions.join("run1.md")).unwrap(),
            "old content"
        );
    }

    #[test]
    fn skip_missing_source_file() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("workspace");
        let dst = tmp.path().join("worktree");
        fs::create_dir_all(&src).unwrap();

        let prompt =
            "<context>\n<file path=\".chro-context/sessions/nonexistent.md\" />\n</context>";
        copy_context_files_to_worktree(prompt, &src, &dst);

        assert!(!dst.join(".chro-context/sessions/nonexistent.md").exists());
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
}
