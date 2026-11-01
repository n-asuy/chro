//! `GET /v1/sessions/:session/wait`: block until a session reaches a state.
//!
//! The answer is pushed, not polled: the wait re-evaluates the session when
//! the database reports a change (turns starting and ending, tasks updating)
//! and when the session's running turn raises or resolves an approval. While
//! it waits it writes a blank line every [`KEEPALIVE`] so proxies and clients
//! keep the connection open; the final envelope follows the padding, which
//! JSON parsers skip as whitespace.

use std::{convert::Infallible, time::Duration};

use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header::CONTENT_TYPE, HeaderValue},
    response::Response,
    Extension,
};
use db::models::{TaskRecord, TaskRun};
use log_types::LogEntry;
use runtime::Runtime;
use serde::Deserialize;
use server_contract::{
    api::{SessionState, SessionView, WaitFor, WaitOutcome, DEFAULT_WAIT_MS, MAX_WAIT_MS},
    Envelope, ErrorCode,
};
use tokio::{
    sync::{broadcast::error::RecvError, mpsc},
    time::{sleep_until, Instant, MissedTickBehavior},
};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use super::{meta, selectors, views, Caller, V1Error};
use crate::AppState;

const KEEPALIVE: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub(crate) struct WaitParams {
    #[serde(rename = "for")]
    condition: WaitFor,
    timeout_ms: Option<u64>,
}

/// The condition that holds for `view`, if it satisfies `wanted`.
fn holds(wanted: WaitFor, view: &SessionView) -> Option<WaitFor> {
    let idle = view.state == SessionState::Idle && view.queue.is_empty();
    let input = view.state == SessionState::AwaitingInput;
    match wanted {
        WaitFor::Idle if idle => Some(WaitFor::Idle),
        WaitFor::Input if input => Some(WaitFor::Input),
        WaitFor::Settled if idle => Some(WaitFor::Idle),
        WaitFor::Settled if input => Some(WaitFor::Input),
        _ => None,
    }
}

/// Whether an entry on a turn's own stream can change the session's state.
fn moves_state(entry: &LogEntry) -> bool {
    match entry {
        LogEntry::Finished => true,
        LogEntry::JsonPatch(patch) => patch.as_array().is_some_and(|ops| {
            ops.iter().any(|op| {
                op.get("path")
                    .and_then(|path| path.as_str())
                    .is_some_and(|path| path.starts_with("/approvals/"))
            })
        }),
        _ => false,
    }
}

pub(crate) async fn wait(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Query(params): Query<WaitParams>,
) -> Result<Response, V1Error> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let timeout = Duration::from_millis(
        params
            .timeout_ms
            .unwrap_or(DEFAULT_WAIT_MS)
            .min(MAX_WAIT_MS),
    );
    let deadline = Instant::now() + timeout;

    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(4);
    tokio::spawn(async move {
        let envelope = match watch(&state, task.id, params.condition, deadline, &tx).await {
            Ok(outcome) => serde_json::to_vec(&Envelope::success(outcome, meta())),
            Err(err) => serde_json::to_vec(&Envelope::<()>::failure(err.0, meta())),
        };
        if let Ok(body) = envelope {
            let _ = tx.send(Ok(Bytes::from(body))).await;
        }
    });

    let mut response = Response::new(Body::from_stream(ReceiverStream::new(rx)));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok(response)
}

async fn snapshot(state: &AppState, task_id: Uuid) -> Result<(SessionView, Option<Uuid>), V1Error> {
    let task = TaskRecord::get(state.pool(), task_id).await?;
    let view = views::session_view(state, &task).await?;
    let in_flight = TaskRun::list_by_task_id(state.pool(), task_id)
        .await?
        .into_iter()
        .find(views::is_in_flight)
        .map(|run| run.id);
    Ok((view, in_flight))
}

async fn watch(
    state: &AppState,
    task_id: Uuid,
    wanted: WaitFor,
    deadline: Instant,
    padding: &mpsc::Sender<Result<Bytes, Infallible>>,
) -> Result<WaitOutcome, V1Error> {
    // Subscribe before the first look, so a change between the look and the
    // subscription cannot be missed.
    let mut database = state.runtime().events().msg_store().subscribe();
    let mut turn_stream: Option<(Uuid, tokio::sync::broadcast::Receiver<LogEntry>)> = None;
    let mut keepalive = tokio::time::interval_at(Instant::now() + KEEPALIVE, KEEPALIVE);
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        let (view, in_flight) = snapshot(state, task_id).await?;
        if let Some(reason) = holds(wanted, &view) {
            let approval = match (reason, in_flight) {
                (WaitFor::Input, Some(run_id)) => {
                    match state
                        .runtime()
                        .approvals()
                        .pending_request_for_run(run_id)
                        .await
                    {
                        Some(request) => Some(
                            views::approval_view(
                                state,
                                &request.id,
                                Some(&request),
                                &approvals::ApprovalStatus::Pending,
                                None,
                            )
                            .await?,
                        ),
                        None => None,
                    }
                }
                _ => None,
            };
            return Ok(WaitOutcome {
                reason,
                session: view,
                approval,
            });
        }

        if turn_stream.as_ref().map(|(id, _)| *id) != in_flight {
            turn_stream = match in_flight {
                Some(run_id) => state
                    .runtime()
                    .msg_stores()
                    .read()
                    .await
                    .get(&run_id)
                    .map(|store| (run_id, store.subscribe())),
                None => None,
            };
        }

        // Sleep until something that can change the answer happens.
        loop {
            tokio::select! {
                _ = sleep_until(deadline) => {
                    let handle = view.handle();
                    return Err(V1Error(
                        server_contract::ErrorBody::new(
                            ErrorCode::Timeout,
                            format!("session {handle} is still {} after the wait ran out", view.state.as_str()),
                        )
                        .with_next(format!("chro session wait {handle} --for {}", wanted.as_str()))
                        .with_data(serde_json::to_value(&view).unwrap_or_default()),
                    ));
                }
                _ = keepalive.tick() => {
                    if padding.send(Ok(Bytes::from_static(b"\n"))).await.is_err() {
                        // The caller hung up; nobody is left to answer.
                        return Err(V1Error::new(ErrorCode::Internal, "caller disconnected"));
                    }
                    break;
                }
                received = database.recv() => {
                    match received {
                        Ok(_) | Err(RecvError::Lagged(_)) => {
                            // Coalesce a burst of changes into one look.
                            while database.try_recv().is_ok() {}
                            break;
                        }
                        Err(RecvError::Closed) => {
                            database = state.runtime().events().msg_store().subscribe();
                            break;
                        }
                    }
                }
                received = async {
                    match turn_stream.as_mut() {
                        Some((_, stream)) => stream.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match received {
                        Ok(entry) if moves_state(&entry) => break,
                        Ok(_) => continue,
                        Err(RecvError::Lagged(_)) => break,
                        Err(RecvError::Closed) => {
                            turn_stream = None;
                            break;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use server_contract::api::ProjectView;

    fn view(state: SessionState, queued: usize) -> SessionView {
        SessionView {
            id: Uuid::nil(),
            slug: Some("s".into()),
            title: String::new(),
            project: ProjectView {
                id: Uuid::nil(),
                slug: None,
                name: String::new(),
                path: String::new(),
            },
            state,
            status: String::new(),
            agent: None,
            branch: None,
            worktree: None,
            note: None,
            summary: None,
            turn: None,
            queue: (0..queued)
                .map(|_| server_contract::api::QueuedMessage {
                    id: Uuid::new_v4(),
                    prompt: String::new(),
                    created_at: Utc::now(),
                })
                .collect(),
            parent: None,
            children: Vec::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn idle_waits_for_the_queue_to_drain_too() {
        assert_eq!(
            holds(WaitFor::Idle, &view(SessionState::Idle, 0)),
            Some(WaitFor::Idle)
        );
        assert_eq!(holds(WaitFor::Idle, &view(SessionState::Idle, 1)), None);
        assert_eq!(holds(WaitFor::Idle, &view(SessionState::Running, 0)), None);
    }

    #[test]
    fn input_holds_only_while_suspended_on_an_answer() {
        assert_eq!(
            holds(WaitFor::Input, &view(SessionState::AwaitingInput, 0)),
            Some(WaitFor::Input)
        );
        assert_eq!(holds(WaitFor::Input, &view(SessionState::Idle, 0)), None);
    }

    #[test]
    fn settled_reports_which_condition_held() {
        assert_eq!(
            holds(WaitFor::Settled, &view(SessionState::Idle, 0)),
            Some(WaitFor::Idle)
        );
        assert_eq!(
            holds(WaitFor::Settled, &view(SessionState::AwaitingInput, 2)),
            Some(WaitFor::Input)
        );
        assert_eq!(
            holds(WaitFor::Settled, &view(SessionState::Running, 0)),
            None
        );
    }

    #[test]
    fn only_approvals_and_the_end_of_a_turn_move_state() {
        assert!(moves_state(&LogEntry::Finished));
        assert!(moves_state(&LogEntry::JsonPatch(serde_json::json!([
            { "op": "add", "path": "/approvals/a1", "value": {} }
        ]))));
        assert!(!moves_state(&LogEntry::JsonPatch(serde_json::json!([
            { "op": "add", "path": "/entries/0", "value": {} }
        ]))));
        assert!(!moves_state(&LogEntry::Stdout("chunk".into())));
    }
}
