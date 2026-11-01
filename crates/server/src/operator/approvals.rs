//! Approvals: tool calls and questions a turn is suspended on.
//!
//! Answering is open to agents as well as people. Three rules govern it,
//! without a policy engine: an agent cannot answer its own session's approval;
//! every answer records who gave it, taken from the caller's token; and the
//! answering command is itself a tool call under the answering agent's own
//! approval mode, so no agent gains a permission its user did not give it.

use std::collections::HashMap;

use approvals::{ApprovalActor, ApprovalResponse, ApprovalStatus};
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use db::models::TaskRun;
use runtime::Runtime;
use serde::Deserialize;
use server_contract::{
    api::{ApprovalList, ApprovalView, Decision, Respond, Responded},
    ErrorCode,
};
use uuid::Uuid;

use super::{selectors, views, Caller, V1Error, V1Result, V1};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub(crate) struct ApprovalsQuery {
    session: Option<String>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Query(query): Query<ApprovalsQuery>,
) -> V1Result<ApprovalList> {
    let only = match query.session.as_deref() {
        Some(selector) => Some(selectors::session(state.pool(), caller, selector).await?.id),
        None => None,
    };
    let mut approvals = Vec::new();
    for (info, task_id) in views::pending_approvals(&state).await? {
        if only.is_some() && task_id != only {
            continue;
        }
        let request = state.runtime().approvals().request(&info.approval_id).await;
        approvals.push(
            views::approval_view(
                &state,
                &info.approval_id,
                request.as_ref(),
                &ApprovalStatus::Pending,
                Some(info.task_run_id),
            )
            .await?,
        );
    }
    Ok(V1(ApprovalList { approvals }))
}

pub(crate) async fn show(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> V1Result<ApprovalView> {
    let service = state.runtime().approvals();
    let status = service
        .status(&id)
        .await
        .ok_or_else(|| V1Error::not_found(format!("approval {id}")))?;
    let request = service.request(&id).await;
    Ok(V1(
        views::approval_view(&state, &id, request.as_ref(), &status, None).await?,
    ))
}

/// The session an approval belongs to, while it is still known.
async fn approval_session(state: &AppState, id: &str) -> Result<Option<Uuid>, V1Error> {
    let Some(request) = state.runtime().approvals().request(id).await else {
        return Ok(None);
    };
    Ok(TaskRun::find_by_id(state.pool(), request.task_run_id)
        .await?
        .map(|run| run.task_id))
}

pub(crate) async fn respond(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
    Json(body): Json<Respond>,
) -> V1Result<Responded> {
    let responded_by = match caller {
        Caller::User => ApprovalActor::User,
        Caller::Agent { task_id, .. } => {
            if approval_session(&state, &id).await? == Some(task_id) {
                return Err(V1Error::new(
                    ErrorCode::SelfResponseForbidden,
                    "an agent cannot answer an approval raised by its own session",
                ));
            }
            ApprovalActor::Agent { session: task_id }
        }
    };

    let status = match body.decision {
        Decision::Approve => ApprovalStatus::Approved,
        Decision::Deny => ApprovalStatus::Denied {
            reason: body.reason.clone(),
        },
    };
    let answers = (!body.answers.is_empty())
        .then(|| body.answers.into_iter().collect::<HashMap<_, _>>());
    let status = state
        .runtime()
        .approvals()
        .respond(
            &id,
            ApprovalResponse {
                status,
                answers,
                responded_by,
            },
        )
        .await
        .map_err(crate::ApiError::from)?;
    Ok(V1(Responded {
        status: status.as_str().to_string(),
    }))
}
