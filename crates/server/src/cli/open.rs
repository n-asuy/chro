//! `chro open`: start the desktop app this CLI ships with, then wait until
//! its server accepts commands.

use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use server_contract::{ErrorBody, ErrorCode};

use super::discovery::{self, Target};

const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// What launching the app means for the binary at `exe`: the `.app` bundle on
/// macOS, otherwise the `chro-desktop` executable beside it.
fn launcher(exe: &Path) -> Option<Command> {
    let dir = exe.parent()?;
    if cfg!(target_os = "macos") {
        // .../Chro.app/Contents/MacOS/chro
        let bundle = dir.parent()?.parent()?;
        if bundle.extension().is_some_and(|ext| ext == "app") {
            let mut command = Command::new("open");
            command.arg(bundle);
            return Some(command);
        }
    }
    let name = if cfg!(windows) { "chro-desktop.exe" } else { "chro-desktop" };
    let sibling = dir.join(name);
    sibling.is_file().then(|| Command::new(sibling))
}

pub(crate) fn open() -> Result<Target, ErrorBody> {
    if let Ok(target) = discovery::locate() {
        return Ok(target);
    }
    let exe: PathBuf = std::env::current_exe()
        .and_then(dunce::canonicalize)
        .map_err(|err| ErrorBody::new(ErrorCode::Internal, format!("locating chro: {err}")))?;
    let mut command = launcher(&exe).ok_or_else(|| {
        ErrorBody::new(
            ErrorCode::RuntimeNotRunning,
            format!(
                "{} is not the chro that ships inside the desktop app, so it cannot start it; start the app or `chro-server`",
                exe.display()
            ),
        )
    })?;
    command
        .spawn()
        .map_err(|err| ErrorBody::new(ErrorCode::Internal, format!("starting the app: {err}")))?;

    let started = Instant::now();
    loop {
        match discovery::locate() {
            Ok(target) => return Ok(target),
            Err(_) if started.elapsed() < READY_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(300))
            }
            Err(err) => {
                return Err(ErrorBody::new(
                    ErrorCode::Timeout,
                    format!("the app did not come up within {}s: {}", READY_TIMEOUT.as_secs(), err.message),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cli_outside_the_app_has_no_launcher() {
        let dir = tempfile::tempdir().unwrap();
        assert!(launcher(&dir.path().join("chro")).is_none());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_desktop_executable_beside_the_cli_is_the_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "chro-desktop.exe" } else { "chro-desktop" };
        std::fs::write(dir.path().join(name), b"").unwrap();
        assert!(launcher(&dir.path().join("chro")).is_some());
    }
}
