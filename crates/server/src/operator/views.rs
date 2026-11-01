//! Building operator API views from stored records.

use std::collections::{HashMap, HashSet};

use approvals::{ApprovalPendingInfo, ApprovalRequest};
use db::{
    models::{ProjectRecord, SessionQueueItem, TaskContextRef, TaskRecord, TaskRun},
    types::RunStatus,
};
use runtime::{Runtime, TaskService};
use server_contract::api::{
    ApprovalView, ProjectView, QueuedMessage, SessionRef, SessionState, SessionView, TurnView,
};
use uuid::Uuid;

use super::V1Error;
use crate::AppState;

/// The state a session is in, from what is true of it right now.
pub(crate) fn derive_state(
    turn_in_flight: bool,
    pending_approval: bool,
    awaiting_question: bool,
) -> SessionState {
    if !turn_in_flight {
        SessionState::Idle
    } else if pending_approval || awaiting_question {
        SessionState::AwaitingInput
    } else {
        SessionState::Running
    }
}

fn snake(value: impl serde::Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(text)) => text,
        _ => String::new(),
    }
}

pub(crate) fn project_view(project: &ProjectRecord) -> ProjectView {
    ProjectView {
        id: project.id,
        slug: project.slug.clone(),
        name: project.name.clone(),
        path: project.git_repo_path.clone(),
    }
}

pub(crate) fn turn_view(run: &TaskRun) -> TurnView {
    TurnView {
        id: run.id,
        slug: run.slug.clone(),
        status: snake(run.status),
        started_at: run.started_at.unwrap_or(run.created_at),
        completed_at: run.completed_at,
    }
}

pub(crate) fn session_ref(task: &TaskRecord) -> SessionRef {
    SessionRef {
        id: task.id,
        slug: task.slug.clone(),
        title: task.title.clone(),
    }
}

/// Pending approvals with the session each belongs to.
pub(crate) async fn pending_approvals(
    state: &AppState,
) -> Result<Vec<(ApprovalPendingInfo, Option<Uuid>)>, V1Error> {
    let mut out = Vec::new();
    for info in state.runtime().approvals().pending().await {
        let task_id = TaskRun::find_by_id(state.pool(), info.task_run_id)
            .await?
            .map(|run| run.task_id);
        out.push((info, task_id));
    }
    Ok(out)
}

/// Builds many session views while reading the shared facts once.
pub(crate) struct SessionViewer<'a> {
    state: &'a AppState,
    projects: HashMap<Uuid, ProjectView>,
    sessions_with_pending: HashSet<Uuid>,
}

impl<'a> SessionViewer<'a> {
    pub async fn new(state: &'a AppState) -> Result<Self, V1Error> {
        let sessions_with_pending = pending_approvals(state)
            .await?
            .into_iter()
            .filter_map(|(_, task_id)| task_id)
            .collect();
        Ok(Self {
            state,
            projects: HashMap::new(),
            sessions_with_pending,
        })
    }

    pub async fn view(&mut self, task: &TaskRecord) -> Result<SessionView, V1Error> {
        let pool = self.state.pool();
        let project = match self.projects.get(&task.project_id) {
            Some(project) => project.clone(),
            None => {
                let project = project_view(&ProjectRecord::get(pool, task.project_id).await?);
                self.projects.insert(task.project_id, project.clone());
                project
            }
        };
        let latest = TaskRun::latest_for_task(pool, task.id).await?;
        let in_flight = TaskService::new(self.state.runtime())
            .turn_in_flight(task.id)
            .await?;
        let state = derive_state(
            in_flight,
            self.sessions_with_pending.contains(&task.id),
            task.awaiting_input,
        );

        let edges = TaskContextRef::list_by_task_id(pool, task.id).await?;
        let parent = match edges
            .iter()
            .find(|edge| edge.kind == "delegate")
            .and_then(|edge| edge.target_task_id)
        {
            Some(parent_id) => TaskRecord::find_by_id(pool, parent_id)
                .await?
                .map(|parent| session_ref(&parent)),
            None => None,
        };
        let mut children = Vec::new();
        for edge in TaskContextRef::list_referencing_task_id(pool, task.id).await? {
            if edge.kind != "delegate" {
                continue;
            }
            if let Some(child) = TaskRecord::find_by_id(pool, edge.task_id).await? {
                children.push(session_ref(&child));
            }
        }

        Ok(SessionView {
            id: task.id,
            slug: task.slug.clone(),
            title: task.title.clone(),
            project,
            state,
            status: snake(task.status),
            agent: task.last_executor.clone(),
            branch: task.branch.clone(),
            worktree: latest
                .as_ref()
                .and_then(|run| run.workspace_path.clone())
                .or_else(|| task.worktree_path.clone()),
            note: task.note.clone(),
            summary: task.last_summary.clone(),
            turn: latest.as_ref().map(turn_view),
            queue: SessionQueueItem::list_by_task(pool, task.id)
                .await?
                .into_iter()
                .map(|item| QueuedMessage {
                    id: item.id,
                    prompt: item.prompt,
                    created_at: item.created_at,
                })
                .collect(),
            parent,
            children,
            created_at: task.created_at,
            updated_at: task.updated_at,
        })
    }
}

pub(crate) async fn session_view(
    state: &AppState,
    task: &TaskRecord,
) -> Result<SessionView, V1Error> {
    SessionViewer::new(state).await?.view(task).await
}

/// Refetch the session and build its view, for results that follow a change.
pub(crate) async fn fresh_session_view(
    state: &AppState,
    task_id: Uuid,
) -> Result<SessionView, V1Error> {
    let task = TaskRecord::get(state.pool(), task_id).await?;
    session_view(state, &task).await
}

pub(crate) async fn approval_view(
    state: &AppState,
    id: &str,
    request: Option<&ApprovalRequest>,
    status: &approvals::ApprovalStatus,
    turn: Option<Uuid>,
) -> Result<ApprovalView, V1Error> {
    let turn = request.map(|r| r.task_run_id).or(turn).unwrap_or_default();
    let session = match TaskRun::find_by_id(state.pool(), turn).await? {
        Some(run) => TaskRecord::find_by_id(state.pool(), run.task_id)
            .await?
            .map(|task| session_ref(&task)),
        None => None,
    };
    Ok(ApprovalView {
        id: id.to_string(),
        session,
        turn,
        tool: request.map(|r| r.tool_name.clone()).unwrap_or_default(),
        input: request.map(|r| r.tool_input.clone()),
        status: status.as_str().to_string(),
        requested_at: request.map(|r| r.created_at),
        timeout_at: request.map(|r| r.timeout_at),
    })
}

/// Whether a run counts as in flight for turn bookkeeping.
pub(crate) fn is_in_flight(run: &TaskRun) -> bool {
    !run.dropped && matches!(run.status, RunStatus::Pending | RunStatus::Running)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_without_a_turn_in_flight_is_idle_whatever_else_holds() {
        assert_eq!(derive_state(false, true, true), SessionState::Idle);
    }

    #[test]
    fn a_turn_waiting_on_an_answer_awaits_input() {
        assert_eq!(derive_state(true, true, false), SessionState::AwaitingInput);
        assert_eq!(derive_state(true, false, true), SessionState::AwaitingInput);
    }

    #[test]
    fn a_turn_that_needs_nothing_is_running() {
        assert_eq!(derive_state(true, false, false), SessionState::Running);
    }
}
