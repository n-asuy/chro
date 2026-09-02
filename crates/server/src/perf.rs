use axum::{extract::Request, http::HeaderMap, middleware::Next, response::Response};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::Instant,
};
use tokio::sync::mpsc;

const PERF_REQUEST_ID_HEADER: &str = "x-perf-request-id";
const CHANNEL_CAPACITY: usize = 4096;
const BATCH_SIZE: usize = 64;

/// Individual rpc entries are only recorded when latency exceeds this threshold.
const RPC_SLOW_THRESHOLD_MS: f64 = 200.0;

/// Aggregated summaries are flushed at this interval.
const RPC_AGGREGATE_INTERVAL_SECS: u64 = 30;

/// Maximum lines per log file before rotating to a new segment.
const MAX_LINES_PER_FILE: u64 = 50_000;

static PERF_ENABLED: AtomicBool = AtomicBool::new(false);
static WRITER_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();
static RPC_AGGREGATOR: OnceLock<Mutex<RpcAggregator>> = OnceLock::new();

// ---------------------------------------------------------------------------
// RPC aggregation
// ---------------------------------------------------------------------------

struct LatencyStats {
    count: u64,
    sum: f64,
    min: f64,
    max: f64,
    /// Sorted insert is too expensive; collect all values and compute percentiles at flush.
    values: Vec<f64>,
}

impl LatencyStats {
    fn new() -> Self {
        Self {
            count: 0,
            sum: 0.0,
            min: f64::MAX,
            max: f64::MIN,
            values: Vec::new(),
        }
    }

    fn record(&mut self, duration_ms: f64) {
        self.count += 1;
        self.sum += duration_ms;
        if duration_ms < self.min {
            self.min = duration_ms;
        }
        if duration_ms > self.max {
            self.max = duration_ms;
        }
        self.values.push(duration_ms);
    }

    fn p95(&mut self) -> f64 {
        if self.values.is_empty() {
            return 0.0;
        }
        self.values
            .sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx = self.values.len() * 95 / 100;
        let idx = idx.min(self.values.len() - 1);
        round_duration_ms(self.values[idx])
    }
}

struct RpcAggregator {
    /// key: "METHOD /path/pattern"
    buckets: HashMap<String, LatencyStats>,
}

impl RpcAggregator {
    fn new() -> Self {
        Self {
            buckets: HashMap::new(),
        }
    }

    fn record(&mut self, method: &str, path_pattern: &str, duration_ms: f64) {
        let key = format!("{method} {path_pattern}");
        self.buckets
            .entry(key)
            .or_insert_with(LatencyStats::new)
            .record(duration_ms);
    }

    fn drain(&mut self) -> HashMap<String, LatencyStats> {
        std::mem::take(&mut self.buckets)
    }
}

/// Normalize UUID segments in a path to `{id}` for aggregation grouping.
///
/// e.g. `/rpc/projects/042ebded-656a-4bdf-b451-4b266f57b604/file` → `/rpc/projects/{id}/file`
pub(crate) fn normalize_path(path: &str) -> String {
    path.split('/')
        .map(|seg| if is_uuid_like(seg) { "{id}" } else { seg })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_uuid_like(s: &str) -> bool {
    // UUID v4: 8-4-4-4-12 hex chars with dashes = 36 chars
    if s.len() != 36 {
        return false;
    }
    let bytes = s.as_bytes();
    bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, &b)| matches!(i, 8 | 13 | 18 | 23) || b.is_ascii_hexdigit())
}

fn flush_aggregated_summaries() {
    let Some(aggregator) = RPC_AGGREGATOR.get() else {
        return;
    };
    let buckets = {
        let Ok(mut guard) = aggregator.lock() else {
            return;
        };
        guard.drain()
    };

    if buckets.is_empty() {
        return;
    }

    let ts = timestamp();
    for (key, mut stats) in buckets {
        let p95 = stats.p95();
        #[allow(clippy::cast_precision_loss)]
        let avg = round_duration_ms(stats.sum / (stats.count as f64));
        let line = serde_json::json!({
            "ts": ts,
            "type": "rpc_summary",
            "endpoint": key,
            "count": stats.count,
            "avg_ms": avg,
            "min_ms": round_duration_ms(stats.min),
            "p95_ms": p95,
            "max_ms": round_duration_ms(stats.max),
        })
        .to_string();
        send_line(line);
    }
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

fn log_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("CHRO_PERF_DIR") {
        let configured = PathBuf::from(path);
        if configured.is_absolute() {
            return configured;
        }
        return std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(configured);
    }

    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    dir.push("log");
    dir.push("performance");
    dir
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn round_duration_ms(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub(crate) fn set_perf_enabled(enabled: bool) {
    PERF_ENABLED.store(enabled, Ordering::Relaxed);
}

fn perf_enabled() -> bool {
    PERF_ENABLED.load(Ordering::Relaxed)
}

pub(crate) fn request_id_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(PERF_REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

pub(crate) fn elapsed_ms(start: Instant) -> f64 {
    round_duration_ms(start.elapsed().as_secs_f64() * 1000.0)
}

fn send_line(line: String) {
    if let Some(tx) = WRITER_TX.get() {
        if tx.try_send(line).is_err() {
            tracing::debug!("perf: writer channel full, dropping entry");
        }
    }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Spawn the dedicated writer task. Call once at startup when `--perf` is enabled.
pub(crate) fn init_writer() -> tokio::task::JoinHandle<()> {
    let (tx, rx) = mpsc::channel::<String>(CHANNEL_CAPACITY);
    // Share the sender with runtime::perf so crates like local-runtime can
    // emit backend perf events without depending on the server crate.
    runtime::perf::register_sender(tx.clone());
    WRITER_TX.set(tx).expect("perf writer already initialized");

    assert!(
        RPC_AGGREGATOR.set(Mutex::new(RpcAggregator::new())).is_ok(),
        "rpc aggregator already initialized"
    );

    tokio::spawn(async move {
        let writer = tokio::spawn(writer_loop(rx));
        let aggregator = tokio::spawn(aggregator_loop());
        let _ = tokio::join!(writer, aggregator);
    })
}

async fn aggregator_loop() {
    use tokio::time::{interval, Duration};

    let mut tick = interval(Duration::from_secs(RPC_AGGREGATE_INTERVAL_SECS));
    loop {
        tick.tick().await;
        if !perf_enabled() {
            return;
        }
        flush_aggregated_summaries();
    }
}

async fn writer_loop(mut rx: mpsc::Receiver<String>) {
    use tokio::time::{interval, Duration};

    let dir = log_dir();
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::error!("perf: cannot create log dir: {e}");
        return;
    }

    let mut current_date = String::new();
    let mut current_segment: u32 = 0;
    let mut lines_written: u64 = 0;
    let mut file: Option<tokio::fs::File> = None;
    let mut batch: Vec<String> = Vec::with_capacity(BATCH_SIZE);
    let mut tick = interval(Duration::from_millis(500));

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
                        // Channel closed — flush aggregated + remaining batch and exit
                        flush_aggregated_summaries();
                        if let Some(ref mut f) = file {
                            let _ = write_batch(f, &batch).await;
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
        let need_rotate = today != current_date || lines_written >= MAX_LINES_PER_FILE;

        if need_rotate {
            if today != current_date {
                current_date.clone_from(&today);
                current_segment = 0;
            } else {
                current_segment += 1;
            }
            lines_written = 0;

            let file_name = if current_segment == 0 {
                format!("{today}_backend.jsonl")
            } else {
                format!("{today}_backend.{current_segment}.jsonl")
            };

            match tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(&file_name))
                .await
            {
                Ok(f) => {
                    file = Some(f);
                }
                Err(e) => {
                    tracing::warn!("perf: cannot open log file: {e}");
                    batch.clear();
                    continue;
                }
            }
        }

        if let Some(ref mut f) = file {
            let count = batch.len() as u64;
            if let Err(e) = write_batch(f, &batch).await {
                tracing::warn!("perf: write failed: {e}");
            } else {
                lines_written += count;
            }
        }

        batch.clear();
    }
}

async fn write_batch(file: &mut tokio::fs::File, batch: &[String]) -> Result<(), std::io::Error> {
    use tokio::io::AsyncWriteExt;

    let mut buf = String::with_capacity(batch.iter().map(|l| l.len() + 1).sum());
    for line in batch {
        buf.push_str(line);
        buf.push('\n');
    }
    file.write_all(buf.as_bytes()).await?;
    file.flush().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public recording API
// ---------------------------------------------------------------------------

pub(crate) fn record_backend_event(name: &str, fields: serde_json::Value) {
    if !perf_enabled() {
        return;
    }

    let mut payload = serde_json::Map::new();
    payload.insert("ts".to_string(), serde_json::Value::String(timestamp()));
    payload.insert(
        "type".to_string(),
        serde_json::Value::String("backend-action".to_string()),
    );
    payload.insert(
        "name".to_string(),
        serde_json::Value::String(name.to_string()),
    );

    if let serde_json::Value::Object(fields) = fields {
        for (key, value) in fields {
            payload.insert(key, value);
        }
    }

    send_line(serde_json::Value::Object(payload).to_string());
}

pub async fn latency_recorder(req: Request, next: Next) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let request_id = request_id_from_headers(req.headers());

    let start = Instant::now();
    let response = next.run(req).await;
    let duration_ms = elapsed_ms(start);

    let status = response.status().as_u16();

    if path == "/health" {
        return response;
    }

    let path_pattern = normalize_path(&path);

    // Always accumulate into the aggregator
    if let Some(aggregator) = RPC_AGGREGATOR.get() {
        if let Ok(mut guard) = aggregator.lock() {
            guard.record(&method, &path_pattern, duration_ms);
        }
    }

    // Only emit individual lines for slow requests
    if duration_ms >= RPC_SLOW_THRESHOLD_MS {
        let line = serde_json::json!({
            "ts": timestamp(),
            "type": "rpc_slow",
            "method": method,
            "path": path,
            "path_pattern": path_pattern,
            "status": status,
            "duration_ms": duration_ms,
            "request_id": request_id,
        })
        .to_string();

        send_line(line);
    }

    response
}
