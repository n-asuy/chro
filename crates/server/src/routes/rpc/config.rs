//! Preferences and executor configuration endpoints.

use axum::{
    extract::{Query, State},
    routing::{get, post, put},
    Json, Router,
};
use config::{
    AppTheme, AppearanceConfig, EditorConfig, LanguagePreference, NotificationConfig,
    TerminalConfig, DEFAULT_MERGE_COMMIT_TEMPLATE,
};
use executors::{
    check_mcp_status, delete_pi_credential, detect_claude_version, get_auth_status_all,
    get_install_status_all, install_tool, list_pi_credentials, list_pi_models, load_mcp_config,
    save_mcp_config, set_pi_api_key, AuthStatusResult, BaseCodingAgent, ClaudeExecutionMode,
    ClaudeVersionResult, ExecutorConfigs, ExecutorInstallStatusResult, ExecutorProfileId,
    InstallableTool, LoadedMcpConfig, McpConfigPayload, McpStatusResult, PiCredentialInfo,
    PiModelOption, SavedMcpConfig, ToolInstallResult,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::spawn_blocking;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/preferences", get(get_preferences).put(update_preferences))
        .route(
            "/preferences/editor",
            get(get_editor_config).put(update_editor_config),
        )
        .route(
            "/preferences/appearance",
            get(get_appearance_config).put(update_appearance_config),
        )
        .route(
            "/preferences/terminal",
            get(get_terminal_config).put(update_terminal_config),
        )
        .route(
            "/preferences/notifications",
            get(get_notification_config).put(update_notification_config),
        )
        .route(
            "/preferences/merge",
            get(get_merge_settings).put(update_merge_settings),
        )
        .route("/ui-state", get(get_ui_state).put(update_ui_state))
        .route(
            "/mcp-config",
            get(get_mcp_config_handler).put(update_mcp_config_handler),
        )
        .route("/executor/detect", get(detect_executor_handler))
        .route("/executor/install-status", get(get_install_status_handler))
        .route("/executor/install", post(install_executor_handler))
        .route("/executor/mcp-status", get(check_mcp_status_handler))
        .route("/executor/auth-status", get(get_auth_status_handler))
        .route("/executor/pi/models", get(get_pi_models_handler))
        .route("/executor/pi/credentials", get(get_pi_credentials_handler))
        .route(
            "/executor/pi/api-key",
            put(set_pi_api_key_handler).delete(delete_pi_credential_handler),
        )
        .route(
            "/executor/profile",
            get(get_executor_profile).put(update_executor_profile),
        )
}

#[derive(Debug, Serialize)]
struct PreferencesEnvelope {
    preferences: PreferencesPayload,
}

#[derive(Debug, Serialize)]
struct PreferencesPayload {
    language: LanguagePreference,
    show_hidden_entries: bool,
    analytics_enabled: bool,
    telemetry_id: String,
}

#[derive(Debug, Deserialize)]
struct UpdatePreferencesRequest {
    language: LanguagePreference,
    #[serde(default)]
    show_hidden_entries: Option<bool>,
    #[serde(default)]
    analytics_enabled: Option<bool>,
}

async fn get_preferences(
    State(state): State<AppState>,
) -> Result<Json<PreferencesEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(PreferencesEnvelope {
        preferences: PreferencesPayload {
            language: config.language,
            show_hidden_entries: config.show_hidden_entries,
            analytics_enabled: config.analytics_enabled,
            telemetry_id: config.telemetry_id,
        },
    }))
}

async fn update_preferences(
    State(state): State<AppState>,
    Json(payload): Json<UpdatePreferencesRequest>,
) -> Result<Json<PreferencesEnvelope>, ApiError> {
    let updated = state
        .runtime()
        .update_config(|config| {
            config.language = payload.language;
            if let Some(flag) = payload.show_hidden_entries {
                config.show_hidden_entries = flag;
            }
            if let Some(flag) = payload.analytics_enabled {
                config.analytics_enabled = flag;
                analytics::set_enabled(flag);
            }
        })
        .await?;
    Ok(Json(PreferencesEnvelope {
        preferences: PreferencesPayload {
            language: updated.language,
            show_hidden_entries: updated.show_hidden_entries,
            analytics_enabled: updated.analytics_enabled,
            telemetry_id: updated.telemetry_id,
        },
    }))
}

#[derive(Debug, Serialize)]
struct EditorConfigEnvelope {
    editor: EditorConfig,
}

#[derive(Debug, Deserialize)]
struct UpdateEditorConfigRequest {
    #[serde(default)]
    font_size: Option<u8>,
    #[serde(default)]
    font_family: Option<Option<String>>,
    #[serde(default)]
    line_height: Option<f32>,
    #[serde(default)]
    show_line_numbers: Option<bool>,
    #[serde(default)]
    line_wrapping: Option<bool>,
    #[serde(default)]
    tab_size: Option<u8>,
    #[serde(default)]
    indent_with_spaces: Option<bool>,
    #[serde(default)]
    vim_mode: Option<bool>,
}

async fn get_editor_config(
    State(state): State<AppState>,
) -> Result<Json<EditorConfigEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(EditorConfigEnvelope {
        editor: config.editor,
    }))
}

async fn update_editor_config(
    State(state): State<AppState>,
    Json(payload): Json<UpdateEditorConfigRequest>,
) -> Result<Json<EditorConfigEnvelope>, ApiError> {
    let updated = state
        .runtime()
        .update_config(|config| {
            if let Some(v) = payload.font_size {
                config.editor.font_size = v.clamp(12, 32);
            }
            if let Some(v) = payload.font_family {
                config.editor.font_family = v;
            }
            if let Some(v) = payload.line_height {
                config.editor.line_height = v.clamp(1.0, 2.5);
            }
            if let Some(v) = payload.show_line_numbers {
                config.editor.show_line_numbers = v;
            }
            if let Some(v) = payload.line_wrapping {
                config.editor.line_wrapping = v;
            }
            if let Some(v) = payload.tab_size {
                config.editor.tab_size = if v == 2 { 2 } else { 4 };
            }
            if let Some(v) = payload.indent_with_spaces {
                config.editor.indent_with_spaces = v;
            }
            if let Some(v) = payload.vim_mode {
                config.editor.vim_mode = v;
            }
        })
        .await?;
    Ok(Json(EditorConfigEnvelope {
        editor: updated.editor,
    }))
}

#[derive(Debug, Serialize)]
struct AppearanceConfigEnvelope {
    appearance: AppearanceConfig,
}

#[derive(Debug, Deserialize)]
struct UpdateAppearanceConfigRequest {
    #[serde(default)]
    theme: Option<AppTheme>,
    /// Accent seed hex. Absent leaves it unchanged; explicit `null` clears it
    /// (reset to the built-in brand). Malformed values are ignored (cleared) so a
    /// bad pick degrades to brand instead of corrupting config.
    #[serde(default, deserialize_with = "double_option")]
    accent: Option<Option<String>>,
}

/// Validate and normalize an accent seed to lowercase `#rrggbb`. Accepts 3- or
/// 6-digit hex with a leading `#`; returns `None` for anything malformed.
fn normalize_accent_hex(raw: &str) -> Option<String> {
    let hex = raw.trim().strip_prefix('#')?;
    let expanded = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => hex.to_string(),
        _ => return None,
    };
    expanded
        .chars()
        .all(|c| c.is_ascii_hexdigit())
        .then(|| format!("#{}", expanded.to_lowercase()))
}

async fn get_appearance_config(
    State(state): State<AppState>,
) -> Result<Json<AppearanceConfigEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(AppearanceConfigEnvelope {
        appearance: config.appearance,
    }))
}

async fn update_appearance_config(
    State(state): State<AppState>,
    Json(payload): Json<UpdateAppearanceConfigRequest>,
) -> Result<Json<AppearanceConfigEnvelope>, ApiError> {
    let updated = state
        .runtime()
        .update_config(|config| {
            if let Some(v) = payload.theme {
                config.appearance.theme = v;
            }
            if let Some(accent) = payload.accent {
                config.appearance.accent = accent.and_then(|hex| normalize_accent_hex(&hex));
            }
        })
        .await?;
    Ok(Json(AppearanceConfigEnvelope {
        appearance: updated.appearance,
    }))
}

#[derive(Debug, Serialize)]
struct TerminalConfigEnvelope {
    terminal: TerminalConfig,
}

#[derive(Debug, Deserialize)]
struct UpdateTerminalConfigRequest {
    #[serde(default)]
    font_family: Option<Option<String>>,
    #[serde(default)]
    font_size: Option<u8>,
    #[serde(default)]
    line_height: Option<f32>,
}

async fn get_terminal_config(
    State(state): State<AppState>,
) -> Result<Json<TerminalConfigEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(TerminalConfigEnvelope {
        terminal: config.terminal,
    }))
}

async fn update_terminal_config(
    State(state): State<AppState>,
    Json(payload): Json<UpdateTerminalConfigRequest>,
) -> Result<Json<TerminalConfigEnvelope>, ApiError> {
    let updated = state
        .runtime()
        .update_config(|config| {
            if let Some(v) = payload.font_family {
                config.terminal.font_family = v.and_then(|name| {
                    let trimmed = name.trim().to_string();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                });
            }
            if let Some(v) = payload.font_size {
                config.terminal.font_size = v.clamp(8, 32);
            }
            if let Some(v) = payload.line_height {
                config.terminal.line_height = v.clamp(1.0, 3.0);
            }
        })
        .await?;
    Ok(Json(TerminalConfigEnvelope {
        terminal: updated.terminal,
    }))
}

#[derive(Debug, Serialize)]
struct NotificationConfigEnvelope {
    notifications: NotificationConfig,
}

#[derive(Debug, Deserialize)]
struct UpdateNotificationConfigRequest {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    on_task_complete: Option<bool>,
    #[serde(default)]
    on_input_needed: Option<bool>,
}

async fn get_notification_config(
    State(state): State<AppState>,
) -> Result<Json<NotificationConfigEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(NotificationConfigEnvelope {
        notifications: config.notifications,
    }))
}

async fn update_notification_config(
    State(state): State<AppState>,
    Json(payload): Json<UpdateNotificationConfigRequest>,
) -> Result<Json<NotificationConfigEnvelope>, ApiError> {
    let updated = state
        .runtime()
        .update_config(|config| {
            if let Some(v) = payload.enabled {
                config.notifications.enabled = v;
            }
            if let Some(v) = payload.on_task_complete {
                config.notifications.on_task_complete = v;
            }
            if let Some(v) = payload.on_input_needed {
                config.notifications.on_input_needed = v;
            }
        })
        .await?;
    Ok(Json(NotificationConfigEnvelope {
        notifications: updated.notifications,
    }))
}

#[derive(Debug, Serialize)]
struct MergeSettingsEnvelope {
    merge_commit_template: String,
}

#[derive(Debug, Deserialize)]
struct UpdateMergeSettingsRequest {
    merge_commit_template: Option<String>,
}

async fn get_merge_settings(
    State(state): State<AppState>,
) -> Result<Json<MergeSettingsEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    let template = config
        .merge_commit_template
        .unwrap_or_else(|| DEFAULT_MERGE_COMMIT_TEMPLATE.to_string());
    Ok(Json(MergeSettingsEnvelope {
        merge_commit_template: template,
    }))
}

async fn update_merge_settings(
    State(state): State<AppState>,
    Json(payload): Json<UpdateMergeSettingsRequest>,
) -> Result<Json<MergeSettingsEnvelope>, ApiError> {
    let updated = state
        .runtime()
        .update_config(|config| {
            config.merge_commit_template = payload.merge_commit_template.and_then(|t| {
                let trimmed = t.trim().to_string();
                if trimmed.is_empty() || trimmed == DEFAULT_MERGE_COMMIT_TEMPLATE {
                    None
                } else {
                    Some(trimmed)
                }
            });
        })
        .await?;
    let template = updated
        .merge_commit_template
        .unwrap_or_else(|| DEFAULT_MERGE_COMMIT_TEMPLATE.to_string());
    Ok(Json(MergeSettingsEnvelope {
        merge_commit_template: template,
    }))
}

#[derive(Debug, Serialize)]
struct ExecutorProfileEnvelope {
    profile: ExecutorProfileId,
    profiles: ExecutorConfigs,
    /// Global Claude execution mode (PTY vs headless `claude -p`). App-wide,
    /// not part of the per-run profile.
    claude_execution_mode: ClaudeExecutionMode,
}

/// Deserialize an optional field that distinguishes "key absent" (leave the
/// value unchanged) from "key present and null" (clear it). Without this,
/// serde maps both to `None` and an execution-mode-only update would silently
/// reset the executor variant.
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(de)?))
}

#[derive(Debug, Deserialize)]
struct UpdateExecutorProfileRequest {
    /// The executor to use (e.g., "CLAUDE_CODE", "CODEX")
    #[serde(default)]
    executor: Option<BaseCodingAgent>,
    /// The variant to use (e.g., "DEFAULT", "PLAN", "APPROVALS"). Absent leaves
    /// the variant untouched; explicit `null` resets it to the default variant.
    #[serde(default, deserialize_with = "double_option")]
    variant: Option<Option<String>>,
    /// Global Claude execution mode. Absent leaves it unchanged.
    #[serde(default)]
    claude_execution_mode: Option<ClaudeExecutionMode>,
}

async fn get_executor_profile(
    State(state): State<AppState>,
) -> Result<Json<ExecutorProfileEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(ExecutorProfileEnvelope {
        profile: config.executor_profile,
        profiles: ExecutorConfigs::get_cached(),
        claude_execution_mode: config.claude_code_execution_mode,
    }))
}

async fn update_executor_profile(
    State(state): State<AppState>,
    Json(payload): Json<UpdateExecutorProfileRequest>,
) -> Result<Json<ExecutorProfileEnvelope>, ApiError> {
    let UpdateExecutorProfileRequest {
        executor,
        variant,
        claude_execution_mode,
    } = payload;

    let updated = state
        .runtime()
        .update_config(|config| {
            if let Some(new_executor) = executor {
                config.executor_profile.executor = new_executor;
            }
            if let Some(new_variant) = variant {
                config.executor_profile.variant = new_variant;
            }
            if let Some(mode) = claude_execution_mode {
                config.claude_code_execution_mode = mode;
            }
        })
        .await?;

    Ok(Json(ExecutorProfileEnvelope {
        profile: updated.executor_profile,
        profiles: ExecutorConfigs::get_cached(),
        claude_execution_mode: updated.claude_code_execution_mode,
    }))
}

#[derive(Debug, Deserialize)]
struct McpConfigQuery {
    #[serde(default)]
    executor: Option<BaseCodingAgent>,
}

#[derive(Debug, Serialize)]
struct McpConfigResponse {
    config_path: String,
    exists: bool,
    mcp_config: McpConfigPayload,
    servers_count: usize,
    parse_error: Option<String>,
    raw_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SaveMcpConfigRequest {
    servers: Value,
    #[serde(default)]
    executor: Option<BaseCodingAgent>,
}

#[derive(Debug, Serialize)]
struct McpConfigSaveResponse {
    config_path: String,
    mcp_config: McpConfigPayload,
    servers_count: usize,
}

async fn get_mcp_config_handler(
    Query(query): Query<McpConfigQuery>,
) -> Result<Json<McpConfigResponse>, ApiError> {
    let executor = query.executor.unwrap_or(BaseCodingAgent::ClaudeCode);
    let LoadedMcpConfig {
        config_path,
        exists,
        mcp_config,
        servers_count,
        parse_error,
        raw_content,
    } = load_mcp_config(executor, None).await?;

    Ok(Json(McpConfigResponse {
        config_path: config_path.to_string_lossy().into_owned(),
        exists,
        mcp_config,
        servers_count,
        parse_error,
        raw_content,
    }))
}

async fn update_mcp_config_handler(
    Query(query): Query<McpConfigQuery>,
    Json(payload): Json<SaveMcpConfigRequest>,
) -> Result<Json<McpConfigSaveResponse>, ApiError> {
    let executor = payload
        .executor
        .or(query.executor)
        .unwrap_or(BaseCodingAgent::ClaudeCode);
    let SavedMcpConfig {
        config_path,
        mcp_config,
        servers_count,
    } = save_mcp_config(executor, payload.servers, None).await?;

    Ok(Json(McpConfigSaveResponse {
        config_path: config_path.to_string_lossy().into_owned(),
        mcp_config,
        servers_count,
    }))
}

async fn detect_executor_handler() -> Json<ClaudeVersionResult> {
    Json(detect_claude_version().await)
}

#[derive(Debug, Deserialize)]
struct CheckMcpStatusQuery {
    executor: Option<BaseCodingAgent>,
}

async fn check_mcp_status_handler(
    Query(query): Query<CheckMcpStatusQuery>,
) -> Json<McpStatusResult> {
    let executor = query.executor.unwrap_or(BaseCodingAgent::ClaudeCode);
    Json(check_mcp_status(executor).await)
}

async fn get_auth_status_handler() -> Json<AuthStatusResult> {
    let result = spawn_blocking(get_auth_status_all)
        .await
        .unwrap_or_else(|_| AuthStatusResult {
            claude_code: executors::AvailabilityInfo::NotFound,
            codex: executors::AvailabilityInfo::NotFound,
            pi: executors::AvailabilityInfo::NotFound,
        });
    Json(result)
}

/// Configured pi models for the runtime picker. Empty when pi is unconfigured or
/// unreachable, in which case the picker falls back to "Default".
async fn get_pi_models_handler() -> Json<Vec<PiModelOption>> {
    Json(list_pi_models().await.unwrap_or_default())
}

/// Providers configured in pi's auth file (no secrets returned).
async fn get_pi_credentials_handler() -> Json<Vec<PiCredentialInfo>> {
    Json(list_pi_credentials())
}

#[derive(Debug, Serialize)]
struct PiCredentialMutationResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SetPiApiKeyRequest {
    provider: String,
    key: String,
}

/// Store an API key for a pi provider in `~/.pi/agent/auth.json`.
async fn set_pi_api_key_handler(
    Json(payload): Json<SetPiApiKeyRequest>,
) -> Json<PiCredentialMutationResult> {
    match set_pi_api_key(&payload.provider, &payload.key) {
        Ok(()) => Json(PiCredentialMutationResult {
            ok: true,
            message: None,
        }),
        Err(err) => Json(PiCredentialMutationResult {
            ok: false,
            message: Some(err.to_string()),
        }),
    }
}

#[derive(Debug, Deserialize)]
struct PiProviderQuery {
    provider: String,
}

/// Remove a pi provider credential.
async fn delete_pi_credential_handler(
    Query(query): Query<PiProviderQuery>,
) -> Json<PiCredentialMutationResult> {
    match delete_pi_credential(&query.provider) {
        Ok(()) => Json(PiCredentialMutationResult {
            ok: true,
            message: None,
        }),
        Err(err) => Json(PiCredentialMutationResult {
            ok: false,
            message: Some(err.to_string()),
        }),
    }
}

async fn get_install_status_handler() -> Json<ExecutorInstallStatusResult> {
    Json(get_install_status_all().await)
}

#[derive(Debug, Deserialize)]
struct InstallToolRequest {
    tool: InstallableTool,
}

async fn install_executor_handler(
    Json(payload): Json<InstallToolRequest>,
) -> Json<ToolInstallResult> {
    Json(install_tool(payload.tool).await)
}

// -- UI State (replaces localStorage) --

#[derive(Debug, Serialize)]
struct UiStateEnvelope {
    ui_state: serde_json::Map<String, Value>,
}

async fn get_ui_state(State(state): State<AppState>) -> Result<Json<UiStateEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(UiStateEnvelope {
        ui_state: config.ui_state,
    }))
}

async fn update_ui_state(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Map<String, Value>>,
) -> Result<Json<UiStateEnvelope>, ApiError> {
    let updated = state
        .runtime()
        .update_config(|config| {
            for (key, value) in payload {
                if value.is_null() {
                    config.ui_state.remove(&key);
                } else {
                    config.ui_state.insert(key, value);
                }
            }
        })
        .await?;
    Ok(Json(UiStateEnvelope {
        ui_state: updated.ui_state,
    }))
}

#[cfg(test)]
mod tests {
    use super::normalize_accent_hex;

    #[test]
    fn normalizes_valid_six_digit_hex() {
        assert_eq!(normalize_accent_hex("#7C3AED").as_deref(), Some("#7c3aed"));
        assert_eq!(
            normalize_accent_hex("  #0c6cbe ").as_deref(),
            Some("#0c6cbe")
        );
    }

    #[test]
    fn expands_three_digit_hex() {
        assert_eq!(normalize_accent_hex("#0af").as_deref(), Some("#00aaff"));
    }

    #[test]
    fn rejects_malformed_values() {
        assert_eq!(normalize_accent_hex("not-a-color"), None);
        assert_eq!(normalize_accent_hex(""), None);
        assert_eq!(normalize_accent_hex("#"), None);
        assert_eq!(normalize_accent_hex("#12"), None);
        assert_eq!(normalize_accent_hex("#1234"), None);
        assert_eq!(normalize_accent_hex("7c3aed"), None); // missing '#'
        assert_eq!(normalize_accent_hex("#zzzzzz"), None);
    }
}
