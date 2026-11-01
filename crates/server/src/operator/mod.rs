//! The operator API: the versioned `/v1` surface the `chro` CLI drives.
//!
//! It is separate from `/rpc`, which belongs to the app's own UI and may
//! change with it. Every request must carry a bearer token and the caller's
//! contract revision; the token decides who the caller is (the machine's user
//! or the agent of one chro turn), never anything the request says.

mod approvals;
mod entries;
mod idempotency;
mod projects;
mod selectors;
mod sessions;
mod status;
mod views;
mod wait;

use std::sync::OnceLock;

use axum::{
    extract::{Request, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use local_runtime::session_tokens::SessionGrant;
use server_contract::{
    routes::{self, HEADER_CONTRACT_REV},
    Envelope, ErrorBody, ErrorCode, Meta, CONTRACT_REV,
};
use uuid::Uuid;

use crate::{runtime_identity::RuntimeIdentity, ApiError, AppState};

pub(crate) use idempotency::IdempotencyLedger;

/// Who a request acts as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Caller {
    /// The machine's user: a person at a terminal or a script.
    User,
    /// The agent of one running turn.
    Agent { task_id: Uuid, run_id: Uuid },
}

impl Caller {
    /// Namespace for per-caller state such as request-id deduplication.
    fn key(&self) -> String {
        match self {
            Caller::User => "user".to_string(),
            Caller::Agent { run_id, .. } => format!("agent:{run_id}"),
        }
    }
}

/// Decide the caller from the `Authorization` header alone.
pub(crate) fn resolve_caller(
    headers: &HeaderMap,
    owner_token: &str,
    session_grant: impl Fn(&str) -> Option<SessionGrant>,
) -> Result<Caller, V1Error> {
    let presented = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| V1Error::new(ErrorCode::Unauthorized, "missing bearer token"))?;

    if constant_time_eq(presented.as_bytes(), owner_token.as_bytes()) {
        return Ok(Caller::User);
    }
    match session_grant(presented) {
        Some(grant) => Ok(Caller::Agent {
            task_id: grant.task_id,
            run_id: grant.run_id,
        }),
        None => Err(V1Error::new(
            ErrorCode::Unauthorized,
            "unknown or expired token; session tokens end with their turn",
        )),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn check_contract(headers: &HeaderMap) -> Result<(), V1Error> {
    let presented = headers
        .get(HEADER_CONTRACT_REV)
        .and_then(|value| value.to_str().ok());
    match presented {
        Some(rev) if rev == CONTRACT_REV => Ok(()),
        other => Err(V1Error::new(
            ErrorCode::ContractMismatch,
            format!(
                "this chro CLI speaks contract {} but the server speaks {CONTRACT_REV}; use the chro command that ships with the running app",
                other.unwrap_or("(none)")
            ),
        )),
    }
}

async fn admit(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let caller = match resolve_caller(request.headers(), &state.identity().owner_token, |token| {
        state.runtime().session_tokens().resolve(token)
    }) {
        Ok(caller) => caller,
        Err(err) => return err.into_response(),
    };
    if let Err(err) = check_contract(request.headers()) {
        return err.into_response();
    }
    request.extensions_mut().insert(caller);
    next.run(request).await
}

pub(crate) fn router(state: AppState) -> Router<AppState> {
    use routes::*;

    let reads = Router::new()
        .route(STATUS.template, get(status::show))
        .route(PROJECTS.template, get(projects::list))
        .route(PROJECT.template, get(projects::show))
        .route(SESSIONS.template, get(sessions::list))
        .route(SESSION.template, get(sessions::show))
        .route(SESSION_WAIT.template, get(wait::wait))
        .route(SESSION_ENTRIES.template, get(entries::list))
        .route(SESSION_TRANSCRIPT.template, get(sessions::transcript))
        .route(SESSION_REFS.template, get(sessions::refs))
        .route(SESSION_DIFF.template, get(sessions::diff))
        .route(APPROVALS.template, get(approvals::list))
        .route(APPROVAL.template, get(approvals::show));

    let writes = Router::new()
        .route(PROJECT_ENSURE.template, post(projects::ensure))
        .route(SESSION_CREATE.template, post(sessions::create))
        .route(SESSION_UPDATE.template, patch(sessions::update))
        .route(SESSION_DELEGATE.template, post(sessions::delegate))
        .route(SESSION_FORK.template, post(sessions::fork))
        .route(SESSION_SEND.template, post(sessions::send))
        .route(SESSION_CANCEL.template, post(sessions::cancel))
        .route(SESSION_UNQUEUE.template, delete(sessions::unqueue))
        .route(SESSION_MERGE.template, post(sessions::merge))
        .route(SESSION_REBASE.template, post(sessions::rebase))
        .route(APPROVAL_RESPOND.template, post(approvals::respond))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            idempotency::deduplicate,
        ));

    // `GET /v1/sessions` and `POST /v1/sessions` share a path, so the two
    // routers are merged rather than nested.
    reads
        .merge(writes)
        .layer(middleware::from_fn_with_state(state, admit))
}

static RUNTIME_ID: OnceLock<String> = OnceLock::new();

/// Record which server answers, for the `meta` member of every response.
pub(crate) fn set_identity(identity: &RuntimeIdentity) {
    let _ = RUNTIME_ID.set(identity.runtime_id.clone());
}

pub(crate) fn meta() -> Meta {
    Meta {
        runtime_id: RUNTIME_ID.get().cloned(),
        contract_rev: CONTRACT_REV.to_string(),
    }
}

/// A successful operator API result.
pub(crate) struct V1<T>(pub T);

impl<T: serde::Serialize> IntoResponse for V1<T> {
    fn into_response(self) -> Response {
        Json(Envelope::success(self.0, meta())).into_response()
    }
}

pub(crate) type V1Result<T> = Result<V1<T>, V1Error>;

/// A failed operator API call, answered as an `ok: false` envelope.
#[derive(Debug)]
pub(crate) struct V1Error(pub ErrorBody);

impl V1Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self(ErrorBody::new(code, message))
    }

    pub fn with_next(self, command: impl Into<String>) -> Self {
        Self(self.0.with_next(command))
    }

    pub fn not_found(what: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::NotFound, format!("no {what}"))
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }
}

impl IntoResponse for V1Error {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.code.http_status())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        if self.0.code == ErrorCode::Internal {
            tracing::error!(message = %self.0.message, "operator api internal error");
        }
        (status, Json(Envelope::<()>::failure(self.0, meta()))).into_response()
    }
}

impl From<ApiError> for V1Error {
    fn from(err: ApiError) -> Self {
        use runtime::RuntimeError;
        match err {
            ApiError::NotFound => V1Error::new(ErrorCode::NotFound, "not found"),
            ApiError::BadRequest(message) => V1Error::invalid(message),
            ApiError::Sqlx(sqlx::Error::RowNotFound) => {
                V1Error::new(ErrorCode::NotFound, "not found")
            }
            ApiError::SerdeUuid(err) => V1Error::invalid(err.to_string()),
            ApiError::Runtime(err) => match err {
                RuntimeError::SessionBusy => V1Error::new(ErrorCode::SessionBusy, err.to_string()),
                RuntimeError::BadRequest(_)
                | RuntimeError::Unsupported(_)
                | RuntimeError::Skills(_) => V1Error::invalid(err.to_string()),
                RuntimeError::NotFound(_) | RuntimeError::TaskRunNotFound(_) => {
                    V1Error::new(ErrorCode::NotFound, err.to_string())
                }
                RuntimeError::Sqlx(sqlx::Error::RowNotFound) => {
                    V1Error::new(ErrorCode::NotFound, "not found")
                }
                RuntimeError::Git(ref git_err) => {
                    use git::GitServiceError;
                    match git_err {
                        GitServiceError::NothingToMerge(_)
                        | GitServiceError::BranchesDiverged(_)
                        | GitServiceError::WorktreeDirty(_, _)
                        | GitServiceError::RebaseInProgress => {
                            V1Error::new(ErrorCode::GitConflict, err.to_string())
                        }
                        _ => V1Error::new(ErrorCode::Internal, err.to_string()),
                    }
                }
                other => V1Error::new(ErrorCode::Internal, other.to_string()),
            },
            ApiError::Approval(err) => match err {
                ::approvals::ApprovalError::NotFound => {
                    V1Error::new(ErrorCode::NotFound, err.to_string())
                }
                ::approvals::ApprovalError::AlreadyCompleted => {
                    V1Error::new(ErrorCode::ApprovalClosed, err.to_string())
                }
            },
            other => V1Error::new(ErrorCode::Internal, other.to_string()),
        }
    }
}

impl From<runtime::RuntimeError> for V1Error {
    fn from(err: runtime::RuntimeError) -> Self {
        ApiError::from(err).into()
    }
}

impl From<sqlx::Error> for V1Error {
    fn from(err: sqlx::Error) -> Self {
        ApiError::from(err).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(auth: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(value) = auth {
            headers.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    const OWNER: &str = "owner-token";

    fn no_sessions(_: &str) -> Option<SessionGrant> {
        None
    }

    #[test]
    fn the_owner_token_acts_as_the_user() {
        let caller = resolve_caller(&headers(Some("Bearer owner-token")), OWNER, no_sessions);
        assert_eq!(caller.unwrap(), Caller::User);
    }

    #[test]
    fn a_session_token_acts_as_its_turns_agent() {
        let grant = SessionGrant {
            task_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
        };
        let caller = resolve_caller(&headers(Some("Bearer turn-token")), OWNER, |token| {
            (token == "turn-token").then_some(grant)
        })
        .unwrap();
        assert_eq!(
            caller,
            Caller::Agent {
                task_id: grant.task_id,
                run_id: grant.run_id
            }
        );
    }

    #[test]
    fn requests_without_a_known_token_are_unauthorized() {
        for auth in [
            None,
            Some("Bearer "),
            Some("Basic owner-token"),
            Some("Bearer nope"),
        ] {
            let err = resolve_caller(&headers(auth), OWNER, no_sessions).unwrap_err();
            assert_eq!(err.0.code, ErrorCode::Unauthorized, "{auth:?}");
        }
    }

    #[test]
    fn a_different_contract_is_refused() {
        let mut map = HeaderMap::new();
        assert_eq!(
            check_contract(&map).unwrap_err().0.code,
            ErrorCode::ContractMismatch
        );
        map.insert(
            HEADER_CONTRACT_REV,
            HeaderValue::from_static("0.0.0+deadbeef"),
        );
        assert_eq!(
            check_contract(&map).unwrap_err().0.code,
            ErrorCode::ContractMismatch
        );
        map.insert(
            HEADER_CONTRACT_REV,
            HeaderValue::from_str(CONTRACT_REV).unwrap(),
        );
        assert!(check_contract(&map).is_ok());
    }

    #[test]
    fn errors_answer_with_their_codes_http_status() {
        let response = V1Error::new(ErrorCode::SessionBusy, "busy").into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn busy_sessions_map_to_session_busy() {
        let err: V1Error = runtime::RuntimeError::SessionBusy.into();
        assert_eq!(err.0.code, ErrorCode::SessionBusy);
    }
}
