use axum::extract::ws::Message;
use json_patch::Patch;
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod diff;
mod entry_index;
mod normalized;
mod patch;
pub use diff::{
    Diff, DiffChangeKind, compute_line_change_counts, create_unified_diff, create_unified_diff_hunk,
};
pub use entry_index::*;
pub use normalized::*;
pub use patch::*;

/// Trait for pushing log entries to a message store.
pub trait LogEntryPusher: Send + Sync {
    fn push(&self, entry: LogEntry);
}

/// Represents the different payloads that can be streamed for a task run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum LogEntry {
    Stdout(String),
    Stderr(String),
    JsonPatch(serde_json::Value),
    SessionId(String),
    UiEvent(UiEventPayload),
    /// User prompt sent to the agent (for message persistence across task switches)
    UserPrompt(String),
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiEventKind {
    OpenSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiEventPayload {
    pub kind: UiEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl UiEventPayload {
    pub fn new(kind: UiEventKind, data: Option<Value>) -> Self {
        Self { kind, data }
    }
}

impl LogEntry {
    /// Approximated byte cost to keep history bounded in memory stores.
    pub fn approx_bytes(&self) -> usize {
        const OVERHEAD: usize = 32;
        match self {
            LogEntry::Stdout(s)
            | LogEntry::Stderr(s)
            | LogEntry::SessionId(s)
            | LogEntry::UserPrompt(s) => s.len() + OVERHEAD,
            LogEntry::JsonPatch(value) => value.to_string().len() + OVERHEAD,
            LogEntry::UiEvent(payload) => {
                payload
                    .data
                    .as_ref()
                    .map(|value| value.to_string().len())
                    .unwrap_or_default()
                    + OVERHEAD
            }
            LogEntry::Finished => OVERHEAD,
        }
    }

    /// Serialize the entry into a single JSON line that can be appended to SQLite.
    pub fn to_json_line(&self) -> Result<String, serde_json::Error> {
        let mut line = serde_json::to_string(self)?;
        line.push('\n');
        Ok(line)
    }

    /// Parse a JSON line back into a [`LogEntry`].
    pub fn from_json_line(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line)
    }

    /// Serialize the entry into a WebSocket text message without error handling.
    /// Falls back to an error message if serialization fails.
    pub fn to_ws_message_unchecked(&self) -> Message {
        let json = match self {
            LogEntry::Finished => r#"{"type":"finished"}"#.to_string(),
            _ => serde_json::to_string(self)
                .unwrap_or_else(|_| r#"{"error":"serialization_failed"}"#.to_string()),
        };
        Message::Text(json.into())
    }
}

impl From<Patch> for LogEntry {
    fn from(value: Patch) -> Self {
        let json_value: Value = serde_json::to_value(value).unwrap_or(Value::Null);
        LogEntry::JsonPatch(json_value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip() {
        let entry = LogEntry::Stdout("hello".into());
        let line = entry.to_json_line().unwrap();
        let parsed = LogEntry::from_json_line(line.trim()).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn approx_bytes_non_zero() {
        assert!(LogEntry::Finished.approx_bytes() > 0);
        assert!(LogEntry::Stdout("abc".into()).approx_bytes() > 3);
    }
}
