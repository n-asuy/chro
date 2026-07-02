//! Claude Code agent implementation.
//!
//! Two execution modes are supported, selected by [`ClaudeExecutionMode`]:
//!
//! - **PTY (default).** Claude runs as a regular interactive TUI inside a PTY.
//!   The run is observed out-of-band instead of through stdio:
//!   - Claude Code hooks (registered via a per-run `--settings` file) POST to a
//!     per-run HTTP endpoint: `UserPromptSubmit` discovers the session
//!     transcript, `Stop` signals turn completion, `PreToolUse` carries the
//!     permission/question flow.
//!   - The session transcript JSONL is tailed and mapped back to stream-json.
//!   - The PTY's own byte stream (TUI rendering) is drained and discarded; the
//!     container reads a synthetic stdout pipe carrying the mapped lines plus a
//!     synthesized final `result` line.
//! - **Print (headless).** Claude runs once via `--print --output-format
//!   stream-json`, writing stream-json straight to stdout, which the container
//!   consumes directly. There is no PTY, no hooks, no transcript tail, and no
//!   approval or interactive-question flow: a simpler, more stable path suited
//!   to batch / parallel runs. Permissions are always skipped so the run never
//!   blocks on a prompt that nothing can answer.
//!
//! Both modes emit the same stream-json and feed the same
//! [`ClaudeLogProcessor`], so log normalization, persistence and replay are
//! identical regardless of how Claude was run.

mod hook_server;
mod hooks;
mod log_sink;
mod processor;
mod supervisor;
mod transcript;
pub mod types;

pub use processor::{ClaudeLogProcessor, HistoryStrategy};
pub use types::{
    ApprovalStatus, ClaudeContentBlockDelta, ClaudeContentItem, ClaudeJson, ClaudeMessage,
    ClaudeStreamEvent, ClaudeToolData,
};

use std::{io::Read, path::Path, sync::Arc};

use async_trait::async_trait;
use command_group::AsyncCommandGroup;
use derivative::Derivative;
use events::MsgStore;
use log_types::LogEntry;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use self::{
    hook_server::{ClaudeHookServer, PermissionBroker},
    hooks::{build_hook_settings, write_hook_settings_file},
    log_sink::LogLineSink,
    supervisor::RunSupervisor,
};
use crate::{
    apply_overrides,
    approvals::ExecutorApprovalService,
    cli_manifest,
    command::{CmdOverrides, CommandBuildError, CommandBuilder},
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, ExecutorError, SpawnedChild, StandardCodingAgentExecutor,
    },
    process::{ExecutionProcess, PtyProcess},
    profile::PermissionMode,
    stdout_dup::create_log_line_pipe,
};

/// Terminal size for the hosted TUI. Nothing renders to a screen, but the
/// CLI lays text out against this grid; keep it wide so content is not
/// wrapped into the scrollback needlessly.
const PTY_SIZE: (u16, u16) = (200, 50);

/// How the Claude CLI is executed.
///
/// `Pty` hosts the interactive TUI and observes it out-of-band (hooks +
/// transcript tail); `Print` runs `claude --print` headless and reads
/// stream-json straight from stdout. The two produce identical log streams and
/// differ only in reliability and feature surface (Print has no approvals and
/// no interactive questions). See the module docs.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeExecutionMode {
    Pty,
    Print,
}

impl Default for ClaudeExecutionMode {
    fn default() -> Self {
        Self::Pty
    }
}

impl ClaudeExecutionMode {
    /// Stable string used to persist the mode (matches the serde `snake_case`
    /// wire form). Kept in sync with [`Self::from_db_str`].
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Pty => "pty",
            Self::Print => "print",
        }
    }

    /// Parse a persisted mode string. Returns `None` for unknown values so the
    /// caller can fall back deliberately rather than guess.
    pub fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "pty" => Some(Self::Pty),
            "print" => Some(Self::Print),
            _ => None,
        }
    }
}

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

    /// How the CLI is run: interactive PTY (default) or headless `--print`.
    #[serde(default)]
    pub execution_mode: ClaudeExecutionMode,

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
            execution_mode: ClaudeExecutionMode::default(),
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

    pub fn with_execution_mode(mut self, mode: ClaudeExecutionMode) -> Self {
        self.execution_mode = mode;
        self
    }

    /// Override the execution mode on a resolved agent. Used to apply the
    /// global setting at spawn time without baking it into every profile.
    pub fn set_execution_mode(&mut self, mode: ClaudeExecutionMode) {
        self.execution_mode = mode;
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
        let mut builder = CommandBuilder::for_manifest(&cli_manifest::CLAUDE);

        match self.permission_mode() {
            PermissionMode::Plan => {
                builder = builder.extend_params(["--permission-mode", "plan"]);
            }
            PermissionMode::Default => {}
            PermissionMode::BypassPermissions => {
                if self.dangerously_skip_permissions.unwrap_or(false) {
                    builder = builder.extend_params(["--dangerously-skip-permissions"]);
                }
            }
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
        match self.execution_mode {
            ClaudeExecutionMode::Pty => {
                self.spawn_pty(current_dir, prompt, env, follow_up_args)
                    .await
            }
            ClaudeExecutionMode::Print => {
                self.spawn_print(current_dir, prompt, env, follow_up_args)
                    .await
            }
        }
    }

    /// Host the interactive TUI in a PTY and observe it via hooks + transcript.
    async fn spawn_pty(
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
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        let permission_mode = self.permission_mode();
        let run_key = uuid::Uuid::new_v4();

        // Synthetic stdout: the container reads stream-json lines from here.
        let (log_stdout, log_writer) = create_log_line_pipe()?;
        let sink = LogLineSink::new(log_writer);
        let cancel = CancellationToken::new();

        let broker = PermissionBroker::new(
            permission_mode,
            self.approvals_service.clone(),
            sink.clone(),
            cancel.clone(),
        );
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let server = ClaudeHookServer::start(events_tx, broker).await?;
        let settings = build_hook_settings(&server.endpoint, permission_mode);
        let settings_path = write_hook_settings_file(&settings, run_key)
            .await
            .map_err(ExecutorError::Io)?;

        args.push("--settings".to_string());
        args.push(settings_path.to_string_lossy().to_string());
        args.push(combined_prompt);

        tracing::info!(
            program = %program_path.display(),
            args = ?args,
            current_dir = %current_dir.display(),
            is_follow_up = follow_up_args.is_some(),
            hook_port = server.endpoint.port,
            "[ClaudeCode::spawn_internal] spawning interactive CLI in PTY"
        );

        let mut cmd = portable_pty::CommandBuilder::new(&program_path);
        cmd.args(&args);
        cmd.cwd(current_dir);
        cmd.env_clear();
        for (key, value) in pty_environment() {
            cmd.env(key, value);
        }
        // Bound MCP tool-call execution time; an unset MCP_TOOL_TIMEOUT is
        // treated as infinite by the CLI, so a hanging MCP tool would stall
        // the run forever. Set before profile env so a user override wins.
        cmd.env("MCP_TOOL_TIMEOUT", "60000");
        for (key, value) in &env.vars {
            cmd.env(key, value);
        }
        if let Some(path) = build_claude_path_env() {
            cmd.env("PATH", path);
        }

        let (pty, raw_output) = PtyProcess::spawn(cmd, PTY_SIZE, log_stdout)?;
        drain_pty_output(raw_output);

        RunSupervisor {
            events: events_rx,
            sink,
            cancel: cancel.clone(),
            is_resume: follow_up_args.is_some(),
            settings_path,
            server,
            child_exit: pty.exit_watch(),
        }
        .spawn();

        Ok(SpawnedChild {
            child: ExecutionProcess::Pty(pty),
            exit_signal: None,
            cancel: Some(cancel),
        })
    }

    /// Build the `claude --print` command for headless execution.
    ///
    /// Permissions are always skipped: print mode has no interactive approval
    /// path, so anything short of skipping would block the run on a prompt that
    /// nothing can answer.
    fn build_print_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
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

    /// Run `claude --print` once, headless, and hand its real stdout (already
    /// stream-json) straight to the container. No PTY, hooks or transcript tail.
    async fn spawn_print(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
        follow_up_args: Option<&[String]>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let builder = self.build_print_command_builder()?;
        let command_parts = if let Some(args) = follow_up_args {
            builder.build_follow_up(args)?
        } else {
            builder.build_initial()?
        };

        let (program_path, mut args) = command_parts.into_resolved().await?;
        // The prompt is the trailing positional argument to `--print`.
        args.push(self.append_prompt.combine_prompt(prompt));

        tracing::info!(
            program = %program_path.display(),
            args = ?args,
            current_dir = %current_dir.display(),
            is_follow_up = follow_up_args.is_some(),
            "[ClaudeCode::spawn_print] spawning headless claude --print"
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
        for (key, value) in pty_environment() {
            process.env(key, value);
        }
        // Bound MCP tool-call execution time; see the PTY path for rationale.
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

/// Parent environment for the PTY, minus Claude Code's own nesting markers.
///
/// When chro itself runs inside a Claude session (dev flows), the inherited
/// `CLAUDECODE`/`CLAUDE_CODE_*` variables make the spawned CLI treat itself
/// as nested and it stops persisting the session transcript — which is this
/// executor's entire data plane. Verified against claude 2.1.173.
fn pty_environment() -> impl Iterator<Item = (String, String)> {
    std::env::vars().filter(|(key, _)| key != "CLAUDECODE" && !key.starts_with("CLAUDE_CODE_"))
}

/// Keep the PTY master drained so the TUI never blocks on a full terminal
/// buffer. The bytes are rendering noise; retain a small tail for debugging.
fn drain_pty_output(mut reader: Box<dyn Read + Send>) {
    const TAIL_CAPACITY: usize = 8 * 1024;
    let _ = std::thread::Builder::new()
        .name("claude-pty-drain".to_string())
        .spawn(move || {
            let mut tail: Vec<u8> = Vec::with_capacity(TAIL_CAPACITY);
            let mut buf = [0u8; 8 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        tail.extend_from_slice(&buf[..n]);
                        if tail.len() > TAIL_CAPACITY {
                            let excess = tail.len() - TAIL_CAPACITY;
                            tail.drain(..excess);
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            tracing::debug!(
                tail = %String::from_utf8_lossy(&tail),
                "claude PTY closed"
            );
        });
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

    #[test]
    fn pty_environment_strips_nesting_markers() {
        // SAFETY: test-only env mutation; tests in this module do not race
        // on these specific keys.
        unsafe {
            std::env::set_var("CLAUDECODE", "1");
            std::env::set_var("CLAUDE_CODE_ENTRYPOINT", "cli");
            std::env::set_var("CHRO_PTY_ENV_PROBE", "keep");
        }
        let env: std::collections::HashMap<String, String> = pty_environment().collect();
        assert!(!env.contains_key("CLAUDECODE"));
        assert!(!env.contains_key("CLAUDE_CODE_ENTRYPOINT"));
        assert_eq!(
            env.get("CHRO_PTY_ENV_PROBE").map(String::as_str),
            Some("keep")
        );
        unsafe {
            std::env::remove_var("CHRO_PTY_ENV_PROBE");
        }
    }

    #[test]
    fn command_builder_uses_interactive_flags() {
        let claude = ClaudeCode::default();
        let params = claude
            .build_command_builder()
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(params.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(!params.iter().any(|p| p.contains("--print")));
        assert!(!params.iter().any(|p| p.contains("stream-json")));

        let plan = ClaudeCode::new().with_plan_mode(true);
        let params = plan
            .build_command_builder()
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(params.contains(&"--permission-mode".to_string()));
        assert!(params.contains(&"plan".to_string()));
        assert!(!params.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn default_execution_mode_is_pty() {
        assert_eq!(
            ClaudeCode::default().execution_mode,
            ClaudeExecutionMode::Pty
        );
    }

    #[test]
    fn print_command_builder_uses_headless_stream_json_flags() {
        let claude = ClaudeCode::default().with_execution_mode(ClaudeExecutionMode::Print);
        let params = claude
            .build_print_command_builder()
            .unwrap()
            .params
            .unwrap_or_default();
        assert!(params.contains(&"--print".to_string()));
        assert!(params.contains(&"--output-format".to_string()));
        assert!(params.contains(&"stream-json".to_string()));
        assert!(params.contains(&"--verbose".to_string()));
        // Headless always skips permissions: there is no approval path.
        assert!(params.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn print_command_includes_model_override() {
        let mut claude = ClaudeCode::default().with_execution_mode(ClaudeExecutionMode::Print);
        claude.model = Some("claude-sonnet-4-20250514".to_string());
        let params = claude
            .build_print_command_builder()
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
    fn execution_mode_serde_roundtrip() {
        // Old profiles without the field default to PTY.
        let without: ClaudeCode = serde_json::from_str("{}").unwrap();
        assert_eq!(without.execution_mode, ClaudeExecutionMode::Pty);

        let with: ClaudeCode = serde_json::from_str(r#"{"execution_mode":"print"}"#).unwrap();
        assert_eq!(with.execution_mode, ClaudeExecutionMode::Print);
    }

    #[test]
    fn execution_mode_db_str_roundtrip() {
        for mode in [ClaudeExecutionMode::Pty, ClaudeExecutionMode::Print] {
            assert_eq!(ClaudeExecutionMode::from_db_str(mode.as_db_str()), Some(mode));
        }
        // The persisted form matches the serde wire form, so old rows stay valid.
        assert_eq!(ClaudeExecutionMode::Pty.as_db_str(), "pty");
        assert_eq!(ClaudeExecutionMode::Print.as_db_str(), "print");
        assert_eq!(ClaudeExecutionMode::from_db_str("garbage"), None);
    }
}
