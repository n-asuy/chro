use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicUsize, Arc},
};

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use anyhow::{anyhow, Context};
use approvals::Approvals;
use async_trait::async_trait;
use config::Config;
use db::{
    models::{ProjectRecord, TaskMerge, TaskRecord, TaskRun, TaskRunLog},
    types::{RunStatus, TaskStatus},
    DBService,
};
use diff_stream;
use events::MsgStore;
use executors::{
    BaseCodingAgent, CodingAgent, ExecutionEnv, ExecutorApprovalService, ExecutorConfigs,
    ExecutorExitResult, ExecutorProfileId, NoopExecutorApprovalService, PermissionMode,
    PermissionRuntimeConfig, RepoContext, StandardCodingAgentExecutor,
};
use futures::{
    stream::{self, BoxStream},
    StreamExt,
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
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};
use uuid::Uuid;

use crate::log_writer::{self, ExecutionLogWriter};
use crate::MsgStoreMap;

mod claude_agent;
mod command;
mod executor_approval_bridge;

use claude_agent::{ClaudeAgentClient, ClaudeLogEmitter, ClaudeProtocolPeer};
use command_group::AsyncGroupChild;
use executor_approval_bridge::ExecutorApprovalBridge;

#[derive(Clone)]
pub struct LocalContainerService {
    db: DBService,
    git: GitService,
    msg_stores: MsgStoreMap,
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<AsyncGroupChild>>>>>,
    executions: Arc<RwLock<HashMap<Uuid, ExecutionHandle>>>,
    event_channels: Arc<RwLock<HashMap<Uuid, broadcast::Sender<ExecutionEvent>>>>,
    config: Arc<RwLock<Config>>,
    approvals: Approvals<MsgStore>,
    logs_dir: PathBuf,
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

    /// Create a CodingAgent and get permission config from the task run's executor profile.
    async fn create_agent_for_run(
        &self,
        run_id: Uuid,
    ) -> Result<(CodingAgent, BaseCodingAgent, PermissionRuntimeConfig), ContainerError> {
        let profile_id = self.resolve_executor_profile_for_run(run_id).await?;
        let configs = ExecutorConfigs::get_cached();
        let coding_agent = configs.get_coding_agent_or_default(&profile_id);
        let base_agent = coding_agent.base_agent();
        tracing::debug!(
            profile_id = %profile_id,
            resolved_agent = ?base_agent,
            "[create_agent_for_run] resolved executor profile"
        );
        let permission_mode = match &coding_agent {
            CodingAgent::ClaudeCode(claude) => claude.permission_mode(),
            _ => PermissionMode::BypassPermissions,
        };
        let permission = PermissionRuntimeConfig::new(permission_mode);
        Ok((coding_agent, base_agent, permission))
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

    /// Read log entries from JSONL file, with SQLite fallback for legacy data.
    pub async fn fetch_logs(&self, task_run_id: Uuid) -> Result<Vec<LogEntry>, ContainerError> {
        let entries = log_writer::read_log_entries(&self.logs_dir, task_run_id).await?;
        if !entries.is_empty() {
            return Ok(entries);
        }
        // Fallback: read from SQLite for runs persisted before the migration.
        Ok(TaskRunLog::fetch_entries(self.db.pool(), task_run_id).await?)
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

        match self.git.commit_all(workspace_path, &message) {
            Ok(Some(oid)) => {
                tracing::info!(
                    %run_id,
                    %oid,
                    "[try_commit_changes] committed changes"
                );
            }
            Ok(None) => {
                tracing::debug!(
                    %run_id,
                    "[try_commit_changes] no changes to commit"
                );
            }
            Err(e) => {
                tracing::warn!(
                    %run_id,
                    error = %e,
                    "[try_commit_changes] failed to commit changes"
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
             SET status = ?, active_session_id = NULL, updated_at = datetime('now')
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

        let (mut agent, agent_kind, permission) = self.create_agent_for_run(run_id).await?;
        tracing::debug!(
            agent_kind = ?agent_kind,
            "[run_execution_process] using coding agent"
        );

        let approvals_service: Arc<dyn ExecutorApprovalService> = if matches!(
            agent_kind,
            BaseCodingAgent::Codex | BaseCodingAgent::ClaudeCode
        ) {
            ExecutorApprovalBridge::new(self.approvals.clone(), params.task_run_id)
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

        let stdout = child.inner().stdout.take();
        let stderr = child.inner().stderr.take();
        let stdin = child.inner().stdin.take();

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

        let control_peer = if matches!(agent_kind, BaseCodingAgent::ClaudeCode) {
            match stdin {
                Some(stdin) => {
                    let approval_cancel = executor_cancel
                        .clone()
                        .unwrap_or_else(CancellationToken::new);
                    let client = ClaudeAgentClient::new(
                        approvals_service.clone(),
                        permission.enabled,
                        approval_cancel,
                    );
                    let logger = ClaudeLogEmitter::new(self.clone(), params.task_run_id);
                    let peer = ClaudeProtocolPeer::new(stdin, client, logger, permission.clone());
                    peer.initialize().await?;
                    msg_store.push(LogEntry::UserPrompt(params.prompt.clone()));
                    peer.send_user_message(&params.prompt).await?;
                    Some(peer)
                }
                None => {
                    return Err(ContainerError::Other(anyhow!("Claude CLI stdin missing")));
                }
            }
        } else {
            msg_store.push(LogEntry::UserPrompt(params.prompt.clone()));
            None
        };

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

        let control_peer_stdout = control_peer.clone();
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

                    if let Some(peer) = control_peer_stdout.as_ref() {
                        match peer.try_consume_line(&line).await {
                            Ok(true) => continue,
                            Ok(false) => {}
                            Err(err) => {
                                warn!(error = %err, "failed to process control message");
                                continue;
                            }
                        }
                    }

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
                let _ = command::kill_process_group(&mut child_guard).await;
                let wait_result = child_guard.wait().await;
                (ExitReason::Cancelled, wait_result.map_err(std::io::Error::from))
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
                let _ = command::kill_process_group(&mut child_guard).await;
                let wait_result = child_guard.wait().await;
                (reason, wait_result.map_err(std::io::Error::from))
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
                if let Err(e) = command::kill_process_group(&mut child_guard).await {
                    tracing::warn!(%run_id, error = %e, "[run_execution_process] kill failed (process may have already exited)");
                }
                let wait_result = child_guard.wait().await;
                tracing::debug!(%run_id, success = wait_result.is_ok(), "[run_execution_process] wait after kill");
                (ExitReason::CompletionSignaled, wait_result.map_err(std::io::Error::from))
            }
            status = async {
                let mut child_guard = child_arc.write().await;
                child_guard.wait().await
            } => {
                tracing::debug!(%run_id, success = status.is_ok(), "[run_execution_process] child.wait() completed");
                (ExitReason::ProcessExited, status.map_err(std::io::Error::from))
            },
        };

        tracing::debug!(%run_id, success = wait_result.is_ok(), "[run_execution_process] select! completed");

        let process_status = match wait_result {
            Ok(s) => s,
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
                let code = process_status.code();
                tracing::debug!(%run_id, ?code, "[run_execution_process] using process exit code");
                code
            }
        };

        #[cfg(unix)]
        let signal = process_status.signal().map(|sig| sig.to_string());
        #[cfg(not(unix))]
        let signal: Option<String> = None;

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

        if exit_code == Some(0) {
            self.try_commit_changes(run_id, &params.workspace_path)
                .await;
        }

        if let Err(e) = self.mark_run_completion(run_id, exit_code).await {
            tracing::error!(%run_id, error = %e, "[run_execution_process] mark_run_completion failed");
            return Err(e);
        }

        self.child_store.write().await.remove(&run_id);
        self.executions.write().await.remove(&run_id);
        self.event_channels.write().await.remove(&run_id);

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

        let handle = tokio::spawn(async move {
            if let Err(err) = service
                .run_execution_process(params, events_tx.clone(), cancel_rx, msg_store)
                .await
            {
                error!(error = %err, "execution failed");
                runtime::perf::record_event(
                    "execution_process_error",
                    serde_json::json!({
                        "task_run_id": run_id,
                        "error": err.to_string(),
                    }),
                );
                let _ = events_tx.send(ExecutionEvent::Error {
                    id: run_id,
                    message: err.to_string(),
                });
            }
        });

        let mut executions = self.executions.write().await;
        executions.insert(
            run_id,
            ExecutionHandle {
                cancel: cancel_tx,
                join: handle,
            },
        );
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
                 SET status = ?, active_session_id = NULL, updated_at = datetime('now')
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
            if let Err(e) = command::kill_process_group(&mut child_guard).await {
                tracing::error!(
                    "Failed to kill process group for task_run_id {}: {}",
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
        let affected = sqlx::query(
            "UPDATE task_runs SET status = ?, completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now') WHERE status = ?",
        )
        .bind(RunStatus::Failed)
        .bind(RunStatus::Running)
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
            (Some(branch), Some(target_branch)) => self
                .git
                .get_branch_status(&project_repo_path, branch, target_branch)
                .map(|(ahead, _)| ahead > 0)
                .unwrap_or(false),
            _ => false,
        };

        let is_clean = self
            .is_container_clean(run.workspace_path.as_deref())
            .await?;

        if let Some(merge) = latest_merge {
            if let Some(commit) = merge.merge_commit() {
                if is_clean && !is_ahead {
                    return self.create_merged_diff_stream(&project_repo_path, commit, stats_only);
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
                self.git
                    .get_base_commit(&project_repo_path, branch, target_branch)?
            }
            _ => self.git.head_commit(&workspace_path)?,
        };
        let handle =
            diff_stream::create(self.git.clone(), workspace_path, base_commit, stats_only).await?;

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
                return Ok(self.git.is_worktree_clean(&path)?);
            }
        }
        Ok(true)
    }

    fn create_merged_diff_stream(
        &self,
        project_repo_path: &PathBuf,
        merge_commit_id: &str,
        stats_only: bool,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, ContainerError> {
        let diffs = self.git.get_diffs(
            DiffTarget::Commit {
                repo_path: project_repo_path,
                commit_sha: merge_commit_id,
            },
            None,
        )?;

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
