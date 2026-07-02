use approvals::ApprovalError;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chro_image::ImageError;
use executors::{ExecutorError, McpConfigError};
use file_search_cache::FileSearchError;
use filesystem::FilesystemError;
use runtime::RuntimeError;
use thiserror::Error;
use tracing::error;

#[derive(Error, Debug)]
pub(crate) enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    SerdeUuid(#[from] uuid::Error),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error(transparent)]
    Approval(#[from] ApprovalError),
    #[error(transparent)]
    Image(#[from] ImageError),
    #[error(transparent)]
    McpConfig(#[from] McpConfigError),
    #[error(transparent)]
    Filesystem(#[from] FilesystemError),
    #[error(transparent)]
    FileSearch(#[from] FileSearchError),
    #[error(transparent)]
    Executor(#[from] ExecutorError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()).into_response(),
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()).into_response(),
            ApiError::Internal(msg) => {
                error!("internal error: {msg}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
            }
            ApiError::Sqlx(err) => {
                // A missing row is "resource not found", not a server fault. Map it
                // to 404 so callers (and WebSocket handshakes for deleted/unknown
                // ids) get the correct status instead of a 500, and so the server
                // log isn't flooded with ERROR lines for routine not-found lookups.
                if matches!(err, sqlx::Error::RowNotFound) {
                    return (StatusCode::NOT_FOUND, "not found").into_response();
                }
                error!("sqlx error: {err}");
                (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response()
            }
            ApiError::SerdeUuid(err) => {
                error!("uuid parse error: {err}");
                (StatusCode::BAD_REQUEST, "invalid uuid").into_response()
            }
            ApiError::Runtime(err) => match err {
                RuntimeError::BadRequest(_) => {
                    (StatusCode::BAD_REQUEST, err.to_string()).into_response()
                }
                RuntimeError::NotFound(_) => {
                    (StatusCode::NOT_FOUND, err.to_string()).into_response()
                }
                RuntimeError::Unsupported(_) => {
                    (StatusCode::BAD_REQUEST, err.to_string()).into_response()
                }
                RuntimeError::Skills(_) => {
                    (StatusCode::BAD_REQUEST, err.to_string()).into_response()
                }
                RuntimeError::Git(git_err) => {
                    use git::GitServiceError;
                    match git_err {
                        GitServiceError::NothingToMerge(_) => {
                            (StatusCode::CONFLICT, err.to_string()).into_response()
                        }
                        GitServiceError::BranchesDiverged(_) => {
                            (StatusCode::CONFLICT, err.to_string()).into_response()
                        }
                        GitServiceError::WorktreeDirty(_, _) => {
                            (StatusCode::CONFLICT, err.to_string()).into_response()
                        }
                        GitServiceError::RebaseInProgress => {
                            (StatusCode::CONFLICT, err.to_string()).into_response()
                        }
                        _ => {
                            error!(?git_err, "git error");
                            (StatusCode::INTERNAL_SERVER_ERROR, git_err.to_string()).into_response()
                        }
                    }
                }
                _ => {
                    error!(?err, "runtime error");
                    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response()
                }
            },
            ApiError::Approval(err) => match err {
                ApprovalError::NotFound => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
                ApprovalError::AlreadyCompleted => {
                    (StatusCode::BAD_REQUEST, err.to_string()).into_response()
                }
            },
            ApiError::Image(err) => match err {
                ImageError::NotFound => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
                _ => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
            },
            ApiError::McpConfig(err) => {
                error!(?err, "mcp config error");
                (StatusCode::INTERNAL_SERVER_ERROR, "mcp_config_error").into_response()
            }
            ApiError::Filesystem(err) => match err {
                FilesystemError::Timeout(_) => {
                    (StatusCode::REQUEST_TIMEOUT, err.to_string()).into_response()
                }
                FilesystemError::Io(inner) => {
                    error!(?inner, "filesystem io error");
                    (StatusCode::BAD_REQUEST, "filesystem error").into_response()
                }
                FilesystemError::NotFile | FilesystemError::NotFound => {
                    (StatusCode::NOT_FOUND, err.to_string()).into_response()
                }
                _ => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
            },
            ApiError::FileSearch(err) => {
                error!(?err, "file search error");
                (StatusCode::INTERNAL_SERVER_ERROR, "file search error").into_response()
            }
            ApiError::Executor(err) => match &err {
                ExecutorError::ExecutableNotFound { .. } => {
                    (StatusCode::NOT_FOUND, err.to_string()).into_response()
                }
                _ => {
                    error!(?err, "executor error");
                    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response()
                }
            },
        }
    }
}
