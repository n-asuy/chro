mod client;
mod task;

use clap::{Parser, Subcommand};
use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SERVER_PORT: u16 = 4310;
const DEFAULT_SERVER_READY_TIMEOUT_SECS: u64 = 120;
const SERVER_READY_RETRY_MS: u64 = 250;
const SERVER_READY_SLOW_START_NOTICE_SECS: u64 = 10;
const SERVER_READY_TIMEOUT_ENV: &str = "CHRO_SERVER_READY_TIMEOUT_SECS";

#[derive(Parser, Debug)]
#[command(name = "chro")]
#[command(author = "Chro")]
#[command(version)]
#[command(about = "Chro — AI-powered productivity tool", long_about = None)]
struct Cli {
    /// Git repository path (default: CWD's git root)
    #[arg(short = 'w', long, global = true)]
    project: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Launch development services (server + Vite)
    Dev {
        /// Enable perf logging for server and Vite
        #[arg(long)]
        perf: bool,
    },

    /// Task management
    Task {
        #[command(subcommand)]
        command: task::TaskCommand,
    },
}

fn main() {
    let cli = Cli::parse();

    match &cli.command {
        None | Some(Commands::Dev { .. }) => {
            let perf = matches!(&cli.command, Some(Commands::Dev { perf: true }));
            run_dev(perf);
        }
        Some(Commands::Task { command }) => {
            let client = match client::ServerClient::connect() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            };

            if let Err(e) = task::run(command, &client, cli.project.as_deref()) {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dev launcher (original functionality)
// ---------------------------------------------------------------------------

fn run_dev(perf: bool) {
    let repo_root = locate_repo_root().unwrap_or_else(|message| {
        eprintln!("{}", message);
        std::process::exit(1);
    });

    let desktop_dir = repo_root.join("apps/desktop");
    if !desktop_dir.is_dir() {
        eprintln!("Failed to locate apps/desktop at {}", desktop_dir.display());
        std::process::exit(1);
    }

    let server_manifest = repo_root.join("crates/server/Cargo.toml");

    println!("Starting Chro...");

    let mut server = spawn_server(&desktop_dir, &server_manifest, &repo_root, perf);
    wait_for_server_ready(&mut server, SERVER_PORT);
    let mut vite = spawn_vite(&desktop_dir, perf);

    let exit_code = wait_for_children(&mut server, &mut vite);
    terminate_child(&mut server);
    terminate_child(&mut vite);
    std::process::exit(exit_code);
}

fn spawn_server(desktop_dir: &Path, server_manifest: &Path, repo_root: &Path, perf: bool) -> Child {
    println!("Starting chro-server on port {}...", SERVER_PORT);

    let mut command = Command::new("cargo");
    command
        .arg("run")
        .arg("--manifest-path")
        .arg(server_manifest)
        .arg("--bin")
        .arg("chro-server")
        .arg("--")
        .arg("--port")
        .arg(SERVER_PORT.to_string())
        .current_dir(desktop_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    if perf {
        command
            .env("CHRO_PERF_DIR", repo_root.join("log/performance"))
            .arg("--perf");
    }

    command.spawn().unwrap_or_else(|error| {
        eprintln!("Failed to launch chro-server: {}", error);
        std::process::exit(1);
    })
}

fn spawn_vite(desktop_dir: &Path, perf: bool) -> Child {
    let script = if perf { "dev:vite:perf" } else { "dev:vite" };
    println!("Starting Vite with `bun run {}`...", script);

    Command::new("bun")
        .arg("run")
        .arg(script)
        .current_dir(desktop_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|error| {
            eprintln!("Failed to launch `bun run {}`: {}", script, error);
            std::process::exit(1);
        })
}

fn wait_for_server_ready(server: &mut Child, port: u16) {
    println!("Waiting for chro-server to become ready...");

    let timeout = server_ready_timeout();
    let started_at = Instant::now();
    let mut warned_about_slow_start = false;

    loop {
        if let Some(status) = wait_status(server, "chro-server") {
            std::process::exit(status);
        }

        if backend_is_ready(port) {
            return;
        }

        let elapsed = started_at.elapsed();
        if !warned_about_slow_start
            && elapsed >= Duration::from_secs(SERVER_READY_SLOW_START_NOTICE_SECS)
        {
            eprintln!(
                "chro-server is still starting after {}s; it may still be compiling",
                elapsed.as_secs()
            );
            warned_about_slow_start = true;
        }

        if elapsed >= timeout {
            break;
        }

        thread::sleep(Duration::from_millis(SERVER_READY_RETRY_MS));
    }

    eprintln!(
        "Timed out waiting for chro-server to become ready on port {} after {}s",
        port,
        timeout.as_secs()
    );
    terminate_child(server);
    std::process::exit(1);
}

fn server_ready_timeout() -> Duration {
    match env::var(SERVER_READY_TIMEOUT_ENV) {
        Ok(value) => match value.trim().parse::<u64>() {
            Ok(seconds) if seconds > 0 => Duration::from_secs(seconds),
            _ => {
                eprintln!(
                    "Ignoring invalid {} value {:?}; expected a positive integer number of seconds",
                    SERVER_READY_TIMEOUT_ENV, value
                );
                Duration::from_secs(DEFAULT_SERVER_READY_TIMEOUT_SECS)
            }
        },
        Err(_) => Duration::from_secs(DEFAULT_SERVER_READY_TIMEOUT_SECS),
    }
}

fn backend_is_ready(port: u16) -> bool {
    let timeout = Duration::from_millis(200);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut response = [0u8; 128];
    match stream.read(&mut response) {
        Ok(size) if size > 0 => {
            let head = String::from_utf8_lossy(&response[..size]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        _ => false,
    }
}

fn wait_for_children(server: &mut Child, vite: &mut Child) -> i32 {
    loop {
        if let Some(status) = wait_status(server, "chro-server") {
            return status;
        }

        if let Some(status) = wait_status(vite, "vite") {
            return status;
        }

        thread::sleep(Duration::from_millis(200));
    }
}

fn locate_repo_root() -> Result<PathBuf, String> {
    if let Ok(value) = env::var("CHRO_REPO_ROOT") {
        let path = PathBuf::from(value);
        if is_repo_root(&path) {
            return Ok(path);
        }

        return Err(format!(
            "CHRO_REPO_ROOT does not point to a valid Chro repository: {}",
            path.display()
        ));
    }

    if let Ok(current_dir) = env::current_dir() {
        if let Some(path) = find_repo_root_from(&current_dir) {
            return Ok(path);
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            if let Some(path) = find_repo_root_from(exe_dir) {
                return Ok(path);
            }
        }
    }

    Err(
        "Failed to locate the Chro repository. Run `chro` from inside a Chro checkout or set CHRO_REPO_ROOT=/path/to/chro."
            .to_string(),
    )
}

fn find_repo_root_from(start: &Path) -> Option<PathBuf> {
    for ancestor in start.ancestors() {
        if is_repo_root(ancestor) {
            return Some(ancestor.to_path_buf());
        }
    }

    None
}

fn is_repo_root(path: &Path) -> bool {
    path.join("apps/desktop").is_dir() && path.join("crates/server/Cargo.toml").is_file()
}

fn wait_status(child: &mut Child, name: &str) -> Option<i32> {
    match child.try_wait() {
        Ok(Some(status)) => {
            let code = status.code().unwrap_or(1);
            eprintln!("{} exited with code {}", name, code);
            Some(code)
        }
        Ok(None) => None,
        Err(error) => {
            eprintln!("Failed while waiting for {}: {}", name, error);
            Some(1)
        }
    }
}

fn terminate_child(child: &mut Child) {
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
        }
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn server_ready_timeout_defaults_when_env_is_missing() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(SERVER_READY_TIMEOUT_ENV);

        assert_eq!(
            server_ready_timeout(),
            Duration::from_secs(DEFAULT_SERVER_READY_TIMEOUT_SECS)
        );
    }

    #[test]
    fn server_ready_timeout_uses_positive_env_value() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(SERVER_READY_TIMEOUT_ENV, "15");

        assert_eq!(server_ready_timeout(), Duration::from_secs(15));

        env::remove_var(SERVER_READY_TIMEOUT_ENV);
    }

    #[test]
    fn server_ready_timeout_rejects_invalid_env_value() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(SERVER_READY_TIMEOUT_ENV, "invalid");

        assert_eq!(
            server_ready_timeout(),
            Duration::from_secs(DEFAULT_SERVER_READY_TIMEOUT_SECS)
        );

        env::remove_var(SERVER_READY_TIMEOUT_ENV);
    }
}
