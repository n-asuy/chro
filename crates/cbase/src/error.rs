//! Error types for cbase parsing and indexing.

/// Errors produced while parsing or indexing a `.cbase`.
#[derive(Debug, thiserror::Error)]
pub enum CbaseError {
    /// The `.cbase` content (YAML or query language) is invalid. The message is
    /// surfaced to the user as an "invalid file" explanation.
    #[error("{0}")]
    Parse(String),
    /// A filesystem error occurred while indexing workspace files.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl CbaseError {
    pub fn parse(message: impl Into<String>) -> Self {
        CbaseError::Parse(message.into())
    }
}
