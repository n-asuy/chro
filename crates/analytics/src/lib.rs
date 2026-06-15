use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};
use tracing::{debug, trace};

pub mod flags;

const POSTHOG_HOST: &str = "https://eu.i.posthog.com";
const POSTHOG_API_KEY: &str = "phc_ciDHQIDUgIxsl1Z5oqbhfHq6Hj2ktS4hdImRC649dZ9";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Keys whose values should be treated as file-system paths and masked.
const PATH_LIKE_KEYS: &[&str] = &[
    "workspace_path",
    "container_ref",
    "file_path",
    "old_path",
    "new_path",
    "path",
];

/// Strip a file path down to just its extension so user directory
/// structures are never sent to PostHog.
///
/// ```text
/// "/Users/foo/project/src/main.rs" → "*.rs"
/// "C:\\Users\\bar\\doc.pdf"        → "*.pdf"
/// "Makefile"                       → "*"
/// ```
pub fn mask_path(path: &str) -> String {
    let basename = path
        .rsplit_once('/')
        .or_else(|| path.rsplit_once('\\'))
        .map_or(path, |(_, name)| name);
    match basename.rfind('.') {
        Some(i) => format!("*{}", &basename[i..]),
        None => "*".to_string(),
    }
}

fn sanitize_properties(properties: Value) -> Value {
    match properties {
        Value::Object(mut map) => {
            for key in PATH_LIKE_KEYS {
                if let Some(Value::String(val)) = map.get(*key) {
                    let masked = mask_path(val);
                    map.insert((*key).to_string(), Value::String(masked));
                }
            }
            Value::Object(map)
        }
        other => other,
    }
}

static INSTANCE: OnceLock<Analytics> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);

pub struct Analytics {
    client: Client,
    api_key: String,
    distinct_id: String,
    app_version: String,
}

/// Configuration for initializing analytics.
pub struct AnalyticsConfig {
    /// Stable identifier for the user/installation.
    /// Falls back to a random UUID when empty.
    pub distinct_id: String,
    /// Whether telemetry is enabled (user opt-in).
    pub enabled: bool,
    /// Application version string (e.g. "0.0.46").
    pub app_version: String,
}

/// Initialize the global analytics singleton.
///
/// Must be called once at startup. Subsequent calls are ignored.
pub fn init(config: AnalyticsConfig) {
    let distinct_id = if config.distinct_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        config.distinct_id
    };

    ENABLED.store(config.enabled, Ordering::SeqCst);

    let _ = INSTANCE.set(Analytics {
        client: Client::new(),
        api_key: POSTHOG_API_KEY.to_string(),
        distinct_id,
        app_version: config.app_version,
    });

    debug!(enabled = config.enabled, "analytics initialized");
}

/// Update the enabled state at runtime (e.g. when user toggles telemetry).
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
}

/// Returns the current distinct_id, or `None` if not initialized.
pub fn distinct_id() -> Option<&'static str> {
    INSTANCE.get().map(|a| a.distinct_id.as_str())
}

/// Capture an analytics event. No-op when disabled or uninitialized.
/// Path-like properties are automatically masked.
pub async fn capture(event: &str, properties: Value) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }

    let Some(analytics) = INSTANCE.get() else {
        return;
    };

    let sanitized = sanitize_properties(properties);
    let mut props = match sanitized {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };

    props.insert("distinct_id".into(), json!(analytics.distinct_id));
    props.insert("$lib".into(), json!("chro-rust"));
    props.insert("app_version".into(), json!(analytics.app_version));

    let payload = json!({
        "api_key": analytics.api_key,
        "event": event,
        "properties": Value::Object(props),
    });

    trace!(target: "analytics", event, "capturing");

    if let Err(e) = analytics
        .client
        .post(format!("{POSTHOG_HOST}/capture/"))
        .json(&payload)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
    {
        debug!("failed to send analytics event: {e}");
    }
}

/// Fire-and-forget variant that spawns a background task.
pub fn capture_nonblocking(event: &'static str, properties: Value) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        capture(event, properties).await;
    });
}

/// Identify the user with PostHog person properties.
pub async fn identify(properties: Value) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }

    let Some(analytics) = INSTANCE.get() else {
        return;
    };

    let set_props = properties.clone();
    let mut props = match properties {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    props.insert("distinct_id".into(), json!(analytics.distinct_id));
    props.insert("$lib".into(), json!("chro-rust"));

    let payload = json!({
        "api_key": analytics.api_key,
        "event": "$identify",
        "properties": Value::Object(props),
        "$set": set_props,
    });

    if let Err(e) = analytics
        .client
        .post(format!("{POSTHOG_HOST}/capture/"))
        .json(&payload)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
    {
        debug!("failed to send identify event: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_is_noop_when_uninitialized() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            capture("test_event", json!({"key": "value"})).await;
        });
    }

    #[test]
    fn capture_is_noop_when_disabled() {
        ENABLED.store(false, Ordering::SeqCst);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            capture("test_event", json!({"key": "value"})).await;
        });
    }

    #[test]
    fn mask_path_unix() {
        assert_eq!(mask_path("/Users/foo/project/src/main.rs"), "*.rs");
        assert_eq!(mask_path("/home/user/docs/readme.md"), "*.md");
    }

    #[test]
    fn mask_path_windows() {
        assert_eq!(mask_path("C:\\Users\\bar\\doc.pdf"), "*.pdf");
    }

    #[test]
    fn mask_path_no_extension() {
        assert_eq!(mask_path("/usr/bin/Makefile"), "*");
        assert_eq!(mask_path("Dockerfile"), "*");
    }

    #[test]
    fn mask_path_dotfile() {
        assert_eq!(mask_path("/home/user/.gitignore"), "*.gitignore");
    }

    #[test]
    fn sanitize_properties_masks_paths() {
        let props = json!({
            "workspace_path": "/Users/foo/project",
            "prompt_chars": 42,
            "file_path": "/tmp/test.tsx",
        });
        let result = sanitize_properties(props);
        assert_eq!(result["workspace_path"], "*");
        assert_eq!(result["prompt_chars"], 42);
        assert_eq!(result["file_path"], "*.tsx");
    }
}
