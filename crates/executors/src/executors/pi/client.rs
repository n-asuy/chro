//! Client for driving a `pi --mode rpc` subprocess.
//!
//! Owns the line-delimited JSON peer: a reader task drains pi's stdout, mirrors
//! every line into the synthetic log stream (so the normalizer renders it), and
//! routes responses, extension-UI prompts, and the terminal `agent_end` event.
//! High-level helpers (`get_state`, `prompt`, `abort`) send commands and await
//! their correlated responses.

use std::{
    collections::HashMap,
    io,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use approvals::ApprovalStatus;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter},
    process::{ChildStdin, ChildStdout},
    sync::{Mutex, oneshot},
};
use tokio_util::sync::CancellationToken;

use super::normalize_logs::PiError;
use super::protocol::{InboundFrame, PiEvent};
use crate::{
    approvals::ExecutorApprovalService,
    executors::{ExecutorError, ExecutorExitResult},
};

/// Sends the run's terminal exit result exactly once.
#[derive(Clone)]
pub struct ExitSignalSender {
    inner: Arc<Mutex<Option<oneshot::Sender<ExecutorExitResult>>>>,
}

impl ExitSignalSender {
    pub fn new(sender: oneshot::Sender<ExecutorExitResult>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Some(sender))),
        }
    }

    pub async fn send(&self, result: ExecutorExitResult) {
        if let Some(sender) = self.inner.lock().await.take() {
            let _ = sender.send(result);
        }
    }
}

/// Async writer that mirrors raw protocol lines into the synthetic stdout pipe
/// consumed by the log normalizer.
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

/// Result delivered to a pending command: the response `data` or an error string.
type ResponseResult = Result<Value, String>;

pub struct PiClient {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<ResponseResult>>>,
    id_counter: AtomicU64,
    log_writer: LogWriter,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
    auto_approve: bool,
    cancel: CancellationToken,
}

impl PiClient {
    pub fn new(
        stdin: ChildStdin,
        log_writer: LogWriter,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        auto_approve: bool,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            id_counter: AtomicU64::new(1),
            log_writer,
            approvals,
            auto_approve,
            cancel,
        })
    }

    /// Spawn the reader task that drains pi's stdout until EOF or `agent_end`.
    pub fn spawn_reader(self: &Arc<Self>, stdout: ChildStdout, exit_tx: ExitSignalSender) {
        let client = self.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        // Mirror every line into the normalizer's input stream.
                        let _ = client.log_writer.log_raw(trimmed).await;

                        if client.route_line(trimmed).await {
                            // Terminal `agent_end` observed.
                            exit_tx.send(ExecutorExitResult::Success).await;
                            break;
                        }
                    }
                    Err(err) => {
                        tracing::warn!("error reading pi stdout: {err}");
                        break;
                    }
                }
            }
            // EOF without an explicit terminal event still completes the run.
            exit_tx.send(ExecutorExitResult::Success).await;
            client.fail_pending("pi process exited").await;
        });
    }

    /// Route one inbound line. Returns true when the run has terminally
    /// completed (`agent_end` with `willRetry == false`).
    async fn route_line(self: &Arc<Self>, line: &str) -> bool {
        match serde_json::from_str::<InboundFrame>(line) {
            Ok(InboundFrame::Response {
                id,
                success,
                data,
                error,
                ..
            }) => {
                if let Some(id) = id {
                    let result = if success {
                        Ok(data.unwrap_or(Value::Null))
                    } else {
                        Err(error.unwrap_or_else(|| "pi command failed".to_string()))
                    };
                    self.resolve(&id, result).await;
                }
                false
            }
            Ok(InboundFrame::ExtensionUiRequest { id, method, .. }) => {
                // Handle out-of-band so a blocking approval never stalls the
                // reader (events must keep draining).
                let client = self.clone();
                tokio::spawn(async move {
                    client.handle_ui_request(id, &method).await;
                });
                false
            }
            Ok(InboundFrame::Event) | Err(_) => match serde_json::from_str::<PiEvent>(line) {
                Ok(PiEvent::AgentEnd { will_retry }) => !will_retry,
                _ => false,
            },
        }
    }

    fn next_id(&self) -> String {
        self.id_counter.fetch_add(1, Ordering::Relaxed).to_string()
    }

    async fn send_value(&self, value: &Value) -> Result<(), ExecutorError> {
        let raw = serde_json::to_string(value)
            .map_err(|err| ExecutorError::Io(io::Error::other(err.to_string())))?;
        let mut guard = self.stdin.lock().await;
        guard
            .write_all(raw.as_bytes())
            .await
            .map_err(ExecutorError::Io)?;
        guard.write_all(b"\n").await.map_err(ExecutorError::Io)?;
        guard.flush().await.map_err(ExecutorError::Io)?;
        Ok(())
    }

    /// Send a command and await its correlated response payload.
    async fn request(&self, mut command: Value, label: &str) -> Result<Value, ExecutorError> {
        let id = self.next_id();
        if let Value::Object(map) = &mut command {
            map.insert("id".to_string(), Value::String(id.clone()));
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        self.send_value(&command).await?;
        match rx.await {
            Ok(Ok(data)) => Ok(data),
            Ok(Err(message)) => Err(ExecutorError::Io(io::Error::other(format!(
                "{label} failed: {message}"
            )))),
            Err(_) => Err(ExecutorError::Io(io::Error::other(format!(
                "{label} response dropped"
            )))),
        }
    }

    async fn resolve(&self, id: &str, result: ResponseResult) {
        if let Some(sender) = self.pending.lock().await.remove(id) {
            let _ = sender.send(result);
        }
    }

    async fn fail_pending(&self, reason: &str) {
        let mut pending = self.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(reason.to_string()));
        }
    }

    /// Query session state (also surfaces the pi session id to the normalizer
    /// via the logged response line).
    pub async fn get_state(&self) -> Result<Value, ExecutorError> {
        self.request(json!({ "type": "get_state" }), "get_state")
            .await
    }

    /// Send a user prompt. Resolves once pi acknowledges preflight; the run
    /// itself completes later via the streamed `agent_end` event.
    pub async fn prompt(&self, message: String) -> Result<(), ExecutorError> {
        self.request(json!({ "type": "prompt", "message": message }), "prompt")
            .await
            .map(|_| ())
    }

    pub async fn abort(&self) -> Result<(), ExecutorError> {
        self.request(json!({ "type": "abort" }), "abort")
            .await
            .map(|_| ())
    }

    /// Write a normalizer-visible error line into the log stream.
    pub async fn log_error(&self, error: PiError) {
        let _ = self.log_writer.log_raw(&error.raw()).await;
    }

    async fn handle_ui_request(&self, id: String, method: &str) {
        let response = match method {
            "confirm" => {
                json!({ "type": "extension_ui_response", "id": id, "confirmed": self.resolve_confirm().await })
            }
            // Side-effect-only and unsupported prompts are dismissed so pi never
            // blocks waiting on a response chro cannot render yet.
            _ => json!({ "type": "extension_ui_response", "id": id, "cancelled": true }),
        };
        if let Err(err) = self.send_value(&response).await {
            tracing::warn!("failed to answer pi extension_ui_request: {err}");
        }
    }

    async fn resolve_confirm(&self) -> bool {
        if self.auto_approve {
            return true;
        }
        let Some(service) = self.approvals.as_ref() else {
            // No approval backend wired: fall back to allowing the action.
            return true;
        };
        match service.create_tool_approval("pi").await {
            Ok(approval_id) => matches!(
                service
                    .wait_tool_approval(&approval_id, self.cancel.clone())
                    .await,
                Ok(ApprovalStatus::Approved)
            ),
            Err(err) => {
                tracing::error!("pi approval request failed: {err}");
                false
            }
        }
    }
}
