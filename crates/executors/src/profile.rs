//! Executor profile management system.
//!
//! This module provides:
//! - `ExecutorConfigs`: Container for all executor configurations with caching
//! - `ExecutorProfileId`: Identifier for a specific executor + variant combination
//! - `ExecutorConfig`: Per-executor configuration with multiple variants

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    sync::RwLock,
};

use convert_case::{Case, Casing};
use lazy_static::lazy_static;
use serde::{Deserialize, Deserializer, Serialize, de::Error as DeError};
use thiserror::Error;
use ts_rs::TS;

use crate::executors::claude::SpeedMode;
use crate::executors::codex::ReasoningEffort;
use crate::executors::{
    AvailabilityInfo, BaseCodingAgent, CodingAgent, StandardCodingAgentExecutor,
};
use crate::shell::resolve_executable_path;

const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

fn asset_dir() -> PathBuf {
    let path = if cfg!(debug_assertions) {
        PathBuf::from(PROJECT_ROOT).join("../../dev_assets")
    } else {
        dirs::data_dir()
            .expect("OS didn't give us a home directory")
            .join("com.chro-ai.chro")
    };

    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }

    path
}

fn profiles_path() -> PathBuf {
    asset_dir().join("profiles.json")
}

/// Canonical form for variant keys.
/// - "DEFAULT" is kept as-is
/// - Everything else is converted to SCREAMING_SNAKE_CASE
pub fn canonical_variant_key<S: AsRef<str>>(raw: S) -> String {
    let key = raw.as_ref();
    if key.eq_ignore_ascii_case("DEFAULT") {
        "DEFAULT".to_string()
    } else {
        key.to_case(Case::Snake).to_case(Case::ScreamingSnake)
    }
}

#[derive(Error, Debug)]
pub enum ProfileError {
    #[error("Built-in executor '{executor}' cannot be deleted")]
    CannotDeleteExecutor { executor: BaseCodingAgent },

    #[error("Built-in configuration '{executor}:{variant}' cannot be deleted")]
    CannotDeleteBuiltInConfig {
        executor: BaseCodingAgent,
        variant: String,
    },

    #[error("Validation error: {0}")]
    Validation(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Serde(#[from] serde_json::Error),

    #[error("No available executor profile")]
    NoAvailableExecutorProfile,
}

lazy_static! {
    static ref EXECUTOR_PROFILES_CACHE: RwLock<ExecutorConfigs> =
        RwLock::new(ExecutorConfigs::load());
}

const DEFAULT_PROFILES_JSON: &str = include_str!("../default_profiles.json");

/// Executor-centric profile identifier
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, Hash, Eq)]
pub struct ExecutorProfileId {
    /// The executor type (e.g., "CLAUDE_CODE", "CODEX")
    #[serde(alias = "profile", deserialize_with = "de_base_coding_agent_kebab")]
    pub executor: BaseCodingAgent,
    /// Optional variant name (e.g., "PLAN", "APPROVALS")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// Optional per-request model override applied on top of the resolved variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional reasoning effort override (Codex only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    /// Optional output-speed override (Claude Code fast mode only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<SpeedMode>,
}

fn de_base_coding_agent_kebab<'de, D>(de: D) -> Result<BaseCodingAgent, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(de)?;
    let norm = raw.replace('-', "_").to_ascii_uppercase();
    BaseCodingAgent::from_str(&norm)
        .map_err(|_| D::Error::custom(format!("unknown executor '{raw}' (normalized to '{norm}')")))
}

impl ExecutorProfileId {
    /// Create a new executor profile ID with default variant
    pub fn new(executor: BaseCodingAgent) -> Self {
        Self {
            executor,
            variant: None,
            model: None,
            reasoning_effort: None,
            speed: None,
        }
    }

    /// Apply the optional model / reasoning overrides onto a resolved agent.
    /// Reasoning effort only applies to Codex; Claude Code has no such concept.
    fn apply_overrides(&self, agent: &mut CodingAgent) {
        match agent {
            CodingAgent::ClaudeCode(claude) => {
                if let Some(model) = &self.model {
                    claude.model = Some(model.clone());
                }
                if let Some(speed) = &self.speed {
                    claude.speed = Some(*speed);
                }
            }
            CodingAgent::Codex(codex) => {
                if let Some(model) = &self.model {
                    codex.model = Some(model.clone());
                }
                if let Some(effort) = &self.reasoning_effort {
                    codex.model_reasoning_effort = Some(effort.clone());
                }
            }
            CodingAgent::Pi(pi) => {
                if let Some(model) = &self.model {
                    pi.model = Some(model.clone());
                }
            }
        }
    }
}

impl std::fmt::Display for ExecutorProfileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.variant {
            Some(variant) => write!(f, "{}:{}", self.executor, variant),
            None => write!(f, "{}", self.executor),
        }
    }
}

impl Default for ExecutorProfileId {
    fn default() -> Self {
        Self::new(BaseCodingAgent::ClaudeCode)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ExecutorConfig {
    #[serde(flatten)]
    pub configurations: HashMap<String, CodingAgent>,
}

impl ExecutorConfig {
    /// Get variant configuration by name
    pub fn get_variant(&self, variant: &str) -> Option<&CodingAgent> {
        self.configurations.get(variant)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ExecutorConfigs {
    pub executors: HashMap<BaseCodingAgent, ExecutorConfig>,
}

impl ExecutorConfigs {
    /// Normalise all variant keys in-place
    fn canonicalise(&mut self) {
        for profile in self.executors.values_mut() {
            let mut replacements = Vec::new();
            for key in profile.configurations.keys().cloned().collect::<Vec<_>>() {
                let canon = canonical_variant_key(&key);
                if canon != key {
                    replacements.push((key, canon));
                }
            }
            for (old, new) in replacements {
                if let Some(cfg) = profile.configurations.remove(&old) {
                    profile.configurations.entry(new).or_insert(cfg);
                }
            }
        }
    }

    /// Get cached executor profiles
    pub fn get_cached() -> ExecutorConfigs {
        EXECUTOR_PROFILES_CACHE.read().unwrap().clone()
    }

    /// Load executor profiles from file or defaults
    pub fn load() -> Self {
        let profiles_path = profiles_path();

        let mut defaults = Self::from_defaults();
        defaults.canonicalise();

        let content = match fs::read_to_string(&profiles_path) {
            Ok(content) => content,
            Err(_) => {
                tracing::info!("No user profiles.json found, using defaults only");
                return defaults;
            }
        };

        match serde_json::from_str::<Self>(&content) {
            Ok(mut user_overrides) => {
                tracing::info!("Loaded user profile overrides from profiles.json");
                user_overrides.canonicalise();
                Self::merge_with_defaults(defaults, user_overrides)
            }
            Err(e) => {
                tracing::error!(
                    "Failed to parse user profiles.json: {}, using defaults only",
                    e
                );
                defaults
            }
        }
    }

    /// Deep merge defaults with user overrides
    fn merge_with_defaults(mut defaults: Self, overrides: Self) -> Self {
        for (executor_key, override_profile) in overrides.executors {
            match defaults.executors.get_mut(&executor_key) {
                Some(default_profile) => {
                    for (config_name, config) in override_profile.configurations {
                        default_profile.configurations.insert(config_name, config);
                    }
                }
                None => {
                    defaults.executors.insert(executor_key, override_profile);
                }
            }
        }
        defaults
    }

    /// Load from the embedded defaults
    pub fn from_defaults() -> Self {
        serde_json::from_str(DEFAULT_PROFILES_JSON).unwrap_or_else(|e| {
            tracing::error!("Failed to parse embedded default_profiles.json: {}", e);
            panic!("Default profiles JSON is invalid")
        })
    }

    pub fn get_coding_agent(&self, executor_profile_id: &ExecutorProfileId) -> Option<CodingAgent> {
        self.executors
            .get(&executor_profile_id.executor)
            .and_then(|executor| {
                executor.get_variant(
                    &executor_profile_id
                        .variant
                        .clone()
                        .unwrap_or("DEFAULT".to_string()),
                )
            })
            .cloned()
            .map(|mut agent| {
                executor_profile_id.apply_overrides(&mut agent);
                agent
            })
    }

    pub fn get_coding_agent_or_default(
        &self,
        executor_profile_id: &ExecutorProfileId,
    ) -> CodingAgent {
        self.get_coding_agent(executor_profile_id)
            .unwrap_or_else(|| {
                let mut default_executor_profile_id = executor_profile_id.clone();
                default_executor_profile_id.variant = Some("DEFAULT".to_string());
                self.get_coding_agent(&default_executor_profile_id)
                    .expect("No default variant found")
            })
    }

    pub async fn get_recommended_executor_profile(
        &self,
    ) -> Result<ExecutorProfileId, ProfileError> {
        let mut agents_with_info: Vec<(BaseCodingAgent, AvailabilityInfo)> = Vec::new();

        for &base_agent in self.executors.keys() {
            let profile_id = ExecutorProfileId::new(base_agent);
            if let Some(coding_agent) = self.get_coding_agent(&profile_id) {
                let info = coding_agent.get_availability_info().await;
                if info.is_available() {
                    agents_with_info.push((base_agent, info));
                }
            }
        }

        if agents_with_info.is_empty() {
            return Err(ProfileError::NoAvailableExecutorProfile);
        }

        agents_with_info.sort_by(|a, b| match (&a.1, &b.1) {
            (
                AvailabilityInfo::LoginDetected {
                    last_auth_timestamp: time_a,
                },
                AvailabilityInfo::LoginDetected {
                    last_auth_timestamp: time_b,
                },
            ) => time_b.cmp(time_a),
            (AvailabilityInfo::LoginDetected { .. }, AvailabilityInfo::InstallationFound) => {
                std::cmp::Ordering::Less
            }
            (AvailabilityInfo::InstallationFound, AvailabilityInfo::LoginDetected { .. }) => {
                std::cmp::Ordering::Greater
            }
            (AvailabilityInfo::LoginDetected { .. }, AvailabilityInfo::NotFound) => {
                std::cmp::Ordering::Less
            }
            (AvailabilityInfo::NotFound, AvailabilityInfo::LoginDetected { .. }) => {
                std::cmp::Ordering::Greater
            }
            (AvailabilityInfo::InstallationFound, AvailabilityInfo::NotFound) => {
                std::cmp::Ordering::Less
            }
            (AvailabilityInfo::NotFound, AvailabilityInfo::InstallationFound) => {
                std::cmp::Ordering::Greater
            }
            _ => std::cmp::Ordering::Equal,
        });

        let selected = agents_with_info[0].0;
        tracing::info!("Recommended executor: {}", selected);
        Ok(ExecutorProfileId::new(selected))
    }
}

pub fn to_default_variant(id: &ExecutorProfileId) -> ExecutorProfileId {
    ExecutorProfileId {
        variant: None,
        ..id.clone()
    }
}

/// Individual MCP server status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub name: String,
    pub command: String,
    pub connected: bool,
}

/// Result of checking MCP servers status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpStatusResult {
    pub ok: bool,
    pub servers: Vec<McpServerStatus>,
    pub error: Option<String>,
    pub message: Option<String>,
}

fn add_parent_dir_to_path_env(command: &mut tokio::process::Command, executable: &Path) {
    let Some(parent) = executable.parent() else {
        return;
    };

    let mut path_entries = vec![parent.to_path_buf()];
    if let Some(existing_path) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&existing_path));
    }

    if let Ok(updated_path) = std::env::join_paths(path_entries) {
        command.env("PATH", updated_path);
    }
}

/// Check MCP server status for the requested executor's CLI.
pub async fn check_mcp_status(executor: BaseCodingAgent) -> McpStatusResult {
    match executor {
        BaseCodingAgent::ClaudeCode => check_claude_mcp_status().await,
        BaseCodingAgent::Codex => check_codex_mcp_status().await,
        // pi does not expose a chro-managed MCP server list.
        BaseCodingAgent::Pi => McpStatusResult {
            ok: true,
            servers: Vec::new(),
            error: None,
            message: None,
        },
    }
}

/// Resolve a manifest CLI and build a command for it, prepending the binary's
/// directory to `PATH` so co-located runtimes (e.g. a Node shim's `node`) are
/// reachable. Falls back to the bare command name when discovery fails.
async fn mcp_command(
    manifest: &'static crate::cli_manifest::CliManifest,
) -> tokio::process::Command {
    match crate::cli_resolver::resolve_cli(manifest).await {
        Some(resolved) => {
            // Normalize for the host platform so a Windows `.cmd` shim runs
            // through the command interpreter. Subcommand args the caller
            // appends flow through as trailing argv, which is exactly right for
            // `%ComSpec% /d /c <shim> <subcommand...>`.
            let invocation = crate::spawn::prepare_invocation(resolved.path.clone(), Vec::new());
            let mut command = match invocation {
                Ok(invocation) => {
                    let mut command = tokio::process::Command::new(&invocation.program);
                    command.args(&invocation.args);
                    command
                }
                Err(_) => tokio::process::Command::new(&resolved.path),
            };
            // PATH gets the shim's own directory so a co-located `node` runtime
            // resolves; use the original resolved path, not the interpreter.
            add_parent_dir_to_path_env(&mut command, &resolved.path);
            command
        }
        None => tokio::process::Command::new(manifest.command),
    }
}

async fn check_claude_mcp_status() -> McpStatusResult {
    let mut command = mcp_command(&crate::cli_manifest::CLAUDE).await;
    let result = command.args(["mcp", "list"]).output().await;

    match result {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let servers = parse_mcp_list_output(&stdout);
                McpStatusResult {
                    ok: true,
                    servers,
                    error: None,
                    message: None,
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                McpStatusResult {
                    ok: false,
                    servers: Vec::new(),
                    error: Some("COMMAND_FAILED".to_string()),
                    message: Some(stderr),
                }
            }
        }
        Err(err) => McpStatusResult {
            ok: false,
            servers: Vec::new(),
            error: Some("NOT_FOUND".to_string()),
            message: Some(err.to_string()),
        },
    }
}

async fn check_codex_mcp_status() -> McpStatusResult {
    let mut command = mcp_command(&crate::cli_manifest::CODEX).await;
    let result = command.args(["mcp", "list", "--json"]).output().await;

    match result {
        Ok(output) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return McpStatusResult {
                    ok: false,
                    servers: Vec::new(),
                    error: Some("COMMAND_FAILED".to_string()),
                    message: Some(stderr),
                };
            }

            match serde_json::from_slice::<Vec<CodexMcpServer>>(&output.stdout) {
                Ok(entries) => {
                    let servers = entries
                        .into_iter()
                        .map(|entry| McpServerStatus {
                            name: entry.name,
                            command: entry.transport.display_command(),
                            connected: entry.enabled,
                        })
                        .collect();
                    McpStatusResult {
                        ok: true,
                        servers,
                        error: None,
                        message: None,
                    }
                }
                Err(err) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let servers = parse_mcp_list_output(&stdout);
                    McpStatusResult {
                        ok: true,
                        servers,
                        error: None,
                        message: Some(format!("failed to parse Codex JSON: {err}")),
                    }
                }
            }
        }
        Err(err) => McpStatusResult {
            ok: false,
            servers: Vec::new(),
            error: Some("NOT_FOUND".to_string()),
            message: Some(err.to_string()),
        },
    }
}

#[derive(Debug, Deserialize)]
struct CodexMcpServer {
    name: String,
    enabled: bool,
    transport: CodexMcpTransport,
}

#[derive(Debug, Deserialize)]
struct CodexMcpTransport {
    #[serde(rename = "type")]
    kind: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
}

impl CodexMcpTransport {
    fn display_command(&self) -> String {
        match self.kind.as_str() {
            "stdio" => {
                let mut parts = Vec::new();
                if let Some(cmd) = &self.command {
                    parts.push(cmd.clone());
                }
                if let Some(args) = &self.args {
                    parts.extend(args.clone());
                }
                parts.join(" ").trim().to_string()
            }
            "streamable_http" => self
                .url
                .clone()
                .or_else(|| self.command.clone())
                .unwrap_or_default(),
            _ => self
                .command
                .clone()
                .or_else(|| self.url.clone())
                .unwrap_or_default(),
        }
    }
}

/// Parse the output of the Claude CLI `mcp list` command.
/// Expected format per line:
/// `server-name: command args - ✓ Connected` or `server-name: command args - ✗ Failed`
fn parse_mcp_list_output(output: &str) -> Vec<McpServerStatus> {
    let mut servers = Vec::new();

    for line in output.lines() {
        let line = line.trim();

        if line.is_empty() || line.starts_with("Checking") {
            continue;
        }

        if let Some(colon_pos) = line.find(':') {
            let name = line[..colon_pos].trim().to_string();
            let rest = line[colon_pos + 1..].trim();

            let (command, connected) = if let Some(dash_pos) = rest.rfind(" - ") {
                let cmd = rest[..dash_pos].trim().to_string();
                let status_part = &rest[dash_pos + 3..];
                let is_connected = status_part.contains('✓') || status_part.contains("Connected");
                (cmd, is_connected)
            } else {
                (rest.to_string(), false)
            };

            servers.push(McpServerStatus {
                name,
                command,
                connected,
            });
        }
    }

    servers
}

/// Installation info for executor CLIs, used to report what is detected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorInstallInfo {
    pub installed: bool,
    pub command: String,
    pub resolved_path: Option<String>,
    pub detected_version: Option<String>,
}

/// Aggregated install status for all known executors and tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorInstallStatusResult {
    pub claude_code: ExecutorInstallInfo,
    pub codex: ExecutorInstallInfo,
    pub pi: ExecutorInstallInfo,
    pub git: ExecutorInstallInfo,
}

async fn detect_install_info(command: &'static str) -> ExecutorInstallInfo {
    let resolved_path = resolve_executable_path(command).await;
    let detected_version = match resolved_path.as_ref() {
        Some(path) => detect_installed_version(path).await,
        None => None,
    };
    let resolved_path = resolved_path.map(|path| path.to_string_lossy().into_owned());

    ExecutorInstallInfo {
        installed: resolved_path.is_some(),
        command: command.to_string(),
        resolved_path,
        detected_version,
    }
}

/// Manifest-aware install detection. Walks the layered candidate list so the
/// `installed` flag reflects every place a user might have installed the CLI
/// (Homebrew, `~/.local/bin`, the official installer dir, etc.).
async fn detect_install_info_for_manifest(
    manifest: &'static crate::cli_manifest::CliManifest,
) -> ExecutorInstallInfo {
    let resolved = crate::cli_resolver::resolve_cli(manifest).await;
    let resolved_path = resolved.as_ref().map(|r| r.path.clone());
    let detected_version = match resolved_path.as_ref() {
        Some(path) => detect_installed_version(path).await,
        None => None,
    };
    let resolved_path = resolved_path.map(|p| p.to_string_lossy().into_owned());

    ExecutorInstallInfo {
        installed: resolved_path.is_some(),
        command: manifest.command.to_string(),
        resolved_path,
        detected_version,
    }
}

async fn detect_installed_version(resolved_path: &Path) -> Option<String> {
    let output = tokio::process::Command::new(resolved_path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    extract_detected_version(&output.stdout, &output.stderr)
}

fn extract_detected_version(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    for candidate in [stdout, stderr] {
        let text = String::from_utf8_lossy(candidate);
        let version = text.lines().map(str::trim).find(|line| !line.is_empty());
        if let Some(version) = version {
            return Some(version.to_string());
        }
    }

    None
}

/// Query install status for all executors.
///
/// This checks whether the CLI command required by the renderer auth flow can
/// actually be resolved from the current environment.
pub async fn get_install_status_all() -> ExecutorInstallStatusResult {
    let claude_code = detect_install_info_for_manifest(&crate::cli_manifest::CLAUDE).await;
    let codex = detect_install_info_for_manifest(&crate::cli_manifest::CODEX).await;
    let pi = detect_install_info_for_manifest(&crate::cli_manifest::PI).await;
    let git = detect_install_info("git").await;

    ExecutorInstallStatusResult {
        claude_code,
        codex,
        pi,
        git,
    }
}

#[cfg(test)]
mod tests {
    use super::{ExecutorProfileId, SpeedMode, extract_detected_version};
    use crate::executors::{BaseCodingAgent, CodingAgent};

    #[test]
    fn speed_override_applies_to_claude_code() {
        let profile = ExecutorProfileId {
            speed: Some(SpeedMode::Fast),
            ..ExecutorProfileId::new(BaseCodingAgent::ClaudeCode)
        };
        let mut agent = CodingAgent::ClaudeCode(Default::default());
        profile.apply_overrides(&mut agent);
        match agent {
            CodingAgent::ClaudeCode(claude) => {
                assert_eq!(claude.speed, Some(SpeedMode::Fast));
            }
            _ => panic!("expected Claude Code agent"),
        }
    }

    #[test]
    fn extract_detected_version_prefers_stdout() {
        let version = extract_detected_version(b"claude 1.0.72\n", b"warning");

        assert_eq!(version.as_deref(), Some("claude 1.0.72"));
    }

    #[test]
    fn extract_detected_version_falls_back_to_stderr() {
        let version = extract_detected_version(b"", b"codex 0.1.0\n");

        assert_eq!(version.as_deref(), Some("codex 0.1.0"));
    }
}
