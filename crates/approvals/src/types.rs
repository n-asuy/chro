use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const APPROVAL_TIMEOUT_SECONDS: i64 = 3600; // 1 hour timeout

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateApprovalRequest {
    pub task_run_id: Uuid,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub task_run_id: Uuid,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub timeout_at: DateTime<Utc>,
}

impl ApprovalRequest {
    pub fn new(payload: CreateApprovalRequest) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            task_run_id: payload.task_run_id,
            tool_name: payload.tool_name,
            tool_input: payload.tool_input,
            created_at: now,
            timeout_at: now + Duration::seconds(APPROVAL_TIMEOUT_SECONDS),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied { reason: Option<String> },
    TimedOut,
}

impl ApprovalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalStatus::Pending => "pending",
            ApprovalStatus::Approved => "approved",
            ApprovalStatus::Denied { .. } => "denied",
            ApprovalStatus::TimedOut => "timed_out",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub status: ApprovalStatus,
    /// Optional answers for AskUserQuestion tool.
    /// Keys are question texts, values are selected option labels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalPendingInfo {
    pub approval_id: String,
    pub task_run_id: Uuid,
    pub tool_name: String,
    pub requested_at: DateTime<Utc>,
    pub timeout_at: DateTime<Utc>,
}
