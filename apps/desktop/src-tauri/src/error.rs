use serde::{Serialize, Serializer};
use thiserror::Error;

/// Public-facing error type returned from `#[tauri::command]` handlers.
///
/// Renderer code receives this as a string via Tauri's invoke mechanism. We
/// intentionally keep the wire format simple — a single message string — to
/// mirror the Electron-era `Error.message` shape that the React layer was
/// already coding against.
#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("workspace not set")]
    WorkspaceNotSet,

    #[error("selection canceled")]
    SelectionCanceled,

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("no runtime available")]
    NoRuntimeAvailable,

    #[error("invalid request: {0}")]
    InvalidRequest(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("backend not ready: {0}")]
    BackendNotReady(String),

    #[error("update error: {0}")]
    Update(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for DesktopError {
    fn from(err: std::io::Error) -> Self {
        DesktopError::Io(err.to_string())
    }
}

impl From<anyhow::Error> for DesktopError {
    fn from(err: anyhow::Error) -> Self {
        DesktopError::Other(format!("{err:#}"))
    }
}

impl From<tauri::Error> for DesktopError {
    fn from(err: tauri::Error) -> Self {
        DesktopError::Other(err.to_string())
    }
}

pub type DesktopResult<T> = Result<T, DesktopError>;
