//! Log normalization for Codex protocol events.
//!
//! This module converts Codex protocol events from the JSON-RPC stream into
//! normalized log entries that can be displayed in the UI.

use std::{collections::HashMap, path::Path, sync::Arc};

use approvals::ApprovalStatus;
use codex_app_server_protocol::{
    CommandExecutionStatus as AppCommandExecutionStatus, JSONRPCNotification, JSONRPCResponse,
    McpToolCallStatus as AppMcpToolCallStatus, ServerNotification, ThreadForkResponse,
    ThreadItem as AppThreadItem, ThreadStartResponse,
};
use codex_protocol::{
    openai_models::ReasoningEffort,
    protocol::{
        AgentMessageDeltaEvent, AgentMessageEvent, AgentReasoningDeltaEvent, AgentReasoningEvent,
        AgentReasoningRawContentDeltaEvent, AgentReasoningRawContentEvent,
        AgentReasoningSectionBreakEvent, BackgroundEventEvent, ErrorEvent, EventMsg,
        ExecCommandBeginEvent, ExecCommandEndEvent, ExecCommandOutputDeltaEvent, ExecOutputStream,
        McpInvocation, McpToolCallBeginEvent, McpToolCallEndEvent, StreamErrorEvent, WarningEvent,
        WebSearchBeginEvent, WebSearchEndEvent,
    },
};
use events::MsgStore;
use futures::StreamExt;
use lazy_static::lazy_static;
use log_types::{
    ActionType, CommandExitStatus, CommandRunResult, ConversationPatch, EntryIndexProvider,
    NormalizedEntry, NormalizedEntryError, NormalizedEntryType, ToolResult, ToolResultValueType,
    ToolStatus,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

trait ToNormalizedEntry {
    fn to_normalized_entry(&self) -> NormalizedEntry;
}

trait ToNormalizedEntryOpt {
    fn to_normalized_entry_opt(&self) -> Option<NormalizedEntry>;
}

#[derive(Debug, Deserialize)]
struct CodexNotificationParams {
    #[serde(rename = "msg")]
    msg: EventMsg,
}

#[derive(Default)]
struct StreamingText {
    content: String,
    /// Entry index for streaming updates (add on first, replace on subsequent)
    entry_index: Option<usize>,
}

#[derive(Default)]
struct CommandState {
    command: String,
    stdout: String,
    stderr: String,
    formatted_output: Option<String>,
    status: ToolStatus,
    exit_code: Option<i32>,
    #[allow(dead_code)]
    call_id: String,
}

impl ToNormalizedEntry for CommandState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        let content = format!("`{}`", self.command);

        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "bash".to_string(),
                action_type: ActionType::CommandRun {
                    command: self.command.clone(),
                    result: Some(CommandRunResult {
                        exit_status: self
                            .exit_code
                            .map(|code| CommandExitStatus::ExitCode { code }),
                        output: if self.formatted_output.is_some() {
                            self.formatted_output.clone()
                        } else {
                            build_command_output(Some(&self.stdout), Some(&self.stderr))
                        },
                    }),
                },
                status: self.status.clone(),
            },
            content,
            metadata: None,
        }
    }
}

struct McpToolState {
    invocation: McpInvocation,
    result: Option<ToolResult>,
    status: ToolStatus,
}

impl ToNormalizedEntry for McpToolState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        let tool_name = format!("mcp:{}:{}", self.invocation.server, self.invocation.tool);
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: tool_name.clone(),
                action_type: ActionType::Tool {
                    tool_name,
                    arguments: self.invocation.arguments.clone(),
                    result: self.result.clone(),
                },
                status: self.status.clone(),
            },
            content: self.invocation.tool.clone(),
            metadata: None,
        }
    }
}

#[derive(Default)]
struct WebSearchState {
    query: Option<String>,
    status: ToolStatus,
}

impl WebSearchState {
    fn new() -> Self {
        Default::default()
    }
}

impl ToNormalizedEntry for WebSearchState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "web_search".to_string(),
                action_type: ActionType::WebFetch {
                    url: self.query.clone().unwrap_or_else(|| "...".to_string()),
                },
                status: self.status.clone(),
            },
            content: self
                .query
                .clone()
                .unwrap_or_else(|| "Web search".to_string()),
            metadata: None,
        }
    }
}

struct LogState {
    assistant: Option<StreamingText>,
    thinking: Option<StreamingText>,
    commands: HashMap<String, CommandState>,
    mcp_tools: HashMap<String, McpToolState>,
    web_searches: HashMap<String, WebSearchState>,
}

enum StreamingTextKind {
    Assistant,
    Thinking,
}

enum UpdateMode {
    Append,
    Set,
}

impl LogState {
    fn new() -> Self {
        Self {
            assistant: None,
            thinking: None,
            commands: HashMap::new(),
            mcp_tools: HashMap::new(),
            web_searches: HashMap::new(),
        }
    }

    /// Returns (entry, is_new) where is_new indicates if this is a new entry (use add) or existing (use replace)
    fn streaming_text_update(
        &mut self,
        content: String,
        type_: StreamingTextKind,
        mode: UpdateMode,
        entry_index_provider: &EntryIndexProvider,
    ) -> (NormalizedEntry, bool) {
        let entry = match type_ {
            StreamingTextKind::Assistant => &mut self.assistant,
            StreamingTextKind::Thinking => &mut self.thinking,
        };

        let is_new = entry.is_none();
        let content_str = if is_new {
            let idx = entry_index_provider.next();
            *entry = Some(StreamingText {
                content,
                entry_index: Some(idx),
            });
            &entry.as_ref().unwrap().content
        } else {
            let streaming_state = entry.as_mut().unwrap();
            match mode {
                UpdateMode::Append => streaming_state.content.push_str(&content),
                UpdateMode::Set => streaming_state.content = content,
            }
            if streaming_state.entry_index.is_none() {
                streaming_state.entry_index = Some(entry_index_provider.next());
            }
            &streaming_state.content
        };

        let normalized = NormalizedEntry {
            timestamp: None,
            entry_type: match type_ {
                StreamingTextKind::Assistant => NormalizedEntryType::AssistantMessage,
                StreamingTextKind::Thinking => NormalizedEntryType::Thinking,
            },
            content: content_str.clone(),
            metadata: None,
        };

        (normalized, is_new)
    }

    /// Get the current entry index for assistant streaming text
    fn assistant_entry_index(&self) -> Option<usize> {
        self.assistant.as_ref().and_then(|s| s.entry_index)
    }

    /// Get the current entry index for thinking streaming text
    fn thinking_entry_index(&self) -> Option<usize> {
        self.thinking.as_ref().and_then(|s| s.entry_index)
    }

    fn assistant_message_append(
        &mut self,
        content: String,
        entry_index_provider: &EntryIndexProvider,
    ) -> (NormalizedEntry, bool) {
        self.streaming_text_update(
            content,
            StreamingTextKind::Assistant,
            UpdateMode::Append,
            entry_index_provider,
        )
    }

    fn thinking_append(
        &mut self,
        content: String,
        entry_index_provider: &EntryIndexProvider,
    ) -> (NormalizedEntry, bool) {
        self.streaming_text_update(
            content,
            StreamingTextKind::Thinking,
            UpdateMode::Append,
            entry_index_provider,
        )
    }

    fn assistant_message(
        &mut self,
        content: String,
        entry_index_provider: &EntryIndexProvider,
    ) -> (NormalizedEntry, bool) {
        self.streaming_text_update(
            content,
            StreamingTextKind::Assistant,
            UpdateMode::Set,
            entry_index_provider,
        )
    }

    fn thinking(
        &mut self,
        content: String,
        entry_index_provider: &EntryIndexProvider,
    ) -> (NormalizedEntry, bool) {
        self.streaming_text_update(
            content,
            StreamingTextKind::Thinking,
            UpdateMode::Set,
            entry_index_provider,
        )
    }
}

/// Synchronously replay persisted log entries into normalized `LogEntry::JsonPatch` entries.
/// Used for history replay after server restart (no live MsgStore / tokio runtime needed).
pub fn replay_log_entries(
    entries: &[log_types::LogEntry],
    _worktree_path: &Path,
) -> Vec<log_types::LogEntry> {
    let entry_index = EntryIndexProvider::new();
    let mut state = LogState::new();
    let mut result: Vec<log_types::LogEntry> = Vec::new();

    for entry in entries {
        let line = match entry {
            log_types::LogEntry::Stdout(s) => s.clone(),
            log_types::LogEntry::UserPrompt(prompt) => {
                let idx = entry_index.next();
                let normalized = NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::UserMessage,
                    content: prompt.clone(),
                    metadata: None,
                };
                let patch = ConversationPatch::add_normalized_entry(idx, normalized);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                continue;
            }
            log_types::LogEntry::Finished => {
                result.push(log_types::LogEntry::Finished);
                break;
            }
            _ => continue,
        };

        // Try parsing error, approval, jsonrpc response, server notification, and codex events
        // in the same order as the async version.
        if let Ok(error) = serde_json::from_str::<Error>(&line) {
            let idx = entry_index.next();
            let patch = ConversationPatch::add_normalized_entry(idx, error.to_normalized_entry());
            let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
            result.push(log_types::LogEntry::JsonPatch(json_value));
            continue;
        }

        if let Ok(approval) = serde_json::from_str::<Approval>(&line) {
            if let Some(pending_entry) = approval.to_pending_tool_entry_opt() {
                let idx = entry_index.next();
                let patch = ConversationPatch::add_normalized_entry(idx, pending_entry);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
            }
            if let Some(normalized) = approval.to_normalized_entry_opt() {
                let idx = entry_index.next();
                let patch = ConversationPatch::add_normalized_entry(idx, normalized);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
            }
            continue;
        }

        if serde_json::from_str::<JSONRPCResponse>(&line).is_ok() {
            // Model info is handled by the live normalizer; skip here for replay.
            continue;
        }

        if let Ok(server_notification) = serde_json::from_str::<ServerNotification>(&line) {
            for patch in
                direct_server_notification_patches(server_notification, &mut state, &entry_index)
            {
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
            }
            continue;
        }

        let notification: JSONRPCNotification = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if !notification.method.starts_with("codex/event") {
            continue;
        }

        let Some(params) = notification
            .params
            .and_then(|p| serde_json::from_value::<CodexNotificationParams>(p).ok())
        else {
            continue;
        };

        let event = params.msg;
        let maybe_entry: Option<NormalizedEntry> = match event {
            EventMsg::SessionConfigured(payload) => {
                let content = format!("Run with {}", payload.model);
                Some(NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content,
                    metadata: None,
                })
            }
            EventMsg::AgentMessageDelta(AgentMessageDeltaEvent { delta }) => {
                state.thinking = None;
                let (entry, is_new) = state.assistant_message_append(delta, &entry_index);
                let idx = state.assistant_entry_index().unwrap_or(0);
                let patch = if is_new {
                    ConversationPatch::add_normalized_entry(idx, entry)
                } else {
                    ConversationPatch::replace(idx, entry)
                };
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                None
            }
            EventMsg::AgentReasoningDelta(AgentReasoningDeltaEvent { delta }) => {
                state.assistant = None;
                let (entry, is_new) = state.thinking_append(delta, &entry_index);
                let idx = state.thinking_entry_index().unwrap_or(0);
                let patch = if is_new {
                    ConversationPatch::add_normalized_entry(idx, entry)
                } else {
                    ConversationPatch::replace(idx, entry)
                };
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                None
            }
            EventMsg::AgentMessage(AgentMessageEvent { message, .. }) => {
                state.thinking = None;
                let (entry, is_new) = state.assistant_message(message, &entry_index);
                let idx = state.assistant_entry_index().unwrap_or(0);
                let patch = if is_new {
                    ConversationPatch::add_normalized_entry(idx, entry)
                } else {
                    ConversationPatch::replace(idx, entry)
                };
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                state.assistant = None;
                None
            }
            EventMsg::AgentReasoning(AgentReasoningEvent { text }) => {
                state.assistant = None;
                let (entry, is_new) = state.thinking(text, &entry_index);
                let idx = state.thinking_entry_index().unwrap_or(0);
                let patch = if is_new {
                    ConversationPatch::add_normalized_entry(idx, entry)
                } else {
                    ConversationPatch::replace(idx, entry)
                };
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                state.thinking = None;
                None
            }
            EventMsg::AgentReasoningRawContent(AgentReasoningRawContentEvent { text }) => {
                state.assistant = None;
                let (entry, is_new) = state.thinking(text, &entry_index);
                let idx = state.thinking_entry_index().unwrap_or(0);
                let patch = if is_new {
                    ConversationPatch::add_normalized_entry(idx, entry)
                } else {
                    ConversationPatch::replace(idx, entry)
                };
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                state.thinking = None;
                None
            }
            EventMsg::AgentReasoningSectionBreak(_) => {
                state.assistant = None;
                state.thinking = None;
                None
            }
            EventMsg::AgentMessageContentDelta(event) => {
                state.thinking = None;
                let (entry, is_new) = state.assistant_message_append(event.delta, &entry_index);
                let idx = state.assistant_entry_index().unwrap_or(0);
                let patch = streaming_entry_patch(entry, idx, is_new);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                None
            }
            EventMsg::ReasoningContentDelta(event) => {
                state.assistant = None;
                let (entry, is_new) = state.thinking_append(event.delta, &entry_index);
                let idx = state.thinking_entry_index().unwrap_or(0);
                let patch = streaming_entry_patch(entry, idx, is_new);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                None
            }
            EventMsg::AgentReasoningRawContentDelta(AgentReasoningRawContentDeltaEvent {
                delta,
            }) => {
                state.assistant = None;
                let (entry, is_new) = state.thinking_append(delta, &entry_index);
                let idx = state.thinking_entry_index().unwrap_or(0);
                let patch = streaming_entry_patch(entry, idx, is_new);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                None
            }
            EventMsg::ReasoningRawContentDelta(event) => {
                state.assistant = None;
                let (entry, is_new) = state.thinking_append(event.delta, &entry_index);
                let idx = state.thinking_entry_index().unwrap_or(0);
                let patch = streaming_entry_patch(entry, idx, is_new);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                None
            }
            EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                call_id, command, ..
            }) => {
                state.assistant = None;
                state.thinking = None;
                let command_text = command.join(" ");
                if command_text.is_empty() {
                    continue;
                }
                state.commands.insert(
                    call_id.clone(),
                    CommandState {
                        command: command_text,
                        stdout: String::new(),
                        stderr: String::new(),
                        formatted_output: None,
                        status: ToolStatus::Created,
                        exit_code: None,
                        call_id: call_id.clone(),
                    },
                );
                Some(state.commands.get(&call_id).unwrap().to_normalized_entry())
            }
            EventMsg::ExecCommandOutputDelta(ExecCommandOutputDeltaEvent {
                call_id,
                stream,
                chunk,
            }) => {
                if let Some(command_state) = state.commands.get_mut(&call_id) {
                    let chunk = String::from_utf8_lossy(&chunk);
                    if chunk.is_empty() {
                        continue;
                    }
                    match stream {
                        ExecOutputStream::Stdout => command_state.stdout.push_str(&chunk),
                        ExecOutputStream::Stderr => command_state.stderr.push_str(&chunk),
                    }
                    Some(command_state.to_normalized_entry())
                } else {
                    None
                }
            }
            EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                call_id,
                exit_code,
                formatted_output,
                ..
            }) => {
                if let Some(mut command_state) = state.commands.remove(&call_id) {
                    command_state.formatted_output = Some(formatted_output);
                    command_state.exit_code = Some(exit_code);
                    command_state.status = if exit_code == 0 {
                        ToolStatus::Success
                    } else {
                        ToolStatus::Failed
                    };
                    Some(command_state.to_normalized_entry())
                } else {
                    None
                }
            }
            EventMsg::BackgroundEvent(BackgroundEventEvent { message }) => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::SystemMessage,
                content: format!("Background event: {message}"),
                metadata: None,
            }),
            EventMsg::StreamError(StreamErrorEvent { message, .. }) => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: format!("Stream error: {message}"),
                metadata: None,
            }),
            EventMsg::McpToolCallBegin(McpToolCallBeginEvent {
                call_id,
                invocation,
                ..
            }) => {
                state.assistant = None;
                state.thinking = None;
                state.mcp_tools.insert(
                    call_id.clone(),
                    McpToolState {
                        invocation,
                        result: None,
                        status: ToolStatus::Created,
                    },
                );
                Some(state.mcp_tools.get(&call_id).unwrap().to_normalized_entry())
            }
            EventMsg::McpToolCallEnd(McpToolCallEndEvent {
                call_id,
                result: mcp_result,
                ..
            }) => {
                if let Some(mut mcp_tool_state) = state.mcp_tools.remove(&call_id) {
                    match mcp_result {
                        Ok(value) => {
                            mcp_tool_state.status = if value.is_error.unwrap_or(false) {
                                ToolStatus::Failed
                            } else {
                                ToolStatus::Success
                            };
                            let all_text = value.content.iter().all(|block| {
                                block.get("type").and_then(|t| t.as_str()) == Some("text")
                            });
                            if all_text {
                                mcp_tool_state.result = Some(ToolResult {
                                    result_type: ToolResultValueType::Markdown,
                                    value: serde_json::Value::String(
                                        value
                                            .content
                                            .iter()
                                            .filter_map(|block| {
                                                block
                                                    .get("text")
                                                    .and_then(|t| t.as_str())
                                                    .map(String::from)
                                            })
                                            .collect::<Vec<String>>()
                                            .join("\n"),
                                    ),
                                });
                            } else {
                                mcp_tool_state.result = Some(ToolResult {
                                    result_type: ToolResultValueType::Json,
                                    value: value
                                        .structured_content
                                        .unwrap_or_else(|| serde_json::Value::Array(value.content)),
                                });
                            }
                        }
                        Err(err) => {
                            mcp_tool_state.status = ToolStatus::Failed;
                            mcp_tool_state.result = Some(ToolResult {
                                result_type: ToolResultValueType::Markdown,
                                value: serde_json::Value::String(err),
                            });
                        }
                    }
                    Some(mcp_tool_state.to_normalized_entry())
                } else {
                    None
                }
            }
            EventMsg::WebSearchBegin(WebSearchBeginEvent { call_id }) => {
                state.assistant = None;
                state.thinking = None;
                state
                    .web_searches
                    .insert(call_id.clone(), WebSearchState::new());
                Some(
                    state
                        .web_searches
                        .get(&call_id)
                        .unwrap()
                        .to_normalized_entry(),
                )
            }
            EventMsg::WebSearchEnd(WebSearchEndEvent { call_id, query, .. }) => {
                state.assistant = None;
                state.thinking = None;
                if let Some(mut entry) = state.web_searches.remove(&call_id) {
                    entry.status = ToolStatus::Success;
                    entry.query = Some(query);
                    Some(entry.to_normalized_entry())
                } else {
                    None
                }
            }
            EventMsg::Error(ErrorEvent { message, .. }) => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: message,
                metadata: None,
            }),
            EventMsg::Warning(WarningEvent { message }) => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: message,
                metadata: None,
            }),
            EventMsg::ContextCompacted(..) => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::SystemMessage,
                content: "Context compacted".to_string(),
                metadata: None,
            }),
            _ => None,
        };

        if let Some(normalized) = maybe_entry {
            let idx = entry_index.next();
            let patch = ConversationPatch::add_normalized_entry(idx, normalized);
            let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
            result.push(log_types::LogEntry::JsonPatch(json_value));
        }
    }

    result
}

pub fn normalize_logs(msg_store: Arc<MsgStore>, _worktree_path: &Path) {
    let history = msg_store.history();
    let entry_index = EntryIndexProvider::start_from_history(&history);
    tokio::spawn(async move {
        let mut state = LogState::new();
        let mut stdout_lines = msg_store.history_plus_stream();

        while let Some(entry) = stdout_lines.next().await {
            let line = match &entry {
                log_types::LogEntry::Stdout(s) => s.clone(),
                log_types::LogEntry::UserPrompt(prompt) => {
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::UserMessage,
                            content: prompt.clone(),
                            metadata: None,
                        },
                    );
                    continue;
                }
                _ => continue,
            };

            if let Ok(error) = serde_json::from_str::<Error>(&line) {
                push_normalized_entry(&msg_store, &entry_index, error.to_normalized_entry());
                continue;
            }

            if let Ok(approval) = serde_json::from_str::<Approval>(&line) {
                if let Some(entry) = approval.to_pending_tool_entry_opt() {
                    push_normalized_entry(&msg_store, &entry_index, entry);
                }
                if let Some(entry) = approval.to_normalized_entry_opt() {
                    push_normalized_entry(&msg_store, &entry_index, entry);
                }
                continue;
            }

            if let Ok(response) = serde_json::from_str::<JSONRPCResponse>(&line) {
                handle_jsonrpc_response(response, &msg_store, &entry_index);
                continue;
            }

            if let Ok(server_notification) = serde_json::from_str::<ServerNotification>(&line) {
                handle_server_notification(
                    server_notification,
                    &mut state,
                    &msg_store,
                    &entry_index,
                );
                continue;
            } else if let Some(session_id) = line
                .strip_prefix(r#"{"method":"sessionConfigured","params":{"sessionId":""#)
                .and_then(|suffix| SESSION_ID.captures(suffix).and_then(|caps| caps.get(1)))
            {
                msg_store.push_session_id(session_id.as_str().to_string());
                continue;
            }

            let notification: JSONRPCNotification = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };

            if !notification.method.starts_with("codex/event") {
                continue;
            }

            let Some(params) = notification
                .params
                .and_then(|p| serde_json::from_value::<CodexNotificationParams>(p).ok())
            else {
                continue;
            };

            let event = params.msg;
            match event {
                EventMsg::SessionConfigured(payload) => {
                    msg_store.push_session_id(payload.session_id.to_string());
                    handle_model_params(
                        payload.model,
                        payload.reasoning_effort,
                        &msg_store,
                        &entry_index,
                    );
                }
                EventMsg::AgentMessageDelta(AgentMessageDeltaEvent { delta }) => {
                    state.thinking = None;
                    let (entry, is_new) = state.assistant_message_append(delta, &entry_index);
                    let idx = state.assistant_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                }
                EventMsg::AgentReasoningDelta(AgentReasoningDeltaEvent { delta }) => {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking_append(delta, &entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                }
                EventMsg::AgentMessage(AgentMessageEvent { message, .. }) => {
                    state.thinking = None;
                    let (entry, is_new) = state.assistant_message(message, &entry_index);
                    let idx = state.assistant_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                    state.assistant = None;
                }
                EventMsg::AgentReasoning(AgentReasoningEvent { text }) => {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking(text, &entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                    state.thinking = None;
                }
                EventMsg::AgentReasoningRawContent(AgentReasoningRawContentEvent { text }) => {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking(text, &entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                    state.thinking = None;
                }
                EventMsg::AgentReasoningSectionBreak(AgentReasoningSectionBreakEvent {
                    item_id: _,
                    summary_index: _,
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                }
                EventMsg::AgentMessageContentDelta(event) => {
                    state.thinking = None;
                    let (entry, is_new) = state.assistant_message_append(event.delta, &entry_index);
                    let idx = state.assistant_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                }
                EventMsg::ReasoningContentDelta(event) => {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking_append(event.delta, &entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                }
                EventMsg::AgentReasoningRawContentDelta(AgentReasoningRawContentDeltaEvent {
                    delta,
                }) => {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking_append(delta, &entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                }
                EventMsg::ReasoningRawContentDelta(event) => {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking_append(event.delta, &entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    push_streaming_entry(&msg_store, entry, idx, is_new);
                }
                EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                    call_id, command, ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                    let command_text = command.join(" ");
                    if command_text.is_empty() {
                        continue;
                    }
                    state.commands.insert(
                        call_id.clone(),
                        CommandState {
                            command: command_text,
                            stdout: String::new(),
                            stderr: String::new(),
                            formatted_output: None,
                            status: ToolStatus::Created,
                            exit_code: None,
                            call_id: call_id.clone(),
                        },
                    );
                    let command_state = state.commands.get(&call_id).unwrap();
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        command_state.to_normalized_entry(),
                    );
                }
                EventMsg::ExecCommandOutputDelta(ExecCommandOutputDeltaEvent {
                    call_id,
                    stream,
                    chunk,
                }) => {
                    if let Some(command_state) = state.commands.get_mut(&call_id) {
                        let chunk = String::from_utf8_lossy(&chunk);
                        if chunk.is_empty() {
                            continue;
                        }
                        match stream {
                            ExecOutputStream::Stdout => command_state.stdout.push_str(&chunk),
                            ExecOutputStream::Stderr => command_state.stderr.push_str(&chunk),
                        }
                        push_normalized_entry(
                            &msg_store,
                            &entry_index,
                            command_state.to_normalized_entry(),
                        );
                    }
                }
                EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                    call_id,
                    exit_code,
                    formatted_output,
                    ..
                }) => {
                    if let Some(mut command_state) = state.commands.remove(&call_id) {
                        command_state.formatted_output = Some(formatted_output);
                        command_state.exit_code = Some(exit_code);
                        command_state.status = if exit_code == 0 {
                            ToolStatus::Success
                        } else {
                            ToolStatus::Failed
                        };
                        push_normalized_entry(
                            &msg_store,
                            &entry_index,
                            command_state.to_normalized_entry(),
                        );
                    }
                }
                EventMsg::BackgroundEvent(BackgroundEventEvent { message }) => {
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content: format!("Background event: {message}"),
                            metadata: None,
                        },
                    );
                }
                EventMsg::StreamError(StreamErrorEvent { message, .. }) => {
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: format!("Stream error: {message}"),
                            metadata: None,
                        },
                    );
                }
                EventMsg::McpToolCallBegin(McpToolCallBeginEvent {
                    call_id,
                    invocation,
                    ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                    state.mcp_tools.insert(
                        call_id.clone(),
                        McpToolState {
                            invocation,
                            result: None,
                            status: ToolStatus::Created,
                        },
                    );
                    let mcp_tool_state = state.mcp_tools.get(&call_id).unwrap();
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        mcp_tool_state.to_normalized_entry(),
                    );
                }
                EventMsg::McpToolCallEnd(McpToolCallEndEvent {
                    call_id, result, ..
                }) => {
                    if let Some(mut mcp_tool_state) = state.mcp_tools.remove(&call_id) {
                        match result {
                            Ok(value) => {
                                mcp_tool_state.status = if value.is_error.unwrap_or(false) {
                                    ToolStatus::Failed
                                } else {
                                    ToolStatus::Success
                                };
                                let all_text = value.content.iter().all(|block| {
                                    block.get("type").and_then(|t| t.as_str()) == Some("text")
                                });
                                if all_text {
                                    mcp_tool_state.result = Some(ToolResult {
                                        result_type: ToolResultValueType::Markdown,
                                        value: Value::String(
                                            value
                                                .content
                                                .iter()
                                                .filter_map(|block| {
                                                    block
                                                        .get("text")
                                                        .and_then(|t| t.as_str())
                                                        .map(String::from)
                                                })
                                                .collect::<Vec<String>>()
                                                .join("\n"),
                                        ),
                                    });
                                } else {
                                    mcp_tool_state.result = Some(ToolResult {
                                        result_type: ToolResultValueType::Json,
                                        value: value
                                            .structured_content
                                            .unwrap_or_else(|| Value::Array(value.content)),
                                    });
                                }
                            }
                            Err(err) => {
                                mcp_tool_state.status = ToolStatus::Failed;
                                mcp_tool_state.result = Some(ToolResult {
                                    result_type: ToolResultValueType::Markdown,
                                    value: Value::String(err),
                                });
                            }
                        };
                        push_normalized_entry(
                            &msg_store,
                            &entry_index,
                            mcp_tool_state.to_normalized_entry(),
                        );
                    }
                }
                EventMsg::WebSearchBegin(WebSearchBeginEvent { call_id }) => {
                    state.assistant = None;
                    state.thinking = None;
                    state
                        .web_searches
                        .insert(call_id.clone(), WebSearchState::new());
                    let web_search_state = state.web_searches.get(&call_id).unwrap();
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        web_search_state.to_normalized_entry(),
                    );
                }
                EventMsg::WebSearchEnd(WebSearchEndEvent { call_id, query, .. }) => {
                    state.assistant = None;
                    state.thinking = None;
                    if let Some(mut entry) = state.web_searches.remove(&call_id) {
                        entry.status = ToolStatus::Success;
                        entry.query = Some(query);
                        push_normalized_entry(
                            &msg_store,
                            &entry_index,
                            entry.to_normalized_entry(),
                        );
                    }
                }
                EventMsg::Error(ErrorEvent { message, .. }) => {
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: message,
                            metadata: None,
                        },
                    );
                }
                EventMsg::Warning(WarningEvent { message }) => {
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: message,
                            metadata: None,
                        },
                    );
                }
                EventMsg::ContextCompacted(..) => {
                    push_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content: "Context compacted".to_string(),
                            metadata: None,
                        },
                    );
                }
                _ => {}
            }
        }
    });
}

fn push_normalized_entry(
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    entry: NormalizedEntry,
) {
    let idx = entry_index.next();
    let patch = ConversationPatch::add_normalized_entry(idx, entry);
    msg_store.push_patch(patch);
}

fn streaming_entry_patch(
    entry: NormalizedEntry,
    entry_idx: usize,
    is_new: bool,
) -> json_patch::Patch {
    if is_new {
        ConversationPatch::add_normalized_entry(entry_idx, entry)
    } else {
        ConversationPatch::replace(entry_idx, entry)
    }
}

/// Push a streaming text entry (assistant message or thinking) with proper add/replace handling.
/// For streaming text, we need to use add for the first emission and replace for subsequent ones.
fn push_streaming_entry(
    msg_store: &Arc<MsgStore>,
    entry: NormalizedEntry,
    entry_idx: usize,
    is_new: bool,
) {
    msg_store.push_patch(streaming_entry_patch(entry, entry_idx, is_new));
}

fn direct_server_notification_patches(
    notification: ServerNotification,
    state: &mut LogState,
    entry_index: &EntryIndexProvider,
) -> Vec<json_patch::Patch> {
    match notification {
        ServerNotification::AgentMessageDelta(notification) => {
            state.thinking = None;
            let (entry, is_new) = state.assistant_message_append(notification.delta, entry_index);
            let idx = state.assistant_entry_index().unwrap_or(0);
            vec![streaming_entry_patch(entry, idx, is_new)]
        }
        ServerNotification::ReasoningSummaryTextDelta(notification) => {
            state.assistant = None;
            let (entry, is_new) = state.thinking_append(notification.delta, entry_index);
            let idx = state.thinking_entry_index().unwrap_or(0);
            vec![streaming_entry_patch(entry, idx, is_new)]
        }
        ServerNotification::ReasoningTextDelta(notification) => {
            state.assistant = None;
            let (entry, is_new) = state.thinking_append(notification.delta, entry_index);
            let idx = state.thinking_entry_index().unwrap_or(0);
            vec![streaming_entry_patch(entry, idx, is_new)]
        }
        ServerNotification::ReasoningSummaryPartAdded(_) => {
            state.assistant = None;
            state.thinking = None;
            Vec::new()
        }
        ServerNotification::ItemCompleted(notification) => match notification.item {
            AppThreadItem::AgentMessage { text, .. } => {
                state.thinking = None;
                let (entry, is_new) = state.assistant_message(text, entry_index);
                let idx = state.assistant_entry_index().unwrap_or(0);
                state.assistant = None;
                vec![streaming_entry_patch(entry, idx, is_new)]
            }
            AppThreadItem::Reasoning {
                summary, content, ..
            } => {
                let text = if summary.is_empty() {
                    content.join("\n")
                } else {
                    summary.join("\n")
                };
                if text.is_empty() {
                    Vec::new()
                } else {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking(text, entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    state.thinking = None;
                    vec![streaming_entry_patch(entry, idx, is_new)]
                }
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn handle_jsonrpc_response(
    response: JSONRPCResponse,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
) {
    if let Ok(response) = serde_json::from_value::<ThreadStartResponse>(response.result.clone()) {
        msg_store.push_session_id(response.thread.id);
        handle_model_params(
            response.model,
            response.reasoning_effort,
            msg_store,
            entry_index,
        );
        return;
    }

    if let Ok(response) = serde_json::from_value::<ThreadForkResponse>(response.result) {
        msg_store.push_session_id(response.thread.id);
        handle_model_params(
            response.model,
            response.reasoning_effort,
            msg_store,
            entry_index,
        );
    }
}

fn handle_server_notification(
    notification: ServerNotification,
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
) {
    match notification {
        ServerNotification::ThreadStarted(notification) => {
            msg_store.push_session_id(notification.thread.id);
        }
        ServerNotification::AgentMessageDelta(notification) => {
            state.thinking = None;
            let (entry, is_new) = state.assistant_message_append(notification.delta, entry_index);
            let idx = state.assistant_entry_index().unwrap_or(0);
            push_streaming_entry(msg_store, entry, idx, is_new);
        }
        ServerNotification::ReasoningSummaryTextDelta(notification) => {
            state.assistant = None;
            let (entry, is_new) = state.thinking_append(notification.delta, entry_index);
            let idx = state.thinking_entry_index().unwrap_or(0);
            push_streaming_entry(msg_store, entry, idx, is_new);
        }
        ServerNotification::ReasoningTextDelta(notification) => {
            state.assistant = None;
            let (entry, is_new) = state.thinking_append(notification.delta, entry_index);
            let idx = state.thinking_entry_index().unwrap_or(0);
            push_streaming_entry(msg_store, entry, idx, is_new);
        }
        ServerNotification::ReasoningSummaryPartAdded(..) => {
            state.assistant = None;
            state.thinking = None;
        }
        ServerNotification::CommandExecutionOutputDelta(notification) => {
            if let Some(command_state) = state.commands.get_mut(&notification.item_id) {
                command_state.stdout.push_str(&notification.delta);
                push_normalized_entry(msg_store, entry_index, command_state.to_normalized_entry());
            }
        }
        ServerNotification::ItemStarted(notification) => match notification.item {
            AppThreadItem::CommandExecution { id, command, .. } => {
                state.assistant = None;
                state.thinking = None;
                if command.is_empty() {
                    return;
                }
                state.commands.insert(
                    id.clone(),
                    CommandState {
                        command,
                        stdout: String::new(),
                        stderr: String::new(),
                        formatted_output: None,
                        status: ToolStatus::Created,
                        exit_code: None,
                        call_id: id.clone(),
                    },
                );
                let command_state = state.commands.get(&id).unwrap();
                push_normalized_entry(msg_store, entry_index, command_state.to_normalized_entry());
            }
            AppThreadItem::McpToolCall {
                server,
                tool,
                arguments,
                ..
            } => {
                state.assistant = None;
                state.thinking = None;
                push_normalized_entry(
                    msg_store,
                    entry_index,
                    app_mcp_tool_entry(server, tool, arguments, ToolStatus::Created, None, None),
                );
            }
            AppThreadItem::WebSearch { id, .. } => {
                state.assistant = None;
                state.thinking = None;
                state.web_searches.insert(id.clone(), WebSearchState::new());
                let web_search_state = state.web_searches.get(&id).unwrap();
                push_normalized_entry(
                    msg_store,
                    entry_index,
                    web_search_state.to_normalized_entry(),
                );
            }
            _ => {}
        },
        ServerNotification::ItemCompleted(notification) => match notification.item {
            AppThreadItem::AgentMessage { text, .. } => {
                state.thinking = None;
                let (entry, is_new) = state.assistant_message(text, entry_index);
                let idx = state.assistant_entry_index().unwrap_or(0);
                push_streaming_entry(msg_store, entry, idx, is_new);
                state.assistant = None;
            }
            AppThreadItem::Reasoning {
                summary, content, ..
            } => {
                let text = if summary.is_empty() {
                    content.join("\n")
                } else {
                    summary.join("\n")
                };
                if text.is_empty() {
                    return;
                } else {
                    state.assistant = None;
                    let (entry, is_new) = state.thinking(text, entry_index);
                    let idx = state.thinking_entry_index().unwrap_or(0);
                    push_streaming_entry(msg_store, entry, idx, is_new);
                    state.thinking = None;
                }
            }
            AppThreadItem::CommandExecution {
                id,
                command,
                aggregated_output,
                exit_code,
                status,
                ..
            } => {
                let mut command_state = state.commands.remove(&id).unwrap_or(CommandState {
                    command,
                    stdout: String::new(),
                    stderr: String::new(),
                    formatted_output: None,
                    status: ToolStatus::Created,
                    exit_code: None,
                    call_id: id,
                });
                command_state.formatted_output = aggregated_output;
                command_state.exit_code = exit_code;
                command_state.status = app_command_status_to_tool_status(status);
                push_normalized_entry(msg_store, entry_index, command_state.to_normalized_entry());
            }
            AppThreadItem::ContextCompaction { .. } => {
                push_normalized_entry(
                    msg_store,
                    entry_index,
                    NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::SystemMessage,
                        content: "Context compacted".to_string(),
                        metadata: None,
                    },
                );
            }
            AppThreadItem::McpToolCall {
                server,
                tool,
                arguments,
                status,
                result,
                error,
                ..
            } => {
                push_normalized_entry(
                    msg_store,
                    entry_index,
                    app_mcp_tool_entry(
                        server,
                        tool,
                        arguments,
                        app_mcp_status_to_tool_status(status),
                        result,
                        error,
                    ),
                );
            }
            AppThreadItem::WebSearch { id, query, .. } => {
                let mut entry = state
                    .web_searches
                    .remove(&id)
                    .unwrap_or_else(WebSearchState::new);
                entry.status = ToolStatus::Success;
                entry.query = Some(query);
                push_normalized_entry(msg_store, entry_index, entry.to_normalized_entry());
            }
            _ => {}
        },
        ServerNotification::Error(notification) => {
            push_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::ErrorMessage {
                        error_type: NormalizedEntryError::Other,
                    },
                    content: format!("Error: {}", notification.error.message),
                    metadata: None,
                },
            );
        }
        ServerNotification::ContextCompacted(..) => {
            push_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: "Context compacted".to_string(),
                    metadata: None,
                },
            );
        }
        _ => {}
    }
}

fn app_command_status_to_tool_status(status: AppCommandExecutionStatus) -> ToolStatus {
    match status {
        AppCommandExecutionStatus::InProgress => ToolStatus::Created,
        AppCommandExecutionStatus::Completed => ToolStatus::Success,
        AppCommandExecutionStatus::Failed => ToolStatus::Failed,
        AppCommandExecutionStatus::Declined => ToolStatus::Denied { reason: None },
    }
}

fn app_mcp_status_to_tool_status(status: AppMcpToolCallStatus) -> ToolStatus {
    match status {
        AppMcpToolCallStatus::InProgress => ToolStatus::Created,
        AppMcpToolCallStatus::Completed => ToolStatus::Success,
        AppMcpToolCallStatus::Failed => ToolStatus::Failed,
    }
}

fn app_mcp_tool_entry(
    server: String,
    tool: String,
    arguments: Value,
    status: ToolStatus,
    result: Option<Box<codex_app_server_protocol::McpToolCallResult>>,
    error: Option<codex_app_server_protocol::McpToolCallError>,
) -> NormalizedEntry {
    let tool_name = format!("mcp:{server}:{tool}");
    let result = if let Some(error) = error {
        Some(ToolResult {
            result_type: ToolResultValueType::Markdown,
            value: Value::String(error.message),
        })
    } else {
        result.map(|result| app_mcp_result_to_tool_result(*result))
    };

    NormalizedEntry {
        timestamp: None,
        entry_type: NormalizedEntryType::ToolUse {
            tool_name: tool_name.clone(),
            action_type: ActionType::Tool {
                tool_name,
                arguments: Some(arguments),
                result,
            },
            status,
        },
        content: tool,
        metadata: None,
    }
}

fn app_mcp_result_to_tool_result(
    result: codex_app_server_protocol::McpToolCallResult,
) -> ToolResult {
    let all_text = result
        .content
        .iter()
        .all(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"));
    if all_text {
        ToolResult {
            result_type: ToolResultValueType::Markdown,
            value: Value::String(
                result
                    .content
                    .iter()
                    .filter_map(|block| {
                        block.get("text").and_then(|t| t.as_str()).map(String::from)
                    })
                    .collect::<Vec<String>>()
                    .join("\n"),
            ),
        }
    } else {
        ToolResult {
            result_type: ToolResultValueType::Json,
            value: result
                .structured_content
                .unwrap_or_else(|| Value::Array(result.content)),
        }
    }
}

fn handle_model_params(
    model: String,
    reasoning_effort: Option<ReasoningEffort>,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
) {
    let content = if let Some(effort) = reasoning_effort {
        format!("Run with {model} reasoning effort: {effort}")
    } else {
        format!("Run with {model}")
    };

    push_normalized_entry(
        msg_store,
        entry_index,
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::SystemMessage,
            content,
            metadata: None,
        },
    );
}

fn build_command_output(stdout: Option<&str>, stderr: Option<&str>) -> Option<String> {
    let mut sections = Vec::new();
    if let Some(out) = stdout {
        let cleaned = out.trim();
        if !cleaned.is_empty() {
            sections.push(format!("stdout:\n{cleaned}"));
        }
    }
    if let Some(err) = stderr {
        let cleaned = err.trim();
        if !cleaned.is_empty() {
            sections.push(format!("stderr:\n{cleaned}"));
        }
    }

    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n\n"))
    }
}

lazy_static! {
    static ref SESSION_ID: Regex = Regex::new(
        r#"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"#
    )
    .expect("valid regex");
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Error {
    LaunchError { error: String },
    AuthRequired { error: String },
}

impl Error {
    pub fn launch_error(error: String) -> Self {
        Self::LaunchError { error }
    }
    pub fn auth_required(error: String) -> Self {
        Self::AuthRequired { error }
    }

    pub fn raw(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

impl ToNormalizedEntry for Error {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        match self {
            Error::LaunchError { error } => NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: error.clone(),
                metadata: None,
            },
            Error::AuthRequired { error } => NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::SetupRequired,
                },
                content: error.clone(),
                metadata: None,
            },
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Approval {
    ApprovalRequested {
        call_id: String,
        tool_name: String,
        approval_id: String,
        requested_at: String,
        timeout_at: String,
    },
    ApprovalResponse {
        call_id: String,
        tool_name: String,
        approval_status: ApprovalStatus,
    },
}

impl Approval {
    pub fn approval_requested(
        call_id: String,
        tool_name: String,
        approval_id: String,
        requested_at: String,
        timeout_at: String,
    ) -> Self {
        Self::ApprovalRequested {
            call_id,
            tool_name,
            approval_id,
            requested_at,
            timeout_at,
        }
    }

    pub fn approval_response(
        call_id: String,
        tool_name: String,
        approval_status: ApprovalStatus,
    ) -> Self {
        Self::ApprovalResponse {
            call_id,
            tool_name,
            approval_status,
        }
    }

    pub fn raw(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn display_tool_name(&self) -> String {
        let tool_name = match self {
            Self::ApprovalRequested { tool_name, .. }
            | Self::ApprovalResponse { tool_name, .. } => tool_name,
        };
        match tool_name.as_str() {
            "codex.exec_command" => "Exec Command".to_string(),
            "codex.apply_patch" => "Edit".to_string(),
            other => other.to_string(),
        }
    }

    fn normalized_tool_name(&self) -> String {
        let tool_name = match self {
            Self::ApprovalRequested { tool_name, .. }
            | Self::ApprovalResponse { tool_name, .. } => tool_name,
        };
        match tool_name.as_str() {
            "codex.exec_command" => "bash".to_string(),
            "codex.apply_patch" => "edit".to_string(),
            other => other.to_string(),
        }
    }

    fn to_pending_tool_entry_opt(&self) -> Option<NormalizedEntry> {
        let Self::ApprovalRequested {
            approval_id,
            requested_at,
            timeout_at,
            ..
        } = self
        else {
            return None;
        };
        let normalized_tool_name = self.normalized_tool_name();
        let display_tool_name = self.display_tool_name();
        Some(NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: normalized_tool_name.clone(),
                action_type: ActionType::Tool {
                    tool_name: normalized_tool_name,
                    arguments: None,
                    result: None,
                },
                status: ToolStatus::PendingApproval {
                    approval_id: approval_id.clone(),
                    requested_at: requested_at.clone(),
                    timeout_at: timeout_at.clone(),
                },
            },
            content: format!("{display_tool_name} (approval pending)"),
            metadata: None,
        })
    }
}

impl ToNormalizedEntryOpt for Approval {
    fn to_normalized_entry_opt(&self) -> Option<NormalizedEntry> {
        let approval_status = match self {
            Self::ApprovalResponse {
                call_id: _,
                tool_name: _,
                approval_status,
            } => approval_status,
            Self::ApprovalRequested { .. } => return None,
        };
        let tool_name = self.display_tool_name();

        match approval_status {
            ApprovalStatus::Pending => None,
            ApprovalStatus::Approved => None,
            ApprovalStatus::Denied { reason } => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::UserFeedback {
                    denied_tool: tool_name.clone(),
                },
                content: reason
                    .clone()
                    .unwrap_or_else(|| "User denied this tool use request".to_string())
                    .trim()
                    .to_string(),
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
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn replay_stdout(line: &str) -> Vec<log_types::LogEntry> {
        replay_log_entries(
            &[log_types::LogEntry::Stdout(line.to_string())],
            Path::new("."),
        )
    }

    fn first_patch_value(entries: &[log_types::LogEntry]) -> &serde_json::Value {
        entries
            .iter()
            .find_map(|entry| match entry {
                log_types::LogEntry::JsonPatch(value) => Some(value),
                _ => None,
            })
            .expect("expected a json patch")
    }

    #[test]
    fn codex_reasoning_text_delta_replays_as_thinking_entry() {
        let entries = replay_stdout(
            r#"{"method":"item/reasoning/textDelta","params":{"threadId":"thread","turnId":"turn","itemId":"rs1","delta":"raw thinking","contentIndex":0}}"#,
        );
        let patch = first_patch_value(&entries);

        assert_eq!(
            patch.pointer("/0/value/content/type/type"),
            Some(&serde_json::Value::String("thinking".to_string()))
        );
        assert_eq!(
            patch.pointer("/0/value/content/content"),
            Some(&serde_json::Value::String("raw thinking".to_string()))
        );
    }

    #[test]
    fn codex_raw_reasoning_event_replays_as_thinking_entry() {
        let entries = replay_stdout(
            r#"{"method":"codex/event/agent_reasoning_raw_content_delta","params":{"id":"0","msg":{"type":"agent_reasoning_raw_content_delta","delta":"raw event"},"conversationId":"thread"}}"#,
        );
        let patch = first_patch_value(&entries);

        assert_eq!(
            patch.pointer("/0/value/content/type/type"),
            Some(&serde_json::Value::String("thinking".to_string()))
        );
        assert_eq!(
            patch.pointer("/0/value/content/content"),
            Some(&serde_json::Value::String("raw event".to_string()))
        );
    }
}
