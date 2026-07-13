use std::{
    collections::HashMap,
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{atomic::AtomicUsize, Arc},
};

use anyhow::{anyhow, Context};
use approvals::Approvals;
use async_trait::async_trait;
use config::Config;
use db::{
    models::{ProjectRecord, TaskMerge, TaskRecord, TaskRun},
    types::{RunStatus, TaskStatus},
    DBService,
};
use diff_stream;
use events::MsgStore;
use executors::{
    BaseCodingAgent, CodingAgent, ExecutionEnv, ExecutionProcess, ExecutorApprovalService,
    ExecutorConfigs, ExecutorExitResult, ExecutorProfileId, NoopExecutorApprovalService,
    RepoContext, StandardCodingAgentExecutor,
};
use futures::{
    stream::{self, BoxStream},
    FutureExt, StreamExt,
};
use git::{DiffTarget, GitService};
use log_types::{Diff, LogEntry};
use runtime::{
    container::{ContainerError, ContainerService},
    ExecutionEvent, ExecutionEventStream, ExecutionStartParams,
};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::{broadcast, oneshot, watch, RwLock},
    task::JoinHandle,
};
use tokio_stream::wrappers::BroadcastStream;
use tracing::{error, warn};
use uuid::Uuid;

use crate::log_writer::{self, ExecutionLogWriter};
use crate::MsgStoreMap;

mod executor_approval_bridge;

use executor_approval_bridge::ExecutorApprovalBridge;

#[derive(Clone)]
pub struct LocalContainerService {
    db: DBService,
    git: GitService,
    msg_stores: MsgStoreMap,
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<ExecutionProcess>>>>>,
    executions: Arc<RwLock<HashMap<Uuid, ExecutionHandle>>>,
    event_channels: Arc<RwLock<HashMap<Uuid, broadcast::Sender<ExecutionEvent>>>>,
    config: Arc<RwLock<Config>>,
    approvals: Approvals<MsgStore>,
    logs_dir: PathBuf,
    worktree_watchers: filesystem::WorktreeWatcherService,
}

struct ExecutionHandle {
    cancel: oneshot::Sender<()>,
    join: JoinHandle<()>,
}

fn task_status_for_terminal_run_status(run_status: RunStatus) -> Option<TaskStatus> {
    match run_status {
        RunStatus::Completed | RunStatus::Cancelled => Some(TaskStatus::Completed),
        RunStatus::Failed => Some(TaskStatus::Failed),
        _ => None,
    }
}

impl LocalContainerService {
    pub fn new(
        db: DBService,
        git: GitService,
        msg_stores: MsgStoreMap,
        config: Arc<RwLock<Config>>,
        approvals: Approvals<MsgStore>,
        logs_dir: PathBuf,
        worktree_watchers: filesystem::WorktreeWatcherService,
    ) -> Self {
        Self {
            db,
            git,
            msg_stores,
            child_store: Arc::new(RwLock::new(HashMap::new())),
            executions: Arc::new(RwLock::new(HashMap::new())),
            event_channels: Arc::new(RwLock::new(HashMap::new())),
            config,
            approvals,
            logs_dir,
            worktree_watchers,
        }
    }

    async fn current_profile(&self) -> ExecutorProfileId {
        self.config.read().await.executor_profile.clone()
    }

    async fn resolve_executor_profile_for_run(
        &self,
        run_id: Uuid,
    ) -> Result<ExecutorProfileId, ContainerError> {
        let run = TaskRun::find_by_id(self.db.pool(), run_id)
            .await?
            .ok_or(ContainerError::TaskRunNotFound(run_id))?;
        if let Some(label) = run.executor_label.as_deref() {
            if let Ok(profile) = serde_json::from_str::<ExecutorProfileId>(label) {
                return Ok(profile);
            }
            warn!(%run_id, executor_label = %label, "[resolve_executor_profile_for_run] invalid executor label");
        }

        let fallback = self.current_profile().await;
        warn!(%run_id, fallback = %fallback, "[resolve_executor_profile_for_run] using default executor profile");
        Ok(fallback)
    }

    /// Create a CodingAgent from the task run's executor profile.
    async fn create_agent_for_run(
        &self,
        run_id: Uuid,
    ) -> Result<(CodingAgent, BaseCodingAgent), ContainerError> {
        let profile_id = self.resolve_executor_profile_for_run(run_id).await?;
        let configs = ExecutorConfigs::get_cached();
        let coding_agent = configs.get_coding_agent_or_default(&profile_id);
        let base_agent = coding_agent.base_agent();
        tracing::debug!(
            profile_id = %profile_id,
            resolved_agent = ?base_agent,
            "[create_agent_for_run] resolved executor profile"
        );
        Ok((coding_agent, base_agent))
    }

    fn collect_workspace_repo_names(workspace_path: &PathBuf) -> Vec<String> {
        std::fs::read_dir(workspace_path)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok))
            .filter_map(|entry| {
                entry
                    .file_type()
                    .ok()
                    .filter(|t| t.is_dir())
                    .map(|_| entry.file_name().to_string_lossy().to_string())
            })
            .collect()
    }

    /// Persist log entries to JSONL file. Does NOT push to MsgStore.
    /// If an active MsgStore exists for this run, entries are pushed there
    /// instead (the background persistence task will write them to file).
    pub async fn append_logs(
        &self,
        task_run_id: Uuid,
        entries: &[LogEntry],
    ) -> Result<(), ContainerError> {
        if entries.is_empty() {
            return Ok(());
        }

        // If run is active, push to MsgStore (background task persists to file).
        let store = {
            let map = self.msg_stores.read().await;
            map.get(&task_run_id).cloned()
        };
        if let Some(store) = store {
            for entry in entries {
                store.push(entry.clone());
            }
            return Ok(());
        }

        // No active execution; write directly to file.
        let mut writer = ExecutionLogWriter::new(&self.logs_dir, task_run_id).await?;
        writer.append_entries(entries).await?;
        Ok(())
    }

    /// Read log entries from the per-run JSONL file.
    pub async fn fetch_logs(&self, task_run_id: Uuid) -> Result<Vec<LogEntry>, ContainerError> {
        Ok(log_writer::read_log_entries(&self.logs_dir, task_run_id).await?)
    }

    pub async fn append_stdout(
        &self,
        task_run_id: Uuid,
        message: impl AsRef<str>,
    ) -> Result<(), ContainerError> {
        self.append_logs(
            task_run_id,
            &[LogEntry::Stdout(message.as_ref().to_string())],
        )
        .await
    }

    /// Auto-commit changes after successful execution.
    /// Commits all changes in the workspace if any exist.
    async fn try_commit_changes(&self, run_id: Uuid, workspace_path: &PathBuf) {
        let message = format!("Auto-commit changes from task run {}", run_id);

        // commit_all runs a blocking git status scan + commit; offload it so it
        // never ties up an async worker thread on large worktrees.
        let git = self.git.clone();
        let workspace = workspace_path.clone();
        let result = runtime::perf::spawn_blocking_instrumented("git.auto_commit", move || {
            git.commit_all(&workspace, &message)
        })
        .await;

        match result {
            Ok(Ok(Some(oid))) => {
                tracing::info!(
                    %run_id,
                    %oid,
                    "[try_commit_changes] committed changes"
                );
            }
            Ok(Ok(None)) => {
                tracing::debug!(
                    %run_id,
                    "[try_commit_changes] no changes to commit"
                );
            }
            Ok(Err(e)) => {
                tracing::warn!(
                    %run_id,
                    error = %e,
                    "[try_commit_changes] failed to commit changes"
                );
            }
            Err(e) => {
                tracing::warn!(
                    %run_id,
                    error = %e,
                    "[try_commit_changes] commit task failed to join"
                );
            }
        }
    }

    async fn mark_run_completion(
        &self,
        run_id: Uuid,
        exit_code: Option<i32>,
    ) -> Result<(), ContainerError> {
        tracing::debug!(
            %run_id,
            ?exit_code,
            "[mark_run_completion] start"
        );

        let status = exit_code
            .map(|code| {
                if code == 0 {
                    RunStatus::Completed
                } else {
                    RunStatus::Failed
                }
            })
            .unwrap_or(RunStatus::Cancelled);

        tracing::debug!(
            %run_id,
            ?status,
            "[mark_run_completion] determined run status"
        );

        let result = sqlx::query(
            "UPDATE task_runs SET status = ?, exit_code = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        )
        .bind(status)
        .bind(exit_code)
        .bind(run_id)
        .execute(self.db.pool())
        .await?;

        tracing::debug!(
            %run_id,
            rows_affected = result.rows_affected(),
            "[mark_run_completion] updated task_runs"
        );

        self.complete_task_execution(run_id, status).await?;

        tracing::info!(
            %run_id,
            ?exit_code,
            ?status,
            "[mark_run_completion] completed"
        );

        Ok(())
    }

    /// Complete task execution by updating task status and clearing active_session_id.
    async fn complete_task_execution(
        &self,
        run_id: Uuid,
        run_status: RunStatus,
    ) -> Result<(), ContainerError> {
        tracing::debug!(
            %run_id,
            ?run_status,
            "[complete_task_execution] start"
        );

        let Some(task_status) = task_status_for_terminal_run_status(run_status) else {
            tracing::debug!(
                %run_id,
                ?run_status,
                "[complete_task_execution] skipping - run status not terminal"
            );
            return Ok(());
        };

        let run = match TaskRun::find_by_id(self.db.pool(), run_id).await? {
            Some(run) => run,
            None => {
                tracing::warn!(
                    %run_id,
                    "[complete_task_execution] task_run not found in DB"
                );
                return Ok(());
            }
        };

        tracing::debug!(
            %run_id,
            task_id = %run.task_id,
            ?task_status,
            "[complete_task_execution] updating task_records"
        );

        let result = sqlx::query(
            "UPDATE task_records
             SET status = ?, active_session_id = NULL, awaiting_input = 0, updated_at = datetime('now')
             WHERE id = ?",
        )
        .bind(task_status)
        .bind(run.task_id)
        .execute(self.db.pool())
        .await?;

        tracing::info!(
            task_id = %run.task_id,
            %run_id,
            ?task_status,
            rows_affected = result.rows_affected(),
            "[complete_task_execution] task_records updated - status and active_session_id cleared"
        );

        Ok(())
    }

    /// Drop the in-memory bookkeeping for a finished run: the child handle, the
    /// execution handle, and the broadcast channel. Removing an absent key is a
    /// no-op, so this is safe to call from any completion path.
    async fn drop_execution_registry(&self, run_id: Uuid) {
        self.child_store.write().await.remove(&run_id);
        self.executions.write().await.remove(&run_id);
        self.event_channels.write().await.remove(&run_id);
    }

    /// Safety-net finalizer for a run whose execution task ended abnormally: an
    /// error bubbled out of [`Self::run_execution_process`], or the task
    /// panicked, before the normal completion path could clear the session
    /// pointer. Forces a still-running run to a failed terminal state, which
    /// clears `active_session_id`/`awaiting_input` (so the sidebar's running
    /// indicator resolves immediately via the task-records change hook), and
    /// drops the in-memory registry.
    ///
    /// Without this, an abnormal exit left `active_session_id` set until the
    /// next server restart or housekeeping sweep, leaving the session row stuck
    /// "running".
    async fn finalize_failed_execution(&self, run_id: Uuid) {
        // Only force a failed status when the run is still Running; a run that
        // already reached a terminal state (e.g. Cancelled) keeps its real
        // outcome while we still clear any dangling session pointer below.
        match TaskRun::find_by_id(self.db.pool(), run_id).await {
            Ok(Some(run)) if run.status == RunStatus::Running => {
                if let Err(err) = self.mark_run_completion(run_id, Some(1)).await {
                    error!(%run_id, error = %err, "[finalize_failed_execution] mark_run_completion failed");
                }
            }
            Ok(Some(run)) => {
                if let Err(err) = self.complete_task_execution(run_id, run.status).await {
                    error!(%run_id, error = %err, "[finalize_failed_execution] complete_task_execution failed");
                }
            }
            Ok(None) => {
                warn!(%run_id, "[finalize_failed_execution] task_run not found");
            }
            Err(err) => {
                error!(%run_id, error = %err, "[finalize_failed_execution] task_run lookup failed");
            }
        }
        self.drop_execution_registry(run_id).await;
    }

    async fn run_execution_process(
        &self,
        params: ExecutionStartParams,
        events_tx: broadcast::Sender<ExecutionEvent>,
        mut cancel_rx: oneshot::Receiver<()>,
        msg_store: Arc<MsgStore>,
    ) -> Result<(), ContainerError> {
        let run_id = params.task_run_id;
        let process_started_at = std::time::Instant::now();
        let is_follow_up = params.resume_session_id.is_some();
        tracing::info!(
            task_run_id = %run_id,
            workspace_path = %params.workspace_path.display(),
            prompt = %params.prompt,
            "[run_execution_process] starting execution"
        );

        let (mut agent, agent_kind) = self.create_agent_for_run(run_id).await?;
        tracing::debug!(
            agent_kind = ?agent_kind,
            "[run_execution_process] using coding agent"
        );

        let approvals_service: Arc<dyn ExecutorApprovalService> = if matches!(
            agent_kind,
            BaseCodingAgent::Codex | BaseCodingAgent::ClaudeCode | BaseCodingAgent::Pi
        ) {
            let task_id = TaskRun::find_by_id(self.db.pool(), params.task_run_id)
                .await?
                .map(|run| run.task_id);
            ExecutorApprovalBridge::new(
                self.approvals.clone(),
                params.task_run_id,
                task_id,
                self.db.clone(),
            )
        } else {
            Arc::new(NoopExecutorApprovalService)
        };
        agent.use_approvals(approvals_service.clone());

        let repo_names = Self::collect_workspace_repo_names(&params.workspace_path);
        let repo_context = RepoContext::new(params.workspace_path.clone(), repo_names);
        let env = ExecutionEnv::new(repo_context, false, String::new());

        let spawned = if let Some(session_id) = params.resume_session_id.as_ref() {
            agent
                .spawn_follow_up(
                    &params.workspace_path,
                    &params.prompt,
                    session_id,
                    None,
                    &env,
                )
                .await
                .context("failed to spawn agent follow-up")?
        } else {
            agent
                .spawn(&params.workspace_path, &params.prompt, &env)
                .await
                .context("failed to spawn agent")?
        };

        let mut child = spawned.child;
        let exit_signal = spawned.exit_signal;
        let executor_cancel = spawned.cancel;

        let stdout = child.take_stdout();
        let stderr = child.take_stderr();

        runtime::perf::record_event(
            "execution_spawned",
            serde_json::json!({
                "task_run_id": run_id,
                "agent_kind": format!("{agent_kind:?}"),
                "is_follow_up": is_follow_up,
                "resume_session_id": params.resume_session_id,
            }),
        );

        let child_arc = Arc::new(RwLock::new(child));
        {
            let mut store = self.child_store.write().await;
            store.insert(run_id, child_arc.clone());
        }

        let executor_session_id = params.executor_session_id;

        // Background task: persist MsgStore entries to JSONL file asynchronously.
        // This task also captures external_session_id inline when it appears in
        // the stream, ensuring it is available in the DB before any follow-up.
        let persistence_task = spawn_log_persistence_task(
            self.logs_dir.clone(),
            run_id,
            msg_store.clone(),
            self.db.pool().clone(),
            executor_session_id,
        );

        msg_store.push(LogEntry::UserPrompt(params.prompt.clone()));

        let workspace_path = params.workspace_path.clone();
        agent.normalize_logs(msg_store.clone(), &workspace_path);

        let (completion_tx, mut completion_rx) = watch::channel(false);

        // Shared counters for stdout/stderr diagnostics
        let stdout_lines = Arc::new(AtomicUsize::new(0));
        let stderr_tail: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        const STDERR_TAIL_CAPACITY: usize = 10;
        let saw_result_message = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result_summary: Arc<std::sync::Mutex<Option<Value>>> =
            Arc::new(std::sync::Mutex::new(None));

        let events_stdout = events_tx.clone();
        let msg_store_stdout = msg_store.clone();
        let stdout_lines_counter = stdout_lines.clone();
        let saw_result_clone = saw_result_message.clone();
        let result_summary_writer = result_summary.clone();
        let stdout_task = tokio::spawn(async move {
            if let Some(stdout) = stdout {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    stdout_lines_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

                    msg_store_stdout.push(LogEntry::Stdout(line.clone()));

                    let payload = serde_json::from_str(&line)
                        .unwrap_or(serde_json::Value::String(line.clone()));
                    tracing::debug!(
                        %run_id,
                        "[stdout_task] sending stream event"
                    );
                    let _ = events_stdout.send(ExecutionEvent::Stream {
                        id: run_id,
                        event: payload.clone(),
                    });

                    if let Some(msg_type) = payload.get("type").and_then(|v| v.as_str()) {
                        if msg_type == "result" {
                            tracing::info!(%run_id, "[stdout_task] received result message, signaling completion");
                            saw_result_clone.store(true, std::sync::atomic::Ordering::Relaxed);
                            // Capture key fields from the result for diagnostics
                            if let Ok(mut guard) = result_summary_writer.lock() {
                                let mut summary = serde_json::Map::new();
                                if let Some(v) = payload.get("subtype") {
                                    summary.insert("subtype".into(), v.clone());
                                }
                                if let Some(v) = payload.get("is_error") {
                                    summary.insert("is_error".into(), v.clone());
                                }
                                if let Some(v) = payload.get("cost_usd") {
                                    summary.insert("cost_usd".into(), v.clone());
                                }
                                if let Some(v) = payload.get("duration_ms") {
                                    summary.insert("duration_ms".into(), v.clone());
                                }
                                if let Some(v) = payload.get("duration_api_ms") {
                                    summary.insert("duration_api_ms".into(), v.clone());
                                }
                                if let Some(v) = payload.get("num_turns") {
                                    summary.insert("num_turns".into(), v.clone());
                                }
                                if let Some(v) = payload.get("session_id") {
                                    summary.insert("session_id".into(), v.clone());
                                }
                                if let Some(v) = payload.get("stop_reason") {
                                    summary.insert("stop_reason".into(), v.clone());
                                }
                                if let Some(v) = payload.get("error") {
                                    summary.insert("error".into(), v.clone());
                                }
                                if let Some(v) = payload.get("total_cost_usd") {
                                    summary.insert("total_cost_usd".into(), v.clone());
                                }
                                // Capture result text preview (first 200 chars)
                                if let Some(result_text) =
                                    payload.get("result").and_then(|v| v.as_str())
                                {
                                    let preview: String = result_text.chars().take(200).collect();
                                    summary.insert(
                                        "result_preview".into(),
                                        serde_json::Value::String(preview),
                                    );
                                }
                                *guard = Some(serde_json::Value::Object(summary));
                            }
                            let _ = completion_tx.send(true);
                        }
                    }
                }
            }
        });

        let events_stderr = events_tx.clone();
        let msg_store_stderr = msg_store.clone();
        let stderr_tail_writer = stderr_tail.clone();
        let stderr_task = tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }

                    // Keep last N stderr lines for diagnostics
                    if let Ok(mut tail) = stderr_tail_writer.lock() {
                        if tail.len() >= STDERR_TAIL_CAPACITY {
                            tail.remove(0);
                        }
                        tail.push(line.clone());
                    }

                    msg_store_stderr.push(LogEntry::Stderr(line.clone()));

                    let _ = events_stderr.send(ExecutionEvent::Stderr {
                        id: run_id,
                        data: line,
                    });
                }
            }
        });

        use futures::FutureExt;
        let mut exit_signal_future = exit_signal
            .map(|rx| rx.boxed())
            .unwrap_or_else(|| std::future::pending().boxed());

        enum ExitReason {
            Cancelled,
            ExitSignalSuccess,
            ExitSignalFailure,
            CompletionSignaled,
            ProcessExited,
        }

        impl ExitReason {
            fn as_str(&self) -> &'static str {
                match self {
                    ExitReason::Cancelled => "cancelled",
                    ExitReason::ExitSignalSuccess => "exit_signal_success",
                    ExitReason::ExitSignalFailure => "exit_signal_failure",
                    ExitReason::CompletionSignaled => "completion_signaled",
                    ExitReason::ProcessExited => "process_exited",
                }
            }
        }

        let (exit_reason, wait_result) = tokio::select! {
            _ = &mut cancel_rx => {
                tracing::info!(%run_id, "[run_execution_process] cancel requested");
                if let Some(cancel) = executor_cancel.as_ref() {
                    cancel.cancel();
                }
                let mut child_guard = child_arc.write().await;
                let _ = child_guard.terminate().await;
                let wait_result = child_guard.wait().await;
                (ExitReason::Cancelled, wait_result)
            }
            exit_result = &mut exit_signal_future => {
                let reason = match exit_result {
                    Ok(ExecutorExitResult::Success) => {
                        tracing::info!(%run_id, "[run_execution_process] exit signal received (success), killing process");
                        ExitReason::ExitSignalSuccess
                    }
                    Ok(ExecutorExitResult::Failure) => {
                        tracing::info!(%run_id, "[run_execution_process] exit signal received (failure), killing process");
                        ExitReason::ExitSignalFailure
                    }
                    Err(_) => {
                        tracing::info!(%run_id, "[run_execution_process] exit signal channel closed, assuming success");
                        ExitReason::ExitSignalSuccess
                    }
                };
                let mut child_guard = child_arc.write().await;
                let _ = child_guard.terminate().await;
                let wait_result = child_guard.wait().await;
                (reason, wait_result)
            }
            _result = async {
                loop {
                    if completion_rx.changed().await.is_err() {
                        return; // Sender dropped
                    }
                    if *completion_rx.borrow() {
                        return; // Completion signaled
                    }
                }
            } => {
                tracing::info!(%run_id, "[run_execution_process] completion signaled, killing process");
                if let Some(cancel) = executor_cancel.as_ref() {
                    cancel.cancel();
                }
                let mut child_guard = child_arc.write().await;
                if let Err(e) = child_guard.terminate().await {
                    tracing::warn!(%run_id, error = %e, "[run_execution_process] kill failed (process may have already exited)");
                }
                let wait_result = child_guard.wait().await;
                tracing::debug!(%run_id, success = wait_result.is_ok(), "[run_execution_process] wait after kill");
                (ExitReason::CompletionSignaled, wait_result)
            }
            status = async {
                let mut child_guard = child_arc.write().await;
                child_guard.wait().await
            } => {
                tracing::debug!(%run_id, success = status.is_ok(), "[run_execution_process] child.wait() completed");
                (ExitReason::ProcessExited, status)
            },
        };

        tracing::debug!(%run_id, success = wait_result.is_ok(), "[run_execution_process] select! completed");

        let process_exit = match wait_result {
            Ok(exit) => exit,
            Err(e) => {
                tracing::error!(%run_id, error = %e, "[run_execution_process] select! returned error");
                return Err(ContainerError::Other(anyhow!("process wait failed: {}", e)));
            }
        };

        let exit_code = match exit_reason {
            ExitReason::CompletionSignaled | ExitReason::ExitSignalSuccess => {
                tracing::debug!(%run_id, "[run_execution_process] treating as successful completion");
                Some(0) // Treat as successful completion
            }
            ExitReason::ExitSignalFailure => {
                tracing::debug!(%run_id, "[run_execution_process] treating as failure (exit signal indicated failure)");
                Some(1) // Treat as failure
            }
            ExitReason::Cancelled => {
                tracing::debug!(%run_id, "[run_execution_process] treating as cancelled");
                None // Will be marked as Cancelled
            }
            ExitReason::ProcessExited => {
                let code = process_exit.code;
                tracing::debug!(%run_id, ?code, "[run_execution_process] using process exit code");
                code
            }
        };

        let signal = process_exit.signal.clone();

        tracing::debug!(%run_id, ?exit_code, ?signal, "[run_execution_process] waiting for stdout/stderr tasks");

        let _ = stdout_task.await;
        let _ = stderr_task.await;

        // Collect diagnostics for the perf event
        let total_stdout_lines = stdout_lines.load(std::sync::atomic::Ordering::Relaxed);
        let stderr_last_lines: Vec<String> =
            stderr_tail.lock().map(|t| t.clone()).unwrap_or_default();
        let had_result = saw_result_message.load(std::sync::atomic::Ordering::Relaxed);
        let result_info = result_summary.lock().ok().and_then(|g| g.clone());
        let elapsed_ms = process_started_at.elapsed().as_secs_f64() * 1000.0;

        runtime::perf::record_event(
            "execution_process_exited",
            serde_json::json!({
                "task_run_id": run_id,
                "exit_reason": exit_reason.as_str(),
                "exit_code": exit_code,
                "signal": signal,
                "is_follow_up": is_follow_up,
                "duration_ms": (elapsed_ms * 100.0).round() / 100.0,
                "stdout_lines": total_stdout_lines,
                "had_result_message": had_result,
                "result_summary": result_info,
                "stderr_last_lines": stderr_last_lines,
            }),
        );

        // Warn when execution errored before reaching the API (num_turns=0)
        let is_pre_api_failure = result_info
            .as_ref()
            .map(|v| {
                let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                let num_turns = v.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(1);
                is_error && num_turns == 0
            })
            .unwrap_or(false);
        if is_pre_api_failure {
            let stop_reason = result_info
                .as_ref()
                .and_then(|v| v.get("stop_reason"))
                .and_then(|v| v.as_str())
                .unwrap_or("null");
            let error_detail = result_info.as_ref().and_then(|v| v.get("error"));
            tracing::warn!(
                %run_id,
                %stop_reason,
                ?error_detail,
                is_follow_up,
                stderr_lines = stderr_last_lines.len(),
                stdout_lines = total_stdout_lines,
                "[run_execution_process] execution failed before reaching API (num_turns=0)"
            );
        }

        // Override exit_code to failure when the executor result reports is_error
        let exit_code = if exit_code == Some(0) {
            let is_result_error = result_info
                .as_ref()
                .and_then(|v| v.get("is_error"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if is_result_error {
                tracing::warn!(
                    %run_id,
                    "[run_execution_process] result has is_error=true, overriding exit_code to 1"
                );
                Some(1)
            } else {
                exit_code
            }
        } else {
            exit_code
        };

        tracing::debug!(%run_id, "[run_execution_process] appending Finished log");

        msg_store.push(LogEntry::Finished);

        // Wait for the background persistence task to flush all entries to file.
        // The Finished entry closes the broadcast channel for this task, so the
        // persistence task will naturally terminate.
        if let Err(e) = persistence_task.await {
            tracing::error!(%run_id, error = %e, "[run_execution_process] log persistence task panicked");
        }

        tracing::debug!(%run_id, "[run_execution_process] sending Exit event");

        let _ = events_tx.send(ExecutionEvent::Exit {
            id: run_id,
            code: exit_code,
            signal: signal.clone(),
        });

        tracing::debug!(%run_id, "[run_execution_process] calling mark_run_completion");

        // Mark the run complete (which clears the task's `active_session_id`)
        // BEFORE the auto-commit. The agent process is already gone by this
        // point, so the turn is done — the sidebar's "running" spinner must
        // resolve now. The auto-commit below is a full `git status` + `add` +
        // `commit` that can take many seconds (and stall on a large or locked
        // worktree); awaiting it before clearing `active_session_id` left the
        // sidebar spinning long after the conversation already showed the turn
        // finished. Completion visibility must not be gated on housekeeping.
        if let Err(e) = self.mark_run_completion(run_id, exit_code).await {
            tracing::error!(%run_id, error = %e, "[run_execution_process] mark_run_completion failed");
            return Err(e);
        }

        if exit_code == Some(0) {
            self.try_commit_changes(run_id, &params.workspace_path)
                .await;
        }

        self.drop_execution_registry(run_id).await;

        Ok(())
    }
}

/// Spawn a background task that subscribes to a MsgStore's broadcast channel
/// and writes each log entry to a JSONL file. When a `SessionId` entry is
/// received, the task also updates `external_session_id` in the database
/// immediately — this eliminates the race condition where a follow-up request
/// arrives before the session ID has been persisted. The task terminates when
/// the broadcast channel is closed (i.e., after `LogEntry::Finished` is pushed
/// and the MsgStore is dropped or no more senders remain).
fn spawn_log_persistence_task(
    logs_dir: PathBuf,
    task_run_id: Uuid,
    msg_store: Arc<MsgStore>,
    db_pool: sqlx::SqlitePool,
    executor_session_id: Uuid,
) -> JoinHandle<()> {
    // Subscribe synchronously before spawning so that entries pushed between
    // spawn and task execution are not lost.
    let rx = msg_store.subscribe();
    tokio::spawn(async move {
        let mut writer = match ExecutionLogWriter::new(&logs_dir, task_run_id).await {
            Ok(w) => w,
            Err(e) => {
                error!(
                    %task_run_id,
                    error = %e,
                    "failed to create log writer"
                );
                return;
            }
        };

        let mut last_session_id: Option<String> = None;
        let mut rx = rx;
        loop {
            match rx.recv().await {
                Ok(entry) => {
                    let is_finished = matches!(entry, LogEntry::Finished);

                    // Capture external_session_id inline as soon as it appears
                    // in the stream so persisted session state stays current.
                    if let LogEntry::SessionId(ref ext_session_id) = entry {
                        if last_session_id.as_deref() != Some(ext_session_id.as_str()) {
                            if let Err(err) = sqlx::query(
                                "UPDATE task_sessions SET external_session_id = ?, updated_at = datetime('now') WHERE id = ?",
                            )
                            .bind(ext_session_id.as_str())
                            .bind(executor_session_id)
                            .execute(&db_pool)
                            .await
                            {
                                warn!(
                                    %executor_session_id,
                                    error = %err,
                                    "failed to update external_session_id from stream"
                                );
                            }
                            last_session_id = Some(ext_session_id.clone());
                        }
                    }

                    if let Err(e) = writer.append_entry(&entry).await {
                        error!(
                            %task_run_id,
                            error = %e,
                            "failed to persist log entry"
                        );
                    }
                    if is_finished {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(
                        %task_run_id,
                        skipped = n,
                        "log persistence lagged, entries lost"
                    );
                }
            }
        }
    })
}

#[async_trait]
impl ContainerService for LocalContainerService {
    async fn start_execution(&self, params: ExecutionStartParams) -> Result<(), ContainerError> {
        {
            let executions = self.executions.read().await;
            if executions.contains_key(&params.task_run_id) {
                return Err(ContainerError::ExecutionAlreadyRunning(params.task_run_id));
            }
        }

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let service = self.clone();
        let events_tx = {
            let mut map = self.event_channels.write().await;
            map.entry(params.task_run_id)
                .or_insert_with(|| broadcast::channel(256).0)
                .clone()
        };

        let run_id = params.task_run_id;

        // Create the MsgStore before spawning so it is guaranteed to exist
        // when the API response reaches the frontend (which may immediately
        // open a log-stream WebSocket for this run).
        let msg_store = Arc::new(MsgStore::new());
        {
            let mut map = self.msg_stores.write().await;
            map.insert(run_id, msg_store.clone());
        }

        // Gate the worker on registration so it can never finalize-and-remove
        // its own execution handle before this function has inserted it (the
        // spawned task may start on another runtime thread the instant it is
        // spawned, and a fast failure would otherwise race the insert below).
        let (registered_tx, registered_rx) = oneshot::channel::<()>();

        let handle = tokio::spawn(async move {
            if registered_rx.await.is_err() {
                return;
            }

            // Run the execution and finalize on EVERY terminal outcome. The
            // normal completion path inside `run_execution_process` clears the
            // session pointer itself; catching the error and panic paths here
            // guarantees `active_session_id` is never left set, so the sidebar's
            // running indicator always resolves without a restart.
            let outcome = AssertUnwindSafe(service.run_execution_process(
                params,
                events_tx.clone(),
                cancel_rx,
                msg_store,
            ))
            .catch_unwind()
            .await;

            let failure = match outcome {
                Ok(Ok(())) => None,
                Ok(Err(err)) => Some(err.to_string()),
                Err(_) => Some("execution task panicked".to_string()),
            };

            if let Some(message) = failure {
                error!(%run_id, error = %message, "execution failed; finalizing run");
                runtime::perf::record_event(
                    "execution_process_error",
                    serde_json::json!({
                        "task_run_id": run_id,
                        "error": message,
                    }),
                );
                let _ = events_tx.send(ExecutionEvent::Error {
                    id: run_id,
                    message,
                });
                service.finalize_failed_execution(run_id).await;
            }
        });

        {
            let mut executions = self.executions.write().await;
            executions.insert(
                run_id,
                ExecutionHandle {
                    cancel: cancel_tx,
                    join: handle,
                },
            );
        }
        // Release the worker now that its handle is registered.
        let _ = registered_tx.send(());
        Ok(())
    }

    async fn cancel_execution(&self, task_run_id: Uuid) -> Result<(), ContainerError> {
        use std::time::Duration;

        let update_result = sqlx::query(
            "UPDATE task_runs SET status = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        )
        .bind(RunStatus::Cancelled)
        .bind(task_run_id)
        .execute(self.db.pool())
        .await;

        if let Err(e) = update_result {
            tracing::warn!(
                "Failed to update task run status to Cancelled for {}: {}",
                task_run_id,
                e
            );
        }

        if let Ok(Some(run)) = TaskRun::find_by_id(self.db.pool(), task_run_id).await {
            let result = sqlx::query(
                "UPDATE task_records
                 SET status = ?, active_session_id = NULL, awaiting_input = 0, updated_at = datetime('now')
                 WHERE id = ?",
            )
            .bind(TaskStatus::Completed)
            .bind(run.task_id)
            .execute(self.db.pool())
            .await;

            if let Err(e) = result {
                tracing::warn!(
                    "Failed to clear active session for task {}: {}",
                    run.task_id,
                    e
                );
            }
        }

        let handle = {
            let mut executions = self.executions.write().await;
            executions.remove(&task_run_id)
        };

        if let Some(handle) = handle {
            let _ = handle.cancel.send(());

            let graceful_result = tokio::time::timeout(Duration::from_secs(5), handle.join).await;

            match graceful_result {
                Ok(Ok(())) => {
                    tracing::debug!(
                        "Process {} exited gracefully after cancel signal",
                        task_run_id
                    );
                }
                Ok(Err(e)) => {
                    tracing::info!("Error waiting for process {}: {}", task_run_id, e);
                }
                Err(_) => {
                    tracing::debug!(
                        "Graceful shutdown timed out for process {}, will force kill",
                        task_run_id
                    );
                }
            }
        }

        let child = {
            let mut store = self.child_store.write().await;
            store.remove(&task_run_id)
        };

        if let Some(child_arc) = child {
            let mut child_guard = child_arc.write().await;
            if let Err(e) = child_guard.terminate().await {
                tracing::error!(
                    "Failed to terminate process for task_run_id {}: {}",
                    task_run_id,
                    e
                );
            }
        }

        self.event_channels.write().await.remove(&task_run_id);

        if let Some(msg_store) = self.msg_stores.write().await.remove(&task_run_id) {
            msg_store.push(LogEntry::Finished);
        }

        Ok(())
    }

    async fn cleanup_task_run_artifacts(&self, task_run_id: Uuid) -> Result<(), ContainerError> {
        self.event_channels.write().await.remove(&task_run_id);
        self.msg_stores.write().await.remove(&task_run_id);
        log_writer::delete_log_file(&self.logs_dir, task_run_id).await?;
        Ok(())
    }

    async fn execution_event_stream(
        &self,
        task_run_id: Uuid,
    ) -> Result<ExecutionEventStream, ContainerError> {
        let receiver = {
            let map = self.event_channels.read().await;
            map.get(&task_run_id)
                .ok_or(ContainerError::ExecutionNotRunning(task_run_id))?
                .subscribe()
        };
        Ok(BroadcastStream::new(receiver))
    }

    async fn cleanup_orphan_executions(&self) -> Result<(), ContainerError> {
        // Local executions die with the server, and a Pending run only exists
        // inside the create window of a start request, so any run still
        // running or pending at startup is an orphan (e.g. a create request
        // whose provisioning was cut short by a crash).
        let affected = sqlx::query(
            "UPDATE task_runs SET status = ?, completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now') WHERE status IN (?, ?)",
        )
        .bind(RunStatus::Failed)
        .bind(RunStatus::Running)
        .bind(RunStatus::Pending)
        .execute(self.db.pool())
        .await?;
        if affected.rows_affected() > 0 {
            tracing::info!(
                count = affected.rows_affected(),
                "marked orphaned executions as failed"
            );
        }

        let task_affected = sqlx::query(
            "UPDATE task_records
             SET status = ?, active_session_id = NULL, updated_at = datetime('now')
             WHERE active_session_id IN (
                 SELECT ts.id
                 FROM task_sessions ts
                 JOIN task_runs tr ON ts.task_run_id = tr.id
                 WHERE tr.status != ?
             )",
        )
        .bind(TaskStatus::Failed)
        .bind(RunStatus::Running)
        .execute(self.db.pool())
        .await?;
        if task_affected.rows_affected() > 0 {
            tracing::info!(
                count = task_affected.rows_affected(),
                "finalized orphaned tasks: status set to Failed and active_session_id cleared"
            );
        }

        // A task can also be stranded in-progress with no session pointer at
        // all (a create that never reached the session insert). Nothing is
        // running at startup, so every remaining in-progress task is stale.
        let stranded_tasks = sqlx::query(
            "UPDATE task_records SET status = ?, active_session_id = NULL, awaiting_input = 0, updated_at = datetime('now') WHERE status = ?",
        )
        .bind(TaskStatus::Failed)
        .bind(TaskStatus::InProgress)
        .execute(self.db.pool())
        .await?;
        if stranded_tasks.rows_affected() > 0 {
            tracing::info!(
                count = stranded_tasks.rows_affected(),
                "finalized stranded in-progress tasks with no running execution"
            );
        }

        Ok(())
    }

    async fn stream_diff(
        &self,
        task_run_id: Uuid,
        stats_only: bool,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, ContainerError> {
        let run = TaskRun::find_by_id(self.db.pool(), task_run_id)
            .await?
            .ok_or(ContainerError::TaskRunNotFound(task_run_id))?;
        let project_repo_path = self.get_project_repo_path(run.task_id).await?;
        let latest_merge = TaskMerge::find_latest_by_task(self.db.pool(), run.task_id).await?;

        let is_ahead = match (run.branch_name.as_deref(), run.target_branch.as_deref()) {
            (Some(branch), Some(target_branch)) => {
                let git = self.git.clone();
                let repo_path = project_repo_path.clone();
                let branch = branch.to_string();
                let target_branch = target_branch.to_string();
                tokio::task::spawn_blocking(move || {
                    git.get_branch_status(&repo_path, &branch, &target_branch)
                        .map(|(ahead, _)| ahead > 0)
                        .unwrap_or(false)
                })
                .await?
            }
            _ => false,
        };

        let is_clean = self
            .is_container_clean(run.workspace_path.as_deref())
            .await?;

        if let Some(merge) = latest_merge {
            if let Some(commit) = merge.merge_commit() {
                if is_clean && !is_ahead {
                    return self
                        .create_merged_diff_stream(&project_repo_path, commit, stats_only)
                        .await;
                }
            }
        }

        let workspace = run
            .workspace_path
            .clone()
            .ok_or(ContainerError::BadRequest("workspace path missing"))?;
        let workspace_path = PathBuf::from(workspace);
        if !workspace_path.exists() {
            return Err(ContainerError::BadRequest("workspace path missing"));
        }
        let base_commit = match (run.branch_name.as_deref(), run.target_branch.as_deref()) {
            (Some(branch), Some(target_branch)) => {
                let git = self.git.clone();
                let repo_path = project_repo_path.clone();
                let branch = branch.to_string();
                let target_branch = target_branch.to_string();
                tokio::task::spawn_blocking(move || {
                    git.get_base_commit(&repo_path, &branch, &target_branch)
                })
                .await??
            }
            _ => {
                let git = self.git.clone();
                let wp = workspace_path.clone();
                tokio::task::spawn_blocking(move || git.head_commit(&wp)).await??
            }
        };
        let events = self.worktree_watchers.subscribe(workspace_path.clone());
        let handle = diff_stream::create(
            self.git.clone(),
            workspace_path,
            base_commit,
            stats_only,
            events,
        )
        .await?;

        let msg_store_stream: BoxStream<'static, Result<LogEntry, std::io::Error>> = {
            let store = {
                let map = self.msg_stores.read().await;
                map.get(&task_run_id).cloned()
            };

            if let Some(store) = store {
                store
                    .history_plus_stream()
                    .filter_map(|entry| async move {
                        match &entry {
                            LogEntry::JsonPatch(value) if patch_targets_live_panels(value) => {
                                Some(Ok(entry))
                            }
                            _ => None,
                        }
                    })
                    .boxed()
            } else {
                stream::empty::<Result<LogEntry, std::io::Error>>().boxed()
            }
        };

        let diff_stream = handle.boxed();
        Ok(stream::select(msg_store_stream, diff_stream).boxed())
    }
}

impl LocalContainerService {
    async fn get_project_repo_path(&self, task_id: Uuid) -> Result<PathBuf, ContainerError> {
        let task = TaskRecord::get(self.db.pool(), task_id).await?;
        let project = ProjectRecord::get(self.db.pool(), task.project_id).await?;
        Ok(PathBuf::from(project.git_repo_path))
    }

    async fn is_container_clean(
        &self,
        workspace_path: Option<&str>,
    ) -> Result<bool, ContainerError> {
        if let Some(path) = workspace_path {
            let path = PathBuf::from(path);
            if path.exists() {
                let git = self.git.clone();
                return Ok(
                    tokio::task::spawn_blocking(move || git.is_worktree_clean(&path)).await??,
                );
            }
        }
        Ok(true)
    }

    async fn create_merged_diff_stream(
        &self,
        project_repo_path: &PathBuf,
        merge_commit_id: &str,
        stats_only: bool,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, ContainerError> {
        // get_diffs walks the commit tree via git2; offload so building a merged
        // diff stream never blocks an async worker thread.
        let git = self.git.clone();
        let repo_path = project_repo_path.clone();
        let commit_sha = merge_commit_id.to_string();
        let diffs = tokio::task::spawn_blocking(move || {
            git.get_diffs(
                DiffTarget::Commit {
                    repo_path: &repo_path,
                    commit_sha: &commit_sha,
                },
                None,
            )
        })
        .await??;

        let cumulative = Arc::new(AtomicUsize::new(0));
        let entries = diffs
            .into_iter()
            .map(|mut diff| {
                diff_stream::apply_stream_omit_policy(&mut diff, &cumulative, stats_only);
                diff_to_entry(diff)
            })
            .collect::<Vec<_>>();

        let stream = stream::iter(entries.into_iter().map(Ok::<_, std::io::Error>))
            .chain(stream::once(async {
                Ok::<_, std::io::Error>(LogEntry::Finished)
            }))
            .boxed();

        Ok(stream)
    }
}

fn patch_targets_live_panels(value: &Value) -> bool {
    let Some(ops) = value.as_array() else {
        return false;
    };

    ops.iter().any(|op| {
        op.get("path")
            .and_then(Value::as_str)
            .map(|path| path.starts_with("/diffs/") || path.starts_with("/approvals/"))
            .unwrap_or(false)
    })
}

fn diff_to_entry(diff: Diff) -> LogEntry {
    let key = diff
        .path_key()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".into());
    let patch = serde_json::json!([{
        "op": "add",
        "path": format!("/diffs/{}", escape_json_pointer_segment(&key)),
        "value": { "type": "DIFF", "content": diff }
    }]);
    LogEntry::JsonPatch(patch)
}

fn escape_json_pointer_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use db::models::{AgentProfile, TaskSession};

    /// Build a `LocalContainerService` backed by a throwaway on-disk SQLite db.
    /// Only the fields the finalizer touches (`db`, the in-memory registries)
    /// matter here; the rest are constructed with cheap defaults.
    async fn build_service() -> (LocalContainerService, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let db = DBService::new_with_path(temp.path().join("test.db"))
            .await
            .unwrap();
        let msg_stores: MsgStoreMap = Arc::new(RwLock::new(HashMap::new()));
        let approvals = Approvals::new(msg_stores.clone());
        let config = Arc::new(RwLock::new(Config::default()));
        let service = LocalContainerService::new(
            db,
            GitService::new(),
            msg_stores,
            config,
            approvals,
            temp.path().join("logs"),
            filesystem::WorktreeWatcherService::default(),
        );
        (service, temp)
    }

    /// Seed a project + task + agent profile + session + run, with the task's
    /// `active_session_id` pointing at the live session and `awaiting_input`
    /// set, mirroring a running task. The run is inserted with `run_status`.
    /// Returns `(task_id, run_id)`.
    async fn seed_running_task(
        service: &LocalContainerService,
        run_status: RunStatus,
    ) -> (Uuid, Uuid) {
        let pool = service.db.pool();

        let project = ProjectRecord::new("finalize-test", "/tmp/finalize-test");
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(project.id)
        .bind(&project.name)
        .bind(&project.git_repo_path)
        .execute(pool)
        .await
        .unwrap();

        // Insert the task with no session pointer first: the FK is circular
        // (task_records.active_session_id -> task_sessions.id -> task_records.id),
        // so the session pointer is wired up last.
        let task = TaskRecord::new(project.id, "stuck running task", None);
        task.insert(pool).await.unwrap();

        let agent_id = AgentProfile::ensure_default_desktop_profile(pool)
            .await
            .unwrap();

        let mut run = TaskRun::new_local(task.id, None);
        run.status = run_status;
        run.insert(pool).await.unwrap();

        let session = TaskSession::new(task.id, agent_id, Some("prompt".to_string()));
        sqlx::query(
            "INSERT INTO task_sessions (id, task_id, task_run_id, agent_profile_id, prompt, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(session.id)
        .bind(session.task_id)
        .bind(run.id)
        .bind(session.agent_profile_id)
        .bind(&session.prompt)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "UPDATE task_records SET active_session_id = ?, awaiting_input = 1 WHERE id = ?",
        )
        .bind(session.id)
        .bind(task.id)
        .execute(pool)
        .await
        .unwrap();

        (task.id, run.id)
    }

    /// The core regression: when an execution ends abnormally, the finalizer
    /// must clear the task's `active_session_id`/`awaiting_input` (so the
    /// sidebar's running indicator resolves) and drop the in-memory registry,
    /// rather than leaving the row stuck "running" until a restart.
    #[tokio::test]
    async fn finalize_failed_execution_clears_running_session() {
        let (service, _temp) = build_service().await;
        let (task_id, run_id) = seed_running_task(&service, RunStatus::Running).await;

        // Seed the in-memory registry as if the run were live.
        service
            .event_channels
            .write()
            .await
            .insert(run_id, broadcast::channel(4).0);
        service.executions.write().await.insert(
            run_id,
            ExecutionHandle {
                cancel: oneshot::channel().0,
                join: tokio::spawn(async {}),
            },
        );

        service.finalize_failed_execution(run_id).await;

        let task_after = TaskRecord::find_by_id(service.db.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task_after.active_session_id, None);
        assert_eq!(task_after.status, TaskStatus::Failed);
        assert!(!task_after.awaiting_input);

        let run_after = TaskRun::find_by_id(service.db.pool(), run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run_after.status, RunStatus::Failed);

        assert!(!service.event_channels.read().await.contains_key(&run_id));
        assert!(!service.executions.read().await.contains_key(&run_id));
    }

    /// A run that already reached a terminal state through another path (e.g.
    /// cancellation) keeps its real outcome; the finalizer must not clobber it
    /// to Failed, but it must still clear the dangling session pointer.
    #[tokio::test]
    async fn finalize_failed_execution_preserves_terminal_run_status() {
        let (service, _temp) = build_service().await;
        let (task_id, run_id) = seed_running_task(&service, RunStatus::Cancelled).await;

        service.finalize_failed_execution(run_id).await;

        let run_after = TaskRun::find_by_id(service.db.pool(), run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run_after.status, RunStatus::Cancelled);

        let task_after = TaskRecord::find_by_id(service.db.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task_after.active_session_id, None);
        assert_eq!(task_after.status, TaskStatus::Completed);
    }

    /// Seed a project + task + run with the given statuses and NO session row,
    /// mirroring a create request that was cancelled mid-provisioning (task
    /// inserted, run never launched). Returns `(task_id, run_id)`.
    async fn seed_task_without_session(
        service: &LocalContainerService,
        task_status: TaskStatus,
        run_status: RunStatus,
    ) -> (Uuid, Uuid) {
        let pool = service.db.pool();

        let project = ProjectRecord::new("orphan-test", "/tmp/orphan-test");
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(project.id)
        .bind(&project.name)
        .bind(&project.git_repo_path)
        .execute(pool)
        .await
        .unwrap();

        let task = TaskRecord::new(project.id, "aborted create", None);
        task.insert(pool).await.unwrap();
        TaskRecord::update_status(pool, task.id, task_status)
            .await
            .unwrap();

        let mut run = TaskRun::new_local(task.id, None);
        run.status = run_status;
        run.insert(pool).await.unwrap();

        (task.id, run.id)
    }

    /// The zombie-session regression: a create request aborted mid-provisioning
    /// (client navigated away before detached handlers existed) left a Pending
    /// run and an in-progress task with no session. Startup cleanup must
    /// finalize both, or the session stays a spinner forever across restarts.
    #[tokio::test]
    async fn cleanup_finalizes_pending_orphan_run_and_stranded_task() {
        let (service, _temp) = build_service().await;
        let (task_id, run_id) =
            seed_task_without_session(&service, TaskStatus::InProgress, RunStatus::Pending).await;

        service.cleanup_orphan_executions().await.unwrap();

        let run_after = TaskRun::find_by_id(service.db.pool(), run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run_after.status, RunStatus::Failed);
        assert!(run_after.completed_at.is_some());

        let task_after = TaskRecord::find_by_id(service.db.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task_after.status, TaskStatus::Failed);
        assert_eq!(task_after.active_session_id, None);
        assert!(!task_after.awaiting_input);
    }

    /// Running orphans keep being swept (pre-existing behavior).
    #[tokio::test]
    async fn cleanup_still_fails_running_orphan_runs() {
        let (service, _temp) = build_service().await;
        let (task_id, run_id) = seed_running_task(&service, RunStatus::Running).await;

        service.cleanup_orphan_executions().await.unwrap();

        let run_after = TaskRun::find_by_id(service.db.pool(), run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run_after.status, RunStatus::Failed);

        let task_after = TaskRecord::find_by_id(service.db.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task_after.status, TaskStatus::Failed);
        assert_eq!(task_after.active_session_id, None);
    }

    /// Terminal state is untouched: completed work must not be rewritten as
    /// failed by the startup sweep.
    #[tokio::test]
    async fn cleanup_leaves_completed_runs_and_tasks_alone() {
        let (service, _temp) = build_service().await;
        let (task_id, run_id) =
            seed_task_without_session(&service, TaskStatus::Completed, RunStatus::Completed).await;

        service.cleanup_orphan_executions().await.unwrap();

        let run_after = TaskRun::find_by_id(service.db.pool(), run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run_after.status, RunStatus::Completed);

        let task_after = TaskRecord::find_by_id(service.db.pool(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task_after.status, TaskStatus::Completed);
    }

    #[test]
    fn cancelled_run_marks_task_completed() {
        assert_eq!(
            task_status_for_terminal_run_status(RunStatus::Cancelled),
            Some(TaskStatus::Completed)
        );
    }

    #[test]
    fn terminal_run_status_maps_to_task_status() {
        assert_eq!(
            task_status_for_terminal_run_status(RunStatus::Completed),
            Some(TaskStatus::Completed)
        );
        assert_eq!(
            task_status_for_terminal_run_status(RunStatus::Failed),
            Some(TaskStatus::Failed)
        );
        assert_eq!(
            task_status_for_terminal_run_status(RunStatus::Pending),
            None
        );
        assert_eq!(
            task_status_for_terminal_run_status(RunStatus::Running),
            None
        );
    }
}
