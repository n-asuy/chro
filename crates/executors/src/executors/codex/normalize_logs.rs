//! Log normalization for Codex protocol events.
//!
//! This module converts Codex protocol events from the JSON-RPC stream into
//! normalized log entries that can be displayed in the UI.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
};

use approvals::ApprovalStatus;
use codex_app_server_protocol::{
    CommandExecutionStatus as AppCommandExecutionStatus, FileUpdateChange as AppFileUpdateChange,
    JSONRPCNotification, JSONRPCResponse, McpToolCallStatus as AppMcpToolCallStatus,
    PatchApplyStatus as AppPatchApplyStatus, PatchChangeKind as AppPatchChangeKind,
    ServerNotification, ThreadItem as AppThreadItem, ThreadStartResponse,
};
use codex_protocol::{
    openai_models::ReasoningEffort,
    protocol::{
        AgentMessageDeltaEvent, AgentMessageEvent, AgentReasoningDeltaEvent, AgentReasoningEvent,
        AgentReasoningRawContentDeltaEvent, AgentReasoningRawContentEvent,
        AgentReasoningSectionBreakEvent, BackgroundEventEvent, ErrorEvent, EventMsg,
        ExecCommandBeginEvent, ExecCommandEndEvent, ExecCommandOutputDeltaEvent, ExecOutputStream,
        FileChange as CoreFileChange, McpInvocation, McpToolCallBeginEvent, McpToolCallEndEvent,
        PatchApplyBeginEvent, PatchApplyEndEvent, PatchApplyStatus as CorePatchApplyStatus,
        PatchApplyUpdatedEvent, StreamErrorEvent, WarningEvent, WebSearchBeginEvent,
        WebSearchEndEvent,
    },
};
use events::MsgStore;
use futures::StreamExt;
use lazy_static::lazy_static;
use log_types::{
    ActionType, CommandExitStatus, CommandRunResult, ConversationPatch, EntryIndexProvider,
    FileChange as NormalizedFileChange, NormalizedEntry, NormalizedEntryError, NormalizedEntryType,
    ToolResult, ToolResultValueType, ToolStatus,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::CompatibleThreadForkResponse;

trait ToNormalizedEntry {
    fn to_normalized_entry(&self) -> NormalizedEntry;
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

struct CommandState {
    command: String,
    stdout: String,
    stderr: String,
    formatted_output: Option<String>,
    status: ToolStatus,
    exit_code: Option<i32>,
    /// Stable conversation entry updated throughout this command's lifetime.
    entry_index: usize,
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
    entry_index: usize,
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

struct WebSearchState {
    query: Option<String>,
    status: ToolStatus,
    entry_index: usize,
}

impl WebSearchState {
    fn new(entry_index: usize) -> Self {
        Self {
            query: None,
            status: ToolStatus::Created,
            entry_index,
        }
    }
}

struct FileChangeEntryState {
    path: String,
    changes: Vec<NormalizedFileChange>,
    status: ToolStatus,
    entry_index: usize,
}

impl ToNormalizedEntry for FileChangeEntryState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "edit".to_string(),
                action_type: ActionType::FileEdit {
                    path: self.path.clone(),
                    changes: self.changes.clone(),
                },
                status: self.status.clone(),
            },
            content: format!("`{}`", self.path),
            metadata: None,
        }
    }
}

struct PendingApprovalState {
    normalized_tool_name: String,
    display_tool_name: String,
    approval_id: String,
    requested_at: String,
    timeout_at: String,
    entry_index: usize,
}

impl PendingApprovalState {
    fn to_normalized_entry(&self, status: ToolStatus) -> NormalizedEntry {
        let pending = matches!(status, ToolStatus::PendingApproval { .. });
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: self.normalized_tool_name.clone(),
                action_type: ActionType::Tool {
                    tool_name: self.normalized_tool_name.clone(),
                    arguments: None,
                    result: None,
                },
                status,
            },
            content: if pending {
                format!("{} (approval pending)", self.display_tool_name)
            } else {
                self.display_tool_name.clone()
            },
            metadata: None,
        }
    }

    fn pending_entry(&self) -> NormalizedEntry {
        self.to_normalized_entry(ToolStatus::PendingApproval {
            approval_id: self.approval_id.clone(),
            requested_at: self.requested_at.clone(),
            timeout_at: self.timeout_at.clone(),
        })
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
    app_assistant: HashMap<String, StreamingText>,
    app_thinking: HashMap<String, StreamingText>,
    commands: HashMap<String, CommandState>,
    mcp_tools: HashMap<String, McpToolState>,
    web_searches: HashMap<String, WebSearchState>,
    file_changes: HashMap<String, HashMap<String, FileChangeEntryState>>,
    pending_approvals: HashMap<String, PendingApprovalState>,
    finished_tools: HashMap<String, usize>,
}

#[derive(Clone, Copy)]
enum StreamingTextKind {
    Assistant,
    Thinking,
}

#[derive(Clone, Copy)]
enum UpdateMode {
    Append,
    Set,
}

impl LogState {
    fn new() -> Self {
        Self {
            assistant: None,
            thinking: None,
            app_assistant: HashMap::new(),
            app_thinking: HashMap::new(),
            commands: HashMap::new(),
            mcp_tools: HashMap::new(),
            web_searches: HashMap::new(),
            file_changes: HashMap::new(),
            pending_approvals: HashMap::new(),
            finished_tools: HashMap::new(),
        }
    }

    fn tool_entry_index(
        &mut self,
        call_id: &str,
        entry_index_provider: &EntryIndexProvider,
    ) -> (usize, bool) {
        let active_entry_index = self
            .commands
            .get(call_id)
            .map(|tool| tool.entry_index)
            .or_else(|| self.mcp_tools.get(call_id).map(|tool| tool.entry_index))
            .or_else(|| self.web_searches.get(call_id).map(|tool| tool.entry_index))
            .or_else(|| self.finished_tools.get(call_id).copied());
        if let Some(entry_index) = active_entry_index {
            return (entry_index, false);
        }
        match self.pending_approvals.remove(call_id) {
            Some(pending) => (pending.entry_index, false),
            None => (entry_index_provider.next(), true),
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
            for patch in approval_patches(approval, &mut state, &entry_index) {
                result.push(patch_log_entry(patch));
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
                let (command_entry_index, is_new) = state.tool_entry_index(&call_id, &entry_index);
                state.commands.insert(
                    call_id.clone(),
                    CommandState {
                        command: command_text,
                        stdout: String::new(),
                        stderr: String::new(),
                        formatted_output: None,
                        status: ToolStatus::Created,
                        exit_code: None,
                        entry_index: command_entry_index,
                    },
                );
                let command_state = state.commands.get(&call_id).unwrap();
                let patch = command_entry_patch(command_state, is_new);
                let json_value = serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                result.push(log_types::LogEntry::JsonPatch(json_value));
                None
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
                    let patch = command_entry_patch(command_state, false);
                    let json_value =
                        serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                    result.push(log_types::LogEntry::JsonPatch(json_value));
                    None
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
                    let patch = command_entry_patch(&command_state, false);
                    state
                        .finished_tools
                        .insert(call_id, command_state.entry_index);
                    let json_value =
                        serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null);
                    result.push(log_types::LogEntry::JsonPatch(json_value));
                    None
                } else {
                    None
                }
            }
            EventMsg::PatchApplyBegin(PatchApplyBeginEvent {
                call_id, changes, ..
            })
            | EventMsg::PatchApplyUpdated(PatchApplyUpdatedEvent { call_id, changes }) => {
                state.assistant = None;
                state.thinking = None;
                for patch in file_change_patches(
                    call_id,
                    app_file_updates_from_core(changes),
                    ToolStatus::Created,
                    false,
                    &mut state,
                    &entry_index,
                ) {
                    result.push(patch_log_entry(patch));
                }
                None
            }
            EventMsg::PatchApplyEnd(PatchApplyEndEvent {
                call_id,
                changes,
                status,
                ..
            }) => {
                for patch in file_change_patches(
                    call_id,
                    app_file_updates_from_core(changes),
                    core_patch_status_to_tool_status(status),
                    true,
                    &mut state,
                    &entry_index,
                ) {
                    result.push(patch_log_entry(patch));
                }
                None
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
                let (tool_entry_index, is_new) = state.tool_entry_index(&call_id, &entry_index);
                state.mcp_tools.insert(
                    call_id.clone(),
                    McpToolState {
                        invocation,
                        result: None,
                        status: ToolStatus::Created,
                        entry_index: tool_entry_index,
                    },
                );
                let tool_state = state.mcp_tools.get(&call_id).unwrap();
                let patch = streaming_entry_patch(
                    tool_state.to_normalized_entry(),
                    tool_state.entry_index,
                    is_new,
                );
                result.push(patch_log_entry(patch));
                None
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
                    let patch = ConversationPatch::replace(
                        mcp_tool_state.entry_index,
                        mcp_tool_state.to_normalized_entry(),
                    );
                    state
                        .finished_tools
                        .insert(call_id, mcp_tool_state.entry_index);
                    result.push(patch_log_entry(patch));
                    None
                } else {
                    None
                }
            }
            EventMsg::WebSearchBegin(WebSearchBeginEvent { call_id }) => {
                state.assistant = None;
                state.thinking = None;
                let (tool_entry_index, is_new) = state.tool_entry_index(&call_id, &entry_index);
                state
                    .web_searches
                    .insert(call_id.clone(), WebSearchState::new(tool_entry_index));
                let tool_state = state.web_searches.get(&call_id).unwrap();
                let patch = streaming_entry_patch(
                    tool_state.to_normalized_entry(),
                    tool_state.entry_index,
                    is_new,
                );
                result.push(patch_log_entry(patch));
                None
            }
            EventMsg::WebSearchEnd(WebSearchEndEvent { call_id, query, .. }) => {
                state.assistant = None;
                state.thinking = None;
                if let Some(mut entry) = state.web_searches.remove(&call_id) {
                    entry.status = ToolStatus::Success;
                    entry.query = Some(query);
                    let patch =
                        ConversationPatch::replace(entry.entry_index, entry.to_normalized_entry());
                    state.finished_tools.insert(call_id, entry.entry_index);
                    result.push(patch_log_entry(patch));
                    None
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
                for patch in approval_patches(approval, &mut state, &entry_index) {
                    msg_store.push_patch(patch);
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
                    let (command_entry_index, is_new) =
                        state.tool_entry_index(&call_id, &entry_index);
                    state.commands.insert(
                        call_id.clone(),
                        CommandState {
                            command: command_text,
                            stdout: String::new(),
                            stderr: String::new(),
                            formatted_output: None,
                            status: ToolStatus::Created,
                            exit_code: None,
                            entry_index: command_entry_index,
                        },
                    );
                    let command_state = state.commands.get(&call_id).unwrap();
                    push_command_entry(&msg_store, command_state, is_new);
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
                        push_command_entry(&msg_store, command_state, false);
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
                        push_command_entry(&msg_store, &command_state, false);
                        state
                            .finished_tools
                            .insert(call_id, command_state.entry_index);
                    }
                }
                EventMsg::PatchApplyBegin(PatchApplyBeginEvent {
                    call_id, changes, ..
                })
                | EventMsg::PatchApplyUpdated(PatchApplyUpdatedEvent { call_id, changes }) => {
                    state.assistant = None;
                    state.thinking = None;
                    for patch in file_change_patches(
                        call_id,
                        app_file_updates_from_core(changes),
                        ToolStatus::Created,
                        false,
                        &mut state,
                        &entry_index,
                    ) {
                        msg_store.push_patch(patch);
                    }
                }
                EventMsg::PatchApplyEnd(PatchApplyEndEvent {
                    call_id,
                    changes,
                    status,
                    ..
                }) => {
                    for patch in file_change_patches(
                        call_id,
                        app_file_updates_from_core(changes),
                        core_patch_status_to_tool_status(status),
                        true,
                        &mut state,
                        &entry_index,
                    ) {
                        msg_store.push_patch(patch);
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
                    let (tool_entry_index, is_new) = state.tool_entry_index(&call_id, &entry_index);
                    state.mcp_tools.insert(
                        call_id.clone(),
                        McpToolState {
                            invocation,
                            result: None,
                            status: ToolStatus::Created,
                            entry_index: tool_entry_index,
                        },
                    );
                    let mcp_tool_state = state.mcp_tools.get(&call_id).unwrap();
                    msg_store.push_patch(streaming_entry_patch(
                        mcp_tool_state.to_normalized_entry(),
                        mcp_tool_state.entry_index,
                        is_new,
                    ));
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
                        msg_store.push_patch(ConversationPatch::replace(
                            mcp_tool_state.entry_index,
                            mcp_tool_state.to_normalized_entry(),
                        ));
                        state
                            .finished_tools
                            .insert(call_id, mcp_tool_state.entry_index);
                    }
                }
                EventMsg::WebSearchBegin(WebSearchBeginEvent { call_id }) => {
                    state.assistant = None;
                    state.thinking = None;
                    let (tool_entry_index, is_new) = state.tool_entry_index(&call_id, &entry_index);
                    state
                        .web_searches
                        .insert(call_id.clone(), WebSearchState::new(tool_entry_index));
                    let web_search_state = state.web_searches.get(&call_id).unwrap();
                    msg_store.push_patch(streaming_entry_patch(
                        web_search_state.to_normalized_entry(),
                        web_search_state.entry_index,
                        is_new,
                    ));
                }
                EventMsg::WebSearchEnd(WebSearchEndEvent { call_id, query, .. }) => {
                    state.assistant = None;
                    state.thinking = None;
                    if let Some(mut entry) = state.web_searches.remove(&call_id) {
                        entry.status = ToolStatus::Success;
                        entry.query = Some(query);
                        msg_store.push_patch(ConversationPatch::replace(
                            entry.entry_index,
                            entry.to_normalized_entry(),
                        ));
                        state.finished_tools.insert(call_id, entry.entry_index);
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

fn patch_log_entry(patch: json_patch::Patch) -> log_types::LogEntry {
    log_types::LogEntry::JsonPatch(serde_json::to_value(&patch).unwrap_or(serde_json::Value::Null))
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

fn streaming_item_patch(
    items: &mut HashMap<String, StreamingText>,
    item_id: String,
    content: String,
    kind: StreamingTextKind,
    mode: UpdateMode,
    entry_index: &EntryIndexProvider,
) -> json_patch::Patch {
    let is_new = !items.contains_key(&item_id);
    let item = items.entry(item_id).or_insert_with(|| StreamingText {
        content: String::new(),
        entry_index: Some(entry_index.next()),
    });
    match mode {
        UpdateMode::Append => item.content.push_str(&content),
        UpdateMode::Set => item.content = content,
    }
    let entry = NormalizedEntry {
        timestamp: None,
        entry_type: match kind {
            StreamingTextKind::Assistant => NormalizedEntryType::AssistantMessage,
            StreamingTextKind::Thinking => NormalizedEntryType::Thinking,
        },
        content: item.content.clone(),
        metadata: None,
    };
    streaming_entry_patch(entry, item.entry_index.unwrap_or(0), is_new)
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

fn command_entry_patch(command_state: &CommandState, is_new: bool) -> json_patch::Patch {
    streaming_entry_patch(
        command_state.to_normalized_entry(),
        command_state.entry_index,
        is_new,
    )
}

fn push_command_entry(msg_store: &Arc<MsgStore>, command_state: &CommandState, is_new: bool) {
    msg_store.push_patch(command_entry_patch(command_state, is_new));
}

fn app_mcp_tool_state(
    server: String,
    tool: String,
    arguments: Value,
    status: ToolStatus,
    result: Option<Box<codex_app_server_protocol::McpToolCallResult>>,
    error: Option<codex_app_server_protocol::McpToolCallError>,
    entry_index: usize,
) -> McpToolState {
    let result = if let Some(error) = error {
        Some(ToolResult {
            result_type: ToolResultValueType::Markdown,
            value: Value::String(error.message),
        })
    } else {
        result.map(|result| app_mcp_result_to_tool_result(*result))
    };

    McpToolState {
        invocation: McpInvocation {
            server,
            tool,
            arguments: Some(arguments),
        },
        result,
        status,
        entry_index,
    }
}

fn normalized_app_file_changes(update: &AppFileUpdateChange) -> Vec<NormalizedFileChange> {
    match &update.kind {
        AppPatchChangeKind::Add => vec![NormalizedFileChange::Write {
            content: update.diff.clone(),
        }],
        AppPatchChangeKind::Delete => vec![NormalizedFileChange::Delete],
        AppPatchChangeKind::Update { move_path } => {
            let mut changes = Vec::new();
            if !update.diff.trim().is_empty() {
                changes.push(NormalizedFileChange::Edit {
                    unified_diff: update.diff.clone(),
                    has_line_numbers: true,
                });
            }
            if let Some(move_path) = move_path {
                changes.push(NormalizedFileChange::Rename {
                    new_path: move_path.to_string_lossy().into_owned(),
                });
            }
            changes
        }
    }
}

fn app_file_updates_from_core(
    changes: HashMap<std::path::PathBuf, CoreFileChange>,
) -> Vec<AppFileUpdateChange> {
    changes
        .into_iter()
        .map(|(path, change)| {
            let path = path.to_string_lossy().into_owned();
            match change {
                CoreFileChange::Add { content } => AppFileUpdateChange {
                    path,
                    kind: AppPatchChangeKind::Add,
                    diff: content,
                },
                CoreFileChange::Delete { content } => AppFileUpdateChange {
                    path,
                    kind: AppPatchChangeKind::Delete,
                    diff: content,
                },
                CoreFileChange::Update {
                    unified_diff,
                    move_path,
                } => AppFileUpdateChange {
                    path,
                    kind: AppPatchChangeKind::Update { move_path },
                    diff: unified_diff,
                },
            }
        })
        .collect()
}

fn file_change_patches(
    item_id: String,
    mut updates: Vec<AppFileUpdateChange>,
    status: ToolStatus,
    completed: bool,
    state: &mut LogState,
    entry_index: &EntryIndexProvider,
) -> Vec<json_patch::Patch> {
    updates.sort_by(|a, b| a.path.cmp(&b.path));
    let mut files = state.file_changes.remove(&item_id).unwrap_or_default();
    let mut patches = Vec::new();
    let mut updated_paths = HashSet::new();
    let mut pending = if updates.is_empty() {
        None
    } else {
        state.pending_approvals.remove(&item_id)
    };

    for update in updates {
        updated_paths.insert(update.path.clone());
        if let Some(mut file) = files.remove(&update.path) {
            file.changes = normalized_app_file_changes(&update);
            file.status = status.clone();
            patches.push(ConversationPatch::replace(
                file.entry_index,
                file.to_normalized_entry(),
            ));
            files.insert(update.path, file);
            continue;
        }

        let (file_entry_index, is_new) = pending
            .take()
            .map(|pending| (pending.entry_index, false))
            .unwrap_or_else(|| (entry_index.next(), true));
        let file = FileChangeEntryState {
            path: update.path.clone(),
            changes: normalized_app_file_changes(&update),
            status: status.clone(),
            entry_index: file_entry_index,
        };
        patches.push(streaming_entry_patch(
            file.to_normalized_entry(),
            file.entry_index,
            is_new,
        ));
        files.insert(update.path, file);
    }

    if completed {
        for (path, file) in &mut files {
            if updated_paths.contains(path) {
                continue;
            }
            file.status = status.clone();
            patches.push(ConversationPatch::replace(
                file.entry_index,
                file.to_normalized_entry(),
            ));
        }
    }
    state.file_changes.insert(item_id, files);

    patches
}

fn direct_server_notification_patches(
    notification: ServerNotification,
    state: &mut LogState,
    entry_index: &EntryIndexProvider,
) -> Vec<json_patch::Patch> {
    match notification {
        ServerNotification::AgentMessageDelta(notification) => {
            vec![streaming_item_patch(
                &mut state.app_assistant,
                notification.item_id,
                notification.delta,
                StreamingTextKind::Assistant,
                UpdateMode::Append,
                entry_index,
            )]
        }
        ServerNotification::ReasoningSummaryTextDelta(notification) => {
            vec![streaming_item_patch(
                &mut state.app_thinking,
                notification.item_id,
                notification.delta,
                StreamingTextKind::Thinking,
                UpdateMode::Append,
                entry_index,
            )]
        }
        ServerNotification::ReasoningTextDelta(notification) => {
            vec![streaming_item_patch(
                &mut state.app_thinking,
                notification.item_id,
                notification.delta,
                StreamingTextKind::Thinking,
                UpdateMode::Append,
                entry_index,
            )]
        }
        ServerNotification::ReasoningSummaryPartAdded(notification) => {
            state.app_thinking.remove(&notification.item_id);
            Vec::new()
        }
        ServerNotification::CommandExecutionOutputDelta(notification) => {
            if let Some(command_state) = state.commands.get_mut(&notification.item_id) {
                command_state.stdout.push_str(&notification.delta);
                vec![command_entry_patch(command_state, false)]
            } else {
                Vec::new()
            }
        }
        ServerNotification::FileChangePatchUpdated(notification) => file_change_patches(
            notification.item_id,
            notification.changes,
            ToolStatus::Created,
            false,
            state,
            entry_index,
        ),
        ServerNotification::ItemStarted(notification) => match notification.item {
            AppThreadItem::CommandExecution { id, command, .. } => {
                state.assistant = None;
                state.thinking = None;
                if command.is_empty() {
                    Vec::new()
                } else {
                    let (command_entry_index, is_new) = state.tool_entry_index(&id, entry_index);
                    state.commands.insert(
                        id.clone(),
                        CommandState {
                            command,
                            stdout: String::new(),
                            stderr: String::new(),
                            formatted_output: None,
                            status: ToolStatus::Created,
                            exit_code: None,
                            entry_index: command_entry_index,
                        },
                    );
                    vec![command_entry_patch(
                        state.commands.get(&id).unwrap(),
                        is_new,
                    )]
                }
            }
            AppThreadItem::McpToolCall {
                id,
                server,
                tool,
                arguments,
                ..
            } => {
                state.assistant = None;
                state.thinking = None;
                let (tool_entry_index, is_new) = state.tool_entry_index(&id, entry_index);
                let tool_state = app_mcp_tool_state(
                    server,
                    tool,
                    arguments,
                    ToolStatus::Created,
                    None,
                    None,
                    tool_entry_index,
                );
                let patch = streaming_entry_patch(
                    tool_state.to_normalized_entry(),
                    tool_state.entry_index,
                    is_new,
                );
                state.mcp_tools.insert(id, tool_state);
                vec![patch]
            }
            AppThreadItem::WebSearch { id, .. } => {
                state.assistant = None;
                state.thinking = None;
                let (tool_entry_index, is_new) = state.tool_entry_index(&id, entry_index);
                let tool_state = WebSearchState::new(tool_entry_index);
                let patch = streaming_entry_patch(
                    tool_state.to_normalized_entry(),
                    tool_state.entry_index,
                    is_new,
                );
                state.web_searches.insert(id, tool_state);
                vec![patch]
            }
            AppThreadItem::FileChange {
                id,
                changes,
                status,
            } => {
                state.assistant = None;
                state.thinking = None;
                file_change_patches(
                    id,
                    changes,
                    app_patch_status_to_tool_status(status),
                    false,
                    state,
                    entry_index,
                )
            }
            _ => Vec::new(),
        },
        ServerNotification::ItemCompleted(notification) => match notification.item {
            AppThreadItem::AgentMessage { id, text, .. } => {
                let patch = streaming_item_patch(
                    &mut state.app_assistant,
                    id.clone(),
                    text,
                    StreamingTextKind::Assistant,
                    UpdateMode::Set,
                    entry_index,
                );
                state.app_assistant.remove(&id);
                vec![patch]
            }
            AppThreadItem::Reasoning {
                id,
                summary,
                content,
            } => {
                let text = if summary.is_empty() {
                    content.join("\n")
                } else {
                    summary.join("\n")
                };
                if text.is_empty() {
                    Vec::new()
                } else {
                    let patch = streaming_item_patch(
                        &mut state.app_thinking,
                        id.clone(),
                        text,
                        StreamingTextKind::Thinking,
                        UpdateMode::Set,
                        entry_index,
                    );
                    state.app_thinking.remove(&id);
                    vec![patch]
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
                let (mut command_state, is_new) = match state.commands.remove(&id) {
                    Some(command_state) => (command_state, false),
                    None => {
                        let (command_entry_index, is_new) =
                            state.tool_entry_index(&id, entry_index);
                        (
                            CommandState {
                                command,
                                stdout: String::new(),
                                stderr: String::new(),
                                formatted_output: None,
                                status: ToolStatus::Created,
                                exit_code: None,
                                entry_index: command_entry_index,
                            },
                            is_new,
                        )
                    }
                };
                command_state.formatted_output = aggregated_output;
                command_state.exit_code = exit_code;
                command_state.status = app_command_status_to_tool_status(status);
                state.finished_tools.insert(id, command_state.entry_index);
                vec![command_entry_patch(&command_state, is_new)]
            }
            AppThreadItem::McpToolCall {
                id,
                server,
                tool,
                arguments,
                status,
                result,
                error,
                ..
            } => {
                let (tool_entry_index, is_new) = match state.mcp_tools.remove(&id) {
                    Some(tool_state) => (tool_state.entry_index, false),
                    None => state.tool_entry_index(&id, entry_index),
                };
                let tool_state = app_mcp_tool_state(
                    server,
                    tool,
                    arguments,
                    app_mcp_status_to_tool_status(status),
                    result,
                    error,
                    tool_entry_index,
                );
                state.finished_tools.insert(id, tool_state.entry_index);
                vec![streaming_entry_patch(
                    tool_state.to_normalized_entry(),
                    tool_state.entry_index,
                    is_new,
                )]
            }
            AppThreadItem::WebSearch { id, query, .. } => {
                let (mut tool_state, is_new) = match state.web_searches.remove(&id) {
                    Some(tool_state) => (tool_state, false),
                    None => {
                        let (tool_entry_index, is_new) = state.tool_entry_index(&id, entry_index);
                        (WebSearchState::new(tool_entry_index), is_new)
                    }
                };
                tool_state.status = ToolStatus::Success;
                tool_state.query = Some(query);
                state.finished_tools.insert(id, tool_state.entry_index);
                vec![streaming_entry_patch(
                    tool_state.to_normalized_entry(),
                    tool_state.entry_index,
                    is_new,
                )]
            }
            AppThreadItem::FileChange {
                id,
                changes,
                status,
            } => file_change_patches(
                id,
                changes,
                app_patch_status_to_tool_status(status),
                true,
                state,
                entry_index,
            ),
            AppThreadItem::ContextCompaction { .. } => {
                vec![ConversationPatch::add_normalized_entry(
                    entry_index.next(),
                    NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::SystemMessage,
                        content: "Context compacted".to_string(),
                        metadata: None,
                    },
                )]
            }
            _ => Vec::new(),
        },
        ServerNotification::Error(notification) => vec![ConversationPatch::add_normalized_entry(
            entry_index.next(),
            NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: format!("Error: {}", notification.error.message),
                metadata: None,
            },
        )],
        ServerNotification::ContextCompacted(..) => vec![ConversationPatch::add_normalized_entry(
            entry_index.next(),
            NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::SystemMessage,
                content: "Context compacted".to_string(),
                metadata: None,
            },
        )],
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

    if let Ok(response) = serde_json::from_value::<CompatibleThreadForkResponse>(response.result) {
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
    if let ServerNotification::ThreadStarted(notification) = &notification {
        msg_store.push_session_id(notification.thread.id.clone());
    }
    for patch in direct_server_notification_patches(notification, state, entry_index) {
        msg_store.push_patch(patch);
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

fn app_patch_status_to_tool_status(status: AppPatchApplyStatus) -> ToolStatus {
    match status {
        AppPatchApplyStatus::InProgress => ToolStatus::Created,
        AppPatchApplyStatus::Completed => ToolStatus::Success,
        AppPatchApplyStatus::Failed => ToolStatus::Failed,
        AppPatchApplyStatus::Declined => ToolStatus::Denied { reason: None },
    }
}

fn core_patch_status_to_tool_status(status: CorePatchApplyStatus) -> ToolStatus {
    match status {
        CorePatchApplyStatus::Completed => ToolStatus::Success,
        CorePatchApplyStatus::Failed => ToolStatus::Failed,
        CorePatchApplyStatus::Declined => ToolStatus::Denied { reason: None },
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
}

fn approval_patches(
    approval: Approval,
    state: &mut LogState,
    entry_index: &EntryIndexProvider,
) -> Vec<json_patch::Patch> {
    let normalized_tool_name = approval.normalized_tool_name();
    let display_tool_name = approval.display_tool_name();

    match approval {
        Approval::ApprovalRequested {
            call_id,
            approval_id,
            requested_at,
            timeout_at,
            ..
        } => {
            let (approval_entry_index, is_new) = state
                .pending_approvals
                .remove(&call_id)
                .map(|pending| (pending.entry_index, false))
                .unwrap_or_else(|| (entry_index.next(), true));
            let pending = PendingApprovalState {
                normalized_tool_name,
                display_tool_name,
                approval_id,
                requested_at,
                timeout_at,
                entry_index: approval_entry_index,
            };
            let patch = streaming_entry_patch(pending.pending_entry(), pending.entry_index, is_new);
            state.pending_approvals.insert(call_id, pending);
            vec![patch]
        }
        Approval::ApprovalResponse {
            call_id,
            approval_status,
            ..
        } => match approval_status {
            ApprovalStatus::Pending | ApprovalStatus::Approved => Vec::new(),
            ApprovalStatus::Denied { reason } => {
                if let Some(pending) = state.pending_approvals.remove(&call_id) {
                    vec![ConversationPatch::replace(
                        pending.entry_index,
                        pending.to_normalized_entry(ToolStatus::Denied { reason }),
                    )]
                } else {
                    let entry = NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::UserFeedback {
                            denied_tool: display_tool_name,
                        },
                        content: reason
                            .unwrap_or_else(|| "User denied this tool use request".to_string())
                            .trim()
                            .to_string(),
                        metadata: None,
                    };
                    vec![ConversationPatch::add_normalized_entry(
                        entry_index.next(),
                        entry,
                    )]
                }
            }
            ApprovalStatus::TimedOut => {
                if let Some(pending) = state.pending_approvals.remove(&call_id) {
                    vec![ConversationPatch::replace(
                        pending.entry_index,
                        pending.to_normalized_entry(ToolStatus::TimedOut),
                    )]
                } else {
                    let entry = NormalizedEntry {
                        timestamp: None,
                        entry_type: NormalizedEntryType::ErrorMessage {
                            error_type: NormalizedEntryError::Other,
                        },
                        content: format!("Approval timed out for tool {display_tool_name}"),
                        metadata: None,
                    };
                    vec![ConversationPatch::add_normalized_entry(
                        entry_index.next(),
                        entry,
                    )]
                }
            }
        },
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

    fn patch_values(entries: &[log_types::LogEntry]) -> Vec<&serde_json::Value> {
        entries
            .iter()
            .filter_map(|entry| match entry {
                log_types::LogEntry::JsonPatch(value) => Some(value),
                _ => None,
            })
            .collect()
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

    #[test]
    fn legacy_command_output_deltas_replace_the_started_entry() {
        let entries = replay_log_entries(
            &[
                log_types::LogEntry::Stdout(
                    r#"{"method":"codex/event/exec_command_begin","params":{"id":"0","msg":{"type":"exec_command_begin","call_id":"call-1","turn_id":"turn","command":["cargo","test"],"cwd":"/tmp","parsed_cmd":[]},"conversationId":"thread"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"codex/event/exec_command_output_delta","params":{"id":"1","msg":{"type":"exec_command_output_delta","call_id":"call-1","stream":"stdout","chunk":"Zmlyc3QK"},"conversationId":"thread"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"codex/event/exec_command_output_delta","params":{"id":"2","msg":{"type":"exec_command_output_delta","call_id":"call-1","stream":"stdout","chunk":"c2Vjb25kCg=="},"conversationId":"thread"}}"#.to_string(),
                ),
            ],
            Path::new("."),
        );
        let patches = patch_values(&entries);

        assert_eq!(patches.len(), 3);
        assert_eq!(
            patches[0].pointer("/0/op").and_then(|v| v.as_str()),
            Some("add")
        );
        assert_eq!(
            patches[1].pointer("/0/op").and_then(|v| v.as_str()),
            Some("replace")
        );
        assert_eq!(
            patches[2].pointer("/0/op").and_then(|v| v.as_str()),
            Some("replace")
        );
        for patch in &patches {
            assert_eq!(
                patch.pointer("/0/path").and_then(|v| v.as_str()),
                Some("/entries/0")
            );
        }
        assert_eq!(
            patches[2]
                .pointer("/0/value/content/type/action_type/result/output")
                .and_then(|v| v.as_str()),
            Some("stdout:\nfirst\nsecond")
        );
    }

    #[test]
    fn app_server_command_output_deltas_replace_the_started_entry() {
        let entries = replay_log_entries(
            &[
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"cmd-1","command":"cargo test","cwd":"/tmp","processId":null,"status":"inProgress","commandActions":[],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/commandExecution/outputDelta","params":{"threadId":"thread","turnId":"turn","itemId":"cmd-1","delta":"first\n"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/commandExecution/outputDelta","params":{"threadId":"thread","turnId":"turn","itemId":"cmd-1","delta":"second\n"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"cmd-1","command":"cargo test","cwd":"/tmp","processId":null,"status":"completed","commandActions":[],"aggregatedOutput":"first\nsecond\n","exitCode":0,"durationMs":5},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
            ],
            Path::new("."),
        );
        let patches = patch_values(&entries);

        assert_eq!(patches.len(), 4);
        assert_eq!(
            patches[0].pointer("/0/op").and_then(|v| v.as_str()),
            Some("add")
        );
        assert_eq!(
            patches[1].pointer("/0/op").and_then(|v| v.as_str()),
            Some("replace")
        );
        assert_eq!(
            patches[2].pointer("/0/op").and_then(|v| v.as_str()),
            Some("replace")
        );
        assert_eq!(
            patches[3].pointer("/0/op").and_then(|v| v.as_str()),
            Some("replace")
        );
        for patch in &patches {
            assert_eq!(
                patch.pointer("/0/path").and_then(|v| v.as_str()),
                Some("/entries/0")
            );
        }
        assert_eq!(
            patches[3]
                .pointer("/0/value/content/type/status/status")
                .and_then(|v| v.as_str()),
            Some("success")
        );
    }

    #[test]
    fn app_server_mcp_completion_replaces_the_started_entry() {
        let entries = replay_log_entries(
            &[
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/started","params":{"item":{"type":"mcpToolCall","id":"mcp-1","server":"docs","tool":"search","status":"inProgress","arguments":{"query":"rust"},"result":null,"error":null,"durationMs":null},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/completed","params":{"item":{"type":"mcpToolCall","id":"mcp-1","server":"docs","tool":"search","status":"completed","arguments":{"query":"rust"},"result":null,"error":null,"durationMs":5},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
            ],
            Path::new("."),
        );
        let patches = patch_values(&entries);

        assert_eq!(patches.len(), 2);
        assert_eq!(
            patches[0].pointer("/0/op").and_then(Value::as_str),
            Some("add")
        );
        assert_eq!(
            patches[1].pointer("/0/op").and_then(Value::as_str),
            Some("replace")
        );
        assert_eq!(
            patches[1].pointer("/0/path").and_then(Value::as_str),
            Some("/entries/0")
        );
        assert_eq!(
            patches[1]
                .pointer("/0/value/content/type/status/status")
                .and_then(Value::as_str),
            Some("success")
        );
    }

    #[test]
    fn app_server_web_search_completion_replaces_the_started_entry() {
        let entries = replay_log_entries(
            &[
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/started","params":{"item":{"type":"webSearch","id":"web-1","query":"","action":null},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/completed","params":{"item":{"type":"webSearch","id":"web-1","query":"Rust release notes","action":null},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
            ],
            Path::new("."),
        );
        let patches = patch_values(&entries);

        assert_eq!(patches.len(), 2);
        assert_eq!(
            patches[0].pointer("/0/op").and_then(Value::as_str),
            Some("add")
        );
        assert_eq!(
            patches[1].pointer("/0/op").and_then(Value::as_str),
            Some("replace")
        );
        assert_eq!(
            patches[1].pointer("/0/path").and_then(Value::as_str),
            Some("/entries/0")
        );
        assert_eq!(
            patches[1]
                .pointer("/0/value/content/content")
                .and_then(Value::as_str),
            Some("Rust release notes")
        );
    }

    #[test]
    fn app_server_file_change_completion_replaces_each_file_entry() {
        let entries = replay_log_entries(
            &[
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/started","params":{"item":{"type":"fileChange","id":"patch-1","changes":[{"path":"src/lib.rs","kind":{"type":"add"},"diff":"fn added() {}\n"}],"status":"inProgress"},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"patch-1","changes":[{"path":"src/lib.rs","kind":{"type":"add"},"diff":"fn added() {}\n"}],"status":"completed"},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
            ],
            Path::new("."),
        );
        let patches = patch_values(&entries);

        assert_eq!(patches.len(), 2);
        assert_eq!(
            patches[0].pointer("/0/op").and_then(Value::as_str),
            Some("add")
        );
        assert_eq!(
            patches[1].pointer("/0/op").and_then(Value::as_str),
            Some("replace")
        );
        assert_eq!(
            patches[1]
                .pointer("/0/value/content/type/action_type/path")
                .and_then(Value::as_str),
            Some("src/lib.rs")
        );
        assert_eq!(
            patches[1]
                .pointer("/0/value/content/type/status/status")
                .and_then(Value::as_str),
            Some("success")
        );
    }

    #[test]
    fn approved_command_reuses_the_pending_approval_entry() {
        let mut state = LogState::new();
        let entry_index = EntryIndexProvider::new();
        let approval = Approval::approval_requested(
            "cmd-1".to_string(),
            "codex.exec_command".to_string(),
            "approval-1".to_string(),
            "2026-07-11T00:00:00Z".to_string(),
            "2026-07-11T00:10:00Z".to_string(),
        );
        let approval_patch = approval_patches(approval, &mut state, &entry_index);
        let approved = Approval::approval_response(
            "cmd-1".to_string(),
            "codex.exec_command".to_string(),
            ApprovalStatus::Approved,
        );
        assert!(approval_patches(approved, &mut state, &entry_index).is_empty());

        let notification: ServerNotification = serde_json::from_str(
            r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"cmd-1","command":"cargo test","cwd":"/tmp","processId":null,"status":"inProgress","commandActions":[],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"thread","turnId":"turn"}}"#,
        )
        .expect("valid command notification");
        let command_patch =
            direct_server_notification_patches(notification, &mut state, &entry_index);
        let approval_value = serde_json::to_value(&approval_patch[0]).unwrap();
        let command_value = serde_json::to_value(&command_patch[0]).unwrap();

        assert_eq!(
            approval_value.pointer("/0/op").and_then(Value::as_str),
            Some("add")
        );
        assert_eq!(
            command_value.pointer("/0/op").and_then(Value::as_str),
            Some("replace")
        );
        assert_eq!(
            command_value.pointer("/0/path").and_then(Value::as_str),
            Some("/entries/0")
        );
    }

    #[test]
    fn denied_approval_replaces_the_pending_entry_with_the_reason() {
        let mut state = LogState::new();
        let entry_index = EntryIndexProvider::new();
        let requested = Approval::approval_requested(
            "cmd-1".to_string(),
            "codex.exec_command".to_string(),
            "approval-1".to_string(),
            "2026-07-11T00:00:00Z".to_string(),
            "2026-07-11T00:10:00Z".to_string(),
        );
        let requested_patch = approval_patches(requested, &mut state, &entry_index);
        let denied = Approval::approval_response(
            "cmd-1".to_string(),
            "codex.exec_command".to_string(),
            ApprovalStatus::Denied {
                reason: Some("not now".to_string()),
            },
        );
        let denied_patch = approval_patches(denied, &mut state, &entry_index);
        let requested_value = serde_json::to_value(&requested_patch[0]).unwrap();
        let denied_value = serde_json::to_value(&denied_patch[0]).unwrap();

        assert_eq!(
            requested_value.pointer("/0/op").and_then(Value::as_str),
            Some("add")
        );
        assert_eq!(
            denied_value.pointer("/0/op").and_then(Value::as_str),
            Some("replace")
        );
        assert_eq!(
            denied_value.pointer("/0/path").and_then(Value::as_str),
            Some("/entries/0")
        );
        assert_eq!(
            denied_value
                .pointer("/0/value/content/type/status/reason")
                .and_then(Value::as_str),
            Some("not now")
        );
    }

    #[test]
    fn app_server_streams_interleaved_message_items_independently() {
        let entries = replay_log_entries(
            &[
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"message-a","delta":"A1"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"message-b","delta":"B1"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"message-a","delta":"A2"}}"#.to_string(),
                ),
            ],
            Path::new("."),
        );
        let patches = patch_values(&entries);

        assert_eq!(patches.len(), 3);
        assert_eq!(
            patches[0].pointer("/0/path").and_then(Value::as_str),
            Some("/entries/0")
        );
        assert_eq!(
            patches[1].pointer("/0/path").and_then(Value::as_str),
            Some("/entries/1")
        );
        assert_eq!(
            patches[2].pointer("/0/op").and_then(Value::as_str),
            Some("replace")
        );
        assert_eq!(
            patches[2].pointer("/0/path").and_then(Value::as_str),
            Some("/entries/0")
        );
        assert_eq!(
            patches[2]
                .pointer("/0/value/content/content")
                .and_then(Value::as_str),
            Some("A1A2")
        );
    }

    #[test]
    fn compatible_command_start_events_share_one_entry() {
        let entries = replay_log_entries(
            &[
                log_types::LogEntry::Stdout(
                    r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"cmd-1","command":"cargo test","cwd":"/tmp","processId":null,"status":"inProgress","commandActions":[],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"thread","turnId":"turn"}}"#.to_string(),
                ),
                log_types::LogEntry::Stdout(
                    r#"{"method":"codex/event/exec_command_begin","params":{"id":"0","msg":{"type":"exec_command_begin","call_id":"cmd-1","turn_id":"turn","command":["cargo","test"],"cwd":"/tmp","parsed_cmd":[]},"conversationId":"thread"}}"#.to_string(),
                ),
            ],
            Path::new("."),
        );
        let patches = patch_values(&entries);

        assert_eq!(patches.len(), 2);
        assert_eq!(
            patches[0].pointer("/0/op").and_then(Value::as_str),
            Some("add")
        );
        assert_eq!(
            patches[1].pointer("/0/op").and_then(Value::as_str),
            Some("replace")
        );
        assert_eq!(
            patches[1].pointer("/0/path").and_then(Value::as_str),
            Some("/entries/0")
        );
    }
}
