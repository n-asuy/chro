//! Read/write pi credentials in `~/.pi/agent/auth.json`.
//!
//! chro stores user-entered API keys exactly the way the pi CLI does: a plain
//! `{ "<provider>": { "type": "api_key", "key": "..." } }` entry in pi's `0600`
//! auth file. Per pi's credential resolution order this beats environment
//! variables and `models.json` and applies to built-in and custom providers
//! alike, so a GUI-launched chro no longer depends on the shell environment.
//!
//! Secret values are written but never read back out — only the set of
//! configured providers (and whether each is an API key or an OAuth login) is
//! surfaced to the UI.

use std::{
    io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

use super::pi_home;
use crate::executors::ExecutorError;

/// A configured pi credential, without its secret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct PiCredentialInfo {
    pub provider: String,
    /// Credential kind reported by pi: `api_key`, `oauth`, or `unknown`.
    pub kind: String,
}

fn auth_path() -> Result<PathBuf, ExecutorError> {
    pi_home()
        .map(|home| home.join("auth.json"))
        .ok_or_else(|| ExecutorError::Io(io::Error::other("no pi home directory")))
}

fn read_auth() -> Map<String, Value> {
    let Ok(path) = auth_path() else {
        return Map::new();
    };
    match std::fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn write_auth(map: &Map<String, Value>) -> Result<(), ExecutorError> {
    let path = auth_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ExecutorError::Io)?;
    }
    let body = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|err| ExecutorError::Io(io::Error::other(err.to_string())))?;
    std::fs::write(&path, body).map_err(ExecutorError::Io)?;
    restrict_permissions(&path);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// Escape a literal API key so pi does not interpret a leading `$` (environment
/// interpolation) or `!` (command execution). pi documents `$$` and `$!` as the
/// literal escapes for these prefixes. Mid-string `$`/`!` are left untouched as
/// real API keys do not contain them.
fn escape_literal_key(key: &str) -> String {
    if let Some(rest) = key.strip_prefix('$') {
        format!("$${rest}")
    } else if let Some(rest) = key.strip_prefix('!') {
        format!("$!{rest}")
    } else {
        key.to_string()
    }
}

/// Configured providers and their credential kind (no secrets).
pub fn list_credentials() -> Vec<PiCredentialInfo> {
    read_auth()
        .into_iter()
        .map(|(provider, value)| {
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            PiCredentialInfo { provider, kind }
        })
        .collect()
}

/// Store an API key for `provider`, replacing any existing entry.
pub fn set_api_key(provider: &str, key: &str) -> Result<(), ExecutorError> {
    let provider = provider.trim();
    let key = key.trim();
    if provider.is_empty() {
        return Err(ExecutorError::Io(io::Error::other("provider is required")));
    }
    if key.is_empty() {
        return Err(ExecutorError::Io(io::Error::other("key is required")));
    }
    let mut map = read_auth();
    map.insert(
        provider.to_string(),
        json!({ "type": "api_key", "key": escape_literal_key(key) }),
    );
    write_auth(&map)
}

/// Remove the credential for `provider` (no-op when absent).
pub fn delete_credential(provider: &str) -> Result<(), ExecutorError> {
    let mut map = read_auth();
    if map.remove(provider.trim()).is_some() {
        write_auth(&map)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_only_leading_dollar_or_bang() {
        assert_eq!(escape_literal_key("sk-ant-123"), "sk-ant-123");
        assert_eq!(escape_literal_key("$SECRET"), "$$SECRET");
        assert_eq!(escape_literal_key("!cmd"), "$!cmd");
        assert_eq!(escape_literal_key("ab$cd"), "ab$cd");
    }

    #[test]
    fn rejects_empty_provider_or_key() {
        assert!(set_api_key("", "k").is_err());
        assert!(set_api_key("p", "  ").is_err());
    }

    #[test]
    fn lists_credential_kinds_from_auth_object() {
        let map: Map<String, Value> = serde_json::from_value(json!({
            "anthropic": { "type": "api_key", "key": "x" },
            "claude-pro": { "type": "oauth", "refresh": "y" }
        }))
        .unwrap();
        let mut infos: Vec<PiCredentialInfo> = map
            .into_iter()
            .map(|(provider, value)| PiCredentialInfo {
                provider,
                kind: value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            })
            .collect();
        infos.sort_by(|a, b| a.provider.cmp(&b.provider));
        assert_eq!(infos[0].provider, "anthropic");
        assert_eq!(infos[0].kind, "api_key");
        assert_eq!(infos[1].kind, "oauth");
    }
}
