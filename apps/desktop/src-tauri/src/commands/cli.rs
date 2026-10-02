use tauri::async_runtime::spawn_blocking;

use crate::error::{DesktopError, DesktopResult};
use crate::runtime::cli_install::{login_shell_path, CliInstallStatus, CliInstaller};

/// Registration state of the bundled `chro` shell command. The login shell PATH
/// is probed first so `pathConfigured` answers "will a new terminal find it",
/// not "does this GUI process see it".
#[tauri::command]
pub async fn cli_install_status() -> DesktopResult<CliInstallStatus> {
    let shell_path = login_shell_path().await;
    run(move || Ok(CliInstaller::for_app(shell_path).status())).await
}

#[tauri::command]
pub async fn cli_install() -> DesktopResult<CliInstallStatus> {
    let shell_path = login_shell_path().await;
    run(move || CliInstaller::for_app(shell_path).install()).await
}

#[tauri::command]
pub async fn cli_remove() -> DesktopResult<CliInstallStatus> {
    let shell_path = login_shell_path().await;
    run(move || CliInstaller::for_app(shell_path).remove()).await
}

/// Filesystem probes and the macOS admin prompt block, so they run off the
/// async runtime.
async fn run(
    op: impl FnOnce() -> anyhow::Result<CliInstallStatus> + Send + 'static,
) -> DesktopResult<CliInstallStatus> {
    spawn_blocking(op)
        .await
        .map_err(|err| DesktopError::Other(err.to_string()))?
        .map_err(DesktopError::from)
}
