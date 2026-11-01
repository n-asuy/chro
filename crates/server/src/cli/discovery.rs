//! Finding the chro server a command should talk to.
//!
//! In order:
//! 1. `CHRO_API_URL` (or the instance `chro cloud up` holds): a server
//!    reached over the network, authenticated with `CHRO_API_TOKEN`.
//! 2. `CHRO_RUNTIME_FILE`: set by chro for every agent it starts, so `chro`
//!    inside a session reaches the server that started it.
//! 3. The desktop app's runtime file, then the standalone server's.
//!
//! A runtime file whose process is gone is skipped, so a crashed server never
//! captures commands meant for a live one.

use std::{
    env,
    path::{Path, PathBuf},
};

use server_contract::{
    runtime_file::{self, RuntimeFile, RUNTIME_FILE_NAME},
    ErrorBody, ErrorCode,
};

pub(crate) const RUNTIME_FILE_ENV: &str = "CHRO_RUNTIME_FILE";
const USER_DATA_ENV: &str = "CHRO_USER_DATA_DIR";

/// Where commands go and with which token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    Local { path: PathBuf, file: RuntimeFile },
    Remote { url: String, token: Option<String> },
}

impl Target {
    pub fn base_url(&self) -> &str {
        match self {
            Target::Local { file, .. } => &file.url,
            Target::Remote { url, .. } => url,
        }
    }

    /// The token that acts as the machine's user on this server.
    pub fn owner_token(&self) -> Option<&str> {
        match self {
            Target::Local { file, .. } => Some(&file.owner_token),
            Target::Remote { token, .. } => token.as_deref(),
        }
    }
}

pub(crate) fn locate() -> Result<Target, ErrorBody> {
    if let Some(url) = remote_url() {
        return Ok(Target::Remote {
            url,
            token: non_empty(env::var("CHRO_API_TOKEN").ok()),
        });
    }
    locate_local(&candidates(), process_alive)
}

/// The first candidate naming a live process.
pub(crate) fn locate_local(
    candidates: &[PathBuf],
    alive: impl Fn(u32) -> bool,
) -> Result<Target, ErrorBody> {
    let mut stale = Vec::new();
    for path in candidates {
        match runtime_file::read(path) {
            Ok(file) if alive(file.pid) => {
                return Ok(Target::Local {
                    path: path.clone(),
                    file,
                })
            }
            Ok(file) => stale.push(format!("{} (pid {})", path.display(), file.pid)),
            Err(_) => {}
        }
    }
    if stale.is_empty() {
        Err(ErrorBody::new(
            ErrorCode::RuntimeNotRunning,
            "chro is not running: no runtime file found",
        )
        .with_next("chro open"))
    } else {
        Err(ErrorBody::new(
            ErrorCode::RuntimeStale,
            format!(
                "the chro server that wrote {} is no longer running",
                stale.join(", ")
            ),
        )
        .with_next("chro open"))
    }
}

/// Candidate runtime files, most specific first, without duplicates.
pub(crate) fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if !out.contains(&path) {
            out.push(path);
        }
    };
    if let Some(path) = non_empty(env::var(RUNTIME_FILE_ENV).ok()) {
        push(PathBuf::from(path));
    }
    if let Some(dir) = non_empty(env::var(USER_DATA_ENV).ok()) {
        push(Path::new(&dir).join(RUNTIME_FILE_NAME));
    }
    if let Some(dir) = desktop_data_dir() {
        push(dir.join(RUNTIME_FILE_NAME));
    }
    push(runtime_file::path_for_database(&db::DBService::default_path()));
    out
}

/// Where the desktop app keeps its database (and so its runtime file).
fn desktop_data_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "linux") {
        dirs::config_dir()
    } else {
        dirs::data_dir()
    };
    base.map(|dir| dir.join("chro"))
}

fn remote_url() -> Option<String> {
    if let Some(url) = non_empty(env::var("CHRO_API_URL").ok()) {
        return Some(url.trim_end_matches('/').to_string());
    }
    #[cfg(feature = "cloud")]
    {
        return super::cloud::endpoint_for_tasks().map(|url| url.trim_end_matches('/').to_string());
    }
    #[cfg(not(feature = "cloud"))]
    None
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(unix)]
pub(crate) fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Signal 0 checks existence and permission without delivering anything.
    // EPERM means the process exists but belongs to someone else.
    let exists = unsafe { libc::kill(pid, 0) } == 0;
    exists || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub(crate) fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn write(dir: &Path, name: &str, pid: u32) -> PathBuf {
        let path = dir.join(name);
        runtime_file::write(
            &path,
            &RuntimeFile {
                runtime_id: format!("rt-{name}"),
                pid,
                url: "http://127.0.0.1:1".into(),
                owner_token: "t".into(),
                version: "0".into(),
                contract_rev: server_contract::CONTRACT_REV.into(),
                started_at: Utc::now(),
            },
        )
        .unwrap();
        path
    }

    #[test]
    fn the_first_live_candidate_wins() {
        let dir = tempfile::tempdir().unwrap();
        let dead = write(dir.path(), "dead.json", 1);
        let live = write(dir.path(), "live.json", 2);
        let target = locate_local(&[dead, live.clone()], |pid| pid == 2).unwrap();
        assert_eq!(
            target,
            Target::Local {
                path: live.clone(),
                file: runtime_file::read(&live).unwrap()
            }
        );
    }

    #[test]
    fn only_dead_servers_is_stale_not_missing() {
        let dir = tempfile::tempdir().unwrap();
        let dead = write(dir.path(), "dead.json", 1);
        let err = locate_local(&[dead], |_| false).unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeStale);
        assert_eq!(err.next, vec!["chro open"]);
    }

    #[test]
    fn no_runtime_file_means_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let err = locate_local(&[dir.path().join("none.json")], |_| true).unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeNotRunning);
    }

    #[test]
    fn this_process_is_alive() {
        assert!(process_alive(std::process::id()));
    }
}
