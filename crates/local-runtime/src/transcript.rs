//! Transcript generation: render raw DB logs directly to Markdown.
//!
//! Instead of running the normalization pipeline, this module parses the raw
//! `LogEntry::Stdout` lines (Claude CLI stream-json) directly and renders them
//! as a chronological Markdown conversation — the same source data that Claude
//! Code saves as JSONL in `~/.claude/projects/`.

use std::{fmt::Write, fs, path::Path};

use executors::{ClaudeContentItem, ClaudeJson};
use image::{ensure_context_dir, WORKTREE_IMAGES_DIR as CONTEXT_DIR};
use log_types::LogEntry;
use runtime::RuntimeError;
use serde_json::Value;
use uuid::Uuid;

use crate::LocalRuntime;

impl LocalRuntime {
    /// Generate a transcript Markdown file for an entire task (all runs
    /// combined in chronological order) and write it under `workspace_path`.
    ///
    /// Returns the relative path suitable for `addFilePart()`.
    pub async fn generate_task_transcript(
        &self,
        task_id: Uuid,
        workspace_path: &Path,
    ) -> Result<String, RuntimeError> {
        let runs = db::models::TaskRun::list_by_task_id(self.db.pool(), task_id).await?;

        // list_by_task_id returns DESC — reverse to chronological order.
        let mut all_entries: Vec<LogEntry> = Vec::new();
        for run in runs.iter().rev() {
            let entries = self.container.fetch_logs(run.id).await?;
            all_entries.extend(entries);
        }

        let markdown = render_raw_transcript(&all_entries, &task_id.to_string());

        let context_dir = ensure_context_dir(workspace_path)?;
        let sessions_dir = context_dir.join("sessions");
        fs::create_dir_all(&sessions_dir)?;

        let filename = format!("{task_id}.md");
        let file_path = sessions_dir.join(&filename);
        fs::write(&file_path, &markdown)?;

        Ok(format!("{CONTEXT_DIR}/sessions/{filename}"))
    }
}

/// Render raw `LogEntry` values into a chronological Markdown transcript.
///
/// Parses `Stdout` lines as `ClaudeJson` and renders each message type.
/// `UserPrompt` entries are rendered as user messages.
fn render_raw_transcript(entries: &[LogEntry], task_id: &str) -> String {
    let mut out = String::with_capacity(8192);
    let mut has_content = false;

    // Header
    writeln!(out, "# Session Transcript").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "- task_id: {task_id}").unwrap();
    writeln!(out, "- generated_at: {}", chrono::Utc::now().to_rfc3339()).unwrap();

    // Buffer for incomplete stdout lines
    let mut stdout_buf = String::new();

    for entry in entries {
        match entry {
            LogEntry::UserPrompt(prompt) => {
                write_separator(&mut out, &mut has_content);
                writeln!(out, "### User").unwrap();
                writeln!(out).unwrap();
                writeln!(out, "{prompt}").unwrap();
            }
            LogEntry::Stdout(chunk) => {
                stdout_buf.push_str(chunk);

                // Process complete lines
                while let Some(newline_pos) = stdout_buf.find('\n') {
                    let line = stdout_buf[..newline_pos].trim().to_string();
                    stdout_buf = stdout_buf[newline_pos + 1..].to_string();

                    if line.is_empty() {
                        continue;
                    }

                    if let Ok(claude_json) = serde_json::from_str::<ClaudeJson>(&line) {
                        render_claude_json(&mut out, &claude_json, &mut has_content);
                    }
                }
            }
            _ => {}
        }
    }

    // Flush remaining buffer
    let remaining = stdout_buf.trim().to_string();
    if !remaining.is_empty() {
        if let Ok(claude_json) = serde_json::from_str::<ClaudeJson>(&remaining) {
            render_claude_json(&mut out, &claude_json, &mut has_content);
        }
    }

    out
}

fn write_separator(out: &mut String, has_content: &mut bool) {
    if *has_content {
        writeln!(out).unwrap();
        writeln!(out, "---").unwrap();
    }
    writeln!(out).unwrap();
    *has_content = true;
}

fn render_claude_json(out: &mut String, json: &ClaudeJson, has_content: &mut bool) {
    match json {
        ClaudeJson::Assistant { message, .. } => {
            render_message_content(out, message.role.as_str(), &message.content, has_content);
        }
        ClaudeJson::User { message, .. } => {
            render_message_content(out, message.role.as_str(), &message.content, has_content);
        }
        ClaudeJson::Result {
            is_error,
            error,
            result,
            ..
        } => {
            if is_error.unwrap_or(false) {
                write_separator(out, has_content);
                writeln!(out, "### Error").unwrap();
                writeln!(out).unwrap();
                if let Some(err) = error {
                    writeln!(out, "{err}").unwrap();
                } else if let Some(r) = result {
                    writeln!(out, "{}", format_value(r)).unwrap();
                }
            }
        }
        // Skip system init, stream events (deltas), tool_use/tool_result
        // (these are embedded in Assistant/User messages)
        ClaudeJson::System { .. }
        | ClaudeJson::StreamEvent { .. }
        | ClaudeJson::ToolUse { .. }
        | ClaudeJson::ToolResult { .. }
        | ClaudeJson::RateLimitEvent { .. }
        | ClaudeJson::ApprovalResponse { .. }
        | ClaudeJson::Unknown { .. } => {}
    }
}

fn render_message_content(
    out: &mut String,
    role: &str,
    content: &[ClaudeContentItem],
    has_content: &mut bool,
) {
    for item in content {
        match item {
            ClaudeContentItem::Text { text } => {
                if text.trim().is_empty() {
                    continue;
                }
                write_separator(out, has_content);
                let heading = match role {
                    "assistant" => "### Assistant",
                    "user" => "### User",
                    _ => "### Message",
                };
                writeln!(out, "{heading}").unwrap();
                writeln!(out).unwrap();
                writeln!(out, "{text}").unwrap();
            }
            ClaudeContentItem::Thinking { thinking } => {
                if thinking.trim().is_empty() {
                    continue;
                }
                write_separator(out, has_content);
                writeln!(out, "### Thinking").unwrap();
                writeln!(out).unwrap();
                writeln!(out, "{thinking}").unwrap();
            }
            ClaudeContentItem::ToolUse { tool_data, .. } => {
                write_separator(out, has_content);
                writeln!(out, "### Tool Use: {}", tool_data.name()).unwrap();
                writeln!(out).unwrap();
                // Serialize input as YAML-like key: value for readability
                if let Ok(val) = serde_json::to_value(tool_data) {
                    if let Some(input) = val.get("input") {
                        write_tool_input(out, input);
                    }
                }
            }
            ClaudeContentItem::ToolResult {
                content, is_error, ..
            } => {
                write_separator(out, has_content);
                let label = if is_error.unwrap_or(false) {
                    "### Tool Error"
                } else {
                    "### Tool Result"
                };
                writeln!(out, "{label}").unwrap();
                writeln!(out).unwrap();
                let text = format_tool_result_content(content);
                if text.is_empty() {
                    writeln!(out, "(empty)").unwrap();
                } else {
                    writeln!(out, "{text}").unwrap();
                }
            }
        }
    }
}

/// Format tool input as readable key-value lines.
fn write_tool_input(out: &mut String, input: &Value) {
    match input {
        Value::Object(map) => {
            for (key, val) in map {
                let formatted = match val {
                    Value::String(s) => {
                        if s.contains('\n') {
                            format!("{key}:\n{s}")
                        } else {
                            format!("{key}: {s}")
                        }
                    }
                    _ => format!("{key}: {}", format_value(val)),
                };
                writeln!(out, "{formatted}").unwrap();
            }
        }
        _ => {
            writeln!(out, "{}", format_value(input)).unwrap();
        }
    }
}

/// Extract text from a tool_result content value.
fn format_tool_result_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => {
            // Claude API tool_result content can be [{type: "text", text: "..."}]
            let mut parts = Vec::new();
            for item in arr {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    parts.push(text.to_string());
                }
            }
            if parts.is_empty() {
                serde_json::to_string_pretty(content).unwrap_or_default()
            } else {
                parts.join("\n\n")
            }
        }
        Value::Null => String::new(),
        _ => serde_json::to_string_pretty(content).unwrap_or_default(),
    }
}

/// Format a JSON value as a compact string.
fn format_value(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => serde_json::to_string_pretty(val).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_entries() {
        let md = render_raw_transcript(&[], "task-1");
        assert!(md.contains("# Session Transcript"));
        assert!(md.contains("- task_id: task-1"));
        assert!(!md.contains("---"));
    }

    #[test]
    fn user_prompt_entry() {
        let entries = vec![LogEntry::UserPrompt("Fix the bug".to_string())];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("### User"));
        assert!(md.contains("Fix the bug"));
    }

    #[test]
    fn assistant_text_message() {
        let entries = vec![LogEntry::Stdout(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will fix it."}]}}"#
                .to_string()
                + "\n",
        )];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("### Assistant"));
        assert!(md.contains("I will fix it."));
    }

    #[test]
    fn tool_use_and_result() {
        let entries = vec![
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/main.rs"}}]}}"#
                    .to_string()
                    + "\n",
            ),
            LogEntry::Stdout(
                r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"fn main() {}"}]}}"#
                    .to_string()
                    + "\n",
            ),
        ];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("### Tool Use: Read"));
        assert!(md.contains("file_path: src/main.rs"));
        assert!(md.contains("### Tool Result"));
        assert!(md.contains("fn main() {}"));
    }

    #[test]
    fn thinking_block() {
        let entries = vec![LogEntry::Stdout(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me analyze..."}]}}"#
                .to_string()
                + "\n",
        )];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("### Thinking"));
        assert!(md.contains("Let me analyze..."));
    }

    #[test]
    fn skips_system_and_stream_events() {
        let entries = vec![
            LogEntry::Stdout(
                r#"{"type":"system","subtype":"init","session_id":"abc"}"#.to_string() + "\n",
            ),
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}"#
                    .to_string()
                    + "\n",
            ),
        ];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(!md.contains("### System"));
        assert!(md.contains("### Assistant"));
    }

    #[test]
    fn error_result() {
        let entries = vec![LogEntry::Stdout(
            r#"{"type":"result","subtype":"error","isError":true,"error":"Connection failed"}"#
                .to_string()
                + "\n",
        )];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("### Error"));
        assert!(md.contains("Connection failed"));
    }

    #[test]
    fn separators_between_entries() {
        let entries = vec![
            LogEntry::UserPrompt("Hello".to_string()),
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}"#
                    .to_string()
                    + "\n",
            ),
        ];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("---"));
        assert!(md.contains("### User"));
        assert!(md.contains("### Assistant"));
    }

    #[test]
    fn bash_tool_with_result() {
        let entries = vec![
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la","description":"List files"}}]}}"#
                    .to_string()
                    + "\n",
            ),
            LogEntry::Stdout(
                r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file1.txt\nfile2.txt"}]}}"#
                    .to_string()
                    + "\n",
            ),
        ];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("### Tool Use: Bash"));
        assert!(md.contains("command: ls -la"));
        assert!(md.contains("### Tool Result"));
        assert!(md.contains("file1.txt"));
    }
}
