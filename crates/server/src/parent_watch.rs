//! Parent-process watchdog.
//!
//! When `chro-server` runs as a sidecar of the desktop shell (or the dev CLI),
//! the launching process hands it the owner PID through the `CHRO_PARENT_PID`
//! environment variable. On POSIX a child is *not* killed when its parent dies
//! — it is reparented to `init`/`launchd` and keeps running, holding its TCP
//! port. The next launch then walks forward to the next free port and a second
//! server appears, so orphaned servers pile up across crashes, force-quits and
//! auto-update relaunches.
//!
//! The fix mirrors what PostgreSQL (the postmaster death pipe), Chromium (its
//! process watcher) and the Language Server Protocol (`initialize.processId`)
//! all do: the child watches its owner and exits on its own when that owner
//! disappears. We poll the PID rather than depend on a clean shutdown signal,
//! precisely because the failure mode is the parent never getting the chance to
//! call `kill()`.
//!
//! The PID travels by environment variable rather than a CLI flag on purpose: a
//! sidecar binary that predates this feature simply ignores an unknown env var
//! and still boots, so a desktop/server version skew degrades to "no watchdog"
//! instead of a hard `unexpected argument` exit that would brick startup.

use std::time::Duration;

/// Environment variable the launcher uses to hand this process its owner's PID.
pub(crate) const OWNER_PID_ENV: &str = "CHRO_PARENT_PID";

/// Read the owner PID handed to us by the launcher, if any.
pub(crate) fn owner_pid_from_env() -> Option<u32> {
    parse_owner_pid(std::env::var(OWNER_PID_ENV).ok())
}

/// Parse the raw `CHRO_PARENT_PID` value. PID `0` is rejected because on POSIX
/// `kill(0, _)` addresses the caller's own process group, not a parent.
fn parse_owner_pid(raw: Option<String>) -> Option<u32> {
    let pid = raw?.trim().parse::<u32>().ok()?;
    (pid != 0).then_some(pid)
}

/// How often the owner PID is probed. Half a second keeps the orphan window
/// (and the port it holds) short without burning a core on syscalls.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Resolve once the watched owner process is gone.
///
/// With `parent_pid == None` (standalone server, or the CLI `task` subcommands)
/// there is no owner to follow, so this future stays pending forever and the
/// server only stops on an explicit signal.
pub(crate) async fn parent_lost(parent_pid: Option<u32>) {
    let Some(pid) = parent_pid else {
        std::future::pending::<()>().await;
        return;
    };

    while process_is_alive(pid) {
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Report whether a process with `pid` currently exists.
#[cfg(unix)]
pub(crate) fn process_is_alive(pid: u32) -> bool {
    // `kill(pid, 0)` runs the kernel's existence/permission checks without
    // delivering a signal:
    //   - `0`     => the process exists and we may signal it.
    //   - `EPERM` => it exists but is owned by another user (still alive).
    //   - `ESRCH` => no such process.
    // A *reaped* child is the `ESRCH` case. A zombie that has not been waited on
    // yet still reports as alive, which is correct: its PID slot is not free
    // until its parent reaps it.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Report whether a process with `pid` currently exists.
#[cfg(windows)]
pub(crate) fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    // SAFETY: every FFI return value is checked and the handle is always closed
    // before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            // The process is gone (or its PID has already been recycled away).
            return false;
        }
        // A zero-millisecond wait is a non-blocking liveness probe:
        //   - `WAIT_TIMEOUT`  => the process object is not signalled, still running.
        //   - `WAIT_OBJECT_0` => the process object is signalled, i.e. it exited.
        let state = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        state == WAIT_TIMEOUT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive() {
        assert!(process_is_alive(std::process::id()));
    }

    #[test]
    fn parses_owner_pid_leniently() {
        assert_eq!(parse_owner_pid(Some("12345".into())), Some(12345));
        assert_eq!(parse_owner_pid(Some("  678\n".into())), Some(678));
        assert_eq!(parse_owner_pid(None), None);
        assert_eq!(parse_owner_pid(Some(String::new())), None);
        assert_eq!(parse_owner_pid(Some("not-a-pid".into())), None);
        // PID 0 is rejected: kill(0, _) targets our own process group, not a parent.
        assert_eq!(parse_owner_pid(Some("0".into())), None);
    }

    #[cfg(unix)]
    #[test]
    fn reaped_process_is_not_alive() {
        use std::process::Command;

        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        assert!(
            process_is_alive(pid),
            "child should be alive right after spawn"
        );

        child.kill().expect("kill child");
        child.wait().expect("reap child"); // reap so the PID leaves the table
        assert!(!process_is_alive(pid), "a reaped child must read as dead");
    }

    #[tokio::test]
    async fn parent_lost_stays_pending_without_pid() {
        let outcome = tokio::time::timeout(Duration::from_millis(200), parent_lost(None)).await;
        assert!(
            outcome.is_err(),
            "with no owner PID the watchdog must never fire"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parent_lost_fires_once_owner_dies() {
        use std::process::Command;

        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        child.kill().expect("kill child");
        child.wait().expect("reap child");

        let outcome = tokio::time::timeout(Duration::from_secs(2), parent_lost(Some(pid))).await;
        assert!(
            outcome.is_ok(),
            "watchdog must resolve once the owner is gone"
        );
    }
}
