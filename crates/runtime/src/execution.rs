use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ExecutionStartParams {
    pub task_run_id: Uuid,
    pub executor_session_id: Uuid,
    pub prompt: String,
    pub workspace_path: PathBuf,
    pub resume_session_id: Option<String>,
    pub force_new_attempt: Option<bool>,
    /// Branch `resume_session_id` instead of continuing it, so the session this
    /// run came from stays untouched. Set on a forked task's first turn.
    pub fork_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEvent {
    Stream {
        id: Uuid,
        event: Value,
    },
    Stdout {
        id: Uuid,
        data: String,
    },
    Stderr {
        id: Uuid,
        data: String,
    },
    Exit {
        id: Uuid,
        code: Option<i32>,
        signal: Option<String>,
    },
    Error {
        id: Uuid,
        message: String,
    },
}
