//! Preferences and executor configuration endpoints.

use std::collections::{BTreeMap, BTreeSet};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, put},
    Extension, Json, Router,
};
use config::{
    AppTheme, AppearanceConfig, EditorConfig, LanguagePreference, NotificationConfig,
    DEFAULT_MERGE_COMMIT_TEMPLATE,
};
use executors::{
    check_mcp_status, delete_pi_credential, get_install_status_all, list_pi_credentials,
    list_pi_models, load_mcp_config, save_mcp_config, set_pi_api_key, supports_question_tool,
    validate_launch_args, BaseCodingAgent, ExecutorConfigs, ExecutorInstallStatusResult,
    ExecutorProfileId, LaunchArgsError, LoadedMcpConfig, McpConfigPayload, McpStatusResult,
    PiCredentialInfo, PiModelOption, SavedMcpConfig,
};
use runtime::Runtime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{mobile::mcp_redaction, operator::DeviceAdmission, ApiError, AppState};

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
        .route("/executor/install-status", get(get_install_status_handler))
        .route("/executor/mcp-status", get(check_mcp_status_handler))
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
        .route(
            "/executor/launch-settings",
            get(get_agent_launch_settings).put(update_agent_launch_settings),
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
}

#[derive(Debug, Deserialize)]
struct UpdatePreferencesRequest {
    language: LanguagePreference,
    #[serde(default)]
    show_hidden_entries: Option<bool>,
}

async fn get_preferences(
    State(state): State<AppState>,
) -> Result<Json<PreferencesEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(PreferencesEnvelope {
        preferences: PreferencesPayload {
            language: config.language,
            show_hidden_entries: config.show_hidden_entries,
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
        })
        .await?;
    Ok(Json(PreferencesEnvelope {
        preferences: PreferencesPayload {
            language: updated.language,
            show_hidden_entries: updated.show_hidden_entries,
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
}

/// Deserialize an optional field that distinguishes "key absent" (leave the
/// value unchanged) from "key present and null" (clear it). Without this,
/// serde maps both to `None` and an executor-only update would silently reset
/// the variant.
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
    /// The variant to use (e.g., "DEFAULT"). Absent leaves
    /// the variant untouched; explicit `null` resets it to the default variant.
    #[serde(default, deserialize_with = "double_option")]
    variant: Option<Option<String>>,
}

async fn get_executor_profile(
    State(state): State<AppState>,
) -> Result<Json<ExecutorProfileEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(ExecutorProfileEnvelope {
        profile: config.executor_profile,
        profiles: ExecutorConfigs::get_cached(),
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
            if let Some(new_variant) = variant {
                config.executor_profile.variant = new_variant;
            }
        })
        .await?;

    Ok(Json(ExecutorProfileEnvelope {
        profile: updated.executor_profile,
        profiles: ExecutorConfigs::get_cached(),
    }))
}

#[derive(Debug, Serialize)]
struct AgentLaunchSettingsEnvelope {
    /// Extra launch arguments per agent.
    launch_args: BTreeMap<BaseCodingAgent, String>,
    /// Agents that have a question tool chro can turn off.
    question_tool_agents: Vec<BaseCodingAgent>,
    /// Agents whose question tool is off.
    question_tool_disabled: BTreeSet<BaseCodingAgent>,
}

impl AgentLaunchSettingsEnvelope {
    fn of(config: config::Config) -> Self {
        Self {
            launch_args: config.agent_launch_args,
            question_tool_agents: [
                BaseCodingAgent::ClaudeCode,
                BaseCodingAgent::Codex,
                BaseCodingAgent::Pi,
            ]
            .into_iter()
            .filter(|agent| supports_question_tool(*agent))
            .collect(),
            question_tool_disabled: config.question_tool_disabled,
        }
    }
}

/// Change one agent's launch settings; absent fields stay as they are.
#[derive(Debug, Deserialize)]
struct UpdateAgentLaunchSettingsRequest {
    executor: BaseCodingAgent,
    /// Shell-style argument string; empty clears the agent's arguments.
    #[serde(default)]
    args: Option<String>,
    /// Whether the agent may ask multiple-choice questions.
    #[serde(default)]
    question_tool: Option<bool>,
}

/// Why an update was refused. Rejections answer
/// `{error: {code, message, flag?}}` so the client can word them itself.
enum LaunchSettingsError {
    Rejected(LaunchArgsError),
    QuestionToolUnsupported,
    Api(ApiError),
}

impl From<runtime::RuntimeError> for LaunchSettingsError {
    fn from(err: runtime::RuntimeError) -> Self {
        Self::Api(err.into())
    }
}

impl IntoResponse for LaunchSettingsError {
    fn into_response(self) -> Response {
        let body = match self {
            Self::Api(err) => return err.into_response(),
            Self::QuestionToolUnsupported => json!({ "error": {
                "code": "question_tool_unsupported",
                "message": "this agent has no question tool to turn off",
            }}),
            Self::Rejected(err) => {
                let message = err.to_string();
                match err {
                    LaunchArgsError::Unparseable => {
                        json!({ "error": { "code": "unparseable", "message": message } })
                    }
                    LaunchArgsError::ReservedFlag { flag } => json!({
                        "error": { "code": "reserved_flag", "message": message, "flag": flag }
                    }),
                    LaunchArgsError::QuestionToolFlag => {
                        json!({ "error": { "code": "question_tool_flag", "message": message } })
                    }
                }
            }
        };
        (StatusCode::BAD_REQUEST, Json(body)).into_response()
    }
}

async fn get_agent_launch_settings(
    State(state): State<AppState>,
) -> Result<Json<AgentLaunchSettingsEnvelope>, ApiError> {
    Ok(Json(AgentLaunchSettingsEnvelope::of(
        state.runtime().current_config().await,
    )))
}

async fn update_agent_launch_settings(
    State(state): State<AppState>,
    Json(payload): Json<UpdateAgentLaunchSettingsRequest>,
) -> Result<Json<AgentLaunchSettingsEnvelope>, LaunchSettingsError> {
    let executor = payload.executor;
    let args = payload
        .args
        .map(|raw| validate_launch_args(executor, &raw))
        .transpose()
        .map_err(LaunchSettingsError::Rejected)?;
    if payload.question_tool.is_some() && !supports_question_tool(executor) {
        return Err(LaunchSettingsError::QuestionToolUnsupported);
    }
    let updated = state
        .runtime()
        .update_config(|config| {
            match args {
                Some(args) if args.is_empty() => {
                    config.agent_launch_args.remove(&executor);
                }
                Some(args) => {
                    config.agent_launch_args.insert(executor, args);
                }
                None => {}
            }
            match payload.question_tool {
                Some(true) => {
                    config.question_tool_disabled.remove(&executor);
                }
                Some(false) => {
                    config.question_tool_disabled.insert(executor);
                }
                None => {}
            }
        })
        .await?;
    Ok(Json(AgentLaunchSettingsEnvelope::of(updated)))
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

/// A paired device's request: its MCP views hide credentials.
type DeviceCaller = Option<Extension<DeviceAdmission>>;

async fn get_mcp_config_handler(
    device: DeviceCaller,
    Query(query): Query<McpConfigQuery>,
) -> Result<Json<McpConfigResponse>, ApiError> {
    let executor = query.executor.unwrap_or(BaseCodingAgent::ClaudeCode);
    let LoadedMcpConfig {
        config_path,
        exists,
        mut mcp_config,
        servers_count,
        parse_error,
        raw_content,
    } = load_mcp_config(executor, None).await?;

    if device.is_some() {
        // The file's raw text and the parser's message (which can quote a
        // line of it) stay on the computer.
        mcp_config.servers = mcp_redaction::redact_servers(&mcp_config.servers);
        return Ok(Json(McpConfigResponse {
            config_path: config_path.to_string_lossy().into_owned(),
            exists,
            mcp_config,
            servers_count,
            parse_error: parse_error.map(|_| UNPARSEABLE_FOR_DEVICE.to_string()),
            raw_content: None,
        }));
    }
    Ok(Json(McpConfigResponse {
        config_path: config_path.to_string_lossy().into_owned(),
        exists,
        mcp_config,
        servers_count,
        parse_error,
        raw_content,
    }))
}

const UNPARSEABLE_FOR_DEVICE: &str =
    "The MCP configuration file on the computer could not be parsed. Fix it on the computer.";

async fn update_mcp_config_handler(
    device: DeviceCaller,
    Query(query): Query<McpConfigQuery>,
    Json(payload): Json<SaveMcpConfigRequest>,
) -> Result<Json<McpConfigSaveResponse>, ApiError> {
    let executor = payload
        .executor
        .or(query.executor)
        .unwrap_or(BaseCodingAgent::ClaudeCode);
    let servers = if device.is_some() {
        // A device edits the redacted view: put the hidden values back. A
        // file that does not parse would be replaced wholesale by a save, so
        // a device may not save over it.
        let current = load_mcp_config(executor, None).await?;
        if current.parse_error.is_some() {
            return Err(ApiError::BadRequest(UNPARSEABLE_FOR_DEVICE.to_string()));
        }
        mcp_redaction::restore_servers(payload.servers, &current.mcp_config.servers)
            .map_err(|err| ApiError::BadRequest(err.to_string()))?
    } else {
        payload.servers
    };
    let SavedMcpConfig {
        config_path,
        mut mcp_config,
        servers_count,
    } = save_mcp_config(executor, servers, None).await?;

    if device.is_some() {
        mcp_config.servers = mcp_redaction::redact_servers(&mcp_config.servers);
    }
    Ok(Json(McpConfigSaveResponse {
        config_path: config_path.to_string_lossy().into_owned(),
        mcp_config,
        servers_count,
    }))
}

#[derive(Debug, Deserialize)]
struct CheckMcpStatusQuery {
    executor: Option<BaseCodingAgent>,
}

async fn check_mcp_status_handler(
    device: DeviceCaller,
    Query(query): Query<CheckMcpStatusQuery>,
) -> Json<McpStatusResult> {
    let executor = query.executor.unwrap_or(BaseCodingAgent::ClaudeCode);
    let mut status = check_mcp_status(executor).await;
    if device.is_some() {
        // The CLI reports each server's command line, URLs included.
        for server in &mut status.servers {
            server.command = mcp_redaction::redact_text(&server.command);
        }
        status.error = status.error.as_deref().map(mcp_redaction::redact_text);
        status.message = status.message.as_deref().map(mcp_redaction::redact_text);
    }
    Json(status)
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

// -- UI State (replaces localStorage) --

#[derive(Debug, Serialize)]
struct UiStateEnvelope {
    ui_state: serde_json::Map<String, Value>,
    /// The config file holding UI state can serve several databases; this
    /// names the one this server uses.
    database: String,
}

async fn get_ui_state(State(state): State<AppState>) -> Result<Json<UiStateEnvelope>, ApiError> {
    let config = state.runtime().current_config().await;
    Ok(Json(UiStateEnvelope {
        ui_state: config.ui_state,
        database: state.runtime().db().database_id().await?,
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
        database: state.runtime().db().database_id().await?,
    }))
}

#[cfg(test)]
mod launch_settings_tests {
    use super::*;
    use axum::body::to_bytes;

    type Rejection = (StatusCode, Value);

    async fn put(
        state: &AppState,
        executor: BaseCodingAgent,
        args: Option<&str>,
        question_tool: Option<bool>,
    ) -> Result<AgentLaunchSettingsEnvelope, Rejection> {
        let request = UpdateAgentLaunchSettingsRequest {
            executor,
            args: args.map(str::to_string),
            question_tool,
        };
        match update_agent_launch_settings(State(state.clone()), Json(request)).await {
            Ok(Json(envelope)) => Ok(envelope),
            Err(err) => {
                let response = err.into_response();
                let status = response.status();
                let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                Err((status, serde_json::from_slice(&bytes).unwrap()))
            }
        }
    }

    async fn read(state: &AppState) -> AgentLaunchSettingsEnvelope {
        let Json(envelope) = get_agent_launch_settings(State(state.clone()))
            .await
            .unwrap();
        envelope
    }

    #[tokio::test]
    async fn stores_trims_and_clears_launch_args_per_agent() {
        let app = crate::test_support::app().await;
        let saved = put(
            &app.state,
            BaseCodingAgent::ClaudeCode,
            Some("  --append-system-prompt \"Ask first.\"  "),
            None,
        )
        .await
        .expect("accepted");
        assert_eq!(
            saved
                .launch_args
                .get(&BaseCodingAgent::ClaudeCode)
                .map(String::as_str),
            Some("--append-system-prompt \"Ask first.\"")
        );
        assert_eq!(read(&app.state).await.launch_args, saved.launch_args);

        let cleared = put(&app.state, BaseCodingAgent::ClaudeCode, Some("   "), None)
            .await
            .expect("accepted");
        assert!(!cleared
            .launch_args
            .contains_key(&BaseCodingAgent::ClaudeCode));
    }

    #[tokio::test]
    async fn refuses_reserved_flags_with_a_coded_error_and_keeps_the_old_value() {
        let app = crate::test_support::app().await;
        put(
            &app.state,
            BaseCodingAgent::Pi,
            Some("--verbose-tools"),
            None,
        )
        .await
        .expect("accepted");

        let (status, body) = put(&app.state, BaseCodingAgent::Pi, Some("--model x"), None)
            .await
            .expect_err("refused");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "reserved_flag");
        assert_eq!(body["error"]["flag"], "--model");
        assert_eq!(
            read(&app.state)
                .await
                .launch_args
                .get(&BaseCodingAgent::Pi)
                .map(String::as_str),
            Some("--verbose-tools")
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn refuses_unparseable_arguments() {
        let app = crate::test_support::app().await;
        let (status, body) = put(&app.state, BaseCodingAgent::Codex, Some("-c \"open"), None)
            .await
            .expect_err("refused");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "unparseable");
    }

    #[tokio::test]
    async fn toggles_the_question_tool_for_agents_that_have_one() {
        let app = crate::test_support::app().await;
        let initial = read(&app.state).await;
        assert_eq!(
            initial.question_tool_agents,
            vec![BaseCodingAgent::ClaudeCode]
        );
        assert!(initial.question_tool_disabled.is_empty(), "on by default");

        let off = put(&app.state, BaseCodingAgent::ClaudeCode, None, Some(false))
            .await
            .expect("accepted");
        assert!(off
            .question_tool_disabled
            .contains(&BaseCodingAgent::ClaudeCode));

        let on = put(&app.state, BaseCodingAgent::ClaudeCode, None, Some(true))
            .await
            .expect("accepted");
        assert!(on.question_tool_disabled.is_empty());

        let (status, body) = put(&app.state, BaseCodingAgent::Codex, None, Some(false))
            .await
            .expect_err("refused");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "question_tool_unsupported");
    }

    #[tokio::test]
    async fn sends_question_tool_flags_to_the_setting() {
        let app = crate::test_support::app().await;
        let (_, body) = put(
            &app.state,
            BaseCodingAgent::ClaudeCode,
            Some("--disallowedTools AskUserQuestion"),
            None,
        )
        .await
        .expect_err("refused");
        assert_eq!(body["error"]["code"], "question_tool_flag");
    }
}
#[cfg(test)]
mod ui_state_tests {
    use super::*;

    #[tokio::test]
    async fn names_the_database_the_same_on_every_read_and_write() {
        let app = crate::test_support::app().await;
        let Json(read) = get_ui_state(State(app.state.clone())).await.unwrap();
        let payload = [("chro.check".to_string(), json!(1))].into_iter().collect();
        let Json(written) = update_ui_state(State(app.state.clone()), Json(payload))
            .await
            .unwrap();
        assert!(!read.database.is_empty());
        assert_eq!(written.database, read.database);
        assert_eq!(
            read.database,
            app.state.runtime().db().database_id().await.unwrap()
        );
    }
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
