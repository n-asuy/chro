//! The device dispatcher: answers the RPC families a paired phone may call.
//!
//! | method | answer |
//! |---|---|
//! | `runtime.clientCapabilities.update` | declares the device's API generation; required before `request` and `subscribe` |
//! | `status.get` | liveness and who answers |
//! | `pairing.exchangeTicket` | swaps the QR ticket for a device-chosen token |
//! | `request` | an allowlisted `/v1` or `/rpc` call, dispatched in-process |
//! | `subscribe` / `subscribe.unsubscribe` | a stream source, as repeated `streaming: true` replies |
//!
//! `request` goes through the same router the HTTP listener serves, as
//! [`Caller::Device`](crate::operator::Caller). The allowlist check runs
//! inside that router against the matched route, so a request reaches a
//! handler only if that exact handler is listed.
//!
//! Each `request` runs on a task its connection owns, under [`Limits`]:
//!
//! | limit | default | on breach |
//! |---|---|---|
//! | requests running per connection | 8 | `runtime_busy`, never started |
//! | requests running on all connections | 32 | `runtime_busy`, never started |
//! | reply bytes queued per connection | 16 MiB | the reply waits |
//! | reply bytes queued on all connections | 64 MiB | the reply waits |
//! | time to answer a request | 5 min | `deadline_exceeded` |
//!
//! A request's slot is held until its reply is queued for the socket, and
//! queued bytes until the socket took them. When the connection closes (the
//! phone left, or was revoked) its requests are cancelled at their next
//! suspension point, and a request that changes something rechecks the
//! device's standing right before its handler runs.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    body::Body,
    extract::{MatchedPath, Request},
    http::{header, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use server_contract::routes::HEADER_REQUEST_ID;
use tokio::{
    sync::{mpsc, OwnedSemaphorePermit, Semaphore},
    task::AbortHandle,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tower::ServiceExt;
use uuid::Uuid;

use super::{
    allowlist,
    binary::{self, Assembly},
    envelope::{ErrorCode, RpcError, RpcReply, RpcRequest, UNKNOWN_ID},
    link::{DeviceGrant, DeviceLink, Standing},
};
use crate::{
    operator::DeviceAdmission,
    routes::{self, stream_sources::StreamSource},
    ApiError, AppState, MAX_IMAGE_UPLOAD_BYTES,
};

/// The device API generation. Raised only when a listed endpoint changes
/// incompatibly; adding endpoints keeps it.
pub(crate) const API_GENERATION: u64 = 1;
/// A device that declares this takes a stream message too large for one reply as
/// ordered `{type:"part", text, final}` replies whose texts join to the message.
pub(crate) const MESSAGE_PARTS_CAPABILITY: &str = "stream.message-parts.v1";
/// The host serves `/streams/session-list` and `GET /rpc/session-list`
/// (architecture doc §27). Phones without it read `/streams/tasks`.
pub(crate) const SESSION_LIST_CAPABILITY: &str = "sessions.list-window.v1";
/// Capabilities the server advertises in `status.get`.
pub(crate) const CAPABILITIES: &[&str] = &[
    "pairing.ticket-exchange.v1",
    MESSAGE_PARTS_CAPABILITY,
    SESSION_LIST_CAPABILITY,
];
/// Largest JSON reply, before encryption and base64.
pub(crate) const MAX_JSON_REPLY_BYTES: usize = 4 * 1024 * 1024;
/// Largest binary reply, across all its chunks.
pub(crate) const MAX_BINARY_REPLY_BYTES: usize = 8 * 1024 * 1024;
/// Largest stream message sent in parts.
pub(crate) const MAX_STREAM_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// Text of one part: escaped into its reply (at most six bytes per byte) it stays
/// under `MAX_JSON_REPLY_BYTES`.
const STREAM_PART_BYTES: usize = 512 * 1024;
pub(crate) const MAX_SUBSCRIPTIONS: usize = 64;
pub(crate) const MAX_PENDING_UPLOADS: usize = 4;

/// How much work devices may have the server do at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Limits {
    pub requests_per_connection: usize,
    pub requests: usize,
    pub queued_bytes_per_connection: usize,
    pub queued_bytes: usize,
    /// From a request's start until its reply is ready to queue.
    pub request_deadline: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            requests_per_connection: 8,
            requests: 32,
            queued_bytes_per_connection: 16 * 1024 * 1024,
            queued_bytes: 64 * 1024 * 1024,
            request_deadline: Duration::from_secs(5 * 60),
        }
    }
}

/// A plaintext frame for the connection's writer to seal and send.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Outbound {
    Text(String),
    Binary(Vec<u8>),
}

impl Outbound {
    fn len(&self) -> usize {
        match self {
            Outbound::Text(text) => text.len(),
            Outbound::Binary(bytes) => bytes.len(),
        }
    }
}

/// A frame in a connection's send queue, holding its share of the queued
/// byte budgets until the writer drops it after sending.
pub(crate) struct Queued {
    pub frame: Outbound,
    _bytes: [OwnedSemaphorePermit; 2],
}

/// One authenticated connection's dispatch state.
pub(crate) struct DeviceSession {
    grant: DeviceGrant,
    outbound: mpsc::Sender<Queued>,
    api_declared: AtomicBool,
    client_capabilities: Mutex<Vec<String>>,
    subscriptions: Mutex<HashMap<String, AbortHandle>>,
    uploads: Mutex<HashMap<String, Assembly>>,
    /// Request slots of this connection.
    requests: Arc<Semaphore>,
    /// Bytes this connection may have queued for its socket.
    queued_bytes: Arc<Semaphore>,
    /// The most bytes one frame is charged, so any frame fits the budgets.
    frame_charge: u32,
    /// Cancelled when the connection ends; its requests stop with it.
    closed: CancellationToken,
    requests_running: TaskTracker,
    dispatcher: Arc<DispatcherInner>,
}

impl DeviceSession {
    fn takes_message_parts(&self) -> bool {
        self.client_capabilities
            .lock()
            .unwrap()
            .iter()
            .any(|capability| capability == MESSAGE_PARTS_CAPABILITY)
    }

    #[cfg(test)]
    pub(crate) fn client_capabilities(&self) -> Vec<String> {
        self.client_capabilities.lock().unwrap().clone()
    }

    /// Bytes queued for the socket and not yet sent.
    #[cfg(test)]
    pub(crate) fn queued_bytes(&self) -> usize {
        self.dispatcher.limits.queued_bytes_per_connection - self.queued_bytes.available_permits()
    }

    /// Wait until every request task of this connection has ended.
    #[cfg(test)]
    pub(crate) async fn requests_ended(&self) {
        self.requests_running.wait().await;
    }

    pub(crate) fn subscription_count(&self) -> usize {
        self.subscriptions.lock().unwrap().len()
    }

    /// Cancel every request and subscription. Called when the connection
    /// ends, however it ends.
    pub(crate) fn close(&self) {
        self.closed.cancel();
        self.requests_running.close();
        for (_, handle) in self.subscriptions.lock().unwrap().drain() {
            handle.abort();
        }
        self.uploads.lock().unwrap().clear();
    }

    /// Queue a frame for the socket once the byte budgets have room. False
    /// when the connection is gone.
    async fn send(&self, frame: Outbound) -> bool {
        let charge = u32::try_from(frame.len())
            .unwrap_or(u32::MAX)
            .clamp(1, self.frame_charge);
        // Always this connection's budget first, then the shared one.
        let Ok(own) = Arc::clone(&self.queued_bytes)
            .acquire_many_owned(charge)
            .await
        else {
            return false;
        };
        let Ok(shared) = Arc::clone(&self.dispatcher.queued_bytes)
            .acquire_many_owned(charge)
            .await
        else {
            return false;
        };
        self.outbound
            .send(Queued {
                frame,
                _bytes: [own, shared],
            })
            .await
            .is_ok()
    }

    async fn reply(&self, reply: RpcReply) {
        self.send(Outbound::Text(reply.to_json())).await;
    }
}

impl Drop for DeviceSession {
    fn drop(&mut self) {
        for (_, handle) in self.subscriptions.get_mut().unwrap().drain() {
            handle.abort();
        }
    }
}

/// Marks a response the device gate refused, so the dispatcher can tell it
/// from a handler's own 403.
#[derive(Debug, Clone, Copy)]
struct DeviceForbidden;

async fn device_gate(request: Request, next: Next) -> Response {
    let permitted = request
        .extensions()
        .get::<MatchedPath>()
        .is_some_and(|matched| allowlist::permits(request.method(), matched.as_str()));
    if !permitted {
        let mut response = StatusCode::FORBIDDEN.into_response();
        response.extensions_mut().insert(DeviceForbidden);
        return response;
    }
    next.run(request).await
}

/// The API router as devices reach it: every route behind the allowlist gate,
/// and activity recorded like the desktop's.
pub(crate) fn device_router(state: AppState) -> Router {
    routes::api_router(state)
        .route_layer(middleware::from_fn(device_gate))
        .layer(middleware::from_fn(routes::rpc::dev_events_recorder))
}

#[derive(Clone)]
pub(crate) struct Dispatcher {
    inner: Arc<DispatcherInner>,
}

struct DispatcherInner {
    router: Router,
    state: AppState,
    link: Arc<dyn DeviceLink>,
    machine_name: String,
    limits: Limits,
    /// Request slots shared by every connection.
    requests: Arc<Semaphore>,
    /// Queued reply bytes shared by every connection.
    queued_bytes: Arc<Semaphore>,
}

impl Dispatcher {
    /// Dispatch to `router`: [`device_router`] in the server.
    pub(crate) fn new(
        state: AppState,
        link: Arc<dyn DeviceLink>,
        router: Router,
        limits: Limits,
    ) -> Self {
        Self {
            inner: Arc::new(DispatcherInner {
                router,
                state,
                link,
                machine_name: whoami::devicename(),
                limits,
                requests: Arc::new(Semaphore::new(limits.requests)),
                queued_bytes: Arc::new(Semaphore::new(limits.queued_bytes)),
            }),
        }
    }

    /// The dispatch state of a new connection whose frames go to `outbound`.
    pub(crate) fn session(
        &self,
        grant: DeviceGrant,
        outbound: mpsc::Sender<Queued>,
    ) -> Arc<DeviceSession> {
        let limits = self.inner.limits;
        let frame_charge = limits
            .queued_bytes_per_connection
            .min(limits.queued_bytes)
            .min(u32::MAX as usize) as u32;
        Arc::new(DeviceSession {
            grant,
            outbound,
            api_declared: AtomicBool::new(false),
            client_capabilities: Mutex::new(Vec::new()),
            subscriptions: Mutex::new(HashMap::new()),
            uploads: Mutex::new(HashMap::new()),
            requests: Arc::new(Semaphore::new(limits.requests_per_connection)),
            queued_bytes: Arc::new(Semaphore::new(limits.queued_bytes_per_connection)),
            frame_charge,
            closed: CancellationToken::new(),
            requests_running: TaskTracker::new(),
            dispatcher: Arc::clone(&self.inner),
        })
    }

    /// Handle one opened text frame. Returns once the request is accepted;
    /// `request` calls keep running on their own task.
    pub(crate) async fn on_text(&self, session: &Arc<DeviceSession>, plaintext: &[u8]) {
        let request = match serde_json::from_slice::<RpcRequest>(plaintext) {
            Ok(request) => request,
            Err(err) => {
                session
                    .reply(RpcReply::failure(
                        UNKNOWN_ID,
                        RpcError::new(ErrorCode::BadRequest, format!("not a request: {err}")),
                    ))
                    .await;
                return;
            }
        };
        if request.id.is_empty() {
            session
                .reply(RpcReply::failure(
                    UNKNOWN_ID,
                    RpcError::new(ErrorCode::BadRequest, "request id must not be empty"),
                ))
                .await;
            return;
        }
        if !token_matches(&request.device_token, &session.grant.token) {
            session
                .reply(RpcReply::failure(
                    request.id,
                    RpcError::new(ErrorCode::Unauthorized, "Device token mismatch"),
                ))
                .await;
            return;
        }
        let id = request.id.clone();
        let outcome = match request.method.as_str() {
            "runtime.clientCapabilities.update" => {
                self.update_capabilities(session, request.params)
            }
            "status.get" => Ok(self.status(session)),
            "pairing.exchangeTicket" => self.exchange_ticket(session, request.params).await,
            "request" => {
                match require_api(session).and_then(|_| parse::<RequestParams>(request.params)) {
                    Ok(params) if params.upload.is_some() => Err(RpcError::new(
                        ErrorCode::InvalidArgument,
                        "uploads travel in binary frames",
                    )),
                    Ok(params) => match self.spawn_request(session, id.clone(), params, None) {
                        Ok(()) => return,
                        Err(err) => Err(err),
                    },
                    Err(err) => Err(err),
                }
            }
            "subscribe" => match require_api(session) {
                Ok(()) => {
                    self.subscribe(session, id, request.params).await;
                    return;
                }
                Err(err) => Err(err),
            },
            "subscribe.unsubscribe" => self.unsubscribe(session, request.params),
            other => Err(RpcError::new(
                ErrorCode::MethodNotFound,
                format!("no method {other}"),
            )),
        };
        session
            .reply(match outcome {
                Ok(result) => RpcReply::success(id, result),
                Err(error) => RpcReply::failure(id, error),
            })
            .await;
    }

    /// Handle one opened binary frame: a chunk of an upload request.
    pub(crate) async fn on_binary(&self, session: &Arc<DeviceSession>, plaintext: &[u8]) {
        let (header, chunk) = match binary::decode(plaintext) {
            Ok(decoded) => decoded,
            Err(err) => {
                session
                    .reply(RpcReply::failure(
                        UNKNOWN_ID,
                        RpcError::new(ErrorCode::BadRequest, err.0),
                    ))
                    .await;
                return;
            }
        };
        let position = match binary::position(&header) {
            Ok(position) => position,
            Err(err) => {
                session
                    .reply(RpcReply::failure(
                        UNKNOWN_ID,
                        RpcError::new(ErrorCode::BadRequest, err.0),
                    ))
                    .await;
                return;
            }
        };
        let id = position.id.clone();
        match self.accept_chunk(session, header, chunk, &position) {
            Ok(Some(assembly)) => {
                let spawned = upload_request(assembly.header).and_then(|params| {
                    self.spawn_request(session, id.clone(), params, Some(assembly.body))
                });
                if let Err(error) = spawned {
                    session.reply(RpcReply::failure(id, error)).await;
                }
            }
            Ok(None) => {}
            Err(error) => {
                session.uploads.lock().unwrap().remove(&id);
                session.reply(RpcReply::failure(id, error)).await;
            }
        }
    }

    /// Add a chunk to its upload; the finished upload once its final chunk
    /// arrived.
    fn accept_chunk(
        &self,
        session: &Arc<DeviceSession>,
        header: Map<String, Value>,
        chunk: &[u8],
        position: &binary::ChunkPosition,
    ) -> Result<Option<Assembly>, RpcError> {
        let invalid = |err: binary::BinaryFrameError| RpcError::new(ErrorCode::BadRequest, err.0);
        let mut uploads = session.uploads.lock().unwrap();
        if position.seq == 0 {
            let token = header
                .get("deviceToken")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !token_matches(token, &session.grant.token) {
                return Err(RpcError::new(
                    ErrorCode::Unauthorized,
                    "Device token mismatch",
                ));
            }
            if header.get("method").and_then(Value::as_str) != Some("request") {
                return Err(RpcError::new(
                    ErrorCode::MethodNotFound,
                    "binary frames carry only request uploads",
                ));
            }
            require_api(session)?;
            if uploads.contains_key(&position.id) {
                return Err(RpcError::new(
                    ErrorCode::BadRequest,
                    format!("upload {} already started", position.id),
                ));
            }
            if uploads.len() >= MAX_PENDING_UPLOADS {
                return Err(RpcError::new(
                    ErrorCode::RuntimeBusy,
                    "too many uploads in flight",
                ));
            }
            let assembly =
                Assembly::start(header, chunk, MAX_IMAGE_UPLOAD_BYTES).map_err(invalid)?;
            if position.is_final {
                return Ok(Some(assembly));
            }
            uploads.insert(position.id.clone(), assembly);
            return Ok(None);
        }
        let assembly = uploads.get_mut(&position.id).ok_or_else(|| {
            RpcError::new(
                ErrorCode::BadRequest,
                format!("no upload {} in progress", position.id),
            )
        })?;
        assembly.push(position.seq, chunk).map_err(invalid)?;
        if position.is_final {
            return Ok(uploads.remove(&position.id));
        }
        Ok(None)
    }

    fn update_capabilities(
        &self,
        session: &Arc<DeviceSession>,
        params: Value,
    ) -> Result<Value, RpcError> {
        let params: CapabilitiesParams = parse(params)?;
        if params.api_generation != API_GENERATION {
            return Err(RpcError {
                data: json!({ "apiGeneration": API_GENERATION }),
                ..RpcError::new(
                    ErrorCode::IncompatibleApi,
                    format!(
                        "this chro speaks device API generation {API_GENERATION}, the app {}; update the older side",
                        params.api_generation
                    ),
                )
            });
        }
        *session.client_capabilities.lock().unwrap() = params.client_capabilities;
        session.api_declared.store(true, Ordering::Release);
        Ok(json!({ "apiGeneration": API_GENERATION, "capabilities": CAPABILITIES }))
    }

    fn status(&self, session: &Arc<DeviceSession>) -> Value {
        let identity = self.inner.state.identity();
        json!({
            "apiGeneration": API_GENERATION,
            "capabilities": CAPABILITIES,
            "machineName": self.inner.machine_name,
            "version": env!("CARGO_PKG_VERSION"),
            "runtimeId": identity.runtime_id,
            "deviceId": session.grant.device_id,
        })
    }

    async fn exchange_ticket(
        &self,
        session: &Arc<DeviceSession>,
        params: Value,
    ) -> Result<Value, RpcError> {
        let params: TicketParams = parse(params)?;
        if !is_device_token(&params.device_token) {
            return Err(RpcError::new(
                ErrorCode::InvalidArgument,
                "deviceToken must be 48 to 128 lowercase hex characters",
            ));
        }
        if !session.grant.is_ticket {
            return Err(RpcError::coded(
                "not_a_ticket",
                "only a connection opened with the QR ticket can exchange it",
            ));
        }
        let link = Arc::clone(&self.inner.link);
        let grant = session.grant.clone();
        let exchanged =
            tokio::task::spawn_blocking(move || link.exchange_ticket(&grant, &params.device_token))
                .await
                .map_err(|err| RpcError::new(ErrorCode::Internal, err.to_string()))?;
        match exchanged {
            Ok(device_id) => Ok(json!({ "deviceId": device_id })),
            Err(err) => Err(RpcError::coded(err.code, err.message)),
        }
    }

    /// Start a `request` on a task the connection owns, if a request slot
    /// is free on the connection and on the server. The slots are released
    /// once the reply is queued, or the connection ends.
    fn spawn_request(
        &self,
        session: &Arc<DeviceSession>,
        id: String,
        params: RequestParams,
        upload: Option<Vec<u8>>,
    ) -> Result<(), RpcError> {
        let limits = self.inner.limits;
        let own = Arc::clone(&session.requests)
            .try_acquire_owned()
            .map_err(|_| {
                RpcError::new(
                    ErrorCode::RuntimeBusy,
                    format!(
                        "at most {} requests run at once per connection",
                        limits.requests_per_connection
                    ),
                )
            })?;
        let shared = Arc::clone(&self.inner.requests)
            .try_acquire_owned()
            .map_err(|_| {
                RpcError::new(
                    ErrorCode::RuntimeBusy,
                    format!("at most {} device requests run at once", limits.requests),
                )
            })?;
        let dispatcher = self.clone();
        let task_session = Arc::clone(session);
        let closed = session.closed.clone();
        session.requests_running.spawn(async move {
            let _slots = (own, shared);
            closed
                .run_until_cancelled(async {
                    let frames = dispatcher.request(&task_session, &id, params, upload).await;
                    for frame in frames {
                        if !task_session.send(frame).await {
                            return;
                        }
                    }
                })
                .await;
        });
        Ok(())
    }

    /// Run one `request` and return the frames that answer it.
    async fn request(
        &self,
        session: &DeviceSession,
        id: &str,
        params: RequestParams,
        upload: Option<Vec<u8>>,
    ) -> Vec<Outbound> {
        let fail = |error: RpcError| vec![Outbound::Text(RpcReply::failure(id, error).to_json())];
        let changes_state = params.method != "GET";
        let request = match build_http_request(session.grant.device_id, params, upload) {
            Ok(request) => request,
            Err(error) => return fail(error),
        };
        // The device's standing was checked when the frame arrived; a
        // change may have waited behind other frames since.
        if changes_state && !self.still_standing(&session.grant).await {
            return fail(RpcError::new(
                ErrorCode::Unauthorized,
                "this device is no longer paired",
            ));
        }
        let deadline = self.inner.limits.request_deadline;
        let answered = tokio::time::timeout(deadline, async {
            let response = match self.inner.router.clone().oneshot(request).await {
                Ok(response) => response,
                Err(infallible) => match infallible {},
            };
            answer(id, response).await
        })
        .await;
        match answered {
            Ok(Ok(frames)) => frames,
            Ok(Err(error)) => fail(error),
            Err(_) => fail(RpcError::new(
                ErrorCode::DeadlineExceeded,
                format!("no answer within {} seconds", deadline.as_secs_f64()),
            )),
        }
    }

    /// Whether `grant` still holds, read from the registry off the async
    /// workers. Fails closed.
    async fn still_standing(&self, grant: &DeviceGrant) -> bool {
        let link = Arc::clone(&self.inner.link);
        let grant = grant.clone();
        tokio::task::spawn_blocking(move || link.standing(&grant))
            .await
            .is_ok_and(|standing| standing == Standing::Active)
    }

    async fn subscribe(&self, session: &Arc<DeviceSession>, id: String, params: Value) {
        let opened = match parse::<SubscribeParams>(params) {
            Ok(params) => self.open_stream(session, params).await,
            Err(err) => Err(err),
        };
        let source = match opened {
            Ok(source) => source,
            Err(error) => {
                session.reply(RpcReply::failure(id, error)).await;
                return;
            }
        };
        let subscription_id = Uuid::new_v4().to_string();
        session
            .reply(RpcReply::streamed(
                &id,
                json!({ "type": "ready", "subscriptionId": subscription_id }),
            ))
            .await;

        let messages = source.open(self.inner.state.clone());
        let forwarder_session = Arc::clone(session);
        let forwarder_id = subscription_id.clone();
        let mut subscriptions = session.subscriptions.lock().unwrap();
        let task = tokio::spawn(async move {
            forward(&forwarder_session, &id, &forwarder_id, messages).await;
            forwarder_session
                .subscriptions
                .lock()
                .unwrap()
                .remove(&forwarder_id);
        });
        subscriptions.insert(subscription_id, task.abort_handle());
    }

    async fn open_stream(
        &self,
        session: &DeviceSession,
        params: SubscribeParams,
    ) -> Result<StreamSource, RpcError> {
        if session.subscription_count() >= MAX_SUBSCRIPTIONS {
            return Err(RpcError::new(
                ErrorCode::RuntimeBusy,
                format!("at most {MAX_SUBSCRIPTIONS} subscriptions per connection"),
            ));
        }
        let stream_params = params
            .params
            .into_iter()
            .map(|(name, value)| scalar(&value).map(|value| (name, value)))
            .collect::<Result<HashMap<_, _>, _>>()?;
        match StreamSource::resolve(&self.inner.state, &params.stream, &stream_params).await {
            Ok(Some(source)) => Ok(source),
            Ok(None) => Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no stream {}", params.stream),
            )),
            Err(err) => Err(api_error(err)),
        }
    }

    fn unsubscribe(&self, session: &Arc<DeviceSession>, params: Value) -> Result<Value, RpcError> {
        let params: UnsubscribeParams = parse(params)?;
        match session
            .subscriptions
            .lock()
            .unwrap()
            .remove(&params.subscription_id)
        {
            Some(handle) => {
                handle.abort();
                Ok(json!({}))
            }
            None => Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no subscription {}", params.subscription_id),
            )),
        }
    }
}

/// Relay a stream's messages as streaming replies, then its end.
async fn forward(
    session: &DeviceSession,
    request_id: &str,
    subscription_id: &str,
    mut messages: routes::stream_sources::MessageStream,
) {
    let takes_parts = session.takes_message_parts();
    while let Some(text) = messages.next().await {
        let replies = match stream_replies(request_id, subscription_id, text, takes_parts) {
            Ok(replies) => replies,
            Err(error) => {
                tracing::warn!(subscription_id, error = %error.message, "phone stream ended");
                session
                    .reply(RpcReply::streamed(
                        request_id,
                        json!({ "type": "end", "subscriptionId": subscription_id, "error": error }),
                    ))
                    .await;
                return;
            }
        };
        for reply in replies {
            if !session.send(Outbound::Text(reply)).await {
                return;
            }
        }
    }
    session
        .reply(RpcReply::streamed(
            request_id,
            json!({ "type": "end", "subscriptionId": subscription_id }),
        ))
        .await;
}

/// One stream message as streaming replies: one `message` when it fits a reply,
/// else (for a device that takes parts) `part`s whose texts join to the message.
fn stream_replies(
    request_id: &str,
    subscription_id: &str,
    text: String,
    takes_parts: bool,
) -> Result<Vec<String>, RpcError> {
    let data = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
    let reply = RpcReply::streamed(
        request_id,
        json!({ "type": "message", "subscriptionId": subscription_id, "data": data }),
    )
    .to_json();
    if reply.len() <= MAX_JSON_REPLY_BYTES {
        return Ok(vec![reply]);
    }
    let limit = if takes_parts {
        MAX_STREAM_MESSAGE_BYTES
    } else {
        MAX_JSON_REPLY_BYTES
    };
    if !takes_parts || text.len() > limit {
        return Err(RpcError::new(
            ErrorCode::ReplyTooLarge,
            format!("a stream message exceeded {limit} bytes"),
        ));
    }
    let parts = split_on_char_boundaries(&text, STREAM_PART_BYTES);
    let last = parts.len() - 1;
    Ok(parts
        .into_iter()
        .enumerate()
        .map(|(index, part)| {
            RpcReply::streamed(
                request_id,
                json!({ "type": "part", "subscriptionId": subscription_id, "text": part, "final": index == last }),
            )
            .to_json()
        })
        .collect())
}

/// `text` in pieces of at most `max` bytes (`max` >= 4), never inside a character.
fn split_on_char_boundaries(text: &str, max: usize) -> Vec<&str> {
    let mut parts = Vec::with_capacity(text.len() / max + 1);
    let mut rest = text;
    while !rest.is_empty() {
        let mut end = rest.len().min(max);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (part, tail) = rest.split_at(end);
        parts.push(part);
        rest = tail;
    }
    parts
}

fn require_api(session: &DeviceSession) -> Result<(), RpcError> {
    if session.api_declared.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(RpcError::new(
            ErrorCode::IncompatibleApi,
            "declare the device API generation with runtime.clientCapabilities.update first",
        ))
    }
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params)
        .map_err(|err| RpcError::new(ErrorCode::InvalidArgument, err.to_string()))
}

fn token_matches(presented: &str, expected: &str) -> bool {
    presented.len() == expected.len()
        && presented
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn is_device_token(token: &str) -> bool {
    (48..=128).contains(&token.len())
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn scalar(value: &Value) -> Result<String, RpcError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        other => Err(RpcError::new(
            ErrorCode::InvalidArgument,
            format!("parameters must be strings, numbers or booleans, not {other}"),
        )),
    }
}

fn api_error(err: ApiError) -> RpcError {
    match err {
        ApiError::NotFound | ApiError::Sqlx(sqlx::Error::RowNotFound) => {
            RpcError::new(ErrorCode::NotFound, "not found")
        }
        ApiError::BadRequest(message) => RpcError::new(ErrorCode::InvalidArgument, message),
        other => RpcError::new(ErrorCode::Internal, other.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilitiesParams {
    client_capabilities: Vec<String>,
    api_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TicketParams {
    device_token: String,
}

/// `request` parameters.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestParams {
    /// `GET`, `POST`, `PUT`, `PATCH` or `DELETE`.
    pub method: String,
    /// The URI path as sent on the wire: segments percent-encoded, no query.
    pub path: String,
    /// Query parameters; arrays repeat the key.
    #[serde(default)]
    pub query: Map<String, Value>,
    /// JSON body.
    #[serde(default)]
    pub body: Option<Value>,
    /// Makes a mutating `/v1` call safe to retry.
    #[serde(default)]
    pub request_id: Option<String>,
    /// For uploads (binary frames only): the multipart part the body becomes.
    #[serde(default)]
    pub upload: Option<UploadPart>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadPart {
    pub field: String,
    pub file_name: String,
    pub content_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscribeParams {
    /// A stream template, e.g. `/streams/tasks/:task_id/runs`.
    stream: String,
    /// Path and query parameters by name.
    #[serde(default)]
    params: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnsubscribeParams {
    subscription_id: String,
}

/// The `request` parameters of a finished upload's first header.
fn upload_request(mut header: Map<String, Value>) -> Result<RequestParams, RpcError> {
    let params: RequestParams = parse(header.remove("params").unwrap_or(Value::Null))?;
    if params.upload.is_none() {
        return Err(RpcError::new(
            ErrorCode::InvalidArgument,
            "a binary request needs params.upload",
        ));
    }
    if params.body.is_some() {
        return Err(RpcError::new(
            ErrorCode::InvalidArgument,
            "an upload's body is the binary payload",
        ));
    }
    Ok(params)
}

const MULTIPART_BOUNDARY: &str = "chro-device-upload-7f3c2b9e";

fn build_http_request(
    device_id: Uuid,
    params: RequestParams,
    upload: Option<Vec<u8>>,
) -> Result<Request, RpcError> {
    let invalid = |message: String| RpcError::new(ErrorCode::InvalidArgument, message);
    let method = match params.method.as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "PATCH" => Method::PATCH,
        "DELETE" => Method::DELETE,
        other => return Err(invalid(format!("unsupported method {other}"))),
    };
    if !params.path.starts_with('/') || params.path.contains(['?', '#']) {
        return Err(invalid(format!(
            "path must be an absolute path without query or fragment, not {:?}",
            params.path
        )));
    }
    let mut target = params.path.clone();
    if !params.query.is_empty() {
        let mut query = form_urlencoded::Serializer::new(String::new());
        for (name, value) in &params.query {
            match value {
                Value::Array(values) => {
                    for value in values {
                        query.append_pair(name, &scalar(value)?);
                    }
                }
                Value::Null => {}
                value => {
                    query.append_pair(name, &scalar(value)?);
                }
            }
        }
        target.push('?');
        target.push_str(&query.finish());
    }
    let uri: Uri = target
        .parse()
        .map_err(|err| invalid(format!("path is not a valid URI path: {err}")))?;

    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(request_id) = &params.request_id {
        let value = HeaderValue::from_str(request_id)
            .map_err(|_| invalid("requestId must be visible ASCII".into()))?;
        builder = builder.header(HEADER_REQUEST_ID, value);
    }
    let body = match (params.body, params.upload, upload) {
        (Some(json), None, None) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&json).expect("values serialize"))
        }
        (None, Some(part), Some(bytes)) => {
            builder = builder.header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={MULTIPART_BOUNDARY}"),
            );
            Body::from(multipart_body(&part, &bytes)?)
        }
        (None, None, None) => Body::empty(),
        _ => {
            return Err(invalid(
                "a request has a JSON body or an upload, not both".into(),
            ))
        }
    };
    let mut request = builder.body(body).map_err(|err| invalid(err.to_string()))?;
    request
        .extensions_mut()
        .insert(DeviceAdmission { device_id });
    Ok(request)
}

fn multipart_body(part: &UploadPart, bytes: &[u8]) -> Result<Vec<u8>, RpcError> {
    let safe = |value: &str| !value.contains(['"', '\r', '\n']);
    if !safe(&part.field) || !safe(&part.file_name) || !safe(&part.content_type) {
        return Err(RpcError::new(
            ErrorCode::InvalidArgument,
            "upload field, fileName and contentType must not contain quotes or line breaks",
        ));
    }
    let mut body = Vec::with_capacity(bytes.len() + 256);
    body.extend_from_slice(
        format!(
            "--{MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            part.field, part.file_name, part.content_type
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{MULTIPART_BOUNDARY}--\r\n").as_bytes());
    Ok(body)
}

fn is_json(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence == "application/json" || essence.ends_with("+json")
}

fn is_text(content_type: &str) -> bool {
    content_type
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("text/")
}

/// Turn a router response into reply frames: JSON as one text reply
/// `{status, body}`, text as `{status, contentType, text}`, anything else
/// (and text too large for one reply) as binary frames.
async fn answer(id: &str, response: Response) -> Result<Vec<Outbound>, RpcError> {
    if response.extensions().get::<DeviceForbidden>().is_some() {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "this endpoint is not available to paired devices",
        ));
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = axum::body::to_bytes(response.into_body(), MAX_BINARY_REPLY_BYTES)
        .await
        .map_err(|_| {
            RpcError::new(
                ErrorCode::ReplyTooLarge,
                format!("the reply exceeds {MAX_BINARY_REPLY_BYTES} bytes"),
            )
        })?;

    if bytes.is_empty() {
        return Ok(vec![Outbound::Text(
            RpcReply::success(id, json!({ "status": status, "body": Value::Null })).to_json(),
        )]);
    }
    if content_type.as_deref().is_some_and(is_json) {
        if bytes.len() > MAX_JSON_REPLY_BYTES {
            return Err(RpcError::new(
                ErrorCode::ReplyTooLarge,
                format!("the reply exceeds {MAX_JSON_REPLY_BYTES} bytes"),
            ));
        }
        if let Ok(body) = serde_json::from_slice::<Value>(&bytes) {
            return Ok(vec![Outbound::Text(
                RpcReply::success(id, json!({ "status": status, "body": body })).to_json(),
            )]);
        }
    }
    // Text (error messages, Markdown, HTML) stays text while it fits a reply.
    if content_type.as_deref().is_some_and(is_text) && bytes.len() <= MAX_JSON_REPLY_BYTES {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            return Ok(vec![Outbound::Text(
                RpcReply::success(
                    id,
                    json!({ "status": status, "contentType": content_type, "text": text }),
                )
                .to_json(),
            )]);
        }
    }
    let mut first = Map::new();
    first.insert("ok".into(), json!(true));
    first.insert(
        "result".into(),
        json!({
            "status": status,
            "contentType": content_type.unwrap_or_else(|| "application/octet-stream".into()),
            "contentLength": bytes.len(),
        }),
    );
    Ok(binary::reply_frames(id, first, &bytes)
        .into_iter()
        .map(Outbound::Binary)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_tokens_are_long_lowercase_hex() {
        assert!(is_device_token(&"a".repeat(48)));
        assert!(is_device_token(&"0f".repeat(64)));
        assert!(!is_device_token(&"a".repeat(47)));
        assert!(!is_device_token(&"a".repeat(129)));
        assert!(!is_device_token(&"A".repeat(48)));
        assert!(!is_device_token(&"g".repeat(48)));
    }

    #[test]
    fn parts_split_between_characters_and_join_to_the_text() {
        let text = "aé説🙂".repeat(10);
        for max in 4..12 {
            let parts = split_on_char_boundaries(&text, max);
            assert!(parts
                .iter()
                .all(|part| !part.is_empty() && part.len() <= max));
            assert_eq!(parts.concat(), text);
        }
        assert!(split_on_char_boundaries("", 8).is_empty());
    }

    #[test]
    fn a_control_heavy_part_still_fits_one_reply() {
        let text = "\u{1}".repeat(STREAM_PART_BYTES * 3);
        let replies = stream_replies("id", "sub", text, true).unwrap();
        assert_eq!(replies.len(), 3);
        assert!(replies
            .iter()
            .all(|reply| reply.len() <= MAX_JSON_REPLY_BYTES));
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("ab", "abc"));
    }

    #[test]
    fn json_content_types_are_recognized() {
        assert!(is_json("application/json"));
        assert!(is_json("application/json; charset=utf-8"));
        assert!(is_json("application/problem+json"));
        assert!(!is_json("image/png"));
        assert!(!is_json("text/plain"));
        assert!(is_text("text/plain; charset=utf-8"));
        assert!(is_text("text/markdown"));
        assert!(!is_text("image/png"));
    }

    fn params(value: Value) -> RequestParams {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn requests_carry_the_device_admission_and_encoded_query() {
        let device_id = Uuid::new_v4();
        let request = build_http_request(
            device_id,
            params(json!({
                "method": "GET",
                "path": "/rpc/projects/p/search",
                "query": {"q": "a b&c", "kind": ["x", "y"], "limit": 5, "skip": null},
                "requestId": "r-1",
            })),
            None,
        )
        .unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(
            request.uri().to_string(),
            "/rpc/projects/p/search?kind=x&kind=y&limit=5&q=a+b%26c"
        );
        assert_eq!(request.headers()[HEADER_REQUEST_ID], "r-1");
        assert_eq!(
            request.extensions().get::<DeviceAdmission>(),
            Some(&DeviceAdmission { device_id })
        );
    }

    #[test]
    fn malformed_requests_are_invalid_arguments() {
        for bad in [
            json!({"method": "TRACE", "path": "/v1/status"}),
            json!({"method": "GET", "path": "v1/status"}),
            json!({"method": "GET", "path": "/v1/status?x=1"}),
            json!({"method": "GET", "path": "/v1/sta tus"}),
            json!({"method": "GET", "path": "/v1/status", "query": {"x": {"y": 1}}}),
        ] {
            let error = build_http_request(Uuid::nil(), params(bad.clone()), None).unwrap_err();
            assert_eq!(error.code, "invalid_argument", "{bad}");
        }
    }

    #[test]
    fn uploads_become_one_multipart_part() {
        let request = build_http_request(
            Uuid::nil(),
            params(json!({
                "method": "POST",
                "path": "/rpc/images/upload",
                "upload": {"field": "image", "fileName": "shelf.png", "contentType": "image/png"},
            })),
            Some(b"PNG".to_vec()),
        )
        .unwrap();
        let content_type = request.headers()[header::CONTENT_TYPE].to_str().unwrap();
        assert!(content_type.starts_with("multipart/form-data; boundary="));

        let quoted = UploadPart {
            field: "image".into(),
            file_name: "a\".png".into(),
            content_type: "image/png".into(),
        };
        assert!(multipart_body(&quoted, b"x").is_err());
    }
}
