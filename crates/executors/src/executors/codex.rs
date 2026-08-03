//! Codex executor implementation for OpenAI's Codex agent.
//!
//! This module provides the integration with OpenAI's Codex CLI agent through
//! the `codex app-server` JSON-RPC interface.

pub mod client;
pub mod jsonrpc;
pub mod mcp_approval;
pub mod normalize_logs;
pub mod session;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use codex_app_server_protocol::{
    AskForApproval as CodexAskForApproval, SandboxMode as CodexSandboxMode, ThreadForkParams,
    ThreadStartParams,
};
use command_group::AsyncCommandGroup;
use derivative::Derivative;
use events::MsgStore;
use log_types::LogEntry;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use strum_macros::AsRefStr;
use tokio::process::Command;
use ts_rs::TS;

use self::{
    client::{AppServerClient, LogWriter},
    jsonrpc::ExitSignalSender,
    normalize_logs::normalize_logs,
};
use crate::{
    approvals::ExecutorApprovalService,
    cli_manifest,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, CommandParts, apply_overrides},
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, CancellationToken, ExecutorError, ExecutorExitResult,
        SpawnedChild, StandardCodingAgentExecutor,
    },
    spawn::Invocation,
    stdout_dup::create_stdout_pipe_writer,
};

/// Returns the Codex home directory.
///
/// Resolved from the Codex CLI manifest (`CODEX_HOME` env var, otherwise
/// `~/.codex`). Returns `None` when the user has no home directory.
pub fn codex_home() -> Option<PathBuf> {
    cli_manifest::resolve_home(&cli_manifest::CODEX)
}

fn fork_params_from(thread_id: String, params: ThreadStartParams) -> ThreadForkParams {
    ThreadForkParams {
        thread_id,
        model: params.model,
        model_provider: params.model_provider,
        cwd: params.cwd,
        approval_policy: params.approval_policy,
        sandbox: params.sandbox,
        config: params.config,
        base_instructions: params.base_instructions,
        developer_instructions: params.developer_instructions,
        service_tier: params.service_tier,
        // Chro only needs the forked thread id before starting the next turn.
        // Omitting history also keeps newly-added ThreadItem variants in a newer
        // app-server from breaking an older client's response decoder.
        exclude_turns: true,
        ..Default::default()
    }
}

/// Sandbox policy modes for Codex
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum SandboxMode {
    Auto,
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// Determines when the user is consulted to approve Codex actions.
///
/// - `UnlessTrusted`: Read-only commands are auto-approved. Everything else will
///   ask the user to approve.
/// - `OnFailure`: All commands run in a restricted sandbox initially. If a
///   command fails, the user is asked to approve execution without the sandbox.
/// - `OnRequest`: The model decides when to ask the user for approval.
/// - `Never`: Commands never ask for approval. Commands that fail in the
///   restricted sandbox are not retried.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum AskForApproval {
    UnlessTrusted,
    OnFailure,
    OnRequest,
    Never,
}

/// Reasoning effort for the underlying model
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
}

/// Model reasoning summary style
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummary {
    Auto,
    Concise,
    Detailed,
    None,
}

/// Format for model reasoning summaries
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummaryFormat {
    None,
    Experimental,
}

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Codex {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_for_approval: Option<AskForApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oss: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary: Option<ReasoningSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary_format: Option<ReasoningSummaryFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_apply_patch_tool: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,

    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

impl Codex {
    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::for_manifest(&cli_manifest::CODEX);
        builder = builder.extend_params(["app-server"]);
        if self.oss.unwrap_or(false) {
            builder = builder.extend_params(["--oss"]);
        }

        apply_overrides(builder, &self.cmd)
    }

    fn build_new_conversation_params(&self, cwd: &Path) -> ThreadStartParams {
        let sandbox = match self.sandbox.as_ref() {
            None | Some(SandboxMode::Auto) => Some(CodexSandboxMode::WorkspaceWrite),
            Some(SandboxMode::ReadOnly) => Some(CodexSandboxMode::ReadOnly),
            Some(SandboxMode::WorkspaceWrite) => Some(CodexSandboxMode::WorkspaceWrite),
            Some(SandboxMode::DangerFullAccess) => Some(CodexSandboxMode::DangerFullAccess),
        };

        let approval_policy = match self.ask_for_approval.as_ref() {
            None if matches!(self.sandbox.as_ref(), None | Some(SandboxMode::Auto)) => {
                Some(CodexAskForApproval::OnRequest)
            }
            None => None,
            Some(AskForApproval::UnlessTrusted) => Some(CodexAskForApproval::UnlessTrusted),
            Some(AskForApproval::OnFailure) => Some(CodexAskForApproval::OnFailure),
            Some(AskForApproval::OnRequest) => Some(CodexAskForApproval::OnRequest),
            Some(AskForApproval::Never) => Some(CodexAskForApproval::Never),
        };

        let mut config = self.build_config_overrides();
        if !matches!(approval_policy, None | Some(CodexAskForApproval::Never)) {
            let overrides = config.get_or_insert_with(HashMap::new);
            overrides.insert(
                "features.default_mode_request_user_input".to_string(),
                Value::Bool(true),
            );
            overrides.insert(
                "suppress_unstable_features_warning".to_string(),
                Value::Bool(true),
            );
        }

        ThreadStartParams {
            model: self.model.clone(),
            cwd: Some(cwd.to_string_lossy().to_string()),
            approval_policy,
            sandbox,
            config,
            base_instructions: self.base_instructions.clone(),
            model_provider: self.model_provider.clone(),
            developer_instructions: self.developer_instructions.clone(),
            persist_extended_history: true,
            ..Default::default()
        }
    }

    fn build_config_overrides(&self) -> Option<HashMap<String, Value>> {
        let mut overrides = HashMap::new();

        if let Some(effort) = &self.model_reasoning_effort {
            overrides.insert(
                "model_reasoning_effort".to_string(),
                Value::String(effort.as_ref().to_string()),
            );
        }

        if let Some(summary) = &self.model_reasoning_summary {
            overrides.insert(
                "model_reasoning_summary".to_string(),
                Value::String(summary.as_ref().to_string()),
            );
        }

        if let Some(format) = &self.model_reasoning_summary_format
            && format != &ReasoningSummaryFormat::None
        {
            overrides.insert(
                "model_reasoning_summary_format".to_string(),
                Value::String(format.as_ref().to_string()),
            );
        }

        if let Some(include_apply_patch_tool) = self.include_apply_patch_tool {
            overrides.insert(
                "include_apply_patch_tool".to_string(),
                Value::Bool(include_apply_patch_tool),
            );
        }

        if let Some(compact_prompt) = &self.compact_prompt {
            overrides.insert(
                "compact_prompt".to_string(),
                Value::String(compact_prompt.clone()),
            );
        }

        if let Some(profile) = &self.profile {
            overrides.insert("profile".to_string(), Value::String(profile.clone()));
        }

        if overrides.is_empty() {
            None
        } else {
            Some(overrides)
        }
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
        command_parts: CommandParts,
        resume_session: Option<&str>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        let Invocation {
            program: program_path,
            args,
        } = command_parts.into_resolved().await?;

        let mut process = Command::new(program_path);
        process
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(current_dir)
            .args(&args)
            .env("NODE_NO_WARNINGS", "1")
            .env("NO_COLOR", "1")
            .env("RUST_LOG", "error");
        env.apply_to_command(&mut process);

        let mut child = process.group_spawn()?;

        let child_stdout = child.inner().stdout.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdout"))
        })?;
        let child_stdin = child.inner().stdin.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdin"))
        })?;

        let new_stdout = create_stdout_pipe_writer(&mut child)?;
        let (exit_signal_tx, exit_signal_rx) = tokio::sync::oneshot::channel();

        let params = self.build_new_conversation_params(current_dir);
        let resume_session = resume_session.map(|s| s.to_string());
        let auto_approve = matches!(
            (&self.sandbox, &self.ask_for_approval),
            (Some(SandboxMode::DangerFullAccess), None)
        );
        let approvals = self.approvals.clone();
        let cancel = CancellationToken::new();
        let cancel_for_client = cancel.clone();
        tokio::spawn(async move {
            let exit_signal_tx = ExitSignalSender::new(exit_signal_tx);
            let log_writer = LogWriter::new(new_stdout);
            if let Err(err) = Self::launch_codex_app_server(
                params,
                resume_session,
                combined_prompt,
                child_stdout,
                child_stdin,
                log_writer.clone(),
                exit_signal_tx.clone(),
                approvals,
                auto_approve,
                cancel_for_client,
            )
            .await
            {
                match &err {
                    ExecutorError::Io(io_err)
                        if io_err.kind() == std::io::ErrorKind::BrokenPipe =>
                    {
                        return;
                    }
                    ExecutorError::AuthRequired(message) => {
                        log_writer
                            .log_raw(&normalize_logs::Error::auth_required(message.clone()).raw())
                            .await
                            .ok();
                        exit_signal_tx
                            .send_exit_signal(ExecutorExitResult::Failure)
                            .await;
                        return;
                    }
                    _ => {
                        tracing::error!("Codex spawn error: {}", err);
                        log_writer
                            .log_raw(&normalize_logs::Error::launch_error(err.to_string()).raw())
                            .await
                            .ok();
                    }
                }
                exit_signal_tx
                    .send_exit_signal(ExecutorExitResult::Failure)
                    .await;
            }
        });

        Ok(SpawnedChild {
            child: child.into(),
            exit_signal: Some(exit_signal_rx),
            cancel: Some(cancel),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn launch_codex_app_server(
        conversation_params: ThreadStartParams,
        resume_session: Option<String>,
        combined_prompt: String,
        child_stdout: tokio::process::ChildStdout,
        child_stdin: tokio::process::ChildStdin,
        log_writer: LogWriter,
        exit_signal_tx: ExitSignalSender,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        auto_approve: bool,
        cancel: CancellationToken,
    ) -> Result<(), ExecutorError> {
        let client = AppServerClient::new(log_writer, approvals, auto_approve, cancel);
        let rpc_peer =
            jsonrpc::JsonRpcPeer::spawn(child_stdin, child_stdout, client.clone(), exit_signal_tx);
        client.connect(rpc_peer);
        client.initialize().await?;
        let auth_status = client.get_auth_status().await?;
        if auth_status.auth_method.is_none() {
            return Err(ExecutorError::AuthRequired(
                "Codex authentication required".to_string(),
            ));
        }
        match resume_session {
            None => {
                let params = conversation_params;
                let response = client.new_conversation(params).await?;
                let conversation_id = response.thread.id;
                client.register_session(&conversation_id).await?;
                client
                    .send_user_message(conversation_id, combined_prompt)
                    .await?;
            }
            Some(session_id) => {
                let response = client
                    .fork_conversation(fork_params_from(session_id, conversation_params))
                    .await?;
                tracing::debug!("forked Codex thread, response {:?}", response);
                let conversation_id = response.thread.id;
                client.register_session(&conversation_id).await?;
                client
                    .send_user_message(conversation_id, combined_prompt)
                    .await?;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for Codex {
    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self.build_command_builder()?.build_initial()?;
        let env = env.clone().with_profile(&self.cmd);
        self.spawn(current_dir, prompt, &env, command_parts, None)
            .await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self.build_command_builder()?.build_follow_up(&[])?;
        let env = env.clone().with_profile(&self.cmd);
        self.spawn(current_dir, prompt, &env, command_parts, Some(session_id))
            .await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, worktree_path: &Path) {
        normalize_logs(msg_store, worktree_path);
    }

    fn replay_log_entries(&self, entries: &[LogEntry], worktree_path: &Path) -> Vec<LogEntry> {
        normalize_logs::replay_log_entries(entries, worktree_path)
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        codex_home().map(|home| home.join("config.toml"))
    }

    async fn get_availability_info(&self) -> AvailabilityInfo {
        if let Some(timestamp) = codex_home()
            .and_then(|home| std::fs::metadata(home.join("auth.json")).ok())
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
        {
            return AvailabilityInfo::LoginDetected {
                last_auth_timestamp: timestamp,
            };
        }

        let mcp_config_found = self
            .default_mcp_config_path()
            .map(|p| p.exists())
            .unwrap_or(false);

        let installation_indicator_found = codex_home()
            .map(|home| home.join("version.json").exists())
            .unwrap_or(false);

        if mcp_config_found || installation_indicator_found {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fork_params_preserve_model_override() {
        let params = ThreadStartParams {
            model: Some("gpt-5.6-terra".to_string()),
            ..Default::default()
        };

        let fork = fork_params_from("thread-1".to_string(), params);

        assert_eq!(fork.thread_id, "thread-1");
        assert_eq!(fork.model.as_deref(), Some("gpt-5.6-terra"));
        assert!(fork.exclude_turns);
    }
}
