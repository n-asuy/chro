//! Claude stream-json log processor.
//!
//! Converts raw Claude CLI stream-json output into normalized log entries
//! with JSON Patch operations for efficient UI updates.
//!
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use events::MsgStore;
use futures::StreamExt;
use json_patch::Patch;
use log_types::{
    ActionType, CommandExitStatus, CommandRunResult, ConversationPatch, EntryIndexProvider,
    FileChange, LogEntry, NormalizedEntry, NormalizedEntryError, NormalizedEntryType, TodoItem,
    ToolResult, ToolResultValueType, ToolStatus, create_unified_diff,
    should_suppress_system_message,
};
use serde_json::Value;
use tracing::warn;

use super::types::{
    AmpBashResult, ApprovalStatus, ClaudeContentBlockDelta, ClaudeContentItem, ClaudeJson,
    ClaudeMessage, ClaudeStreamEvent, ClaudeToolData, ClaudeToolResultTextItem,
    ClaudeToolWithInput,
};

/// Strategy for handling history and user messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryStrategy {
    /// Claude-code default format
    Default,
    /// Amp threads format which includes logs from previous executions
    AmpResume,
}

/// Information about a tool call for result matching.
#[derive(Debug, Clone)]
struct ClaudeToolCallInfo {
    entry_index: usize,
    tool_name: String,
    tool_data: ClaudeToolData,
    content: String,
}

/// Handles log processing and interpretation for Claude executor.
pub struct ClaudeLogProcessor {
    model_name: Option<String>,
    /// Map tool_use_id -> structured info for follow-up ToolResult replacement
    tool_map: HashMap<String, ClaudeToolCallInfo>,
    /// Strategy controlling how to handle history and user messages
    strategy: HistoryStrategy,
    /// Streaming messages keyed by message_id
    streaming_messages: HashMap<String, StreamingMessageState>,
    /// Current streaming message id
    streaming_message_id: Option<String>,
}

impl Default for ClaudeLogProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeLogProcessor {
    pub fn new() -> Self {
        Self::new_with_strategy(HistoryStrategy::Default)
    }

    pub fn new_with_strategy(strategy: HistoryStrategy) -> Self {
        Self {
            model_name: None,
            tool_map: HashMap::new(),
            strategy,
            streaming_messages: HashMap::new(),
            streaming_message_id: None,
        }
    }

    /// Process raw logs from MsgStore and convert them to normalized entries with patches.
    /// Spawns a tokio task that subscribes to the msg_store stream.
    pub fn process_logs(
        msg_store: Arc<MsgStore>,
        current_dir: &Path,
        entry_index_provider: EntryIndexProvider,
        strategy: HistoryStrategy,
    ) {
        let current_dir_clone = current_dir.to_owned();
        tokio::spawn(async move {
            let mut stream = msg_store.history_plus_stream();
            let mut buffer = String::new();
            let worktree_path = current_dir_clone.to_string_lossy().to_string();
            let mut session_id_extracted = false;
            let mut processor = Self::new_with_strategy(strategy);

            while let Some(msg) = stream.next().await {
                let chunk = match msg {
                    LogEntry::Stdout(x) => x,
                    LogEntry::UserPrompt(prompt) => {
                        let entry = NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::UserMessage,
                            content: prompt,
                            metadata: None,
                        };
                        let patch_id = entry_index_provider.next();
                        let patch = ConversationPatch::add_normalized_entry(patch_id, entry);
                        msg_store.push_patch(patch);
                        continue;
                    }
                    LogEntry::JsonPatch(_) | LogEntry::SessionId(_) | LogEntry::Stderr(_) => {
                        continue;
                    }
                    LogEntry::UiEvent(_) => continue,
                    LogEntry::Finished => break,
                };

                buffer.push_str(&chunk);
                if !chunk.ends_with('\n') {
                    buffer.push('\n');
                }

                let lines_to_process: Vec<_> = buffer
                    .split_inclusive('\n')
                    .filter(|l| l.ends_with('\n'))
                    .map(str::to_owned)
                    .collect();
                for line in lines_to_process {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    if trimmed.starts_with("Service not running, starting service")
                        || trimmed
                            .contains("claude code router service has been successfully stopped")
                    {
                        continue;
                    }

                    match serde_json::from_str::<ClaudeJson>(trimmed) {
                        Ok(claude_json) => {
                            if !session_id_extracted {
                                if let Some(session_id) = claude_json.session_id() {
                                    msg_store.push_session_id(session_id);
                                    session_id_extracted = true;
                                }
                            }

                            let patches = processor.normalize_entries(
                                &claude_json,
                                &worktree_path,
                                &entry_index_provider,
                            );
                            for patch in patches {
                                msg_store.push_patch(patch);
                            }
                        }
                        Err(_) => {
                            if !trimmed.is_empty() && !should_suppress_system_message(trimmed) {
                                let entry = NormalizedEntry {
                                    timestamp: None,
                                    entry_type: NormalizedEntryType::SystemMessage,
                                    content: trimmed.to_string(),
                                    metadata: None,
                                };
                                let patch_id = entry_index_provider.next();
                                let patch =
                                    ConversationPatch::add_normalized_entry(patch_id, entry);
                                msg_store.push_patch(patch);
                            }
                        }
                    }
                }

                buffer = buffer.rsplit('\n').next().unwrap_or("").to_owned();
            }

            let trailing = buffer.trim();
            if !trailing.is_empty() && !should_suppress_system_message(trailing) {
                let entry = NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: trailing.to_string(),
                    metadata: None,
                };
                let patch_id = entry_index_provider.next();
                let patch = ConversationPatch::add_normalized_entry(patch_id, entry);
                msg_store.push_patch(patch);
            }
        });
    }

    /// Synchronously normalize persisted raw log entries (from DB) into the same
    /// WebSocket stream shape used by the UI (`LogEntry::JsonPatch` etc.).
    pub fn normalize_log_entries(entries: &[LogEntry], worktree_path: &str) -> Vec<LogEntry> {
        let entry_index_provider = EntryIndexProvider::new();
        let mut processor = Self::new();
        let mut result: Vec<LogEntry> = Vec::new();
        let mut buffer = String::new();
        let mut session_id_emitted = false;

        for entry in entries {
            match entry {
                LogEntry::Stdout(chunk) => {
                    buffer.push_str(chunk);
                    if !chunk.ends_with('\n') {
                        buffer.push('\n');
                    }

                    let lines_to_process: Vec<_> = buffer
                        .split_inclusive('\n')
                        .filter(|l| l.ends_with('\n'))
                        .map(str::to_owned)
                        .collect();

                    for line in lines_to_process {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }

                        if trimmed.starts_with("Service not running, starting service")
                            || trimmed.contains(
                                "claude code router service has been successfully stopped",
                            )
                        {
                            continue;
                        }

                        match serde_json::from_str::<ClaudeJson>(trimmed) {
                            Ok(claude_json) => {
                                if !session_id_emitted {
                                    if let Some(session_id) = claude_json.session_id() {
                                        result.push(LogEntry::SessionId(session_id.to_string()));
                                        session_id_emitted = true;
                                    }
                                }

                                let patches = processor.normalize_entries(
                                    &claude_json,
                                    worktree_path,
                                    &entry_index_provider,
                                );
                                for patch in patches {
                                    let json_value =
                                        serde_json::to_value(&patch).unwrap_or(Value::Null);
                                    result.push(LogEntry::JsonPatch(json_value));
                                }
                            }
                            Err(_) => {
                                if !trimmed.is_empty() && !should_suppress_system_message(trimmed) {
                                    let entry = NormalizedEntry {
                                        timestamp: None,
                                        entry_type: NormalizedEntryType::SystemMessage,
                                        content: trimmed.to_string(),
                                        metadata: None,
                                    };
                                    let patch_id = entry_index_provider.next();
                                    let patch =
                                        ConversationPatch::add_normalized_entry(patch_id, entry);
                                    let json_value =
                                        serde_json::to_value(&patch).unwrap_or(Value::Null);
                                    result.push(LogEntry::JsonPatch(json_value));
                                }
                            }
                        }
                    }

                    buffer = buffer.rsplit('\n').next().unwrap_or("").to_owned();
                }
                LogEntry::UserPrompt(prompt) => {
                    let entry = NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::UserMessage,
                        content: prompt.clone(),
                        metadata: None,
                    };
                    let patch_id = entry_index_provider.next();
                    let patch = ConversationPatch::add_normalized_entry(patch_id, entry);
                    let json_value = serde_json::to_value(&patch).unwrap_or(Value::Null);
                    result.push(LogEntry::JsonPatch(json_value));
                }
                LogEntry::SessionId(id) => {
                    if !session_id_emitted {
                        session_id_emitted = true;
                    }
                    result.push(LogEntry::SessionId(id.clone()));
                }
                LogEntry::Finished => {
                    result.push(LogEntry::Finished);
                    break;
                }
                LogEntry::Stderr(_) | LogEntry::JsonPatch(_) | LogEntry::UiEvent(_) => {}
            }
        }

        let trailing = buffer.trim();
        if !trailing.is_empty() && !should_suppress_system_message(trailing) {
            let entry = NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::SystemMessage,
                content: trailing.to_string(),
                metadata: None,
            };
            let patch_id = entry_index_provider.next();
            let patch = ConversationPatch::add_normalized_entry(patch_id, entry);
            let json_value = serde_json::to_value(&patch).unwrap_or(Value::Null);
            result.push(LogEntry::JsonPatch(json_value));
        }

        result
    }

    /// Normalize Claude tool_result content to either Markdown string or parsed JSON.
    fn normalize_claude_tool_result_value(content: &Value) -> (ToolResultValueType, Value) {
        if let Some(s) = content.as_str() {
            if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                return (ToolResultValueType::Json, parsed);
            }
            return (ToolResultValueType::Markdown, Value::String(s.to_string()));
        }

        if let Ok(items) = serde_json::from_value::<Vec<ClaudeToolResultTextItem>>(content.clone())
        {
            if !items.is_empty() {
                let joined = items
                    .into_iter()
                    .map(|i| i.text)
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if let Ok(parsed) = serde_json::from_str::<Value>(&joined) {
                    return (ToolResultValueType::Json, parsed);
                }
                return (ToolResultValueType::Markdown, Value::String(joined));
            }
        }

        (ToolResultValueType::Json, content.clone())
    }

    /// Convert Claude content item to normalized entry.
    fn content_item_to_normalized_entry(
        content_item: &ClaudeContentItem,
        role: &str,
        worktree_path: &str,
    ) -> Option<NormalizedEntry> {
        match content_item {
            ClaudeContentItem::Text { text } => {
                let entry_type = match role {
                    "assistant" => NormalizedEntryType::AssistantMessage,
                    _ => return None,
                };
                Some(NormalizedEntry {
                    timestamp: None,
                    entry_type,
                    content: text.clone(),
                    metadata: Some(serde_json::to_value(content_item).unwrap_or(Value::Null)),
                })
            }
            ClaudeContentItem::Thinking { thinking } => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::Thinking,
                content: thinking.clone(),
                metadata: Some(serde_json::to_value(content_item).unwrap_or(Value::Null)),
            }),
            ClaudeContentItem::ToolUse { tool_data, id } => {
                let name = tool_data.name();
                let action_type = Self::extract_action_type(tool_data, worktree_path);
                let content =
                    Self::generate_concise_content(tool_data, &action_type, worktree_path);

                let mut metadata = serde_json::to_value(content_item).unwrap_or(Value::Null);
                if let Some(obj) = metadata.as_object_mut() {
                    obj.insert("tool_call_id".to_string(), Value::String(id.clone()));
                }

                Some(NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::ToolUse {
                        tool_name: name.to_string(),
                        action_type,
                        status: ToolStatus::Created,
                    },
                    content,
                    metadata: Some(metadata),
                })
            }
            ClaudeContentItem::ToolResult { .. } => None,
            ClaudeContentItem::Unknown { data } => {
                let block_type = data
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let _ = role;
                let _ = worktree_path;
                Some(NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: format!("Unsupported Claude content block: {block_type}"),
                    metadata: Some(serde_json::to_value(content_item).unwrap_or(Value::Null)),
                })
            }
        }
    }

    /// Extract action type from structured tool data.
    fn extract_action_type(tool_data: &ClaudeToolData, worktree_path: &str) -> ActionType {
        match tool_data {
            ClaudeToolData::Read { file_path } => ActionType::FileRead {
                path: make_path_relative(file_path, worktree_path),
            },
            ClaudeToolData::Edit {
                file_path,
                old_string,
                new_string,
            } => {
                let changes = if old_string.is_some() || new_string.is_some() {
                    vec![FileChange::Edit {
                        unified_diff: create_unified_diff(
                            file_path,
                            old_string.as_deref().unwrap_or(""),
                            new_string.as_deref().unwrap_or(""),
                        ),
                        has_line_numbers: false,
                    }]
                } else {
                    vec![]
                };
                ActionType::FileEdit {
                    path: make_path_relative(file_path, worktree_path),
                    changes,
                }
            }
            ClaudeToolData::MultiEdit { file_path, edits } => {
                let changes: Vec<FileChange> = edits
                    .iter()
                    .filter(|edit| edit.old_string.is_some() || edit.new_string.is_some())
                    .map(|edit| FileChange::Edit {
                        unified_diff: create_unified_diff(
                            file_path,
                            edit.old_string.as_deref().unwrap_or(""),
                            edit.new_string.as_deref().unwrap_or(""),
                        ),
                        has_line_numbers: false,
                    })
                    .collect();
                ActionType::FileEdit {
                    path: make_path_relative(file_path, worktree_path),
                    changes,
                }
            }
            ClaudeToolData::Write { file_path, content } => ActionType::FileEdit {
                path: make_path_relative(file_path, worktree_path),
                changes: vec![FileChange::Write {
                    content: content.clone(),
                }],
            },
            ClaudeToolData::Bash { command, .. } => ActionType::CommandRun {
                command: command.clone(),
                result: None,
            },
            ClaudeToolData::Grep { pattern, .. } => ActionType::Search {
                query: pattern.clone(),
            },
            ClaudeToolData::Glob { pattern, .. } => ActionType::Search {
                query: pattern.clone(),
            },
            ClaudeToolData::LS { path } => ActionType::Other {
                description: format!(
                    "List directory: {}",
                    make_path_relative(path, worktree_path)
                ),
            },
            ClaudeToolData::WebFetch { url, .. } => ActionType::WebFetch { url: url.clone() },
            ClaudeToolData::WebSearch { query, .. } => ActionType::Search {
                query: query.clone(),
            },
            ClaudeToolData::Task {
                description,
                prompt,
                ..
            } => {
                let task_description = description
                    .clone()
                    .or_else(|| prompt.clone())
                    .unwrap_or_default();
                ActionType::TaskCreate {
                    description: task_description,
                }
            }
            ClaudeToolData::ExitPlanMode { plan } => {
                ActionType::PlanPresentation { plan: plan.clone() }
            }
            ClaudeToolData::TodoWrite { todos } => ActionType::TodoManagement {
                todos: todos
                    .iter()
                    .map(|t| TodoItem {
                        content: t.content.clone(),
                        status: t.status.clone(),
                        priority: t.priority.clone(),
                    })
                    .collect(),
                operation: "write".to_string(),
            },
            ClaudeToolData::TodoRead {} => ActionType::TodoManagement {
                todos: vec![],
                operation: "read".to_string(),
            },
            ClaudeToolData::NotebookEdit { .. } => ActionType::Tool {
                tool_name: "NotebookEdit".to_string(),
                arguments: Some(serde_json::to_value(tool_data).unwrap_or(Value::Null)),
                result: None,
            },
            ClaudeToolData::AskUserQuestion { questions } => {
                let questions_json = questions
                    .iter()
                    .map(|q| {
                        serde_json::json!({
                            "question": q.question,
                            "header": q.header,
                            "options": q.options.iter().map(|o| {
                                serde_json::json!({
                                    "label": o.label,
                                    "description": o.description
                                })
                            }).collect::<Vec<_>>(),
                            "multiSelect": q.multi_select
                        })
                    })
                    .collect::<Vec<_>>();

                ActionType::Tool {
                    tool_name: "AskUserQuestion".to_string(),
                    arguments: Some(serde_json::json!({ "questions": questions_json })),
                    result: None,
                }
            }
            ClaudeToolData::Unknown { .. } => {
                let name = tool_data.name();
                if name.starts_with("mcp__") {
                    let parts: Vec<&str> = name.split("__").collect();
                    let label = if parts.len() >= 3 {
                        format!("mcp:{}:{}", parts[1], parts[2])
                    } else {
                        name.to_string()
                    };
                    let args = serde_json::to_value(tool_data)
                        .ok()
                        .and_then(|v| serde_json::from_value::<ClaudeToolWithInput>(v).ok())
                        .map(|w| w.input)
                        .unwrap_or(Value::Null);
                    ActionType::Tool {
                        tool_name: label,
                        arguments: Some(args),
                        result: None,
                    }
                } else {
                    ActionType::Other {
                        description: format!("Tool: {}", name),
                    }
                }
            }
        }
    }

    /// Generate concise, readable content for tool usage.
    fn generate_concise_content(
        tool_data: &ClaudeToolData,
        action_type: &ActionType,
        worktree_path: &str,
    ) -> String {
        match action_type {
            ActionType::FileRead { path } => format!("`{path}`"),
            ActionType::FileEdit { path, .. } => format!("`{path}`"),
            ActionType::CommandRun { command, .. } => format!("`{command}`"),
            ActionType::Search { query } => format!("`{query}`"),
            ActionType::WebFetch { url } => format!("`{url}`"),
            ActionType::TaskCreate { description } => {
                if description.is_empty() {
                    "Task".to_string()
                } else {
                    format!("Task: `{description}`")
                }
            }
            ActionType::Tool { .. } => match tool_data {
                ClaudeToolData::NotebookEdit { notebook_path, .. } => {
                    format!("`{}`", make_path_relative(notebook_path, worktree_path))
                }
                ClaudeToolData::AskUserQuestion { questions } => questions
                    .first()
                    .map(|q| q.header.clone())
                    .unwrap_or_else(|| "Question".to_string()),
                ClaudeToolData::Unknown { .. } => {
                    let name = tool_data.name();
                    if name.starts_with("mcp__") {
                        let parts: Vec<&str> = name.split("__").collect();
                        if parts.len() >= 3 {
                            return format!("mcp:{}:{}", parts[1], parts[2]);
                        }
                    }
                    name.to_string()
                }
                _ => tool_data.name().to_string(),
            },
            ActionType::PlanPresentation { plan } => plan.clone(),
            ActionType::TodoManagement { .. } => "TODO list updated".to_string(),
            ActionType::Other { description: _ } => match tool_data {
                ClaudeToolData::LS { path } => {
                    let relative_path = make_path_relative(path, worktree_path);
                    if relative_path.is_empty() {
                        "List directory".to_string()
                    } else {
                        format!("List directory: `{relative_path}`")
                    }
                }
                ClaudeToolData::Glob { pattern, path, .. } => {
                    if let Some(search_path) = path {
                        format!(
                            "Find files: `{}` in `{}`",
                            pattern,
                            make_path_relative(search_path, worktree_path)
                        )
                    } else {
                        format!("Find files: `{pattern}`")
                    }
                }
                _ => tool_data.name().to_string(),
            },
        }
    }

    /// Convert Claude JSON to normalized patches.
    fn normalize_entries(
        &mut self,
        claude_json: &ClaudeJson,
        worktree_path: &str,
        entry_index_provider: &EntryIndexProvider,
    ) -> Vec<Patch> {
        let mut patches = Vec::new();

        match claude_json {
            ClaudeJson::System { api_key_source, .. } => {
                // System events (`init`, `status`, `thinking_tokens`, …) are
                // Claude Code protocol/status signals, not user-facing
                // conversation content. We never surface them as SystemMessage
                // entries: doing so leaks every new subtype Claude Code adds
                // into the UI as a bare "System: <subtype>" line.
                //
                // The sole exception is the billing warning. An
                // ANTHROPIC_API_KEY on the init event means usage is billed
                // pay-as-you-go instead of via the Claude subscription, which
                // the user must see.
                if let Some("ANTHROPIC_API_KEY") = api_key_source.as_deref() {
                    warn!("ANTHROPIC_API_KEY env variable detected");
                    let warning = NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::ErrorMessage {
                            error_type: NormalizedEntryError::Other,
                        },
                        content: "Claude Code + ANTHROPIC_API_KEY detected. Usage will be billed via Anthropic pay-as-you-go instead of your Claude subscription.".to_string(),
                        metadata: None,
                    };
                    let idx = entry_index_provider.next();
                    patches.push(ConversationPatch::add_normalized_entry(idx, warning));
                }
            }
            ClaudeJson::Assistant { message, .. } => {
                if let Some(patch) = self.extract_model_name(message, entry_index_provider) {
                    patches.push(patch);
                }

                let mut streaming_message_state = message
                    .id
                    .as_ref()
                    .and_then(|id| self.streaming_messages.remove(id));

                for (content_index, item) in message.content.iter().enumerate() {
                    let entry_index = streaming_message_state
                        .as_mut()
                        .and_then(|state| state.content_entry_index(content_index));

                    match item {
                        ClaudeContentItem::ToolUse { id, tool_data } => {
                            let tool_name = tool_data.name().to_string();
                            let action_type = Self::extract_action_type(tool_data, worktree_path);
                            let content_text = Self::generate_concise_content(
                                tool_data,
                                &action_type,
                                worktree_path,
                            );

                            let mut metadata = serde_json::to_value(item).unwrap_or(Value::Null);
                            if let Some(obj) = metadata.as_object_mut() {
                                obj.insert("tool_call_id".to_string(), Value::String(id.clone()));
                            }

                            let entry = NormalizedEntry {
                                timestamp: None,
                                entry_type: NormalizedEntryType::ToolUse {
                                    tool_name: tool_name.clone(),
                                    action_type,
                                    status: ToolStatus::Created,
                                },
                                content: content_text.clone(),
                                metadata: Some(metadata),
                            };

                            let is_new = entry_index.is_none();
                            let id_num = entry_index.unwrap_or_else(|| entry_index_provider.next());

                            self.tool_map.insert(
                                id.clone(),
                                ClaudeToolCallInfo {
                                    entry_index: id_num,
                                    tool_name: tool_name.clone(),
                                    tool_data: tool_data.clone(),
                                    content: content_text,
                                },
                            );

                            let patch = if is_new {
                                ConversationPatch::add_normalized_entry(id_num, entry)
                            } else {
                                ConversationPatch::replace(id_num, entry)
                            };
                            patches.push(patch);
                        }
                        ClaudeContentItem::Text { .. }
                        | ClaudeContentItem::Thinking { .. }
                        | ClaudeContentItem::Unknown { .. } => {
                            if let Some(entry) = Self::content_item_to_normalized_entry(
                                item,
                                &message.role,
                                worktree_path,
                            ) {
                                let is_new = entry_index.is_none();
                                let idx =
                                    entry_index.unwrap_or_else(|| entry_index_provider.next());
                                let patch = if is_new {
                                    ConversationPatch::add_normalized_entry(idx, entry)
                                } else {
                                    ConversationPatch::replace(idx, entry)
                                };
                                patches.push(patch);
                            }
                        }
                        ClaudeContentItem::ToolResult { .. } => {}
                    }
                }
            }
            ClaudeJson::User { message, .. } => {
                if matches!(self.strategy, HistoryStrategy::AmpResume)
                    && message
                        .content
                        .iter()
                        .any(|c| matches!(c, ClaudeContentItem::Text { .. }))
                {
                    let cur = entry_index_provider.current();
                    if cur > 0 {
                        for _ in 0..cur {
                            patches.push(ConversationPatch::remove_by_key(0.to_string()));
                        }
                        entry_index_provider.reset();
                        self.tool_map.clear();
                    }

                    for item in &message.content {
                        if let ClaudeContentItem::Text { text } = item {
                            let entry = NormalizedEntry {
                                timestamp: None,
                                entry_type: NormalizedEntryType::UserMessage,
                                content: text.clone(),
                                metadata: Some(serde_json::to_value(item).unwrap_or(Value::Null)),
                            };
                            let id = entry_index_provider.next();
                            patches.push(ConversationPatch::add_normalized_entry(id, entry));
                        }
                    }
                }

                for item in &message.content {
                    if let ClaudeContentItem::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = item
                    {
                        if let Some(info) = self.tool_map.get(tool_use_id).cloned() {
                            let is_command = matches!(info.tool_data, ClaudeToolData::Bash { .. });

                            if is_command {
                                let content_str = if let Some(s) = content.as_str() {
                                    s.to_string()
                                } else {
                                    content.to_string()
                                };

                                let result = if let Ok(result) =
                                    serde_json::from_str::<AmpBashResult>(&content_str)
                                {
                                    Some(CommandRunResult {
                                        exit_status: Some(CommandExitStatus::ExitCode {
                                            code: result.exit_code,
                                        }),
                                        output: Some(result.output),
                                    })
                                } else {
                                    Some(CommandRunResult {
                                        exit_status: is_error.map(|is_err| {
                                            CommandExitStatus::Success { success: !is_err }
                                        }),
                                        output: Some(content_str),
                                    })
                                };

                                let status = if is_error.unwrap_or(false) {
                                    ToolStatus::Failed
                                } else {
                                    ToolStatus::Success
                                };

                                let entry = NormalizedEntry {
                                    timestamp: None,
                                    entry_type: NormalizedEntryType::ToolUse {
                                        tool_name: info.tool_name.clone(),
                                        action_type: ActionType::CommandRun {
                                            command: info.content.clone(),
                                            result,
                                        },
                                        status,
                                    },
                                    content: info.content.clone(),
                                    metadata: None,
                                };
                                patches.push(ConversationPatch::replace(info.entry_index, entry));
                            } else if matches!(info.tool_data, ClaudeToolData::Read { .. }) {
                                let status = if is_error.unwrap_or(false) {
                                    ToolStatus::Failed
                                } else {
                                    ToolStatus::Success
                                };

                                let entry = NormalizedEntry {
                                    timestamp: None,
                                    entry_type: NormalizedEntryType::ToolUse {
                                        tool_name: info.tool_name.clone(),
                                        action_type: Self::extract_action_type(
                                            &info.tool_data,
                                            worktree_path,
                                        ),
                                        status,
                                    },
                                    content: info.content.clone(),
                                    metadata: None,
                                };
                                patches.push(ConversationPatch::replace(info.entry_index, entry));
                            } else if matches!(
                                info.tool_data,
                                ClaudeToolData::Unknown { .. }
                                    | ClaudeToolData::NotebookEdit { .. }
                            ) {
                                let (res_type, res_value) =
                                    Self::normalize_claude_tool_result_value(content);

                                let args_to_show = serde_json::to_value(&info.tool_data)
                                    .ok()
                                    .and_then(|v| {
                                        serde_json::from_value::<ClaudeToolWithInput>(v).ok()
                                    })
                                    .map(|w| w.input)
                                    .unwrap_or(Value::Null);

                                let tool_name = info.tool_data.name().to_string();
                                let label = if tool_name.starts_with("mcp__") {
                                    let parts: Vec<&str> = tool_name.split("__").collect();
                                    if parts.len() >= 3 {
                                        format!("mcp:{}:{}", parts[1], parts[2])
                                    } else {
                                        tool_name.clone()
                                    }
                                } else {
                                    tool_name.clone()
                                };

                                let status = if is_error.unwrap_or(false) {
                                    ToolStatus::Failed
                                } else {
                                    ToolStatus::Success
                                };

                                let entry = NormalizedEntry {
                                    timestamp: None,
                                    entry_type: NormalizedEntryType::ToolUse {
                                        tool_name: label.clone(),
                                        action_type: ActionType::Tool {
                                            tool_name: label,
                                            arguments: Some(args_to_show),
                                            result: Some(ToolResult {
                                                result_type: res_type,
                                                value: res_value,
                                            }),
                                        },
                                        status,
                                    },
                                    content: info.content.clone(),
                                    metadata: None,
                                };
                                patches.push(ConversationPatch::replace(info.entry_index, entry));
                            }
                        }
                    }
                }
            }
            ClaudeJson::ToolUse { tool_data, .. } => {
                let tool_name = tool_data.name();
                let action_type = Self::extract_action_type(tool_data, worktree_path);
                let content =
                    Self::generate_concise_content(tool_data, &action_type, worktree_path);

                let entry = NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::ToolUse {
                        tool_name: tool_name.to_string(),
                        action_type,
                        status: ToolStatus::Created,
                    },
                    content,
                    metadata: Some(serde_json::to_value(claude_json).unwrap_or(Value::Null)),
                };
                let idx = entry_index_provider.next();
                patches.push(ConversationPatch::add_normalized_entry(idx, entry));
            }
            ClaudeJson::ToolResult { .. } => {}
            ClaudeJson::StreamEvent { event, .. } => match event {
                ClaudeStreamEvent::MessageStart { message } => {
                    if message.role == "assistant" {
                        if let Some(patch) = self.extract_model_name(message, entry_index_provider)
                        {
                            patches.push(patch);
                        }

                        if let Some(message_id) = message.id.clone() {
                            self.streaming_messages.insert(
                                message_id.clone(),
                                StreamingMessageState::new(message.role.clone()),
                            );
                            self.streaming_message_id = Some(message_id);
                        } else {
                            self.streaming_message_id = None;
                        }
                    } else {
                        self.streaming_message_id = None;
                    }
                }
                ClaudeStreamEvent::ContentBlockStart {
                    index,
                    content_block,
                } => {
                    if let Some(state) = self
                        .streaming_message_id
                        .as_ref()
                        .and_then(|id| self.streaming_messages.get_mut(id))
                    {
                        state.content_block_start(*index, content_block.clone());
                    }
                }
                ClaudeStreamEvent::ContentBlockDelta { index, delta } => {
                    if let Some(state) = self
                        .streaming_message_id
                        .as_ref()
                        .and_then(|id| self.streaming_messages.get_mut(id))
                    {
                        if let Some(patch) = state.apply_content_block_delta(
                            *index,
                            delta,
                            worktree_path,
                            entry_index_provider,
                        ) {
                            patches.push(patch);
                        }
                    }
                }
                ClaudeStreamEvent::ContentBlockStop { .. } => {}
                ClaudeStreamEvent::MessageDelta { .. } => {}
                ClaudeStreamEvent::MessageStop => {
                    if let Some(message_id) = self.streaming_message_id.take() {
                        let _ = self.streaming_messages.remove(&message_id);
                    }
                }
                ClaudeStreamEvent::Unknown => {}
            },
            ClaudeJson::Result { is_error, .. } => {
                if is_error.unwrap_or(false) {
                    let entry = NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::ErrorMessage {
                            error_type: NormalizedEntryError::Other,
                        },
                        content: serde_json::to_string(claude_json)
                            .unwrap_or_else(|_| "error".to_string()),
                        metadata: Some(serde_json::to_value(claude_json).unwrap_or(Value::Null)),
                    };
                    let idx = entry_index_provider.next();
                    patches.push(ConversationPatch::add_normalized_entry(idx, entry));
                }
            }
            ClaudeJson::RateLimitEvent { .. } => {}
            ClaudeJson::ApprovalResponse {
                tool_name,
                approval_status,
                ..
            } => {
                let entry_opt = match approval_status {
                    ApprovalStatus::Pending | ApprovalStatus::Approved => None,
                    ApprovalStatus::Denied { reason } => Some(NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::UserFeedback {
                            denied_tool: tool_name.clone(),
                        },
                        content: reason
                            .as_ref()
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "User denied this tool use request".to_string()),
                        metadata: None,
                    }),
                    ApprovalStatus::TimedOut => Some(NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::ErrorMessage {
                            error_type: NormalizedEntryError::Other,
                        },
                        content: format!("Approval timed out for tool {tool_name}"),
                        metadata: None,
                    }),
                };

                if let Some(entry) = entry_opt {
                    let idx = entry_index_provider.next();
                    patches.push(ConversationPatch::add_normalized_entry(idx, entry));
                }
            }
            ClaudeJson::Unknown { data } => {
                let entry = NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: format!(
                        "Unrecognized JSON message: {}",
                        serde_json::to_value(data).unwrap_or_default()
                    ),
                    metadata: None,
                };
                let idx = entry_index_provider.next();
                patches.push(ConversationPatch::add_normalized_entry(idx, entry));
            }
        }

        patches
    }

    fn extract_model_name(
        &mut self,
        message: &ClaudeMessage,
        entry_index_provider: &EntryIndexProvider,
    ) -> Option<Patch> {
        if self.model_name.is_none() {
            if let Some(model) = message.model.as_ref() {
                self.model_name = Some(model.clone());
                let display_name = format_model_display_name(model);
                let entry = NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: format!("Run with {display_name}"),
                    metadata: None,
                };
                let id = entry_index_provider.next();
                return Some(ConversationPatch::add_normalized_entry(id, entry));
            }
        }
        None
    }
}

/// Formats a raw model ID into a human-readable display name.
/// Examples:
///   "claude-opus-4-5-20251101" -> "Opus 4.5"
///   "claude-sonnet-4-5-20251101" -> "Sonnet 4.5"
///   "claude-3-5-sonnet-20241022" -> "Sonnet 3.5"
///   "claude-3-opus-20240229" -> "Opus 3"
fn format_model_display_name(model_id: &str) -> String {
    let lower = model_id.to_lowercase();

    let family = if lower.contains("opus") {
        "Opus"
    } else if lower.contains("sonnet") {
        "Sonnet"
    } else if lower.contains("haiku") {
        "Haiku"
    } else {
        return model_id.to_string();
    };

    let version = extract_version_from_model_id(&lower);

    match version {
        Some(v) => format!("{family} {v}"),
        None => family.to_string(),
    }
}

fn extract_version_from_model_id(model_id: &str) -> Option<String> {
    let cleaned = model_id
        .replace("claude-", "")
        .replace("-opus", " ")
        .replace("-sonnet", " ")
        .replace("-haiku", " ")
        .replace("opus-", " ")
        .replace("sonnet-", " ")
        .replace("haiku-", " ");

    let parts: Vec<&str> = cleaned.split_whitespace().next()?.split('-').collect();

    for (i, part) in parts.iter().enumerate() {
        if let Ok(major) = part.parse::<u32>() {
            if i + 1 < parts.len() {
                if let Ok(minor) = parts[i + 1].parse::<u32>() {
                    return Some(format!("{major}.{minor}"));
                }
            }
            return Some(format!("{major}"));
        }
    }
    None
}

struct StreamingMessageState {
    role: String,
    contents: HashMap<usize, StreamingContentState>,
}

impl StreamingMessageState {
    fn new(role: String) -> Self {
        Self {
            role,
            contents: HashMap::new(),
        }
    }

    fn content_block_start(&mut self, index: usize, content_block: ClaudeContentItem) {
        if let Some(state) = StreamingContentState::from_content_block(content_block) {
            self.contents.insert(index, state);
        }
    }

    fn apply_content_block_delta(
        &mut self,
        index: usize,
        delta: &ClaudeContentBlockDelta,
        worktree_path: &str,
        entry_index_provider: &EntryIndexProvider,
    ) -> Option<Patch> {
        if let std::collections::hash_map::Entry::Vacant(e) = self.contents.entry(index) {
            let new_state = StreamingContentState::from_delta(delta)?;
            e.insert(new_state);
        }

        let entry_state = self.contents.get_mut(&index)?;
        entry_state.apply_content_delta(delta);

        let content_item = entry_state.to_content_item();
        let entry = ClaudeLogProcessor::content_item_to_normalized_entry(
            &content_item,
            &self.role,
            worktree_path,
        )?;

        if let Some(existing_index) = entry_state.entry_index {
            Some(ConversationPatch::replace(existing_index, entry))
        } else {
            let entry_index = entry_index_provider.next();
            entry_state.entry_index = Some(entry_index);
            Some(ConversationPatch::add_normalized_entry(entry_index, entry))
        }
    }

    fn content_entry_index(&self, content_index: usize) -> Option<usize> {
        self.contents
            .get(&content_index)
            .and_then(|s| s.entry_index)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamingContentKind {
    Text,
    Thinking,
}

struct StreamingContentState {
    kind: StreamingContentKind,
    buffer: String,
    entry_index: Option<usize>,
}

impl StreamingContentState {
    fn from_content_block(content_block: ClaudeContentItem) -> Option<Self> {
        match content_block {
            ClaudeContentItem::Text { text } => Some(Self {
                kind: StreamingContentKind::Text,
                buffer: text,
                entry_index: None,
            }),
            ClaudeContentItem::Thinking { thinking } => Some(Self {
                kind: StreamingContentKind::Thinking,
                buffer: thinking,
                entry_index: None,
            }),
            _ => None,
        }
    }

    fn from_delta(delta: &ClaudeContentBlockDelta) -> Option<Self> {
        match delta {
            ClaudeContentBlockDelta::TextDelta { .. } => Some(Self {
                kind: StreamingContentKind::Text,
                buffer: String::new(),
                entry_index: None,
            }),
            ClaudeContentBlockDelta::ThinkingDelta { .. } => Some(Self {
                kind: StreamingContentKind::Thinking,
                buffer: String::new(),
                entry_index: None,
            }),
            _ => None,
        }
    }

    fn apply_content_delta(&mut self, delta: &ClaudeContentBlockDelta) {
        match (self.kind, delta) {
            (StreamingContentKind::Text, ClaudeContentBlockDelta::TextDelta { text }) => {
                self.buffer.push_str(text);
            }
            (
                StreamingContentKind::Thinking,
                ClaudeContentBlockDelta::ThinkingDelta { thinking },
            ) => {
                self.buffer.push_str(thinking);
            }
            _ => {
                warn!(
                    "Mismatched content types: delta {:?}, kind {:?}",
                    delta, self.kind
                );
            }
        }
    }

    fn to_content_item(&self) -> ClaudeContentItem {
        match self.kind {
            StreamingContentKind::Text => ClaudeContentItem::Text {
                text: self.buffer.clone(),
            },
            StreamingContentKind::Thinking => ClaudeContentItem::Thinking {
                thinking: self.buffer.clone(),
            },
        }
    }
}

fn make_path_relative(path: &str, worktree_path: &str) -> String {
    let path_obj = normalize_macos_private_alias(Path::new(path));
    let worktree_obj = normalize_macos_private_alias(Path::new(worktree_path));

    if path_obj.is_relative() {
        return path.to_string();
    }

    if let Ok(relative_path) = path_obj.strip_prefix(&worktree_obj) {
        let result = relative_path.to_string_lossy().to_string();
        return if result.is_empty() {
            ".".to_string()
        } else {
            result
        };
    }

    if !path_obj.exists() || !worktree_obj.exists() {
        return path.to_string();
    }

    let canonical_path = std::fs::canonicalize(&path_obj);
    let canonical_worktree = std::fs::canonicalize(&worktree_obj);

    match (canonical_path, canonical_worktree) {
        (Ok(canon_path), Ok(canon_worktree)) => {
            if let Ok(relative_path) = canon_path.strip_prefix(&canon_worktree) {
                let result = relative_path.to_string_lossy().to_string();
                if result.is_empty() {
                    ".".to_string()
                } else {
                    result
                }
            } else {
                path.to_string()
            }
        }
        _ => path.to_string(),
    }
}

fn normalize_macos_private_alias<P: AsRef<Path>>(p: P) -> PathBuf {
    let path = p.as_ref();
    if cfg!(target_os = "macos") {
        if let Some(s) = path.to_str() {
            if s == "/private/var" {
                return PathBuf::from("/var");
            }
            if let Some(rest) = s.strip_prefix("/private/var/") {
                return PathBuf::from(format!("/var/{rest}"));
            }
            if s == "/private/tmp" {
                return PathBuf::from("/tmp");
            }
            if let Some(rest) = s.strip_prefix("/private/tmp/") {
                return PathBuf::from(format!("/tmp/{rest}"));
            }
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use log_types::extract_normalized_entry_from_patch;

    fn patches_to_entries(patches: &[Patch]) -> Vec<NormalizedEntry> {
        patches
            .iter()
            .filter_map(extract_normalized_entry_from_patch)
            .map(|(_, e)| e)
            .collect()
    }

    #[test]
    fn test_normalize_system_init() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson =
            serde_json::from_str(r#"{"type":"system","subtype":"init","session_id":"abc123"}"#)
                .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        assert!(patches.is_empty());
    }

    #[test]
    fn test_normalize_system_status_is_suppressed() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson =
            serde_json::from_str(r#"{"type":"system","subtype":"status","session_id":"abc123"}"#)
                .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        assert!(
            patches.is_empty(),
            "System: status should be suppressed, got {patches:?}"
        );
    }

    #[test]
    fn test_normalize_system_unknown_subtype_is_suppressed() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson = serde_json::from_str(
            r#"{"type":"system","subtype":"permissions","session_id":"abc123"}"#,
        )
        .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        assert!(
            patches.is_empty(),
            "system subtypes carry no user-facing content, got {patches:?}"
        );
    }

    #[test]
    fn test_normalize_system_thinking_tokens_is_suppressed() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson = serde_json::from_str(
            r#"{"type":"system","subtype":"thinking_tokens","session_id":"abc123"}"#,
        )
        .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        assert!(
            patches.is_empty(),
            "System: thinking_tokens must never reach the UI, got {patches:?}"
        );
    }

    #[test]
    fn test_normalize_system_api_key_source_emits_billing_warning() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson = serde_json::from_str(
            r#"{"type":"system","subtype":"init","session_id":"abc123","apiKeySource":"ANTHROPIC_API_KEY"}"#,
        )
        .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        let entries = patches_to_entries(&patches);
        assert_eq!(entries.len(), 1);
        assert!(matches!(
            entries[0].entry_type,
            NormalizedEntryType::ErrorMessage { .. }
        ));
        assert!(entries[0].content.contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn test_normalize_log_entries_suppresses_system_status_stderr() {
        let logs = vec![LogEntry::Stdout("System: status\n".to_string())];
        let out = ClaudeLogProcessor::normalize_log_entries(&logs, "/tmp");
        let json_patches: Vec<_> = out
            .iter()
            .filter(|e| matches!(e, LogEntry::JsonPatch(_)))
            .collect();
        assert!(
            json_patches.is_empty(),
            "non-JSON 'System: status' stderr must not emit a SystemMessage patch"
        );
    }

    #[test]
    fn test_normalize_assistant_text() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson = serde_json::from_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}"#,
        )
        .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        let entries = patches_to_entries(&patches);
        assert_eq!(entries.len(), 1);
        assert!(matches!(
            entries[0].entry_type,
            NormalizedEntryType::AssistantMessage
        ));
        assert_eq!(entries[0].content, "Hello!");
    }

    #[test]
    fn test_normalize_rate_limit_event_is_silent() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson = serde_json::from_str(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"abc123","uuid":"u1"}"#,
        )
        .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        assert!(patches.is_empty());
    }

    #[test]
    fn test_normalize_tool_use() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson = serde_json::from_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]}}"#,
        )
        .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        let entries = patches_to_entries(&patches);
        assert_eq!(entries.len(), 1);
        if let NormalizedEntryType::ToolUse {
            tool_name, status, ..
        } = &entries[0].entry_type
        {
            assert_eq!(tool_name, "Bash");
            assert!(matches!(status, ToolStatus::Created));
        } else {
            panic!("Expected ToolUse entry type");
        }
    }

    #[test]
    fn test_read_tool_result_keeps_concise_path() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let assistant_json: ClaudeJson = serde_json::from_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"/tmp/project/huge.pdf"}}]}}"#,
        )
        .unwrap();

        let initial_patches =
            processor.normalize_entries(&assistant_json, "/tmp/project", &provider);
        let initial_entries = patches_to_entries(&initial_patches);
        assert_eq!(initial_entries.len(), 1);
        assert_eq!(initial_entries[0].content, "`huge.pdf`");

        let tool_result_json: ClaudeJson = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-1","content":"very large pdf contents","is_error":false}]}}"#,
        )
        .unwrap();

        let result_patches =
            processor.normalize_entries(&tool_result_json, "/tmp/project", &provider);
        let result_entries = patches_to_entries(&result_patches);
        assert_eq!(result_entries.len(), 1);
        assert_eq!(result_entries[0].content, "`huge.pdf`");
        assert!(
            !result_entries[0]
                .content
                .contains("very large pdf contents")
        );
        assert!(matches!(
            result_entries[0].entry_type,
            NormalizedEntryType::ToolUse {
                status: ToolStatus::Success,
                ..
            }
        ));
    }

    #[test]
    fn test_normalize_thinking() {
        let mut processor = ClaudeLogProcessor::new();
        let provider = EntryIndexProvider::new();
        let json: ClaudeJson = serde_json::from_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me think..."}]}}"#,
        )
        .unwrap();
        let patches = processor.normalize_entries(&json, "/tmp", &provider);
        let entries = patches_to_entries(&patches);
        assert_eq!(entries.len(), 1);
        assert!(matches!(
            entries[0].entry_type,
            NormalizedEntryType::Thinking
        ));
        assert_eq!(entries[0].content, "Let me think...");
    }

    #[test]
    fn test_format_model_display_name() {
        assert_eq!(
            format_model_display_name("claude-opus-4-5-20251101"),
            "Opus 4.5"
        );
        assert_eq!(
            format_model_display_name("claude-sonnet-4-5-20251101"),
            "Sonnet 4.5"
        );

        assert_eq!(
            format_model_display_name("claude-3-5-sonnet-20241022"),
            "Sonnet 3.5"
        );
        assert_eq!(
            format_model_display_name("claude-3-5-haiku-20241022"),
            "Haiku 3.5"
        );

        assert_eq!(
            format_model_display_name("claude-3-opus-20240229"),
            "Opus 3"
        );
        assert_eq!(
            format_model_display_name("claude-3-sonnet-20240229"),
            "Sonnet 3"
        );

        assert_eq!(format_model_display_name("gpt-4-turbo"), "gpt-4-turbo");
    }
}
