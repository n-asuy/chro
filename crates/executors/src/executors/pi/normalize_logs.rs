//! Normalize pi `--mode rpc` output into chro conversation entries.
//!
//! The reader mirrors every protocol line into the message store; this module
//! turns those lines (`AgentSessionEvent`s, the `get_state` response, and chro's
//! own error markers) into `NormalizedEntry` JSON patches. Assistant text and
//! reasoning stream in place (one entry, replaced as it grows); tool calls are
//! rendered from `tool_execution_start`/`_end` pairs keyed by tool-call id.

use std::{collections::HashMap, path::Path, sync::Arc};

use events::MsgStore;
use futures::StreamExt;
use json_patch::Patch;
use log_types::{
    ActionType, CommandExitStatus, CommandRunResult, ConversationPatch, EntryIndexProvider,
    FileChange, NormalizedEntry, NormalizedEntryError, NormalizedEntryType, ToolResult, ToolStatus,
    create_unified_diff,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::protocol::{PiEvent, PiMessage, session_id_from_state};

/// A normalizer-visible error line emitted by the pi client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiError {
    chro_pi_error: PiErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PiErrorBody {
    message: String,
    #[serde(default)]
    auth: bool,
}

impl PiError {
    pub fn launch_error(message: String) -> Self {
        Self {
            chro_pi_error: PiErrorBody {
                message,
                auth: false,
            },
        }
    }

    pub fn auth_required(message: String) -> Self {
        Self {
            chro_pi_error: PiErrorBody {
                message,
                auth: true,
            },
        }
    }

    pub fn raw(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    fn to_normalized_entry(&self) -> NormalizedEntry {
        let error_type = if self.chro_pi_error.auth {
            NormalizedEntryError::SetupRequired
        } else {
            NormalizedEntryError::Other
        };
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ErrorMessage { error_type },
            content: self.chro_pi_error.message.clone(),
            metadata: None,
        }
    }
}

/// A single emission from the line processor.
enum Emit {
    Patch(Patch),
    SessionId(String),
}

#[derive(Default)]
struct LogState {
    assistant_idx: Option<usize>,
    thinking_idx: Option<usize>,
    tool_idx: HashMap<String, usize>,
    tool_calls: HashMap<String, ToolCallInfo>,
}

struct ToolCallInfo {
    tool_name: String,
    args: Value,
}

impl LogState {
    fn new() -> Self {
        Self::default()
    }

    /// Finalize the current assistant turn so the next message starts fresh
    /// entries rather than overwriting this one.
    fn end_assistant(&mut self) {
        self.assistant_idx = None;
        self.thinking_idx = None;
    }
}

/// Stream-process the live message store into conversation patches.
pub fn normalize_logs(msg_store: Arc<MsgStore>, _worktree_path: &Path) {
    let history = msg_store.history();
    let entry_index = EntryIndexProvider::start_from_history(&history);
    tokio::spawn(async move {
        let mut state = LogState::new();
        let mut stream = msg_store.history_plus_stream();

        while let Some(entry) = stream.next().await {
            let line = match &entry {
                log_types::LogEntry::Stdout(line) => line.clone(),
                log_types::LogEntry::UserPrompt(prompt) => {
                    let idx = entry_index.next();
                    msg_store.push_patch(ConversationPatch::add_normalized_entry(
                        idx,
                        user_entry(prompt.clone()),
                    ));
                    continue;
                }
                _ => continue,
            };

            for emit in process_line(&line, &mut state, &entry_index) {
                match emit {
                    Emit::Patch(patch) => msg_store.push_patch(patch),
                    Emit::SessionId(session_id) => msg_store.push_session_id(session_id),
                }
            }
        }
    });
}

/// Reconstruct conversation patches from persisted log entries (history replay).
pub fn replay_log_entries(
    entries: &[log_types::LogEntry],
    _worktree_path: &Path,
) -> Vec<log_types::LogEntry> {
    let entry_index = EntryIndexProvider::new();
    let mut state = LogState::new();
    let mut result: Vec<log_types::LogEntry> = Vec::new();

    for entry in entries {
        let line = match entry {
            log_types::LogEntry::Stdout(line) => line.clone(),
            log_types::LogEntry::UserPrompt(prompt) => {
                let idx = entry_index.next();
                result.push(patch_entry(ConversationPatch::add_normalized_entry(
                    idx,
                    user_entry(prompt.clone()),
                )));
                continue;
            }
            log_types::LogEntry::Finished => {
                result.push(log_types::LogEntry::Finished);
                break;
            }
            _ => continue,
        };

        for emit in process_line(&line, &mut state, &entry_index) {
            match emit {
                Emit::Patch(patch) => result.push(patch_entry(patch)),
                Emit::SessionId(session_id) => {
                    result.push(log_types::LogEntry::SessionId(session_id))
                }
            }
        }
    }

    result
}

fn patch_entry(patch: Patch) -> log_types::LogEntry {
    let value = serde_json::to_value(&patch).unwrap_or(Value::Null);
    log_types::LogEntry::JsonPatch(value)
}

/// Turn one raw protocol line into zero or more emissions.
fn process_line(line: &str, state: &mut LogState, idx: &EntryIndexProvider) -> Vec<Emit> {
    let mut emits = Vec::new();

    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return emits;
    };

    // chro-emitted error marker.
    if value.get("chro_pi_error").is_some() {
        if let Ok(error) = serde_json::from_value::<PiError>(value.clone()) {
            let entry_idx = idx.next();
            emits.push(Emit::Patch(ConversationPatch::add_normalized_entry(
                entry_idx,
                error.to_normalized_entry(),
            )));
        }
        return emits;
    }

    // Surface the pi session id from the get_state response.
    if value.get("type").and_then(Value::as_str) == Some("response")
        && value.get("command").and_then(Value::as_str) == Some("get_state")
    {
        if let Some(session_id) = value.get("data").and_then(session_id_from_state) {
            emits.push(Emit::SessionId(session_id));
        }
        return emits;
    }

    let Ok(event) = serde_json::from_value::<PiEvent>(value) else {
        return emits;
    };

    match event {
        PiEvent::MessageStart { message } | PiEvent::MessageUpdate { message } => {
            render_assistant(&message, state, idx, &mut emits);
        }
        PiEvent::MessageEnd { message } => {
            render_assistant(&message, state, idx, &mut emits);
            if matches!(message, PiMessage::Assistant { .. }) {
                state.end_assistant();
            }
        }
        PiEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => {
            let action = pi_action(&tool_name, &args, None);
            let entry = tool_entry(&tool_name, &args, action, ToolStatus::Created);
            let entry_idx = idx.next();
            emits.push(Emit::Patch(ConversationPatch::add_normalized_entry(
                entry_idx, entry,
            )));
            state.tool_idx.insert(tool_call_id.clone(), entry_idx);
            state
                .tool_calls
                .insert(tool_call_id, ToolCallInfo { tool_name, args });
        }
        PiEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => {
            let (name, args) = match state.tool_calls.get(&tool_call_id) {
                Some(info) => (info.tool_name.clone(), info.args.clone()),
                None => (tool_name, Value::Null),
            };
            let action = pi_action(&name, &args, Some(&result));
            let status = if is_error {
                ToolStatus::Failed
            } else {
                ToolStatus::Success
            };
            let entry = tool_entry(&name, &args, action, status);
            match state.tool_idx.get(&tool_call_id) {
                Some(entry_idx) => {
                    emits.push(Emit::Patch(ConversationPatch::replace(*entry_idx, entry)));
                }
                None => {
                    let entry_idx = idx.next();
                    emits.push(Emit::Patch(ConversationPatch::add_normalized_entry(
                        entry_idx, entry,
                    )));
                }
            }
        }
        PiEvent::AgentEnd { .. } | PiEvent::Other => {}
    }

    emits
}

fn render_assistant(
    message: &PiMessage,
    state: &mut LogState,
    idx: &EntryIndexProvider,
    emits: &mut Vec<Emit>,
) {
    if !matches!(message, PiMessage::Assistant { .. }) {
        return;
    }

    // Reasoning renders above the answer, so allocate it first.
    let thinking = message.assistant_thinking();
    if !thinking.trim().is_empty() {
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::Thinking,
            content: thinking,
            metadata: None,
        };
        match state.thinking_idx {
            Some(entry_idx) => {
                emits.push(Emit::Patch(ConversationPatch::replace(entry_idx, entry)))
            }
            None => {
                let entry_idx = idx.next();
                emits.push(Emit::Patch(ConversationPatch::add_normalized_entry(
                    entry_idx, entry,
                )));
                state.thinking_idx = Some(entry_idx);
            }
        }
    }

    let text = message.assistant_text();
    if !text.trim().is_empty() {
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::AssistantMessage,
            content: text,
            metadata: None,
        };
        match state.assistant_idx {
            Some(entry_idx) => {
                emits.push(Emit::Patch(ConversationPatch::replace(entry_idx, entry)))
            }
            None => {
                let entry_idx = idx.next();
                emits.push(Emit::Patch(ConversationPatch::add_normalized_entry(
                    entry_idx, entry,
                )));
                state.assistant_idx = Some(entry_idx);
            }
        }
    }
}

fn user_entry(content: String) -> NormalizedEntry {
    NormalizedEntry {
        timestamp: None,
        entry_type: NormalizedEntryType::UserMessage,
        content,
        metadata: None,
    }
}

fn tool_entry(
    tool_name: &str,
    args: &Value,
    action_type: ActionType,
    status: ToolStatus,
) -> NormalizedEntry {
    NormalizedEntry {
        timestamp: None,
        entry_type: NormalizedEntryType::ToolUse {
            tool_name: tool_name.to_string(),
            action_type,
            status,
        },
        content: tool_content(tool_name, args),
        metadata: Some(args.clone()),
    }
}

/// Map a pi tool call to a structured action for rich rendering.
fn pi_action(tool_name: &str, args: &Value, result: Option<&Value>) -> ActionType {
    let str_arg = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);

    match tool_name {
        "read" | "view" => ActionType::FileRead {
            path: str_arg("path").unwrap_or_default(),
        },
        "write" | "create" => {
            let path = str_arg("path").unwrap_or_default();
            let content = str_arg("content").unwrap_or_default();
            ActionType::FileEdit {
                path,
                changes: vec![FileChange::Write { content }],
            }
        }
        "edit" | "str_replace" => {
            let path = str_arg("path").unwrap_or_default();
            ActionType::FileEdit {
                path: path.clone(),
                changes: edit_changes(&path, args),
            }
        }
        "bash" | "shell" | "exec" => {
            let command = str_arg("command")
                .or_else(|| str_arg("cmd"))
                .unwrap_or_default();
            ActionType::CommandRun {
                command,
                result: result.map(command_result),
            }
        }
        "grep" | "glob" | "search" | "find" | "ripgrep" => ActionType::Search {
            query: str_arg("pattern")
                .or_else(|| str_arg("query"))
                .or_else(|| str_arg("path"))
                .unwrap_or_default(),
        },
        "fetch" | "webfetch" | "web_fetch" => ActionType::WebFetch {
            url: str_arg("url").unwrap_or_default(),
        },
        _ => ActionType::Tool {
            tool_name: tool_name.to_string(),
            arguments: Some(args.clone()),
            result: result.map(|value| ToolResult::markdown(result_to_text(value))),
        },
    }
}

fn edit_changes(path: &str, args: &Value) -> Vec<FileChange> {
    args.get("edits")
        .and_then(Value::as_array)
        .map(|edits| {
            edits
                .iter()
                .filter_map(|edit| {
                    let old = edit.get("oldText").and_then(Value::as_str)?;
                    let new = edit.get("newText").and_then(Value::as_str)?;
                    Some(FileChange::Edit {
                        unified_diff: create_unified_diff(path, old, new),
                        has_line_numbers: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn command_result(result: &Value) -> CommandRunResult {
    let exit_status = result
        .get("exitCode")
        .and_then(Value::as_i64)
        .map(|code| CommandExitStatus::ExitCode { code: code as i32 });
    CommandRunResult {
        exit_status,
        output: Some(result_to_text(result)),
    }
}

fn tool_content(tool_name: &str, args: &Value) -> String {
    let str_arg = |key: &str| args.get(key).and_then(Value::as_str);
    match tool_name {
        "bash" | "shell" | "exec" => str_arg("command")
            .or_else(|| str_arg("cmd"))
            .unwrap_or(tool_name)
            .to_string(),
        "read" | "view" | "write" | "create" | "edit" | "str_replace" => {
            str_arg("path").unwrap_or(tool_name).to_string()
        }
        _ => tool_name.to_string(),
    }
}

/// Best-effort extraction of human-readable text from a tool result value.
fn result_to_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    // BashResult-style payloads.
    if let Some(output) = value.get("output").and_then(Value::as_str) {
        return output.to_string();
    }
    // AgentToolResult-style `{ content: [{ type: "text", text }] }`.
    if let Some(text) = content_blocks_text(value.get("content")) {
        return text;
    }
    if let Some(text) = content_blocks_text(Some(value)) {
        return text;
    }
    serde_json::to_string(value).unwrap_or_default()
}

fn content_blocks_text(value: Option<&Value>) -> Option<String> {
    let blocks = value?.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() { None } else { Some(text) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use log_types::extract_normalized_entry_from_patch;

    fn entries(emits: Vec<Emit>) -> Vec<(usize, NormalizedEntry)> {
        emits
            .into_iter()
            .filter_map(|emit| match emit {
                Emit::Patch(patch) => extract_normalized_entry_from_patch(&patch),
                Emit::SessionId(_) => None,
            })
            .collect()
    }

    #[test]
    fn streams_assistant_text_into_one_entry() {
        let mut state = LogState::new();
        let idx = EntryIndexProvider::new();

        let start = r#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]}}"#;
        let update = r#"{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"assistantMessageEvent":{}}"#;
        let end = r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}"#;

        let first = entries(process_line(start, &mut state, &idx));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].0, 0);
        assert_eq!(first[0].1.content, "Hel");

        let second = entries(process_line(update, &mut state, &idx));
        // Same entry index, replaced in place.
        assert_eq!(second[0].0, 0);
        assert_eq!(second[0].1.content, "Hello");

        let _ = process_line(end, &mut state, &idx);
        // After the turn ends, a new assistant message gets a fresh index.
        let next = entries(process_line(
            r#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Again"}]}}"#,
            &mut state,
            &idx,
        ));
        assert_eq!(next[0].0, 1);
    }

    #[test]
    fn renders_bash_tool_call_and_result() {
        let mut state = LogState::new();
        let idx = EntryIndexProvider::new();

        let start = r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls -la"}}"#;
        let started = entries(process_line(start, &mut state, &idx));
        assert_eq!(started.len(), 1);
        match &started[0].1.entry_type {
            NormalizedEntryType::ToolUse {
                action_type: ActionType::CommandRun { command, result },
                status,
                ..
            } => {
                assert_eq!(command, "ls -la");
                assert!(result.is_none());
                assert_eq!(status, &ToolStatus::Created);
            }
            other => panic!("unexpected entry: {other:?}"),
        }

        let end = r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"output":"total 0","exitCode":0},"isError":false}"#;
        let ended = entries(process_line(end, &mut state, &idx));
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0].0, started[0].0, "tool entry replaced in place");
        match &ended[0].1.entry_type {
            NormalizedEntryType::ToolUse {
                action_type:
                    ActionType::CommandRun {
                        result: Some(run), ..
                    },
                status,
                ..
            } => {
                assert_eq!(status, &ToolStatus::Success);
                assert_eq!(run.output.as_deref(), Some("total 0"));
                assert_eq!(
                    run.exit_status,
                    Some(CommandExitStatus::ExitCode { code: 0 })
                );
            }
            other => panic!("unexpected entry: {other:?}"),
        }
    }

    #[test]
    fn maps_edit_to_unified_diff() {
        let mut state = LogState::new();
        let idx = EntryIndexProvider::new();
        let start = r#"{"type":"tool_execution_start","toolCallId":"e1","toolName":"edit","args":{"path":"/tmp/a.txt","edits":[{"oldText":"foo","newText":"bar"}]}}"#;
        let started = entries(process_line(start, &mut state, &idx));
        match &started[0].1.entry_type {
            NormalizedEntryType::ToolUse {
                action_type: ActionType::FileEdit { path, changes },
                ..
            } => {
                assert_eq!(path, "/tmp/a.txt");
                assert_eq!(changes.len(), 1);
                match &changes[0] {
                    FileChange::Edit { unified_diff, .. } => {
                        assert!(unified_diff.contains("-foo"));
                        assert!(unified_diff.contains("+bar"));
                    }
                    other => panic!("unexpected change: {other:?}"),
                }
            }
            other => panic!("unexpected entry: {other:?}"),
        }
    }

    #[test]
    fn extracts_session_id_from_get_state() {
        let mut state = LogState::new();
        let idx = EntryIndexProvider::new();
        let line = r#"{"type":"response","id":"1","command":"get_state","success":true,"data":{"sessionId":"sess-123","thinkingLevel":"medium"}}"#;
        let emits = process_line(line, &mut state, &idx);
        assert!(matches!(emits.as_slice(), [Emit::SessionId(s)] if s == "sess-123"));
    }

    #[test]
    fn renders_error_marker() {
        let mut state = LogState::new();
        let idx = EntryIndexProvider::new();
        let line = PiError::auth_required("sign in to pi".to_string()).raw();
        let rendered = entries(process_line(&line, &mut state, &idx));
        assert_eq!(rendered.len(), 1);
        assert!(matches!(
            rendered[0].1.entry_type,
            NormalizedEntryType::ErrorMessage {
                error_type: NormalizedEntryError::SetupRequired
            }
        ));
    }
}
