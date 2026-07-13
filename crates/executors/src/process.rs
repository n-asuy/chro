//! Process-group handle shared by coding-agent executors.

use std::time::Duration;

use command_group::AsyncGroupChild;

/// Terminal status of an execution process.
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

/// A spawned executor and its process group.
pub struct ExecutionProcess(AsyncGroupChild);

impl std::fmt::Debug for ExecutionProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ExecutionProcess")
    }
}

impl ExecutionProcess {
    pub fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.0.inner().stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.0.inner().stderr.take()
    }

    pub fn id(&mut self) -> Option<u32> {
        self.0.inner().id()
    }

    pub async fn wait(&mut self) -> std::io::Result<ProcessExit> {
        Ok(ProcessExit::from_exit_status(self.0.wait().await?))
    }

    /// Best-effort termination of the process and everything it spawned.
    pub async fn terminate(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use nix::{
                sys::signal::{Signal, killpg},
                unistd::{Pid, getpgid},
            };

            if let Some(pid) = self.0.inner().id()
                && let Ok(pgid) = getpgid(Some(Pid::from_raw(pid as i32)))
            {
                for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
                    if let Err(error) = killpg(pgid, sig) {
                        tracing::warn!("failed to send {sig:?} to process group {pgid}: {error}");
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if self.0.inner().try_wait()?.is_some() {
                        break;
                    }
                }
            }
        }
        let _ = self.0.kill().await;
        let _ = self.0.wait().await;
        Ok(())
    }
}

impl From<AsyncGroupChild> for ExecutionProcess {
    fn from(child: AsyncGroupChild) -> Self {
        Self(child)
    }
}
