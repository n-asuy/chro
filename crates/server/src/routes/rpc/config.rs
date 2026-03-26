//! Preferences and executor configuration endpoints.

use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use config::{AppTheme, EditorConfig, LanguagePreference, DEFAULT_MERGE_COMMIT_TEMPLATE};
use executors::{
    anthropic_model_presets, check_mcp_status, detect_claude_version, get_auth_status_all,
    load_mcp_config, save_mcp_config, trigger_auth_login, AuthLoginResult, AuthStatusResult,
    BaseCodingAgent, ClaudeVersionResult, ExecutorConfigs, ExecutorProfileId, LoadedMcpConfig,
    McpConfigPayload, McpStatusResult, ModelPreset, SavedMcpConfig,
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
            "/preferences/merge",
            get(get_merge_settings).put(update_merge_settings),
        )
        .route("/ui-state", get(get_ui_state).put(update_ui_state))
        .route(
            "/mcp-config",
            get(get_mcp_config_handler).put(update_mcp_config_handler),
        )
        .route("/executor/detect", get(detect_executor_handler))
        .route("/executor/mcp-status", get(check_mcp_status_handler))
        .route("/executor/auth-status", get(get_auth_status_handler))
        .route("/executor/auth", post(start_auth_handler))
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
    #[serde(default)]
    theme: Option<AppTheme>,
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
            if let Some(v) = payload.theme {
                config.editor.theme = v;
            }
        })
        .await?;
    Ok(Json(EditorConfigEnvelope {
        editor: updated.editor,
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
    options: ExecutorProfileOptions,
}

#[derive(Debug, Serialize)]
struct ExecutorProfileOptions {
    anthropic_models: &'static [ModelPreset],
}

#[derive(Debug, Deserialize)]
struct UpdateExecutorProfileRequest {
    /// The executor to use (e.g., "CLAUDE_CODE", "CODEX")
    #[serde(default)]
    executor: Option<BaseCodingAgent>,
    /// The variant to use (e.g., "DEFAULT", "PLAN", "APPROVALS")
    #[serde(default)]
    variant: Option<String>,
}

async fn get_executor_profile(
    State(state): State<AppState>,
) -> Result<Json<ExecutorProfileEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(ExecutorProfileEnvelope {
        profile: config.executor_profile,
        profiles: ExecutorConfigs::get_cached(),
        options: ExecutorProfileOptions {
            anthropic_models: anthropic_model_presets(),
        },
    }))
}

async fn update_executor_profile(
    State(state): State<AppState>,
    Json(payload): Json<UpdateExecutorProfileRequest>,
) -> Result<Json<ExecutorProfileEnvelope>, ApiError> {
    let UpdateExecutorProfileRequest { executor, variant } = payload;

    let updated = state
        .runtime()
        .update_config(|config| {
            if let Some(new_executor) = executor {
                config.executor_profile.executor = new_executor;
            }
            config.executor_profile.variant = variant;
        })
        .await?;

    Ok(Json(ExecutorProfileEnvelope {
        profile: updated.executor_profile,
        profiles: ExecutorConfigs::get_cached(),
        options: ExecutorProfileOptions {
            anthropic_models: anthropic_model_presets(),
        },
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
    let result = spawn_blocking(detect_claude_version)
        .await
        .unwrap_or_else(|err| ClaudeVersionResult {
            ok: false,
            version: None,
            command: None,
            resolved_path: None,
            error: Some("UNEXPECTED_ERROR".to_string()),
            message: Some(err.to_string()),
        });
    Json(result)
}

#[derive(Debug, Deserialize)]
struct CheckMcpStatusQuery {
    executor: Option<BaseCodingAgent>,
}

async fn check_mcp_status_handler(
    Query(query): Query<CheckMcpStatusQuery>,
) -> Json<McpStatusResult> {
    let executor = query.executor.unwrap_or(BaseCodingAgent::ClaudeCode);
    let result = spawn_blocking(move || check_mcp_status(executor))
        .await
        .unwrap_or_else(|err| McpStatusResult {
            ok: false,
            servers: Vec::new(),
            error: Some("UNEXPECTED_ERROR".to_string()),
            message: Some(err.to_string()),
        });
    Json(result)
}

async fn get_auth_status_handler() -> Json<AuthStatusResult> {
    let result = spawn_blocking(get_auth_status_all)
        .await
        .unwrap_or_else(|_| AuthStatusResult {
            claude_code: executors::AvailabilityInfo::NotFound,
            codex: executors::AvailabilityInfo::NotFound,
        });
    Json(result)
}

#[derive(Debug, Deserialize)]
struct StartAuthRequest {
    executor: BaseCodingAgent,
}

async fn start_auth_handler(
    Json(payload): Json<StartAuthRequest>,
) -> Result<Json<AuthLoginResult>, ApiError> {
    let result = trigger_auth_login(payload.executor).await?;
    Ok(Json(result))
}

// -- UI State (replaces localStorage) --

#[derive(Debug, Serialize)]
struct UiStateEnvelope {
    ui_state: serde_json::Map<String, Value>,
}

async fn get_ui_state(
    State(state): State<AppState>,
) -> Result<Json<UiStateEnvelope>, ApiError> {
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
