use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
};

use dirs::home_dir;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio::fs;

use crate::executors::BaseCodingAgent;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConfigFormat {
    Json,
    Toml,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AgentSpec {
    format: ConfigFormat,
    env_var: Option<&'static str>,
    home_segments: &'static [&'static str],
    servers_path: &'static [&'static str],
}

fn agent_spec(agent: BaseCodingAgent) -> AgentSpec {
    match agent {
        BaseCodingAgent::ClaudeCode => AgentSpec {
            format: ConfigFormat::Json,
            env_var: Some("CLAUDE_CONFIG_PATH"),
            home_segments: &[".claude.json"],
            servers_path: &["mcpServers"],
        },
        BaseCodingAgent::Codex => AgentSpec {
            format: ConfigFormat::Toml,
            env_var: Some("CODEX_CONFIG_PATH"),
            home_segments: &[".codex", "config.toml"],
            servers_path: &["mcp_servers"],
        },
    }
}

/// MCP configuration metadata for an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfig {
    servers: HashMap<String, Value>,
    pub servers_path: Vec<String>,
    pub template: Value,
    pub is_toml_config: bool,
}

impl McpConfig {
    pub fn new(servers_path: Vec<String>, template: Value, is_toml_config: bool) -> Self {
        Self {
            servers: HashMap::new(),
            servers_path,
            template,
            is_toml_config,
        }
    }
}

type ServerMap = Map<String, Value>;

fn servers_path_vec(spec: &AgentSpec) -> Vec<String> {
    spec.servers_path
        .iter()
        .map(|segment| segment.to_string())
        .collect()
}

fn default_template_for_spec(spec: &AgentSpec) -> Value {
    let mut root = Value::Object(Map::new());
    if spec.servers_path.is_empty() {
        return root;
    }

    let mut cursor = root
        .as_object_mut()
        .expect("template root coerced to object");
    for segment in spec
        .servers_path
        .iter()
        .take(spec.servers_path.len().saturating_sub(1))
    {
        cursor = cursor
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("child coerced to object");
    }

    if let Some(last) = spec.servers_path.last() {
        cursor.insert((*last).to_string(), Value::Object(Map::new()));
    }

    root
}

fn default_payload(
    _agent: BaseCodingAgent,
    spec: &AgentSpec,
    servers: ServerMap,
) -> McpConfigPayload {
    McpConfigPayload {
        servers,
        servers_path: servers_path_vec(spec),
        template: default_template_for_spec(spec),
        is_toml_config: matches!(spec.format, ConfigFormat::Toml),
    }
}

fn parse_config_content(raw: &str, spec: &AgentSpec) -> Result<Value, String> {
    match spec.format {
        ConfigFormat::Json => serde_json::from_str(raw).map_err(|err| err.to_string()),
        ConfigFormat::Toml => {
            let toml_value: toml::Value = toml::from_str(raw).map_err(|err| err.to_string())?;
            serde_json::to_value(toml_value).map_err(|err| err.to_string())
        }
    }
}

fn serialize_config(value: &Value, spec: &AgentSpec) -> Result<String, McpConfigError> {
    match spec.format {
        ConfigFormat::Json => Ok(serde_json::to_string_pretty(value)?),
        ConfigFormat::Toml => Ok(toml::to_string_pretty(value)?),
    }
}

fn ensure_object(mut value: Value, template: &Value) -> Value {
    if !value.is_object() {
        value = template.clone();
    }
    value
}

fn sanitize_servers_map(map: &ServerMap) -> ServerMap {
    map.iter()
        .filter(|(key, _)| key.as_str() != "meta")
        .map(|(key, val)| (key.clone(), val.clone()))
        .collect()
}

fn sanitize_servers_value(value: &Value) -> ServerMap {
    value
        .as_object()
        .map(sanitize_servers_map)
        .unwrap_or_default()
}

fn extract_servers(root: &Value, path: &[String]) -> ServerMap {
    let mut current = root;
    for segment in path {
        current = match current.get(segment) {
            Some(value) => value,
            None => return ServerMap::new(),
        };
    }
    current
        .as_object()
        .map(sanitize_servers_map)
        .unwrap_or_default()
}

fn apply_servers_to_root(mut root: Value, path: &[String], servers: &ServerMap) -> Value {
    if path.is_empty() {
        return Value::Object(servers.clone());
    }

    if !root.is_object() {
        root = Value::Object(Default::default());
    }

    let mut cursor = root.as_object_mut().expect("value coerced to object");
    for segment in path.iter().take(path.len().saturating_sub(1)) {
        cursor = cursor
            .entry(segment.clone())
            .or_insert_with(|| Value::Object(Default::default()))
            .as_object_mut()
            .expect("child coerced to object");
    }

    if let Some(last) = path.last() {
        cursor.insert(last.clone(), Value::Object(servers.clone()));
    }

    root
}

fn resolve_config_path(spec: &AgentSpec, override_path: Option<&Path>) -> PathBuf {
    if let Some(path) = override_path {
        return path.to_path_buf();
    }

    if let Some(env_var) = spec.env_var {
        if let Ok(env_path) = env::var(env_var) {
            let trimmed = env_path.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }

    let mut base = home_dir().unwrap_or_else(|| PathBuf::from("."));
    for segment in spec.home_segments {
        base = base.join(segment);
    }
    base
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfigPayload {
    pub servers: ServerMap,
    pub servers_path: Vec<String>,
    pub template: Value,
    pub is_toml_config: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedMcpConfig {
    pub config_path: PathBuf,
    pub exists: bool,
    pub mcp_config: McpConfigPayload,
    pub servers_count: usize,
    pub parse_error: Option<String>,
    pub raw_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedMcpConfig {
    pub config_path: PathBuf,
    pub mcp_config: McpConfigPayload,
    pub servers_count: usize,
}

#[derive(Debug, Error)]
pub enum McpConfigError {
    #[error("failed to read MCP config {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to save MCP config {path}: {source}")]
    Save {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to serialize MCP config: {0}")]
    Json(#[from] serde_json::Error),
    #[error("failed to serialize MCP config to TOML: {0}")]
    Toml(#[from] toml::ser::Error),
}

/// Load the user's MCP configuration from disk, mirroring the behaviour of the Electron store.
pub async fn load_mcp_config(
    agent: BaseCodingAgent,
    override_path: Option<&Path>,
) -> Result<LoadedMcpConfig, McpConfigError> {
    let spec = agent_spec(agent);
    let path = resolve_config_path(&spec, override_path);
    let template = default_template_for_spec(&spec);
    let servers_path = servers_path_vec(&spec);

    match fs::read_to_string(&path).await {
        Ok(raw) => {
            if raw.trim().is_empty() {
                let payload = default_payload(agent, &spec, ServerMap::new());
                return Ok(LoadedMcpConfig {
                    config_path: path,
                    exists: true,
                    mcp_config: payload,
                    servers_count: 0,
                    parse_error: None,
                    raw_content: None,
                });
            }

            match parse_config_content(&raw, &spec) {
                Ok(parsed) => {
                    let normalized = ensure_object(parsed, &template);
                    let servers = extract_servers(&normalized, &servers_path);
                    let payload = default_payload(agent, &spec, servers.clone());
                    Ok(LoadedMcpConfig {
                        config_path: path,
                        exists: true,
                        mcp_config: payload,
                        servers_count: servers.len(),
                        parse_error: None,
                        raw_content: None,
                    })
                }
                Err(err) => Ok(LoadedMcpConfig {
                    config_path: path,
                    exists: true,
                    mcp_config: default_payload(agent, &spec, ServerMap::new()),
                    servers_count: 0,
                    parse_error: Some(err),
                    raw_content: Some(raw),
                }),
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(LoadedMcpConfig {
            config_path: path,
            exists: false,
            mcp_config: default_payload(agent, &spec, ServerMap::new()),
            servers_count: 0,
            parse_error: None,
            raw_content: None,
        }),
        Err(err) => Err(McpConfigError::Read { path, source: err }),
    }
}

/// Persist MCP server overrides back to disk after sanitising the payload.
pub async fn save_mcp_config(
    agent: BaseCodingAgent,
    servers_input: Value,
    override_path: Option<&Path>,
) -> Result<SavedMcpConfig, McpConfigError> {
    let spec = agent_spec(agent);
    let path = resolve_config_path(&spec, override_path);
    let template = default_template_for_spec(&spec);
    let servers_path = servers_path_vec(&spec);
    let sanitized = sanitize_servers_value(&servers_input);

    let raw_root = match fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => {
            return Err(McpConfigError::Read {
                path: path.clone(),
                source: err,
            });
        }
    };

    let parsed_root = if raw_root.trim().is_empty() {
        template.clone()
    } else {
        parse_config_content(&raw_root, &spec).unwrap_or_else(|_| template.clone())
    };
    let normalized = ensure_object(parsed_root, &template);
    let updated = apply_servers_to_root(normalized, &servers_path, &sanitized);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|source| McpConfigError::Save {
                path: path.clone(),
                source,
            })?;
    }

    let content = serialize_config(&updated, &spec)?;
    fs::write(&path, content)
        .await
        .map_err(|source| McpConfigError::Save {
            path: path.clone(),
            source,
        })?;

    let payload = default_payload(agent, &spec, sanitized.clone());
    Ok(SavedMcpConfig {
        config_path: path,
        mcp_config: payload,
        servers_count: sanitized.len(),
    })
}
