//! Message sources behind the streaming endpoints.
//!
//! Every stream is a source of text messages, independent of how they are
//! delivered. The WebSocket routes (`/streams/*` and the run diff) pump a
//! source into a socket with [`serve_ws`]; the paired-device dispatcher
//! forwards the same messages as repeated RPC replies. Both therefore send
//! byte-identical payloads.
//!
//! A source is resolved first ([`StreamSource`] constructors turn raw ids and
//! queries into resolved ids, failing with the HTTP error the routes answer
//! with), then opened ([`StreamSource::open`]) into a [`MessageStream`].
//! Instrumentation (perf events, first-message stall watchdogs) belongs to the
//! source, so it is recorded the same way for every transport.

use std::{
    collections::HashMap,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket};
use db::models::{ProjectRecord, SessionWindow, TaskRun};
use events::EventError;
use filesystem::{GitStateEventBatch, GitStateEventKind, GitStateSubscription, WorktreeEventBatch};
use futures::{
    stream::{self, BoxStream},
    SinkExt, Stream, StreamExt,
};
use log_types::{LogEntry, ReplayLog};
use runtime::Runtime;
use serde_json::{json, Value};
use tokio::sync::broadcast::{self, error::RecvError};
use uuid::Uuid;

use super::rpc::session_list::window_from_params;
use crate::{identifiers, perf, ApiError, AppState};

/// The text messages of one stream, in delivery order.
pub(crate) type MessageStream = BoxStream<'static, String>;

type EntryStream = BoxStream<'static, Result<LogEntry, std::io::Error>>;
type SnapshotResult = Result<EntryStream, EventError>;

const FIRST_PATCH_STALL_MS: u64 = 15_000;
/// How long a log stream gathers entries before sending them.
const LOG_COALESCE_WINDOW: Duration = Duration::from_millis(50);
/// Most entries gathered into one batch (a replay's are all ready at once).
const LOG_COALESCE_MAX: usize = 512;
/// Above this batch size the paths are not worth enumerating over the wire;
/// the event degrades to "many files changed" and matches any path filter.
const MAX_ENUMERATED_PATHS: usize = 512;

/// A resolved stream, ready to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StreamSource {
    /// Every task of every project (the cross-project inbox).
    AllTasks,
    /// The paired phone's session list: a window of live sessions.
    SessionList {
        window: SessionWindow,
    },
    Tasks {
        project_id: Uuid,
    },
    TaskRuns {
        task_id: Uuid,
    },
    TaskSessions {
        task_id: Uuid,
    },
    SessionQueue {
        task_id: Uuid,
    },
    TaskDrafts {
        project_id: Uuid,
    },
    TaskRunLogs {
        task_run_id: Uuid,
    },
    RepoEvents {
        worktree: PathBuf,
    },
    TaskRunDiff {
        task_run_id: Uuid,
        stats_only: bool,
    },
}

/// What a WebSocket does once its source has no more messages.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StreamEnd {
    /// Keep the socket open until the client leaves. Shared snapshot streams
    /// only end on a snapshot failure, after which the client decides when to
    /// reconnect.
    Linger,
    /// Send a close frame without a status.
    Close,
    /// Send this close frame.
    CloseWith { code: u16, reason: &'static str },
}

/// The templates [`StreamSource::resolve`] names, with the parameters each
/// takes. Path parameters keep their route names; query parameters are
/// listed after the `?`. Tests hold this against the router and the resolver.
#[cfg(test)]
pub(crate) const STREAM_TEMPLATES: &[&str] = &[
    "/streams/tasks?project_id",
    "/streams/session-list?sort,limit,project_limits,include",
    "/streams/tasks/:task_id/runs",
    "/streams/tasks/:task_id/sessions",
    "/streams/tasks/:task_id/queue",
    "/streams/task-drafts?project_id",
    "/streams/task-runs/:id/logs",
    "/streams/task-runs/:id/repo-events",
    "/streams/projects/:project_id/repo-events",
    "/rpc/task-runs/:id/diff?stats_only",
];

impl StreamSource {
    pub(crate) async fn tasks(
        state: &AppState,
        project_id: Option<&str>,
    ) -> Result<Self, ApiError> {
        Ok(match project_id {
            Some(raw) => Self::Tasks {
                project_id: identifiers::resolve_project_id(state.pool(), raw).await?,
            },
            None => Self::AllTasks,
        })
    }

    pub(crate) fn session_list(params: &HashMap<String, String>) -> Result<Self, ApiError> {
        Ok(Self::SessionList {
            window: window_from_params(params)?,
        })
    }

    pub(crate) async fn task_runs(state: &AppState, task_id: &str) -> Result<Self, ApiError> {
        Ok(Self::TaskRuns {
            task_id: identifiers::resolve_task_id(state.pool(), task_id).await?,
        })
    }

    pub(crate) async fn task_sessions(state: &AppState, task_id: &str) -> Result<Self, ApiError> {
        Ok(Self::TaskSessions {
            task_id: identifiers::resolve_task_id(state.pool(), task_id).await?,
        })
    }

    pub(crate) async fn session_queue(state: &AppState, task_id: &str) -> Result<Self, ApiError> {
        Ok(Self::SessionQueue {
            task_id: identifiers::resolve_task_id(state.pool(), task_id).await?,
        })
    }

    pub(crate) async fn task_drafts(state: &AppState, project_id: &str) -> Result<Self, ApiError> {
        Ok(Self::TaskDrafts {
            project_id: identifiers::resolve_project_id(state.pool(), project_id).await?,
        })
    }

    pub(crate) async fn task_run_logs(state: &AppState, id: &str) -> Result<Self, ApiError> {
        Ok(Self::TaskRunLogs {
            task_run_id: identifiers::resolve_task_run_id(state.pool(), id).await?,
        })
    }

    pub(crate) async fn run_repo_events(state: &AppState, id: &str) -> Result<Self, ApiError> {
        let run_id = identifiers::resolve_task_run_id(state.pool(), id).await?;
        let run = TaskRun::get(state.pool(), run_id).await?;
        let path = run
            .container_ref
            .or(run.workspace_path)
            .ok_or_else(|| ApiError::BadRequest("task run has no workspace path".into()))?;
        Ok(Self::RepoEvents {
            worktree: PathBuf::from(path),
        })
    }

    pub(crate) async fn project_repo_events(
        state: &AppState,
        project_id: &str,
    ) -> Result<Self, ApiError> {
        let project = ProjectRecord::get_by_identifier(state.pool(), project_id).await?;
        Ok(Self::RepoEvents {
            worktree: PathBuf::from(project.git_repo_path),
        })
    }

    pub(crate) async fn task_run_diff(
        state: &AppState,
        id: &str,
        stats_only: bool,
    ) -> Result<Self, ApiError> {
        Ok(Self::TaskRunDiff {
            task_run_id: identifiers::resolve_task_run_id(state.pool(), id).await?,
            stats_only,
        })
    }

    /// Resolve a stream named by its template (one of [`STREAM_TEMPLATES`]
    /// without the query part) and a flat map of path and query parameters.
    /// `Ok(None)` means the template names no stream.
    pub(crate) async fn resolve(
        state: &AppState,
        template: &str,
        params: &HashMap<String, String>,
    ) -> Result<Option<Self>, ApiError> {
        let param = |name: &str| -> Result<&str, ApiError> {
            params
                .get(name)
                .map(String::as_str)
                .ok_or_else(|| ApiError::BadRequest(format!("missing stream parameter `{name}`")))
        };
        let source = match template {
            "/streams/tasks" => {
                Self::tasks(state, params.get("project_id").map(String::as_str)).await?
            }
            "/streams/session-list" => Self::session_list(params)?,
            "/streams/tasks/:task_id/runs" => Self::task_runs(state, param("task_id")?).await?,
            "/streams/tasks/:task_id/sessions" => {
                Self::task_sessions(state, param("task_id")?).await?
            }
            "/streams/tasks/:task_id/queue" => {
                Self::session_queue(state, param("task_id")?).await?
            }
            "/streams/task-drafts" => Self::task_drafts(state, param("project_id")?).await?,
            "/streams/task-runs/:id/logs" => Self::task_run_logs(state, param("id")?).await?,
            "/streams/task-runs/:id/repo-events" => {
                Self::run_repo_events(state, param("id")?).await?
            }
            "/streams/projects/:project_id/repo-events" => {
                Self::project_repo_events(state, param("project_id")?).await?
            }
            "/rpc/task-runs/:id/diff" => {
                let stats_only = match params.get("stats_only").map(String::as_str) {
                    None | Some("false") => false,
                    Some("true") => true,
                    Some(other) => {
                        return Err(ApiError::BadRequest(format!(
                            "stats_only must be true or false, not {other:?}"
                        )))
                    }
                };
                Self::task_run_diff(state, param("id")?, stats_only).await?
            }
            _ => return Ok(None),
        };
        Ok(Some(source))
    }

    /// How a WebSocket ends once this stream is exhausted.
    pub(crate) fn ws_end(&self) -> StreamEnd {
        match self {
            Self::AllTasks
            | Self::SessionList { .. }
            | Self::Tasks { .. }
            | Self::TaskRuns { .. }
            | Self::TaskSessions { .. }
            | Self::SessionQueue { .. }
            | Self::TaskDrafts { .. } => StreamEnd::Linger,
            Self::TaskRunLogs { .. } | Self::RepoEvents { .. } => StreamEnd::Close,
            // A normal-closure frame tells the client the outcome is terminal
            // (merged run, missing worktree) instead of inviting a reconnect.
            Self::TaskRunDiff { .. } => StreamEnd::CloseWith {
                code: close_code::NORMAL,
                reason: "diff stream ended",
            },
        }
    }

    /// Open the stream. Opening never fails: a source that cannot start
    /// yields one `{"error": ...}` message and ends, as the routes always did.
    pub(crate) fn open(self, state: AppState) -> MessageStream {
        match self {
            Self::AllTasks => shared("all_tasks", json!({}), async move {
                state.runtime().events().stream_all_tasks_raw().await
            }),
            Self::SessionList { window } => shared(
                "session_list",
                json!({ "sort": format!("{:?}", window.sort), "per_project": window.per_project }),
                async move {
                    state
                        .runtime()
                        .events()
                        .stream_session_list_raw(window)
                        .await
                },
            ),
            Self::Tasks { project_id } => {
                shared("tasks", json!({ "project_id": project_id }), async move {
                    state.runtime().events().stream_tasks_raw(project_id).await
                })
            }
            Self::TaskRuns { task_id } => {
                shared("task_runs", json!({ "task_id": task_id }), async move {
                    state.runtime().events().stream_task_runs_raw(task_id).await
                })
            }
            Self::TaskSessions { task_id } => {
                shared("task_sessions", json!({ "task_id": task_id }), async move {
                    state
                        .runtime()
                        .events()
                        .stream_task_sessions_raw(task_id)
                        .await
                })
            }
            Self::SessionQueue { task_id } => {
                shared("session_queue", json!({ "task_id": task_id }), async move {
                    state
                        .runtime()
                        .events()
                        .stream_session_queue_raw(task_id)
                        .await
                })
            }
            Self::TaskDrafts { project_id } => shared(
                "task_drafts",
                json!({ "project_id": project_id }),
                async move {
                    state
                        .runtime()
                        .events()
                        .stream_task_drafts_raw(project_id)
                        .await
                },
            ),
            Self::TaskRunLogs { task_run_id } => task_run_logs(state, task_run_id),
            Self::RepoEvents { worktree } => repo_events(state, worktree),
            Self::TaskRunDiff {
                task_run_id,
                stats_only,
            } => task_run_diff(state, task_run_id, stats_only),
        }
    }
}

/// Pump a source into a WebSocket until either side ends, then end the
/// socket the way the source asks.
pub(crate) async fn serve_ws(socket: WebSocket, mut messages: MessageStream, end: StreamEnd) {
    let (mut sender, mut inbound) = socket.split();
    loop {
        tokio::select! {
            message = messages.next() => match message {
                Some(text) => {
                    if sender.send(Message::Text(text)).await.is_err() {
                        return;
                    }
                }
                None => break,
            },
            received = inbound.next() => match received {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                    let _ = SinkExt::close(&mut sender).await;
                    return;
                }
                Some(Ok(_)) => {}
            },
        }
    }
    match end {
        StreamEnd::Linger => while let Some(Ok(_)) = inbound.next().await {},
        StreamEnd::Close => {
            let _ = SinkExt::close(&mut sender).await;
        }
        StreamEnd::CloseWith { code, reason } => {
            let _ = sender
                .send(Message::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                })))
                .await;
        }
    }
}

fn error_message(err: impl std::fmt::Display) -> String {
    json!({ "error": err.to_string() }).to_string()
}

fn entry_text(entry: &LogEntry) -> String {
    match entry.to_ws_message_unchecked() {
        Message::Text(text) => text,
        _ => error_message("serialization_failed"),
    }
}

/// A snapshot + live-update stream, instrumented around its initial snapshot.
///
/// These streams (`/tasks`, `/tasks/:id/runs`, `/tasks/:id/sessions`,
/// `/task-drafts`) gate the sidebar's loading state: the frontend shows every
/// session as loading until the first message arrives, and force-reconnects if
/// nothing arrives within `FIRST_PATCH_STALL_MS`. The first message is the
/// initial snapshot, which `stream_*_raw` builds with a synchronous DB read.
/// Timing that read (`snapshot_ms`) directly exposes reader-vs-writer lock
/// contention under the `Delete` journal: a slow snapshot (or one that errors
/// with `database is locked`) is the backend cause of an all-sessions-loading
/// flash. The HTTP perf middleware can't see this because the WS upgrade
/// returns `101` before the snapshot runs.
fn shared(
    label: &'static str,
    key: Value,
    snapshot: impl std::future::Future<Output = SnapshotResult> + Send + 'static,
) -> MessageStream {
    let probe = SharedProbe::open(label, key);
    stream::once(async move {
        let started = Instant::now();
        let result = snapshot.await;
        probe.snapshot_done(perf::elapsed_ms(started), result.as_ref().err());
        (probe, result)
    })
    .flat_map(|(probe, result)| match result {
        Ok(entries) => entries
            .map(move |item| {
                probe.first_message();
                match item {
                    Ok(entry) => entry_text(&entry),
                    Err(err) => error_message(err),
                }
            })
            .boxed(),
        Err(err) => stream::iter([error_message(err)]).boxed(),
    })
    .boxed()
}

/// Perf events of one shared stream.
struct SharedProbe {
    label: &'static str,
    key: Value,
    opened_at: Instant,
    first_message_seen: Arc<AtomicBool>,
    stall_timer: tokio::task::JoinHandle<()>,
}

impl SharedProbe {
    fn open(label: &'static str, key: Value) -> Self {
        perf::record_backend_event(
            "shared_stream_opened",
            json!({ "stream": label, "key": key }),
        );
        // Watchdog mirroring the frontend's first-message timeout: if no
        // message is delivered within the same window, the sidebar has already
        // flipped every session to loading. Record it so the stall is
        // attributable to the backend.
        let first_message_seen = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&first_message_seen);
        let stall_key = key.clone();
        let stall_timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(FIRST_PATCH_STALL_MS)).await;
            if !seen.load(Ordering::Relaxed) {
                perf::record_backend_event(
                    "shared_stream_stalled",
                    json!({ "stream": label, "key": stall_key, "timeout_ms": FIRST_PATCH_STALL_MS }),
                );
            }
        });
        Self {
            label,
            key,
            opened_at: Instant::now(),
            first_message_seen,
            stall_timer,
        }
    }

    fn snapshot_done(&self, snapshot_ms: f64, error: Option<&EventError>) {
        match error {
            None => perf::record_backend_event(
                "shared_stream_snapshot_ready",
                json!({ "stream": self.label, "key": self.key, "snapshot_ms": snapshot_ms }),
            ),
            Some(err) => {
                self.first_message_seen.store(true, Ordering::Relaxed);
                self.stall_timer.abort();
                // `database is locked` / SQLITE_BUSY surfaces here when the
                // busy timeout is exhausted instead of merely delaying the read.
                perf::record_backend_event(
                    "shared_stream_snapshot_failed",
                    json!({ "stream": self.label, "key": self.key, "snapshot_ms": snapshot_ms, "error": err.to_string() }),
                );
                tracing::warn!(stream = self.label, error = %err, "[shared_stream] failed to create stream");
            }
        }
    }

    fn first_message(&self) {
        if !self.first_message_seen.swap(true, Ordering::Relaxed) {
            self.stall_timer.abort();
            perf::record_backend_event(
                "shared_stream_first_message",
                json!({
                    "stream": self.label,
                    "key": self.key,
                    "time_to_first_message_ms": perf::elapsed_ms(self.opened_at),
                }),
            );
        }
    }
}

impl Drop for SharedProbe {
    fn drop(&mut self) {
        self.stall_timer.abort();
    }
}

/// A run's conversation log: a liveness marker, the replayed history, then
/// live updates, coalesced per window.
fn task_run_logs(state: AppState, task_run_id: Uuid) -> MessageStream {
    let probe = Arc::new(LogProbe::open(task_run_id));
    // First-byte liveness marker, sent before the (potentially expensive)
    // history replay is built. Clients measure replay health as idle time
    // between messages; without this, a slow cold replay is indistinguishable
    // from a dead stream during the entire normalization.
    let marker = stream::once(async { r#"{"replayStarted":true}"#.to_string() });
    let body_probe = Arc::clone(&probe);
    let body = stream::once(async move { state.runtime().stream_logs(task_run_id).await })
        .flat_map(move |result| {
            let probe = Arc::clone(&body_probe);
            match result {
                Ok(entries) => coalesce_entry_updates(entries)
                    .filter_map(move |item| futures::future::ready(probe.observe(item)))
                    .boxed(),
                Err(err) => {
                    probe.start_failed(&err);
                    stream::iter([error_message(err)]).boxed()
                }
            }
        });
    Ended::new(marker.chain(body).boxed(), move || probe.ended()).boxed()
}

/// Perf events of one log stream. Dropping it before the stream finished
/// records why it closed early.
struct LogProbe {
    task_run_id: Uuid,
    opened_at: Instant,
    first_patch_seen: Arc<AtomicBool>,
    stall_timer: tokio::task::JoinHandle<()>,
    counts: std::sync::Mutex<LogCounts>,
}

#[derive(Default)]
struct LogCounts {
    patch_messages: usize,
    patch_ops: usize,
    finished: bool,
    ended: bool,
    failed_to_start: bool,
}

impl LogProbe {
    fn open(task_run_id: Uuid) -> Self {
        let first_patch_seen = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&first_patch_seen);
        let stall_timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(FIRST_PATCH_STALL_MS)).await;
            if !seen.load(Ordering::Relaxed) {
                perf::record_backend_event(
                    "task_run_logs_stream_stalled",
                    json!({ "task_run_id": task_run_id, "timeout_ms": FIRST_PATCH_STALL_MS }),
                );
            }
        });
        perf::record_backend_event(
            "task_run_logs_stream_opened",
            json!({ "task_run_id": task_run_id }),
        );
        Self {
            task_run_id,
            opened_at: Instant::now(),
            first_patch_seen,
            stall_timer,
            counts: Default::default(),
        }
    }

    fn start_failed(&self, err: &impl std::fmt::Display) {
        self.first_patch_seen.store(true, Ordering::Relaxed);
        self.stall_timer.abort();
        self.counts.lock().unwrap().failed_to_start = true;
        perf::record_backend_event(
            "task_run_logs_stream_start_failed",
            json!({ "task_run_id": self.task_run_id, "error": err.to_string() }),
        );
        tracing::warn!(task_run_id = %self.task_run_id, error = %err, "[stream_task_run_logs] failed to create stream");
    }

    /// Record one item and turn it into the message clients receive.
    fn observe(&self, item: Result<LogEntry, std::io::Error>) -> Option<String> {
        match item {
            Ok(entry) => {
                if let LogEntry::JsonPatch(value) = &entry {
                    let (ops, contains_entry_patch) = parse_patch_stats(value);
                    {
                        let mut counts = self.counts.lock().unwrap();
                        counts.patch_messages += 1;
                        counts.patch_ops += ops;
                    }
                    if contains_entry_patch && !self.first_patch_seen.swap(true, Ordering::Relaxed)
                    {
                        perf::record_backend_event(
                            "task_run_logs_stream_first_patch",
                            json!({
                                "task_run_id": self.task_run_id,
                                "time_to_first_patch_ms": perf::elapsed_ms(self.opened_at),
                            }),
                        );
                    }
                } else if matches!(entry, LogEntry::Finished) {
                    self.first_patch_seen.store(true, Ordering::Relaxed);
                    let mut counts = self.counts.lock().unwrap();
                    counts.finished = true;
                    perf::record_backend_event(
                        "task_run_logs_stream_finished",
                        json!({
                            "task_run_id": self.task_run_id,
                            "elapsed_ms": perf::elapsed_ms(self.opened_at),
                            "patch_messages": counts.patch_messages,
                            "patch_ops": counts.patch_ops,
                        }),
                    );
                }
                log_entry_message(entry)
            }
            Err(err) => {
                perf::record_backend_event(
                    "task_run_logs_stream_error",
                    json!({ "task_run_id": self.task_run_id, "error": err.to_string() }),
                );
                Some(error_message(err))
            }
        }
    }

    fn ended(&self) {
        self.counts.lock().unwrap().ended = true;
    }
}

impl Drop for LogProbe {
    fn drop(&mut self) {
        self.stall_timer.abort();
        let counts = self.counts.lock().unwrap();
        if counts.finished || counts.failed_to_start {
            return;
        }
        perf::record_backend_event(
            "task_run_logs_stream_closed",
            json!({
                "task_run_id": self.task_run_id,
                "elapsed_ms": perf::elapsed_ms(self.opened_at),
                "patch_messages": counts.patch_messages,
                "patch_ops": counts.patch_ops,
                "reason": if counts.ended {
                    "stream_ended_without_finished"
                } else {
                    "client_disconnected"
                },
            }),
        );
    }
}

/// Calls `on_end` once when the inner stream is exhausted (not when it is
/// dropped early).
struct Ended<F: FnMut() + Send> {
    inner: MessageStream,
    on_end: Option<F>,
}

impl<F: FnMut() + Send> Ended<F> {
    fn new(inner: MessageStream, on_end: F) -> Self {
        Self {
            inner,
            on_end: Some(on_end),
        }
    }
}

impl<F: FnMut() + Send + Unpin> Stream for Ended<F> {
    type Item = String;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<String>> {
        let polled = self.inner.poll_next_unpin(cx);
        if let Poll::Ready(None) = polled {
            if let Some(mut on_end) = self.on_end.take() {
                on_end();
            }
        }
        polled
    }
}

/// Batch a log stream over short windows and fold superseded entry updates
/// within each batch.
///
/// A streaming entry (command output, assistant text) is re-sent whole on
/// every chunk the agent emits, far faster than a client can use. Folding
/// sends it at most once per window, so the bytes on the wire and the work in
/// the client follow the window rate, not the chunk rate.
fn coalesce_entry_updates(stream: EntryStream) -> EntryStream {
    tokio_stream::StreamExt::chunks_timeout(stream, LOG_COALESCE_MAX, LOG_COALESCE_WINDOW)
        .flat_map(|batch| stream::iter(fold_batch(batch)))
        .boxed()
}

/// Fold one batch, keeping errors in their place relative to entries.
fn fold_batch(
    batch: Vec<Result<LogEntry, std::io::Error>>,
) -> Vec<Result<LogEntry, std::io::Error>> {
    let mut out = Vec::with_capacity(batch.len());
    let mut folded = ReplayLog::new();
    for item in batch {
        match item {
            Ok(entry) => folded.push(entry),
            Err(err) => {
                out.extend(
                    std::mem::take(&mut folded)
                        .into_entries()
                        .into_iter()
                        .map(Ok),
                );
                out.push(Err(err));
            }
        }
    }
    out.extend(folded.into_entries().into_iter().map(Ok));
    out
}

fn log_entry_message(entry: LogEntry) -> Option<String> {
    match entry {
        LogEntry::JsonPatch(value) => Some(json!({ "JsonPatch": value }).to_string()),
        LogEntry::Finished => Some(r#"{"finished":true}"#.to_string()),
        _ => None,
    }
}

fn parse_patch_stats(value: &Value) -> (usize, bool) {
    let Some(ops) = value.as_array() else {
        return (0, false);
    };

    let mut contains_entry_patch = false;
    for op in ops {
        let Some(path) = op.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(index) = path.strip_prefix("/entries/") else {
            continue;
        };
        if index.parse::<usize>().is_err() {
            continue;
        }
        let action = op.get("op").and_then(Value::as_str);
        if action != Some("remove") {
            contains_entry_patch = true;
            break;
        }
    }

    (ops.len(), contains_entry_patch)
}

/// A run's diff against its base, live until the run is merged.
fn task_run_diff(state: AppState, task_run_id: Uuid, stats_only: bool) -> MessageStream {
    stream::once(async move { state.runtime().stream_diff(task_run_id, stats_only).await })
        .flat_map(move |result| match result {
            Ok(entries) => entries
                .map(|item| match item {
                    Ok(entry) => entry_text(&entry),
                    Err(err) => error_message(err),
                })
                .boxed(),
            Err(err) => {
                tracing::warn!(%task_run_id, error = %err, "[task_run_diff] failed to create diff stream");
                stream::iter([error_message(err)]).boxed()
            }
        })
        .boxed()
}

/// Notification-only change signals for one worktree scope, multiplexing the
/// worktree's file batches and its git metadata state. No data is carried:
/// consumers re-run the RPC they already use, debounced client-side.
///
/// Message shapes (`type` matches the client stream envelope):
/// - `{"type":"repo_event","payload":{"channel":"files","paths":[...]}}`:
///   `paths` is omitted when a batch is too large to enumerate; consumers
///   must then treat the event as matching any path filter.
/// - `{"type":"repo_event","payload":{"channel":"git","kinds":["headMoved"]}}`
/// - `{"type":"repo_event","payload":{"channel":"resync"}}`: the broadcast
///   lagged and notifications were lost; consumers refresh unconditionally.
fn repo_events(state: AppState, worktree: PathBuf) -> MessageStream {
    stream::once(async move {
        let files = state.runtime().subscribe_worktree_changes(worktree.clone());
        // Git dir resolution reads the filesystem; keep it off the async
        // workers. Non-git worktrees (scratch chats) have no git channel.
        let runtime = state.runtime().clone();
        let git = tokio::task::spawn_blocking(move || runtime.subscribe_git_state(&worktree))
            .await
            .ok()
            .flatten();
        repo_event_messages(files, git)
    })
    .flatten()
    .boxed()
}

struct RepoReceivers {
    files: broadcast::Receiver<WorktreeEventBatch>,
    git: Option<GitStateSubscription>,
}

fn repo_event_messages(
    files: broadcast::Receiver<WorktreeEventBatch>,
    git: Option<GitStateSubscription>,
) -> MessageStream {
    stream::unfold(RepoReceivers { files, git }, |mut receivers| async move {
        loop {
            let message = tokio::select! {
                batch = receivers.files.recv() => match batch {
                    Ok(batch) => files_message(&batch),
                    Err(RecvError::Lagged(_)) => Some(resync_message()),
                    Err(RecvError::Closed) => return None,
                },
                batch = recv_git(&mut receivers.git) => match batch {
                    Ok(batch) => git_message(receivers.git.as_ref().expect("git arm only polls Some"), &batch),
                    Err(RecvError::Lagged(_)) => Some(resync_message()),
                    Err(RecvError::Closed) => {
                        receivers.git = None;
                        continue;
                    }
                },
            };
            if let Some(message) = message {
                return Some((message, receivers));
            }
        }
    })
    .boxed()
}

/// Await the git receiver, or pend forever when there is no git channel so the
/// `select!` arm never fires for non-git worktrees.
async fn recv_git(
    git_sub: &mut Option<GitStateSubscription>,
) -> Result<GitStateEventBatch, RecvError> {
    match git_sub {
        Some(subscription) => subscription.receiver.recv().await,
        None => std::future::pending().await,
    }
}

fn files_message(batch: &WorktreeEventBatch) -> Option<String> {
    if batch.is_empty() {
        return None;
    }
    let payload = if batch.len() > MAX_ENUMERATED_PATHS
        || batch.iter().any(|event| event.relative_path.is_empty())
    {
        json!({ "channel": "files" })
    } else {
        let paths: Vec<&str> = batch
            .iter()
            .map(|event| event.relative_path.as_str())
            .collect();
        json!({ "channel": "files", "paths": paths })
    };
    Some(repo_envelope(payload))
}

fn git_message(subscription: &GitStateSubscription, batch: &GitStateEventBatch) -> Option<String> {
    let mut kinds: Vec<&'static str> = subscription
        .relevant_kinds(batch)
        .into_iter()
        .map(kind_label)
        .collect();
    if kinds.is_empty() {
        return None;
    }
    kinds.sort_unstable();
    Some(repo_envelope(json!({ "channel": "git", "kinds": kinds })))
}

fn resync_message() -> String {
    repo_envelope(json!({ "channel": "resync" }))
}

fn repo_envelope(payload: Value) -> String {
    json!({ "type": "repo_event", "payload": payload }).to_string()
}

fn kind_label(kind: GitStateEventKind) -> &'static str {
    match kind {
        GitStateEventKind::HeadMoved => "headMoved",
        GitStateEventKind::IndexChanged => "indexChanged",
        GitStateEventKind::OperationChanged => "operationChanged",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use filesystem::{GitEventScope, GitStateEvent, WorktreeEvent, WorktreeEventKind};

    fn entry_patch(op: &str, index: usize, content: &str) -> LogEntry {
        LogEntry::JsonPatch(json!([{
            "op": op,
            "path": format!("/entries/{index}"),
            "value": { "content": content },
        }]))
    }

    #[tokio::test]
    async fn ready_updates_of_one_entry_are_sent_once_per_batch() {
        const UPDATES: usize = 1_000;
        let mut items = vec![Ok(entry_patch("add", 0, ""))];
        items.extend((0..UPDATES).map(|n| Ok(entry_patch("replace", 0, &n.to_string()))));
        items.push(Ok(LogEntry::Finished));

        let sent: Vec<_> = coalesce_entry_updates(stream::iter(items).boxed())
            .map(Result::unwrap)
            .collect()
            .await;

        let batches = (UPDATES + 2).div_ceil(LOG_COALESCE_MAX);
        assert_eq!(
            sent.len(),
            batches + 1,
            "one update per batch, then Finished"
        );
        assert_eq!(sent[batches - 1], entry_patch("replace", 0, "999"));
        assert_eq!(sent[batches], LogEntry::Finished);
    }

    #[tokio::test]
    async fn a_live_entry_is_sent_without_waiting_for_more() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut stream = coalesce_entry_updates(
            tokio_stream::wrappers::UnboundedReceiverStream::new(rx).boxed(),
        );

        tx.send(Ok(entry_patch("add", 0, "a"))).unwrap();
        let first = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("sent within the window, not held until the stream ends");

        assert_eq!(first.unwrap().unwrap(), entry_patch("add", 0, "a"));
    }

    #[test]
    fn errors_keep_their_place_and_split_folding() {
        let batch = vec![
            Ok(entry_patch("add", 0, "a")),
            Err(std::io::Error::other("boom")),
            Ok(entry_patch("replace", 0, "a2")),
        ];

        let out = fold_batch(batch);

        assert_eq!(out.len(), 3);
        assert_eq!(out[0].as_ref().unwrap(), &entry_patch("add", 0, "a"));
        assert!(out[1].is_err());
        assert_eq!(out[2].as_ref().unwrap(), &entry_patch("replace", 0, "a2"));
    }

    #[test]
    fn log_messages_wrap_patches_and_mark_the_finish() {
        assert_eq!(
            log_entry_message(LogEntry::JsonPatch(json!([]))).unwrap(),
            r#"{"JsonPatch":[]}"#
        );
        assert_eq!(
            log_entry_message(LogEntry::Finished).unwrap(),
            r#"{"finished":true}"#
        );
    }

    fn file_event(path: &str) -> WorktreeEvent {
        WorktreeEvent {
            kind: WorktreeEventKind::Modified,
            relative_path: path.to_string(),
            is_dir: false,
        }
    }

    fn subscription_for(git_dir: &str) -> GitStateSubscription {
        let (_sender, receiver) = broadcast::channel(1);
        GitStateSubscription {
            git_dir: PathBuf::from(git_dir),
            receiver,
        }
    }

    fn parsed(text: String) -> Value {
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn files_message_enumerates_paths_and_degrades_above_cap() {
        let batch = Arc::new(vec![file_event("src/a.md"), file_event("b.txt")]);
        let value = parsed(files_message(&batch).unwrap());
        assert_eq!(value["type"], "repo_event");
        assert_eq!(value["payload"]["channel"], "files");
        assert_eq!(value["payload"]["paths"].as_array().unwrap().len(), 2);

        let big = Arc::new(
            (0..MAX_ENUMERATED_PATHS + 1)
                .map(|i| file_event(&format!("f{i}")))
                .collect::<Vec<_>>(),
        );
        let value = parsed(files_message(&big).unwrap());
        assert!(
            value["payload"].get("paths").is_none(),
            "oversized batches must omit paths (match-all semantics)"
        );

        let overflow = Arc::new(vec![file_event("")]);
        let value = parsed(files_message(&overflow).unwrap());
        assert!(
            value["payload"].get("paths").is_none(),
            "overflow marker must request a full files refresh"
        );

        assert!(files_message(&Arc::new(Vec::new())).is_none());
    }

    #[test]
    fn git_message_filters_by_scope_and_labels_kinds() {
        let subscription = subscription_for("/repo/.git/worktrees/wt1");
        let batch: GitStateEventBatch = Arc::new(vec![
            GitStateEvent {
                kind: GitStateEventKind::HeadMoved,
                scope: GitEventScope::Shared,
            },
            GitStateEvent {
                kind: GitStateEventKind::IndexChanged,
                scope: GitEventScope::Worktree(PathBuf::from("/repo/.git")),
            },
        ]);

        let value = parsed(git_message(&subscription, &batch).unwrap());
        assert_eq!(value["payload"]["channel"], "git");
        assert_eq!(
            value["payload"]["kinds"],
            json!(["headMoved"]),
            "another worktree's index change must be filtered out"
        );

        let only_foreign: GitStateEventBatch = Arc::new(vec![GitStateEvent {
            kind: GitStateEventKind::OperationChanged,
            scope: GitEventScope::Worktree(PathBuf::from("/repo/.git")),
        }]);
        assert!(git_message(&subscription, &only_foreign).is_none());
    }

    #[tokio::test]
    async fn repo_events_stream_file_batches_and_resyncs_after_lag() {
        let (files_tx, files_rx) = broadcast::channel(1);
        let mut messages = repo_event_messages(files_rx, None);

        files_tx.send(Arc::new(vec![file_event("a.md")])).unwrap();
        let first = parsed(messages.next().await.unwrap());
        assert_eq!(first["payload"]["paths"], json!(["a.md"]));

        // Two sends into a capacity-1 channel lose one batch.
        files_tx.send(Arc::new(vec![file_event("b.md")])).unwrap();
        files_tx.send(Arc::new(vec![file_event("c.md")])).unwrap();
        let lagged = parsed(messages.next().await.unwrap());
        assert_eq!(lagged["payload"]["channel"], "resync");

        drop(files_tx);
        let tail: Vec<_> = messages.collect().await;
        assert_eq!(tail.len(), 1, "the retained batch, then the end");
        assert_eq!(parsed(tail[0].clone())["payload"]["paths"], json!(["c.md"]));
    }

    #[tokio::test]
    async fn every_template_resolves_with_its_parameters() {
        let app = crate::test_support::app().await;
        let project = app.project("repo").await;
        let task = app.task(&project, "Streams").await;
        let mut run = TaskRun::new_local(task.id, None);
        run.workspace_path = Some(project.git_repo_path.clone());
        run.insert(app.pool()).await.unwrap();

        let ids = HashMap::from([
            ("project_id".to_string(), project.id.to_string()),
            ("task_id".to_string(), task.id.to_string()),
            ("id".to_string(), run.id.to_string()),
        ]);
        for template in STREAM_TEMPLATES {
            let (path, query) = template.split_once('?').unwrap_or((template, ""));
            let params: HashMap<String, String> = path
                .split('/')
                .filter_map(|segment| segment.strip_prefix(':'))
                .chain(query.split(',').filter(|name| ids.contains_key(*name)))
                .map(|name| (name.to_string(), ids[name].clone()))
                .collect();
            let source = StreamSource::resolve(&app.state, path, &params)
                .await
                .unwrap_or_else(|err| panic!("{template}: {err}"));
            assert!(source.is_some(), "{template} is not resolvable");
        }
        assert_eq!(
            StreamSource::resolve(&app.state, "/streams/tasks", &HashMap::new())
                .await
                .unwrap(),
            Some(StreamSource::AllTasks),
            "no project means every project"
        );
        assert_eq!(
            StreamSource::resolve(&app.state, "/streams/browser", &HashMap::new())
                .await
                .unwrap(),
            None
        );
    }

    #[test]
    fn websocket_endings_match_each_stream_kind() {
        let id = Uuid::nil();
        assert_eq!(StreamSource::AllTasks.ws_end(), StreamEnd::Linger);
        assert_eq!(
            StreamSource::TaskRuns { task_id: id }.ws_end(),
            StreamEnd::Linger
        );
        assert_eq!(
            StreamSource::TaskRunLogs { task_run_id: id }.ws_end(),
            StreamEnd::Close
        );
        assert_eq!(
            StreamSource::RepoEvents {
                worktree: PathBuf::new()
            }
            .ws_end(),
            StreamEnd::Close
        );
        assert_eq!(
            StreamSource::TaskRunDiff {
                task_run_id: id,
                stats_only: false
            }
            .ws_end(),
            StreamEnd::CloseWith {
                code: 1000,
                reason: "diff stream ended"
            }
        );
    }
}
