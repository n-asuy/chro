//! Claude Code stream-json type definitions.
//!
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Approval status for tool use requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied {
        #[serde(default)]
        reason: Option<String>,
    },
    TimedOut,
}

/// Top-level Claude stream-json message types.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum ClaudeJson {
    #[serde(rename = "system")]
    System {
        subtype: Option<String>,
        session_id: Option<String>,
        cwd: Option<String>,
        tools: Option<Vec<Value>>,
        model: Option<String>,
        #[serde(default, rename = "apiKeySource")]
        api_key_source: Option<String>,
    },
    #[serde(rename = "assistant")]
    Assistant {
        message: ClaudeMessage,
        session_id: Option<String>,
    },
    #[serde(rename = "user")]
    User {
        message: ClaudeMessage,
        session_id: Option<String>,
    },
    #[serde(rename = "tool_use")]
    ToolUse {
        tool_name: String,
        #[serde(flatten)]
        tool_data: ClaudeToolData,
        session_id: Option<String>,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        result: Value,
        is_error: Option<bool>,
        session_id: Option<String>,
    },
    #[serde(rename = "stream_event")]
    StreamEvent {
        event: ClaudeStreamEvent,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(default)]
        uuid: Option<String>,
    },
    #[serde(rename = "result")]
    Result {
        #[serde(default)]
        subtype: Option<String>,
        #[serde(default, alias = "isError")]
        is_error: Option<bool>,
        #[serde(default, alias = "durationMs")]
        duration_ms: Option<u64>,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default, alias = "numTurns")]
        num_turns: Option<u32>,
        #[serde(default, alias = "sessionId")]
        session_id: Option<String>,
    },
    #[serde(rename = "rate_limit_event")]
    RateLimitEvent {
        #[serde(default)]
        rate_limit_info: Option<ClaudeRateLimitInfo>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        uuid: Option<String>,
    },
    #[serde(rename = "approval_response")]
    ApprovalResponse {
        call_id: String,
        tool_name: String,
        approval_status: ApprovalStatus,
    },
    #[serde(untagged)]
    Unknown {
        #[serde(flatten)]
        data: HashMap<String, Value>,
    },
}

impl ClaudeJson {
    /// Extract session_id from stable runtime messages.
    ///
    /// We intentionally ignore `system` and `stream_event` variants here
    /// because those can appear before the session is fully initialized.
    pub fn session_id(&self) -> Option<&str> {
        match self {
            ClaudeJson::System { .. } => None,
            ClaudeJson::Assistant { session_id, .. } => session_id.as_deref(),
            ClaudeJson::User { session_id, .. } => session_id.as_deref(),
            ClaudeJson::ToolUse { session_id, .. } => session_id.as_deref(),
            ClaudeJson::ToolResult { session_id, .. } => session_id.as_deref(),
            ClaudeJson::StreamEvent { .. } => None,
            ClaudeJson::Result { session_id, .. } => session_id.as_deref(),
            ClaudeJson::RateLimitEvent { session_id, .. } => session_id.as_deref(),
            ClaudeJson::ApprovalResponse { .. } => None,
            ClaudeJson::Unknown { .. } => None,
        }
    }
}

/// Rate limit information emitted by Claude as an out-of-band event.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateLimitInfo {
    #[serde(default)]
    pub is_using_overage: Option<bool>,
    #[serde(default)]
    pub overage_disabled_reason: Option<String>,
    #[serde(default)]
    pub overage_status: Option<String>,
    #[serde(default)]
    pub rate_limit_type: Option<String>,
    #[serde(default)]
    pub resets_at: Option<u64>,
    #[serde(default)]
    pub status: Option<String>,
}

/// A Claude message with role and content.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ClaudeMessage {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub message_type: Option<String>,
    pub role: String,
    pub model: Option<String>,
    pub content: Vec<ClaudeContentItem>,
    pub stop_reason: Option<String>,
}

/// Content items within a Claude message.
///
/// The `Unknown` fallback keeps the parent message parseable when Claude
/// introduces a new content block type (e.g. `server_tool_use` for the
/// computer-use plugins). Without it, a single unrecognized item would
/// fail deserialization of the whole assistant message and the run would
/// silently drop the chunk.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum ClaudeContentItem {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        #[serde(flatten)]
        tool_data: ClaudeToolData,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: Value,
        is_error: Option<bool>,
    },
    #[serde(untagged)]
    Unknown {
        #[serde(flatten)]
        data: HashMap<String, Value>,
    },
}

/// Stream event types for streaming responses.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum ClaudeStreamEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: ClaudeMessage },
    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: usize,
        content_block: ClaudeContentItem,
    },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta {
        index: usize,
        delta: ClaudeContentBlockDelta,
    },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: usize },
    #[serde(rename = "message_delta")]
    MessageDelta {
        #[serde(default)]
        delta: Option<ClaudeMessageDelta>,
        #[serde(default)]
        usage: Option<ClaudeUsage>,
    },
    #[serde(rename = "message_stop")]
    MessageStop,
    #[serde(other)]
    Unknown,
}

/// Delta update for content blocks.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum ClaudeContentBlockDelta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { thinking: String },
    #[serde(other)]
    Unknown,
}

/// Delta for message-level updates.
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
pub struct ClaudeMessageDelta {
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_sequence: Option<String>,
}

/// Token usage information.
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
pub struct ClaudeUsage {
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default, rename = "cache_creation_input_tokens")]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default, rename = "cache_read_input_tokens")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    pub service_tier: Option<String>,
}

/// Structured tool data for known Claude tools.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "name", content = "input")]
pub enum ClaudeToolData {
    #[serde(rename = "TodoWrite", alias = "todo_write")]
    TodoWrite {
        todos: Vec<ClaudeTodoItem>,
    },
    #[serde(rename = "Task", alias = "task")]
    Task {
        subagent_type: Option<String>,
        description: Option<String>,
        prompt: Option<String>,
    },
    #[serde(rename = "Glob", alias = "glob")]
    Glob {
        #[serde(alias = "filePattern")]
        pattern: String,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
    },
    #[serde(rename = "LS", alias = "list_directory", alias = "ls")]
    LS {
        path: String,
    },
    #[serde(rename = "Read", alias = "read")]
    Read {
        #[serde(alias = "path")]
        file_path: String,
    },
    #[serde(rename = "Bash", alias = "bash")]
    Bash {
        #[serde(alias = "cmd", alias = "command_line")]
        command: String,
        #[serde(default)]
        description: Option<String>,
    },
    #[serde(rename = "Grep", alias = "grep")]
    Grep {
        pattern: String,
        #[serde(default)]
        output_mode: Option<String>,
        #[serde(default)]
        path: Option<String>,
    },
    ExitPlanMode {
        plan: String,
    },
    #[serde(rename = "Edit", alias = "edit_file")]
    Edit {
        #[serde(alias = "path")]
        file_path: String,
        #[serde(alias = "old_str")]
        old_string: Option<String>,
        #[serde(alias = "new_str")]
        new_string: Option<String>,
    },
    #[serde(rename = "MultiEdit", alias = "multi_edit")]
    MultiEdit {
        #[serde(alias = "path")]
        file_path: String,
        edits: Vec<ClaudeEditItem>,
    },
    #[serde(rename = "Write", alias = "create_file", alias = "write_file")]
    Write {
        #[serde(alias = "path")]
        file_path: String,
        content: String,
    },
    #[serde(rename = "NotebookEdit", alias = "notebook_edit")]
    NotebookEdit {
        notebook_path: String,
        new_source: String,
        edit_mode: String,
        #[serde(default)]
        cell_id: Option<String>,
    },
    #[serde(rename = "WebFetch", alias = "read_web_page")]
    WebFetch {
        url: String,
        #[serde(default)]
        prompt: Option<String>,
    },
    #[serde(rename = "WebSearch", alias = "web_search")]
    WebSearch {
        query: String,
        #[serde(default)]
        num_results: Option<u32>,
    },
    #[serde(rename = "TodoRead", alias = "todo_read")]
    TodoRead {},
    #[serde(rename = "AskUserQuestion", alias = "ask_user_question")]
    AskUserQuestion {
        questions: Vec<AskUserQuestionItem>,
    },
    #[serde(untagged)]
    Unknown {
        #[serde(flatten)]
        data: HashMap<String, Value>,
    },
}

/// A question item for AskUserQuestion tool.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct AskUserQuestionItem {
    pub question: String,
    pub header: String,
    pub options: Vec<AskUserQuestionOption>,
    #[serde(default, rename = "multiSelect")]
    pub multi_select: bool,
}

/// An option for AskUserQuestion.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct AskUserQuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

impl ClaudeToolData {
    /// Get the tool name.
    pub fn name(&self) -> &str {
        match self {
            ClaudeToolData::TodoWrite { .. } => "TodoWrite",
            ClaudeToolData::Task { .. } => "Task",
            ClaudeToolData::Glob { .. } => "Glob",
            ClaudeToolData::LS { .. } => "LS",
            ClaudeToolData::Read { .. } => "Read",
            ClaudeToolData::Bash { .. } => "Bash",
            ClaudeToolData::Grep { .. } => "Grep",
            ClaudeToolData::ExitPlanMode { .. } => "ExitPlanMode",
            ClaudeToolData::Edit { .. } => "Edit",
            ClaudeToolData::MultiEdit { .. } => "MultiEdit",
            ClaudeToolData::Write { .. } => "Write",
            ClaudeToolData::NotebookEdit { .. } => "NotebookEdit",
            ClaudeToolData::WebFetch { .. } => "WebFetch",
            ClaudeToolData::WebSearch { .. } => "WebSearch",
            ClaudeToolData::TodoRead { .. } => "TodoRead",
            ClaudeToolData::AskUserQuestion { .. } => "AskUserQuestion",
            ClaudeToolData::Unknown { data } => data
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown"),
        }
    }
}

/// A TODO item from TodoWrite.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ClaudeTodoItem {
    #[serde(default)]
    pub id: Option<String>,
    pub content: String,
    pub status: String,
    #[serde(default)]
    pub priority: Option<String>,
}

/// An edit item for MultiEdit.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ClaudeEditItem {
    pub old_string: Option<String>,
    pub new_string: Option<String>,
}

/// Helper struct for parsing tool_result text content.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ClaudeToolResultTextItem {
    pub text: String,
}

/// Helper struct for extracting tool input.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ClaudeToolWithInput {
    #[serde(default)]
    pub input: Value,
}

/// Amp's claude-compatible Bash tool_result content format.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct AmpBashResult {
    #[serde(default)]
    pub output: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_system_message() {
        let json =
            r#"{"type":"system","subtype":"init","session_id":"abc123","model":"claude-sonnet-4"}"#;
        let parsed: ClaudeJson = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.session_id(), None);
    }

    #[test]
    fn parse_assistant_message() {
        let json = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"xyz"}"#;
        let parsed: ClaudeJson = serde_json::from_str(json).unwrap();
        if let ClaudeJson::Assistant { message, .. } = parsed {
            assert_eq!(message.content.len(), 1);
        } else {
            panic!("Expected Assistant variant");
        }
    }

    #[test]
    fn parse_rate_limit_event() {
        let json = r#"{"type":"rate_limit_event","rate_limit_info":{"isUsingOverage":false,"overageDisabledReason":"out_of_credits","overageStatus":"rejected","rateLimitType":"five_hour","resetsAt":1772528400,"status":"allowed"},"session_id":"s1","uuid":"u1"}"#;
        let parsed: ClaudeJson = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.session_id(), Some("s1"));
        if let ClaudeJson::RateLimitEvent {
            rate_limit_info, ..
        } = parsed
        {
            let info = rate_limit_info.expect("rate_limit_info");
            assert_eq!(info.rate_limit_type.as_deref(), Some("five_hour"));
            assert_eq!(info.status.as_deref(), Some("allowed"));
        } else {
            panic!("Expected RateLimitEvent variant");
        }
    }

    #[test]
    fn parse_tool_use_bash() {
        let json = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]}}"#;
        let parsed: ClaudeJson = serde_json::from_str(json).unwrap();
        if let ClaudeJson::Assistant { message, .. } = parsed {
            if let ClaudeContentItem::ToolUse { tool_data, .. } = &message.content[0] {
                assert_eq!(tool_data.name(), "Bash");
            } else {
                panic!("Expected ToolUse content");
            }
        } else {
            panic!("Expected Assistant variant");
        }
    }

    #[test]
    fn parse_unknown_content_block_type() {
        let json = r#"{"type":"server_tool_use","id":"st_1","name":"web_search","input":{"q":"x"}}"#;
        let parsed: ClaudeContentItem = serde_json::from_str(json).unwrap();
        assert!(matches!(parsed, ClaudeContentItem::Unknown { .. }));
    }

    #[test]
    fn parse_assistant_message_with_unknown_content_block_does_not_fail() {
        let json = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"server_tool_use","name":"computer","input":{"action":"screenshot"}}]}}"#;
        let parsed: ClaudeJson = serde_json::from_str(json).unwrap();
        match parsed {
            ClaudeJson::Assistant { message, .. } => {
                assert_eq!(message.content.len(), 1);
                assert!(matches!(message.content[0], ClaudeContentItem::Unknown { .. }));
            }
            _ => panic!("expected Assistant variant"),
        }
    }

    #[test]
    fn parse_thinking() {
        let json = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me analyze..."}]}}"#;
        let parsed: ClaudeJson = serde_json::from_str(json).unwrap();
        if let ClaudeJson::Assistant { message, .. } = parsed {
            if let ClaudeContentItem::Thinking { thinking } = &message.content[0] {
                assert_eq!(thinking, "Let me analyze...");
            } else {
                panic!("Expected Thinking content");
            }
        } else {
            panic!("Expected Assistant variant");
        }
    }
}
