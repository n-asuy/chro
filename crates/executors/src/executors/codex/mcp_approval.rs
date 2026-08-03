//! Approval prompts carried over MCP elicitation requests.
//!
//! The agent server asks the client to approve an MCP tool call by sending an
//! elicitation request tagged with an approval kind in its `_meta`. The same
//! request type also carries genuine server-driven form and URL elicitations,
//! which are a different interaction and are not handled here.
//!
//! This module owns the whole protocol translation: request `_meta` in, a
//! render-ready prompt out, and a decision back into a protocol response. It is
//! deliberately free of I/O so the mapping is testable on its own.

use codex_app_server_protocol::{
    McpServerElicitationAction, McpServerElicitationRequest, McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
};
use serde::Serialize;
use serde_json::{Map, Value};

/// Tool name recorded on the approval record. The UI keys its approval card off
/// this, the way it keys the question panel off `AskUserQuestion`.
pub const MCP_APPROVAL_TOOL_NAME: &str = "codex.mcp_tool_call";

/// Key the chosen decision id travels under in the approval answers map. The
/// approval transport carries `{ question: answer }` pairs; an approval is one
/// question, so it uses one well-known key.
pub const MCP_APPROVAL_DECISION_KEY: &str = "decision";

const APPROVAL_KIND_KEY: &str = "codex_approval_kind";
const APPROVAL_KIND_MCP_TOOL_CALL: &str = "mcp_tool_call";
const CONNECTOR_NAME_KEY: &str = "connector_name";
const TOOL_TITLE_KEY: &str = "tool_title";
const RISK_LEVEL_KEY: &str = "riskLevel";
const TOOL_PARAMS_KEY: &str = "tool_params";
const TOOL_PARAMS_DISPLAY_KEY: &str = "tool_params_display";
const PERSIST_KEY: &str = "persist";
const PERSIST_SESSION: &str = "session";
const PERSIST_ALWAYS: &str = "always";

/// What the user chose. Ids are the wire contract with the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpApprovalDecision {
    Allow,
    AllowForSession,
    AllowAlways,
    Deny,
}

impl McpApprovalDecision {
    pub fn id(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::AllowForSession => "allow_session",
            Self::AllowAlways => "allow_always",
            Self::Deny => "deny",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "allow" => Some(Self::Allow),
            "allow_session" => Some(Self::AllowForSession),
            "allow_always" => Some(Self::AllowAlways),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }

    pub fn is_approval(self) -> bool {
        !matches!(self, Self::Deny)
    }
}

/// One labelled fact about the pending call. `value` may span multiple lines
/// (a code argument, say); the UI renders those as a block.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpApprovalParam {
    pub label: String,
    pub value: String,
}

impl McpApprovalParam {
    fn is_multiline(&self) -> bool {
        self.value.contains('\n')
    }
}

/// Everything the approval card needs, already shaped for rendering.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpApprovalPrompt {
    pub server: String,
    /// Connector or tool title, when the server supplied one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<String>,
    pub params: Vec<McpApprovalParam>,
    /// Decision ids in display order. Which remembering options appear is the
    /// server's call, so the client never offers one it would ignore.
    pub options: Vec<String>,
}

impl McpApprovalPrompt {
    /// Returns `None` when the elicitation is not an approval request: a form
    /// or URL elicitation is the server asking for input, not for permission.
    pub fn from_elicitation(params: &McpServerElicitationRequestParams) -> Option<Self> {
        let (meta, message) = match &params.request {
            McpServerElicitationRequest::Form { meta, message, .. } => (meta.as_ref()?, message),
            McpServerElicitationRequest::Url { .. } => return None,
        };
        let meta = meta.as_object()?;
        if meta.get(APPROVAL_KIND_KEY).and_then(Value::as_str) != Some(APPROVAL_KIND_MCP_TOOL_CALL)
        {
            return None;
        }

        Some(Self {
            server: params.server_name.clone(),
            title: string_field(meta, CONNECTOR_NAME_KEY).or_else(|| {
                string_field(meta, TOOL_TITLE_KEY)
            }),
            message: message.clone(),
            risk_level: string_field(meta, RISK_LEVEL_KEY),
            params: approval_params(meta),
            options: approval_options(meta),
        })
    }
}

fn string_field(meta: &Map<String, Value>, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Prefers the server's own display list, which is already ordered and named
/// for humans. Falls back to the raw arguments so a call still shows what it
/// is about to do when the server sends no display hints.
fn approval_params(meta: &Map<String, Value>) -> Vec<McpApprovalParam> {
    if let Some(display) = meta.get(TOOL_PARAMS_DISPLAY_KEY).and_then(Value::as_array) {
        let params: Vec<McpApprovalParam> = display
            .iter()
            .filter_map(|entry| {
                let entry = entry.as_object()?;
                let label = string_field(entry, "display_name")
                    .or_else(|| string_field(entry, "name"))?;
                Some(McpApprovalParam {
                    label,
                    value: value_to_display(entry.get("value")?),
                })
            })
            .collect();
        if !params.is_empty() {
            return params;
        }
    }

    let Some(raw) = meta.get(TOOL_PARAMS_KEY).and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut params: Vec<McpApprovalParam> = raw
        .iter()
        .map(|(label, value)| McpApprovalParam {
            label: label.clone(),
            value: value_to_display(value),
        })
        .filter(|param| !param.value.is_empty())
        .collect();
    // Multi-line values are the substance of the decision, so they lead; the
    // rest follow alphabetically for a stable order across calls.
    params.sort_by(|a, b| {
        b.is_multiline()
            .cmp(&a.is_multiline())
            .then_with(|| a.label.cmp(&b.label))
    });
    params
}

fn value_to_display(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn approval_options(meta: &Map<String, Value>) -> Vec<String> {
    let persist: Vec<&str> = meta
        .get(PERSIST_KEY)
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let mut options = vec![McpApprovalDecision::Allow];
    if persist.contains(&PERSIST_SESSION) {
        options.push(McpApprovalDecision::AllowForSession);
    }
    if persist.contains(&PERSIST_ALWAYS) {
        options.push(McpApprovalDecision::AllowAlways);
    }
    options.push(McpApprovalDecision::Deny);
    options
        .into_iter()
        .map(|decision| decision.id().to_string())
        .collect()
}

/// Encodes a decision as an elicitation response. Remembering the answer is
/// expressed through `_meta.persist`; the server keeps the preference itself,
/// so the client only reports what was chosen.
pub fn elicitation_response(decision: McpApprovalDecision) -> McpServerElicitationRequestResponse {
    let persist = match decision {
        McpApprovalDecision::AllowForSession => Some(PERSIST_SESSION),
        McpApprovalDecision::AllowAlways => Some(PERSIST_ALWAYS),
        McpApprovalDecision::Allow | McpApprovalDecision::Deny => None,
    };

    McpServerElicitationRequestResponse {
        action: if decision.is_approval() {
            McpServerElicitationAction::Accept
        } else {
            McpServerElicitationAction::Decline
        },
        content: None,
        meta: persist.map(|persist| serde_json::json!({ PERSIST_KEY: persist })),
    }
}

/// Response for an elicitation this client cannot present. Declining leaves the
/// turn alive and tells the model the request went unanswered, where leaving it
/// open would hang the agent server forever.
pub fn unsupported_elicitation_response() -> McpServerElicitationRequestResponse {
    McpServerElicitationRequestResponse {
        action: McpServerElicitationAction::Decline,
        content: None,
        meta: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn elicitation(meta: Value, message: &str) -> McpServerElicitationRequestParams {
        serde_json::from_value(serde_json::json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "serverName": "node_repl",
            "mode": "form",
            "_meta": meta,
            "message": message,
            "requestedSchema": { "type": "object", "properties": {} },
        }))
        .expect("elicitation params should decode")
    }

    /// Shape captured from a real run that stalled: a connector approval with
    /// both remembering options offered.
    fn connector_approval() -> McpServerElicitationRequestParams {
        elicitation(
            serde_json::json!({
                "codex_approval_kind": "mcp_tool_call",
                "connector_id": "computer-use",
                "connector_name": "Computer Use",
                "persist": ["session", "always"],
                "riskLevel": "low",
                "tool_params": { "app": "com.chro-ai.desktop" },
                "tool_params_display": [
                    { "display_name": "App", "name": "app", "value": "Chro" }
                ],
            }),
            "Allow Computer Use to use \"Chro\"?",
        )
    }

    #[test]
    fn reads_a_connector_approval() {
        let prompt = McpApprovalPrompt::from_elicitation(&connector_approval())
            .expect("an approval-kind elicitation should produce a prompt");

        assert_eq!(prompt.server, "node_repl");
        assert_eq!(prompt.title.as_deref(), Some("Computer Use"));
        assert_eq!(prompt.message, "Allow Computer Use to use \"Chro\"?");
        assert_eq!(prompt.risk_level.as_deref(), Some("low"));
        assert_eq!(
            prompt.params,
            vec![McpApprovalParam {
                label: "App".to_string(),
                value: "Chro".to_string(),
            }]
        );
        assert_eq!(
            prompt.options,
            vec!["allow", "allow_session", "allow_always", "deny"]
        );
    }

    #[test]
    fn offers_only_the_remembering_options_the_server_allows() {
        let params = elicitation(
            serde_json::json!({
                "codex_approval_kind": "mcp_tool_call",
                "persist": ["session"],
            }),
            "Run this?",
        );
        let prompt = McpApprovalPrompt::from_elicitation(&params).expect("prompt");

        assert_eq!(prompt.options, vec!["allow", "allow_session", "deny"]);
    }

    #[test]
    fn offers_a_bare_choice_when_nothing_can_be_remembered() {
        let params = elicitation(
            serde_json::json!({ "codex_approval_kind": "mcp_tool_call" }),
            "Run this?",
        );
        let prompt = McpApprovalPrompt::from_elicitation(&params).expect("prompt");

        assert_eq!(prompt.options, vec!["allow", "deny"]);
    }

    #[test]
    fn falls_back_to_raw_arguments_and_leads_with_multiline_values() {
        let params = elicitation(
            serde_json::json!({
                "codex_approval_kind": "mcp_tool_call",
                "tool_params": {
                    "timeout_ms": 30000,
                    "code": "const a = 1;\nconsole.log(a);",
                    "title": "Inspect the app",
                    "empty": "",
                },
            }),
            "Run JavaScript?",
        );
        let prompt = McpApprovalPrompt::from_elicitation(&params).expect("prompt");

        assert_eq!(
            prompt.params,
            vec![
                McpApprovalParam {
                    label: "code".to_string(),
                    value: "const a = 1;\nconsole.log(a);".to_string(),
                },
                McpApprovalParam {
                    label: "timeout_ms".to_string(),
                    value: "30000".to_string(),
                },
                McpApprovalParam {
                    label: "title".to_string(),
                    value: "Inspect the app".to_string(),
                },
            ],
            "multi-line arguments lead, the rest are alphabetical, empties drop"
        );
    }

    #[test]
    fn ignores_elicitations_that_are_not_approvals() {
        let form = elicitation(serde_json::json!({ "hint": "profile" }), "Which profile?");
        assert!(McpApprovalPrompt::from_elicitation(&form).is_none());

        let untagged = elicitation(Value::Null, "Which profile?");
        assert!(McpApprovalPrompt::from_elicitation(&untagged).is_none());

        let url: McpServerElicitationRequestParams = serde_json::from_value(serde_json::json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "serverName": "node_repl",
            "mode": "url",
            "_meta": { "codex_approval_kind": "mcp_tool_call" },
            "message": "Sign in",
            "url": "https://example.test/auth",
            "elicitationId": "elicit-1",
        }))
        .expect("url elicitation should decode");
        assert!(
            McpApprovalPrompt::from_elicitation(&url).is_none(),
            "a URL elicitation is a sign-in hand-off, not an approval"
        );
    }

    #[test]
    fn encodes_each_decision_for_the_server() {
        let allow = elicitation_response(McpApprovalDecision::Allow);
        assert_eq!(allow.action, McpServerElicitationAction::Accept);
        assert!(allow.meta.is_none());

        let session = elicitation_response(McpApprovalDecision::AllowForSession);
        assert_eq!(session.action, McpServerElicitationAction::Accept);
        assert_eq!(
            session.meta,
            Some(serde_json::json!({ "persist": "session" }))
        );

        let always = elicitation_response(McpApprovalDecision::AllowAlways);
        assert_eq!(always.action, McpServerElicitationAction::Accept);
        assert_eq!(always.meta, Some(serde_json::json!({ "persist": "always" })));

        let deny = elicitation_response(McpApprovalDecision::Deny);
        assert_eq!(deny.action, McpServerElicitationAction::Decline);
        assert!(deny.meta.is_none());
    }

    #[test]
    fn decision_ids_round_trip() {
        for decision in [
            McpApprovalDecision::Allow,
            McpApprovalDecision::AllowForSession,
            McpApprovalDecision::AllowAlways,
            McpApprovalDecision::Deny,
        ] {
            assert_eq!(McpApprovalDecision::from_id(decision.id()), Some(decision));
        }
        assert_eq!(McpApprovalDecision::from_id("something-else"), None);
    }

    #[test]
    fn serializes_the_prompt_for_the_approval_record() {
        let prompt = McpApprovalPrompt::from_elicitation(&connector_approval()).expect("prompt");

        assert_eq!(
            serde_json::to_value(&prompt).expect("prompt should serialize"),
            serde_json::json!({
                "server": "node_repl",
                "title": "Computer Use",
                "message": "Allow Computer Use to use \"Chro\"?",
                "risk_level": "low",
                "params": [{ "label": "App", "value": "Chro" }],
                "options": ["allow", "allow_session", "allow_always", "deny"],
            })
        );
    }
}
