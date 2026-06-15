use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Deserialize;
use serde::de::DeserializeOwned;
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

/// Open `path` as a cmux workspace through cmux's own CLI.
///
/// Unlike [`open_path`] (which hands the folder to an app via LaunchServices /
/// `open -a` and depends on the target registering a `public.folder` document
/// type), this routes through cmux's own CLI, so it behaves identically
/// regardless of how cmux was launched and uses cmux's native workspace
/// handling.
///
/// `cmux open <dir>` always creates a *new* workspace, so calling it repeatedly
/// for the same project stacks up duplicates. To avoid that, we first look for
/// an existing workspace already sitting in `path` (see
/// [`find_cmux_workspace_for`]) and simply switch to it — no new workspace, no
/// new tab. Only when none exists do we fall back to `cmux open` to create one.
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

    // Prefer focusing the workspace already open for this directory over
    // stacking a duplicate. The lookup is best-effort — it returns `None` when
    // cmux is not running or the socket is unreachable — so a miss cleanly
    // falls through to creating a workspace below.
    if let Some(workspace_id) = find_cmux_workspace_for(&binary, Path::new(path)).await {
        let status = Command::new(&binary)
            .arg("workspace")
            .arg("select")
            .arg(&workspace_id)
            .env("CMUX_QUIET", "1")
            .stdin(Stdio::null())
            .status()
            .await
            .map_err(|err| DesktopError::Other(err.to_string()))?;

        if status.success() {
            foreground_cmux().await;
            return Ok(());
        }
        // A failed select (e.g. the workspace was closed between listing and
        // selecting) is not fatal — fall through and open a fresh workspace.
    }

    let status = Command::new(&binary)
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

    foreground_cmux().await;
    Ok(())
}

/// Bring cmux to the foreground. `cmux open`/`workspace select` act over the
/// control socket but do not necessarily raise the app when it is already
/// running, so the affected workspace can otherwise stay in the background.
/// Best-effort: a foreground failure must not turn a successful open into an
/// error.
async fn foreground_cmux() {
    let _ = Command::new("open")
        .arg("-a")
        .arg("cmux")
        .stdin(Stdio::null())
        .status()
        .await;
}

#[derive(Deserialize)]
struct CmuxWindow {
    id: String,
}

#[derive(Deserialize)]
struct CmuxWorkspaceList {
    workspaces: Vec<CmuxWorkspace>,
}

#[derive(Deserialize)]
struct CmuxWorkspace {
    id: String,
    current_directory: Option<String>,
}

/// Find an existing cmux workspace whose active directory is `target` or a
/// descendant of it, returning its UUID. cmux opens a workspace at the project
/// root but its active terminal may have `cd`'d deeper, so an exact match is
/// preferred and a workspace nested inside `target` is accepted as a fallback;
/// the closest (shallowest) match wins. Distinct directory trees never match,
/// so separate worktrees keep separate workspaces.
///
/// Best-effort: any failure to reach cmux (not running, socket error, unparsable
/// output) yields `None`, leaving the caller to create a workspace instead.
async fn find_cmux_workspace_for(binary: &Path, target: &Path) -> Option<String> {
    let target = canonicalize_lenient(target);

    let windows: Vec<CmuxWindow> =
        cmux_json(binary, &["--id-format", "uuids", "list-windows", "--json"]).await?;

    let mut best: Option<(usize, String)> = None;
    for window in &windows {
        let Some(list) = cmux_json::<CmuxWorkspaceList>(
            binary,
            &[
                "--id-format",
                "uuids",
                "workspace",
                "list",
                "--json",
                "--window",
                window.id.as_str(),
            ],
        )
        .await
        else {
            continue;
        };

        for ws in list.workspaces {
            let Some(dir) = ws.current_directory.as_deref() else {
                continue;
            };
            let dir = canonicalize_lenient(Path::new(dir));
            let Some(score) = directory_match_score(&target, &dir) else {
                continue;
            };
            if best.as_ref().map_or(true, |(b, _)| score < *b) {
                best = Some((score, ws.id));
            }
        }
    }

    best.map(|(_, id)| id)
}

/// Score how well `dir` belongs to `target`: `0` for an exact match, `n` for a
/// directory `n` levels below `target`, `None` when `dir` is outside `target`.
/// Lower is closer. Only descendants count — `target` is the project root cmux
/// was opened at, so its workspace can only have drifted deeper, never above.
fn directory_match_score(target: &Path, dir: &Path) -> Option<usize> {
    dir.strip_prefix(target)
        .ok()
        .map(|rest| rest.components().count())
}

/// Resolve symlinks and `.`/`..` so paths compare structurally (e.g. macOS's
/// `/var` → `/private/var`). Falls back to the path as-given when it cannot be
/// canonicalized (e.g. it no longer exists), which simply makes a stale entry
/// fail to match.
fn canonicalize_lenient(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Run a cmux subcommand and deserialize its JSON stdout. Returns `None` on spawn
/// failure, a non-zero exit, or a parse error so callers can treat cmux being
/// unavailable as "nothing found".
async fn cmux_json<T: DeserializeOwned>(binary: &Path, args: &[&str]) -> Option<T> {
    let output = Command::new(binary)
        .args(args)
        .env("CMUX_QUIET", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    serde_json::from_slice(&output.stdout).ok()
}

/// Resolve the `cmux` CLI binary. The CLI always ships *inside* the app bundle
/// at `cmux.app/Contents/Resources/bin/cmux`; the `/usr/local/bin/cmux` symlink
/// the app offers to create is optional (it needs admin rights), so the bundle
/// path is the most reliable candidate and is probed first. A desktop app
/// launched from Finder does not inherit the user's shell `PATH`, so we probe
/// fixed locations directly and only then fall back to a login-shell lookup for
/// non-standard installs. `CMUX_BIN` overrides discovery entirely.
async fn resolve_cmux_binary() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("CMUX_BIN") {
        let path = PathBuf::from(value.trim());
        if path.is_file() {
            return Some(path);
        }
    }

    const BUNDLE_CLI: &str = "Contents/Resources/bin/cmux";
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/Applications/cmux.app").join(BUNDLE_CLI),
        PathBuf::from("/usr/local/bin/cmux"),
        PathBuf::from("/opt/homebrew/bin/cmux"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Applications/cmux.app").join(BUNDLE_CLI));
    }
    for path in candidates {
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
