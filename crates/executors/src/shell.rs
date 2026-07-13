use std::{
    collections::HashSet,
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::{process::Command, task::spawn_blocking, time::timeout};

const PATH_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolve a generic executable by name.
///
/// Used for ad-hoc binaries that are not declared in a [`crate::cli_manifest::CliManifest`]
/// (npm, curl, brew, etc.) and as the fallback path when a user overrides
/// the CLI base command via `CmdOverrides::base_command_override`. CLI
/// binaries that own a manifest should go through [`crate::cli_resolver::resolve_cli`]
/// instead so they pick up candidate-list + login-shell PATH refresh.
pub async fn resolve_executable_path(executable: &str) -> Option<PathBuf> {
    if executable.trim().is_empty() {
        return None;
    }

    let path = Path::new(executable);
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    if let Some(found) = which_executable(executable).await {
        return Some(found);
    }

    if refresh_login_shell_path().await
        && let Some(found) = which_executable(executable).await
    {
        return Some(found);
    }

    None
}

/// Look up a binary by name via `which`, off the runtime so it doesn't block.
///
/// Public so the manifest-driven resolver in [`crate::cli_resolver`] can
/// reuse the same primitive without re-implementing the spawn-blocking dance.
pub async fn which_executable(executable: &str) -> Option<PathBuf> {
    let executable = executable.to_string();
    spawn_blocking(move || which::which(executable))
        .await
        .ok()
        .and_then(Result::ok)
}

/// Refresh `$PATH` from the user's login shell.
///
/// Public so the manifest-driven resolver can re-walk its candidate list
/// after the GUI-launched process picks up the user's interactive PATH
/// (Homebrew, NVM, etc.). Returns `true` when `$PATH` actually changed.
pub async fn refresh_login_shell_path() -> bool {
    refresh_path().await
}

async fn refresh_path() -> bool {
    let Some(refreshed) = get_login_shell_path().await else {
        return false;
    };

    let existing = env::var_os("PATH").unwrap_or_default();
    let merged = merge_paths(&existing, &refreshed);

    if merged == existing {
        return false;
    }

    unsafe {
        env::set_var("PATH", &merged);
    }
    true
}

fn merge_paths(primary: impl AsRef<OsStr>, secondary: impl AsRef<OsStr>) -> OsString {
    let mut seen = HashSet::<PathBuf>::new();
    let mut merged = Vec::<PathBuf>::new();

    for path in env::split_paths(primary.as_ref()).chain(env::split_paths(secondary.as_ref())) {
        if path.as_os_str().is_empty() {
            continue;
        }

        if seen.insert(path.clone()) {
            merged.push(path);
        }
    }

    env::join_paths(merged).unwrap_or_default()
}

#[cfg(not(windows))]
async fn get_login_shell_path() -> Option<OsString> {
    for shell in shell_candidates() {
        if let Some(path) = read_path_from_shell(&shell).await {
            return Some(path);
        }
    }
    None
}

#[cfg(not(windows))]
async fn read_path_from_shell(shell: &Path) -> Option<OsString> {
    if !shell.is_file() {
        return None;
    }

    let mut cmd = Command::new(shell);
    if let Some(name) = shell.file_name().and_then(|n| n.to_str()) {
        if matches!(name, "zsh" | "bash") {
            cmd.arg("-l");
        }
    }

    cmd.arg("-c")
        .arg(script_for_shell(shell))
        .env("TERM", "dumb")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = match timeout(PATH_REFRESH_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => output,
        _ => return None,
    };

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(OsString::from(value))
    }
}

#[cfg(not(windows))]
fn shell_candidates() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    if let Ok(shell) = env::var("SHELL") {
        let path = PathBuf::from(shell);
        if path.is_file() && seen.insert(path.clone()) {
            candidates.push(path);
        }
    }

    for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        let path = PathBuf::from(fallback);
        if path.is_file() && seen.insert(path.clone()) {
            candidates.push(path);
        }
    }

    candidates
}

#[cfg(not(windows))]
fn script_for_shell(shell: &Path) -> String {
    let name = shell
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();

    match name {
        "zsh" => {
            "if [ -f \"$HOME/.zshrc\" ]; then source \"$HOME/.zshrc\"; fi; printf '%s' \"$PATH\""
                .into()
        }
        "bash" => {
            "if [ -f \"$HOME/.bashrc\" ]; then source \"$HOME/.bashrc\"; fi; printf '%s' \"$PATH\""
                .into()
        }
        _ => "printf '%s' \"$PATH\"".into(),
    }
}

// Wrapper printed around the captured PATH so banners, MOTDs, or profile
// `Write-Host` noise can be stripped before parsing.
#[cfg(windows)]
const WINDOWS_PATH_DELIMITER: &str = "__CHRO_PATH__";

// Dot-source every existing PowerShell profile (suppressing all output), then
// print the resulting `$env:Path` between delimiters. Node version managers
// (fnm, nvm-windows, Volta) and similar tools prepend their bin dirs from the
// user's profile, not the registry, so this captures dirs a bare `which` and
// the registry-only `Path` miss. `-NoProfile` skips PowerShell's own auto-load;
// we source the profiles explicitly so the set is deterministic.
#[cfg(windows)]
const WINDOWS_PATH_SCRIPT: &str = "$ErrorActionPreference='SilentlyContinue'; \
foreach ($p in @($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost)) \
{ if ($p -and (Test-Path $p)) { . $p *> $null } }; \
[Console]::Out.Write('__CHRO_PATH__' + $env:Path + '__CHRO_PATH__')";

/// Capture the user's interactive `PATH` on Windows.
///
/// A GUI-launched process only inherits the registry (Machine + User) `PATH`,
/// so CLIs that a terminal resolves via the PowerShell profile are invisible to
/// a bare `which`. We launch PowerShell, dot-source the profiles, and read the
/// resulting `$env:Path` so discovery matches the user's real shell.
///
/// PowerShell 7 (`pwsh`) and Windows PowerShell (`powershell.exe`) use separate
/// profile paths, so try `pwsh` first (where modern fnm/starship setups live)
/// and fall back to the always-present `powershell.exe`.
#[cfg(windows)]
async fn get_login_shell_path() -> Option<OsString> {
    for exe in ["pwsh.exe", "powershell.exe"] {
        if let Some(path) = read_path_from_powershell(exe).await {
            return Some(path);
        }
    }
    None
}

#[cfg(windows)]
async fn read_path_from_powershell(exe: &str) -> Option<OsString> {
    let mut cmd = Command::new(exe);
    cmd.arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(WINDOWS_PATH_SCRIPT)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = match timeout(PATH_REFRESH_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => output,
        _ => return None,
    };

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let value = extract_between(&stdout, WINDOWS_PATH_DELIMITER)?;
    if value.is_empty() {
        None
    } else {
        Some(OsString::from(value))
    }
}

#[cfg(windows)]
fn extract_between(text: &str, delimiter: &str) -> Option<String> {
    let start = text.find(delimiter)? + delimiter.len();
    let rest = &text[start..];
    let end = rest.find(delimiter)?;
    Some(rest[..end].trim().to_string())
}
