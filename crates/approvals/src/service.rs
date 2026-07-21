use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use log_types::{LogEntry, LogEntryPusher};
use thiserror::Error;
use tokio::{
    sync::{oneshot, RwLock},
    time::sleep,
};
use uuid::Uuid;

use crate::types::{
    ApprovalPendingInfo, ApprovalRequest, ApprovalResponse, ApprovalStatus, CreateApprovalRequest,
};

#[derive(Debug, Error)]
pub enum ApprovalError {
    #[error("approval not found")]
    NotFound,
    #[error("approval already completed")]
    AlreadyCompleted,
}

/// Data sent when an approval is resolved.
#[derive(Clone)]
pub struct ApprovalResolvedData {
    pub status: ApprovalStatus,
    pub answers: Option<std::collections::HashMap<String, String>>,
}

pub type ApprovalWaiter = oneshot::Receiver<ApprovalResolvedData>;

pub struct Approvals<S: LogEntryPusher + 'static> {
    pending: Arc<RwLock<HashMap<String, PendingApproval>>>,
    completed: Arc<RwLock<HashMap<String, ApprovalStatus>>>,
    msg_stores: Arc<RwLock<HashMap<Uuid, Arc<S>>>>,
}

impl<S: LogEntryPusher + 'static> Clone for Approvals<S> {
    fn clone(&self) -> Self {
        Self {
            pending: Arc::clone(&self.pending),
            completed: Arc::clone(&self.completed),
            msg_stores: Arc::clone(&self.msg_stores),
        }
    }
}

struct PendingApproval {
    request: ApprovalRequest,
    waiters: Vec<oneshot::Sender<ApprovalResolvedData>>,
}

impl PendingApproval {
    fn new(
        request: ApprovalRequest,
        waiter: Option<oneshot::Sender<ApprovalResolvedData>>,
    ) -> Self {
        Self {
            request,
            waiters: waiter.into_iter().collect(),
        }
    }

    fn notify(&mut self, data: ApprovalResolvedData) {
        for tx in self.waiters.drain(..) {
            let _ = tx.send(data.clone());
        }
    }
}

impl<S: LogEntryPusher + 'static> Approvals<S> {
    pub fn new(msg_stores: Arc<RwLock<HashMap<Uuid, Arc<S>>>>) -> Self {
        Self {
            pending: Arc::new(RwLock::new(HashMap::new())),
            completed: Arc::new(RwLock::new(HashMap::new())),
            msg_stores,
        }
    }

    pub async fn create_with_waiter(
        &self,
        payload: CreateApprovalRequest,
    ) -> Result<(ApprovalRequest, ApprovalWaiter), ApprovalError> {
        let request = ApprovalRequest::new(payload);
        let (tx, rx) = oneshot::channel();
        let request = self.register_pending(request, Some(tx)).await?;
        Ok((request, rx))
    }

    pub async fn create(
        &self,
        payload: CreateApprovalRequest,
    ) -> Result<ApprovalRequest, ApprovalError> {
        let request = ApprovalRequest::new(payload);
        self.register_pending(request, None).await
    }

    async fn register_pending(
        &self,
        request: ApprovalRequest,
        waiter: Option<oneshot::Sender<ApprovalResolvedData>>,
    ) -> Result<ApprovalRequest, ApprovalError> {
        let id = request.id.clone();
        self.pending
            .write()
            .await
            .insert(id.clone(), PendingApproval::new(request.clone(), waiter));
        self.push_patch(&request, &ApprovalStatus::Pending, PatchOp::Add)
            .await;
        self.spawn_timeout_watcher(id).await;
        Ok(request)
    }

    pub async fn respond(
        &self,
        id: &str,
        response: ApprovalResponse,
    ) -> Result<ApprovalStatus, ApprovalError> {
        let entry = self.pending.write().await.remove(id);
        match entry {
            Some(mut pending) => {
                let status = response.status.clone();
                let data = ApprovalResolvedData {
                    status: response.status,
                    answers: response.answers,
                };
                pending.notify(data);
                self.completed
                    .write()
                    .await
                    .insert(id.to_string(), status.clone());
                self.push_patch(&pending.request, &status, PatchOp::Replace)
                    .await;
                Ok(status)
            }
            None => {
                if self.completed.read().await.contains_key(id) {
                    Err(ApprovalError::AlreadyCompleted)
                } else {
                    Err(ApprovalError::NotFound)
                }
            }
        }
    }

    pub async fn status(&self, id: &str) -> Option<ApprovalStatus> {
        if let Some(status) = self.completed.read().await.get(id) {
            return Some(status.clone());
        }
        if let Some(pending) = self.pending.read().await.get(id) {
            if Utc::now() >= pending.request.timeout_at {
                return Some(ApprovalStatus::TimedOut);
            }
            return Some(ApprovalStatus::Pending);
        }
        None
    }

    /// Return the full pending request for a run, if any. Unlike
    /// [`Self::pending`], this includes `tool_input`, so callers can surface
    /// what the agent is blocked on (e.g. the AskUserQuestion question text).
    pub async fn pending_request_for_run(&self, task_run_id: Uuid) -> Option<ApprovalRequest> {
        self.pending
            .read()
            .await
            .values()
            .find(|pending| pending.request.task_run_id == task_run_id)
            .map(|pending| pending.request.clone())
    }

    pub async fn pending(&self) -> Vec<ApprovalPendingInfo> {
        self.pending
            .read()
            .await
            .values()
            .map(|pending| ApprovalPendingInfo {
                approval_id: pending.request.id.clone(),
                task_run_id: pending.request.task_run_id,
                tool_name: pending.request.tool_name.clone(),
                requested_at: pending.request.created_at,
                timeout_at: pending.request.timeout_at,
            })
            .collect()
    }

    async fn spawn_timeout_watcher(&self, id: String)
    where
        Self: Clone,
    {
        let approvals = self.clone();
        tokio::spawn(async move {
            let maybe_request = {
                approvals
                    .pending
                    .read()
                    .await
                    .get(&id)
                    .map(|p| p.request.clone())
            };
            if let Some(request) = maybe_request {
                let duration = timeout_duration(request.timeout_at);
                sleep(duration).await;
                approvals.mark_timed_out(&id).await;
            }
        });
    }

    async fn mark_timed_out(&self, id: &str) {
        let entry = self.pending.write().await.remove(id);
        if let Some(mut pending) = entry {
            let status = ApprovalStatus::TimedOut;
            let data = ApprovalResolvedData {
                status: status.clone(),
                answers: None,
            };
            pending.notify(data);
            self.completed
                .write()
                .await
                .insert(id.to_string(), status.clone());
            self.push_patch(&pending.request, &status, PatchOp::Replace)
                .await;
        }
    }

    async fn push_patch(&self, request: &ApprovalRequest, status: &ApprovalStatus, op: PatchOp) {
        if let Some(store) = self.msg_store_for_run(request.task_run_id).await {
            let value = approval_patch_value(request, status, op);
            store.push(LogEntry::JsonPatch(value));
        }
    }

    async fn msg_store_for_run(&self, task_run_id: Uuid) -> Option<Arc<S>> {
        self.msg_stores.read().await.get(&task_run_id).cloned()
    }
}

fn timeout_duration(timeout_at: DateTime<Utc>) -> Duration {
    let now = Utc::now();
    if timeout_at <= now {
        Duration::from_secs(0)
    } else {
        (timeout_at - now)
            .to_std()
            .unwrap_or_else(|_| Duration::from_secs(0))
    }
}

#[derive(Clone, Copy)]
enum PatchOp {
    Add,
    Replace,
}

fn approval_patch_value(
    request: &ApprovalRequest,
    status: &ApprovalStatus,
    op: PatchOp,
) -> serde_json::Value {
    let escaped_id = escape_json_pointer_segment(&request.id);
    let value = serde_json::json!({
        "id": request.id,
        "task_run_id": request.task_run_id,
        "tool_name": request.tool_name,
        "tool_input": request.tool_input,
        "created_at": request.created_at,
        "timeout_at": request.timeout_at,
        "status": status,
    });

    let op_value = match op {
        PatchOp::Add => "add",
        PatchOp::Replace => "replace",
    };

    serde_json::json!([
        {
            "op": op_value,
            "path": format!("/approvals/{}", escaped_id),
            "value": value
        }
    ])
}

fn escape_json_pointer_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}
