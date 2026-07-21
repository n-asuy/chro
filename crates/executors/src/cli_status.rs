//! Resolve each agent CLI to a path + version for the "CLI status" UI surface.
//!
//! This is the read-only diagnostics counterpart to [`crate::cli_resolver`]:
//! it resolves the binary the same way an execution would, then runs
//! `<cli> --version` so the desktop can show which build is actually on PATH.
//! Surfacing this is the direct fix for silent version drift (a stale binary
//! shadowing the intended one), which has produced hard-to-diagnose failures.

use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use ts_rs::TS;

use crate::cli_manifest::{self, CliManifest};
use crate::cli_resolver::{ResolutionSource, resolve_cli};
use crate::spawn::prepare_invocation;

/// Max time to wait for a `--version` probe before giving up.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Status of a single agent CLI: where it resolved and what version it reports.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "cli-status.ts")]
pub struct CliStatus {
    /// Manifest name, e.g. `"claude"`, `"codex"`, `"pi"`.
    pub name: String,
    /// Whether a binary was resolved at all.
    pub found: bool,
    /// Absolute resolved path, when found.
    pub path: Option<String>,
    /// Human-readable locator for how it resolved.
    pub source: Option<String>,
    /// Raw first line of `<cli> --version`, when the probe succeeded.
    pub version: Option<String>,
    /// Install hint from the manifest, shown when the CLI is missing.
    pub install_hint: String,
}

fn source_label(source: &ResolutionSource) -> String {
    match source {
        ResolutionSource::EnvOverride { env_name } => format!("${env_name}"),
        ResolutionSource::UnderHome(rel) => format!("~/{rel}"),
        ResolutionSource::Absolute(abs) => (*abs).to_string(),
        ResolutionSource::Path { name } => (*name).to_string(),
    }
}

/// Resolve one manifest and probe its version. Never errors: a missing binary
/// or a failed probe is reported as absent/`None`, not a hard failure.
pub async fn probe_cli(manifest: &'static CliManifest) -> CliStatus {
    let mut status = CliStatus {
        name: manifest.name.to_string(),
        found: false,
        path: None,
        source: None,
        version: None,
        install_hint: manifest.install_hint.to_string(),
    };

    let Some(resolved) = resolve_cli(manifest).await else {
        return status;
    };

    status.found = true;
    status.path = Some(resolved.path.to_string_lossy().into_owned());
    status.source = Some(source_label(&resolved.source));
    status.version = probe_version(&resolved.path).await;
    status
}

async fn probe_version(path: &std::path::Path) -> Option<String> {
    // Route through the same platform normalization as execution so a resolved
    // Windows `.cmd` shim is probed via the command interpreter rather than
    // spawned directly (which `CreateProcessW` cannot do).
    let invocation = prepare_invocation(path.to_path_buf(), vec!["--version".to_string()]).ok()?;
    let output = tokio::time::timeout(
        VERSION_PROBE_TIMEOUT,
        Command::new(&invocation.program)
            .args(&invocation.args)
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr)
    } else {
        String::from_utf8_lossy(&output.stdout)
    };
    let first_line = text.lines().next()?.trim();
    if first_line.is_empty() {
        None
    } else {
        Some(first_line.to_string())
    }
}

/// Probe a bare command by name via a `PATH` lookup (for CLIs without a
/// manifest, e.g. chro's own CLI). `install_hint` is left empty.
pub async fn probe_named(name: &str, command: &str) -> CliStatus {
    let mut status = CliStatus {
        name: name.to_string(),
        found: false,
        path: None,
        source: None,
        version: None,
        install_hint: String::new(),
    };

    let Some(path) = crate::shell::which_executable(command).await else {
        return status;
    };
    status.found = true;
    status.source = Some(command.to_string());
    status.version = probe_version(&path).await;
    status.path = Some(path.to_string_lossy().into_owned());
    status
}

/// Probe every known agent CLI concurrently.
pub async fn probe_all_agent_clis() -> Vec<CliStatus> {
    let (codex, claude, pi) = tokio::join!(
        probe_cli(&cli_manifest::CODEX),
        probe_cli(&cli_manifest::CLAUDE),
        probe_cli(&cli_manifest::PI),
    );
    vec![claude, codex, pi]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_label_omits_wrappers_for_home_and_absolute_paths() {
        assert_eq!(
            source_label(&ResolutionSource::UnderHome(".local/bin/claude")),
            "~/.local/bin/claude"
        );
        assert_eq!(
            source_label(&ResolutionSource::Absolute("/opt/homebrew/bin/codex")),
            "/opt/homebrew/bin/codex"
        );
    }

    #[test]
    fn source_label_omits_wrappers_for_env_and_path_sources() {
        assert_eq!(
            source_label(&ResolutionSource::EnvOverride {
                env_name: "CLAUDE_BIN"
            }),
            "$CLAUDE_BIN"
        );
        assert_eq!(source_label(&ResolutionSource::Path { name: "pi" }), "pi");
    }
}
