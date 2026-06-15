//! Unified handle over the two ways an executor process can run:
//! piped through a process group (codex) or hosted inside a PTY (claude).
//!
//! The container only needs four operations — take the log streams, wait,
//! terminate, and identify — so both variants are folded behind
//! [`ExecutionProcess`] instead of leaking `AsyncGroupChild` everywhere.

use std::{
    io::{Read, Write},
    sync::{Arc, Mutex as StdMutex},
    thread,
    time::Duration,
};

use command_group::AsyncGroupChild;
use portable_pty::{Child as PtyChild, CommandBuilder as PtyCommandBuilder, MasterPty, PtySize};
use tokio::sync::watch;

use crate::executors::ExecutorError;

/// Terminal status of an execution process, normalized across variants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

impl ProcessExit {
    pub fn from_exit_status(status: std::process::ExitStatus) -> Self {
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|sig| sig.to_string())
        };
        #[cfg(not(unix))]
        let signal: Option<String> = None;

        Self {
            code: status.code(),
            signal,
        }
    }
}

/// A spawned executor process: either a process-group child with real pipes,
/// or a PTY-hosted child whose "stdout" is a synthetic pipe the executor
/// writes structured log lines into.
pub enum ExecutionProcess {
    Group(AsyncGroupChild),
    Pty(PtyProcess),
}

impl std::fmt::Debug for ExecutionProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Group(_) => f.write_str("ExecutionProcess::Group"),
            Self::Pty(_) => f.write_str("ExecutionProcess::Pty"),
        }
    }
}

impl ExecutionProcess {
    pub fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        match self {
            Self::Group(child) => child.inner().stdout.take(),
            Self::Pty(pty) => pty.log_stdout.take(),
        }
    }

    pub fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        match self {
            Self::Group(child) => child.inner().stderr.take(),
            Self::Pty(_) => None,
        }
    }

    pub fn id(&mut self) -> Option<u32> {
        match self {
            Self::Group(child) => child.inner().id(),
            Self::Pty(pty) => pty.pid,
        }
    }

    pub async fn wait(&mut self) -> std::io::Result<ProcessExit> {
        match self {
            Self::Group(child) => Ok(ProcessExit::from_exit_status(child.wait().await?)),
            Self::Pty(pty) => pty.wait().await,
        }
    }

    /// Best-effort termination of the process and everything it spawned.
    ///
    /// Group children get the SIGINT → SIGTERM → SIGKILL ladder on their
    /// process group; PTY children are killed and lose their controlling
    /// terminal (SIGHUP to the foreground group) when the master closes.
    pub async fn terminate(&mut self) -> std::io::Result<()> {
        match self {
            Self::Group(child) => {
                #[cfg(unix)]
                {
                    use nix::{
                        sys::signal::{Signal, killpg},
                        unistd::{Pid, getpgid},
                    };

                    if let Some(pid) = child.inner().id()
                        && let Ok(pgid) = getpgid(Some(Pid::from_raw(pid as i32)))
                    {
                        for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
                            if let Err(e) = killpg(pgid, sig) {
                                tracing::warn!(
                                    "failed to send {sig:?} to process group {pgid}: {e}"
                                );
                            }
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            if child.inner().try_wait()?.is_some() {
                                break;
                            }
                        }
                    }
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                Ok(())
            }
            Self::Pty(pty) => pty.terminate().await,
        }
    }
}

impl From<AsyncGroupChild> for ExecutionProcess {
    fn from(child: AsyncGroupChild) -> Self {
        Self::Group(child)
    }
}

/// A child process hosted in a PTY.
///
/// The PTY master is held for the child's lifetime (dropping it hangs up the
/// controlling terminal). A detached thread polls the child for exit and
/// publishes the code on a watch channel so `wait()` is async and reentrant.
pub struct PtyProcess {
    pid: Option<u32>,
    child: Arc<StdMutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    master: StdMutex<Option<Box<dyn MasterPty + Send>>>,
    /// Master write end, used to send the graceful-quit sequence on
    /// termination so the hosted TUI shuts its session down cleanly.
    writer: StdMutex<Option<Box<dyn Write + Send>>>,
    exit_rx: watch::Receiver<Option<ProcessExit>>,
    /// Synthetic stdout (structured log lines), handed to the container once.
    log_stdout: Option<tokio::process::ChildStdout>,
}

/// Sent to interactively quit a hosted TUI agent. Double Ctrl-C is the
/// conventional "interrupt then quit" chord: it cleanly tears down a turn in
/// flight and exits an idle prompt alike (verified against claude 2.1.173),
/// which finalizes the session so a later `--resume` does not see a dangling
/// turn and inject a phantom "continue" prompt.
const GRACEFUL_QUIT_SEQUENCE: &[u8] = b"\x03\x03";
/// How long to wait for the TUI to exit on its own after the quit sequence
/// before falling back to SIGKILL + terminal hang-up.
const GRACEFUL_QUIT_TIMEOUT: Duration = Duration::from_secs(5);

impl PtyProcess {
    /// Spawn `cmd` inside a fresh PTY.
    ///
    /// `log_stdout` is the read end of the synthetic log pipe presented to
    /// the container as the process's stdout. `raw_output` receives the PTY
    /// master's byte stream; the caller must keep draining it so the child
    /// never blocks on a full terminal buffer.
    pub fn spawn(
        cmd: PtyCommandBuilder,
        size: (u16, u16),
        log_stdout: tokio::process::ChildStdout,
    ) -> Result<(Self, Box<dyn Read + Send>), ExecutorError> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols: size.0.max(1),
                rows: size.1.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| ExecutorError::Io(std::io::Error::other(format!("openpty: {e}"))))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| ExecutorError::Io(std::io::Error::other(format!("pty spawn: {e}"))))?;
        // Drop the slave end so master reads return EOF once the child exits.
        drop(pair.slave);

        let raw_output = pair
            .master
            .try_clone_reader()
            .map_err(|e| ExecutorError::Io(std::io::Error::other(format!("pty reader: {e}"))))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| ExecutorError::Io(std::io::Error::other(format!("pty writer: {e}"))))?;

        let pid = child.process_id();
        let child = Arc::new(StdMutex::new(Some(child)));
        let (exit_tx, exit_rx) = watch::channel(None);
        spawn_exit_watcher(Arc::clone(&child), exit_tx);

        Ok((
            Self {
                pid,
                child,
                master: StdMutex::new(Some(pair.master)),
                writer: StdMutex::new(Some(writer)),
                exit_rx,
                log_stdout: Some(log_stdout),
            },
            raw_output,
        ))
    }

    /// Watch-channel view of the child's exit, for supervisors that need to
    /// react to the process dying without owning the handle.
    pub fn exit_watch(&self) -> watch::Receiver<Option<ProcessExit>> {
        self.exit_rx.clone()
    }

    async fn wait(&mut self) -> std::io::Result<ProcessExit> {
        let mut rx = self.exit_rx.clone();
        loop {
            if let Some(exit) = rx.borrow().clone() {
                return Ok(exit);
            }
            rx.changed()
                .await
                .map_err(|_| std::io::Error::other("pty exit watcher dropped"))?;
        }
    }

    async fn terminate(&mut self) -> std::io::Result<()> {
        // Prefer a clean shutdown: send the quit chord and give the TUI a
        // moment to finalize its session before resorting to signals.
        if self.send_quit_sequence() {
            let mut rx = self.exit_rx.clone();
            let graceful = async {
                loop {
                    if rx.borrow().is_some() {
                        return;
                    }
                    if rx.changed().await.is_err() {
                        return;
                    }
                }
            };
            if tokio::time::timeout(GRACEFUL_QUIT_TIMEOUT, graceful)
                .await
                .is_ok()
                && self.exit_rx.borrow().is_some()
            {
                return Ok(());
            }
        }

        if let Ok(mut guard) = self.child.lock()
            && let Some(child) = guard.as_mut()
        {
            let _ = child.kill();
        }
        // Hang up the controlling terminal so the child's foreground group
        // (tool subprocesses) receives SIGHUP as well.
        if let Ok(mut guard) = self.master.lock() {
            guard.take();
        }
        let _ = self.wait().await;
        Ok(())
    }

    /// Write the graceful-quit chord to the PTY. Returns false if the writer
    /// is already gone (then the caller falls back to signals).
    fn send_quit_sequence(&self) -> bool {
        let Ok(mut guard) = self.writer.lock() else {
            return false;
        };
        let Some(writer) = guard.as_mut() else {
            return false;
        };
        writer.write_all(GRACEFUL_QUIT_SEQUENCE).is_ok() && writer.flush().is_ok()
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock()
            && let Some(child) = guard.as_mut()
        {
            let _ = child.kill();
        }
        if let Ok(mut guard) = self.master.lock() {
            guard.take();
        }
    }
}

fn spawn_exit_watcher(
    child: Arc<StdMutex<Option<Box<dyn PtyChild + Send + Sync>>>>,
    exit_tx: watch::Sender<Option<ProcessExit>>,
) {
    let _ = thread::Builder::new()
        .name("executor-pty-exit".to_string())
        .spawn(move || {
            loop {
                let status = {
                    let Ok(mut guard) = child.lock() else {
                        return;
                    };
                    let Some(child) = guard.as_mut() else {
                        return;
                    };
                    match child.try_wait() {
                        Ok(status) => status,
                        Err(_) => {
                            let _ = exit_tx.send(Some(ProcessExit {
                                code: None,
                                signal: None,
                            }));
                            return;
                        }
                    }
                };
                if let Some(status) = status {
                    let _ = exit_tx.send(Some(ProcessExit {
                        code: i32::try_from(status.exit_code()).ok(),
                        signal: None,
                    }));
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stdout_dup::create_log_line_pipe;

    fn pty_cmd(script: &str) -> PtyCommandBuilder {
        let mut cmd = PtyCommandBuilder::new("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    }

    #[tokio::test]
    async fn pty_process_reports_exit_code() {
        let (read, _write) = create_log_line_pipe().unwrap();
        let (pty, mut raw) = PtyProcess::spawn(pty_cmd("exit 3"), (80, 24), read).unwrap();
        // Drain the master so the child can exit.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(raw.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut process = ExecutionProcess::Pty(pty);
        let exit = process.wait().await.unwrap();
        assert_eq!(exit.code, Some(3));
    }

    #[tokio::test]
    async fn pty_process_terminate_kills_child() {
        let (read, _write) = create_log_line_pipe().unwrap();
        let (pty, mut raw) = PtyProcess::spawn(pty_cmd("sleep 30"), (80, 24), read).unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(raw.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut process = ExecutionProcess::Pty(pty);
        tokio::time::timeout(Duration::from_secs(10), process.terminate())
            .await
            .expect("terminate timed out")
            .unwrap();
    }

    #[tokio::test]
    async fn pty_process_exposes_synthetic_stdout() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let (read, mut write) = create_log_line_pipe().unwrap();
        let (pty, mut raw) = PtyProcess::spawn(pty_cmd("exit 0"), (80, 24), read).unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(raw.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut process = ExecutionProcess::Pty(pty);
        let stdout = process.take_stdout().expect("synthetic stdout");
        write.write_all(b"hello\n").await.unwrap();
        write.flush().await.unwrap();
        drop(write);
        let mut lines = BufReader::new(stdout).lines();
        assert_eq!(lines.next_line().await.unwrap().as_deref(), Some("hello"));
    }
}
