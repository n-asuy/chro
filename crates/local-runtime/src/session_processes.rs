//! Stops the background processes a session's agents leave behind.
//!
//! Agents start dev servers, browsers and watchers from their tool commands,
//! and those commands run in a process group and session of their own: ending
//! the agent's process group does not reach them, and when the agent exits
//! they are handed to the init process and keep running. What they keep is
//! their environment. Every agent gets the session's name as `CHRO_SESSION`
//! and inherits `CHRO_RUNTIME_FILE` from this server, so a process carrying
//! both was started on behalf of one of this server's sessions, however far
//! it has wandered from the agent. Its descendants are the session's too:
//! some programs (Apple's own binaries, hardened apps such as Chrome) do not
//! let other processes read their environment on macOS, and they are reached
//! through the marked process that started them.
//!
//! A periodic sweep finds those processes outside this server's own process
//! tree (anything still under the server belongs to a live agent or a
//! terminal the server manages) and stops the ones whose session no longer
//! wants them: the session is gone, closed, or has had no run for
//! [`IDLE_GRACE`]. The grace keeps a dev server up for the person checking
//! what the agent just built.

use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    time::Duration,
};

use db::{
    models::task::{SessionActivity, TaskRecord},
    DBService,
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};
use tracing::{debug, info, warn};

/// Names the session an agent works for. Set by the container on every run.
pub(crate) const SESSION_ENV: &str = "CHRO_SESSION";
/// Names the runtime file of the server that started the agent. The server
/// sets it on itself at startup, so every child inherits it.
const RUNTIME_FILE_ENV: &str = "CHRO_RUNTIME_FILE";

const SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// How long a session's background processes outlive its latest run.
const IDLE_GRACE: Duration = Duration::from_secs(30 * 60);
/// Time between asking a process to stop and forcing it.
const TERMINATE_GRACE: Duration = Duration::from_secs(5);

/// One running process as the sweep sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessEntry {
    pub pid: Pid,
    pub parent: Option<Pid>,
    pub start_time: u64,
    pub name: String,
    /// The session its own environment names, when this server started it.
    pub session: Option<String>,
}

/// A process started on behalf of a session, outside this server's tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionProcess {
    pub pid: Pid,
    /// Guards against the pid being reused between finding and stopping.
    pub start_time: u64,
    pub session: String,
    pub name: String,
}

/// The session a process works for, when its environment says this server
/// started it.
pub(crate) fn session_of(environ: &[OsString], runtime_file: &OsStr) -> Option<String> {
    let mut session = None;
    let mut ours = false;
    for entry in environ {
        let entry = entry.to_string_lossy();
        let Some((key, value)) = entry.split_once('=') else {
            continue;
        };
        if key == SESSION_ENV && !value.is_empty() {
            session = Some(value.to_string());
        } else if key == RUNTIME_FILE_ENV {
            ours = OsStr::new(value) == runtime_file;
        }
    }
    session.filter(|_| ours)
}

/// Each process outside `server`'s tree that works for a session: the one
/// its own environment names, else the one of its nearest ancestor that
/// names one.
pub(crate) fn claim(entries: &[ProcessEntry], server: Pid) -> Vec<SessionProcess> {
    let by_pid: HashMap<Pid, &ProcessEntry> = entries.iter().map(|entry| (entry.pid, entry)).collect();
    entries
        .iter()
        .filter_map(|entry| {
            let mut session = None;
            let mut seen = HashSet::new();
            let mut current = Some(entry);
            while let Some(process) = current {
                if process.pid == server {
                    return None;
                }
                if !seen.insert(process.pid) {
                    break;
                }
                if session.is_none() {
                    session = process.session.clone();
                }
                current = process.parent.and_then(|parent| by_pid.get(&parent).copied());
            }
            Some(SessionProcess {
                pid: entry.pid,
                start_time: entry.start_time,
                session: session?,
                name: entry.name.clone(),
            })
        })
        .collect()
}

/// Whether a session's background processes should be stopped. `None` is a
/// session that no longer exists.
pub(crate) fn should_stop(activity: Option<SessionActivity>, grace: Duration) -> bool {
    match activity {
        None => true,
        Some(activity) if activity.running => false,
        Some(activity) => activity.closed || activity.idle >= grace,
    }
}

/// Every process working for a session of the server whose runtime file is
/// `runtime_file`, outside `server`'s tree.
pub(crate) fn find_session_processes(
    system: &mut System,
    runtime_file: &OsStr,
    server: Pid,
) -> Vec<SessionProcess> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_environ(UpdateKind::Always),
    );
    let entries: Vec<ProcessEntry> = system
        .processes()
        .iter()
        .map(|(pid, process)| ProcessEntry {
            pid: *pid,
            parent: process.parent(),
            start_time: process.start_time(),
            name: process.name().to_string_lossy().into_owned(),
            session: session_of(process.environ(), runtime_file),
        })
        .collect();
    claim(&entries, server)
}

/// Ask each process to terminate, then kill the ones still running after
/// `grace`. A process is only signalled while its pid still names the same
/// process.
pub(crate) fn stop_processes(system: &mut System, processes: &[SessionProcess], grace: Duration) {
    let pids: Vec<Pid> = processes.iter().map(|process| process.pid).collect();
    let signal_living = |system: &mut System, signal: Signal| {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::new(),
        );
        let mut signalled = 0usize;
        for target in processes {
            let Some(process) = system.process(target.pid) else {
                continue;
            };
            if process.start_time() != target.start_time {
                continue;
            }
            let delivered = process
                .kill_with(signal)
                .unwrap_or_else(|| process.kill());
            if delivered {
                signalled += 1;
            }
        }
        signalled
    };

    if signal_living(system, Signal::Term) == 0 {
        return;
    }
    std::thread::sleep(grace);
    let forced = signal_living(system, Signal::Kill);
    if forced > 0 {
        debug!(forced, "killed session processes that ignored SIGTERM");
    }
}

/// One sweep: find this server's session processes and stop those whose
/// session is done with them. Returns how many were stopped.
async fn sweep(db: &DBService, system: &mut System) -> anyhow::Result<usize> {
    let Some(runtime_file) = std::env::var_os(RUNTIME_FILE_ENV) else {
        return Ok(0);
    };
    let server = Pid::from_u32(std::process::id());
    let found = tokio::task::block_in_place(|| {
        find_session_processes(system, &runtime_file, server)
    });
    if found.is_empty() {
        return Ok(0);
    }

    let mut verdicts: HashMap<String, bool> = HashMap::new();
    for process in &found {
        if verdicts.contains_key(&process.session) {
            continue;
        }
        let activity = TaskRecord::find_session_activity(db.pool(), &process.session).await?;
        verdicts.insert(process.session.clone(), should_stop(activity, IDLE_GRACE));
    }

    let doomed: Vec<SessionProcess> = found
        .into_iter()
        .filter(|process| verdicts[&process.session])
        .collect();
    if doomed.is_empty() {
        return Ok(0);
    }
    for process in &doomed {
        info!(
            pid = %process.pid,
            name = %process.name,
            session = %process.session,
            "stopping a process left behind by a session"
        );
    }
    tokio::task::block_in_place(|| stop_processes(system, &doomed, TERMINATE_GRACE));
    Ok(doomed.len())
}

pub(crate) fn spawn_session_process_sweeper(db: DBService) {
    tokio::spawn(async move {
        let mut system = System::new();
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            match sweep(&db, &mut system).await {
                Ok(0) => {}
                Ok(stopped) => info!(stopped, "stopped processes left behind by sessions"),
                Err(err) => warn!(error = %err, "session process sweep failed"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environ(entries: &[&str]) -> Vec<OsString> {
        entries.iter().map(OsString::from).collect()
    }

    const OURS: &str = "/data/chro/runtime.json";

    #[test]
    fn a_process_belongs_to_a_session_only_when_this_server_started_it() {
        let runtime_file = OsStr::new(OURS);
        assert_eq!(
            session_of(
                &environ(&["PATH=/bin", "CHRO_SESSION=fix-login", "CHRO_RUNTIME_FILE=/data/chro/runtime.json"]),
                runtime_file
            ),
            Some("fix-login".to_string())
        );
        assert_eq!(
            session_of(
                &environ(&["CHRO_SESSION=fix-login", "CHRO_RUNTIME_FILE=/other/runtime.json"]),
                runtime_file
            ),
            None,
            "another server's session"
        );
        assert_eq!(
            session_of(&environ(&["CHRO_SESSION=fix-login"]), runtime_file),
            None,
            "no server named"
        );
        assert_eq!(
            session_of(&environ(&["CHRO_RUNTIME_FILE=/data/chro/runtime.json"]), runtime_file),
            None,
            "a server child that no session started"
        );
        assert_eq!(
            session_of(
                &environ(&["CHRO_SESSION=", "CHRO_RUNTIME_FILE=/data/chro/runtime.json"]),
                runtime_file
            ),
            None
        );
    }

    fn entry(pid: u32, parent: Option<u32>, session: Option<&str>) -> ProcessEntry {
        ProcessEntry {
            pid: Pid::from_u32(pid),
            parent: parent.map(Pid::from_u32),
            start_time: u64::from(pid),
            name: format!("p{pid}"),
            session: session.map(str::to_string),
        }
    }

    fn claimed(entries: &[ProcessEntry], server: u32) -> Vec<(u32, String)> {
        let mut claimed: Vec<(u32, String)> = claim(entries, Pid::from_u32(server))
            .into_iter()
            .map(|process| (process.pid.as_u32(), process.session))
            .collect();
        claimed.sort();
        claimed
    }

    #[test]
    fn an_orphaned_session_process_and_its_unreadable_descendants_are_claimed() {
        // init(1) ─ dev server (10, marked) ─ helper (11, environment unreadable)
        //        ─ unrelated (20)
        let entries = [
            entry(1, None, None),
            entry(10, Some(1), Some("fix-login")),
            entry(11, Some(10), None),
            entry(20, Some(1), None),
        ];
        assert_eq!(
            claimed(&entries, 99),
            vec![(10, "fix-login".to_string()), (11, "fix-login".to_string())]
        );
    }

    #[test]
    fn a_process_keeps_its_own_session_under_another_sessions_process() {
        let entries = [
            entry(1, None, None),
            entry(10, Some(1), Some("outer")),
            entry(11, Some(10), Some("inner")),
        ];
        assert_eq!(
            claimed(&entries, 99),
            vec![(10, "outer".to_string()), (11, "inner".to_string())]
        );
    }

    #[test]
    fn nothing_under_the_server_is_claimed() {
        // server(5) ─ agent (6, marked) ─ dev server (7, marked)
        let entries = [
            entry(1, None, None),
            entry(5, Some(1), None),
            entry(6, Some(5), Some("fix-login")),
            entry(7, Some(6), Some("fix-login")),
        ];
        assert!(claimed(&entries, 5).is_empty());
    }

    #[test]
    fn a_parent_cycle_does_not_hang_the_claim() {
        let entries = [entry(10, Some(11), Some("loop")), entry(11, Some(10), None)];
        assert_eq!(claimed(&entries, 99).len(), 2);
    }

    fn activity(running: bool, closed: bool, idle_minutes: u64) -> Option<SessionActivity> {
        Some(SessionActivity {
            running,
            closed,
            idle: Duration::from_secs(idle_minutes * 60),
        })
    }

    #[test]
    fn a_running_session_keeps_its_processes_even_when_closed() {
        let grace = Duration::from_secs(30 * 60);
        assert!(!should_stop(activity(true, false, 600), grace));
        assert!(!should_stop(activity(true, true, 600), grace));
    }

    #[test]
    fn an_idle_session_keeps_its_processes_through_the_grace() {
        let grace = Duration::from_secs(30 * 60);
        assert!(!should_stop(activity(false, false, 29), grace));
        assert!(should_stop(activity(false, false, 30), grace));
    }

    #[test]
    fn a_closed_or_deleted_session_releases_its_processes_at_once() {
        let grace = Duration::from_secs(30 * 60);
        assert!(should_stop(activity(false, true, 0), grace));
        assert!(should_stop(None, grace));
    }

    /// Not a test: the process the tests below spawn. It is this test binary
    /// rather than a system program, because macOS hides the environment of
    /// Apple's own binaries from other processes.
    #[test]
    #[ignore]
    fn session_process_stand_in() {
        if std::env::var_os(STAND_IN_ENV).is_some() {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    const STAND_IN_ENV: &str = "CHRO_SESSION_PROCESS_STAND_IN";

    #[cfg(unix)]
    mod processes {
        use super::*;
        use std::process::{Child, Command, Stdio};

        struct Spawned(Child);
        impl Drop for Spawned {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        fn spawn_stand_in(session: &str, runtime_file: &str) -> Spawned {
            let child = Spawned(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "session_processes::tests::session_process_stand_in",
                        "--ignored",
                        "--test-threads=1",
                    ])
                    .env(STAND_IN_ENV, "1")
                    .env("CHRO_SESSION", session)
                    .env("CHRO_RUNTIME_FILE", runtime_file)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn stand-in"),
            );
            // Let the exec finish before the environment is read.
            std::thread::sleep(Duration::from_millis(300));
            child
        }

        fn unique_runtime_file() -> String {
            format!("/tmp/chro-session-processes-{}/runtime.json", uuid::Uuid::new_v4())
        }

        /// Stands in for a server the test process is not a child of.
        fn some_other_server() -> Pid {
            Pid::from_u32(u32::MAX - 1)
        }

        #[test]
        fn finds_processes_by_the_session_and_server_in_their_environment() {
            let runtime_file = unique_runtime_file();
            let ours = spawn_stand_in("dev-server", &runtime_file);
            let foreign = spawn_stand_in("dev-server", &unique_runtime_file());
            let mut system = System::new();

            let found =
                find_session_processes(&mut system, OsStr::new(&runtime_file), some_other_server());

            let pids: Vec<u32> = found.iter().map(|p| p.pid.as_u32()).collect();
            assert_eq!(pids, vec![ours.0.id()], "found {found:?}");
            assert_eq!(found[0].session, "dev-server");
            drop(foreign);
        }

        #[test]
        fn leaves_alone_processes_still_under_the_server() {
            let runtime_file = unique_runtime_file();
            let _child = spawn_stand_in("dev-server", &runtime_file);
            let mut system = System::new();

            let found = find_session_processes(
                &mut system,
                OsStr::new(&runtime_file),
                Pid::from_u32(std::process::id()),
            );

            assert!(found.is_empty(), "found {found:?}");
        }

        #[test]
        fn stopping_terminates_the_found_processes() {
            let runtime_file = unique_runtime_file();
            let mut child = spawn_stand_in("dev-server", &runtime_file);
            let mut system = System::new();
            let found =
                find_session_processes(&mut system, OsStr::new(&runtime_file), some_other_server());
            assert_eq!(found.len(), 1);

            stop_processes(&mut system, &found, Duration::from_millis(200));

            let status = child.0.wait().expect("wait stand-in");
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(nix::sys::signal::Signal::SIGTERM as i32));
        }

        #[test]
        fn a_reused_pid_is_not_signalled() {
            let runtime_file = unique_runtime_file();
            let mut child = spawn_stand_in("dev-server", &runtime_file);
            let mut system = System::new();
            let mut found =
                find_session_processes(&mut system, OsStr::new(&runtime_file), some_other_server());
            assert_eq!(found.len(), 1);
            found[0].start_time += 1;

            stop_processes(&mut system, &found, Duration::from_millis(200));

            assert!(child.0.try_wait().unwrap().is_none(), "the process must survive");
        }
    }
}
