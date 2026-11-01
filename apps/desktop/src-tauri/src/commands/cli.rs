use tauri::async_runtime::spawn_blocking;

use crate::error::{DesktopError, DesktopResult};
use crate::runtime::cli_install::{
    cli_launcher_path, login_shell_path, CliInstallStatus, CliInstaller,
};

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

/// What installing the agent skill would change, without writing anything:
/// the bundled CLI's `chro skill install --dry-run` report.
#[tauri::command]
pub async fn agent_skill_status() -> DesktopResult<serde_json::Value> {
    run_skill_install(true).await
}

/// Install the agent skill into the harnesses' skill folders. The skill
/// touches every agent on the machine, not only chro's, so this runs only
/// from a person's explicit choice (onboarding or the Agent status menu),
/// never on its own.
#[tauri::command]
pub async fn agent_skill_install() -> DesktopResult<serde_json::Value> {
    run_skill_install(false).await
}

async fn run_skill_install(dry_run: bool) -> DesktopResult<serde_json::Value> {
    let launcher = cli_launcher_path(tauri::is_dev())
        .ok_or_else(|| DesktopError::Other("the bundled chro CLI was not found".into()))?;
    let output = spawn_blocking(move || {
        let mut command = std::process::Command::new(&launcher);
        command.args(["skill", "install", "--json"]);
        if dry_run {
            command.arg("--dry-run");
        }
        command.output()
    })
    .await
    .map_err(|err| DesktopError::Other(err.to_string()))??;
    skill_report(&output.stdout)
}

/// The `result` of the CLI's JSON envelope, or its error message.
fn skill_report(stdout: &[u8]) -> DesktopResult<serde_json::Value> {
    let envelope: serde_json::Value = serde_json::from_slice(stdout).map_err(|_| {
        DesktopError::Other(format!(
            "unexpected output from chro skill install: {}",
            String::from_utf8_lossy(stdout).trim()
        ))
    })?;
    if envelope["ok"] == true {
        return Ok(envelope["result"].clone());
    }
    let message = envelope["error"]["message"]
        .as_str()
        .unwrap_or("chro skill install failed");
    Err(DesktopError::Other(message.to_string()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_is_the_envelope_result() {
        let report = skill_report(br#"{"ok":true,"result":{"dry_run":true,"targets":[]},"meta":{}}"#)
            .unwrap();
        assert_eq!(report["dry_run"], true);
    }

    #[test]
    fn a_failed_envelope_surfaces_its_message() {
        let err = skill_report(
            br#"{"ok":false,"error":{"code":"internal","message":"no home directory"},"meta":{}}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("no home directory"));
    }

    #[test]
    fn output_that_is_not_an_envelope_is_an_error() {
        assert!(skill_report(b"Segmentation fault").is_err());
    }
}
