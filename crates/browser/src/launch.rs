//! Launch a dedicated automation Chrome.
//!
//! Mirrors the `agent-browser` skill's `start_chrome_cdp_profile.sh`: a fresh
//! `--user-data-dir` on its own debugging port. A dedicated profile sidesteps
//! the Chrome 136+ default-profile CDP lockdown and the 144+ per-attach "Allow
//! remote debugging" dialog entirely — the trade-off is that it does not carry
//! the user's logged-in sessions (that is the "attach to existing Chrome" path,
//! deferred for the MVP).
//!
//! `--remote-allow-origins=*` is mandatory: since Chrome 111 the CDP WebSocket
//! upgrade is rejected (403) unless the request Origin is allow-listed, and a
//! non-browser client sends none.

use std::{net::TcpListener, path::PathBuf, process::Stdio};

use tokio::process::{Child, Command};

use crate::error::{BrowserError, Result};

/// How to launch the automation browser.
#[derive(Debug, Clone)]
pub struct LaunchConfig {
    /// Profile directory. Created if absent; reused across launches so logins
    /// the user establishes in the automation browser persist.
    pub user_data_dir: PathBuf,
    /// Run without a visible window. The screencast still streams frames.
    pub headless: bool,
    /// Optional first navigation, opened as a positional argument.
    pub start_url: Option<String>,
}

/// A launched Chrome process plus the coordinates needed to connect.
pub struct ChromeProcess {
    child: Child,
    pub port: u16,
    pub user_data_dir: PathBuf,
}

impl ChromeProcess {
    /// Best-effort kill. Called on drop and on explicit shutdown.
    pub fn kill(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl Drop for ChromeProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Spawn Chrome with remote debugging enabled and return its handle.
pub async fn launch(config: LaunchConfig) -> Result<ChromeProcess> {
    let executable = find_chrome()?;
    std::fs::create_dir_all(&config.user_data_dir)
        .map_err(|e| BrowserError::Launch(format!("create user-data-dir failed: {e}")))?;
    let port = free_port()?;

    let mut cmd = Command::new(&executable);
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg(format!(
            "--user-data-dir={}",
            config.user_data_dir.display()
        ))
        // Allow the CDP WebSocket upgrade from a non-browser client (Chrome 111+).
        .arg("--remote-allow-origins=*")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-popup-blocking")
        // Keep the relaunch deterministic: never restore the previous session's
        // tabs, never nag about an unclean shutdown.
        .arg("--no-startup-window=false")
        .arg("--disable-session-crashed-bubble")
        .arg("--hide-crash-restore-bubble");

    if config.headless {
        cmd.arg("--headless=new");
    }
    if let Some(url) = &config.start_url {
        cmd.arg(url);
    }

    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    // Chrome's own children outlive the parent on POSIX anyway; detach stdio so
    // a full pipe never blocks the browser.

    let child = cmd
        .spawn()
        .map_err(|e| BrowserError::Launch(format!("spawn {} failed: {e}", executable.display())))?;

    Ok(ChromeProcess {
        child,
        port,
        user_data_dir: config.user_data_dir,
    })
}

/// Reserve an ephemeral port by binding to `:0`, then release it for Chrome.
/// A brief TOCTOU window exists between release and Chrome's bind; acceptable
/// for a developer-local automation browser.
fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| BrowserError::Launch(format!("could not reserve a port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| BrowserError::Launch(format!("could not read reserved port: {e}")))?
        .port();
    Ok(port)
}

/// Locate a Chrome/Chromium binary. `CHRO_CHROME_PATH` wins; otherwise probe
/// the per-platform install locations.
fn find_chrome() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("CHRO_CHROME_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(BrowserError::ChromeNotFound(format!(
            "CHRO_CHROME_PATH={} does not exist",
            path.display()
        )));
    }

    for candidate in chrome_candidates() {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    if let Some(found) = which_chrome() {
        return Ok(found);
    }
    Err(BrowserError::ChromeNotFound(
        "checked the standard install paths and $PATH".to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn chrome_candidates() -> Vec<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(target_os = "windows")]
fn chrome_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for env in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(env) {
            paths.push(PathBuf::from(&base).join("Google/Chrome/Application/chrome.exe"));
            paths.push(PathBuf::from(&base).join("Microsoft/Edge/Application/msedge.exe"));
        }
    }
    paths
}

#[cfg(all(unix, not(target_os = "macos")))]
fn chrome_candidates() -> Vec<PathBuf> {
    [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/snap/bin/chromium",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

/// Fall back to `$PATH` resolution for less common install layouts.
fn which_chrome() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["chrome.exe", "msedge.exe"]
    } else {
        &[
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ]
    };
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}
