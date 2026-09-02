//! Local development event sink.
//!
//! Records the full stream of application activity to newline-delimited JSON
//! on disk so a developer can analyse how they actually use the app. Nothing
//! written here leaves the machine: the network path is [`crate::capture`],
//! which is gated on a separate egress allowlist. That split is deliberate --
//! the local stream is a firehose with raw paths and identifiers, and it must
//! stay impossible for it to reach a remote collector by accident.
//!
//! Enabled by default in debug builds and switchable in any build through the
//! `CHRO_DEV_EVENTS` environment variable.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info};

/// Environment override for the sink. Truthy values force it on in release
/// builds; falsy values turn it off in debug builds.
const ENV_ENABLE: &str = "CHRO_DEV_EVENTS";

const CHANNEL_CAPACITY: usize = 8192;
const BATCH_SIZE: usize = 128;
const FLUSH_INTERVAL_MS: u64 = 500;

/// Maximum lines per file before rotating to a new segment.
const MAX_LINES_PER_FILE: u64 = 200_000;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static WRITER_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();
static SESSION_ID: OnceLock<String> = OnceLock::new();

/// Which side of the app produced an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Emitted by the server process.
    Backend,
    /// Reported by the renderer through the dev-events ingest endpoint.
    Frontend,
}

impl Source {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Backend => "backend",
            Source::Frontend => "frontend",
        }
    }
}

/// One recorded activity. `ts` and `session` are filled in by the sink when
/// absent, which is the normal case for backend events; the renderer supplies
/// its own so batched events keep the time and page they happened on.
#[derive(Debug, Clone)]
pub struct DevEvent {
    pub source: Source,
    pub event: String,
    pub props: Value,
    pub ts: Option<String>,
    pub session: Option<String>,
}

impl DevEvent {
    #[must_use]
    pub fn backend(event: impl Into<String>, props: Value) -> Self {
        Self {
            source: Source::Backend,
            event: event.into(),
            props,
            ts: None,
            session: None,
        }
    }
}

/// Configuration for the local sink.
pub struct Config {
    /// Directory that daily `YYYY-MM-DD.jsonl` segments are written to.
    pub dir: PathBuf,
    pub enabled: bool,
}

/// Interpret an environment toggle. Unrecognised values are ignored so a typo
/// falls back to the build default rather than silently disabling recording.
fn parse_toggle(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Whether the sink should run: `CHRO_DEV_EVENTS` when set, otherwise on in
/// debug builds and off in release builds.
#[must_use]
pub fn should_enable() -> bool {
    std::env::var(ENV_ENABLE)
        .ok()
        .as_deref()
        .and_then(parse_toggle)
        .unwrap_or(cfg!(debug_assertions))
}

/// Start the sink. Subsequent calls are ignored.
pub fn init(config: Config) {
    if !config.enabled {
        return;
    }

    let (tx, rx) = mpsc::channel::<String>(CHANNEL_CAPACITY);
    if WRITER_TX.set(tx).is_err() {
        return;
    }
    let _ = SESSION_ID.set(uuid::Uuid::new_v4().to_string());

    let dir = config.dir.clone();
    tokio::spawn(async move {
        writer_loop(dir, rx).await;
    });

    ACTIVE.store(true, Ordering::Relaxed);
    info!(dir = %config.dir.display(), "dev event sink recording locally");
}

#[must_use]
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Identifier for this server process, used to group events by app run.
fn process_session() -> String {
    SESSION_ID
        .get()
        .cloned()
        .unwrap_or_else(|| "unknown".to_string())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Serialize one event as a single JSONL line.
///
/// `serde_json` escapes control characters, so no field -- including anything
/// supplied by the renderer -- can break the one-event-per-line invariant.
fn encode(event: &DevEvent) -> String {
    json!({
        "ts": event.ts.clone().unwrap_or_else(now_rfc3339),
        "source": event.source.as_str(),
        "session": event.session.clone().unwrap_or_else(process_session),
        "event": event.event,
        "props": event.props,
    })
    .to_string()
}

fn send_line(line: String) {
    if let Some(tx) = WRITER_TX.get() {
        if tx.try_send(line).is_err() {
            debug!("dev events: writer channel full, dropping entry");
        }
    }
}

/// Record one event. No-op when the sink is inactive.
pub fn record(event: DevEvent) {
    if !is_active() {
        return;
    }
    send_line(encode(&event));
}

/// Record a batch of events, e.g. one flush from the renderer.
pub fn record_all(events: impl IntoIterator<Item = DevEvent>) {
    if !is_active() {
        return;
    }
    for event in events {
        send_line(encode(&event));
    }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Name of the segment file for a given day and rotation index.
fn segment_name(date: &str, segment: u32) -> String {
    if segment == 0 {
        format!("{date}.jsonl")
    } else {
        format!("{date}.{segment}.jsonl")
    }
}

async fn writer_loop(dir: PathBuf, mut rx: mpsc::Receiver<String>) {
    use tokio::time::{interval, Duration};

    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("dev events: cannot create {}: {e}", dir.display());
        return;
    }

    let mut current_date = String::new();
    let mut current_segment: u32 = 0;
    let mut lines_written: u64 = 0;
    let mut file: Option<tokio::fs::File> = None;
    let mut batch: Vec<String> = Vec::with_capacity(BATCH_SIZE);
    let mut tick = interval(Duration::from_millis(FLUSH_INTERVAL_MS));

    loop {
        tokio::select! {
            maybe_line = rx.recv() => {
                match maybe_line {
                    Some(line) => {
                        batch.push(line);
                        while batch.len() < BATCH_SIZE {
                            match rx.try_recv() {
                                Ok(line) => batch.push(line),
                                Err(_) => break,
                            }
                        }
                    }
                    None => {
                        // Channel closed: flush what is left and stop.
                        if let Some(ref mut f) = file {
                            let _ = write_batch(f, &batch).await;
                        } else if !batch.is_empty() {
                            let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
                            if let Ok(mut f) = open_segment(&dir, &segment_name(&date, 0)).await {
                                let _ = write_batch(&mut f, &batch).await;
                            }
                        }
                        return;
                    }
                }
            }
            _ = tick.tick() => {}
        }

        if batch.is_empty() {
            continue;
        }

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let need_rotate =
            file.is_none() || today != current_date || lines_written >= MAX_LINES_PER_FILE;

        if need_rotate {
            if today == current_date {
                current_segment += 1;
            } else {
                current_date.clone_from(&today);
                current_segment = 0;
            }
            lines_written = 0;

            match open_segment(&dir, &segment_name(&today, current_segment)).await {
                Ok(f) => file = Some(f),
                Err(e) => {
                    tracing::warn!("dev events: cannot open log file: {e}");
                    batch.clear();
                    continue;
                }
            }
        }

        if let Some(ref mut f) = file {
            let count = batch.len() as u64;
            if let Err(e) = write_batch(f, &batch).await {
                tracing::warn!("dev events: write failed: {e}");
            } else {
                lines_written += count;
            }
        }

        batch.clear();
    }
}

async fn open_segment(dir: &Path, name: &str) -> Result<tokio::fs::File, std::io::Error> {
    tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
        .await
}

async fn write_batch(file: &mut tokio::fs::File, batch: &[String]) -> Result<(), std::io::Error> {
    use tokio::io::AsyncWriteExt;

    if batch.is_empty() {
        return Ok(());
    }
    let mut buf = String::with_capacity(batch.iter().map(|l| l.len() + 1).sum());
    for line in batch {
        buf.push_str(line);
        buf.push('\n');
    }
    file.write_all(buf.as_bytes()).await?;
    file.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_environment_toggles() {
        assert_eq!(parse_toggle("1"), Some(true));
        assert_eq!(parse_toggle("TRUE"), Some(true));
        assert_eq!(parse_toggle(" on "), Some(true));
        assert_eq!(parse_toggle("0"), Some(false));
        assert_eq!(parse_toggle("off"), Some(false));
        assert_eq!(parse_toggle(""), None);
        assert_eq!(parse_toggle("maybe"), None);
    }

    #[test]
    fn encodes_one_line_per_event() {
        let line = encode(&DevEvent {
            source: Source::Frontend,
            event: "ui.click".to_string(),
            props: json!({ "text": "line one\nline two" }),
            ts: Some("2026-08-14T00:00:00.000Z".to_string()),
            session: Some("page-1".to_string()),
        });

        assert!(!line.contains('\n'), "line must stay single-line: {line}");
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["ts"], "2026-08-14T00:00:00.000Z");
        assert_eq!(parsed["source"], "frontend");
        assert_eq!(parsed["session"], "page-1");
        assert_eq!(parsed["event"], "ui.click");
        assert_eq!(parsed["props"]["text"], "line one\nline two");
    }

    #[test]
    fn fills_in_timestamp_and_session_when_absent() {
        let line = encode(&DevEvent::backend("rpc", json!({ "status": 200 })));
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert!(parsed["ts"].as_str().unwrap().ends_with('Z'));
        assert!(!parsed["session"].as_str().unwrap().is_empty());
        assert_eq!(parsed["source"], "backend");
    }

    #[test]
    fn names_segments_by_day_then_index() {
        assert_eq!(segment_name("2026-08-14", 0), "2026-08-14.jsonl");
        assert_eq!(segment_name("2026-08-14", 3), "2026-08-14.3.jsonl");
    }

    #[tokio::test]
    async fn writer_appends_every_line_to_the_daily_segment() {
        let dir = std::env::temp_dir().join(format!("chro-dev-events-{}", uuid::Uuid::new_v4()));
        let (tx, rx) = mpsc::channel::<String>(16);
        let writer = tokio::spawn(writer_loop(dir.clone(), rx));

        tx.send(r#"{"event":"a"}"#.to_string()).await.unwrap();
        tx.send(r#"{"event":"b"}"#.to_string()).await.unwrap();
        drop(tx);
        writer.await.unwrap();

        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let contents = std::fs::read_to_string(dir.join(segment_name(&date, 0))).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines, vec![r#"{"event":"a"}"#, r#"{"event":"b"}"#]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn record_is_a_noop_while_inactive() {
        // The global sink is never initialized in unit tests, so recording
        // must not panic or block.
        record(DevEvent::backend("noop", json!({})));
        assert!(!is_active());
    }
}
