//! Executor profile management system.
//!
//! This module provides:
//! - `ExecutorConfigs`: Container for all executor configurations with caching
//! - `ExecutorProfileId`: Identifier for a specific executor + variant combination
//! - `ExecutorConfig`: Per-executor configuration with multiple variants

use std::{
    collections::{HashMap, HashSet},
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

use crate::executors::{
    AvailabilityInfo, BaseCodingAgent, CodingAgent, ExecutorError, StandardCodingAgentExecutor,
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
                let info = coding_agent.get_availability_info();
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
        executor: id.executor,
        variant: None,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    Plan,
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_cli_flag(&self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::Plan => "plan",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }
}

/// Runtime configuration for permissions, used by the container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRuntimeConfig {
    pub mode: PermissionMode,
    /// Whether manual approval is enabled (i.e., not bypassing permissions).
    #[serde(default)]
    pub enabled: bool,
    /// Optional hooks configuration for the control protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hooks: Option<serde_json::Value>,
}

impl Default for PermissionRuntimeConfig {
    fn default() -> Self {
        Self {
            mode: PermissionMode::BypassPermissions,
            enabled: false,
            hooks: None,
        }
    }
}

impl PermissionRuntimeConfig {
    pub fn new(mode: PermissionMode) -> Self {
        let enabled = !matches!(mode, PermissionMode::BypassPermissions);
        Self {
            mode,
            enabled,
            hooks: None,
        }
    }
}

/// Model preset for Anthropic models.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPreset {
    pub id: &'static str,
    pub name: &'static str,
}

/// Returns available Anthropic model presets.
pub const fn anthropic_model_presets() -> &'static [ModelPreset] {
    &[
        ModelPreset {
            id: "claude-sonnet-4-20250514",
            name: "Claude Sonnet 4",
        },
        ModelPreset {
            id: "claude-3-5-sonnet-20241022",
            name: "Claude 3.5 Sonnet",
        },
        ModelPreset {
            id: "claude-3-opus-20240229",
            name: "Claude 3 Opus",
        },
    ]
}

/// Result of detecting Claude CLI version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeVersionResult {
    pub ok: bool,
    pub version: Option<String>,
    pub command: Option<String>,
    pub resolved_path: Option<String>,
    pub error: Option<String>,
    pub message: Option<String>,
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

fn add_parent_dir_to_path_env(command: &mut std::process::Command, executable: &std::path::Path) {
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

/// Find the Claude CLI executable path.
/// On Windows, also checks %APPDATA%\npm where global npm packages are installed.
fn find_claude_executable() -> Option<std::path::PathBuf> {
    if let Ok(path) = which::which("claude") {
        return Some(path);
    }

    #[cfg(not(windows))]
    {
        if let Some(path) = find_claude_in_known_locations() {
            return Some(path);
        }

        if let Some(path) = find_claude_via_login_shell() {
            return Some(path);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(path) = find_claude_in_known_locations_windows() {
            return Some(path);
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn find_claude_in_known_locations_windows() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;

    let mut candidates: Vec<std::path::PathBuf> = vec![
        home.join(".local").join("bin").join("claude.exe"),
        home.join(".local").join("bin").join("claude.cmd"),
        home.join(".claude").join("bin").join("claude.exe"),
    ];

    // %APPDATA%\npm (global npm packages)
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = std::path::PathBuf::from(appdata);
        candidates.push(appdata.join("npm").join("claude.cmd"));
        candidates.push(appdata.join("npm").join("claude.exe"));
    }

    // %LOCALAPPDATA%\Volta (Volta tool manager)
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            std::path::PathBuf::from(local_appdata)
                .join("Volta")
                .join("bin")
                .join("claude.exe"),
        );
    }

    // %USERPROFILE%\.volta\bin (Volta alternative location)
    candidates.push(home.join(".volta").join("bin").join("claude.exe"));

    // fnm / nvm-windows: scan %APPDATA%\fnm\node-versions or %NVM_HOME%
    if let Ok(appdata) = std::env::var("APPDATA") {
        let fnm_dir = std::path::PathBuf::from(&appdata)
            .join("fnm")
            .join("node-versions");
        if fnm_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&fnm_dir) {
                let mut version_dirs: Vec<std::path::PathBuf> = entries
                    .filter_map(Result::ok)
                    .filter_map(|e| e.path().is_dir().then_some(e.path()))
                    .collect();
                version_dirs.sort_by(|a, b| {
                    b.file_name()
                        .unwrap_or_default()
                        .cmp(a.file_name().unwrap_or_default())
                });
                candidates.extend(
                    version_dirs
                        .into_iter()
                        .map(|d| d.join("installation").join("claude.cmd")),
                );
            }
        }
    }

    if let Ok(nvm_home) = std::env::var("NVM_HOME") {
        let nvm_dir = std::path::PathBuf::from(nvm_home);
        if let Ok(entries) = fs::read_dir(&nvm_dir) {
            let mut version_dirs: Vec<std::path::PathBuf> = entries
                .filter_map(Result::ok)
                .filter_map(|e| e.path().is_dir().then_some(e.path()))
                .collect();
            version_dirs.sort_by(|a, b| {
                b.file_name()
                    .unwrap_or_default()
                    .cmp(a.file_name().unwrap_or_default())
            });
            candidates.extend(version_dirs.into_iter().map(|d| d.join("claude.cmd")));
        }
    }

    // %ProgramFiles%\nodejs (system-wide Node.js installation)
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            std::path::PathBuf::from(program_files)
                .join("nodejs")
                .join("claude.cmd"),
        );
    }

    candidates.into_iter().find(|path| path.exists())
}

#[cfg(not(windows))]
fn find_claude_in_known_locations() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let mut candidates = vec![
        home.join(".local").join("bin").join("claude"),
        home.join(".claude").join("bin").join("claude"),
        home.join(".npm-global").join("bin").join("claude"),
        home.join(".nodebrew")
            .join("current")
            .join("bin")
            .join("claude"),
        home.join(".volta").join("bin").join("claude"),
        std::path::PathBuf::from("/opt/homebrew/bin/claude"),
        std::path::PathBuf::from("/usr/local/bin/claude"),
    ];

    let nvm_dir = std::env::var("NVM_DIR")
        .ok()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".nvm"));
    let nvm_versions_dir = nvm_dir.join("versions").join("node");

    if let Ok(entries) = fs::read_dir(nvm_versions_dir) {
        let mut version_dirs: Vec<std::path::PathBuf> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                path.is_dir().then_some(path)
            })
            .collect();
        version_dirs.sort_by(|a, b| {
            b.file_name()
                .unwrap_or_default()
                .cmp(a.file_name().unwrap_or_default())
        });
        candidates.extend(
            version_dirs
                .into_iter()
                .map(|dir| dir.join("bin").join("claude")),
        );
    }

    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(not(windows))]
fn find_claude_via_login_shell() -> Option<std::path::PathBuf> {
    use std::process::{Command, Stdio};

    let mut seen = HashSet::new();
    let mut shells = Vec::<std::path::PathBuf>::new();

    if let Ok(shell) = std::env::var("SHELL") {
        let path = std::path::PathBuf::from(shell);
        if path.is_file() && seen.insert(path.clone()) {
            shells.push(path);
        }
    }

    for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        let path = std::path::PathBuf::from(fallback);
        if path.is_file() && seen.insert(path.clone()) {
            shells.push(path);
        }
    }

    for shell in shells {
        let shell_name = shell
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let script = match shell_name {
            "zsh" => {
                "if [ -f \"$HOME/.zshrc\" ]; then source \"$HOME/.zshrc\"; fi; command -v claude"
            }
            "bash" => {
                "if [ -f \"$HOME/.bashrc\" ]; then source \"$HOME/.bashrc\"; fi; command -v claude"
            }
            _ => "command -v claude",
        };

        let mut command = Command::new(&shell);
        if matches!(shell_name, "zsh" | "bash") {
            command.arg("-l");
        }
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped());

        let output = match command.output() {
            Ok(value) if value.status.success() => value,
            _ => continue,
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines().map(str::trim) {
            if line.is_empty() {
                continue;
            }
            let path = std::path::PathBuf::from(line);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    None
}

/// Detect Claude CLI version.
pub fn detect_claude_version() -> ClaudeVersionResult {
    use std::process::Command;

    let claude_path = find_claude_executable();

    let result = if let Some(path) = &claude_path {
        let mut command = Command::new(path);
        add_parent_dir_to_path_env(&mut command, path);
        command.arg("--version").output()
    } else {
        Command::new("claude").arg("--version").output()
    };

    match result {
        Ok(output) => {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                ClaudeVersionResult {
                    ok: true,
                    version: Some(version),
                    command: Some("claude".to_string()),
                    resolved_path: claude_path.map(|p| p.to_string_lossy().into_owned()),
                    error: None,
                    message: None,
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                ClaudeVersionResult {
                    ok: false,
                    version: None,
                    command: Some("claude".to_string()),
                    resolved_path: claude_path.map(|p| p.to_string_lossy().into_owned()),
                    error: Some("COMMAND_FAILED".to_string()),
                    message: Some(stderr),
                }
            }
        }
        Err(err) => ClaudeVersionResult {
            ok: false,
            version: None,
            command: Some("claude".to_string()),
            resolved_path: claude_path.map(|p| p.to_string_lossy().into_owned()),
            error: Some("NOT_FOUND".to_string()),
            message: Some(err.to_string()),
        },
    }
}

/// Check MCP server status for the requested executor's CLI.
pub fn check_mcp_status(executor: BaseCodingAgent) -> McpStatusResult {
    match executor {
        BaseCodingAgent::ClaudeCode => check_claude_mcp_status(),
        BaseCodingAgent::Codex => check_codex_mcp_status(),
    }
}

fn check_claude_mcp_status() -> McpStatusResult {
    use std::process::Command;

    let claude_path = find_claude_executable();
    let result = if let Some(path) = &claude_path {
        let mut command = Command::new(path);
        add_parent_dir_to_path_env(&mut command, path);
        command.args(["mcp", "list"]).output()
    } else {
        Command::new("claude").args(["mcp", "list"]).output()
    };

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

fn check_codex_mcp_status() -> McpStatusResult {
    use std::process::Command;

    let result = Command::new("codex")
        .args(["mcp", "list", "--json"])
        .output();

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

/// Aggregated auth status for all known executors.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatusResult {
    pub claude_code: AvailabilityInfo,
    pub codex: AvailabilityInfo,
}

/// Installation info for executor CLIs required by onboarding and auth flows.
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
    pub git: ExecutorInstallInfo,
}

/// Result of triggering an auth login flow for an executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthLoginResult {
    pub ok: bool,
    pub executor: BaseCodingAgent,
    pub message: Option<String>,
    /// OAuth URL extracted from CLI stdout, if available.
    pub auth_url: Option<String>,
}

/// Query auth status for all executors.
///
/// Uses cached executor profiles to obtain a `CodingAgent` for each
/// `BaseCodingAgent` variant and calls `get_availability_info()` on it.
pub fn get_auth_status_all() -> AuthStatusResult {
    let configs = ExecutorConfigs::get_cached();

    let availability_for = |agent: BaseCodingAgent| -> AvailabilityInfo {
        let profile_id = ExecutorProfileId::new(agent);
        configs
            .get_coding_agent(&profile_id)
            .map(|ca| ca.get_availability_info())
            .unwrap_or(AvailabilityInfo::NotFound)
    };

    AuthStatusResult {
        claude_code: availability_for(BaseCodingAgent::ClaudeCode),
        codex: availability_for(BaseCodingAgent::Codex),
    }
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
    let git = detect_install_info("git").await;

    ExecutorInstallStatusResult {
        claude_code,
        codex,
        git,
    }
}

/// Tools that can be installed via the onboarding install endpoint.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InstallableTool {
    ClaudeCode,
    Codex,
    Git,
}

impl std::fmt::Display for InstallableTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClaudeCode => write!(f, "CLAUDE_CODE"),
            Self::Codex => write!(f, "CODEX"),
            Self::Git => write!(f, "GIT"),
        }
    }
}

/// Result of attempting to install a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInstallResult {
    pub ok: bool,
    pub tool: InstallableTool,
    pub command: String,
    pub strategy: String,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
}

/// Determine the install command for the given tool.
async fn get_install_strategy(
    tool: InstallableTool,
) -> Result<(&'static str, &'static str), String> {
    match tool {
        InstallableTool::ClaudeCode => {
            if cfg!(target_os = "windows") {
                if resolve_executable_path("npm").await.is_some() {
                    return Ok(("npm", "npm install -g @anthropic-ai/claude-code"));
                }
                return Err("Automatic install requires npm on Windows.".into());
            }
            if resolve_executable_path("curl").await.is_some() {
                return Ok((
                    "official installer",
                    "curl -fsSL https://claude.ai/install.sh | bash",
                ));
            }
            if resolve_executable_path("npm").await.is_some() {
                return Ok(("npm", "npm install -g @anthropic-ai/claude-code"));
            }
            Err("Automatic install requires curl or npm. Open the install guide to continue manually.".into())
        }
        InstallableTool::Codex => {
            if cfg!(target_os = "macos") && resolve_executable_path("brew").await.is_some() {
                return Ok(("Homebrew", "brew install --cask codex"));
            }
            if resolve_executable_path("npm").await.is_some() {
                return Ok(("npm", "npm install -g @openai/codex"));
            }
            Err("Automatic install requires Homebrew or npm. Open the install guide to continue manually.".into())
        }
        InstallableTool::Git => {
            if cfg!(target_os = "macos") {
                return Ok(("Xcode CLT", "xcode-select --install"));
            }
            if cfg!(target_os = "windows") {
                if resolve_executable_path("winget").await.is_some() {
                    return Ok(("winget", "winget install --id Git.Git -e --source winget"));
                }
                return Err(
                    "Automatic install requires winget. Download Git from https://git-scm.com"
                        .into(),
                );
            }
            if resolve_executable_path("apt-get").await.is_some() {
                return Ok(("apt", "sudo apt-get install -y git"));
            }
            if resolve_executable_path("brew").await.is_some() {
                return Ok(("Homebrew", "brew install git"));
            }
            Err("Automatic install requires Xcode CLI Tools, apt, or Homebrew.".into())
        }
    }
}

/// Install a tool using the best available strategy.
pub async fn install_tool(tool: InstallableTool) -> ToolInstallResult {
    let (strategy_label, command) = match get_install_strategy(tool).await {
        Ok(pair) => pair,
        Err(msg) => {
            return ToolInstallResult {
                ok: false,
                tool,
                command: String::new(),
                strategy: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                message: msg,
            };
        }
    };

    let label = tool.to_string();
    let cwd = std::env::temp_dir();
    match crate::shell::run_script_logged(&label, command, &cwd).await {
        Ok(output) if output.status.success() => ToolInstallResult {
            ok: true,
            tool,
            command: command.to_string(),
            strategy: strategy_label.to_string(),
            stdout: output.stdout.trim().to_string(),
            stderr: output.stderr.trim().to_string(),
            message: format!("Installed via {strategy_label}."),
        },
        Ok(output) => ToolInstallResult {
            ok: false,
            tool,
            command: command.to_string(),
            strategy: strategy_label.to_string(),
            stdout: output.stdout.trim().to_string(),
            stderr: output.stderr.trim().to_string(),
            message: output
                .stderr
                .lines()
                .last()
                .unwrap_or("Installation failed.")
                .trim()
                .to_string(),
        },
        Err(err) => ToolInstallResult {
            ok: false,
            tool,
            command: command.to_string(),
            strategy: strategy_label.to_string(),
            stdout: String::new(),
            stderr: String::new(),
            message: format!("Failed to run installer: {err}"),
        },
    }
}

/// Extract a non-localhost URL from text output.
fn extract_auth_url(text: &str) -> Option<String> {
    let url_re = regex::Regex::new(r"https?://[^\s\x1b\]\)>]+").ok()?;
    for m in url_re.find_iter(text) {
        let url = m
            .as_str()
            .trim_end_matches(|c: char| c == '.' || c == ',' || c == ')');
        // Skip localhost URLs
        if url.contains("127.0.0.1") || url.contains("localhost") || url.contains("::1") {
            continue;
        }
        return Some(url.to_string());
    }
    None
}

/// Trigger the OAuth login flow for the given executor's CLI.
///
/// Resolves the executable, spawns the login command, reads stdout/stderr
/// for up to 15 seconds to extract the OAuth URL, then returns the URL
/// so the frontend can open it in the browser.
pub async fn trigger_auth_login(
    executor: BaseCodingAgent,
) -> Result<AuthLoginResult, ExecutorError> {
    let (manifest, args): (&'static crate::cli_manifest::CliManifest, Vec<&str>) = match executor {
        BaseCodingAgent::ClaudeCode => (&crate::cli_manifest::CLAUDE, vec!["auth", "login"]),
        BaseCodingAgent::Codex => (&crate::cli_manifest::CODEX, vec!["login"]),
    };
    let program = manifest.command;

    let executable = crate::cli_resolver::resolve_cli(manifest)
        .await
        .map(|r| r.path)
        .ok_or_else(|| ExecutorError::ExecutableNotFound {
            program: program.to_string(),
            install_hint: Some(manifest.install_hint.to_string()),
        })?;

    let mut cmd = tokio::process::Command::new(&executable);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(ExecutorError::Io)?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Read output for up to 15 seconds looking for an auth URL
    let auth_url = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        read_auth_url(stdout, stderr),
    )
    .await
    .unwrap_or(None);

    Ok(AuthLoginResult {
        ok: true,
        executor,
        message: if auth_url.is_some() {
            Some("Auth URL extracted from CLI output".to_string())
        } else {
            Some(format!("Auth login process started for {program}"))
        },
        auth_url,
    })
}

/// Read stdout and stderr concurrently, looking for an auth URL.
async fn read_auth_url(
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
) -> Option<String> {
    use tokio::io::AsyncReadExt;

    let read_stream = |mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>| async move {
        let mut buf = vec![0u8; 4096];
        let mut accumulated = String::new();
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    accumulated.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some(url) = extract_auth_url(&accumulated) {
                        return Some(url);
                    }
                }
                Err(_) => break,
            }
        }
        None
    };

    let stdout_fut = async {
        match stdout {
            Some(s) => read_stream(Box::new(s)).await,
            None => None,
        }
    };
    let stderr_fut = async {
        match stderr {
            Some(s) => read_stream(Box::new(s)).await,
            None => None,
        }
    };

    tokio::select! {
        result = stdout_fut => if result.is_some() { return result; },
        result = stderr_fut => if result.is_some() { return result; },
    }
    None
}

#[cfg(test)]
mod tests {
    use super::extract_detected_version;

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
