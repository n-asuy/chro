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
    spawn::Invocation,
};

/// Output speed for the underlying model. `Fast` maps to Claude Code's fast
/// mode (Anthropic `speed: "fast"`), currently available on Opus; `Standard`
/// is the default and needs no CLI opt-in.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SpeedMode {
    Standard,
    Fast,
}

/// Claude Code agent configuration.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ClaudeCode {
    /// Extra text appended to the prompt.
    #[serde(default)]
    pub append_prompt: AppendPrompt,

    /// Model to use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// Output speed. `Fast` opts into fast mode; unset / `Standard` is default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<SpeedMode>,

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

        // Fast mode has no dedicated flag; the CLI reads it from settings
        // (`fastMode: true`), gated per model to Opus. `--settings` merges with
        // the user's own settings rather than replacing them.
        if self.speed == Some(SpeedMode::Fast) {
            builder = builder.extend_params(["--settings", r#"{"fastMode":true}"#]);
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

        let Invocation {
            program: program_path,
            args,
        } = command_parts.into_resolved().await?;

        // The prompt is delivered over stdin rather than as a positional
        // argument. `claude --print` reads stdin when no prompt is passed, and
        // keeping free-form text out of argv is what lets the Windows batch-shim
        // wrapper (`prepare_invocation`) forward a fixed, metacharacter-free
        // argument list through the command interpreter.
        let prompt = self.append_prompt.combine_prompt(prompt);

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
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(current_dir)
            .args(&args)
            .env_clear();
        for (key, value) in claude_environment() {
            process.env(key, value);
        }
        // Applied before profile variables so an explicit user override wins.
        for (key, value) in headless_harness_env() {
            process.env(key, value);
        }
        for (key, value) in &env.vars {
            process.env(key, value);
        }
        if let Some(path) = build_claude_path_env() {
            process.env("PATH", path);
        }

        let mut child = process.group_spawn()?;

        // Feed the prompt over stdin, then close it so the CLI sees EOF and
        // begins its turn. Done off-task so a large prompt never blocks the
        // caller; the CLI drains stdin before emitting output, so there is no
        // deadlock with the stdout reader the container installs next.
        let mut child_stdin = child.inner().stdin.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("claude process missing stdin"))
        })?;
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            if let Err(err) = child_stdin.write_all(prompt.as_bytes()).await {
                tracing::warn!("failed to write prompt to claude stdin: {err}");
            }
            // Drop closes the pipe, signalling EOF.
            drop(child_stdin);
        });

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

    /// `--fork-session` makes the resumed conversation write to a new session id
    /// instead of appending to the original, which is what keeps a fork from
    /// mutating the session it branched from.
    ///
    /// `--resume` only resolves ids within the current repo's project-dir
    /// family (verified 2026-07-18: a sibling worktree of the same repo
    /// resolves, an unrelated directory fails with "No conversation found",
    /// surfaced as an opaque `error_during_execution` in stream-json mode). A
    /// fork can legitimately run somewhere the source never did, so the source
    /// session file is copied into the target cwd's project dir first.
    async fn spawn_fork(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        make_session_visible_from(current_dir, session_id);

        let args = vec![
            "--resume".to_string(),
            session_id.to_string(),
            "--fork-session".to_string(),
        ];

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

    async fn get_availability_info(&self) -> AvailabilityInfo {
        let config_path = dirs::home_dir().map(|home| home.join(".claude.json"));
        let config_exists = config_path.as_ref().map(|p| p.exists()).unwrap_or(false);

        if !config_exists {
            return AvailabilityInfo::NotFound;
        }

        // Both ~/.claude.json and Keychain credentials persist after logout,
        // so ask the CLI for its current login state.
        match check_claude_auth_status().await {
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
/// The project-dir name Claude Code derives from a working directory: the
/// canonical path with every non-alphanumeric character replaced by `-`.
/// Verified empirically (`/tmp/ab_c.d` → `-private-tmp-ab-c-d`).
fn claude_project_dir_name(cwd: &Path) -> String {
    let canonical = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    canonical
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Copy `session_id`'s transcript into `cwd`'s project dir if it lives
/// elsewhere, so a subsequent `--resume` from `cwd` can find it.
///
/// Best-effort on purpose: when the session is already visible (same directory,
/// or a worktree of the same repo) there is nothing to do, and when the file
/// cannot be found the resume itself will produce the error worth reporting.
/// The copy keeps the original session id, so the source file stays untouched
/// and `--fork-session` still allocates a fresh id for the branch.
fn make_session_visible_from(cwd: &Path, session_id: &str) {
    let Some(projects_dir) = dirs::home_dir().map(|home| home.join(".claude").join("projects"))
    else {
        return;
    };
    let file_name = format!("{session_id}.jsonl");
    let target_dir = projects_dir.join(claude_project_dir_name(cwd));
    if target_dir.join(&file_name).exists() {
        return;
    }

    let Ok(entries) = std::fs::read_dir(&projects_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file_name);
        if !candidate.is_file() {
            continue;
        }
        if let Err(err) = std::fs::create_dir_all(&target_dir)
            .and_then(|_| std::fs::copy(&candidate, target_dir.join(&file_name)).map(|_| ()))
        {
            tracing::warn!(
                session_id,
                source = %candidate.display(),
                target = %target_dir.display(),
                error = %err,
                "failed to copy session transcript for fork; resume may not resolve"
            );
        } else {
            tracing::info!(
                session_id,
                target = %target_dir.display(),
                "copied session transcript so the fork can resume it here"
            );
        }
        return;
    }
}

fn claude_environment() -> impl Iterator<Item = (String, String)> {
    std::env::vars().filter(|(key, _)| key != "CLAUDECODE" && !key.starts_with("CLAUDE_CODE_"))
}

/// Fixed environment for headless (`--print`) execution, applied on every
/// spawn after the inherited environment and before profile overrides.
///
/// - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`: under `--print` there is no
///   "re-invoke the agent when a background task finishes" — the process ends
///   with the turn, and the CLI kills its background tasks on exit. An agent
///   that backgrounds a long job and yields to await it therefore ends the run
///   as a success mid-work, with the awaited job dead. Disabling the
///   capability (which also covers the CLI auto-backgrounding long foreground
///   commands) forces long jobs to run in the foreground, where the CLI keeps
///   the turn open and emits `tool_progress` heartbeats.
/// - `MCP_TOOL_TIMEOUT`: an unset timeout is infinite, so bound hanging MCP
///   tool calls.
/// - `NO_COLOR`: keep stream output free of ANSI noise.
fn headless_harness_env() -> &'static [(&'static str, &'static str)] {
    &[
        ("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"),
        ("MCP_TOOL_TIMEOUT", "60000"),
        ("NO_COLOR", "1"),
    ]
}

/// Run `claude auth status` with a timeout and return the `loggedIn` value.
///
/// Resolves the binary through the shared layered resolver (the same path the
/// CLI-status pulldown and execution use) and normalizes it for the host, so a
/// Windows `.cmd` shim is invoked via the command interpreter instead of the
/// bare `claude` name — which `CreateProcessW` cannot launch and which bypasses
/// the resolver's PATH discovery.
async fn check_claude_auth_status() -> Option<bool> {
    let resolved = crate::cli_resolver::resolve_cli(&cli_manifest::CLAUDE).await?;
    let invocation = crate::spawn::prepare_invocation(
        resolved.path,
        vec!["auth".to_string(), "status".to_string()],
    )
    .ok()?;

    let mut cmd = tokio::process::Command::new(&invocation.program);
    cmd.args(&invocation.args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    if let Some(path) = build_claude_path_env() {
        cmd.env("PATH", path);
    }

    let output = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output())
        .await
        .ok()? // timed out
        .ok()?; // spawn / io failure

    if !output.status.success() {
        return Some(false);
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    json.get("loggedIn")?.as_bool()
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
    fn headless_env_disables_background_tasks() {
        let env: std::collections::HashMap<&str, &str> =
            headless_harness_env().iter().copied().collect();
        // Yielding a turn while a background task runs ends the process (and
        // the CLI kills the task on exit) under `--print`, so the capability
        // must be off entirely; see the fn doc for the failure it prevents.
        assert_eq!(env.get("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"), Some(&"1"));
        assert_eq!(env.get("MCP_TOOL_TIMEOUT"), Some(&"60000"));
        assert_eq!(env.get("NO_COLOR"), Some(&"1"));
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

    #[test]
    fn fast_speed_opts_into_fast_mode_settings() {
        let claude = ClaudeCode {
            speed: Some(SpeedMode::Fast),
            ..Default::default()
        };
        let params = claude
            .build_command_builder()
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(
            params
                .windows(2)
                .any(|w| w == ["--settings", r#"{"fastMode":true}"#]),
            "fast speed must enable fast mode via settings: {params:?}"
        );
    }

    #[test]
    fn standard_speed_adds_no_settings() {
        for speed in [None, Some(SpeedMode::Standard)] {
            let claude = ClaudeCode {
                speed,
                ..Default::default()
            };
            let params = claude
                .build_command_builder()
                .unwrap()
                .params
                .unwrap_or_default();
            assert!(
                !params.iter().any(|p| p == "--settings"),
                "standard speed must not inject settings: {params:?}"
            );
        }
    }
}
