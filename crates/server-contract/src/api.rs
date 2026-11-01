//! Request and result bodies of the operator API.
//!
//! The CLI's nouns are the user's: a *session* is what the app lists as a
//! session, a *turn* is one agent execution inside it, and a *project* is a
//! repository or folder. Internal storage names never appear here.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Who a request acts as, decided by the server from the bearer token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CallerView {
    User,
    Agent { session: SessionRef },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusView {
    pub version: String,
    pub contract_rev: String,
    pub runtime_id: String,
    pub pid: u32,
    pub url: String,
    pub caller: CallerView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectView {
    pub id: Uuid,
    pub slug: Option<String>,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnsureProject {
    /// Absolute path of a repository or folder; registered when unknown.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectList {
    pub projects: Vec<ProjectView>,
}

/// Short reference to a session, enough to address it again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRef {
    pub id: Uuid,
    pub slug: Option<String>,
    pub title: String,
}

impl SessionRef {
    /// The shortest identifier that addresses this session.
    pub fn handle(&self) -> String {
        self.slug.clone().unwrap_or_else(|| self.id.to_string())
    }
}

/// Derived from what the session is doing right now, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// No turn in flight; a message starts one immediately.
    Idle,
    /// A turn is executing.
    Running,
    /// A turn is suspended on an unanswered approval or question.
    AwaitingInput,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Idle => "idle",
            SessionState::Running => "running",
            SessionState::AwaitingInput => "awaiting_input",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnView {
    pub id: Uuid,
    pub slug: Option<String>,
    /// `pending`, `running`, `completed`, `failed` or `cancelled`.
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionView {
    pub id: Uuid,
    pub slug: Option<String>,
    pub title: String,
    pub project: ProjectView,
    pub state: SessionState,
    /// Outcome of the latest turn: `pending`, `in_progress`, `completed`,
    /// `failed` or `cancelled`.
    pub status: String,
    /// Agent the latest turn ran with, e.g. `CLAUDE_CODE`.
    pub agent: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    /// Short status line the session's agent (or a person) set.
    pub note: Option<String>,
    /// One-line outcome of the latest completed turn.
    pub summary: Option<String>,
    /// The latest turn, in flight or not.
    pub turn: Option<TurnView>,
    /// Messages waiting for the current turn to end, oldest (next) first.
    pub queue: Vec<QueuedMessage>,
    /// The session that delegated this one.
    pub parent: Option<SessionRef>,
    /// Sessions this one delegated.
    pub children: Vec<SessionRef>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A message waiting in a session's queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueuedMessage {
    pub id: Uuid,
    pub prompt: String,
    pub created_at: DateTime<Utc>,
}

impl SessionView {
    pub fn as_ref(&self) -> SessionRef {
        SessionRef {
            id: self.id,
            slug: self.slug.clone(),
            title: self.title.clone(),
        }
    }

    pub fn handle(&self) -> String {
        self.as_ref().handle()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionList {
    pub sessions: Vec<SessionView>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<SessionState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Most recently updated first; defaults to [`DEFAULT_SESSION_LIMIT`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

pub const DEFAULT_SESSION_LIMIT: u32 = 50;

/// Which agent runs a turn. Every field falls back to the app's settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentChoice {
    /// `claude`, `codex` or `pi`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `low`, `medium`, `high`, `xhigh`, `max` or `ultra`; honored by agents and
    /// models that support it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl AgentChoice {
    pub fn is_default(&self) -> bool {
        self.agent.is_none() && self.model.is_none() && self.effort.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewSession {
    /// Project selector: slug, id, or `path:<dir>`.
    pub project: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, flatten)]
    pub agent: AgentChoice,
    /// Sessions attached as context.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<String>,
    /// `false` creates the session without starting a turn.
    #[serde(default = "default_true")]
    pub start: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStarted {
    pub session: SessionView,
    pub turn: Option<TurnView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delegate {
    pub prompt: String,
    #[serde(default, flatten)]
    pub agent: AgentChoice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fork {
    /// First message of the fork; without one the fork waits idle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Forked {
    pub session: SessionView,
    /// `native` when the agent duplicated the conversation, `digest` when the
    /// fork starts from a summary of it instead.
    pub mode: String,
    pub turn: Option<TurnView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendMessage {
    pub prompt: String,
    /// When the session is busy: `true` queues the message behind the current
    /// turn, `false` fails with `session_busy`.
    #[serde(default = "default_true")]
    pub queue: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageAccepted {
    pub queued: bool,
    /// 1-based place in the queue when `queued`.
    pub position: Option<u32>,
    /// The turn the message started when not queued.
    pub turn: Option<TurnView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitFor {
    /// No turn in flight and nothing queued.
    Idle,
    /// A turn is suspended on an approval or question.
    Input,
    /// Whichever of `idle` and `input` comes first: someone else's move.
    Settled,
}

impl WaitFor {
    pub fn as_str(self) -> &'static str {
        match self {
            WaitFor::Idle => "idle",
            WaitFor::Input => "input",
            WaitFor::Settled => "settled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitQuery {
    #[serde(rename = "for")]
    pub condition: WaitFor,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WaitOutcome {
    /// `idle` or `input`: the condition that held.
    pub reason: WaitFor,
    pub session: SessionView,
    /// The approval the session is suspended on, for `input`.
    pub approval: Option<ApprovalView>,
}

/// Longest wait a server accepts.
pub const MAX_WAIT_MS: u64 = 2 * 60 * 60 * 1000;
/// Wait used when the caller names none.
pub const DEFAULT_WAIT_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntriesQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    User,
    Assistant,
    Tool,
    Error,
    /// Marks where a turn ended; `status` holds its outcome.
    TurnEnd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryView {
    /// Pass as `since` to read only what follows this entry.
    pub cursor: String,
    /// Turn the entry belongs to.
    pub turn: String,
    pub kind: EntryKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entries {
    pub entries: Vec<EntryView>,
    /// Cursor of the last entry returned, or the `since` that was passed when
    /// nothing new exists. `None` only for a session with no entries at all.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transcript {
    pub markdown: String,
}

/// Fields to change; absent fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateSession {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// An empty string clears the note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefView {
    /// `session`, `task`, `file`, `directory`, `skill`, `image`, `fork`,
    /// `delegate` or `handoff`.
    pub kind: String,
    pub session: Option<SessionRef>,
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refs {
    pub refs: Vec<RefView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefDirection {
    /// What this session references.
    #[default]
    Outbound,
    /// What references this session.
    Inbound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// What merging the session would bring into its target branch: the
/// worktree, uncommitted work included, against the merge base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffView {
    pub branch: String,
    pub target_branch: String,
    pub base_commit: String,
    pub worktree: String,
    pub files: Vec<DiffFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Merge {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Merged {
    pub merge_commit: String,
    pub target_branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rebase {
    /// Defaults to the branch the session's turn targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onto: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rebased {
    pub onto: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalView {
    pub id: String,
    pub session: Option<SessionRef>,
    pub turn: Uuid,
    pub tool: String,
    /// The tool call awaiting a decision, including AskUserQuestion's
    /// questions and options. Absent once the approval is answered.
    pub input: Option<Value>,
    /// `pending`, `approved`, `denied` or `timed_out`.
    pub status: String,
    pub requested_at: Option<DateTime<Utc>>,
    pub timeout_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalList {
    pub approvals: Vec<ApprovalView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Respond {
    pub decision: Decision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// AskUserQuestion answers: question text to chosen option label.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub answers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Responded {
    pub status: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn new_session_starts_by_default_and_flattens_the_agent_choice() {
        let parsed: NewSession = serde_json::from_value(json!({
            "project": "path:/repo",
            "prompt": "fix it",
            "agent": "codex",
            "effort": "high"
        }))
        .unwrap();
        assert!(parsed.start);
        assert_eq!(parsed.agent.agent.as_deref(), Some("codex"));
        assert_eq!(parsed.agent.effort.as_deref(), Some("high"));
    }

    #[test]
    fn messages_queue_unless_told_otherwise() {
        let parsed: SendMessage = serde_json::from_value(json!({ "prompt": "next" })).unwrap();
        assert!(parsed.queue);
    }

    #[test]
    fn wait_query_uses_the_for_keyword() {
        let query = WaitQuery {
            condition: WaitFor::Settled,
            timeout_ms: 1000,
        };
        assert_eq!(
            serde_json::to_value(query).unwrap(),
            json!({ "for": "settled", "timeout_ms": 1000 })
        );
    }

    #[test]
    fn caller_is_tagged_by_kind() {
        let caller = CallerView::Agent {
            session: SessionRef {
                id: Uuid::nil(),
                slug: Some("ab12cd34".into()),
                title: "t".into(),
            },
        };
        let value = serde_json::to_value(caller).unwrap();
        assert_eq!(value["kind"], json!("agent"));
        assert_eq!(value["session"]["slug"], json!("ab12cd34"));
    }

    #[test]
    fn handle_prefers_the_slug() {
        let with_slug = SessionRef {
            id: Uuid::nil(),
            slug: Some("ab12cd34".into()),
            title: String::new(),
        };
        assert_eq!(with_slug.handle(), "ab12cd34");
        let without = SessionRef {
            slug: None,
            ..with_slug
        };
        assert_eq!(without.handle(), Uuid::nil().to_string());
    }
}
