//! Dynamic pi model catalog.
//!
//! pi ships the full provider/model catalog in-process (hundreds of entries,
//! refreshed per release) and exposes it over the rpc `get_available_models`
//! command. chro queries it with a short-lived `pi --mode rpc` process and
//! narrows the result to the providers the user has actually configured, so the
//! model picker stays small and relevant instead of listing every known model.
//!
//! The "configured providers" set is derived entirely from pi's own state — the
//! `/login` credentials in `auth.json`, the custom providers in `models.json`,
//! and whichever provider pi currently resolves to — so chro carries no
//! hardcoded provider knowledge of its own.

use std::{collections::BTreeSet, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use ts_rs::TS;

use super::pi_home;
use crate::{cli_manifest, command::CommandBuilder, executors::ExecutorError};

/// One selectable pi model. `value` is pi's `provider/id` form (accepted
/// verbatim by `pi --model`); `label` is the human-facing name.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct PiModelOption {
    pub value: String,
    pub label: String,
    pub provider: String,
}

/// Maximum time to wait for the helper pi process to answer.
const QUERY_TIMEOUT: Duration = Duration::from_secs(12);

/// List the pi models the user can currently select.
///
/// Returns an empty list (rather than an error) when pi is installed but no
/// provider is configured, or when the helper process cannot be reached — the
/// picker then simply offers "Default" and pi falls back to its own resolved
/// model.
pub async fn list_available_models() -> Result<Vec<PiModelOption>, ExecutorError> {
    let configured = configured_providers();
    let (catalog, current_provider) = match tokio::time::timeout(QUERY_TIMEOUT, query_pi()).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            tracing::warn!("pi model query failed: {err}");
            return Ok(Vec::new());
        }
        Err(_) => {
            tracing::warn!("pi model query timed out");
            return Ok(Vec::new());
        }
    };

    let mut allowed = configured;
    if let Some(provider) = current_provider {
        allowed.insert(provider);
    }
    // No configured providers at all: leave the picker on "Default".
    if allowed.is_empty() {
        return Ok(Vec::new());
    }

    // The rpc catalog only covers built-in providers; custom providers (and
    // their models) live solely in models.json, so merge both candidate pools.
    let mut models: Vec<PiModelOption> = catalog
        .into_iter()
        .chain(custom_provider_models())
        .filter(|model| allowed.contains(&model.provider))
        .collect();
    models.sort_by(|a, b| a.provider.cmp(&b.provider).then(a.label.cmp(&b.label)));
    models.dedup_by(|a, b| a.value == b.value);
    Ok(models)
}

/// Models declared by custom providers in `models.json`, which never appear in
/// the rpc catalog.
fn custom_provider_models() -> Vec<PiModelOption> {
    let Some(home) = pi_home() else {
        return Vec::new();
    };
    let Some(root) = read_json_object(&home.join("models.json")) else {
        return Vec::new();
    };
    let Some(Value::Object(providers)) = root.get("providers") else {
        return Vec::new();
    };

    let mut models = Vec::new();
    for (provider, definition) in providers {
        let Some(entries) = definition.get("models").and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            let Some(id) = entry.get("id").and_then(Value::as_str) else {
                continue;
            };
            let label = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string();
            models.push(PiModelOption {
                value: format!("{provider}/{id}"),
                label,
                provider: provider.clone(),
            });
        }
    }
    models
}

/// Providers the user has configured, drawn from pi's own state files.
fn configured_providers() -> BTreeSet<String> {
    let mut providers = BTreeSet::new();
    let Some(home) = pi_home() else {
        return providers;
    };

    // `/login` credentials: `{ "<provider>": <credential>, ... }`.
    if let Some(map) = read_json_object(&home.join("auth.json")) {
        providers.extend(map.into_iter().map(|(key, _)| key));
    }

    // Custom providers: `{ "providers": { "<provider>": { ... } } }`.
    if let Some(models) = read_json_object(&home.join("models.json"))
        && let Some(Value::Object(custom)) = models.get("providers")
    {
        providers.extend(custom.keys().cloned());
    }

    providers
}

fn read_json_object(path: &std::path::Path) -> Option<serde_json::Map<String, Value>> {
    let contents = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&contents).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Drive a one-shot `pi --mode rpc` to read the catalog and the current model's
/// provider. Returns `(catalog, current_provider)`.
async fn query_pi() -> Result<(Vec<PiModelOption>, Option<String>), ExecutorError> {
    let command_parts = CommandBuilder::for_manifest(&cli_manifest::PI)
        .extend_params(["--mode", "rpc"])
        .build_initial()?;
    let (program, args) = command_parts.into_resolved().await?;

    let mut child = Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .env("NODE_NO_WARNINGS", "1")
        .env("NO_COLOR", "1")
        .kill_on_drop(true)
        .spawn()
        .map_err(ExecutorError::Io)?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ExecutorError::Io(std::io::Error::other("pi helper missing stdin")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ExecutorError::Io(std::io::Error::other("pi helper missing stdout")))?;

    let request = json!({ "id": "1", "type": "get_available_models" }).to_string();
    let state_request = json!({ "id": "2", "type": "get_state" }).to_string();
    stdin
        .write_all(format!("{state_request}\n{request}\n").as_bytes())
        .await
        .map_err(ExecutorError::Io)?;
    stdin.flush().await.map_err(ExecutorError::Io)?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut catalog: Option<Vec<PiModelOption>> = None;
    let mut current_provider: Option<String> = None;

    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(ExecutorError::Io)?;
        if read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("response") {
            continue;
        }
        match value.get("command").and_then(Value::as_str) {
            Some("get_available_models") => {
                catalog = Some(parse_catalog(value.get("data")));
            }
            Some("get_state") => {
                current_provider = value
                    .get("data")
                    .and_then(|d| d.get("model"))
                    .and_then(|m| m.get("provider"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            _ => {}
        }
        if catalog.is_some() {
            break;
        }
    }

    Ok((catalog.unwrap_or_default(), current_provider))
}

/// Parse the `{ models: [{ provider, id, name, ... }] }` payload.
fn parse_catalog(data: Option<&Value>) -> Vec<PiModelOption> {
    let Some(models) = data.and_then(|d| d.get("models")).and_then(Value::as_array) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| {
            let provider = model.get("provider").and_then(Value::as_str)?;
            let id = model.get("id").and_then(Value::as_str)?;
            let label = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string();
            Some(PiModelOption {
                value: format!("{provider}/{id}"),
                label,
                provider: provider.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_catalog_into_provider_id_values() {
        let data = json!({
            "models": [
                { "provider": "sakana", "id": "fugu-ultra", "name": "Sakana Fugu Ultra" },
                { "provider": "google", "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro" },
                { "id": "no-provider" }
            ]
        });
        let parsed = parse_catalog(Some(&data));
        assert_eq!(parsed.len(), 2, "entries missing provider/id are skipped");
        assert_eq!(parsed[0].value, "sakana/fugu-ultra");
        assert_eq!(parsed[0].label, "Sakana Fugu Ultra");
        assert_eq!(parsed[1].value, "google/gemini-2.5-pro");
    }

    #[test]
    fn catalog_label_falls_back_to_id() {
        let data = json!({ "models": [{ "provider": "p", "id": "m" }] });
        let parsed = parse_catalog(Some(&data));
        assert_eq!(parsed[0].label, "m");
    }

    /// Hits the real installed pi. Confirms the result is narrowed to the
    /// configured providers (not the full ~300-model catalog).
    #[tokio::test]
    #[ignore = "requires an installed, configured pi CLI"]
    async fn lists_only_configured_models() {
        let models = list_available_models().await.expect("query pi");
        eprintln!("pi models ({}):", models.len());
        for model in &models {
            eprintln!("  {} | {}", model.value, model.label);
        }
        assert!(
            models.len() < 100,
            "expected the configured subset, got the full catalog ({})",
            models.len()
        );
        assert!(models.iter().all(|m| m.value.contains('/')));
    }
}
