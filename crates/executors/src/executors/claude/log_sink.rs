//! Shared writer for the synthetic stdout pipe of a PTY-hosted Claude run.
//!
//! The transcript tailer, the permission broker and the run supervisor all
//! emit stream-json lines into the same pipe; this sink serializes their
//! writes and lets the supervisor close the pipe (EOF for the container's
//! stdout reader) exactly once.

use std::sync::Arc;

use tokio::{io::AsyncWriteExt, sync::Mutex};

#[derive(Clone)]
pub struct LogLineSink {
    file: Arc<Mutex<Option<tokio::fs::File>>>,
}

impl LogLineSink {
    pub fn new(file: tokio::fs::File) -> Self {
        Self {
            file: Arc::new(Mutex::new(Some(file))),
        }
    }

    /// Write one line (newline appended). Returns false when the pipe is
    /// closed or broken — callers treat that as "run is over, stop writing".
    pub async fn write_line(&self, line: &str) -> bool {
        let mut guard = self.file.lock().await;
        let Some(file) = guard.as_mut() else {
            return false;
        };
        let write = async {
            file.write_all(line.as_bytes()).await?;
            file.write_all(b"\n").await?;
            file.flush().await
        };
        match write.await {
            Ok(()) => true,
            Err(err) => {
                tracing::debug!(error = %err, "claude log sink write failed; dropping pipe");
                guard.take();
                false
            }
        }
    }

    pub async fn write_json(&self, value: &serde_json::Value) -> bool {
        match serde_json::to_string(value) {
            Ok(line) => self.write_line(&line).await,
            Err(_) => false,
        }
    }

    /// Close the pipe; the container's stdout reader sees EOF.
    pub async fn close(&self) {
        self.file.lock().await.take();
    }
}
