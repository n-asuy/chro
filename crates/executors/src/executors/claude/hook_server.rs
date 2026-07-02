//! Per-run HTTP receiver for Claude Code hook posts.
//!
//! Each run binds its own ephemeral 127.0.0.1 port with a fresh token, so
//! there is no cross-run multiplexing and a stale hook from a dead run can
//! never reach a live one. `PreToolUse` is answered synchronously through
//! the [`PermissionBroker`]; every other event is forwarded to the run
//! supervisor.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use approvals::ApprovalStatus as ApprovalOutcome;

use super::{
    hooks::{HOOK_TOKEN_HEADER, HookEndpoint},
    log_sink::LogLineSink,
    types::ApprovalStatus,
};
use crate::{
    approvals::{ExecutorApprovalService, QuestionStatus},
    executors::ExecutorError,
    profile::PermissionMode,
};

/// A hook event forwarded to the run supervisor.
#[derive(Debug)]
pub struct HookEvent {
    pub kind: HookEventKind,
    pub session_id: Option<String>,
    pub transcript_path: Option<PathBuf>,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEventKind {
    UserPromptSubmit,
    Stop,
    Notification,
    Other,
}

impl HookEvent {
    fn from_payload(name: &str, payload: Value) -> Self {
        let kind = match name {
            "UserPromptSubmit" => HookEventKind::UserPromptSubmit,
            "Stop" => HookEventKind::Stop,
            "Notification" => HookEventKind::Notification,
            _ => HookEventKind::Other,
        };
        Self {
            kind,
            session_id: payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            transcript_path: payload
                .get("transcript_path")
                .and_then(Value::as_str)
                .map(PathBuf::from),
            payload,
        }
    }
}

/// Decides `PreToolUse` hook responses for one run.
///
/// Mirrors the semantics of the retired stdio control protocol: bypass mode
/// only intercepts `AskUserQuestion`; approvals mode routes every tool
/// through the chro approval flow; plan mode gates `ExitPlanMode` on a plan
/// approval and auto-allows the implementation tools afterwards (the session
/// itself stays in plan mode, so the hook decision is what unlocks writes).
pub struct PermissionBroker {
    mode: PermissionMode,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
    plan_approved: AtomicBool,
    cancel: CancellationToken,
    sink: LogLineSink,
}

const EXIT_PLAN_MODE: &str = "ExitPlanMode";
const ASK_USER_QUESTION: &str = "AskUserQuestion";

impl PermissionBroker {
    pub fn new(
        mode: PermissionMode,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        sink: LogLineSink,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            mode,
            approvals,
            plan_approved: AtomicBool::new(false),
            cancel,
            sink,
        })
    }

    pub async fn decide(&self, payload: &Value) -> Value {
        let tool_name = payload
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let tool_input = payload
            .get("tool_input")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let call_id = payload
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        if tool_name == ASK_USER_QUESTION {
            return self.answer_question(&tool_name, tool_input).await;
        }

        match self.mode {
            PermissionMode::BypassPermissions => no_opinion(),
            PermissionMode::Default => self.approve_tool(&tool_name, &call_id, false).await,
            PermissionMode::Plan => {
                if tool_name == EXIT_PLAN_MODE {
                    self.approve_tool(&tool_name, &call_id, true).await
                } else if self.plan_approved.load(Ordering::Relaxed) {
                    allow_decision("Plan approved by user", None)
                } else {
                    // Defer to Claude's native plan-mode policy (reads pass,
                    // writes are blocked until the plan is approved).
                    no_opinion()
                }
            }
        }
    }

    async fn approve_tool(&self, tool_name: &str, call_id: &str, is_plan_gate: bool) -> Value {
        let Some(approvals) = self.approvals.as_ref() else {
            return deny_decision("Approval service unavailable");
        };

        let status = async {
            let approval_id = approvals.create_tool_approval(tool_name).await?;
            approvals
                .wait_tool_approval(&approval_id, self.cancel.clone())
                .await
        }
        .await;

        let status = match status {
            Ok(status) => status,
            Err(err) => {
                tracing::warn!(%tool_name, error = %err, "tool approval flow failed");
                return deny_decision(&format!("Approval flow failed: {err}"));
            }
        };

        self.log_approval_response(call_id, tool_name, &status)
            .await;

        match status {
            ApprovalOutcome::Approved => {
                if is_plan_gate {
                    self.plan_approved.store(true, Ordering::Relaxed);
                }
                allow_decision("Approved by user", None)
            }
            ApprovalOutcome::Denied { reason } => {
                deny_decision(&format!("Denied by user: {}", reason.unwrap_or_default()))
            }
            ApprovalOutcome::TimedOut => deny_decision("Approval request timed out"),
            ApprovalOutcome::Pending => deny_decision("Approval still pending"),
        }
    }

    async fn answer_question(&self, tool_name: &str, tool_input: Value) -> Value {
        let Some(approvals) = self.approvals.as_ref() else {
            return deny_decision("Question service unavailable");
        };

        let status = async {
            let approval_id = approvals
                .create_question_approval(tool_name, tool_input.clone())
                .await?;
            approvals
                .wait_question_answer(&approval_id, self.cancel.clone())
                .await
        }
        .await;

        match status {
            Ok(QuestionStatus::Answered { answers }) => {
                let mut input = tool_input.as_object().cloned().unwrap_or_default();
                input.insert(
                    "answers".to_string(),
                    serde_json::to_value(answers).unwrap_or(Value::Null),
                );
                allow_decision("Answered via chro", Some(Value::Object(input)))
            }
            Ok(QuestionStatus::TimedOut) => deny_decision("Question request timed out"),
            Err(err) => {
                tracing::warn!(error = %err, "question flow failed");
                deny_decision(&format!("Question flow failed: {err}"))
            }
        }
    }

    /// Emit the canonical `approval_response` stream-json line so the log
    /// processor renders denials/timeouts as user feedback.
    async fn log_approval_response(
        &self,
        call_id: &str,
        tool_name: &str,
        status: &ApprovalOutcome,
    ) {
        let stream_status = match status {
            ApprovalOutcome::Pending => ApprovalStatus::Pending,
            ApprovalOutcome::Approved => ApprovalStatus::Approved,
            ApprovalOutcome::Denied { reason } => ApprovalStatus::Denied {
                reason: reason.clone(),
            },
            ApprovalOutcome::TimedOut => ApprovalStatus::TimedOut,
        };
        let line = json!({
            "type": "approval_response",
            "call_id": call_id,
            "tool_name": tool_name,
            "approval_status": stream_status,
        });
        self.sink.write_json(&line).await;
    }
}

fn allow_decision(reason: &str, updated_input: Option<Value>) -> Value {
    let mut output = json!({
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "permissionDecisionReason": reason,
    });
    if let Some(input) = updated_input {
        output["updatedInput"] = input;
    }
    json!({ "hookSpecificOutput": output })
}

fn deny_decision(reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
}

fn no_opinion() -> Value {
    json!({})
}

#[derive(Clone)]
struct HookServerState {
    token: String,
    events: UnboundedSender<HookEvent>,
    broker: Arc<PermissionBroker>,
}

/// The per-run hook receiver. Shut down by the run supervisor.
pub struct ClaudeHookServer {
    pub endpoint: HookEndpoint,
    shutdown: CancellationToken,
}

impl ClaudeHookServer {
    pub async fn start(
        events: UnboundedSender<HookEvent>,
        broker: Arc<PermissionBroker>,
    ) -> Result<Self, ExecutorError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(ExecutorError::Io)?;
        let port = listener.local_addr().map_err(ExecutorError::Io)?.port();
        let token = uuid::Uuid::new_v4().simple().to_string();

        let state = HookServerState {
            token: token.clone(),
            events,
            broker,
        };
        let router = Router::new()
            .route("/hook", post(handle_hook))
            .with_state(state);

        let shutdown = CancellationToken::new();
        let server_shutdown = shutdown.clone();
        tokio::spawn(async move {
            let serve = axum::serve(listener, router)
                .with_graceful_shutdown(server_shutdown.cancelled_owned());
            if let Err(err) = serve.await {
                tracing::warn!(error = %err, "claude hook server terminated abnormally");
            }
        });

        Ok(Self {
            endpoint: HookEndpoint { port, token },
            shutdown,
        })
    }

    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }
}

impl Drop for ClaudeHookServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn handle_hook(
    State(state): State<HookServerState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let authorized = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|token| token == state.token)
        .unwrap_or(false);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, Json(json!({})));
    }

    let event_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if event_name == "PreToolUse" {
        let decision = state.broker.decide(&payload).await;
        return (StatusCode::OK, Json(decision));
    }

    let _ = state
        .events
        .send(HookEvent::from_payload(&event_name, payload));
    (StatusCode::OK, Json(json!({})))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use async_trait::async_trait;
    use tokio::sync::mpsc;

    use super::*;
    use crate::approvals::ExecutorApprovalError;
    use crate::stdout_dup::create_log_line_pipe;

    struct StaticApprovals {
        tool_status: ApprovalOutcome,
        answers: HashMap<String, String>,
    }

    #[async_trait]
    impl ExecutorApprovalService for StaticApprovals {
        async fn create_tool_approval(&self, _: &str) -> Result<String, ExecutorApprovalError> {
            Ok("approval-1".to_string())
        }
        async fn create_question_approval(
            &self,
            _: &str,
            _: Value,
        ) -> Result<String, ExecutorApprovalError> {
            Ok("question-1".to_string())
        }
        async fn wait_tool_approval(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<ApprovalOutcome, ExecutorApprovalError> {
            Ok(self.tool_status.clone())
        }
        async fn wait_question_answer(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<QuestionStatus, ExecutorApprovalError> {
            Ok(QuestionStatus::Answered {
                answers: self.answers.clone(),
            })
        }
    }

    fn broker_with(
        mode: PermissionMode,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
    ) -> Arc<PermissionBroker> {
        let (_, write) = create_log_line_pipe().unwrap();
        PermissionBroker::new(
            mode,
            approvals,
            LogLineSink::new(write),
            CancellationToken::new(),
        )
    }

    fn pre_tool_use(tool: &str, input: Value) -> Value {
        json!({
            "hook_event_name": "PreToolUse",
            "tool_name": tool,
            "tool_input": input,
            "tool_use_id": "call-1",
        })
    }

    #[tokio::test]
    async fn bypass_mode_has_no_opinion_on_regular_tools() {
        let broker = broker_with(PermissionMode::BypassPermissions, None);
        let decision = broker
            .decide(&pre_tool_use("Bash", json!({"command": "ls"})))
            .await;
        assert_eq!(decision, json!({}));
    }

    #[tokio::test]
    async fn approvals_mode_allows_approved_tools() {
        let approvals: Arc<dyn ExecutorApprovalService> = Arc::new(StaticApprovals {
            tool_status: ApprovalOutcome::Approved,
            answers: HashMap::new(),
        });
        let broker = broker_with(PermissionMode::Default, Some(approvals));
        let decision = broker
            .decide(&pre_tool_use("Bash", json!({"command": "ls"})))
            .await;
        assert_eq!(
            decision["hookSpecificOutput"]["permissionDecision"],
            json!("allow")
        );
    }

    #[tokio::test]
    async fn approvals_mode_denies_with_user_reason() {
        let approvals: Arc<dyn ExecutorApprovalService> = Arc::new(StaticApprovals {
            tool_status: ApprovalOutcome::Denied {
                reason: Some("not now".to_string()),
            },
            answers: HashMap::new(),
        });
        let broker = broker_with(PermissionMode::Default, Some(approvals));
        let decision = broker
            .decide(&pre_tool_use("Write", json!({"file_path": "x"})))
            .await;
        assert_eq!(
            decision["hookSpecificOutput"]["permissionDecision"],
            json!("deny")
        );
        assert!(
            decision["hookSpecificOutput"]["permissionDecisionReason"]
                .as_str()
                .unwrap()
                .contains("not now")
        );
    }

    #[tokio::test]
    async fn questions_are_answered_via_updated_input() {
        let mut answers = HashMap::new();
        answers.insert("favorite color?".to_string(), "turquoise".to_string());
        let approvals: Arc<dyn ExecutorApprovalService> = Arc::new(StaticApprovals {
            tool_status: ApprovalOutcome::Approved,
            answers,
        });
        let broker = broker_with(PermissionMode::BypassPermissions, Some(approvals));
        let decision = broker
            .decide(&pre_tool_use(
                "AskUserQuestion",
                json!({"questions": [{"question": "favorite color?"}]}),
            ))
            .await;
        let output = &decision["hookSpecificOutput"];
        assert_eq!(output["permissionDecision"], json!("allow"));
        assert_eq!(
            output["updatedInput"]["answers"]["favorite color?"],
            json!("turquoise")
        );
        // The original questions must survive: the tool validates its input.
        assert!(output["updatedInput"]["questions"].is_array());
    }

    #[tokio::test]
    async fn plan_mode_unlocks_tools_after_exit_plan_mode_approval() {
        let approvals: Arc<dyn ExecutorApprovalService> = Arc::new(StaticApprovals {
            tool_status: ApprovalOutcome::Approved,
            answers: HashMap::new(),
        });
        let broker = broker_with(PermissionMode::Plan, Some(approvals));

        // Before approval: defer to native plan-mode policy.
        let before = broker
            .decide(&pre_tool_use("Write", json!({"file_path": "x"})))
            .await;
        assert_eq!(before, json!({}));

        let gate = broker
            .decide(&pre_tool_use("ExitPlanMode", json!({"plan": "do it"})))
            .await;
        assert_eq!(
            gate["hookSpecificOutput"]["permissionDecision"],
            json!("allow")
        );

        let after = broker
            .decide(&pre_tool_use("Write", json!({"file_path": "x"})))
            .await;
        assert_eq!(
            after["hookSpecificOutput"]["permissionDecision"],
            json!("allow")
        );
    }

    #[tokio::test]
    async fn server_routes_events_and_rejects_bad_tokens() {
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let broker = broker_with(PermissionMode::BypassPermissions, None);
        let server = ClaudeHookServer::start(events_tx, broker).await.unwrap();
        let url = format!("http://127.0.0.1:{}/hook", server.endpoint.port);

        let client = reqwest_lite_post(
            &url,
            Some(&server.endpoint.token),
            &json!({
                "hook_event_name": "Stop",
                "session_id": "s-1",
                "transcript_path": "/tmp/t.jsonl",
            }),
        )
        .await;
        assert_eq!(client.0, 200);

        let event = events_rx.recv().await.expect("event forwarded");
        assert_eq!(event.kind, HookEventKind::Stop);
        assert_eq!(event.session_id.as_deref(), Some("s-1"));

        let unauthorized = reqwest_lite_post(&url, None, &json!({"hook_event_name": "Stop"})).await;
        assert_eq!(unauthorized.0, 401);

        server.shutdown();
    }

    /// Minimal HTTP POST helper so the test does not pull an HTTP client
    /// dependency into the crate.
    async fn reqwest_lite_post(url: &str, token: Option<&str>, body: &Value) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let address = url
            .strip_prefix("http://")
            .and_then(|rest| rest.split('/').next())
            .unwrap();
        let path = "/hook";
        let payload = serde_json::to_string(body).unwrap();
        let token_header = token
            .map(|t| format!("{HOOK_TOKEN_HEADER}: {t}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\n{token_header}Content-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );

        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        let status = response
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, response)
    }
}
