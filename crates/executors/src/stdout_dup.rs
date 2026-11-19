//! Cross-platform stdout duplication utility for child processes
//!
//! Provides a single function to duplicate a child process's stdout stream.
//! Supports Unix and Windows platforms.

#[cfg(unix)]
use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};
#[cfg(windows)]
use std::os::windows::io::{FromRawHandle, IntoRawHandle, OwnedHandle};

use std::sync::Arc;

use command_group::AsyncGroupChild;
use tokio::{
    io::{AsyncWrite, AsyncWriteExt, BufWriter},
    sync::Mutex,
};

use crate::executors::ExecutorError;

/// Async writer that mirrors raw protocol lines into a synthetic stdout pipe
/// consumed by the log normalizer.
#[derive(Clone)]
pub struct LogWriter {
    writer: Arc<Mutex<BufWriter<Box<dyn AsyncWrite + Send + Unpin>>>>,
}

impl LogWriter {
    pub fn new(writer: impl AsyncWrite + Send + Unpin + 'static) -> Self {
        Self {
            writer: Arc::new(Mutex::new(BufWriter::new(Box::new(writer)))),
        }
    }

    pub async fn log_raw(&self, raw: &str) -> Result<(), ExecutorError> {
        let mut guard = self.writer.lock().await;
        guard
            .write_all(raw.as_bytes())
            .await
            .map_err(ExecutorError::Io)?;
        guard.write_all(b"\n").await.map_err(ExecutorError::Io)?;
        guard.flush().await.map_err(ExecutorError::Io)?;
        Ok(())
    }
}

/// Create a fresh stdout pipe for the child process and return an async writer
/// that writes directly to the child's new stdout.
///
/// This helper does not read or duplicate any existing stdout; it simply
/// replaces the child's stdout with a new pipe reader and returns the
/// corresponding async writer for the caller to write into.
pub fn create_stdout_pipe_writer<'b>(
    child: &mut AsyncGroupChild,
) -> Result<impl AsyncWrite + 'b, ExecutorError> {
    let (read, write) = create_log_line_pipe()?;
    child.inner().stdout = Some(read);
    Ok(write)
}

/// Create a standalone pipe shaped like a child's stdout: the read end can be
/// presented to the container as `ChildStdout`, the write end is an async
/// writer the executor pushes structured protocol lines into.
pub fn create_log_line_pipe()
-> Result<(tokio::process::ChildStdout, tokio::fs::File), ExecutorError> {
    let (pipe_reader, pipe_writer) = os_pipe::pipe().map_err(|e| {
        ExecutorError::Io(std::io::Error::other(format!("Failed to create pipe: {e}")))
    })?;
    Ok((
        wrap_fd_as_child_stdout(pipe_reader)?,
        wrap_fd_as_tokio_writer(pipe_writer)?,
    ))
}

/// Convert os_pipe::PipeReader to tokio::process::ChildStdout
fn wrap_fd_as_child_stdout(
    pipe_reader: os_pipe::PipeReader,
) -> Result<tokio::process::ChildStdout, ExecutorError> {
    #[cfg(unix)]
    {
        let raw_fd = pipe_reader.into_raw_fd();
        let owned_fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let std_stdout = std::process::ChildStdout::from(owned_fd);
        tokio::process::ChildStdout::from_std(std_stdout).map_err(ExecutorError::Io)
    }

    #[cfg(windows)]
    {
        let raw_handle = pipe_reader.into_raw_handle();
        let owned_handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };
        let std_stdout = std::process::ChildStdout::from(owned_handle);
        tokio::process::ChildStdout::from_std(std_stdout).map_err(ExecutorError::Io)
    }
}

/// Convert os_pipe::PipeWriter to a tokio file for async writing
fn wrap_fd_as_tokio_writer(
    pipe_writer: os_pipe::PipeWriter,
) -> Result<tokio::fs::File, ExecutorError> {
    #[cfg(unix)]
    {
        let raw_fd = pipe_writer.into_raw_fd();
        let owned_fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let std_file = std::fs::File::from(owned_fd);
        Ok(tokio::fs::File::from_std(std_file))
    }

    #[cfg(windows)]
    {
        let raw_handle = pipe_writer.into_raw_handle();
        let owned_handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };
        let std_file = std::fs::File::from(owned_handle);
        Ok(tokio::fs::File::from_std(std_file))
    }
}
