//! Session-transcript tailing for PTY-hosted Claude runs.
//!
//! Interactive Claude writes the conversation incrementally to
//! `~/.claude/projects/<dir>/<session>.jsonl`. Tailing that file and mapping
//! its `user`/`assistant` lines to stream-json keeps the existing
//! `ClaudeLogProcessor` pipeline (and therefore the conversation UI,
//! persistence and replay) byte-compatible with the old `--print` output.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::types::{SYNTHETIC_MODEL_ID, SYNTHETIC_NO_RESPONSE_TEXT};

/// Map one transcript JSONL line to a stream-json line, or `None` for line
/// types the conversation pipeline must not see.
///
/// Skipped on purpose:
/// - sidechain lines (subagent traffic shares the transcript file)
/// - meta lines (caveats and other injected context)
/// - bookkeeping types (`ai-title`, `file-history-snapshot`, `summary`, …)
///
/// User lines with plain-string content are normalized to a content-block
/// array because `ClaudeMessage.content` is typed as a block list.
pub fn map_transcript_line(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let line_type = value.get("type")?.as_str()?;
    if line_type != "user" && line_type != "assistant" {
        return None;
    }
    if is_flagged(&value, "isSidechain") || is_flagged(&value, "isMeta") {
        return None;
    }
    if line_type == "assistant" && is_synthetic_no_response_line(&value) {
        return None;
    }

    let mut message = value.get("message")?.clone();
    if !message.is_object() {
        return None;
    }
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        message["content"] = json!([{ "type": "text", "text": text }]);
    } else if !content.is_array() {
        return None;
    }

    let mapped = json!({
        "type": line_type,
        "message": message,
        "session_id": value.get("sessionId"),
    });
    Some(mapped.to_string())
}

fn is_flagged(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn is_synthetic_no_response_line(value: &Value) -> bool {
    let Some(message) = value.get("message") else {
        return false;
    };
    if message.get("model").and_then(Value::as_str) != Some(SYNTHETIC_MODEL_ID) {
        return false;
    }

    let Some(content) = message.get("content") else {
        return false;
    };
    if let Some(text) = content.as_str() {
        return text.trim() == SYNTHETIC_NO_RESPONSE_TEXT;
    }

    let Some(items) = content.as_array() else {
        return false;
    };
    let mut saw_sentinel = false;
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            return false;
        }
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        if text == SYNTHETIC_NO_RESPONSE_TEXT {
            saw_sentinel = true;
        } else {
            return false;
        }
    }
    saw_sentinel
}

/// Incremental reader over an append-only transcript file.
///
/// Poll-driven: each [`read_new_lines`](Self::read_new_lines) call picks up
/// the bytes appended since the previous one. Tolerates the file not existing
/// yet and lines that are still being written (kept as a partial buffer).
pub struct TranscriptTailer {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

impl TranscriptTailer {
    /// `start_at_end` skips everything already in the file — used for resumed
    /// sessions, whose files begin with copied history that the UI already
    /// has. Fresh sessions tail from the beginning (offset 0).
    pub async fn new(path: &Path, start_at_end: bool) -> Self {
        let offset = if start_at_end {
            tokio::fs::metadata(path)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };
        Self {
            path: path.to_path_buf(),
            offset,
            partial: Vec::new(),
        }
    }

    /// Read all complete lines appended since the last call.
    pub async fn read_new_lines(&mut self) -> Vec<String> {
        let Ok(mut file) = tokio::fs::File::open(&self.path).await else {
            return Vec::new();
        };
        if file
            .seek(std::io::SeekFrom::Start(self.offset))
            .await
            .is_err()
        {
            return Vec::new();
        }
        let mut buf = Vec::new();
        let Ok(read) = file.read_to_end(&mut buf).await else {
            return Vec::new();
        };
        if read == 0 {
            return Vec::new();
        }
        self.offset += read as u64;
        self.partial.extend_from_slice(&buf);

        let mut lines = Vec::new();
        while let Some(newline_at) = self.partial.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=newline_at).collect();
            if let Ok(text) = String::from_utf8(line) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    lines.push(trimmed.to_string());
                }
            }
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_assistant_line_to_stream_json() {
        let raw = r#"{"type":"assistant","sessionId":"s-1","uuid":"u1","message":{"role":"assistant","model":"claude-opus-4-5","content":[{"type":"text","text":"hi"}]}}"#;
        let mapped = map_transcript_line(raw).unwrap();
        let value: Value = serde_json::from_str(&mapped).unwrap();
        assert_eq!(value["type"], "assistant");
        assert_eq!(value["session_id"], "s-1");
        assert_eq!(value["message"]["content"][0]["text"], "hi");

        let parsed: super::super::types::ClaudeJson = serde_json::from_str(&mapped).unwrap();
        assert_eq!(parsed.session_id(), Some("s-1"));
    }

    #[test]
    fn wraps_string_user_content_into_text_block() {
        let raw =
            r#"{"type":"user","sessionId":"s-1","message":{"role":"user","content":"hello"}}"#;
        let mapped = map_transcript_line(raw).unwrap();
        let value: Value = serde_json::from_str(&mapped).unwrap();
        assert_eq!(value["message"]["content"][0]["type"], "text");
        assert_eq!(value["message"]["content"][0]["text"], "hello");
    }

    #[test]
    fn passes_tool_results_through() {
        let raw = r#"{"type":"user","sessionId":"s-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"done","is_error":false}]}}"#;
        let mapped = map_transcript_line(raw).unwrap();
        let value: Value = serde_json::from_str(&mapped).unwrap();
        assert_eq!(value["message"]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn skips_sidechain_meta_and_bookkeeping_lines() {
        for raw in [
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"caveat"}}"#,
            r#"{"type":"assistant","sessionId":"s-1","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}"#,
            r#"{"type":"ai-title","aiTitle":"t","sessionId":"s"}"#,
            r#"{"type":"file-history-snapshot","sessionId":"s"}"#,
            r#"{"type":"summary","summary":"x"}"#,
            r#"{"type":"system","subtype":"stop_hook_summary"}"#,
            "not json",
        ] {
            assert_eq!(map_transcript_line(raw), None, "should skip: {raw}");
        }
    }

    #[test]
    fn maps_non_synthetic_no_response_text() {
        let raw = r#"{"type":"assistant","sessionId":"s-1","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"No response requested."}]}}"#;
        let mapped = map_transcript_line(raw).unwrap();
        let value: Value = serde_json::from_str(&mapped).unwrap();
        assert_eq!(
            value["message"]["content"][0]["text"],
            "No response requested."
        );
    }

    #[tokio::test]
    async fn tailer_reads_appended_lines_incrementally() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("chro-tailer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transcript.jsonl");

        let mut tailer = TranscriptTailer::new(&path, false).await;
        assert!(tailer.read_new_lines().await.is_empty());

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{\"a\":1}}").unwrap();
        write!(file, "{{\"b\":").unwrap();
        file.flush().unwrap();

        let lines = tailer.read_new_lines().await;
        assert_eq!(lines, vec!["{\"a\":1}".to_string()]);

        writeln!(file, "2}}").unwrap();
        file.flush().unwrap();
        let lines = tailer.read_new_lines().await;
        assert_eq!(lines, vec!["{\"b\":2}".to_string()]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn tailer_can_skip_existing_history() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("chro-tailer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transcript.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "{{\"history\":true}}").unwrap();
        file.flush().unwrap();

        let mut tailer = TranscriptTailer::new(&path, true).await;
        assert!(tailer.read_new_lines().await.is_empty());

        writeln!(file, "{{\"fresh\":true}}").unwrap();
        file.flush().unwrap();
        assert_eq!(
            tailer.read_new_lines().await,
            vec!["{\"fresh\":true}".to_string()]
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
