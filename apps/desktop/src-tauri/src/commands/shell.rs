use std::path::PathBuf;
use std::process::Stdio;

use tauri::{AppHandle, Runtime as TauriRuntime};
use tauri_plugin_opener::OpenerExt;
use tokio::process::Command;

use crate::error::{DesktopError, DesktopResult};

/// Open `url` in the host operating system's default handler. We delegate to
/// `tauri-plugin-opener` so the URL is validated and the open is scoped via
/// capabilities rather than letting arbitrary processes through.
#[tauri::command]
pub fn open_external_url<R: TauriRuntime>(
    app: AppHandle<R>,
    url: String,
) -> DesktopResult<()> {
    if url.trim().is_empty() {
        return Err(DesktopError::InvalidRequest("url is empty".into()));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| DesktopError::Other(err.to_string()))
}

/// Open a local filesystem path in the host operating system's default handler
/// or in a specific application when `with` is provided.
#[tauri::command]
pub fn open_path<R: TauriRuntime>(
    app: AppHandle<R>,
    path: String,
    with: Option<String>,
) -> DesktopResult<()> {
    let path = path.trim();
    if path.is_empty() {
        return Err(DesktopError::InvalidRequest("path is empty".into()));
    }

    let with = with
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    app.opener()
        .open_path(path.to_string(), with)
        .map_err(|err| DesktopError::Other(err.to_string()))
}

/// Open `path` as a cmux workspace through the `cmux open` CLI contract.
///
/// Unlike [`open_path`] (which hands the folder to an app via LaunchServices /
/// `open -a` and depends on the target registering a `public.folder` document
/// type), this routes through cmux's own CLI, so it behaves identically
/// regardless of how cmux was launched and uses cmux's native workspace
/// handling.
#[tauri::command]
pub async fn open_in_cmux(path: String) -> DesktopResult<()> {
    let path = path.trim();
    if path.is_empty() {
        return Err(DesktopError::InvalidRequest("path is empty".into()));
    }

    let Some(binary) = resolve_cmux_binary().await else {
        return Err(DesktopError::Other(
            "cmux CLI not found. Install cmux (brew install --cask cmux) and \
             launch it once so it installs the `cmux` command."
                .into(),
        ));
    };

    let status = Command::new(binary)
        .arg("open")
        .arg(path)
        .stdin(Stdio::null())
        .status()
        .await
        .map_err(|err| DesktopError::Other(err.to_string()))?;

    if !status.success() {
        return Err(DesktopError::Other(format!(
            "cmux open exited with status {}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".into()),
        )));
    }

    Ok(())
}

/// Resolve the `cmux` CLI binary that `cmux.app` installs (the installer's
/// default destination is `/usr/local/bin/cmux`). A desktop app launched from
/// Finder does not inherit the user's shell `PATH`, so we probe the known
/// install locations directly and fall back to a login-shell lookup for
/// non-standard installs. `CMUX_BIN` overrides discovery entirely.
async fn resolve_cmux_binary() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("CMUX_BIN") {
        let path = PathBuf::from(value.trim());
        if path.is_file() {
            return Some(path);
        }
    }

    for candidate in ["/usr/local/bin/cmux", "/opt/homebrew/bin/cmux"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }

    resolve_via_login_shell("cmux").await
}

/// Ask the user's login shell to resolve `command`, so installs that only live
/// on a profile-managed `PATH` (Apple Silicon Homebrew, asdf, mise, …) still
/// resolve when the GUI process was started without that `PATH`.
async fn resolve_via_login_shell(command: &str) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-lc", &format!("command -v {command}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if resolved.is_empty() {
        return None;
    }

    let path = PathBuf::from(resolved);
    path.is_file().then_some(path)
}
