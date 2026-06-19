//! Interactive PTY sessions for the terminal tab.
//!
//! Each session owns a `portable_pty` master/slave pair, a child process,
//! a writer task that drains the input channel into stdin, and a reader
//! thread that feeds master output into a headless [`terminal::Emulator`]
//! and broadcasts grid snapshots to the WebSocket layer. Emulation (VTE
//! parsing, scrollback, cursor/color state) lives here in Rust — the browser
//! only paints the snapshots — so a reconnecting or second viewer attaches to
//! a live shell and immediately sees the current screen.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    thread,
    time::Duration,
};

use bytes::Bytes;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use terminal::{Emulator, TerminalSnapshot};
use thiserror::Error;
use tokio::{
    sync::{broadcast, mpsc, Mutex},
    task::JoinHandle,
};
use uuid::Uuid;

const OUTPUT_BROADCAST_CAPACITY: usize = 1024;
const INPUT_CHANNEL_CAPACITY: usize = 256;
const READ_BUFFER_BYTES: usize = 8 * 1024;

/// Outbound event emitted by the PTY reader after driving the emulator.
#[derive(Debug, Clone)]
pub enum PtyOutbound {
    /// A fresh view of the terminal grid, produced after parsing a read burst.
    Snapshot(Arc<TerminalSnapshot>),
    /// Process exited; carries the exit code if it could be determined.
    Exit(Option<i32>),
}

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("pty session not found: {0}")]
    NotFound(Uuid),
    #[error("failed to open pty: {0}")]
    OpenFailed(String),
    #[error("failed to spawn shell: {0}")]
    SpawnFailed(String),
    #[error("failed to take pty writer: {0}")]
    WriterFailed(String),
    #[error("failed to resize pty: {0}")]
    ResizeFailed(String),
    #[error("pty input channel closed")]
    InputClosed,
}

/// What program the PTY should host.
///
/// The terminal tab launches an interactive login [`PtyCommand::Shell`]; auth
/// flows launch a specific agent login CLI via [`PtyCommand::Program`] so the
/// CLI's own device-code / token prompts render directly in the terminal
/// (no browser callback, so it works headless and locally through one path).
#[derive(Debug, Clone)]
pub enum PtyCommand {
    /// Interactive shell. `shell` overrides the binary; otherwise `$SHELL`,
    /// then `/bin/bash` (or `cmd.exe` on Windows).
    Shell { shell: Option<String> },
    /// A specific executable with its arguments.
    ///
    /// `initial_input` is typed into the child once it produces its first
    /// output (not on a fixed delay), so an interactive CLI that has finished
    /// painting receives e.g. a slash command. The viewer can still type it by
    /// hand if the auto-send lands too early.
    Program {
        program: String,
        args: Vec<String>,
        initial_input: Option<String>,
    },
}

impl Default for PtyCommand {
    fn default() -> Self {
        Self::Shell { shell: None }
    }
}

#[derive(Debug, Clone)]
pub struct PtySpawnConfig {
    pub cwd: Option<PathBuf>,
    pub command: PtyCommand,
    pub cols: u16,
    pub rows: u16,
    pub env: Vec<(String, String)>,
}

impl Default for PtySpawnConfig {
    fn default() -> Self {
        Self {
            cwd: None,
            command: PtyCommand::default(),
            cols: 80,
            rows: 24,
            env: Vec::new(),
        }
    }
}

/// Public handle to a live PTY session.
pub struct PtySession {
    id: Uuid,
    master: Arc<StdMutex<Box<dyn MasterPty + Send>>>,
    input_tx: mpsc::Sender<Bytes>,
    output_tx: broadcast::Sender<PtyOutbound>,
    /// Authoritative terminal grid. The reader thread advances it; resize and
    /// snapshot reads lock it from the request side.
    emulator: Arc<StdMutex<Emulator>>,
    /// Handle to the child; held for the lifetime of the session so we can
    /// kill it explicitly on shutdown.
    child: Arc<StdMutex<Option<Box<dyn Child + Send + Sync>>>>,
    writer_task: StdMutex<Option<JoinHandle<()>>>,
}

impl PtySession {
    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PtyOutbound> {
        self.output_tx.subscribe()
    }

    pub async fn write(&self, data: Bytes) -> Result<(), PtyError> {
        self.input_tx
            .send(data)
            .await
            .map_err(|_| PtyError::InputClosed)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        {
            let master = self.master.lock().expect("pty master mutex poisoned");
            master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| PtyError::ResizeFailed(e.to_string()))?;
        }
        // Reflow the grid and push the reflowed view so the client repaints at
        // the new size without waiting for the next program output.
        let snapshot = {
            let mut emulator = self.emulator.lock().expect("emulator mutex poisoned");
            emulator.resize(cols, rows);
            emulator.snapshot()
        };
        let _ = self
            .output_tx
            .send(PtyOutbound::Snapshot(Arc::new(snapshot)));
        Ok(())
    }

    /// Current grid view. Used to paint a freshly attached client before any
    /// new program output arrives.
    pub fn snapshot(&self) -> Arc<TerminalSnapshot> {
        let emulator = self.emulator.lock().expect("emulator mutex poisoned");
        Arc::new(emulator.snapshot())
    }

    /// Scroll the scrollback view by `delta_lines` (positive scrolls toward
    /// history) and push the resulting view.
    pub fn scroll(&self, delta_lines: i32) {
        let snapshot = {
            let mut emulator = self.emulator.lock().expect("emulator mutex poisoned");
            emulator.scroll_lines(delta_lines);
            emulator.snapshot()
        };
        let _ = self
            .output_tx
            .send(PtyOutbound::Snapshot(Arc::new(snapshot)));
    }

    /// Best-effort termination. Sends SIGKILL via portable-pty's `Child`,
    /// then aborts the writer task.
    fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }
        if let Ok(mut guard) = self.writer_task.lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }
        // The reader thread exits naturally when the PTY master is closed
        // after the child dies, so we don't join it here (it may be in a
        // blocking read). It will terminate within milliseconds.
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Process-wide registry of live PTY sessions.
#[derive(Clone, Default)]
pub struct PtyService {
    inner: Arc<Mutex<HashMap<Uuid, Arc<PtySession>>>>,
}

impl PtyService {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn create(&self, config: PtySpawnConfig) -> Result<Arc<PtySession>, PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                cols: config.cols.max(1),
                rows: config.rows.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::OpenFailed(e.to_string()))?;

        let mut cmd = match &config.command {
            PtyCommand::Shell { shell } => {
                let shell = resolve_shell(shell.as_deref());
                let mut cmd = CommandBuilder::new(&shell);
                cmd.env("SHELL", &shell);
                cmd
            }
            PtyCommand::Program { program, args, .. } => {
                let mut cmd = CommandBuilder::new(program);
                for arg in args {
                    cmd.arg(arg);
                }
                // A child that shells out (e.g. an agent login CLI) still
                // expects a usable `$SHELL`.
                cmd.env("SHELL", resolve_shell(None));
                cmd
            }
        };
        // Bytes to type into the child once it has rendered (see `PtyCommand`).
        let initial_input: Option<Bytes> = match &config.command {
            PtyCommand::Program {
                initial_input: Some(text),
                ..
            } => Some(Bytes::from(text.clone().into_bytes())),
            _ => None,
        };
        if let Some(cwd) = config.cwd.as_ref() {
            if cwd.is_dir() {
                cmd.cwd(cwd);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // `portable-pty` does not inherit the parent env on every platform,
        // so explicitly forward the user's PATH/HOME/locale when present.
        for key in ["PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE"] {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }
        for (k, v) in config.env.iter() {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        // Drop the slave end so the master's read returns once the child exits.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::WriterFailed(e.to_string()))?;

        let id = Uuid::new_v4();
        let (input_tx, input_rx) = mpsc::channel::<Bytes>(INPUT_CHANNEL_CAPACITY);
        let (output_tx, _) = broadcast::channel::<PtyOutbound>(OUTPUT_BROADCAST_CAPACITY);

        let emulator = Arc::new(StdMutex::new(Emulator::new(
            config.cols.max(1),
            config.rows.max(1),
        )));

        let writer_task = spawn_writer_task(writer, input_rx);
        spawn_reader_thread(
            id,
            pair.master
                .try_clone_reader()
                .map_err(|e| PtyError::OpenFailed(format!("clone master reader failed: {e}")))?,
            output_tx.clone(),
            Arc::clone(&emulator),
            input_tx.clone(),
            initial_input,
        );

        let child = Arc::new(StdMutex::new(Some(child)));
        let exit_watcher_child = Arc::clone(&child);
        let exit_watcher_output = output_tx.clone();
        thread::Builder::new()
            .name(format!("pty-exit-{id}"))
            .spawn(move || {
                let exit_code = wait_for_child(exit_watcher_child);
                let _ = exit_watcher_output.send(PtyOutbound::Exit(exit_code));
            })
            .map_err(|e| PtyError::SpawnFailed(format!("spawn exit watcher: {e}")))?;

        let session = Arc::new(PtySession {
            id,
            master: Arc::new(StdMutex::new(pair.master)),
            input_tx,
            output_tx,
            emulator,
            child,
            writer_task: StdMutex::new(Some(writer_task)),
        });

        let mut sessions = self.inner.lock().await;
        sessions.insert(id, Arc::clone(&session));
        Ok(session)
    }

    /// Look up a live session by id. Used by the WebSocket layer to
    /// reattach a reconnecting client to its existing shell.
    pub async fn get(&self, id: Uuid) -> Option<Arc<PtySession>> {
        self.inner.lock().await.get(&id).cloned()
    }

    /// Remove a session from the registry and shut it down.
    pub async fn close(&self, id: Uuid) -> Result<(), PtyError> {
        let mut sessions = self.inner.lock().await;
        match sessions.remove(&id) {
            Some(session) => {
                session.shutdown();
                Ok(())
            }
            None => Err(PtyError::NotFound(id)),
        }
    }

    /// Drop every live session. Used during graceful shutdown.
    pub async fn shutdown_all(&self) {
        let mut sessions = self.inner.lock().await;
        for session in sessions.values() {
            session.shutdown();
        }
        sessions.clear();
    }
}

fn resolve_shell(requested: Option<&str>) -> String {
    if let Some(shell) = requested {
        if !shell.trim().is_empty() {
            return shell.to_string();
        }
    }
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.trim().is_empty() {
            return shell;
        }
    }
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        "/bin/bash".to_string()
    }
}

fn spawn_writer_task(
    mut writer: Box<dyn Write + Send>,
    mut input_rx: mpsc::Receiver<Bytes>,
) -> JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        // We're already on a blocking thread; pull from the channel via
        // `blocking_recv` to avoid spawning an extra runtime hop per byte.
        while let Some(chunk) = input_rx.blocking_recv() {
            if writer.write_all(&chunk).is_err() {
                break;
            }
            if writer.flush().is_err() {
                break;
            }
        }
    })
}

fn spawn_reader_thread(
    id: Uuid,
    mut reader: Box<dyn Read + Send>,
    output_tx: broadcast::Sender<PtyOutbound>,
    emulator: Arc<StdMutex<Emulator>>,
    input_tx: mpsc::Sender<Bytes>,
    initial_input: Option<Bytes>,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUFFER_BYTES];
            // Typed into the child after its first output burst, so an
            // interactive CLI has started painting before it receives the
            // keystrokes. Taken once, then never again.
            let mut pending_initial = initial_input;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Drive the grid and grab a snapshot under the lock, but
                        // release it before the (potentially blocking) reply
                        // send so resize/snapshot callers never wait behind PTY
                        // back-pressure.
                        let (snapshot, pty_writes) = {
                            let mut emulator = emulator.lock().expect("emulator mutex poisoned");
                            let output = emulator.advance(&buf[..n]);
                            (emulator.snapshot(), output.pty_writes)
                        };
                        // Route any device replies the terminal generated
                        // (cursor/color/size queries) back into the PTY.
                        if !pty_writes.is_empty() {
                            let _ = input_tx.blocking_send(Bytes::from(pty_writes));
                        }
                        // Drop on broadcast failure (no subscribers) but keep
                        // draining so the child never blocks on a full pipe.
                        let _ = output_tx.send(PtyOutbound::Snapshot(Arc::new(snapshot)));
                        // First paint observed: send the queued initial input.
                        if let Some(bytes) = pending_initial.take() {
                            let _ = input_tx.blocking_send(bytes);
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .expect("failed to spawn pty reader thread")
}

fn wait_for_child(child: Arc<StdMutex<Option<Box<dyn Child + Send + Sync>>>>) -> Option<i32> {
    loop {
        let status = {
            let mut guard = match child.lock() {
                Ok(g) => g,
                Err(_) => return None,
            };
            let Some(child) = guard.as_mut() else {
                return None;
            };
            match child.try_wait() {
                Ok(Some(status)) => Some(status),
                Ok(None) => None,
                Err(_) => return None,
            }
        };
        if let Some(status) = status {
            return status.exit_code().try_into().ok();
        }
        thread::sleep(Duration::from_millis(50));
    }
}
