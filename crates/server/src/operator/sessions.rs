//! Sessions: create, inspect, message, delegate, fork, and land their work.

use std::{future::Future, path::PathBuf};

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use db::{
    models::{SessionQueueItem, TaskContextRef, TaskContextRefInput, TaskRecord, TaskRun},
    types::TaskStatus,
};
use executors::{BaseCodingAgent, ExecutorProfileId, ReasoningEffort};
use git::DiffTarget;
use runtime::{
    ForkWorkspace, MessageOptions, Runtime, RuntimeError, SendOutcome, SendTaskMessageParams,
    TaskService,
};
use serde::Deserialize;
use server_contract::{
    api::{
        AgentChoice, Delegate, DiffFile, DiffView, Fork, Forked, Merge, Merged, MessageAccepted,
        NewSession, Rebase, Rebased, RefDirection, RefView, Refs, SendMessage, SessionList,
        SessionListQuery, SessionStarted, SessionView, Transcript, UpdateSession,
        DEFAULT_SESSION_LIMIT,
    },
    ErrorCode,
};
use uuid::Uuid;

use super::{
    selectors,
    views::{self, fresh_session_view, session_ref, session_view, turn_view, SessionViewer},
    Caller, V1Error, V1Result, V1,
};
use crate::AppState;

/// Run work that must finish even if the caller hangs up. Starting a turn
/// writes several rows and spawns a process; abandoning it halfway (because
/// the HTTP request was dropped) would leave a session that looks started
/// but has nothing behind it.
async fn detached<T, F>(work: F) -> Result<T, RuntimeError>
where
    T: Send + 'static,
    F: Future<Output = Result<T, RuntimeError>> + Send + 'static,
{
    tokio::spawn(work)
        .await
        .map_err(|err| RuntimeError::Other(anyhow::anyhow!("turn start task failed: {err}")))?
}

fn parse_agent(name: &str) -> Result<BaseCodingAgent, V1Error> {
    match name.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "claude" | "claude-code" => Ok(BaseCodingAgent::ClaudeCode),
        "codex" => Ok(BaseCodingAgent::Codex),
        "pi" => Ok(BaseCodingAgent::Pi),
        other => Err(V1Error::invalid(format!(
            "unknown agent '{other}'; use claude, codex, or pi"
        ))),
    }
}

/// Executor profile for an explicit agent choice; `None` keeps the app's
/// configured default untouched.
async fn executor_profile(
    state: &AppState,
    choice: &AgentChoice,
) -> Result<Option<ExecutorProfileId>, V1Error> {
    if choice.is_default() {
        return Ok(None);
    }
    let executor = match choice.agent.as_deref() {
        Some(name) => parse_agent(name)?,
        None => {
            state
                .runtime()
                .current_config()
                .await
                .executor_profile
                .executor
        }
    };
    let reasoning_effort = match choice.effort.as_deref() {
        Some(effort) => Some(
            serde_json::from_value::<ReasoningEffort>(serde_json::Value::String(
                effort.trim().to_ascii_lowercase(),
            ))
            .map_err(|_| {
                V1Error::invalid(format!(
                    "unknown effort '{effort}'; use low, medium, high, xhigh, max, or ultra"
                ))
            })?,
        ),
        None => None,
    };
    Ok(Some(ExecutorProfileId {
        executor,
        variant: None,
        model: choice.model.clone(),
        reasoning_effort,
        speed: None,
    }))
}

async fn session_refs(
    state: &AppState,
    caller: Caller,
    selectors_: &[String],
) -> Result<Vec<TaskContextRefInput>, V1Error> {
    let mut refs = Vec::with_capacity(selectors_.len());
    for selector in selectors_ {
        let task = selectors::session(state.pool(), caller, selector).await?;
        refs.push(TaskContextRefInput::session(task.id, task.branch.clone()));
    }
    Ok(refs)
}

fn required(text: &str, what: &str) -> Result<String, V1Error> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(V1Error::invalid(format!("{what} must not be empty")));
    }
    Ok(text.to_string())
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Query(query): Query<SessionListQuery>,
) -> V1Result<SessionList> {
    let pool = state.pool();
    let mut tasks = match query.project.as_deref() {
        Some(selector) => {
            let project = selectors::project(pool, selector).await?;
            TaskRecord::list_by_project(pool, project.id).await?
        }
        None => TaskRecord::list_all(pool).await?,
    };
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    let limit = query.limit.unwrap_or(DEFAULT_SESSION_LIMIT) as usize;
    let mut viewer = SessionViewer::new(&state).await?;
    let mut sessions = Vec::new();
    for task in &tasks {
        if sessions.len() >= limit {
            break;
        }
        if query.status.as_deref().is_some_and(|status| {
            serde_json::to_value(task.status).ok() != Some(serde_json::json!(status))
        }) {
            continue;
        }
        let view = viewer.view(task).await?;
        if query.state.is_some_and(|wanted| wanted != view.state) {
            continue;
        }
        sessions.push(view);
    }
    Ok(V1(SessionList { sessions }))
}

pub(crate) async fn show(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
) -> V1Result<SessionView> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    Ok(V1(session_view(&state, &task).await?))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<NewSession>,
) -> V1Result<SessionStarted> {
    let prompt = required(&body.prompt, "prompt")?;
    let project = selectors::project_ensuring(state.pool(), &body.project).await?;
    let refs = session_refs(&state, caller, &body.refs).await?;
    let profile = executor_profile(&state, &body.agent).await?;
    state.spawn_index_prewarm(PathBuf::from(&project.git_repo_path));

    let runtime = state.runtime().clone();
    let title = body.title.clone();
    let start = body.start;
    let (task_id, turn) = detached(async move {
        let service = TaskService::new(&runtime);
        let task = service
            .create_task(
                project.id,
                title.clone(),
                None,
                Some(prompt.clone()),
                refs.clone(),
            )
            .await?;
        // A title someone chose is pinned, like a rename in the app, so the
        // title generated when the first turn starts does not replace it.
        if let Some(title) = title {
            service.update_task_title(task.id, title).await?;
        }
        if !start {
            return Ok((task.id, None));
        }
        let started = service
            .send_task_message(SendTaskMessageParams {
                task_id: task.id,
                prompt,
                options: MessageOptions {
                    executor_profile_id: profile,
                    context_refs: refs,
                    ..MessageOptions::default()
                },
            })
            .await?;
        Ok((task.id, Some(started.execution.task_run)))
    })
    .await?;

    Ok(V1(SessionStarted {
        session: fresh_session_view(&state, task_id).await?,
        turn: turn.as_ref().map(turn_view),
    }))
}

pub(crate) async fn update(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Json(body): Json<UpdateSession>,
) -> V1Result<SessionView> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let service = TaskService::new(state.runtime());
    if let Some(title) = body.title.as_deref() {
        service
            .update_task_title(task.id, required(title, "title")?.trim().to_string())
            .await?;
    }
    if let Some(status) = body.status.as_deref() {
        let status: TaskStatus = serde_json::from_value(serde_json::json!(status)).map_err(|_| {
            V1Error::invalid(format!(
                "unknown status '{status}'; use pending, in_progress, completed, failed, or cancelled"
            ))
        })?;
        service.update_task_status(task.id, status).await?;
    }
    if let Some(note) = body.note.as_deref() {
        let note = note.trim();
        TaskRecord::set_note(state.pool(), task.id, (!note.is_empty()).then_some(note)).await?;
    }
    Ok(V1(fresh_session_view(&state, task.id).await?))
}

pub(crate) async fn delegate(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Json(body): Json<Delegate>,
) -> V1Result<SessionStarted> {
    let prompt = required(&body.prompt, "prompt")?;
    let source = selectors::session(state.pool(), caller, &selector).await?;
    let profile = executor_profile(&state, &body.agent).await?;
    let runtime = state.runtime().clone();
    let child = detached(async move {
        TaskService::new(&runtime)
            .delegate_task(source.id, prompt, profile)
            .await
    })
    .await?;
    let turn = TaskRun::latest_for_task(state.pool(), child.id).await?;
    Ok(V1(SessionStarted {
        session: session_view(&state, &child).await?,
        turn: turn.as_ref().map(turn_view),
    }))
}

pub(crate) async fn fork(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Json(body): Json<Fork>,
) -> V1Result<Forked> {
    let source = selectors::session(state.pool(), caller, &selector).await?;
    let prompt = match body.prompt.as_deref() {
        Some(prompt) => Some(required(prompt, "prompt")?),
        None => None,
    };
    let runtime = state.runtime().clone();
    let (outcome, turn) = detached(async move {
        let service = TaskService::new(&runtime);
        let outcome = service
            .fork_task_latest(source.id, ForkWorkspace::Same)
            .await?;
        let turn = match prompt {
            Some(prompt) => match service
                .send_or_queue(SendTaskMessageParams::text(outcome.task.id, prompt), true)
                .await?
            {
                SendOutcome::Started(start) => Some(start.execution.task_run),
                SendOutcome::Queued { .. } => None,
            },
            None => None,
        };
        Ok((outcome, turn))
    })
    .await?;
    Ok(V1(Forked {
        session: fresh_session_view(&state, outcome.task.id).await?,
        mode: serde_json::to_value(outcome.mode)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default(),
        turn: turn.as_ref().map(turn_view),
    }))
}

pub(crate) async fn send(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Json(body): Json<SendMessage>,
) -> V1Result<MessageAccepted> {
    let prompt = required(&body.prompt, "prompt")?;
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let handle = views::session_ref(&task).handle();
    let runtime = state.runtime().clone();
    let outcome = detached(async move {
        TaskService::new(&runtime)
            .send_or_queue(SendTaskMessageParams::text(task.id, prompt), body.queue)
            .await
    })
    .await
    .map_err(|err| {
        let err = V1Error::from(err);
        if err.0.code == ErrorCode::SessionBusy {
            err.with_next(format!("chro session wait {handle} --for idle"))
                .with_next(format!("chro session send {handle} --prompt <text>"))
        } else {
            err
        }
    })?;
    Ok(V1(match outcome {
        SendOutcome::Started(start) => MessageAccepted {
            queued: false,
            position: None,
            turn: Some(turn_view(&start.execution.task_run)),
        },
        SendOutcome::Queued { position } => MessageAccepted {
            queued: true,
            position: Some(position),
            turn: None,
        },
    }))
}

/// Stop the session: discard queued messages, then cancel the turn in flight.
/// Queue first, so finishing the cancelled turn cannot start the next one.
pub(crate) async fn cancel(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
) -> V1Result<SessionView> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let service = TaskService::new(state.runtime());
    service.clear_session_queue(task.id).await?;
    for run in TaskRun::list_by_task_id(state.pool(), task.id).await? {
        if views::is_in_flight(&run) {
            state.runtime().cancel_execution(run.id).await?;
        }
    }
    Ok(V1(fresh_session_view(&state, task.id).await?))
}

/// Withdraw one queued message before it becomes a turn.
pub(crate) async fn unqueue(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((selector, message)): Path<(String, String)>,
) -> V1Result<SessionView> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let queue: Vec<Uuid> = SessionQueueItem::list_by_task(state.pool(), task.id)
        .await?
        .into_iter()
        .map(|item| item.id)
        .collect();
    let id = selectors::queued_message(&queue, &message)?;
    // It can start between the lookup and here; that is the same outcome as
    // asking too late.
    if !TaskService::new(state.runtime())
        .withdraw_queued(task.id, id)
        .await?
    {
        return Err(selectors::queued_message(&[], &message).unwrap_err());
    }
    Ok(V1(fresh_session_view(&state, task.id).await?))
}

#[derive(Debug, Deserialize)]
pub(crate) struct RefsQuery {
    #[serde(default)]
    direction: RefDirection,
}

pub(crate) async fn refs(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Query(query): Query<RefsQuery>,
) -> V1Result<Refs> {
    let pool = state.pool();
    let task = selectors::session(pool, caller, &selector).await?;
    let edges = match query.direction {
        RefDirection::Outbound => TaskContextRef::list_by_task_id(pool, task.id).await?,
        RefDirection::Inbound => TaskContextRef::list_referencing_task_id(pool, task.id).await?,
    };
    let mut refs = Vec::with_capacity(edges.len());
    for edge in edges {
        let other: Option<Uuid> = match query.direction {
            RefDirection::Outbound => edge.target_task_id,
            RefDirection::Inbound => Some(edge.task_id),
        };
        let session = match other {
            Some(id) => TaskRecord::find_by_id(pool, id)
                .await?
                .map(|task| session_ref(&task)),
            None => None,
        };
        refs.push(RefView {
            kind: edge.kind,
            session,
            label: edge.label.or(edge.path),
            created_at: edge.created_at,
        });
    }
    Ok(V1(Refs { refs }))
}

pub(crate) async fn diff(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
) -> V1Result<DiffView> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let run = TaskRun::latest_for_task(state.pool(), task.id)
        .await?
        .ok_or_else(|| V1Error::not_found(format!("turn in session {selector}")))?;
    let (Some(branch), Some(target), Some(worktree)) = (
        run.branch_name.clone(),
        run.target_branch.clone(),
        run.workspace_path.clone(),
    ) else {
        return Err(V1Error::invalid(
            "this session does not work on a git branch, so it has nothing to diff",
        ));
    };
    if run.worktree_deleted {
        return Err(V1Error::invalid(
            "this session's worktree was cleaned up; only its history remains",
        ));
    }

    let git = state.runtime().git().clone();
    let (branch_for_diff, target_for_diff, worktree_for_diff) =
        (branch.clone(), target.clone(), worktree.clone());
    let (base, diffs) = tokio::task::spawn_blocking(move || {
        let worktree_path = std::path::Path::new(&worktree_for_diff);
        let base = git.get_base_commit(worktree_path, &branch_for_diff, &target_for_diff)?;
        let diffs = git.get_diffs(
            DiffTarget::Worktree {
                worktree_path,
                base_commit: base,
            },
            None,
        )?;
        Ok::<_, git::GitServiceError>((base, diffs))
    })
    .await
    .map_err(|err| V1Error::new(ErrorCode::Internal, err.to_string()))?
    .map_err(RuntimeError::from)?;

    let files = diffs
        .iter()
        .filter_map(|diff| {
            Some(DiffFile {
                path: diff.path_key()?.to_string(),
                additions: diff.additions.unwrap_or(0) as u32,
                deletions: diff.deletions.unwrap_or(0) as u32,
            })
        })
        .collect();
    Ok(V1(DiffView {
        branch,
        target_branch: target,
        base_commit: base.as_oid().to_string(),
        worktree,
        files,
    }))
}

async fn latest_run(state: &AppState, task: &TaskRecord) -> Result<TaskRun, V1Error> {
    TaskRun::latest_for_task(state.pool(), task.id)
        .await?
        .ok_or_else(|| V1Error::invalid("this session has no turns yet"))
}

pub(crate) async fn merge(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Json(body): Json<Merge>,
) -> V1Result<Merged> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let run = latest_run(&state, &task).await?;
    let runtime = state.runtime().clone();
    let outcome = detached(async move {
        TaskService::new(&runtime)
            .merge_task_run(run.id, body.message)
            .await
    })
    .await?;
    Ok(V1(Merged {
        merge_commit: outcome.merge_commit,
        target_branch: outcome.target_branch,
    }))
}

pub(crate) async fn rebase(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Json(body): Json<Rebase>,
) -> V1Result<Rebased> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let run = latest_run(&state, &task).await?;
    let onto = body
        .onto
        .or_else(|| run.target_branch.clone())
        .ok_or_else(|| V1Error::invalid("this session has no target branch; pass --onto"))?;
    let runtime = state.runtime().clone();
    let outcome = detached(async move {
        TaskService::new(&runtime)
            .rebase_task_run(run.id, onto, None)
            .await
    })
    .await?;
    Ok(V1(Rebased {
        onto: outcome.new_base_branch,
    }))
}

pub(crate) async fn transcript(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
) -> V1Result<Transcript> {
    let task = selectors::session(state.pool(), caller, &selector).await?;
    let markdown = state.runtime().task_transcript_markdown(task.id).await?;
    Ok(V1(Transcript { markdown }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_names_accept_the_spellings_people_use() {
        for name in ["claude", "Claude-Code", "claude_code"] {
            assert!(matches!(parse_agent(name), Ok(BaseCodingAgent::ClaudeCode)));
        }
        assert!(matches!(parse_agent("codex"), Ok(BaseCodingAgent::Codex)));
        assert!(matches!(parse_agent("pi"), Ok(BaseCodingAgent::Pi)));
        assert_eq!(
            parse_agent("gpt").unwrap_err().0.code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn blank_text_is_refused() {
        assert!(required("  ", "prompt").is_err());
        assert_eq!(required(" go ", "prompt").unwrap(), " go ");
    }
}
