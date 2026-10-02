//! Registers the bundled `chro` CLI as a shell command.
//!
//! The desktop bundle always ships the CLI next to the app executable (Tauri
//! `externalBin`), so "installing" it is only a matter of making the shell find
//! it, the same model as VS Code's `code` command. macOS and Linux get a symlink
//! in a `bin` directory that is on the user's PATH; Windows gets the bundle
//! directory appended to the user PATH registry value. Nothing is copied, so the
//! command can never drift from the app that ships it.
//!
//! The core is a plain struct built from paths so it can be exercised against a
//! temp directory in tests; the Tauri command layer resolves the real paths.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;

use super::server::repo_root;

/// Environment override for the full command path, for unusual PATH setups.
const INSTALL_PATH_ENV: &str = "CHRO_CLI_INSTALL_PATH";
const DEFAULT_MAC_BIN_DIR: &str = "/usr/local/bin";
const LOGIN_SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    NotInstalled,
    Installed,
    /// A chro-owned command exists but points at a different chro build
    /// (older bundle, moved app, dev target). Reinstalling repairs it.
    Stale,
    /// Something that is not a chro launcher owns the command name. Never
    /// touched automatically.
    Conflict,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallMethod {
    Symlink,
    PathEntry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    pub platform: String,
    pub command_name: String,
    pub command_path: Option<String>,
    pub path_directory: Option<String>,
    /// Whether `path_directory` is on the PATH of the user's login shell, i.e.
    /// whether a freshly opened terminal will find the command.
    pub path_configured: bool,
    /// Whether registering would need administrator rights (the command
    /// directory, or its nearest existing ancestor, is not writable). Lets the
    /// UI register silently when it can and ask first when a prompt would show.
    pub needs_elevation: bool,
    pub launcher_path: Option<String>,
    pub install_method: Option<InstallMethod>,
    pub supported: bool,
    pub state: InstallState,
    /// Where the installed command currently points (symlink target).
    pub current_target: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Linux,
    Windows,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Darwin
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Other
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Darwin => "darwin",
            Self::Linux => "linux",
            Self::Windows => "win32",
            Self::Other => std::env::consts::OS,
        }
    }
}

/// Runs a shell command with administrator privileges (macOS `osascript`).
/// Injected so tests can observe the escalation instead of prompting.
pub type PrivilegedRunner = Box<dyn Fn(&str) -> Result<()> + Send + Sync>;

pub struct CliInstaller {
    platform: Platform,
    command_name: String,
    launcher: Option<PathBuf>,
    /// Directory the command is exposed from: the symlink directory on unix,
    /// the bundle directory itself on Windows.
    command_dir: PathBuf,
    /// PATH of the user's shell, used to report `path_configured`. `None`
    /// when the probe failed; the process PATH is then used instead.
    shell_path: Option<OsString>,
    privileged: Option<PrivilegedRunner>,
}

impl CliInstaller {
    /// Build the installer for this running app: bundled launcher, platform
    /// default command directory (or `CHRO_CLI_INSTALL_PATH`), and the login
    /// shell PATH captured by the caller.
    pub fn for_app(shell_path: Option<OsString>) -> Self {
        let platform = Platform::current();
        let dev = tauri::is_dev();
        let launcher = cli_launcher_path(dev);
        let command_name = if dev {
            // Development builds must not claim the production command name.
            "chro-dev".to_string()
        } else {
            "chro".to_string()
        };
        let override_path = std::env::var_os(INSTALL_PATH_ENV)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute());
        let (command_name, command_dir) = match (&override_path, platform) {
            (Some(path), _) => (
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(command_name),
                path.parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("/")),
            ),
            (None, Platform::Windows) => (
                command_name,
                launcher
                    .as_ref()
                    .and_then(|l| l.parent().map(Path::to_path_buf))
                    .unwrap_or_default(),
            ),
            (None, _) => (
                command_name,
                default_unix_bin_dir(platform, dirs::home_dir()),
            ),
        };
        Self {
            platform,
            command_name,
            launcher,
            command_dir,
            shell_path,
            privileged: (platform == Platform::Darwin)
                .then(|| Box::new(run_mac_privileged_command) as PrivilegedRunner),
        }
    }

    #[cfg(test)]
    fn for_test(
        platform: Platform,
        command_name: &str,
        launcher: Option<PathBuf>,
        command_dir: PathBuf,
        shell_path: Option<OsString>,
        privileged: Option<PrivilegedRunner>,
    ) -> Self {
        Self {
            platform,
            command_name: command_name.to_string(),
            launcher,
            command_dir,
            shell_path,
            privileged,
        }
    }

    fn command_path(&self) -> PathBuf {
        let name = match self.platform {
            Platform::Windows => format!("{}.exe", self.command_name),
            _ => self.command_name.clone(),
        };
        self.command_dir.join(name)
    }

    fn install_method(&self) -> InstallMethod {
        match self.platform {
            Platform::Windows => InstallMethod::PathEntry,
            _ => InstallMethod::Symlink,
        }
    }

    pub fn status(&self) -> CliInstallStatus {
        let mut status = CliInstallStatus {
            platform: self.platform.label().to_string(),
            command_name: self.command_name.clone(),
            command_path: None,
            path_directory: None,
            path_configured: false,
            needs_elevation: false,
            launcher_path: self
                .launcher
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            install_method: None,
            supported: false,
            state: InstallState::Unsupported,
            current_target: None,
            detail: None,
        };

        if self.platform == Platform::Other {
            status.detail = Some("CLI registration is not implemented on this platform.".into());
            return status;
        }
        let Some(launcher) = self.launcher.as_ref() else {
            status.detail = Some(
                "The bundled chro CLI is missing from this build, so it cannot be registered."
                    .into(),
            );
            return status;
        };

        let command_path = self.command_path();
        status.command_path = Some(command_path.to_string_lossy().into_owned());
        status.path_directory = Some(self.command_dir.to_string_lossy().into_owned());
        status.install_method = Some(self.install_method());
        status.supported = true;
        status.path_configured = self.path_configured();
        status.needs_elevation = self.install_needs_elevation();

        match self.platform {
            Platform::Windows => {
                // The command is the bundled exe itself; registration only
                // owns the PATH entry, so the two are the same fact.
                status.state = if status.path_configured {
                    InstallState::Installed
                } else {
                    InstallState::NotInstalled
                };
                status.current_target = Some(launcher.to_string_lossy().into_owned());
            }
            _ => {
                let (state, target) = inspect_symlink(&command_path, launcher);
                status.state = state;
                status.current_target = target.map(|t| t.to_string_lossy().into_owned());
            }
        }
        status.detail = self.describe(&status);
        status
    }

    fn describe(&self, status: &CliInstallStatus) -> Option<String> {
        let name = &self.command_name;
        let dir = self.command_dir.display();
        match status.state {
            InstallState::Conflict => Some(format!(
                "{} is not a chro launcher. Remove it manually to register `{name}` there.",
                status.command_path.as_deref().unwrap_or_default()
            )),
            InstallState::Stale => Some(format!(
                "`{name}` points at a different chro build. Reinstall to point it at this app."
            )),
            InstallState::Installed if !status.path_configured => Some(format!(
                "`{name}` is registered in {dir}, but that directory is not on your shell PATH. Add it to your shell profile, then open a new terminal."
            )),
            InstallState::Installed if self.platform == Platform::Windows => {
                Some("Open a new terminal to pick up the updated PATH.".into())
            }
            InstallState::NotInstalled if self.platform == Platform::Windows => {
                Some(format!("Add {dir} to your user PATH."))
            }
            InstallState::NotInstalled => Some(format!("Register `{name}` in {dir}.")),
            _ => None,
        }
    }

    pub fn install(&self) -> Result<CliInstallStatus> {
        let status = self.status();
        if !status.supported {
            bail!(
                "{}",
                status
                    .detail
                    .unwrap_or_else(|| "CLI registration is unavailable on this build.".into())
            );
        }
        match status.state {
            InstallState::Installed => return Ok(status),
            InstallState::Conflict => bail!(
                "Refusing to replace a non-chro command at {}.",
                status.command_path.unwrap_or_default()
            ),
            _ => {}
        }

        match self.platform {
            Platform::Windows => {
                update_windows_user_path(|current| add_path_entry(current, &self.command_dir))?
            }
            _ => self.install_symlink()?,
        }
        Ok(self.status())
    }

    pub fn remove(&self) -> Result<CliInstallStatus> {
        let status = self.status();
        if !status.supported {
            return Ok(status);
        }
        match status.state {
            InstallState::NotInstalled | InstallState::Unsupported => return Ok(status),
            InstallState::Conflict => bail!(
                "Refusing to remove a non-chro command at {}.",
                status.command_path.unwrap_or_default()
            ),
            InstallState::Installed | InstallState::Stale => {}
        }

        match self.platform {
            Platform::Windows => {
                update_windows_user_path(|current| remove_path_entry(current, &self.command_dir))?
            }
            _ => self.remove_symlink()?,
        }
        Ok(self.status())
    }

    fn path_configured(&self) -> bool {
        let path = self
            .shell_path
            .clone()
            .or_else(|| std::env::var_os("PATH"))
            .unwrap_or_default();
        path_contains_dir(&path, &self.command_dir)
    }

    /// Whether creating the symlink would fail with a permission error, which
    /// on macOS turns into an administrator prompt. Walks up to the nearest
    /// existing directory because `~/.local/bin` may not exist yet.
    fn install_needs_elevation(&self) -> bool {
        if self.platform == Platform::Windows {
            return false;
        }
        let mut probe: &Path = &self.command_dir;
        while !probe.exists() {
            match probe.parent() {
                Some(parent) => probe = parent,
                None => return true,
            }
        }
        !is_writable_dir(probe)
    }

    fn install_symlink(&self) -> Result<()> {
        let launcher = self
            .launcher
            .as_ref()
            .ok_or_else(|| anyhow!("bundled CLI launcher missing"))?;
        let command_path = self.command_path();
        match replace_symlink(&self.command_dir, &command_path, launcher) {
            Ok(()) => Ok(()),
            Err(err) if is_permission_denied(&err) => {
                let Some(privileged) = self.privileged.as_ref() else {
                    return Err(err).with_context(|| {
                        format!("no write access to {}", self.command_dir.display())
                    });
                };
                privileged(&format!(
                    "mkdir -p {dir} && ln -sfn {launcher} {command}",
                    dir = shell_quote(&self.command_dir),
                    launcher = shell_quote(launcher),
                    command = shell_quote(&command_path),
                ))
                .context("administrator install failed")
            }
            Err(err) => {
                Err(err).with_context(|| format!("could not register {}", command_path.display()))
            }
        }
    }

    fn remove_symlink(&self) -> Result<()> {
        let command_path = self.command_path();
        match std::fs::remove_file(&command_path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                let Some(privileged) = self.privileged.as_ref() else {
                    return Err(err).with_context(|| {
                        format!("no write access to {}", self.command_dir.display())
                    });
                };
                privileged(&format!("rm -f {}", shell_quote(&command_path)))
                    .context("administrator remove failed")
            }
            Err(err) => {
                Err(err).with_context(|| format!("could not remove {}", command_path.display()))
            }
        }
    }
}

/// Classify what currently occupies `command_path` relative to the launcher we
/// would point it at. Ownership is decided by the symlink target's file name:
/// chro only ever links to a binary named like its launcher, so a link to any
/// other program is somebody else's command.
fn inspect_symlink(command_path: &Path, launcher: &Path) -> (InstallState, Option<PathBuf>) {
    let metadata = match std::fs::symlink_metadata(command_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (InstallState::NotInstalled, None)
        }
        Err(_) => return (InstallState::Conflict, None),
    };
    if !metadata.file_type().is_symlink() {
        return (InstallState::Conflict, None);
    }
    let Ok(raw_target) = std::fs::read_link(command_path) else {
        return (InstallState::Conflict, None);
    };
    let target = if raw_target.is_absolute() {
        raw_target
    } else {
        command_path
            .parent()
            .map(|dir| dir.join(&raw_target))
            .unwrap_or(raw_target)
    };
    if same_path(&target, launcher) {
        return (InstallState::Installed, Some(target));
    }
    let owned = target.file_name().is_some() && target.file_name() == launcher.file_name();
    if owned {
        (InstallState::Stale, Some(target))
    } else {
        (InstallState::Conflict, Some(target))
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn replace_symlink(dir: &Path, command_path: &Path, launcher: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    match std::fs::symlink_metadata(command_path) {
        Ok(_) => std::fs::remove_file(command_path)?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(launcher, command_path)
    }
    #[cfg(not(unix))]
    {
        let _ = launcher;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "symlink registration is unix-only",
        ))
    }
}

#[cfg(unix)]
fn is_writable_dir(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated C string for the call's duration.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn is_writable_dir(_dir: &Path) -> bool {
    true
}

fn is_permission_denied(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::PermissionDenied
}

/// Whether `dir` is one of the PATH entries. Entries are compared after
/// canonicalization so `/usr/local/bin/` and `/usr/local/bin` match, and a
/// symlinked bin dir still counts.
pub fn path_contains_dir(path: &OsString, dir: &Path) -> bool {
    let wanted = normalize_dir(dir);
    std::env::split_paths(path)
        .any(|entry| !entry.as_os_str().is_empty() && normalize_dir(&entry) == wanted)
}

fn normalize_dir(dir: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut normalized = PathBuf::new();
    for component in canonical.components() {
        normalized.push(component.as_os_str());
    }
    normalized
}

/// macOS keeps `/usr/local/bin` on the default PATH, so it is preferred when
/// present (Apple Silicon machines without Homebrew may lack it). Linux and the
/// fallback use the user-owned `~/.local/bin`, which needs no privileges.
fn default_unix_bin_dir(platform: Platform, home: Option<PathBuf>) -> PathBuf {
    let user_bin = home
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".local")
        .join("bin");
    match platform {
        Platform::Darwin if Path::new(DEFAULT_MAC_BIN_DIR).is_dir() => {
            PathBuf::from(DEFAULT_MAC_BIN_DIR)
        }
        _ => user_bin,
    }
}

/// The `chro` CLI this app ships, or the freshly built one from a source
/// checkout in dev mode. Lives beside `chro-server` in both layouts.
pub fn cli_launcher_path(dev: bool) -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "chro.exe"
    } else {
        "chro"
    };
    if dev {
        if let Some(root) = repo_root() {
            for profile in ["debug", "release"] {
                let candidate = root
                    .join("crates")
                    .join("server")
                    .join("target")
                    .join(profile)
                    .join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let candidate = std::env::current_exe().ok()?.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

/// PATH as the user's login shell sees it. GUI processes inherit launchd's
/// sparse PATH, so this is what decides whether a terminal will find the
/// command. `None` when the shell cannot be asked (Windows, timeout, error).
pub async fn login_shell_path() -> Option<OsString> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let output = tokio::time::timeout(
        LOGIN_SHELL_PATH_TIMEOUT,
        tokio::process::Command::new(shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    Some(OsString::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

fn run_mac_privileged_command(command: &str) -> Result<()> {
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .context("osascript could not be started")?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("User canceled") || stderr.contains("(-128)") {
        bail!("Administrator authorization was cancelled.");
    }
    bail!("{}", stderr.trim());
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Append `dir` to a `;`-separated Windows PATH value unless already present.
/// Returns `None` when nothing changes so callers skip the registry write.
pub fn add_path_entry(current: &str, dir: &Path) -> Option<String> {
    if windows_path_has_entry(current, dir) {
        return None;
    }
    let dir = dir.to_string_lossy();
    let trimmed = current.trim_end_matches(';');
    Some(if trimmed.is_empty() {
        dir.into_owned()
    } else {
        format!("{trimmed};{dir}")
    })
}

/// Remove `dir` from a `;`-separated Windows PATH value. Returns `None` when
/// it was not present.
pub fn remove_path_entry(current: &str, dir: &Path) -> Option<String> {
    if !windows_path_has_entry(current, dir) {
        return None;
    }
    let wanted = windows_path_key(&dir.to_string_lossy());
    Some(
        current
            .split(';')
            .filter(|entry| !entry.is_empty() && windows_path_key(entry) != wanted)
            .collect::<Vec<_>>()
            .join(";"),
    )
}

fn windows_path_has_entry(current: &str, dir: &Path) -> bool {
    let wanted = windows_path_key(&dir.to_string_lossy());
    current
        .split(';')
        .any(|entry| !entry.is_empty() && windows_path_key(entry) == wanted)
}

fn windows_path_key(entry: &str) -> String {
    entry
        .trim()
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

/// Read-modify-write the user-scope PATH through PowerShell, which broadcasts
/// the environment change so new terminals pick it up. `edit` returns `None`
/// to leave the value untouched.
#[cfg(target_os = "windows")]
fn update_windows_user_path(edit: impl Fn(&str) -> Option<String>) -> Result<()> {
    let read = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path', 'User')",
        ])
        .output()
        .context("powershell could not be started")?;
    if !read.status.success() {
        bail!("{}", String::from_utf8_lossy(&read.stderr).trim());
    }
    let current = String::from_utf8_lossy(&read.stdout).trim().to_string();
    let Some(next) = edit(&current) else {
        return Ok(());
    };
    let script = format!(
        "[Environment]::SetEnvironmentVariable('Path', '{}', 'User')",
        next.replace('\'', "''")
    );
    let write = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .context("powershell could not be started")?;
    if !write.status.success() {
        bail!("{}", String::from_utf8_lossy(&write.stderr).trim());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn update_windows_user_path(_edit: impl Fn(&str) -> Option<String>) -> Result<()> {
    bail!("user PATH registration is Windows-only")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct Fixture {
        _root: tempfile::TempDir,
        launcher: PathBuf,
        bin: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("Chro.app").join("Contents").join("MacOS");
        std::fs::create_dir_all(&app).unwrap();
        let launcher = app.join("chro");
        std::fs::write(&launcher, "#!/bin/sh\n").unwrap();
        let bin = root.path().join("bin");
        Fixture {
            _root: root,
            launcher,
            bin,
        }
    }

    fn installer(fx: &Fixture, shell_path: Option<OsString>) -> CliInstaller {
        CliInstaller::for_test(
            Platform::Darwin,
            "chro",
            Some(fx.launcher.clone()),
            fx.bin.clone(),
            shell_path,
            None,
        )
    }

    #[test]
    fn reports_not_installed_before_any_registration() {
        let fx = fixture();
        let status = installer(&fx, None).status();
        assert!(status.supported);
        assert_eq!(status.state, InstallState::NotInstalled);
        assert_eq!(status.install_method, Some(InstallMethod::Symlink));
        assert_eq!(
            status.command_path.as_deref(),
            Some(fx.bin.join("chro").to_str().unwrap())
        );
        assert!(status.detail.unwrap().contains("Register `chro`"));
    }

    #[test]
    fn install_creates_symlink_to_launcher_and_remove_deletes_it() {
        let fx = fixture();
        let cli = installer(&fx, Some(fx.bin.as_os_str().to_os_string()));

        let status = cli.install().unwrap();
        assert_eq!(status.state, InstallState::Installed);
        assert!(status.path_configured);
        assert_eq!(
            std::fs::read_link(fx.bin.join("chro")).unwrap(),
            fx.launcher
        );
        assert_eq!(
            status.current_target.as_deref(),
            Some(fx.launcher.to_str().unwrap())
        );

        // Installing again is idempotent.
        assert_eq!(cli.install().unwrap().state, InstallState::Installed);

        let status = cli.remove().unwrap();
        assert_eq!(status.state, InstallState::NotInstalled);
        assert!(!fx.bin.join("chro").exists());
        assert_eq!(cli.remove().unwrap().state, InstallState::NotInstalled);
    }

    #[test]
    fn symlink_to_another_chro_build_is_stale_and_reinstall_repairs_it() {
        let fx = fixture();
        let old_app = fx._root.path().join("old").join("MacOS");
        std::fs::create_dir_all(&old_app).unwrap();
        let old_launcher = old_app.join("chro");
        std::fs::write(&old_launcher, "").unwrap();
        std::fs::create_dir_all(&fx.bin).unwrap();
        std::os::unix::fs::symlink(&old_launcher, fx.bin.join("chro")).unwrap();

        let cli = installer(&fx, None);
        let status = cli.status();
        assert_eq!(status.state, InstallState::Stale);
        assert_eq!(
            status.current_target.as_deref(),
            Some(old_launcher.to_str().unwrap())
        );

        let status = cli.install().unwrap();
        assert_eq!(status.state, InstallState::Installed);
        assert_eq!(
            std::fs::read_link(fx.bin.join("chro")).unwrap(),
            fx.launcher
        );
    }

    #[test]
    fn dangling_chro_symlink_is_stale() {
        let fx = fixture();
        std::fs::create_dir_all(&fx.bin).unwrap();
        std::os::unix::fs::symlink(
            fx._root.path().join("gone").join("chro"),
            fx.bin.join("chro"),
        )
        .unwrap();
        assert_eq!(installer(&fx, None).status().state, InstallState::Stale);
    }

    #[test]
    fn foreign_command_is_a_conflict_that_install_and_remove_refuse() {
        let fx = fixture();
        std::fs::create_dir_all(&fx.bin).unwrap();
        std::fs::write(fx.bin.join("chro"), "#!/bin/sh\necho other\n").unwrap();

        let cli = installer(&fx, None);
        let status = cli.status();
        assert_eq!(status.state, InstallState::Conflict);
        assert!(status.detail.unwrap().contains("not a chro launcher"));
        assert!(cli.install().is_err());
        assert!(cli.remove().is_err());
        assert!(fx.bin.join("chro").is_file());
    }

    #[test]
    fn symlink_to_a_differently_named_program_is_a_conflict() {
        let fx = fixture();
        let other = fx._root.path().join("other-tool");
        std::fs::write(&other, "").unwrap();
        std::fs::create_dir_all(&fx.bin).unwrap();
        std::os::unix::fs::symlink(&other, fx.bin.join("chro")).unwrap();
        assert_eq!(installer(&fx, None).status().state, InstallState::Conflict);
    }

    #[test]
    fn path_configured_reflects_the_shell_path_not_the_process_path() {
        let fx = fixture();
        std::fs::create_dir_all(&fx.bin).unwrap();
        let on_path = std::env::join_paths([PathBuf::from("/usr/bin"), fx.bin.clone()]).unwrap();
        assert!(installer(&fx, Some(on_path)).status().path_configured);
        let off_path = OsString::from("/usr/bin:/bin");
        let status = installer(&fx, Some(off_path)).install().unwrap();
        assert_eq!(status.state, InstallState::Installed);
        assert!(!status.path_configured);
        assert!(status.detail.unwrap().contains("not on your shell PATH"));
    }

    #[test]
    fn path_lookup_ignores_trailing_separators_and_empty_entries() {
        let fx = fixture();
        std::fs::create_dir_all(&fx.bin).unwrap();
        let mut with_slash = fx.bin.as_os_str().to_os_string();
        with_slash.push("/");
        let path = std::env::join_paths([OsString::from(""), with_slash]).unwrap();
        assert!(path_contains_dir(&path, &fx.bin));
        assert!(!path_contains_dir(&OsString::from(""), &fx.bin));
    }

    #[test]
    fn unwritable_bin_dir_falls_back_to_the_privileged_runner() {
        use std::os::unix::fs::PermissionsExt;
        let fx = fixture();
        std::fs::create_dir_all(&fx.bin).unwrap();
        std::fs::set_permissions(&fx.bin, std::fs::Permissions::from_mode(0o555)).unwrap();
        if std::fs::write(fx.bin.join("probe"), "").is_ok() {
            // Running as root: the permission bits do not apply, so the
            // fallback cannot be provoked here.
            std::fs::remove_file(fx.bin.join("probe")).unwrap();
            return;
        }

        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let bin = fx.bin.clone();
        let launcher = fx.launcher.clone();
        let runner: PrivilegedRunner = Box::new(move |command: &str| {
            recorder.lock().unwrap().push(command.to_string());
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::os::unix::fs::symlink(&launcher, bin.join("chro")).unwrap();
            Ok(())
        });
        let cli = CliInstaller::for_test(
            Platform::Darwin,
            "chro",
            Some(fx.launcher.clone()),
            fx.bin.clone(),
            None,
            Some(runner),
        );

        let status = cli.install().unwrap();
        assert_eq!(status.state, InstallState::Installed);
        let commands = seen.lock().unwrap();
        assert_eq!(commands.len(), 1);
        assert!(commands[0].starts_with("mkdir -p '"));
        assert!(commands[0].contains("ln -sfn '"));
    }

    #[test]
    fn elevation_is_needed_only_when_the_nearest_existing_dir_is_unwritable() {
        use std::os::unix::fs::PermissionsExt;
        let fx = fixture();
        // Not created yet, but its parent (the temp root) is writable.
        assert!(!installer(&fx, None).status().needs_elevation);

        std::fs::create_dir_all(&fx.bin).unwrap();
        std::fs::set_permissions(&fx.bin, std::fs::Permissions::from_mode(0o555)).unwrap();
        let locked = installer(&fx, None).status().needs_elevation;
        std::fs::set_permissions(&fx.bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        if std::fs::write(fx.bin.join("probe"), "").is_ok() && unsafe { libc::geteuid() } == 0 {
            return; // root ignores mode bits
        }
        assert!(locked);
        assert!(!installer(&fx, None).status().needs_elevation);
    }

    #[test]
    fn windows_registration_never_needs_elevation() {
        let fx = fixture();
        let cli = CliInstaller::for_test(
            Platform::Windows,
            "chro",
            Some(fx.launcher.clone()),
            PathBuf::from("C:\\Program Files\\Chro"),
            None,
            None,
        );
        assert!(!cli.status().needs_elevation);
    }

    #[test]
    fn missing_launcher_is_unsupported_and_install_fails_clearly() {
        let fx = fixture();
        let cli =
            CliInstaller::for_test(Platform::Darwin, "chro", None, fx.bin.clone(), None, None);
        let status = cli.status();
        assert!(!status.supported);
        assert_eq!(status.state, InstallState::Unsupported);
        assert!(cli.install().unwrap_err().to_string().contains("missing"));
        assert_eq!(cli.remove().unwrap().state, InstallState::Unsupported);
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(
            shell_quote(Path::new("/Apps/It's Chro.app/chro")),
            "'/Apps/It'\\''s Chro.app/chro'"
        );
    }

    #[test]
    fn windows_path_entries_are_added_once_and_removed_case_insensitively() {
        let dir = Path::new("C:\\Program Files\\Chro");
        assert_eq!(
            add_path_entry("C:\\Windows;", dir).as_deref(),
            Some("C:\\Windows;C:\\Program Files\\Chro")
        );
        assert_eq!(
            add_path_entry("", dir).as_deref(),
            Some("C:\\Program Files\\Chro")
        );
        assert_eq!(add_path_entry("c:\\program files\\chro\\", dir), None);
        assert_eq!(
            remove_path_entry("C:\\Windows;c:\\PROGRAM FILES\\chro\\;D:\\x", dir).as_deref(),
            Some("C:\\Windows;D:\\x")
        );
        assert_eq!(remove_path_entry("C:\\Windows", dir), None);
    }

    #[test]
    fn default_bin_dir_prefers_usr_local_bin_on_macos_only_when_present() {
        let home = PathBuf::from("/Users/someone");
        let linux = default_unix_bin_dir(Platform::Linux, Some(home.clone()));
        assert_eq!(linux, home.join(".local").join("bin"));
        let mac = default_unix_bin_dir(Platform::Darwin, Some(home.clone()));
        if Path::new(DEFAULT_MAC_BIN_DIR).is_dir() {
            assert_eq!(mac, PathBuf::from(DEFAULT_MAC_BIN_DIR));
        } else {
            assert_eq!(mac, home.join(".local").join("bin"));
        }
    }
}
