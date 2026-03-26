//! Cross-platform stdout duplication utility for child processes
//!
//! Provides a single function to duplicate a child process's stdout stream.
//! Supports Unix and Windows platforms.

#[cfg(unix)]
use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};
#[cfg(windows)]
use std::os::windows::io::{FromRawHandle, IntoRawHandle, OwnedHandle};

use command_group::AsyncGroupChild;
use tokio::io::AsyncWrite;

use crate::executors::ExecutorError;

/// Create a fresh stdout pipe for the child process and return an async writer
/// that writes directly to the child's new stdout.
///
/// This helper does not read or duplicate any existing stdout; it simply
/// replaces the child's stdout with a new pipe reader and returns the
/// corresponding async writer for the caller to write into.
pub fn create_stdout_pipe_writer<'b>(
    child: &mut AsyncGroupChild,
) -> Result<impl AsyncWrite + 'b, ExecutorError> {
    let (pipe_reader, pipe_writer) = os_pipe::pipe().map_err(|e| {
        ExecutorError::Io(std::io::Error::other(format!("Failed to create pipe: {e}")))
    })?;
    child.inner().stdout = Some(wrap_fd_as_child_stdout(pipe_reader)?);

    wrap_fd_as_tokio_writer(pipe_writer)
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
) -> Result<impl AsyncWrite, ExecutorError> {
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
