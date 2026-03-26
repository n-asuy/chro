//! Process group management utilities.
use command_group::AsyncGroupChild;
use runtime::container::ContainerError;

#[cfg(unix)]
use nix::{
    sys::signal::{killpg, Signal},
    unistd::{getpgid, Pid},
};
#[cfg(unix)]
use tokio::time::Duration;

/// Kill the entire process group, not just the leader.
/// This ensures all child processes (e.g., Claude tools) are also terminated.
pub async fn kill_process_group(child: &mut AsyncGroupChild) -> Result<(), ContainerError> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.inner().id() {
            let pgid = getpgid(Some(Pid::from_raw(pid as i32)))
                .map_err(|e| ContainerError::Other(anyhow::anyhow!("getpgid failed: {}", e)))?;

            for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
                if let Err(e) = killpg(pgid, sig) {
                    tracing::warn!(
                        "Failed to send signal {:?} to process group {}: {}",
                        sig,
                        pgid,
                        e
                    );
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                if child
                    .inner()
                    .try_wait()
                    .map_err(|e| ContainerError::Io(e))?
                    .is_some()
                {
                    break;
                }
            }
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(())
}
