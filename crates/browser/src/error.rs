//! Error type shared across the browser engine.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrowserError {
    /// Could not locate a Chrome/Chromium executable to launch.
    #[error("no Chrome/Chromium executable found (set CHRO_CHROME_PATH): {0}")]
    ChromeNotFound(String),

    /// Spawning the Chrome process failed.
    #[error("failed to launch Chrome: {0}")]
    Launch(String),

    /// The DevTools endpoint never became reachable.
    #[error("CDP discovery failed: {0}")]
    Discovery(String),

    /// The CDP WebSocket handshake or connection failed.
    #[error("CDP connection failed: {0}")]
    Connect(String),

    /// Sending a command over the (closed) CDP socket failed.
    #[error("CDP transport closed")]
    Closed,

    /// A CDP command did not return within the deadline.
    #[error("CDP command `{0}` timed out")]
    Timeout(String),

    /// Chrome returned a CDP-level error for a command.
    #[error("CDP error on `{method}`: {message}")]
    Protocol { method: String, message: String },

    /// A command response was missing an expected field.
    #[error("unexpected CDP response for `{method}`: {detail}")]
    UnexpectedResponse { method: String, detail: String },

    /// No attachable page target exists.
    #[error("no attachable page target")]
    NoPage,
}

pub type Result<T> = std::result::Result<T, BrowserError>;
