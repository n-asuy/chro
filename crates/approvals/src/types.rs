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

/// Who answered an approval. Client-asserted (localhost RPC has no auth), so
/// this is an attribution record, not a security boundary. It always resolves
/// to a concrete actor: an omitted `responded_by` defaults to [`ApprovalActor::User`]
/// (the UI never sends one), and the CLI stamps [`ApprovalActor::Agent`] from
/// `CHRO_TASK_ID` whenever it runs inside a chro session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApprovalActor {
    User,
    /// An agent responding via the CLI. `task` is the delegating session's
    /// id or slug; the server resolves it to a canonical task id when it
    /// enforces the self-approval ban.
    Agent {
        task: String,
    },
}

impl Default for ApprovalActor {
    fn default() -> Self {
        ApprovalActor::User
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub status: ApprovalStatus,
    /// Optional answers for AskUserQuestion tool.
    /// Keys are question texts, values are selected option labels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<std::collections::HashMap<String, String>>,
    /// Who is answering. Defaults to [`ApprovalActor::User`] when omitted so
    /// attribution is always recorded, never null.
    #[serde(default)]
    pub responded_by: ApprovalActor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalPendingInfo {
    pub approval_id: String,
    pub task_run_id: Uuid,
    pub tool_name: String,
    pub requested_at: DateTime<Utc>,
    pub timeout_at: DateTime<Utc>,
    /// Owning task of `task_run_id`. Enriched at the route layer (the approval
    /// service has no database), so it is `None` in service-built values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_slug: Option<String>,
}
