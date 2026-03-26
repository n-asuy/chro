use std::{
    collections::HashSet,
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use log_types::LogEntry;
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader},
    process::Command,
    sync::mpsc,
    task::{JoinError, JoinHandle, spawn_blocking},
    time::timeout,
};

/// Error emitted when running shell commands fails.
#[derive(Debug, Error)]
pub enum ShellError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("task join error: {0}")]
    Join(#[from] JoinError),
    #[error("process terminated unexpectedly")]
    Aborted,
}

pub struct ShellOutput {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

const PATH_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolve an executable by name, refreshing the PATH from the user's login shell if needed.
pub async fn resolve_executable_path(executable: &str) -> Option<PathBuf> {
    if executable.trim().is_empty() {
        return None;
    }

    let path = Path::new(executable);
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    if let Some(found) = which_async(executable).await {
        return Some(found);
    }

    if refresh_path().await {
        if let Some(found) = which_async(executable).await {
            return Some(found);
        }
    }

    None
}

async fn which_async(executable: &str) -> Option<PathBuf> {
    let executable = executable.to_string();
    spawn_blocking(move || which::which(executable))
        .await
        .ok()
        .and_then(Result::ok)
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

#[cfg(windows)]
async fn get_login_shell_path() -> Option<OsString> {
    let mut cmd = Command::new("powershell.exe");
    cmd.arg("-NoProfile").arg("-Command").arg(
        r#"$machine = [System.Environment]::GetEnvironmentVariable('Path','Machine');
$user = [System.Environment]::GetEnvironmentVariable('Path','User');
$all = @($machine, $user, $Env:Path) | Where-Object { $_ -and $_.Length -gt 0 };
[Console]::Out.Write(($all -join ';'));"#,
    );
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

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

/// Run a shell script using the host's preferred shell.
pub async fn run_script(script: &str, cwd: impl AsRef<Path>) -> Result<ShellOutput, ShellError> {
    let (program, flag) = detect_shell();
    let mut cmd = Command::new(program);
    cmd.arg(flag)
        .arg(script)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn()?;

    let stdout_reader = child.stdout.take().map(read_stream_to_string);
    let stderr_reader = child.stderr.take().map(read_stream_to_string);

    let status = child.wait().await?;

    let stdout = if let Some(handle) = stdout_reader {
        handle.await??
    } else {
        String::new()
    };
    let stderr = if let Some(handle) = stderr_reader {
        handle.await??
    } else {
        String::new()
    };

    Ok(ShellOutput {
        status,
        stdout,
        stderr,
    })
}

/// Stream stdout/stderr into [`LogEntry`] values while executing a command.
pub async fn stream_command<I, S, P>(
    program: P,
    args: I,
    cwd: impl AsRef<Path>,
    mut on_entry: impl FnMut(LogEntry) + Send + 'static,
) -> Result<std::process::ExitStatus, ShellError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    P: AsRef<OsStr>,
{
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn()?;

    let (tx, mut rx) = mpsc::unbounded_channel::<LogEntry>();
    let consumer = tokio::spawn(async move {
        while let Some(entry) = rx.recv().await {
            on_entry(entry);
        }
    });

    let stdout_handle = child.stdout.take().map(|stdout| {
        let sender = tx.clone();
        spawn_reader(stdout, move |line| {
            let _ = sender.send(LogEntry::Stdout(line));
        })
    });

    let stderr_handle = child.stderr.take().map(|stderr| {
        let sender = tx.clone();
        spawn_reader(stderr, move |line| {
            let _ = sender.send(LogEntry::Stderr(line));
        })
    });

    let status = child.wait().await?;

    if let Some(handle) = stdout_handle {
        let _ = handle.await;
    }
    if let Some(handle) = stderr_handle {
        let _ = handle.await;
    }

    drop(tx);
    let _ = consumer.await;

    Ok(status)
}

fn spawn_reader<R, F>(reader: R, mut on_line: F) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    F: FnMut(String) + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf = String::new();
        while reader
            .read_line(&mut buf)
            .await
            .map(|n| n > 0)
            .unwrap_or(false)
        {
            let line = buf.trim_end_matches(['\n', '\r']).to_string();
            on_line(line);
            buf.clear();
        }
    })
}

fn read_stream_to_string(
    mut reader: impl AsyncRead + Unpin + Send + 'static,
) -> JoinHandle<Result<String, std::io::Error>> {
    tokio::spawn(async move {
        let mut buffer = Vec::new();
        reader.read_to_end(&mut buffer).await?;
        Ok(String::from_utf8_lossy(&buffer).to_string())
    })
}

/// Detect a reasonable interactive shell for executing scripts.
pub fn detect_shell() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("cmd", "/C")
    } else if Path::new("/bin/zsh").exists() {
        ("/bin/zsh", "-c")
    } else if Path::new("/bin/bash").exists() {
        ("/bin/bash", "-c")
    } else {
        ("/bin/sh", "-c")
    }
}
