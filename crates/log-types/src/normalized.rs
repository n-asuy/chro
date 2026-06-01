//! Normalized log entry types for structured agent output display.
//!
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Result type for tool execution values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolResultValueType {
    Markdown,
    Json,
}

/// Tool result with typed value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    #[serde(rename = "type")]
    pub result_type: ToolResultValueType,
    /// For Markdown, this will be a JSON string; for JSON, a structured value
    pub value: Value,
}

impl ToolResult {
    pub fn markdown<S: Into<String>>(markdown: S) -> Self {
        Self {
            result_type: ToolResultValueType::Markdown,
            value: Value::String(markdown.into()),
        }
    }

    pub fn json(value: Value) -> Self {
        Self {
            result_type: ToolResultValueType::Json,
            value,
        }
    }
}

/// Exit status of a command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandExitStatus {
    ExitCode { code: i32 },
    Success { success: bool },
}

/// Result of a command execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandRunResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<CommandExitStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/// Error type classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedEntryError {
    SetupRequired,
    Other,
}

/// The type of normalized entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedEntryType {
    /// User input message
    UserMessage,
    /// User feedback (denial reason, etc.)
    UserFeedback { denied_tool: String },
    /// Assistant response text
    AssistantMessage,
    /// Tool use action
    ToolUse {
        tool_name: String,
        action_type: ActionType,
        status: ToolStatus,
    },
    /// System message (initialization, model info, etc.)
    SystemMessage,
    /// Error message
    ErrorMessage { error_type: NormalizedEntryError },
    /// Thinking/reasoning block
    Thinking,
    /// Loading state
    Loading,
    /// Next action summary
    NextAction {
        failed: bool,
        execution_processes: usize,
        needs_setup: bool,
    },
}

/// A normalized entry representing a single piece of agent conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NormalizedEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(rename = "type")]
    pub entry_type: NormalizedEntryType,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Content patterns whose `SystemMessage` entries must never reach the UI.
///
/// These are agent-CLI protocol events (e.g. Claude Code's
/// `{"type":"system","subtype":"status"}`) that normalize into
/// `SystemMessage` but carry no user-facing value. Suppression happens at
/// the normalizer boundary so the entries never enter the patch stream,
/// the conversation store, or the render path.
pub const SUPPRESSED_SYSTEM_CONTENT_PATTERNS: &[&str] = &["System: status"];

/// Returns true when a would-be `SystemMessage` content matches a known
/// suppression pattern and the entry must not be emitted.
///
/// Matching is whitespace-trimmed and requires either an exact match or a
/// word-boundary prefix (pattern followed by whitespace). This avoids
/// accidentally swallowing content like "System: statusbar".
pub fn should_suppress_system_message(content: &str) -> bool {
    let trimmed = content.trim();
    SUPPRESSED_SYSTEM_CONTENT_PATTERNS.iter().any(|pattern| {
        if trimmed == *pattern {
            return true;
        }
        trimmed
            .strip_prefix(*pattern)
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_whitespace()))
    })
}

/// Status of a tool execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolStatus {
    /// Tool call created, awaiting result
    #[default]
    Created,
    /// Tool executed successfully
    Success,
    /// Tool execution failed
    Failed,
    /// Tool was denied/skipped
    Denied {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Waiting for approval
    PendingApproval {
        approval_id: String,
        requested_at: String,
        timeout_at: String,
    },
    /// Approval timed out
    TimedOut,
}

/// A TODO item from TodoWrite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

/// Describes what action a tool is performing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ActionType {
    /// Reading a file
    FileRead { path: String },
    /// Editing/writing a file
    FileEdit {
        path: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        changes: Vec<FileChange>,
    },
    /// Running a command
    CommandRun {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<CommandRunResult>,
    },
    /// Searching (grep, glob, etc.)
    Search { query: String },
    /// Fetching a web page
    WebFetch { url: String },
    /// Generic tool with optional arguments and result for rich rendering
    Tool {
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,
    },
    /// Creating a subtask
    TaskCreate { description: String },
    /// Presenting a plan (ExitPlanMode)
    PlanPresentation { plan: String },
    /// TODO list management
    TodoManagement {
        todos: Vec<TodoItem>,
        operation: String,
    },
    /// Other/unknown action
    Other { description: String },
}

/// Represents a file change (edit or write).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FileChange {
    /// Create a file if it doesn't exist, and overwrite its content.
    Write { content: String },
    /// Delete a file.
    Delete,
    /// Rename a file.
    Rename { new_path: String },
    /// Edit a file with a unified diff.
    Edit {
        /// Unified diff containing file header and hunks.
        unified_diff: String,
        /// Whether line numbers in the hunks are reliable.
        has_line_numbers: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppresses_exact_system_status() {
        assert!(should_suppress_system_message("System: status"));
    }

    #[test]
    fn suppresses_trimmed_system_status() {
        assert!(should_suppress_system_message("  System: status\n"));
    }

    #[test]
    fn suppresses_system_status_with_trailing_detail() {
        assert!(should_suppress_system_message("System: status running"));
    }

    #[test]
    fn does_not_suppress_unrelated_system_messages() {
        assert!(!should_suppress_system_message("Run with Opus 4.7"));
        assert!(!should_suppress_system_message("System: init"));
        assert!(!should_suppress_system_message("System message"));
        assert!(!should_suppress_system_message(""));
    }

    #[test]
    fn does_not_suppress_word_boundary_false_positive() {
        assert!(!should_suppress_system_message("System: statusbar"));
    }
}
