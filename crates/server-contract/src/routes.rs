//! Every operator API endpoint as a typed constant.
//!
//! The server mounts handlers at `Route::template` and the CLI calls through
//! the same constant, so an endpoint cannot be removed on one side while the
//! other still uses it: the constant's request and result types travel with
//! it.

use std::marker::PhantomData;

use crate::api::*;

/// Header carrying the caller's `CONTRACT_REV`. Required on every call.
pub const HEADER_CONTRACT_REV: &str = "chro-contract-rev";
/// Header carrying the request id that makes a mutating call safe to retry.
pub const HEADER_REQUEST_ID: &str = "idempotency-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

/// Body of calls that send none.
pub type NoBody = ();

pub struct Route<Req, Res> {
    pub method: Method,
    /// Path with `:name` segments, in the router's syntax.
    pub template: &'static str,
    _types: PhantomData<fn(Req) -> Res>,
}

impl<Req, Res> Route<Req, Res> {
    const fn new(method: Method, template: &'static str) -> Self {
        Self {
            method,
            template,
            _types: PhantomData,
        }
    }

    /// Whether repeating the call could change state twice.
    pub fn is_mutating(&self) -> bool {
        self.method != Method::Get
    }

    /// Fill the `:name` segments in order with percent-encoded `params`.
    ///
    /// Panics when the number of params does not match the template; that is
    /// a programming error, not an input error.
    pub fn path(&self, params: &[&str]) -> String {
        let mut params = params.iter();
        let path = self
            .template
            .split('/')
            .map(|segment| {
                if segment.starts_with(':') {
                    let value = params
                        .next()
                        .unwrap_or_else(|| panic!("missing param for {}", self.template));
                    encode_segment(value)
                } else {
                    segment.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("/");
        assert!(
            params.next().is_none(),
            "extra params for {}",
            self.template
        );
        path
    }
}

/// Every route, for tables that must cover all of them (schema, tests).
pub fn all() -> Vec<(Method, &'static str)> {
    vec![
        (STATUS.method, STATUS.template),
        (PROJECTS.method, PROJECTS.template),
        (PROJECT.method, PROJECT.template),
        (PROJECT_ENSURE.method, PROJECT_ENSURE.template),
        (SESSIONS.method, SESSIONS.template),
        (SESSION_CREATE.method, SESSION_CREATE.template),
        (SESSION.method, SESSION.template),
        (SESSION_UPDATE.method, SESSION_UPDATE.template),
        (SESSION_DELEGATE.method, SESSION_DELEGATE.template),
        (SESSION_FORK.method, SESSION_FORK.template),
        (SESSION_SEND.method, SESSION_SEND.template),
        (SESSION_WAIT.method, SESSION_WAIT.template),
        (SESSION_ENTRIES.method, SESSION_ENTRIES.template),
        (SESSION_TRANSCRIPT.method, SESSION_TRANSCRIPT.template),
        (SESSION_CANCEL.method, SESSION_CANCEL.template),
        (SESSION_UNQUEUE.method, SESSION_UNQUEUE.template),
        (SESSION_REFS.method, SESSION_REFS.template),
        (SESSION_DIFF.method, SESSION_DIFF.template),
        (SESSION_MERGE.method, SESSION_MERGE.template),
        (SESSION_REBASE.method, SESSION_REBASE.template),
        (APPROVALS.method, APPROVALS.template),
        (APPROVAL.method, APPROVAL.template),
        (APPROVAL_RESPOND.method, APPROVAL_RESPOND.template),
    ]
}

fn encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub const STATUS: Route<NoBody, StatusView> = Route::new(Method::Get, "/v1/status");

pub const PROJECTS: Route<NoBody, ProjectList> = Route::new(Method::Get, "/v1/projects");
pub const PROJECT: Route<NoBody, ProjectView> = Route::new(Method::Get, "/v1/projects/:project");
pub const PROJECT_ENSURE: Route<EnsureProject, ProjectView> =
    Route::new(Method::Post, "/v1/projects");

pub const SESSIONS: Route<NoBody, SessionList> = Route::new(Method::Get, "/v1/sessions");
pub const SESSION_CREATE: Route<NewSession, SessionStarted> =
    Route::new(Method::Post, "/v1/sessions");
pub const SESSION: Route<NoBody, SessionView> = Route::new(Method::Get, "/v1/sessions/:session");
pub const SESSION_UPDATE: Route<UpdateSession, SessionView> =
    Route::new(Method::Patch, "/v1/sessions/:session");
pub const SESSION_DELEGATE: Route<Delegate, SessionStarted> =
    Route::new(Method::Post, "/v1/sessions/:session/delegations");
pub const SESSION_FORK: Route<Fork, Forked> =
    Route::new(Method::Post, "/v1/sessions/:session/forks");
pub const SESSION_SEND: Route<SendMessage, MessageAccepted> =
    Route::new(Method::Post, "/v1/sessions/:session/messages");
pub const SESSION_WAIT: Route<NoBody, WaitOutcome> =
    Route::new(Method::Get, "/v1/sessions/:session/wait");
pub const SESSION_ENTRIES: Route<NoBody, Entries> =
    Route::new(Method::Get, "/v1/sessions/:session/entries");
pub const SESSION_TRANSCRIPT: Route<NoBody, Transcript> =
    Route::new(Method::Get, "/v1/sessions/:session/transcript");
pub const SESSION_CANCEL: Route<NoBody, SessionView> =
    Route::new(Method::Post, "/v1/sessions/:session/cancel");
pub const SESSION_UNQUEUE: Route<NoBody, SessionView> =
    Route::new(Method::Delete, "/v1/sessions/:session/queue/:message");
pub const SESSION_REFS: Route<NoBody, Refs> = Route::new(Method::Get, "/v1/sessions/:session/refs");
pub const SESSION_DIFF: Route<NoBody, DiffView> =
    Route::new(Method::Get, "/v1/sessions/:session/diff");
pub const SESSION_MERGE: Route<Merge, Merged> =
    Route::new(Method::Post, "/v1/sessions/:session/merge");
pub const SESSION_REBASE: Route<Rebase, Rebased> =
    Route::new(Method::Post, "/v1/sessions/:session/rebase");

pub const APPROVALS: Route<NoBody, ApprovalList> = Route::new(Method::Get, "/v1/approvals");
pub const APPROVAL: Route<NoBody, ApprovalView> =
    Route::new(Method::Get, "/v1/approvals/:approval");
pub const APPROVAL_RESPOND: Route<Respond, Responded> =
    Route::new(Method::Post, "/v1/approvals/:approval/respond");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_fills_params_in_order_and_encodes_them() {
        assert_eq!(
            SESSION_SEND.path(&["ab12cd34"]),
            "/v1/sessions/ab12cd34/messages"
        );
        assert_eq!(APPROVAL.path(&["a b/c"]), "/v1/approvals/a%20b%2Fc");
    }

    #[test]
    #[should_panic(expected = "missing param")]
    fn path_rejects_missing_params() {
        SESSION.path(&[]);
    }

    #[test]
    fn only_get_routes_are_free_to_repeat() {
        assert!(!SESSION.is_mutating());
        assert!(SESSION_SEND.is_mutating());
        assert!(SESSION_UPDATE.is_mutating());
        assert!(SESSION_UNQUEUE.is_mutating());
    }

    #[test]
    fn a_queued_message_is_withdrawn_by_deleting_it() {
        assert_eq!(SESSION_UNQUEUE.method.as_str(), "DELETE");
        assert_eq!(
            SESSION_UNQUEUE.path(&["ab12cd34", "5f93"]),
            "/v1/sessions/ab12cd34/queue/5f93"
        );
        assert!(all().contains(&(SESSION_UNQUEUE.method, SESSION_UNQUEUE.template)));
    }

    #[test]
    fn every_route_is_versioned_and_unique() {
        let routes = all();
        for (_, template) in &routes {
            assert!(template.starts_with("/v1/"), "{template}");
        }
        let mut keys: Vec<_> = routes
            .iter()
            .map(|(m, t)| format!("{} {t}", m.as_str()))
            .collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), routes.len());
    }
}
