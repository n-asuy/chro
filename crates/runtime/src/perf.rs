use std::sync::OnceLock;
use tokio::sync::mpsc;

static PERF_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// Register the perf log sender. Called once at startup by the server crate.
pub fn register_sender(tx: mpsc::Sender<String>) {
    let _ = PERF_TX.set(tx);
}

fn timestamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Record a backend perf event from any crate that depends on `runtime`.
pub fn record_event(name: &str, fields: serde_json::Value) {
    let Some(tx) = PERF_TX.get() else {
        return;
    };

    let mut payload = serde_json::Map::new();
    payload.insert("ts".into(), serde_json::Value::String(timestamp()));
    payload.insert(
        "type".into(),
        serde_json::Value::String("backend-action".into()),
    );
    payload.insert("name".into(), serde_json::Value::String(name.into()));

    if let serde_json::Value::Object(fields) = fields {
        for (key, value) in fields {
            payload.insert(key, value);
        }
    }

    let line = serde_json::Value::Object(payload).to_string();
    // Best-effort send; if channel is full we drop the event.
    let _ = tx.try_send(line);
}
