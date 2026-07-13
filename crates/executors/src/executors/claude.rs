//! Claude Code agent implementation.
//!
//! Claude runs headlessly via `--print --output-format stream-json`. The CLI's
//! stdout feeds [`ClaudeLogProcessor`] directly, keeping execution suitable for
//! unattended and parallel runs without an interactive terminal dependency.

mod processor;
pub mod types;

pub use processor::{ClaudeLogProcessor, HistoryStrategy};
pub use types::{
    ApprovalStatus, ClaudeContentBlockDelta, ClaudeContentItem, ClaudeJson, ClaudeMessage,
    ClaudeStreamEvent, ClaudeToolData,
};

use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use command_group::AsyncCommandGroup;
use events::MsgStore;
use log_types::LogEntry;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    apply_overrides,
    approvals::ExecutorApprovalService,
    cli_manifest,
    command::{CmdOverrides, CommandBuildError, CommandBuilder},
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, ExecutorError, SpawnedChild, StandardCodingAgentExecutor,
    },
};

/// Claude Code agent configuration.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ClaudeCode {
    /// Extra text appended to the prompt.
    #[serde(default)]
    pub append_prompt: AppendPrompt,

    /// Model to use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// Command overrides.
    #[serde(flatten)]
    #[ts(skip)]
    #[schemars(skip)]
    pub cmd: CmdOverrides,
}

impl ClaudeCode {
    pub fn new() -> Self {
        Self::default()
    }

    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::for_manifest(&cli_manifest::CLAUDE).extend_params([
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
        ]);

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

        let (program_path, mut args) = command_parts.into_resolved().await?;
        args.push(self.append_prompt.combine_prompt(prompt));

        tracing::info!(
            program = %program_path.display(),
            args = ?args,
            current_dir = %current_dir.display(),
            is_follow_up = follow_up_args.is_some(),
            "[ClaudeCode::spawn_internal] spawning headless claude --print"
        );

        let mut process = tokio::process::Command::new(&program_path);
        process
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(current_dir)
            .args(&args)
            .env_clear();
        for (key, value) in claude_environment() {
            process.env(key, value);
        }
        // An unset timeout is infinite, so bound hanging MCP tool calls. Apply
        // this before profile variables so an explicit user override still wins.
        process.env("MCP_TOOL_TIMEOUT", "60000");
        process.env("NO_COLOR", "1");
        for (key, value) in &env.vars {
            process.env(key, value);
        }
        if let Some(path) = build_claude_path_env() {
            process.env("PATH", path);
        }

        let child = process.group_spawn()?;

        Ok(SpawnedChild {
            child: child.into(),
            exit_signal: None,
            cancel: None,
        })
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for ClaudeCode {
    fn use_approvals(&mut self, _approvals: Arc<dyn ExecutorApprovalService>) {}

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

        // Both ~/.claude.json and Keychain credentials persist after logout,
        // so ask the CLI for its current login state.
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
            Some(false) | None => AvailabilityInfo::InstallationFound,
        }
    }
}

/// Parent environment minus Claude Code's own nesting markers.
///
/// When chro itself runs inside a Claude session, the inherited
/// `CLAUDECODE`/`CLAUDE_CODE_*` variables make the spawned CLI reject nesting.
fn claude_environment() -> impl Iterator<Item = (String, String)> {
    std::env::vars().filter(|(key, _)| key != "CLAUDECODE" && !key.starts_with("CLAUDE_CODE_"))
}

/// Run `claude auth status` with a timeout and return the `loggedIn` value.
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
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut combined = String::new();
    for dir in cli_manifest::manifest_path_dirs(&cli_manifest::CLAUDE) {
        if !combined.is_empty() {
            combined.push(sep);
        }
        combined.push_str(&dir.to_string_lossy());
    }
    if let Ok(current) = std::env::var("PATH")
        && !current.is_empty()
    {
        if !combined.is_empty() {
            combined.push(sep);
        }
        combined.push_str(&current);
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
    fn claude_environment_strips_nesting_markers() {
        // SAFETY: test-only env mutation; tests in this module do not race on
        // these specific keys.
        unsafe {
            std::env::set_var("CLAUDECODE", "1");
            std::env::set_var("CLAUDE_CODE_ENTRYPOINT", "cli");
            std::env::set_var("CHRO_CLAUDE_ENV_PROBE", "keep");
        }
        let env: std::collections::HashMap<String, String> = claude_environment().collect();
        assert!(!env.contains_key("CLAUDECODE"));
        assert!(!env.contains_key("CLAUDE_CODE_ENTRYPOINT"));
        assert_eq!(
            env.get("CHRO_CLAUDE_ENV_PROBE").map(String::as_str),
            Some("keep")
        );
        unsafe {
            std::env::remove_var("CHRO_CLAUDE_ENV_PROBE");
        }
    }

    #[test]
    fn command_builder_uses_headless_stream_json_flags() {
        let params = ClaudeCode::default()
            .build_command_builder()
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(params.contains(&"--print".to_string()));
        assert!(params.contains(&"--output-format".to_string()));
        assert!(params.contains(&"stream-json".to_string()));
        assert!(params.contains(&"--verbose".to_string()));
        assert!(params.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn command_includes_model_override() {
        let mut claude = ClaudeCode::default();
        claude.model = Some("claude-sonnet-4-20250514".to_string());
        let params = claude
            .build_command_builder()
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(
            params
                .windows(2)
                .any(|w| w == ["--model", "claude-sonnet-4-20250514"]),
            "model override must be passed: {params:?}"
        );
    }
}
