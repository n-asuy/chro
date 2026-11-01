//! The closed set of failures the operator API and the CLI report.
//!
//! Every failure carries one [`ErrorCode`]. The code decides the HTTP status a
//! server answers with and the exit code the CLI ends with, so callers branch
//! on the code and never on message text.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The command line itself is wrong (unknown flag, missing argument).
    Usage,
    /// The request is well-formed but its values are not acceptable.
    InvalidRequest,
    /// A selector cannot be used here, e.g. `self` outside a chro session.
    InvalidSelector,
    NotFound,
    /// A selector matches more than one object; see `candidates`.
    Ambiguous,
    /// The session already has a turn in flight and queueing was refused.
    SessionBusy,
    /// Git refused the operation (diverged branches, dirty worktree, ...).
    GitConflict,
    /// An agent tried to answer an approval raised by its own session.
    SelfResponseForbidden,
    /// The approval was already answered or timed out.
    ApprovalClosed,
    /// Another request with the same request id is still running.
    RequestInProgress,
    /// No runtime file: the chro app or server is not running.
    RuntimeNotRunning,
    /// A runtime file exists but the process it names is gone.
    RuntimeStale,
    /// The runtime file names a server that does not answer.
    Unreachable,
    /// A wait ran out of time before its condition held.
    Timeout,
    /// Missing, expired, or unknown token.
    Unauthorized,
    /// The CLI and the server were built from different contracts.
    ContractMismatch,
    Internal,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 17] = [
        ErrorCode::Usage,
        ErrorCode::InvalidRequest,
        ErrorCode::InvalidSelector,
        ErrorCode::NotFound,
        ErrorCode::Ambiguous,
        ErrorCode::SessionBusy,
        ErrorCode::GitConflict,
        ErrorCode::SelfResponseForbidden,
        ErrorCode::ApprovalClosed,
        ErrorCode::RequestInProgress,
        ErrorCode::RuntimeNotRunning,
        ErrorCode::RuntimeStale,
        ErrorCode::Unreachable,
        ErrorCode::Timeout,
        ErrorCode::Unauthorized,
        ErrorCode::ContractMismatch,
        ErrorCode::Internal,
    ];

    /// Process exit code of a CLI command that failed with this code.
    pub fn exit_code(self) -> u8 {
        match self {
            ErrorCode::Internal => 1,
            ErrorCode::Usage | ErrorCode::InvalidRequest | ErrorCode::InvalidSelector => 2,
            ErrorCode::NotFound | ErrorCode::Ambiguous => 3,
            ErrorCode::SessionBusy
            | ErrorCode::GitConflict
            | ErrorCode::SelfResponseForbidden
            | ErrorCode::ApprovalClosed
            | ErrorCode::RequestInProgress => 4,
            ErrorCode::RuntimeNotRunning | ErrorCode::RuntimeStale | ErrorCode::Unreachable => 5,
            ErrorCode::Timeout => 6,
            ErrorCode::Unauthorized | ErrorCode::ContractMismatch => 7,
        }
    }

    /// HTTP status a server answers with. Codes that only the CLI produces
    /// (it never reached a server) still get one so the table is total.
    pub fn http_status(self) -> u16 {
        match self {
            ErrorCode::Usage | ErrorCode::InvalidRequest | ErrorCode::InvalidSelector => 400,
            ErrorCode::Unauthorized => 401,
            ErrorCode::SelfResponseForbidden => 403,
            ErrorCode::NotFound => 404,
            ErrorCode::Timeout => 408,
            ErrorCode::Ambiguous
            | ErrorCode::SessionBusy
            | ErrorCode::GitConflict
            | ErrorCode::ApprovalClosed
            | ErrorCode::RequestInProgress
            | ErrorCode::ContractMismatch => 409,
            ErrorCode::Internal => 500,
            ErrorCode::RuntimeNotRunning | ErrorCode::RuntimeStale | ErrorCode::Unreachable => 503,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Usage => "usage",
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::InvalidSelector => "invalid_selector",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Ambiguous => "ambiguous",
            ErrorCode::SessionBusy => "session_busy",
            ErrorCode::GitConflict => "git_conflict",
            ErrorCode::SelfResponseForbidden => "self_response_forbidden",
            ErrorCode::ApprovalClosed => "approval_closed",
            ErrorCode::RequestInProgress => "request_in_progress",
            ErrorCode::RuntimeNotRunning => "runtime_not_running",
            ErrorCode::RuntimeStale => "runtime_stale",
            ErrorCode::Unreachable => "unreachable",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Unauthorized => "unauthorized",
            ErrorCode::ContractMismatch => "contract_mismatch",
            ErrorCode::Internal => "internal",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The `error` member of a failed response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    /// Complete command lines to run next, in order of preference.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub next: Vec<String>,
    /// For `ambiguous`: the identifiers the selector matched.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
    /// Code-specific detail, e.g. the session state when a wait times out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ErrorBody {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            next: Vec::new(),
            candidates: Vec::new(),
            data: None,
        }
    }

    pub fn with_next(mut self, command: impl Into<String>) -> Self {
        self.next.push(command.into());
        self
    }

    pub fn with_candidates(mut self, candidates: Vec<String>) -> Self {
        self.candidates = candidates;
        self
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_snake_case_and_round_trips() {
        for code in ErrorCode::ALL {
            let json = serde_json::to_value(code).unwrap();
            assert_eq!(json, Value::String(code.as_str().to_string()));
            assert_eq!(serde_json::from_value::<ErrorCode>(json).unwrap(), code);
        }
    }

    #[test]
    fn exit_codes_follow_the_documented_table() {
        let expected = [
            (ErrorCode::Internal, 1),
            (ErrorCode::Usage, 2),
            (ErrorCode::InvalidRequest, 2),
            (ErrorCode::InvalidSelector, 2),
            (ErrorCode::NotFound, 3),
            (ErrorCode::Ambiguous, 3),
            (ErrorCode::SessionBusy, 4),
            (ErrorCode::GitConflict, 4),
            (ErrorCode::SelfResponseForbidden, 4),
            (ErrorCode::ApprovalClosed, 4),
            (ErrorCode::RequestInProgress, 4),
            (ErrorCode::RuntimeNotRunning, 5),
            (ErrorCode::RuntimeStale, 5),
            (ErrorCode::Unreachable, 5),
            (ErrorCode::Timeout, 6),
            (ErrorCode::Unauthorized, 7),
            (ErrorCode::ContractMismatch, 7),
        ];
        assert_eq!(expected.len(), ErrorCode::ALL.len());
        for (code, exit) in expected {
            assert_eq!(code.exit_code(), exit, "{code}");
        }
    }

    #[test]
    fn no_failure_exits_zero_or_answers_2xx() {
        for code in ErrorCode::ALL {
            assert_ne!(code.exit_code(), 0, "{code}");
            assert!(code.http_status() >= 400, "{code}");
        }
    }

    #[test]
    fn empty_detail_is_omitted_from_the_wire() {
        let body = ErrorBody::new(ErrorCode::NotFound, "no session abc");
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            serde_json::json!({ "code": "not_found", "message": "no session abc" })
        );
    }
}
