//! pi executor implementation.
//!
//! pi runs as a long-lived `pi --mode rpc` subprocess: chro sends JSON commands
//! on stdin and pi streams responses plus `AgentSessionEvent`s on stdout. A
//! reader task ([`client::PiClient`]) mirrors every line into the synthetic log
//! stream for normalization and watches for the terminal `agent_end` event. The
//! data plane mirrors the Codex executor because pi exposes a first-class
//! embedding protocol.

pub mod auth;
pub mod client;
pub mod models;
pub mod normalize_logs;
pub mod protocol;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use command_group::AsyncCommandGroup;
use derivative::Derivative;
use events::MsgStore;
use log_types::LogEntry;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum_macros::AsRefStr;
use tokio::process::Command;
use ts_rs::TS;

use self::{
    client::{ExitSignalSender, LogWriter, PiClient},
    normalize_logs::PiError,
};
use crate::{
    approvals::ExecutorApprovalService,
    cli_manifest,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, apply_overrides},
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, CancellationToken, ExecutorError, ExecutorExitResult,
        SpawnedChild, StandardCodingAgentExecutor,
    },
    stdout_dup::create_stdout_pipe_writer,
};

/// Returns the pi config home directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`).
pub fn pi_home() -> Option<PathBuf> {
    cli_manifest::resolve_home(&cli_manifest::PI)
}

/// Reasoning depth for the underlying model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

/// pi agent configuration.
#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema, Default)]
#[derivative(Debug, PartialEq)]
pub struct Pi {
    /// Extra text appended to the prompt.
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    /// Provider name (e.g. `anthropic`). Defaults to pi's configured provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model pattern or id. Defaults to pi's configured model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Reasoning depth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    /// Replace the system prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Append text to the system prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    /// Route tool execution through chro's approval flow instead of running
    /// unattended. Defaults to unattended (auto-approve).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals: Option<bool>,
    /// Command overrides.
    #[serde(flatten)]
    pub cmd: CmdOverrides,

    /// Approval service (not serialized).
    #[serde(skip)]
    #[ts(skip)]
    #[schemars(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    approvals_service: Option<Arc<dyn ExecutorApprovalService>>,
}

impl Pi {
    /// Whether tool execution runs unattended (no approval gating).
    fn auto_approve(&self) -> bool {
        !self.approvals.unwrap_or(false)
    }

    fn build_command_builder(
        &self,
        resume_session: Option<&str>,
    ) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::for_manifest(&cli_manifest::PI);
        builder = builder.extend_params(["--mode", "rpc"]);

        if let Some(provider) = &self.provider {
            builder = builder.extend_params(["--provider", provider]);
        }
        if let Some(model) = &self.model {
            builder = builder.extend_params(["--model", model]);
        }
        if let Some(level) = &self.thinking_level {
            builder = builder.extend_params(["--thinking", level.as_ref()]);
        }
        if let Some(system_prompt) = &self.system_prompt {
            builder = builder.extend_params(["--system-prompt", system_prompt]);
        }
        if let Some(append) = &self.append_system_prompt {
            builder = builder.extend_params(["--append-system-prompt", append]);
        }
        if let Some(session_id) = resume_session {
            builder = builder.extend_params(["--session-id", session_id]);
        }

        apply_overrides(builder, &self.cmd)
    }

    async fn spawn_internal(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
        resume_session: Option<&str>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        let command_parts = self
            .build_command_builder(resume_session)?
            .build_initial()?;
        let (program_path, args) = command_parts.into_resolved().await?;

        let mut process = Command::new(&program_path);
        process
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(current_dir)
            .args(&args)
            .env("NODE_NO_WARNINGS", "1")
            .env("NO_COLOR", "1");
        env.apply_to_command(&mut process);

        let mut child = process.group_spawn()?;

        let child_stdout =
            child.inner().stdout.take().ok_or_else(|| {
                ExecutorError::Io(std::io::Error::other("pi process missing stdout"))
            })?;
        let child_stdin =
            child.inner().stdin.take().ok_or_else(|| {
                ExecutorError::Io(std::io::Error::other("pi process missing stdin"))
            })?;

        // Replace the child's stdout with a synthetic pipe the container reads;
        // the reader task writes mapped lines into it.
        let log_stdout = create_stdout_pipe_writer(&mut child)?;
        let log_writer = LogWriter::new(log_stdout);

        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        let exit_signal = ExitSignalSender::new(exit_tx);
        let cancel = CancellationToken::new();

        let client = PiClient::new(
            child_stdin,
            log_writer,
            self.approvals_service.clone(),
            self.auto_approve(),
            cancel.clone(),
        );
        client.spawn_reader(child_stdout, exit_signal.clone());

        // Drive the turn: confirm liveness / surface the session id, then prompt.
        //
        // No task may outlive the pi process while holding a `PiClient`: the
        // client owns the synthetic-stdout writer, and the container blocks on
        // that pipe reaching EOF before it finalizes the run. The reader task
        // drops its handle on process EOF and this driver drops its handle once
        // the prompt is acknowledged, so the writer closes and the run settles.
        // Cancellation is handled by the container (it cancels `cancel`, which
        // unblocks any pending approval wait, then terminates the process).
        tokio::spawn(async move {
            if let Err(err) = client.get_state().await {
                tracing::warn!("pi get_state failed: {err}");
            }
            if let Err(err) = client.prompt(combined_prompt).await {
                let message = err.to_string();
                let pi_error = if looks_like_auth_error(&message) {
                    PiError::auth_required(message)
                } else {
                    PiError::launch_error(message)
                };
                client.log_error(pi_error).await;
                exit_signal.send(ExecutorExitResult::Failure).await;
            }
        });

        Ok(SpawnedChild {
            child: child.into(),
            exit_signal: Some(exit_rx),
            cancel: Some(cancel),
        })
    }
}

fn looks_like_auth_error(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("api key") || lowered.contains("login") || lowered.contains("auth")
}

#[async_trait]
impl StandardCodingAgentExecutor for Pi {
    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals_service = Some(approvals);
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let env = env.clone().with_profile(&self.cmd);
        self.spawn_internal(current_dir, prompt, &env, None).await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let env = env.clone().with_profile(&self.cmd);
        self.spawn_internal(current_dir, prompt, &env, Some(session_id))
            .await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, worktree_path: &Path) {
        normalize_logs::normalize_logs(msg_store, worktree_path);
    }

    fn replay_log_entries(&self, entries: &[LogEntry], worktree_path: &Path) -> Vec<LogEntry> {
        normalize_logs::replay_log_entries(entries, worktree_path)
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        // pi does not expose a chro-writable MCP server config; treat it as
        // MCP-unsupported until that contract is verified.
        None
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        let Some(home) = pi_home() else {
            return AvailabilityInfo::NotFound;
        };

        let auth_path = home.join("auth.json");
        if let Some(timestamp) = pi_logged_in_timestamp(&auth_path) {
            return AvailabilityInfo::LoginDetected {
                last_auth_timestamp: timestamp,
            };
        }

        if home.exists() {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }
}

/// Return the auth.json mtime when pi holds at least one provider credential.
///
/// pi may also run from an env-provided API key with an empty `auth.json`, so an
/// empty object is treated as "installed but not signed in".
fn pi_logged_in_timestamp(auth_path: &Path) -> Option<i64> {
    let contents = std::fs::read_to_string(auth_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let has_credential = parsed.as_object().is_some_and(|map| !map.is_empty());
    if !has_credential {
        return None;
    }
    std::fs::metadata(auth_path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_runs_unattended() {
        assert!(Pi::default().auto_approve());
    }

    #[test]
    fn approvals_variant_gates_tools() {
        let pi = Pi {
            approvals: Some(true),
            ..Pi::default()
        };
        assert!(!pi.auto_approve());
    }

    #[test]
    fn command_builder_uses_rpc_mode_and_flags() {
        let pi = Pi {
            model: Some("anthropic/claude".to_string()),
            thinking_level: Some(ThinkingLevel::High),
            ..Pi::default()
        };
        let params = pi
            .build_command_builder(None)
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(params.windows(2).any(|w| w == ["--mode", "rpc"]));
        assert!(
            params
                .windows(2)
                .any(|w| w == ["--model", "anthropic/claude"])
        );
        assert!(params.windows(2).any(|w| w == ["--thinking", "high"]));
        assert!(!params.iter().any(|p| p == "--session-id"));
    }

    #[test]
    fn follow_up_resumes_session() {
        let params = Pi::default()
            .build_command_builder(Some("sess-1"))
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(params.windows(2).any(|w| w == ["--session-id", "sess-1"]));
    }

    #[test]
    fn thinking_level_serializes_lowercase() {
        assert_eq!(ThinkingLevel::Xhigh.as_ref(), "xhigh");
    }
}
