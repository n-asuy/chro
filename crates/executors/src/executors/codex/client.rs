//! Codex app server client implementation.

use std::{
    collections::VecDeque,
    io,
    sync::{Arc, OnceLock},
};

use approvals::{APPROVAL_TIMEOUT_SECONDS, ApprovalStatus};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use codex_app_server_protocol::{
    ApplyPatchApprovalResponse, ClientInfo, ClientNotification, ClientRequest,
    CommandExecutionApprovalDecision, CommandExecutionRequestApprovalResponse,
    ExecCommandApprovalResponse, FileChangeApprovalDecision, FileChangeRequestApprovalResponse,
    GetAuthStatusParams, GetAuthStatusResponse, InitializeCapabilities, InitializeParams,
    InitializeResponse, JSONRPCError, JSONRPCNotification, JSONRPCRequest, JSONRPCResponse,
    RequestId, ServerRequest, ThreadForkParams, ThreadForkResponse, ThreadStartParams,
    ThreadStartResponse, TurnStartParams, TurnStartResponse, UserInput,
};
use codex_protocol::protocol::ReviewDecision;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{self, Value};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt, BufWriter},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use super::jsonrpc::{JsonRpcCallbacks, JsonRpcPeer};
use crate::{
    approvals::{ExecutorApprovalError, ExecutorApprovalService},
    executors::ExecutorError,
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
        let request = ClientRequest::Initialize {
            request_id: self.next_request_id(),
            params: InitializeParams {
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
        };

        self.send_request::<InitializeResponse>(request, "initialize")
            .await?;
        self.send_message(&ClientNotification::Initialized).await
    }

    pub async fn new_conversation(
        &self,
        params: ThreadStartParams,
    ) -> Result<ThreadStartResponse, ExecutorError> {
        let request = ClientRequest::ThreadStart {
            request_id: self.next_request_id(),
            params,
        };
        self.send_request(request, "thread/start").await
    }

    pub async fn fork_conversation(
        &self,
        params: ThreadForkParams,
    ) -> Result<ThreadForkResponse, ExecutorError> {
        let request = ClientRequest::ThreadFork {
            request_id: self.next_request_id(),
            params,
        };
        self.send_request(request, "thread/fork").await
    }

    pub async fn send_user_message(
        &self,
        conversation_id: String,
        message: String,
    ) -> Result<TurnStartResponse, ExecutorError> {
        let request = ClientRequest::TurnStart {
            request_id: self.next_request_id(),
            params: TurnStartParams {
                thread_id: conversation_id,
                input: vec![UserInput::Text {
                    text: message,
                    text_elements: vec![],
                }],
                ..Default::default()
            },
        };
        self.send_request(request, "turn/start").await
    }

    pub async fn get_auth_status(&self) -> Result<GetAuthStatusResponse, ExecutorError> {
        let request = ClientRequest::GetAuthStatus {
            request_id: self.next_request_id(),
            params: GetAuthStatusParams {
                include_token: Some(true),
                refresh_token: Some(false),
            },
        };
        self.send_request(request, "getAuthStatus").await
    }

    async fn handle_server_request(
        &self,
        peer: &JsonRpcPeer,
        request: ServerRequest,
    ) -> Result<(), ExecutorError> {
        match request {
            ServerRequest::CommandExecutionRequestApproval { request_id, params } => {
                let tool_call_id = params.approval_id.as_deref().unwrap_or(&params.item_id);
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
            _ => {
                tracing::error!("received unsupported server request: {:?}", request);
                Err(
                    ExecutorApprovalError::RequestFailed("unsupported server request".to_string())
                        .into(),
                )
            }
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

        let now = Utc::now();
        let requested_at = now.to_rfc3339();
        let timeout_at = (now + Duration::seconds(APPROVAL_TIMEOUT_SECONDS)).to_rfc3339();
        if let Err(err) = self
            .log_writer
            .log_raw(
                &Approval::approval_requested(
                    tool_call_id.to_string(),
                    display_tool_name.to_string(),
                    approval_id.clone(),
                    requested_at,
                    timeout_at,
                )
                .raw(),
            )
            .await
        {
            tracing::warn!(
                "failed to log approval request for call_id={tool_call_id}, tool={display_tool_name}: {err}"
            );
        }

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

    async fn send_request<R>(&self, request: ClientRequest, label: &str) -> Result<R, ExecutorError>
    where
        R: DeserializeOwned + std::fmt::Debug,
    {
        let request_id = request_id(&request);
        self.rpc().request(request_id, &request, label).await
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
        let request = ClientRequest::TurnStart {
            request_id: peer.next_request_id(),
            params: TurnStartParams {
                thread_id: conversation_id,
                input: vec![UserInput::Text {
                    text: format!("User feedback: {feedback}"),
                    text_elements: vec![],
                }],
                ..Default::default()
            },
        };
        tokio::spawn(async move {
            if let Err(err) = peer
                .request::<TurnStartResponse, _>(request_id(&request), &request, "turn/start")
                .await
            {
                tracing::error!("failed to send feedback follow-up message: {err}");
            }
        });
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

fn request_id(request: &ClientRequest) -> RequestId {
    match request {
        ClientRequest::Initialize { request_id, .. }
        | ClientRequest::ThreadStart { request_id, .. }
        | ClientRequest::ThreadFork { request_id, .. }
        | ClientRequest::GetAuthStatus { request_id, .. }
        | ClientRequest::TurnStart { request_id, .. } => request_id.clone(),
        _ => unreachable!("request_id called for unsupported request variant"),
    }
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
