use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime as TauriRuntime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};
use uuid::Uuid;

use super::port::{find_available_port, write_port_file};

const SERVER_HOST: &str = "127.0.0.1";
const DEFAULT_SERVER_PORT: u16 = 4310;
const SERVER_PORT_ENV: &str = "CHRO_DESKTOP_SERVER_PORT";
const HEALTH_CHECK_ATTEMPTS: u32 = 40;
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const HEALTH_CHECK_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// Snapshot of a running `chro-server` instance. Cheap to clone because all of
/// the mutable state lives behind `Arc<Mutex<...>>`.
#[derive(Clone)]
pub struct RuntimeContext {
    pub id: String,
    pub dir: PathBuf,
    pub port: u16,
    pub base_url: String,
    pub workspace_path: Arc<Mutex<Option<String>>>,
    child: Arc<Mutex<Option<CommandChild>>>,
}

impl RuntimeContext {
    pub async fn kill(&self) {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.take() {
            if let Err(err) = child.kill() {
                warn!("[runtime] failed to kill chro-server child: {err}");
            }
        }
    }

    pub async fn set_workspace_path(&self, value: Option<String>) {
        let mut guard = self.workspace_path.lock().await;
        *guard = value;
    }

    pub async fn workspace_path(&self) -> Option<String> {
        self.workspace_path.lock().await.clone()
    }
}

#[derive(Default)]
pub struct RuntimeRegistry {
    runtimes: Mutex<HashMap<String, RuntimeContext>>,
}

impl RuntimeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, runtime: RuntimeContext) {
        self.runtimes
            .lock()
            .await
            .insert(runtime.id.clone(), runtime);
    }

    pub async fn remove(&self, id: &str) -> Option<RuntimeContext> {
        self.runtimes.lock().await.remove(id)
    }

    pub async fn get(&self, id: &str) -> Option<RuntimeContext> {
        self.runtimes.lock().await.get(id).cloned()
    }

    pub async fn primary(&self) -> Option<RuntimeContext> {
        self.runtimes.lock().await.values().next().cloned()
    }

    pub async fn all(&self) -> Vec<RuntimeContext> {
        self.runtimes.lock().await.values().cloned().collect()
    }

    pub async fn kill_all(&self) {
        let map = std::mem::take(&mut *self.runtimes.lock().await);
        for (id, runtime) in map {
            info!("[runtime] stopping chro-server runtime {id}");
            runtime.kill().await;
        }
    }
}

/// Information needed to point the renderer at this runtime. Returned to the
/// renderer via `get_runtime_info` and injected via `initialization_script`
/// so `window.__CHRO_RUNTIME__` is populated synchronously.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfoPayload {
    pub runtime_id: Option<String>,
    pub backend_url: String,
    pub workspace_path: Option<String>,
    pub platform: String,
}

pub fn platform_string() -> String {
    if cfg!(target_os = "macos") {
        "darwin".to_string()
    } else if cfg!(target_os = "windows") {
        "win32".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

pub struct LaunchOptions {
    pub dir: PathBuf,
    pub use_default_config_path: bool,
}

/// Spawn `chro-server` as a sidecar, then poll `/health` until it answers.
pub async fn launch_runtime<R: TauriRuntime>(
    app: AppHandle<R>,
    options: LaunchOptions,
) -> Result<RuntimeContext> {
    let runtime_id = Uuid::new_v4().to_string();
    tokio::fs::create_dir_all(&options.dir)
        .await
        .with_context(|| format!("create runtime dir {}", options.dir.display()))?;

    let db_path = options.dir.join("db.sqlite");
    let port = find_available_port(SERVER_HOST, server_start_port())?;

    if let Err(err) = write_port_file(port) {
        warn!("[runtime] failed to write port file: {err:#}");
    }

    let args: Vec<String> = vec![
        "--db-path".into(),
        db_path.to_string_lossy().into_owned(),
        "--host".into(),
        SERVER_HOST.into(),
        "--port".into(),
        port.to_string(),
        "--no-open".into(),
    ];

    let mut env_vars: HashMap<String, String> = HashMap::new();
    // Tie the sidecar's lifetime to this shell. If the desktop process dies
    // without a clean exit (crash, force-quit, auto-update relaunch) the server
    // self-terminates instead of orphaning onto launchd and holding its port,
    // which would push the next launch onto a new port. Delivered via env (not a
    // CLI flag) so an older bundled chro-server simply ignores it and still boots.
    env_vars.insert("CHRO_PARENT_PID".into(), std::process::id().to_string());
    match std::env::var("RUST_LOG") {
        Ok(value) => {
            env_vars.insert("RUST_LOG".into(), value);
        }
        Err(_) => {
            env_vars.insert(
                "RUST_LOG".into(),
                "info,tower_http=debug,server=debug,local_runtime=debug,runtime=debug,executors=debug"
                    .into(),
            );
        }
    }
    if !options.use_default_config_path {
        env_vars.insert(
            "CHRO_CONFIG_PATH".into(),
            options
                .dir
                .join("config.json")
                .to_string_lossy()
                .into_owned(),
        );
    }

    let command = resolve_sidecar(&app, &args, &env_vars)?;
    let (mut rx, child) = command
        .spawn()
        .context("failed to spawn chro-server sidecar")?;

    let runtime_id_for_logs = runtime_id.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in split_lines(&bytes) {
                        info!(target: "chro-server", "[{runtime_id_for_logs}] {line}");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    for line in split_lines(&bytes) {
                        warn!(target: "chro-server", "[{runtime_id_for_logs}] {line}");
                    }
                }
                CommandEvent::Error(err) => {
                    warn!("[chro-server:{runtime_id_for_logs}] error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    info!(
                        "[chro-server:{runtime_id_for_logs}] terminated code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    let base_url = format!("http://{SERVER_HOST}:{port}");
    wait_for_server_ready(SERVER_HOST, port).await?;

    Ok(RuntimeContext {
        id: runtime_id,
        dir: options.dir,
        port,
        base_url,
        workspace_path: Arc::new(Mutex::new(None)),
        child: Arc::new(Mutex::new(Some(child))),
    })
}

fn server_start_port() -> u16 {
    match std::env::var(SERVER_PORT_ENV) {
        Ok(value) => match value.trim().parse::<u16>() {
            Ok(port) if port != 0 => port,
            Ok(_) | Err(_) => {
                warn!(
                    env = SERVER_PORT_ENV,
                    value,
                    default = DEFAULT_SERVER_PORT,
                    "invalid server start port override"
                );
                DEFAULT_SERVER_PORT
            }
        },
        Err(_) => DEFAULT_SERVER_PORT,
    }
}

fn split_lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split(|c: char| c == '\n' || c == '\r')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn resolve_sidecar<R: TauriRuntime>(
    app: &AppHandle<R>,
    args: &[String],
    env_vars: &HashMap<String, String>,
) -> Result<tauri_plugin_shell::process::Command> {
    let shell = app.shell();

    // `tauri dev` only rebuilds the Rust shell and the frontend — it never
    // rebuilds the bundled `binaries/chro-server-*`, which is a frozen release
    // artifact staged by `tauri build`. Running it in dev therefore executes a
    // stale server (e.g. one missing newly added DB migrations, which then fails
    // to open an already-upgraded database). In dev we prefer the freshly
    // compiled `crates/server/target` binary; release builds keep the bundle.
    let dev_local = if tauri::is_dev() {
        dev_binary_path()
    } else {
        None
    };

    let mut cmd = if let Some(local) = dev_local {
        debug!(
            "[runtime] dev mode: using freshly built chro-server at {}",
            local.display()
        );
        shell.command(local.to_string_lossy().into_owned())
    } else if let Ok(sidecar) = shell.sidecar("chro-server") {
        debug!("[runtime] using bundled chro-server sidecar");
        sidecar
    } else if let Some(local) = sidecar_next_to_current_exe() {
        debug!(
            "[runtime] using bundled chro-server binary at {}",
            local.display()
        );
        shell.command(local.to_string_lossy().into_owned())
    } else if let Some(local) = dev_binary_path() {
        debug!(
            "[runtime] using local chro-server binary at {}",
            local.display()
        );
        shell.command(local.to_string_lossy().into_owned())
    } else {
        anyhow::bail!(
            "chro-server binary not found. Either bundle the sidecar or build crates/server."
        );
    };

    cmd = cmd.args(args);
    for (key, value) in env_vars {
        cmd = cmd.env(key, value);
    }
    Ok(cmd)
}

fn sidecar_next_to_current_exe() -> Option<PathBuf> {
    let binary_name = if cfg!(target_os = "windows") {
        "chro-server.exe"
    } else {
        "chro-server"
    };
    let candidate = std::env::current_exe().ok()?.parent()?.join(binary_name);
    candidate.exists().then_some(candidate)
}

/// Locate the cargo target binary for `chro-server`. We anchor on the repo
/// root so a contributor can launch the desktop from any subdirectory.
fn dev_binary_path() -> Option<PathBuf> {
    let binary_name = if cfg!(target_os = "windows") {
        "chro-server.exe"
    } else {
        "chro-server"
    };
    let repo_root = repo_root()?;
    for profile in ["debug", "release"] {
        let candidate = repo_root
            .join("crates")
            .join("server")
            .join("target")
            .join(profile)
            .join(binary_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn repo_root() -> Option<PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        if current
            .join("crates")
            .join("server")
            .join("Cargo.toml")
            .exists()
        {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Poll `host:port` over plain TCP until something accepts. Matches the
/// Electron build's 40-attempt × 250ms loop. We follow the connect with a tiny
/// HTTP request so we hard-fail when the listener answers but isn't the
/// chro-server (rare but possible if another local service grabbed the port).
async fn wait_for_server_ready(host: &str, port: u16) -> Result<()> {
    for attempt in 0..HEALTH_CHECK_ATTEMPTS {
        match probe_health(host, port).await {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(err) => debug!("[runtime] health check attempt {attempt} failed: {err}"),
        }
        tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
    }
    anyhow::bail!("Rust server did not become ready in time")
}

async fn probe_health(host: &str, port: u16) -> Result<bool> {
    let host = host.to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<bool> {
        let addr = (host.as_str(), port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| anyhow::anyhow!("could not resolve host"))?;
        let mut stream = TcpStream::connect_timeout(&addr, HEALTH_CHECK_CONNECT_TIMEOUT)?;
        stream.set_read_timeout(Some(HEALTH_CHECK_CONNECT_TIMEOUT))?;
        stream.set_write_timeout(Some(HEALTH_CHECK_CONNECT_TIMEOUT))?;
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nUser-Agent: chro-desktop\r\n\r\n",
            host = host.as_str(),
            port = port,
        );
        stream.write_all(request.as_bytes())?;
        let mut buf = [0u8; 32];
        let read = stream.read(&mut buf).unwrap_or(0);
        if read == 0 {
            return Ok(false);
        }
        let response = String::from_utf8_lossy(&buf[..read]);
        Ok(response.starts_with("HTTP/1.1 2") || response.starts_with("HTTP/1.0 2"))
    })
    .await??;

    Ok(result)
}

/// Tauri-managed state holding the registry of running chro-server processes
/// and the primary userData dir path.
pub struct ServerState {
    pub registry: RuntimeRegistry,
    pub primary_runtime_dir: PathBuf,
}

impl ServerState {
    pub fn new(primary_runtime_dir: PathBuf) -> Self {
        Self {
            registry: RuntimeRegistry::new(),
            primary_runtime_dir,
        }
    }
}

pub async fn primary_runtime<R: TauriRuntime>(app: &AppHandle<R>) -> Option<RuntimeContext> {
    app.state::<ServerState>().registry.primary().await
}
