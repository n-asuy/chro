use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::info;

use crate::error::{DesktopError, DesktopResult};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DesktopExecutor {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorInstallResult {
    pub ok: bool,
    pub executor: String,
    pub command: String,
    pub strategy: String,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
}

#[tauri::command]
pub async fn install_executor(executor: DesktopExecutor) -> DesktopResult<ExecutorInstallResult> {
    let executor_name = match executor {
        DesktopExecutor::ClaudeCode => "CLAUDE_CODE",
        DesktopExecutor::Codex => "CODEX",
    };

    let strategy = match resolve_strategy(executor).await {
        Ok(strategy) => strategy,
        Err(err) => {
            return Ok(ExecutorInstallResult {
                ok: false,
                executor: executor_name.to_string(),
                command: String::new(),
                strategy: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                message: err.to_string(),
            });
        }
    };

    match run_shell_command(&strategy.command, executor_name).await {
        Ok((stdout, stderr)) => Ok(ExecutorInstallResult {
            ok: true,
            executor: executor_name.to_string(),
            command: strategy.command.clone(),
            strategy: strategy.label.clone(),
            stdout: stdout.trim().to_string(),
            stderr: stderr.trim().to_string(),
            message: format!("Installed via {}.", strategy.label),
        }),
        Err(err) => Ok(ExecutorInstallResult {
            ok: false,
            executor: executor_name.to_string(),
            command: strategy.command.clone(),
            strategy: strategy.label.clone(),
            stdout: err.stdout.trim().to_string(),
            stderr: err.stderr.trim().to_string(),
            message: err.message,
        }),
    }
}

#[derive(Debug, Clone)]
struct Strategy {
    label: String,
    command: String,
}

async fn resolve_strategy(executor: DesktopExecutor) -> DesktopResult<Strategy> {
    match executor {
        DesktopExecutor::ClaudeCode => {
            if cfg!(target_os = "windows") {
                if command_exists("npm").await {
                    return Ok(Strategy {
                        label: "npm".into(),
                        command: "npm install -g @anthropic-ai/claude-code".into(),
                    });
                }
                return Err(DesktopError::Other(
                    "Automatic install requires npm on Windows. Open the install guide to continue manually.".into(),
                ));
            }
            if command_exists("curl").await {
                return Ok(Strategy {
                    label: "official installer".into(),
                    command: "curl -fsSL https://claude.ai/install.sh | bash".into(),
                });
            }
            if command_exists("npm").await {
                return Ok(Strategy {
                    label: "npm".into(),
                    command: "npm install -g @anthropic-ai/claude-code".into(),
                });
            }
            Err(DesktopError::Other(
                "Automatic install requires curl or npm. Open the install guide to continue manually.".into(),
            ))
        }
        DesktopExecutor::Codex => {
            if cfg!(target_os = "macos") && command_exists("brew").await {
                return Ok(Strategy {
                    label: "Homebrew".into(),
                    command: "brew install --cask codex".into(),
                });
            }
            if command_exists("npm").await {
                return Ok(Strategy {
                    label: "npm".into(),
                    command: "npm install -g @openai/codex".into(),
                });
            }
            Err(DesktopError::Other(
                "Automatic install requires Homebrew or npm. Open the install guide to continue manually.".into(),
            ))
        }
    }
}

#[derive(Debug)]
struct ShellExecError {
    stdout: String,
    stderr: String,
    message: String,
}

async fn run_shell_command(command: &str, label: &str) -> Result<(String, String), ShellExecError> {
    info!("[install:{label}] $ {command}");
    let output = if cfg!(target_os = "windows") {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output()
            .await
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/bash".into()
            }
        });
        let args = if has_login_shell(&shell) {
            vec!["-lc", command]
        } else {
            vec!["-c", command]
        };
        Command::new(shell)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output()
            .await
    };

    let output = output.map_err(|err| ShellExecError {
        stdout: String::new(),
        stderr: String::new(),
        message: err.to_string(),
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if output.status.success() {
        Ok((stdout, stderr))
    } else {
        let message = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!(
                "Installer exited with code {}",
                output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())
            )
        };
        Err(ShellExecError {
            stdout,
            stderr,
            message,
        })
    }
}

fn has_login_shell(shell: &str) -> bool {
    shell.ends_with("/zsh") || shell.ends_with("/bash") || shell.ends_with("/fish")
}

async fn command_exists(name: &str) -> bool {
    let probe = if cfg!(target_os = "windows") {
        format!("Get-Command {name} | Out-Null")
    } else {
        format!("command -v {name} >/dev/null 2>&1")
    };
    run_shell_command(&probe, "probe").await.is_ok()
}
