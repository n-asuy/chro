//! Wire types for the pi `--mode rpc` protocol.
//!
//! pi speaks a line-delimited JSON dialect over stdin/stdout: the client sends
//! commands (`{ id, type, ... }`), pi replies with responses
//! (`{ type: "response", command, success, data | error }`) and streams session
//! events (`AgentSessionEvent`). Extension UI prompts arrive as
//! `extension_ui_request` and are answered with `extension_ui_response`.
//!
//! Only the subset chro consumes is modelled here. Unknown event and content
//! variants degrade to `Other` so protocol additions never break decoding.

use serde::Deserialize;
use serde_json::Value;

/// A content block inside an assistant message. Tool-call and image blocks are
/// not rendered from here (tools come from `tool_execution_*` events), so they
/// collapse into `Other`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(other)]
    Other,
}

/// A pi conversation message as carried by message events.
///
/// Only assistant messages are rendered from the message stream (user prompts
/// are surfaced upstream, tool results come from `tool_execution_*` events), so
/// every other role collapses into `Other`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "role")]
pub enum PiMessage {
    #[serde(rename = "assistant")]
    Assistant {
        #[serde(default)]
        content: Vec<ContentBlock>,
    },
    #[serde(other)]
    Other,
}

impl PiMessage {
    /// Concatenated assistant text (empty for non-assistant messages).
    pub fn assistant_text(&self) -> String {
        match self {
            PiMessage::Assistant { content } => content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        }
    }

    /// Concatenated assistant thinking text (empty for non-assistant messages).
    pub fn assistant_thinking(&self) -> String {
        match self {
            PiMessage::Assistant { content } => content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Thinking { thinking } => Some(thinking.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        }
    }
}

/// A pi session event (subset of `AgentSessionEvent`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum PiEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: PiMessage },
    #[serde(rename = "message_update")]
    MessageUpdate { message: PiMessage },
    #[serde(rename = "message_end")]
    MessageEnd { message: PiMessage },
    #[serde(rename = "tool_execution_start")]
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    #[serde(rename = "tool_execution_end")]
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        result: Value,
        #[serde(default, rename = "isError")]
        is_error: bool,
    },
    #[serde(rename = "agent_end")]
    AgentEnd {
        #[serde(default, rename = "willRetry")]
        will_retry: bool,
    },
    #[serde(other)]
    Other,
}

/// The kind of an inbound line, used by the reader loop to route the message.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum InboundFrame {
    #[serde(rename = "response")]
    Response {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        success: bool,
        #[serde(default)]
        data: Option<Value>,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(rename = "extension_ui_request")]
    ExtensionUiRequest {
        id: String,
        method: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        message: Option<String>,
    },
    /// Any event or frame the reader loop does not act on directly (rendered by
    /// the log normalizer instead).
    #[serde(other)]
    Event,
}

/// Extract a pi session id from a `get_state` response payload.
pub fn session_id_from_state(data: &Value) -> Option<String> {
    data.get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_assistant_message_text_and_thinking() {
        let raw = serde_json::json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "Hello" },
                { "type": "toolCall", "id": "t1", "name": "bash", "arguments": { "command": "ls" } }
            ]
        });
        let msg: PiMessage = serde_json::from_value(raw).unwrap();
        assert_eq!(msg.assistant_text(), "Hello");
        assert_eq!(msg.assistant_thinking(), "hmm");
    }

    #[test]
    fn decodes_tool_execution_events() {
        let start = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "t1",
            "toolName": "read",
            "args": { "path": "/a" }
        });
        match serde_json::from_value::<PiEvent>(start).unwrap() {
            PiEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                ..
            } => {
                assert_eq!(tool_call_id, "t1");
                assert_eq!(tool_name, "read");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn agent_end_carries_will_retry() {
        let ev = serde_json::json!({ "type": "agent_end", "willRetry": false, "messages": [] });
        match serde_json::from_value::<PiEvent>(ev).unwrap() {
            PiEvent::AgentEnd { will_retry } => assert!(!will_retry),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn unknown_event_degrades_to_other() {
        let ev = serde_json::json!({ "type": "turn_start" });
        assert!(matches!(
            serde_json::from_value::<PiEvent>(ev).unwrap(),
            PiEvent::Other
        ));
    }

    #[test]
    fn routes_response_and_ui_frames() {
        let resp = serde_json::json!({
            "type": "response", "id": "1", "command": "get_state", "success": true,
            "data": { "sessionId": "abc" }
        });
        match serde_json::from_value::<InboundFrame>(resp).unwrap() {
            InboundFrame::Response { data, .. } => {
                assert_eq!(
                    session_id_from_state(&data.unwrap()).as_deref(),
                    Some("abc")
                );
            }
            other => panic!("unexpected: {other:?}"),
        }
        let ui = serde_json::json!({
            "type": "extension_ui_request", "id": "u1", "method": "confirm",
            "title": "ok?", "message": "do it"
        });
        assert!(matches!(
            serde_json::from_value::<InboundFrame>(ui).unwrap(),
            InboundFrame::ExtensionUiRequest { .. }
        ));
    }
}
