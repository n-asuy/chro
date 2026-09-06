//! Codex app server client implementation.

use std::{
    collections::{HashMap, VecDeque},
    io,
    sync::{Arc, OnceLock},
};

use approvals::{APPROVAL_TIMEOUT_SECONDS, ApprovalStatus};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use codex_app_server_protocol::{
    ApplyPatchApprovalResponse, AskForApproval, ClientInfo, ClientNotification,
    CommandExecutionApprovalDecision, CommandExecutionRequestApprovalResponse,
    ExecCommandApprovalResponse, FileChangeApprovalDecision, FileChangeRequestApprovalResponse,
    GetAuthStatusParams, GetAuthStatusResponse, InitializeCapabilities, InitializeParams,
    InitializeResponse, JSONRPCError, JSONRPCNotification, JSONRPCRequest, JSONRPCResponse,
    McpServerElicitationRequestParams, McpServerElicitationRequestResponse, RequestId, SandboxMode,
    ServerRequest, TurnStartResponse, UserInput,
};
use codex_protocol::protocol::ReviewDecision;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{self, Value};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt, BufWriter},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use super::jsonrpc::{JsonRpcCallbacks, JsonRpcPeer};
use crate::{
    approvals::{ExecutorApprovalError, ExecutorApprovalService, QuestionStatus},
    executors::ExecutorError,
};

use super::mcp_approval::{
    MCP_APPROVAL_DECISION_KEY, MCP_APPROVAL_TOOL_NAME, McpApprovalDecision, McpApprovalPrompt,
    elicitation_response, unsupported_elicitation_response,
};
use super::normalize_logs::Approval;

pub struct AppServerClient {
    rpc: OnceLock<JsonRpcPeer>,
    log_writer: LogWriter,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
    conversation_id: Mutex<Option<String>>,
    pending_feedback: Mutex<VecDeque<String>>,
    auto_approve: bool,
    cancel: CancellationToken,
}

/// A JSON-RPC request to the agent server.
///
/// The protocol crate models requests as one wide enum whose params structs
/// carry every field the server version it was generated from understood.
/// Serializing those emits the fields Chro never sets as explicit nulls, and a
/// server that has since dropped a field rejects the whole request because the
/// key is present at all (`permissionProfile` was removed this way). Spelling
/// out the request here means Chro sends exactly the fields it chose, which is
/// the mirror image of what [`CompatibleThreadResponse`] does for responses.
#[derive(Debug, Serialize)]
struct Request<P> {
    method: &'static str,
    #[serde(rename = "id")]
    request_id: RequestId,
    params: P,
}

/// The `thread/start` parameters Chro sets. See [`Request`] for why these are
/// not the protocol crate's `ThreadStartParams`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<AskForApproval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub persist_extended_history: bool,
}

/// The `thread/fork` parameters Chro sets.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkRequest {
    pub thread_id: String,
    #[serde(flatten)]
    pub start: ThreadStartRequest,
    /// Return thread metadata without `thread.turns`. Chro only needs the
    /// forked thread id, and skipping history also keeps thread items added by
    /// a newer app server out of the response decoder.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub exclude_turns: bool,
}

/// The `turn/start` parameters Chro sets.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnStartRequest {
    thread_id: String,
    input: Vec<UserInput>,
}

/// The subset of thread start/fork responses that Chro consumes.
///
/// Deserializing the complete protocol response makes Chro fail when a newer
/// Codex app-server adds an enum variant to an otherwise unused field (for
/// example `serviceTier: "default"`) or a new `ThreadItem` variant. Keeping the
/// response shape deliberately narrow lets serde ignore those fields while we
/// retain the metadata required by the executor and log normalizer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibleThreadResponse {
    pub thread: ThreadMetadata,
    pub model: String,
    /// Kept as the raw string the server reported. Chro only ever displays it,
    /// and the set of levels grows with the model catalog (`max` and `ultra`
    /// arrived with GPT-6), so decoding it into a fixed enum would fail the
    /// whole request on a level the pinned protocol crate has not heard of.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ThreadMetadata {
    pub id: String,
}

impl AppServerClient {
    pub fn new(
        log_writer: LogWriter,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        auto_approve: bool,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            rpc: OnceLock::new(),
            log_writer,
            approvals,
            auto_approve,
            conversation_id: Mutex::new(None),
            pending_feedback: Mutex::new(VecDeque::new()),
            cancel,
        })
    }

    pub fn connect(&self, peer: JsonRpcPeer) {
        let _ = self.rpc.set(peer);
    }

    fn rpc(&self) -> &JsonRpcPeer {
        self.rpc.get().expect("Codex RPC peer not attached")
    }

    pub async fn initialize(&self) -> Result<(), ExecutorError> {
        // `initialize` and `getAuthStatus` params describe one narrow request
        // each rather than the server's whole configuration surface, so reusing
        // the protocol crate's structs for them is safe.
        let request = self.request(
            "initialize",
            InitializeParams {
                client_info: ClientInfo {
                    name: "vibe-codex-executor".to_string(),
                    title: None,
                    version: env!("CARGO_PKG_VERSION").to_string(),
                },
                capabilities: Some(InitializeCapabilities {
                    experimental_api: true,
                    ..Default::default()
                }),
            },
        );

        self.send_request::<InitializeResponse, _>(request).await?;
        self.send_message(&ClientNotification::Initialized).await
    }

    pub async fn new_conversation(
        &self,
        params: ThreadStartRequest,
    ) -> Result<CompatibleThreadResponse, ExecutorError> {
        self.send_request(self.request("thread/start", params))
            .await
    }

    pub async fn fork_conversation(
        &self,
        params: ThreadForkRequest,
    ) -> Result<CompatibleThreadResponse, ExecutorError> {
        self.send_request(self.request("thread/fork", params)).await
    }

    pub async fn send_user_message(
        &self,
        conversation_id: String,
        message: String,
    ) -> Result<TurnStartResponse, ExecutorError> {
        let request = self.request(
            "turn/start",
            TurnStartRequest {
                thread_id: conversation_id,
                input: vec![UserInput::Text {
                    text: message,
                    text_elements: vec![],
                }],
            },
        );
        self.send_request(request).await
    }

    pub async fn get_auth_status(&self) -> Result<GetAuthStatusResponse, ExecutorError> {
        let request = self.request(
            "getAuthStatus",
            GetAuthStatusParams {
                include_token: Some(true),
                refresh_token: Some(false),
            },
        );
        self.send_request(request).await
    }

    async fn handle_server_request(
        &self,
        peer: &JsonRpcPeer,
        request: ServerRequest,
    ) -> Result<(), ExecutorError> {
        match request {
            ServerRequest::CommandExecutionRequestApproval { request_id, params } => {
                // Keep the conversation lifecycle keyed by the item id used by
                // item/started and item/completed; approval_id is request-scoped.
                let tool_call_id = &params.item_id;
                let status = match self
                    .request_tool_approval("bash", "codex.exec_command", tool_call_id)
                    .await
                {
                    Ok(status) => status,
                    Err(err) => {
                        tracing::error!("failed to request command approval: {err}");
                        ApprovalStatus::Denied {
                            reason: Some("approval service error".to_string()),
                        }
                    }
                };
                self.log_writer
                    .log_raw(
                        &Approval::approval_response(
                            tool_call_id.to_string(),
                            "codex.exec_command".to_string(),
                            status.clone(),
                        )
                        .raw(),
                    )
                    .await?;

                let (decision, feedback) = self.review_decision(&status).await?;
                let response = CommandExecutionRequestApprovalResponse {
                    decision: CommandExecutionApprovalDecision::from(decision),
                };
                send_server_response(peer, request_id, response).await?;
                if let Some(message) = feedback {
                    tracing::debug!("queueing exec denial feedback: {message}");
                    self.enqueue_feedback(message).await;
                }
                Ok(())
            }
            ServerRequest::FileChangeRequestApproval { request_id, params } => {
                let status = match self
                    .request_tool_approval("edit", "codex.apply_patch", &params.item_id)
                    .await
                {
                    Ok(status) => status,
                    Err(err) => {
                        tracing::error!("failed to request patch approval: {err}");
                        ApprovalStatus::Denied {
                            reason: Some("approval service error".to_string()),
                        }
                    }
                };
                self.log_writer
                    .log_raw(
                        &Approval::approval_response(
                            params.item_id.clone(),
                            "codex.apply_patch".to_string(),
                            status.clone(),
                        )
                        .raw(),
                    )
                    .await?;
                let (decision, feedback) = self.review_decision(&status).await?;
                let response = FileChangeRequestApprovalResponse {
                    decision: file_change_decision(decision),
                };
                send_server_response(peer, request_id, response).await?;
                if let Some(message) = feedback {
                    tracing::debug!("queueing patch denial feedback: {message}");
                    self.enqueue_feedback(message).await;
                }
                Ok(())
            }
            ServerRequest::ApplyPatchApproval { request_id, params } => {
                let status = match self
                    .request_tool_approval("edit", "codex.apply_patch", &params.call_id)
                    .await
                {
                    Ok(status) => status,
                    Err(err) => {
                        tracing::error!("failed to request patch approval: {err}");
                        ApprovalStatus::Denied {
                            reason: Some("approval service error".to_string()),
                        }
                    }
                };
                self.log_writer
                    .log_raw(
                        &Approval::approval_response(
                            params.call_id,
                            "codex.apply_patch".to_string(),
                            status.clone(),
                        )
                        .raw(),
                    )
                    .await?;
                let (decision, feedback) = self.review_decision(&status).await?;
                let response = ApplyPatchApprovalResponse { decision };
                send_server_response(peer, request_id, response).await?;
                if let Some(message) = feedback {
                    tracing::debug!("queueing patch denial feedback: {message}");
                    self.enqueue_feedback(message).await;
                }
                Ok(())
            }
            ServerRequest::ExecCommandApproval { request_id, params } => {
                let status = match self
                    .request_tool_approval("bash", "codex.exec_command", &params.call_id)
                    .await
                {
                    Ok(status) => status,
                    Err(err) => {
                        tracing::error!("failed to request command approval: {err}");
                        ApprovalStatus::Denied {
                            reason: Some("approval service error".to_string()),
                        }
                    }
                };
                self.log_writer
                    .log_raw(
                        &Approval::approval_response(
                            params.call_id,
                            "codex.exec_command".to_string(),
                            status.clone(),
                        )
                        .raw(),
                    )
                    .await?;

                let (decision, feedback) = self.review_decision(&status).await?;
                let response = ExecCommandApprovalResponse { decision };
                send_server_response(peer, request_id, response).await?;
                if let Some(message) = feedback {
                    tracing::debug!("queueing exec denial feedback: {message}");
                    self.enqueue_feedback(message).await;
                }
                Ok(())
            }
            ServerRequest::McpServerElicitationRequest { request_id, params } => {
                let response = self.resolve_mcp_elicitation(params).await;
                send_server_response(peer, request_id, response).await
            }
            other => {
                // Every server-initiated request must be answered, and answering
                // must not end the session. The read loop treats an error here as
                // end-of-stream, so failing an unknown request stops the run while
                // the agent server waits forever for a reply that never comes. A
                // null result lets the server fall back and the turn continue.
                tracing::warn!("unsupported server request, replying empty: {other:?}");
                send_server_response(peer, other.id().clone(), Value::Null).await
            }
        }
    }

    /// Answers an MCP elicitation. Approval-kind elicitations go to the user as
    /// an approval; anything else is declined, because presenting a form this
    /// client cannot render would be worse than telling the server no.
    ///
    /// No approval entry is written to the conversation log. Exec and patch
    /// approvals log one because the tool event that follows reclaims it by
    /// call id, and the elicitation carries no call id to reclaim with. The MCP
    /// tool item already shows the call running, then completed or failed.
    async fn resolve_mcp_elicitation(
        &self,
        params: McpServerElicitationRequestParams,
    ) -> McpServerElicitationRequestResponse {
        let Some(prompt) = McpApprovalPrompt::from_elicitation(&params) else {
            tracing::info!(
                server = %params.server_name,
                "declining MCP elicitation that is not an approval request"
            );
            return unsupported_elicitation_response();
        };

        if self.auto_approve {
            return elicitation_response(McpApprovalDecision::Allow);
        }

        let decision = match self.request_mcp_decision(&prompt).await {
            Ok(decision) => decision,
            Err(err) => {
                tracing::error!("failed to request MCP tool approval: {err}");
                McpApprovalDecision::Deny
            }
        };

        elicitation_response(decision)
    }

    async fn request_mcp_decision(
        &self,
        prompt: &McpApprovalPrompt,
    ) -> Result<McpApprovalDecision, ExecutorError> {
        let approval_service = self
            .approvals
            .as_ref()
            .ok_or(ExecutorApprovalError::ServiceUnavailable)?;

        let tool_input = serde_json::to_value(prompt)
            .map_err(|err| ExecutorError::Io(io::Error::other(err.to_string())))?;
        let approval_id = approval_service
            .create_question_approval(MCP_APPROVAL_TOOL_NAME, tool_input)
            .await?;

        let answered = approval_service
            .wait_question_answer(&approval_id, self.cancel.clone())
            .await?;

        // An answer that names no decision, or names one this build does not
        // know, is not consent.
        Ok(match answered {
            QuestionStatus::Answered { answers } => answers
                .get(MCP_APPROVAL_DECISION_KEY)
                .and_then(|id| McpApprovalDecision::from_id(id))
                .unwrap_or(McpApprovalDecision::Deny),
            // Approved without naming a variant (the CLI can do this): grant the
            // narrowest thing that was asked for, this call only.
            QuestionStatus::Resolved { approved: true } => McpApprovalDecision::Allow,
            QuestionStatus::Resolved { approved: false } | QuestionStatus::TimedOut => {
                McpApprovalDecision::Deny
            }
        })
    }

    /// Records a pending approval in the conversation log. Best-effort: losing
    /// the log line costs a rendered row, not the approval itself.
    async fn log_approval_requested(&self, call_id: &str, tool_name: &str, approval_id: &str) {
        let now = Utc::now();
        if let Err(err) = self
            .log_writer
            .log_raw(
                &Approval::approval_requested(
                    call_id.to_string(),
                    tool_name.to_string(),
                    approval_id.to_string(),
                    now.to_rfc3339(),
                    (now + Duration::seconds(APPROVAL_TIMEOUT_SECONDS)).to_rfc3339(),
                )
                .raw(),
            )
            .await
        {
            tracing::warn!(
                "failed to log approval request for call_id={call_id}, tool={tool_name}: {err}"
            );
        }
    }

    async fn request_tool_approval(
        &self,
        tool_name: &str,
        display_tool_name: &str,
        tool_call_id: &str,
    ) -> Result<ApprovalStatus, ExecutorError> {
        if self.auto_approve {
            return Ok(ApprovalStatus::Approved);
        }

        let approval_service = self
            .approvals
            .as_ref()
            .ok_or(ExecutorApprovalError::ServiceUnavailable)?;

        let approval_id = approval_service.create_tool_approval(tool_name).await?;
        self.log_approval_requested(tool_call_id, display_tool_name, &approval_id)
            .await;

        Ok(approval_service
            .wait_tool_approval(&approval_id, self.cancel.clone())
            .await?)
    }

    pub async fn register_session(&self, conversation_id: &str) -> Result<(), ExecutorError> {
        {
            let mut guard: tokio::sync::MutexGuard<'_, Option<String>> =
                self.conversation_id.lock().await;
            guard.replace(conversation_id.to_string());
        }
        self.flush_pending_feedback().await;
        Ok(())
    }

    async fn send_message<M>(&self, message: &M) -> Result<(), ExecutorError>
    where
        M: Serialize + Sync,
    {
        self.rpc().send(message).await
    }

    fn request<P>(&self, method: &'static str, params: P) -> Request<P> {
        Request {
            method,
            request_id: self.next_request_id(),
            params,
        }
    }

    async fn send_request<R, P>(&self, request: Request<P>) -> Result<R, ExecutorError>
    where
        R: DeserializeOwned + std::fmt::Debug,
        P: Serialize + Sync,
    {
        self.rpc()
            .request(request.request_id.clone(), &request, request.method)
            .await
    }

    fn next_request_id(&self) -> RequestId {
        self.rpc().next_request_id()
    }

    async fn review_decision(
        &self,
        status: &ApprovalStatus,
    ) -> Result<(ReviewDecision, Option<String>), ExecutorError> {
        if self.auto_approve {
            return Ok((ReviewDecision::ApprovedForSession, None));
        }

        let outcome = match status {
            ApprovalStatus::Approved => (ReviewDecision::Approved, None),
            ApprovalStatus::Denied { reason } => {
                let feedback = reason
                    .as_ref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                if feedback.is_some() {
                    (ReviewDecision::Abort, feedback)
                } else {
                    (ReviewDecision::Denied, None)
                }
            }
            ApprovalStatus::TimedOut => (ReviewDecision::Denied, None),
            ApprovalStatus::Pending => (ReviewDecision::Denied, None),
        };
        Ok(outcome)
    }

    async fn enqueue_feedback(&self, message: String) {
        if message.trim().is_empty() {
            return;
        }
        let mut guard = self.pending_feedback.lock().await;
        guard.push_back(message);
    }

    async fn flush_pending_feedback(&self) {
        let messages: Vec<String> = {
            let mut guard = self.pending_feedback.lock().await;
            guard.drain(..).collect()
        };

        if messages.is_empty() {
            return;
        }

        let Some(conversation_id) = self.conversation_id.lock().await.clone() else {
            tracing::warn!(
                "pending Codex feedback but conversation id unavailable; dropping {} messages",
                messages.len()
            );
            return;
        };

        for message in messages {
            let trimmed = message.trim();
            if trimmed.is_empty() {
                continue;
            }
            self.spawn_feedback_message(conversation_id.clone(), trimmed.to_string());
        }
    }

    fn spawn_feedback_message(&self, conversation_id: String, feedback: String) {
        let peer = self.rpc().clone();
        let request = Request {
            method: "turn/start",
            request_id: peer.next_request_id(),
            params: TurnStartRequest {
                thread_id: conversation_id,
                input: vec![UserInput::Text {
                    text: format!("User feedback: {feedback}"),
                    text_elements: vec![],
                }],
            },
        };
        tokio::spawn(async move {
            if let Err(err) = peer
                .request::<TurnStartResponse, _>(
                    request.request_id.clone(),
                    &request,
                    request.method,
                )
                .await
            {
                tracing::error!("failed to send feedback follow-up message: {err}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app server rejects a request that carries a field it has retired,
    /// even when the value is `null`, so an unset field must not reach the wire
    /// at all.
    #[test]
    fn thread_start_request_omits_fields_chro_did_not_set() {
        let request = Request {
            method: "thread/start",
            request_id: RequestId::Integer(7),
            params: ThreadStartRequest {
                model: Some("gpt-6-astra".to_string()),
                cwd: Some("/workspace".to_string()),
                persist_extended_history: true,
                ..Default::default()
            },
        };

        let value = serde_json::to_value(&request).expect("request should serialize");

        assert_eq!(value["method"], "thread/start");
        assert_eq!(value["id"], 7);
        let params = value["params"]
            .as_object()
            .expect("params should be an object");
        let mut keys: Vec<&str> = params.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["cwd", "model", "persistExtendedHistory"]);
    }

    #[test]
    fn thread_fork_request_omits_fields_chro_did_not_set() {
        let request = ThreadForkRequest {
            thread_id: "thread-1".to_string(),
            start: ThreadStartRequest {
                model: Some("gpt-6-astra".to_string()),
                ..Default::default()
            },
            exclude_turns: true,
        };

        let value = serde_json::to_value(&request).expect("fork params should serialize");

        let params = value.as_object().expect("params should be an object");
        let mut keys: Vec<&str> = params.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["excludeTurns", "model", "threadId"]);
    }

    #[test]
    fn turn_start_request_omits_fields_chro_did_not_set() {
        let request = TurnStartRequest {
            thread_id: "thread-1".to_string(),
            input: vec![UserInput::Text {
                text: "hello".to_string(),
                text_elements: vec![],
            }],
        };

        let value = serde_json::to_value(&request).expect("turn params should serialize");

        let params = value.as_object().expect("params should be an object");
        let mut keys: Vec<&str> = params.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["input", "threadId"]);
    }

    /// GPT-6 added `max` and `ultra`; a level the pinned protocol crate has
    /// never heard of must not fail the whole thread response.
    #[test]
    fn thread_start_response_accepts_unknown_reasoning_effort() {
        let response = serde_json::from_value::<CompatibleThreadResponse>(serde_json::json!({
            "thread": { "id": "started-thread", "turns": [] },
            "model": "gpt-6-astra",
            "reasoningEffort": "ultra"
        }))
        .expect("an unknown reasoning level should not prevent decoding thread metadata");

        assert_eq!(response.reasoning_effort.as_deref(), Some("ultra"));
    }

    #[test]
    fn thread_start_response_ignores_unknown_service_tier() {
        let response = serde_json::from_value::<CompatibleThreadResponse>(serde_json::json!({
            "thread": {
                "id": "started-thread",
                "turns": []
            },
            "model": "gpt-5.6",
            "modelProvider": "openai",
            "serviceTier": "default",
            "cwd": "C:\\workspace",
            "reasoningEffort": "high"
        }))
        .expect("unknown service tier should not prevent decoding thread metadata");

        assert_eq!(response.thread.id, "started-thread");
        assert_eq!(response.model, "gpt-5.6");
        assert_eq!(response.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn fork_response_ignores_unknown_thread_items() {
        let response = serde_json::from_value::<CompatibleThreadResponse>(serde_json::json!({
            "thread": {
                "id": "forked-thread",
                "turns": [{
                    "id": "turn-1",
                    "items": [{
                        "type": "subAgentActivity",
                        "id": "sub-agent-1",
                        "status": "completed"
                    }]
                }]
            },
            "model": "gpt-5.4",
            "reasoningEffort": "high"
        }))
        .expect("unknown thread items should not prevent decoding fork metadata");

        assert_eq!(response.thread.id, "forked-thread");
        assert_eq!(response.model, "gpt-5.4");
        assert_eq!(response.reasoning_effort.as_deref(), Some("high"));
    }

    /// Drives a client over an in-memory pipe pair standing in for the agent
    /// server. Returns a writer for server-to-client lines and a reader for the
    /// client's replies.
    struct FakeServer {
        to_client: tokio::io::DuplexStream,
        from_client: tokio::io::Lines<tokio::io::BufReader<tokio::io::DuplexStream>>,
        _client: Arc<AppServerClient>,
    }

    impl FakeServer {
        fn start(auto_approve: bool) -> Self {
            use tokio::io::AsyncBufReadExt;

            let (to_client, client_stdout) = tokio::io::duplex(8 * 1024);
            let (client_stdin, from_client) = tokio::io::duplex(8 * 1024);

            let client = AppServerClient::new(
                LogWriter::new(tokio::io::sink()),
                None,
                auto_approve,
                CancellationToken::new(),
            );
            let (exit_tx, _exit_rx) = tokio::sync::oneshot::channel();
            let peer = super::super::jsonrpc::JsonRpcPeer::spawn(
                client_stdin,
                client_stdout,
                client.clone(),
                super::super::jsonrpc::ExitSignalSender::new(exit_tx),
            );
            client.connect(peer);

            Self {
                to_client,
                from_client: tokio::io::BufReader::new(from_client).lines(),
                _client: client,
            }
        }

        async fn send(&mut self, message: Value) {
            let line = format!("{}\n", serde_json::to_string(&message).unwrap());
            self.to_client.write_all(line.as_bytes()).await.unwrap();
        }

        /// Next reply, or `None` if the client stopped reading and answering.
        async fn next_reply(&mut self) -> Option<Value> {
            let line = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                self.from_client.next_line(),
            )
            .await
            .ok()?
            .ok()??;
            serde_json::from_str(&line).ok()
        }
    }

    fn mcp_approval_request(id: i64) -> Value {
        serde_json::json!({
            "method": "mcpServer/elicitation/request",
            "id": id,
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "serverName": "some_server",
                "mode": "form",
                "_meta": {
                    "codex_approval_kind": "mcp_tool_call",
                    "persist": ["session", "always"],
                },
                "message": "Allow this?",
                "requestedSchema": { "type": "object", "properties": {} },
            },
        })
    }

    #[tokio::test]
    async fn answers_an_mcp_approval_request() {
        let mut server = FakeServer::start(true);
        server.send(mcp_approval_request(7)).await;

        let reply = server.next_reply().await.expect("client should reply");
        assert_eq!(reply["id"], serde_json::json!(7));
        assert_eq!(reply["result"]["action"], serde_json::json!("accept"));
    }

    #[tokio::test]
    async fn keeps_serving_after_a_request_it_does_not_understand() {
        // Regression: an unhandled server request used to end the read loop,
        // which reported the run as finished while the agent server sat waiting
        // for a reply that never came. It must be answered and survived.
        let mut server = FakeServer::start(true);

        server
            .send(serde_json::json!({
                "method": "item/tool/requestUserInput",
                "id": 1,
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "questions": [],
                },
            }))
            .await;

        let reply = server
            .next_reply()
            .await
            .expect("an unhandled request must still be answered");
        assert_eq!(reply["id"], serde_json::json!(1));

        server.send(mcp_approval_request(2)).await;
        let reply = server
            .next_reply()
            .await
            .expect("the session must survive an unhandled request");
        assert_eq!(reply["id"], serde_json::json!(2));
        assert_eq!(reply["result"]["action"], serde_json::json!("accept"));
    }

    #[tokio::test]
    async fn declines_an_elicitation_that_is_not_an_approval() {
        let mut server = FakeServer::start(true);

        server
            .send(serde_json::json!({
                "method": "mcpServer/elicitation/request",
                "id": 3,
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "serverName": "some_server",
                    "mode": "form",
                    "_meta": null,
                    "message": "Which profile?",
                    "requestedSchema": { "type": "object", "properties": {} },
                },
            }))
            .await;

        let reply = server.next_reply().await.expect("client should reply");
        assert_eq!(reply["id"], serde_json::json!(3));
        assert_eq!(
            reply["result"]["action"],
            serde_json::json!("decline"),
            "a form this client cannot render is declined, never left hanging"
        );
    }
}

#[async_trait]
impl JsonRpcCallbacks for AppServerClient {
    async fn on_request(
        &self,
        peer: &JsonRpcPeer,
        raw: &str,
        request: JSONRPCRequest,
    ) -> Result<(), ExecutorError> {
        self.log_writer.log_raw(raw).await?;
        match ServerRequest::try_from(request.clone()) {
            Ok(server_request) => self.handle_server_request(peer, server_request).await,
            Err(err) => {
                tracing::debug!("Unhandled server request `{}`: {err}", request.method);
                let response = JSONRPCResponse {
                    id: request.id,
                    result: Value::Null,
                };
                peer.send(&response).await
            }
        }
    }

    async fn on_response(
        &self,
        _peer: &JsonRpcPeer,
        raw: &str,
        _response: &JSONRPCResponse,
    ) -> Result<(), ExecutorError> {
        self.log_writer.log_raw(raw).await
    }

    async fn on_error(
        &self,
        _peer: &JsonRpcPeer,
        raw: &str,
        _error: &JSONRPCError,
    ) -> Result<(), ExecutorError> {
        self.log_writer.log_raw(raw).await
    }

    async fn on_notification(
        &self,
        _peer: &JsonRpcPeer,
        raw: &str,
        notification: JSONRPCNotification,
    ) -> Result<bool, ExecutorError> {
        self.log_writer.log_raw(raw).await?;

        let method = notification.method.as_str();
        if method == "turn/completed" {
            return Ok(true);
        }

        if !method.starts_with("codex/event") {
            return Ok(false);
        }

        if method.ends_with("turn_aborted") {
            tracing::debug!("codex turn aborted; flushing feedback queue");
            self.flush_pending_feedback().await;
            return Ok(false);
        }

        let has_finished = method
            .strip_prefix("codex/event/")
            .is_some_and(|suffix| suffix == "task_complete");

        Ok(has_finished)
    }

    async fn on_non_json(&self, raw: &str) -> Result<(), ExecutorError> {
        self.log_writer.log_raw(raw).await?;
        Ok(())
    }
}

async fn send_server_response<T>(
    peer: &JsonRpcPeer,
    request_id: RequestId,
    response: T,
) -> Result<(), ExecutorError>
where
    T: Serialize,
{
    let payload = JSONRPCResponse {
        id: request_id,
        result: serde_json::to_value(response)
            .map_err(|err| ExecutorError::Io(io::Error::other(err.to_string())))?,
    };

    peer.send(&payload).await
}

fn file_change_decision(decision: ReviewDecision) -> FileChangeApprovalDecision {
    match decision {
        ReviewDecision::Approved => FileChangeApprovalDecision::Accept,
        ReviewDecision::ApprovedForSession => FileChangeApprovalDecision::AcceptForSession,
        ReviewDecision::Abort => FileChangeApprovalDecision::Cancel,
        ReviewDecision::Denied | ReviewDecision::TimedOut => FileChangeApprovalDecision::Decline,
        ReviewDecision::ApprovedExecpolicyAmendment { .. }
        | ReviewDecision::NetworkPolicyAmendment { .. } => FileChangeApprovalDecision::Accept,
    }
}

#[derive(Clone)]
pub struct LogWriter {
    writer: Arc<Mutex<BufWriter<Box<dyn AsyncWrite + Send + Unpin>>>>,
}

impl LogWriter {
    pub fn new(writer: impl AsyncWrite + Send + Unpin + 'static) -> Self {
        Self {
            writer: Arc::new(Mutex::new(BufWriter::new(Box::new(writer)))),
        }
    }

    pub async fn log_raw(&self, raw: &str) -> Result<(), ExecutorError> {
        let mut guard = self.writer.lock().await;
        guard
            .write_all(raw.as_bytes())
            .await
            .map_err(ExecutorError::Io)?;
        guard.write_all(b"\n").await.map_err(ExecutorError::Io)?;
        guard.flush().await.map_err(ExecutorError::Io)?;
        Ok(())
    }
}
