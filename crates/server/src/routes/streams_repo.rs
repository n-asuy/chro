//! Notification-only repo-events streams.
//!
//! One WebSocket per open worktree scope, multiplexing the two change signal
//! sources — worktree file batches and git metadata state — into lightweight
//! notifications. No data is carried: consumers react by re-running the RPC
//! they already use (status, branch-status, working diffs, cbase query),
//! debounced client-side. This replaces the frontend's interval polling.
//!
//! Message shapes (`type` matches the client stream envelope):
//! - `{"type":"repo_event","payload":{"channel":"files","paths":[...]}}` —
//!   `paths` is omitted when a batch is too large to enumerate; consumers
//!   must then treat the event as matching any path filter.
//! - `{"type":"repo_event","payload":{"channel":"git","kinds":["headMoved"]}}`
//! - `{"type":"repo_event","payload":{"channel":"resync"}}` — the broadcast
//!   lagged and notifications were lost; consumers refresh unconditionally.

use std::path::PathBuf;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use db::models::{ProjectRecord, TaskRun};
use filesystem::{GitStateEventBatch, GitStateEventKind, GitStateSubscription, WorktreeEventBatch};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::{identifiers::resolve_task_run_id, ApiError, AppState};

/// Above this batch size the paths are not worth enumerating over the wire;
/// the event degrades to "many files changed" and matches any path filter.
const MAX_ENUMERATED_PATHS: usize = 512;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/task-runs/:id/repo-events", get(stream_run_repo_events))
        .route(
            "/projects/:project_id/repo-events",
            get(stream_project_repo_events),
        )
}

async fn stream_run_repo_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let run_id = resolve_task_run_id(state.pool(), &id).await?;
    let run = TaskRun::get(state.pool(), run_id).await?;
    let path = run
        .container_ref
        .or(run.workspace_path)
        .ok_or_else(|| ApiError::BadRequest("task run has no workspace path".into()))?;
    let worktree = PathBuf::from(path);
    Ok(ws.on_upgrade(move |socket| handle_repo_events_ws(socket, state, worktree)))
}

async fn stream_project_repo_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let project = ProjectRecord::get_by_identifier(state.pool(), &project_id).await?;
    let worktree = PathBuf::from(project.git_repo_path);
    Ok(ws.on_upgrade(move |socket| handle_repo_events_ws(socket, state, worktree)))
}

async fn handle_repo_events_ws(socket: WebSocket, state: AppState, worktree: PathBuf) {
    let files_rx = state.runtime().subscribe_worktree_changes(worktree.clone());

    // Git dir resolution reads the filesystem; keep it off the async workers.
    // Non-git worktrees (scratch chats) simply have no git channel.
    let git_sub = {
        let runtime = state.runtime().clone();
        let path = worktree.clone();
        tokio::task::spawn_blocking(move || runtime.subscribe_git_state(&path))
            .await
            .ok()
            .flatten()
    };

    run_repo_events(socket, files_rx, git_sub).await;
}

async fn run_repo_events(
    socket: WebSocket,
    mut files_rx: tokio::sync::broadcast::Receiver<WorktreeEventBatch>,
    mut git_sub: Option<GitStateSubscription>,
) {
    let (mut sender, mut inbound) = socket.split();

    loop {
        let message = tokio::select! {
            batch = files_rx.recv() => match batch {
                Ok(batch) => files_message(&batch),
                Err(RecvError::Lagged(_)) => Some(resync_message()),
                Err(RecvError::Closed) => break,
            },
            batch = recv_git(&mut git_sub) => match batch {
                Ok(batch) => git_message(git_sub.as_ref().expect("git arm only polls Some"), &batch),
                Err(RecvError::Lagged(_)) => Some(resync_message()),
                Err(RecvError::Closed) => {
                    git_sub = None;
                    continue;
                }
            },
            received = inbound.next() => match received {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => continue,
            },
        };

        let Some(message) = message else { continue };
        if sender.send(message).await.is_err() {
            break;
        }
    }

    // Send a proper close frame so the client sees a clean closure instead of
    // an abnormal drop that triggers reconnection attempts.
    let _ = SinkExt::close(&mut sender).await;
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

fn files_message(batch: &WorktreeEventBatch) -> Option<Message> {
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
    Some(envelope(payload))
}

fn git_message(subscription: &GitStateSubscription, batch: &GitStateEventBatch) -> Option<Message> {
    let mut kinds: Vec<&'static str> = subscription
        .relevant_kinds(batch)
        .into_iter()
        .map(kind_label)
        .collect();
    if kinds.is_empty() {
        return None;
    }
    kinds.sort_unstable();
    Some(envelope(json!({ "channel": "git", "kinds": kinds })))
}

fn resync_message() -> Message {
    envelope(json!({ "channel": "resync" }))
}

fn envelope(payload: serde_json::Value) -> Message {
    Message::Text(json!({ "type": "repo_event", "payload": payload }).to_string())
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
    use std::path::PathBuf;
    use std::sync::Arc;

    fn message_json(message: Message) -> serde_json::Value {
        let Message::Text(text) = message else {
            panic!("expected a text message");
        };
        serde_json::from_str(&text).unwrap()
    }

    fn file_event(path: &str) -> WorktreeEvent {
        WorktreeEvent {
            kind: WorktreeEventKind::Modified,
            relative_path: path.to_string(),
            is_dir: false,
        }
    }

    fn subscription_for(git_dir: &str) -> GitStateSubscription {
        let (_sender, receiver) = tokio::sync::broadcast::channel(1);
        GitStateSubscription {
            git_dir: PathBuf::from(git_dir),
            receiver,
        }
    }

    #[test]
    fn files_message_enumerates_paths_and_degrades_above_cap() {
        let batch = Arc::new(vec![file_event("src/a.md"), file_event("b.txt")]);
        let value = message_json(files_message(&batch).unwrap());
        assert_eq!(value["type"], "repo_event");
        assert_eq!(value["payload"]["channel"], "files");
        let paths = value["payload"]["paths"].as_array().unwrap();
        assert_eq!(paths.len(), 2);

        let big = Arc::new(
            (0..MAX_ENUMERATED_PATHS + 1)
                .map(|i| file_event(&format!("f{i}")))
                .collect::<Vec<_>>(),
        );
        let value = message_json(files_message(&big).unwrap());
        assert!(
            value["payload"].get("paths").is_none(),
            "oversized batches must omit paths (match-all semantics)"
        );

        let overflow = Arc::new(vec![file_event("")]);
        let value = message_json(files_message(&overflow).unwrap());
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

        let value = message_json(git_message(&subscription, &batch).unwrap());
        assert_eq!(value["payload"]["channel"], "git");
        assert_eq!(
            value["payload"]["kinds"],
            serde_json::json!(["headMoved"]),
            "another worktree's index change must be filtered out"
        );

        let only_foreign: GitStateEventBatch = Arc::new(vec![GitStateEvent {
            kind: GitStateEventKind::OperationChanged,
            scope: GitEventScope::Worktree(PathBuf::from("/repo/.git")),
        }]);
        assert!(git_message(&subscription, &only_foreign).is_none());
    }
}
