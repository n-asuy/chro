mod assets;

pub use assets::{asset_dir, chats_dir, config_path, profiles_path};

use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use executors::{BaseCodingAgent, ExecutorProfileId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const CURRENT_VERSION: u32 = 20;

pub const DEFAULT_MERGE_COMMIT_TEMPLATE: &str =
    "{{title}} (chro {{task_short_id}}){{description_block}}";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LanguagePreference {
    #[default]
    En,
    Ja,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppTheme {
    Light,
    Dark,
    /// Follow the operating system's light/dark preference. Resolved to a
    /// concrete light/dark value by the renderer.
    #[default]
    System,
}

/// Application-wide appearance settings. Distinct from `EditorConfig`: the
/// theme here drives the whole app chrome, not just the code editor.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppearanceConfig {
    #[serde(default)]
    pub theme: AppTheme,
    /// Optional user-chosen accent seed as a `#rrggbb` hex string. `None` follows
    /// the built-in brand accent. The per-mode readability clamp happens at
    /// derivation time in the renderer, not on this stored seed.
    #[serde(default)]
    pub accent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorConfig {
    #[serde(default = "EditorConfig::default_font_size")]
    pub font_size: u8,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default = "EditorConfig::default_line_height")]
    pub line_height: f32,
    #[serde(default)]
    pub show_line_numbers: bool,
    #[serde(default = "EditorConfig::default_line_wrapping")]
    pub line_wrapping: bool,
    #[serde(default = "EditorConfig::default_tab_size")]
    pub tab_size: u8,
    #[serde(default = "EditorConfig::default_indent_with_spaces")]
    pub indent_with_spaces: bool,
    #[serde(default)]
    pub vim_mode: bool,
}

impl EditorConfig {
    fn default_font_size() -> u8 {
        15
    }
    fn default_line_height() -> f32 {
        1.6
    }
    fn default_line_wrapping() -> bool {
        true
    }
    fn default_tab_size() -> u8 {
        4
    }
    fn default_indent_with_spaces() -> bool {
        true
    }
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            font_size: Self::default_font_size(),
            font_family: None,
            line_height: Self::default_line_height(),
            show_line_numbers: false,
            line_wrapping: Self::default_line_wrapping(),
            tab_size: Self::default_tab_size(),
            indent_with_spaces: Self::default_indent_with_spaces(),
            vim_mode: false,
        }
    }
}

/// Desktop notification preferences. Notifications fire from the renderer via
/// the Tauri notification plugin; these gate whether and when.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationConfig {
    #[serde(default = "NotificationConfig::default_true")]
    pub enabled: bool,
    /// Notify when an agent task run finishes (completed or failed).
    #[serde(default = "NotificationConfig::default_true")]
    pub on_task_complete: bool,
    /// Notify when an agent blocks on an AskUserQuestion and needs an answer.
    #[serde(default = "NotificationConfig::default_true")]
    pub on_input_needed: bool,
}

impl NotificationConfig {
    fn default_true() -> bool {
        true
    }
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            on_task_complete: true,
            on_input_needed: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub executor_profile: ExecutorProfileId,
    pub github_token: Option<String>,
    pub language: LanguagePreference,
    #[serde(default)]
    pub show_hidden_entries: bool,
    #[serde(default)]
    pub editor: EditorConfig,
    #[serde(default)]
    pub appearance: AppearanceConfig,
    #[serde(default)]
    pub notifications: NotificationConfig,
    #[serde(default)]
    pub merge_commit_template: Option<String>,
    /// Opaque JSON blob for frontend UI state (panel widths, sidebar collapsed, etc.).
    #[serde(default)]
    pub ui_state: serde_json::Map<String, Value>,
    #[serde(default)]
    pub mobile_pairing: MobilePairingConfig,
    /// Extra launch arguments per agent CLI, one shell-style string each,
    /// validated by `executors::validate_launch_args` before they are stored.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_launch_args: BTreeMap<BaseCodingAgent, String>,
    /// Agents whose question tool is turned off; it is on for every other one.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub question_tool_disabled: BTreeSet<BaseCodingAgent>,
}

/// Addresses the user typed for phone pairing, beside the detected ones.
/// The server validates them before they are stored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobilePairingConfig {
    /// Saved custom addresses, in the order they were added.
    #[serde(default)]
    pub custom_addresses: Vec<String>,
    /// The custom address pairing codes advertise; `None` uses a detected one.
    #[serde(default)]
    pub selected_custom_address: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        let now = Utc::now();
        Self {
            version: CURRENT_VERSION,
            created_at: now,
            updated_at: now,
            executor_profile: ExecutorProfileId::default(),
            github_token: None,
            language: LanguagePreference::default(),
            show_hidden_entries: false,
            editor: EditorConfig::default(),
            appearance: AppearanceConfig::default(),
            notifications: NotificationConfig::default(),
            merge_commit_template: None,
            ui_state: serde_json::Map::new(),
            mobile_pairing: MobilePairingConfig::default(),
            agent_launch_args: BTreeMap::new(),
            question_tool_disabled: BTreeSet::new(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Unsupported config version {0}")]
    UnsupportedVersion(u32),
}

#[derive(Debug, Clone)]
pub struct ConfigService {
    location: PathBuf,
}

impl ConfigService {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            location: path.as_ref().to_path_buf(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.location
    }

    pub fn load(&self) -> Result<Config, ConfigError> {
        if !self.location.exists() {
            return Ok(Config::default());
        }

        let raw = fs::read_to_string(&self.location)?;
        let mut json: Value = serde_json::from_str(&raw)?;
        migrate_config(&mut json)?;
        let mut config: Config = serde_json::from_value(json)?;
        config.updated_at = Utc::now();
        Ok(config)
    }

    pub fn save(&self, mut config: Config) -> Result<(), ConfigError> {
        config.version = CURRENT_VERSION;
        config.updated_at = Utc::now();
        let parent = self
            .location
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        fs::create_dir_all(&parent)?;
        write_replacing(
            &parent,
            &self.location,
            &serde_json::to_vec_pretty(&config)?,
        )?;
        Ok(())
    }
}

/// Replace `path` with `bytes` in one step: write a sibling temporary file and
/// rename it over `path`, so a concurrent reader sees the old file or the new
/// one, never a partial write.
fn write_replacing(dir: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = path
        .file_name()
        .map_or_else(|| "config".into(), |name| name.to_string_lossy());
    let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = dir.join(format!(".{name}.{}.{unique}.tmp", std::process::id()));
    let written = fs::write(&temporary, bytes).and_then(|()| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Render a merge commit message from a template string.
///
/// Supported tokens:
/// - `{{title}}` – task title
/// - `{{task_id}}` – full task UUID
/// - `{{task_short_id}}` – 8-char short id
/// - `{{description}}` – task description (empty string when absent)
/// - `{{description_block}}` – `\n\n<description>` when present, empty otherwise
pub fn render_merge_commit_template(
    template: &str,
    title: &str,
    task_id: &str,
    task_short_id: &str,
    description: Option<&str>,
) -> String {
    let desc = description.unwrap_or("");
    let desc_block = if desc.is_empty() {
        String::new()
    } else {
        format!("\n\n{desc}")
    };
    template
        .replace("{{title}}", title)
        .replace("{{task_id}}", task_id)
        .replace("{{task_short_id}}", task_short_id)
        .replace("{{description}}", desc)
        .replace("{{description_block}}", &desc_block)
}

fn migrate_config(json: &mut Value) -> Result<(), ConfigError> {
    let version = json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(1);

    if version > CURRENT_VERSION {
        return Err(ConfigError::UnsupportedVersion(version));
    }

    if version < 2 {
        let executor = json
            .get_mut("executor_profile")
            .and_then(Value::as_object_mut);
        if executor.is_none() {
            json["executor_profile"] = serde_json::json!({
                "name": "claude-desktop",
                "provider": "anthropic",
                "model": "claude-sonnet-4-20250514",
                "temperature": 0.2,
                "max_tokens": 4000
            });
        }
        json["version"] = Value::from(2);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(2)
        < 3
    {
        json["version"] = Value::from(3);
        json["created_at"] = json
            .get("created_at")
            .cloned()
            .unwrap_or_else(|| Value::from(Utc::now().to_rfc3339()));
        json["updated_at"] = Value::from(Utc::now().to_rfc3339());
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(3)
        < 4
    {
        json["version"] = Value::from(4);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(4)
        < 5
    {
        json["version"] = Value::from(5);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(5)
        < 6
    {
        json["version"] = Value::from(6);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(6)
        < 7
    {
        if let Some(executor) = json
            .get_mut("executor_profile")
            .and_then(Value::as_object_mut)
        {
            executor.insert("plan_mode".into(), Value::Bool(false));
            executor.insert("dangerously_skip_permissions".into(), Value::Bool(true));
        }
        json["version"] = Value::from(7);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(7)
        < 8
    {
        json["executor_profile"] = serde_json::json!({
            "executor": "CLAUDE_CODE"
        });
        json["version"] = Value::from(8);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(8)
        < 9
    {
        if let Some(obj) = json.as_object_mut() {
            obj.remove("workspace_dir");
        }
        json["version"] = Value::from(9);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(9)
        < 10
    {
        if json.get("editor").is_none() {
            json["editor"] = serde_json::to_value(EditorConfig::default())
                .unwrap_or_else(|_| serde_json::json!({}));
        }
        json["version"] = Value::from(10);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(10)
        < 11
    {
        if let Some(editor) = json.get_mut("editor").and_then(Value::as_object_mut) {
            if editor.get("theme").is_none() {
                editor.insert(
                    "theme".into(),
                    serde_json::to_value(AppTheme::default()).unwrap(),
                );
            }
        }
        json["version"] = Value::from(11);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(11)
        < 12
    {
        if let Some(editor) = json.get_mut("editor").and_then(Value::as_object_mut) {
            if let Some(theme) = editor
                .get("theme")
                .and_then(Value::as_str)
                .map(String::from)
            {
                match theme.as_str() {
                    "light_contrast" => {
                        editor.insert("theme".into(), Value::from("light"));
                    }
                    "dark_contrast" => {
                        editor.insert("theme".into(), Value::from("dark"));
                    }
                    _ => {}
                }
            }
        }
        json["version"] = Value::from(12);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(12)
        < 13
    {
        json["version"] = Value::from(13);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(13)
        < 14
    {
        json["version"] = Value::from(14);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(14)
        < 15
    {
        // merge_commit_template defaults to None via serde; no data migration needed
        json["version"] = Value::from(15);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(15)
        < 16
    {
        // Move the app theme out of the editor config into its own
        // appearance domain. Preserve any explicit user choice.
        if json.get("appearance").is_none() {
            let theme = json
                .get("editor")
                .and_then(|editor| editor.get("theme"))
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| "light".to_string());
            json["appearance"] = serde_json::json!({ "theme": theme });
        }
        if let Some(editor) = json.get_mut("editor").and_then(Value::as_object_mut) {
            editor.remove("theme");
        }
        json["version"] = Value::from(16);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(16)
        < 17
    {
        json["version"] = Value::from(17);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(17)
        < 18
    {
        if json.get("notifications").is_none() {
            json["notifications"] = serde_json::to_value(NotificationConfig::default())
                .unwrap_or_else(|_| serde_json::json!({}));
        }
        json["version"] = Value::from(18);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(18)
        < 19
    {
        json["version"] = Value::from(19);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(19)
        < 20
    {
        if let Some(obj) = json.as_object_mut() {
            obj.remove("terminal");
            obj.remove("claude_code_execution_mode");
        }
        json["version"] = Value::from(20);
    }

    if json.get("language").is_none() {
        json["language"] = serde_json::json!(LanguagePreference::default());
    }

    if let Some(obj) = json.as_object_mut() {
        obj.remove("onboarding_acknowledged");
    }
    if json.get("show_hidden_entries").is_none() {
        json["show_hidden_entries"] = Value::Bool(false);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use executors::BaseCodingAgent;
    use tempfile::tempdir;

    #[test]
    fn legacy_telemetry_fields_are_ignored_and_not_saved() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        let service = ConfigService::new(&path);
        let mut legacy = serde_json::to_value(Config::default()).unwrap();
        legacy["analytics_enabled"] = Value::Bool(true);
        legacy["telemetry_id"] = Value::String("old-installation".into());
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let loaded = service.load().expect("old configuration remains readable");
        service.save(loaded).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(saved.get("analytics_enabled").is_none());
        assert!(saved.get("telemetry_id").is_none());
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        let service = ConfigService::new(&path);
        let config = Config {
            language: LanguagePreference::En,
            ..Config::default()
        };
        service.save(config.clone()).unwrap();
        let loaded = service.load().unwrap();
        assert_eq!(
            loaded.executor_profile.executor,
            config.executor_profile.executor
        );
        assert_eq!(loaded.language, LanguagePreference::En);
    }

    #[test]
    fn a_load_during_saves_never_reads_a_partial_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        let service = ConfigService::new(&path);
        service.save(Config::default()).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writers: Vec<_> = (0..2)
            .map(|_| {
                let service = ConfigService::new(&path);
                let stop = std::sync::Arc::clone(&stop);
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        service.save(Config::default()).unwrap();
                    }
                })
            })
            .collect();
        for _ in 0..500 {
            service.load().expect("a complete file");
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        for writer in writers {
            writer.join().unwrap();
        }
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name != "chro.json")
            .collect();
        assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
    }

    #[test]
    fn migration_adds_executor_profile() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        fs::write(
            &path,
            serde_json::json!({
                "version": 1,
                "analytics_enabled": true
            })
            .to_string(),
        )
        .unwrap();

        let service = ConfigService::new(&path);
        let config = service.load().unwrap();
        assert_eq!(config.version, CURRENT_VERSION);
        assert_eq!(
            config.executor_profile.executor,
            BaseCodingAgent::ClaudeCode
        );
        assert_eq!(config.language, LanguagePreference::default());
    }

    #[test]
    fn agent_launch_args_roundtrip_and_default_to_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        let service = ConfigService::new(&path);

        service.save(Config::default()).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            raw.get("agent_launch_args").is_none(),
            "empty map is not written"
        );
        assert!(service.load().unwrap().agent_launch_args.is_empty());

        let mut config = Config::default();
        config.agent_launch_args.insert(
            BaseCodingAgent::ClaudeCode,
            "--append-system-prompt \"Ask first.\"".to_string(),
        );
        service.save(config).unwrap();
        assert_eq!(
            service
                .load()
                .unwrap()
                .agent_launch_args
                .get(&BaseCodingAgent::ClaudeCode)
                .map(String::as_str),
            Some("--append-system-prompt \"Ask first.\"")
        );
    }

    #[test]
    fn default_path_missing_returns_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let service = ConfigService::new(&path);
        let config = service.load().unwrap();
        assert_eq!(config.version, CURRENT_VERSION);
        assert_eq!(config.language, LanguagePreference::default());
    }

    #[test]
    fn migration_removes_legacy_onboarding_flag() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        fs::write(
            &path,
            serde_json::json!({
                "version": CURRENT_VERSION,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
                "executor_profile": { "executor": "CLAUDE_CODE" },
                "analytics_enabled": false,
                "telemetry_id": "test-telemetry-id",
                "language": "ja",
                "onboarding_acknowledged": true,
                "show_hidden_entries": false,
                "editor": {
                    "font_size": 15,
                    "font_family": null,
                    "line_height": 1.6,
                    "show_line_numbers": false,
                    "line_wrapping": true,
                    "tab_size": 4,
                    "indent_with_spaces": true,
                    "vim_mode": false,
                    "theme": "light"
                }
            })
            .to_string(),
        )
        .unwrap();

        let service = ConfigService::new(&path);
        let config = service.load().unwrap();
        service.save(config).unwrap();

        let final_content = fs::read_to_string(&path).unwrap();
        let final_json: Value = serde_json::from_str(&final_content).unwrap();
        assert!(final_json.get("onboarding_acknowledged").is_none());
    }

    #[test]
    fn migration_removes_workspace_dir() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        fs::write(
            &path,
            serde_json::json!({
                "version": 8,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
                "executor_profile": { "executor": "CLAUDE_CODE" },
                "analytics_enabled": false,
                "language": "ja",
                "workspace_dir": "/some/old/path",
                "show_hidden_entries": false
            })
            .to_string(),
        )
        .unwrap();

        let service = ConfigService::new(&path);
        let config = service.load().unwrap();
        assert_eq!(config.version, CURRENT_VERSION);

        service.save(config).unwrap();
        let final_content = fs::read_to_string(&path).unwrap();
        let final_json: Value = serde_json::from_str(&final_content).unwrap();
        assert!(final_json.get("workspace_dir").is_none());
    }

    #[test]
    fn appearance_accent_defaults_to_none_and_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        let service = ConfigService::new(&path);

        // Default: no accent seed.
        assert_eq!(Config::default().appearance.accent, None);

        let mut config = Config::default();
        config.appearance.accent = Some("#7c3aed".to_string());
        service.save(config).unwrap();
        let loaded = service.load().unwrap();
        assert_eq!(loaded.appearance.accent.as_deref(), Some("#7c3aed"));
    }

    #[test]
    fn legacy_config_without_accent_loads_without_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        fs::write(
            &path,
            serde_json::json!({
                "version": CURRENT_VERSION,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
                "executor_profile": { "executor": "CLAUDE_CODE" },
                "analytics_enabled": false,
                "telemetry_id": "test-telemetry-id",
                "language": "en",
                "show_hidden_entries": false,
                "appearance": { "theme": "dark" }
            })
            .to_string(),
        )
        .unwrap();

        let service = ConfigService::new(&path);
        let config = service.load().unwrap();
        assert_eq!(config.appearance.theme, AppTheme::Dark);
        assert_eq!(config.appearance.accent, None);
    }

    #[test]
    fn migration_removes_retired_execution_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        fs::write(
            &path,
            serde_json::json!({
                "version": 18,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
                "executor_profile": { "executor": "CLAUDE_CODE" },
                "analytics_enabled": false,
                "telemetry_id": "test-telemetry-id",
                "language": "en",
                "show_hidden_entries": false,
                "terminal": {
                    "font_family": null,
                    "font_size": 13,
                    "line_height": 1.2
                },
                "claude_code_execution_mode": "legacy"
            })
            .to_string(),
        )
        .unwrap();

        let service = ConfigService::new(&path);
        let config = service.load().unwrap();
        assert_eq!(config.version, CURRENT_VERSION);
        service.save(config).unwrap();

        let migrated: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(migrated.get("terminal").is_none());
        assert!(migrated.get("claude_code_execution_mode").is_none());
    }
}
