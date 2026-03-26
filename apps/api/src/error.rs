use serde::Serialize;
use worker::{Error as WorkerError, Response};

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
pub enum ApiError {
    Unauthorized(String),
    BadRequest(String),
    Internal(String),
    WorkerError(WorkerError),
}

impl ApiError {
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::Unauthorized(msg.into())
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    pub fn into_response(self) -> worker::Result<Response> {
        let (status, message) = match self {
            Self::Unauthorized(msg) => (401, msg),
            Self::BadRequest(msg) => (400, msg),
            Self::Internal(msg) => {
                worker::console_log!("Internal error: {}", msg);
                (500, "Internal server error".to_string())
            }
            Self::WorkerError(err) => {
                worker::console_log!("Worker error: {:?}", err);
                (500, "Internal server error".to_string())
            }
        };

        #[derive(Serialize)]
        struct ErrorResponse {
            error: String,
        }

        let mut response = Response::from_json(&ErrorResponse { error: message })?;
        let headers = response.headers_mut();
        headers.set("Access-Control-Allow-Origin", "*")?;
        headers.set(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, DELETE, OPTIONS",
        )?;
        headers.set(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        )?;
        Ok(response.with_status(status))
    }
}

impl From<WorkerError> for ApiError {
    fn from(err: WorkerError) -> Self {
        Self::WorkerError(err)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized(msg) => write!(f, "Unauthorized: {}", msg),
            Self::BadRequest(msg) => write!(f, "Bad request: {}", msg),
            Self::Internal(msg) => write!(f, "Internal error: {}", msg),
            Self::WorkerError(err) => write!(f, "Worker error: {:?}", err),
        }
    }
}

impl std::error::Error for ApiError {}
