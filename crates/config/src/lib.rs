mod assets;
mod legacy_migration;

pub use assets::{asset_dir, config_path, profiles_path};
pub use legacy_migration::migrate_legacy_dirs;

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use executors::ExecutorProfileId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

const CURRENT_VERSION: u32 = 15;

pub const DEFAULT_MERGE_COMMIT_TEMPLATE: &str =
    "{{title}} (chro {{task_short_id}}){{description_block}}";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LanguagePreference {
    En,
    Ja,
}

impl Default for LanguagePreference {
    fn default() -> Self {
        LanguagePreference::En
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppTheme {
    Light,
    Dark,
}

impl Default for AppTheme {
    fn default() -> Self {
        AppTheme::Light
    }
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
    #[serde(default)]
    pub theme: AppTheme,
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
            theme: AppTheme::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub executor_profile: ExecutorProfileId,
    pub analytics_enabled: bool,
    #[serde(default = "default_telemetry_id")]
    pub telemetry_id: String,
    pub github_token: Option<String>,
    pub language: LanguagePreference,
    #[serde(default)]
    pub show_hidden_entries: bool,
    #[serde(default)]
    pub editor: EditorConfig,
    #[serde(default)]
    pub merge_commit_template: Option<String>,
    /// Opaque JSON blob for frontend UI state (panel widths, sidebar collapsed, etc.).
    #[serde(default)]
    pub ui_state: serde_json::Map<String, Value>,
}

fn default_telemetry_id() -> String {
    Uuid::new_v4().to_string()
}

impl Default for Config {
    fn default() -> Self {
        let now = Utc::now();
        Self {
            version: CURRENT_VERSION,
            created_at: now,
            updated_at: now,
            executor_profile: ExecutorProfileId::default(),
            analytics_enabled: true,
            telemetry_id: default_telemetry_id(),
            github_token: None,
            language: LanguagePreference::default(),
            show_hidden_entries: false,
            editor: EditorConfig::default(),
            merge_commit_template: None,
            ui_state: serde_json::Map::new(),
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
        fs::create_dir_all(parent)?;
        fs::write(&self.location, serde_json::to_vec_pretty(&config)?)?;
        Ok(())
    }
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
        json["analytics_enabled"] = Value::Bool(true);
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
        json["analytics_enabled"] = Value::Bool(true);
        json["version"] = Value::from(13);
    }

    if json
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(13)
        < 14
    {
        if json.get("telemetry_id").is_none() {
            json["telemetry_id"] = Value::String(Uuid::new_v4().to_string());
        }
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
    fn save_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chro.json");
        let service = ConfigService::new(&path);
        let mut config = Config::default();
        config.analytics_enabled = true;
        config.language = LanguagePreference::En;
        service.save(config.clone()).unwrap();
        let loaded = service.load().unwrap();
        assert_eq!(loaded.analytics_enabled, true);
        assert_eq!(
            loaded.executor_profile.executor,
            config.executor_profile.executor
        );
        assert_eq!(loaded.language, LanguagePreference::En);
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
}
