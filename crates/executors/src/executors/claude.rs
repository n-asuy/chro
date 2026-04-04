//! Claude Code agent implementation.

mod processor;
pub mod types;

pub use processor::{ClaudeLogProcessor, HistoryStrategy};
pub use types::{
    ApprovalStatus, ClaudeContentBlockDelta, ClaudeContentItem, ClaudeJson, ClaudeMessage,
    ClaudeStreamEvent, ClaudeToolData,
};

use std::{path::Path, process::Stdio, sync::Arc};

use async_trait::async_trait;
use command_group::AsyncCommandGroup;
use derivative::Derivative;
use events::MsgStore;
use log_types::LogEntry;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;

use crate::{
    apply_overrides,
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandBuildError, CommandBuilder},
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, ExecutorError, SpawnedChild, StandardCodingAgentExecutor,
    },
    profile::PermissionMode,
};

/// Claude Code agent configuration.
#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct ClaudeCode {
    /// Extra text appended to the prompt.
    #[serde(default)]
    pub append_prompt: AppendPrompt,

    /// Enable plan mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<bool>,

    /// Enable approvals mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals: Option<bool>,

    /// Model to use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// Skip all permissions (dangerous).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dangerously_skip_permissions: Option<bool>,

    /// Command overrides.
    #[serde(flatten)]
    #[ts(skip)]
    #[schemars(skip)]
    pub cmd: CmdOverrides,

    /// Approval service (not serialized).
    #[serde(skip)]
    #[ts(skip)]
    #[schemars(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    approvals_service: Option<Arc<dyn ExecutorApprovalService>>,
}

impl Default for ClaudeCode {
    fn default() -> Self {
        Self {
            append_prompt: AppendPrompt::default(),
            plan: None,
            approvals: None,
            model: None,
            dangerously_skip_permissions: Some(true),
            cmd: CmdOverrides::default(),
            approvals_service: None,
        }
    }
}

impl ClaudeCode {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_plan_mode(mut self, enabled: bool) -> Self {
        self.plan = Some(enabled);
        self
    }

    pub fn with_approvals(mut self, enabled: bool) -> Self {
        self.approvals = Some(enabled);
        self
    }

    /// Get the permission mode based on configuration.
    pub fn permission_mode(&self) -> PermissionMode {
        if self.plan.unwrap_or(false) {
            PermissionMode::Plan
        } else if self.approvals.unwrap_or(false) {
            PermissionMode::Default
        } else {
            PermissionMode::BypassPermissions
        }
    }

    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::new("claude").params([
            "--print",
            "--verbose",
            "--output-format=stream-json",
            "--input-format=stream-json",
            "--include-partial-messages",
        ]);

        let plan = self.plan.unwrap_or(false);
        let approvals = self.approvals.unwrap_or(false);

        if plan || approvals {
            builder = builder.extend_params(["--permission-prompt-tool=stdio"]);
            builder = builder.extend_params([format!(
                "--permission-mode={}",
                PermissionMode::BypassPermissions.as_cli_flag()
            )]);
        }

        if self.dangerously_skip_permissions.unwrap_or(false) && !plan && !approvals {
            builder = builder.extend_params(["--dangerously-skip-permissions"]);
        }

        if let Some(model) = &self.model {
            builder = builder.extend_params(["--model", model]);
        }

        apply_overrides(builder, &self.cmd)
    }

    async fn spawn_internal(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
        follow_up_args: Option<&[String]>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let builder = self.build_command_builder()?;
        let command_parts = if let Some(args) = follow_up_args {
            builder.build_follow_up(args)?
        } else {
            builder.build_initial()?
        };

        let (program_path, args) = command_parts.into_resolved().await?;
        let combined_prompt = self.append_prompt.combine_prompt(prompt);

        tracing::info!(
            program = %program_path.display(),
            args = ?args,
            current_dir = %current_dir.display(),
            is_follow_up = follow_up_args.is_some(),
            "[ClaudeCode::spawn_internal] spawning CLI"
        );

        let mut command = Command::new(&program_path);
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(current_dir)
            .args(&args);
        env.apply_to_command(&mut command);

        if let Some(path) = build_claude_path_env() {
            command.env("PATH", path);
        }

        let child = command.group_spawn()?;

        let _ = combined_prompt; // Will be used by container

        Ok(SpawnedChild {
            child,
            exit_signal: None,
            cancel: None,
        })
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for ClaudeCode {
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
        reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut args = vec!["--resume".to_string(), session_id.to_string()];

        if let Some(uuid) = reset_to_message_id {
            args.push("--resume-session-at".to_string());
            args.push(uuid.to_string());
        }

        let env = env.clone().with_profile(&self.cmd);
        self.spawn_internal(current_dir, prompt, &env, Some(&args))
            .await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, worktree_path: &Path) {
        use log_types::EntryIndexProvider;
        let history = msg_store.history();
        let entry_index = EntryIndexProvider::start_from_history(&history);
        ClaudeLogProcessor::process_logs(
            msg_store,
            worktree_path,
            entry_index,
            HistoryStrategy::Default,
        );
    }

    fn replay_log_entries(&self, entries: &[LogEntry], worktree_path: &Path) -> Vec<LogEntry> {
        ClaudeLogProcessor::normalize_log_entries(entries, &worktree_path.to_string_lossy())
    }

    fn default_mcp_config_path(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|home| home.join(".claude.json"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        let config_path = dirs::home_dir().map(|home| home.join(".claude.json"));
        let config_exists = config_path.as_ref().map(|p| p.exists()).unwrap_or(false);

        if !config_exists {
            return AvailabilityInfo::NotFound;
        }

        // Verify actual login state via `claude auth status`.
        // Both ~/.claude.json and Keychain credentials persist after logout,
        // so file/token existence checks are unreliable.
        match check_claude_auth_status() {
            Some(true) => {
                let timestamp = config_path
                    .and_then(|p| std::fs::metadata(p).ok())
                    .and_then(|m| m.modified().ok())
                    .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                AvailabilityInfo::LoginDetected {
                    last_auth_timestamp: timestamp,
                }
            }
            Some(false) => AvailabilityInfo::InstallationFound,
            // Timeout or error — fall back to InstallationFound
            // so the user can re-authenticate rather than being stuck.
            None => AvailabilityInfo::InstallationFound,
        }
    }
}

/// Run `claude auth status` with a timeout and return the `loggedIn` value.
/// Returns `Some(true)` if logged in, `Some(false)` if not, `None` on error/timeout.
fn check_claude_auth_status() -> Option<bool> {
    let mut cmd = std::process::Command::new("claude");
    cmd.args(["auth", "status"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    if let Some(path) = build_claude_path_env() {
        cmd.env("PATH", path);
    }

    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Some(false);
                }
                let stdout = child.stdout.take()?;
                let json: serde_json::Value =
                    serde_json::from_reader(std::io::BufReader::new(stdout)).ok()?;
                return json.get("loggedIn")?.as_bool();
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

fn build_claude_path_env() -> Option<String> {
    let mut combined = String::new();
    if let Some(home) = dirs::home_dir() {
        for bin in [
            home.join(".local").join("bin"),
            home.join(".claude").join("bin"),
        ] {
            if !bin.exists() {
                continue;
            }
            if !combined.is_empty() {
                combined.push(if cfg!(windows) { ';' } else { ':' });
            }
            combined.push_str(&bin.to_string_lossy());
        }
    }
    if let Ok(current) = std::env::var("PATH") {
        if !current.is_empty() {
            if !combined.is_empty() {
                combined.push(if cfg!(windows) { ';' } else { ':' });
            }
            combined.push_str(&current);
        }
    }
    if combined.is_empty() {
        None
    } else {
        Some(combined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let claude = ClaudeCode::default();
        assert!(claude.dangerously_skip_permissions.unwrap_or(false));
        assert_eq!(claude.permission_mode(), PermissionMode::BypassPermissions);
    }

    #[test]
    fn test_plan_mode() {
        let claude = ClaudeCode::new().with_plan_mode(true);
        assert_eq!(claude.permission_mode(), PermissionMode::Plan);
    }

    #[test]
    fn test_approvals_mode() {
        let claude = ClaudeCode::new().with_approvals(true);
        assert_eq!(claude.permission_mode(), PermissionMode::Default);
    }
}
