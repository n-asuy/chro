//! Wire types for conversation derivation.
//!
//! These structs mirror the TypeScript declarations the desktop frontend feeds
//! into `flattenConversationEntries` and `segmentConversationEntries`
//! (`apps/desktop/src/session/types/normalized.ts` and `.../types/api.ts`).
//! The JSON contract is the spec, so field/variant names match the TS shapes
//! exactly.
//!
//! Reconciliation note (for U8/U9): this `NormalizedEntry` is the frontend
//! display shape, which differs from `crates/log-types::NormalizedEntry` on
//! three envelope fields. It carries an `id` (added client-side for React keys;
//! absent in log-types). Its discriminant field is `entry_type` (log-types
//! renames it to `type`). Its `timestamp` is present-but-null in the wire
//! stream rather than omitted. The inner discriminant of
//! `entry_type`/`action_type`/`status` uses `type`, `action`, and `status` tags
//! respectively, with snake_case variant names that line up with log-types.
//! When U8/U9 bridges log-types into this module, that envelope (`id`,
//! `entry_type` key, nullable `timestamp`) is the adapter seam.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Exit status of a command (`CommandExitStatus` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandExitStatus {
    ExitCode { code: i64 },
    Success { success: bool },
}

/// Result of a command execution (`CommandRunResult` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandRunResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<CommandExitStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/// A file change inside a `file_edit` action (`FileChange` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FileChange {
    Write {
        content: String,
    },
    Delete,
    Rename {
        new_path: String,
    },
    Edit {
        unified_diff: String,
        has_line_numbers: bool,
    },
}

/// A TODO item from todo management (`TodoItem` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

/// Typed value carried by a generic tool result (`ToolResult` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    #[serde(rename = "type")]
    pub result_type: String,
    pub value: Value,
}

/// Describes what action a tool is performing (`ActionType` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ActionType {
    FileRead {
        path: String,
    },
    FileEdit {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        changes: Option<Vec<FileChange>>,
    },
    CommandRun {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<CommandRunResult>,
    },
    Search {
        query: String,
    },
    WebFetch {
        url: String,
    },
    Tool {
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,
    },
    TaskCreate {
        description: String,
    },
    PlanPresentation {
        plan: String,
    },
    TodoManagement {
        todos: Vec<TodoItem>,
        operation: String,
    },
    Other {
        description: String,
    },
}

/// Status of a tool execution (`ToolStatus` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolStatus {
    Created,
    Success,
    Failed,
    Denied {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    PendingApproval {
        approval_id: String,
        requested_at: String,
        timeout_at: String,
    },
    TimedOut,
}

/// Error classification on an error message (`NormalizedEntryError` in TS).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedEntryError {
    SetupRequired,
    MalformedToolCall,
    ApiError,
    Other,
}

/// Entry-type discriminated union (`NormalizedEntryType` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedEntryType {
    UserMessage,
    UserFeedback {
        denied_tool: String,
    },
    AssistantMessage,
    ToolUse {
        tool_name: String,
        action_type: ActionType,
        status: ToolStatus,
    },
    SystemMessage,
    ErrorMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_type: Option<NormalizedEntryError>,
    },
    Thinking,
    Loading,
    NextAction {
        failed: bool,
        execution_processes: i64,
        needs_setup: bool,
    },
}

/// A normalized entry representing a single piece of agent conversation.
///
/// The `id` field is added client-side (React keys); `entry_type` is the
/// literal field name in the wire shape (it is not flattened onto the parent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NormalizedEntry {
    pub id: String,
    /// Present in the wire stream and may be explicitly null, so it is always
    /// serialized (the synthetic/loading entries rely on a literal `null`).
    pub timestamp: Option<String>,
    pub entry_type: NormalizedEntryType,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Display entry with a render key. Mirrors the TS `DisplayEntry` union:
/// `NORMALIZED_ENTRY` carries a structured entry; `STDOUT`/`STDERR` carry raw
/// process output. The `type` tag uses the exact uppercase TS literals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DisplayEntry {
    #[serde(rename = "NORMALIZED_ENTRY")]
    Normalized {
        content: NormalizedEntry,
        key: String,
    },
    #[serde(rename = "STDOUT")]
    Stdout { content: String, key: String },
    #[serde(rename = "STDERR")]
    Stderr { content: String, key: String },
}

impl DisplayEntry {
    /// The render key common to every display-entry variant.
    pub fn key(&self) -> &str {
        match self {
            DisplayEntry::Normalized { key, .. }
            | DisplayEntry::Stdout { key, .. }
            | DisplayEntry::Stderr { key, .. } => key,
        }
    }

    /// The structured entry, when this is a `NORMALIZED_ENTRY`.
    pub fn normalized(&self) -> Option<&NormalizedEntry> {
        match self {
            DisplayEntry::Normalized { content, .. } => Some(content),
            _ => None,
        }
    }
}

/// A task session row (`TaskSessionRecord` in TS), trimmed to the fields the
/// flatten logic reads (`id`, `task_run_id`, `prompt`). The remaining columns
/// are irrelevant to derivation and intentionally omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskSessionRecord {
    pub id: String,
    pub task_run_id: Option<String>,
    pub prompt: Option<String>,
}

/// Per-run conversation state fed into the flatten step
/// (`TaskRunConversationState` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunConversationState {
    pub task_run_id: String,
    pub created_at: String,
    pub entries: Vec<DisplayEntry>,
}

/// A prompt override for a run that has no persisted session yet
/// (`TaskRunPromptOverride` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRunPromptOverride {
    pub prompt: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// A run of consecutive agent "working" entries rendered as one collapsible
/// thinking-steps timeline (`ThinkingStepsSegment` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingStepsSegment {
    pub entries: Vec<DisplayEntry>,
    pub live: bool,
    pub awaiting_approval: bool,
    pub label: Option<String>,
    pub key: String,
}

/// One element of a segmented conversation (`ConversationSegment` in TS): either
/// a passthrough display entry or a thinking-steps run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ConversationSegment {
    #[serde(rename = "ENTRY")]
    Entry { entry: DisplayEntry, key: String },
    #[serde(rename = "THINKING_STEPS", rename_all = "camelCase")]
    ThinkingSteps {
        entries: Vec<DisplayEntry>,
        live: bool,
        awaiting_approval: bool,
        label: Option<String>,
        key: String,
    },
}
