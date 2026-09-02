//! Transcript generation: render raw DB logs directly to Markdown.
//!
//! Instead of running the normalization pipeline, this module parses the raw
//! `LogEntry::Stdout` lines (Claude CLI stream-json) directly and renders them
//! as a chronological Markdown conversation — the same source data that Claude
//! Code saves as JSONL in `~/.claude/projects/`.

use std::fmt::Write;

use executors::{ClaudeContentItem, ClaudeJson};
use log_types::LogEntry;
use runtime::RuntimeError;
use serde_json::Value;
use uuid::Uuid;

use crate::LocalRuntime;

impl LocalRuntime {
    /// Render the Markdown transcript for an entire task (all runs combined in
    /// chronological order) and return the content. The runtime inlines this
    /// content into the executor's prompt at start-of-execution time, so no
    /// transcript file ever lands on disk.
    pub async fn task_transcript_markdown(&self, task_id: Uuid) -> Result<String, RuntimeError> {
        let runs = db::models::TaskRun::list_by_task_id(self.db.pool(), task_id).await?;

        // list_by_task_id returns DESC — reverse to chronological order.
        let mut all_entries: Vec<LogEntry> = Vec::new();
        for run in runs.iter().rev() {
            let entries = self.container.fetch_logs(run.id).await?;
            all_entries.extend(entries);
        }

        Ok(render_raw_transcript(&all_entries, &task_id.to_string()))
    }

    /// Return the most recent user prompt and assistant reply for a task.
    ///
    /// The assistant reply is the latest assistant text across all runs (runs
    /// scanned newest-first, entries within a run newest-first). The user prompt
    /// is the most recent session prompt, matching what the session view shows
    /// as the user message (it sources prompts from session metadata, not the
    /// raw expanded prompt logged at execution time).
    pub async fn task_last_exchange(
        &self,
        task_id: Uuid,
    ) -> Result<runtime::LastExchange, RuntimeError> {
        // list_by_task_id returns DESC (newest first) — exactly the order we
        // want when looking for the most recent reply.
        let runs = db::models::TaskRun::list_by_task_id(self.db.pool(), task_id).await?;
        let mut assistant = None;
        for run in &runs {
            let entries = self.container.fetch_logs(run.id).await?;
            if let Some(text) = last_assistant_text(&entries) {
                assistant = Some(text);
                break;
            }
        }

        // list_by_task_id (sessions) returns created_at ASC, so the last
        // non-empty prompt is the most recent user message.
        let sessions = db::models::TaskSession::list_by_task_id(self.db.pool(), task_id).await?;
        let user = sessions.iter().rev().find_map(|session| {
            session
                .prompt
                .as_deref()
                .map(str::trim)
                .filter(|prompt| !prompt.is_empty())
                .map(str::to_owned)
        });

        Ok(runtime::LastExchange { user, assistant })
    }

    /// Return the user prompt and final assistant reply for one conversation
    /// turn. A turn is a task session: each send inserts a session row linked
    /// to the run that executed it, so the turn's reply is the last assistant
    /// text in that run's log. `None` when the session does not belong to the
    /// task.
    pub async fn task_session_exchange(
        &self,
        task_id: Uuid,
        session_id: Uuid,
    ) -> Result<Option<runtime::LastExchange>, RuntimeError> {
        let sessions = db::models::TaskSession::list_by_task_id(self.db.pool(), task_id).await?;
        let Some(session) = sessions.into_iter().find(|session| session.id == session_id) else {
            return Ok(None);
        };

        let user = session
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .map(str::to_owned);
        let assistant = match session.task_run_id {
            Some(run_id) => last_assistant_text(&self.container.fetch_logs(run_id).await?),
            None => None,
        };

        Ok(Some(runtime::LastExchange { user, assistant }))
    }
}

/// Find the last assistant text message within a single run's log entries.
///
/// Mirrors [`render_raw_transcript`]'s interpretation of the raw Claude
/// stream-json `Stdout` lines, but walks backwards and stops at the first
/// assistant message that carries non-empty text.
pub(crate) fn last_assistant_text(entries: &[LogEntry]) -> Option<String> {
    for entry in entries.iter().rev() {
        let LogEntry::Stdout(chunk) = entry else {
            continue;
        };
        for line in chunk.split('\n').rev() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(ClaudeJson::Assistant { message, .. }) =
                serde_json::from_str::<ClaudeJson>(trimmed)
            else {
                continue;
            };
            let text = message
                .content
                .iter()
                .filter_map(|item| match item {
                    ClaudeContentItem::Text { text } if !text.trim().is_empty() => {
                        Some(text.trim())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// Character budget for a one-line outcome summary. Wide enough for a full
/// sentence, short enough to render on a single sidebar/preview line.
const OUTCOME_MAX_CHARS: usize = 160;

/// Distill a final assistant message into a one-line outcome summary.
///
/// Agents conventionally lead their final message with the outcome, so the
/// first prose line is a faithful "what this run did". Markdown structure is
/// stripped rather than rendered: heading/list/quote markers are removed,
/// fenced code and non-prose lines (tables, rules, images) are skipped, and
/// inline emphasis/code markers are dropped. Returns `None` when the text has
/// no prose line at all.
pub(crate) fn outcome_summary(text: &str) -> Option<String> {
    let mut in_fence = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || line.is_empty() {
            continue;
        }
        // Non-prose structure: tables, horizontal rules, images.
        if line.starts_with('|') || line.starts_with("![") {
            continue;
        }
        if line.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')) {
            continue;
        }

        let mut rest = line;
        // Peel leading block markers (headings, quotes, list bullets), which
        // can nest (e.g. "> - **Done**: ...").
        loop {
            let peeled = rest
                .trim_start_matches('#')
                .trim_start_matches('>')
                .trim_start();
            let peeled = peeled
                .strip_prefix("- ")
                .or_else(|| peeled.strip_prefix("* "))
                .or_else(|| peeled.strip_prefix("+ "))
                .or_else(|| {
                    // Ordered list: "12. rest"
                    let digits = peeled.chars().take_while(char::is_ascii_digit).count();
                    (digits > 0)
                        .then(|| peeled[digits..].strip_prefix(". "))
                        .flatten()
                })
                .unwrap_or(peeled);
            if peeled == rest {
                break;
            }
            rest = peeled;
        }

        // Drop inline emphasis/code markers; keep the words.
        let cleaned: String = rest
            .replace("**", "")
            .replace("__", "")
            .chars()
            .filter(|c| *c != '`')
            .collect();
        let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
        if cleaned.is_empty() {
            continue;
        }

        if cleaned.chars().count() <= OUTCOME_MAX_CHARS {
            return Some(cleaned);
        }
        let truncated: String = cleaned.chars().take(OUTCOME_MAX_CHARS).collect();
        return Some(format!("{}…", truncated.trim_end()));
    }
    None
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

    for entry in entries {
        match entry {
            LogEntry::UserPrompt(prompt) => {
                write_separator(&mut out, &mut has_content);
                writeln!(out, "### User").unwrap();
                writeln!(out).unwrap();
                writeln!(out, "{prompt}").unwrap();
            }
            LogEntry::Stdout(chunk) => {
                // Each Stdout entry is one logical unit, written as a single
                // complete JSON line by the Claude executor (no trailing \n)
                // or as one-or-more newline-delimited JSON lines from other
                // sources. Parse each non-empty line independently — buffering
                // across entries would only conflate distinct messages.
                for line in chunk.split('\n') {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(claude_json) = serde_json::from_str::<ClaudeJson>(trimmed) {
                        render_claude_json(&mut out, &claude_json, &mut has_content);
                    }
                }
            }
            _ => {}
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
        // (these are embedded in Assistant/User messages) and progress
        // heartbeats (no content of their own; the tool call is already
        // rendered from the message that carries it)
        ClaudeJson::System { .. }
        | ClaudeJson::StreamEvent { .. }
        | ClaudeJson::ToolUse { .. }
        | ClaudeJson::ToolResult { .. }
        | ClaudeJson::ToolProgress { .. }
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
            ClaudeContentItem::Unknown { data } => {
                let block_type = data
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                write_separator(out, has_content);
                writeln!(out, "### Unsupported content block: {block_type}").unwrap();
                writeln!(out).unwrap();
                if let Ok(rendered) = serde_json::to_string_pretty(data) {
                    writeln!(out, "```json\n{rendered}\n```").unwrap();
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
                .to_string(),
        )];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("### Assistant"));
        assert!(md.contains("I will fix it."));
    }

    /// Regression: the Claude executor writes each stream-json line as a
    /// `LogEntry::Stdout` payload **without** a trailing newline. Multiple
    /// consecutive entries must each render — previously they were concatenated
    /// into a single buffer keyed by `\n`, which silently dropped every entry.
    #[test]
    fn multiple_stdout_entries_without_trailing_newline() {
        let entries = vec![
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First message"}]}}"#
                    .to_string(),
            ),
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Second message"}]}}"#
                    .to_string(),
            ),
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Third message"}]}}"#
                    .to_string(),
            ),
        ];
        let md = render_raw_transcript(&entries, "task-1");
        assert!(md.contains("First message"), "first message missing:\n{md}");
        assert!(
            md.contains("Second message"),
            "second message missing:\n{md}"
        );
        assert!(md.contains("Third message"), "third message missing:\n{md}");
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
    fn outcome_summary_takes_first_prose_line() {
        assert_eq!(
            outcome_summary("Fixed the race in the settle effect.\n\nDetails follow."),
            Some("Fixed the race in the settle effect.".to_string())
        );
    }

    #[test]
    fn outcome_summary_strips_markdown_structure() {
        assert_eq!(
            outcome_summary("## 結論\n\n**修正完了**: `container.rs` の順序を入れ替えました。"),
            Some("結論".to_string())
        );
        assert_eq!(
            outcome_summary("- **Done**: wired the summary field"),
            Some("Done: wired the summary field".to_string())
        );
    }

    #[test]
    fn outcome_summary_skips_fences_tables_and_rules() {
        let text = "```rust\nlet x = 1;\n```\n\n| a | b |\n\n---\n\nActual outcome line.";
        assert_eq!(
            outcome_summary(text),
            Some("Actual outcome line.".to_string())
        );
    }

    #[test]
    fn outcome_summary_truncates_long_lines_on_char_boundary() {
        let long = "あ".repeat(200);
        let summary = outcome_summary(&long).unwrap();
        assert!(summary.ends_with('…'));
        assert_eq!(summary.chars().count(), 161);
    }

    #[test]
    fn outcome_summary_none_for_non_prose() {
        assert_eq!(outcome_summary(""), None);
        assert_eq!(outcome_summary("```\ncode only\n```"), None);
    }

    #[test]
    fn last_assistant_text_returns_latest_reply() {
        let entries = vec![
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First reply"}]}}"#
                    .to_string(),
            ),
            LogEntry::Stdout(
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Do more"}]}}"#
                    .to_string(),
            ),
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Second reply"}]}}"#
                    .to_string(),
            ),
        ];
        assert_eq!(
            last_assistant_text(&entries),
            Some("Second reply".to_string())
        );
    }

    #[test]
    fn last_assistant_text_skips_tool_only_and_empty_messages() {
        let entries = vec![
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The real answer"}]}}"#
                    .to_string(),
            ),
            LogEntry::Stdout(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.rs"}}]}}"#
                    .to_string(),
            ),
            LogEntry::Stdout(
                r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#
                    .to_string(),
            ),
        ];
        assert_eq!(
            last_assistant_text(&entries),
            Some("The real answer".to_string())
        );
    }

    #[test]
    fn last_assistant_text_none_without_assistant_text() {
        let entries = vec![LogEntry::UserPrompt("Just a prompt".to_string())];
        assert_eq!(last_assistant_text(&entries), None);
    }

    #[test]
    fn last_assistant_text_joins_multiple_text_blocks() {
        let entries = vec![LogEntry::Stdout(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Part one"},{"type":"text","text":"Part two"}]}}"#
                .to_string(),
        )];
        assert_eq!(
            last_assistant_text(&entries),
            Some("Part one\n\nPart two".to_string())
        );
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
