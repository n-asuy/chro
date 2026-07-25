//! Agent usage meters: rolling-window token usage per agent CLI, aggregated
//! from each CLI's own local session logs.
//!
//! Every supported CLI already writes a JSONL transcript carrying per-turn token
//! counts, so usage is derived entirely from local files: no credentials, no
//! network, nothing to rate-limit. (An earlier revision queried the provider's
//! OAuth usage endpoint for remaining-quota percentages; that endpoint shares a
//! per-account quota with every CLI session's startup token refresh, so a
//! cosmetic meter competing for it could starve real task runs. Reading the logs
//! the CLIs already produce avoids that class of problem entirely.)
//!
//! Scanning is incremental: each file's consumed byte offset and the samples
//! inside the window are retained, so only newly appended bytes are parsed on
//! subsequent refreshes. Without this the Claude logs alone would re-read
//! hundreds of megabytes every minute.
//!
//! What the logs support differs by CLI, and the meter reports only the common
//! denominator (tokens consumed in the window, plus cost where the CLI records
//! it) rather than mixing differently-defined numbers into one bar.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{ApiError, AppState};

/// Rolling window the meter reports over. Matches the 5-hour block the
/// providers themselves bill sessions against.
const WINDOW_MINUTES: u32 = 300;
const WINDOW: Duration = Duration::from_secs(WINDOW_MINUTES as u64 * 60);
/// Re-scan at most this often; menu opens in between reuse the snapshot.
const USAGE_TTL: Duration = Duration::from_secs(60);
/// Guard against pathological directory trees while still covering the deepest
/// real layout (`sessions/YYYY/MM/DD/rollout-*.jsonl`).
const MAX_SCAN_DEPTH: usize = 8;

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/agent-usage", get(get_agent_usage))
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum UsageStatus {
    /// Logs were found and scanned (a zero total is a valid `ok` result).
    Ok,
    /// This CLI keeps no local logs here — nothing to report.
    Unavailable,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
struct TokenTotals {
    /// Fresh (non-cached) prompt tokens.
    input: u64,
    output: u64,
    /// Prompt tokens served from cache.
    cache_read: u64,
    /// Prompt tokens written into the cache.
    cache_creation: u64,
    total: u64,
}

impl TokenTotals {
    fn add(&mut self, sample: &Sample) {
        self.input += sample.input;
        self.output += sample.output;
        self.cache_read += sample.cache_read;
        self.cache_creation += sample.cache_creation;
        self.total += sample.input + sample.output + sample.cache_read + sample.cache_creation;
    }
}

#[derive(Debug, Clone, Serialize)]
struct ProviderUsage {
    /// Agent CLI name, matching the `cli-status` manifest name.
    provider: String,
    status: UsageStatus,
    window_minutes: u32,
    tokens: TokenTotals,
    /// Spend over the window, only for CLIs that record cost themselves. Left
    /// absent rather than estimated from a bundled price table, which would go
    /// stale silently.
    cost_usd: Option<f64>,
    /// Distinct session files that contributed to the window.
    session_count: u32,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
struct AgentUsageResponse {
    providers: Vec<ProviderUsage>,
}

async fn get_agent_usage(
    State(state): State<AppState>,
) -> Result<Json<AgentUsageResponse>, ApiError> {
    Ok(Json(state.usage_cache().get_or_scan().await))
}

// ---------------------------------------------------------------------------
// Per-line parsing
// ---------------------------------------------------------------------------

/// One turn's token usage, already normalized across the CLIs' differing shapes.
#[derive(Debug, Clone, Default)]
struct Sample {
    ts_ms: i64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    cost_usd: Option<f64>,
    /// Stable per-turn identity used to drop copies of the same turn that
    /// appear in more than one session file (resume/fork replays the prior
    /// transcript). `None` means the CLI exposes no such id, so the sample is
    /// always counted.
    dedup_key: Option<String>,
}

fn field_u64(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

fn field_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_iso_to_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn entry_timestamp_ms(value: &serde_json::Value) -> Option<i64> {
    value
        .get("timestamp")
        .and_then(serde_json::Value::as_str)
        .and_then(parse_iso_to_ms)
}

/// `{"timestamp":…,"requestId":…,"message":{"id":…,"usage":{"input_tokens":…,
/// "output_tokens":…,"cache_read_input_tokens":…,"cache_creation_input_tokens":…}}}`
/// The four counts are disjoint, so they sum directly. Resume/fork copies the
/// prior transcript into new session files (measured ~47% of in-window entries
/// are such copies), so the assistant `message.id` + `requestId` pair is carried
/// as the dedup key — the same identity ccusage keys on.
fn parse_claude_line(value: &serde_json::Value) -> Option<Sample> {
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let dedup_key = match (field_str(message, "id"), field_str(value, "requestId")) {
        (Some(id), Some(request)) => Some(format!("{id}:{request}")),
        // Without both halves we cannot safely identify a copy, so count it.
        _ => None,
    };
    Some(Sample {
        ts_ms: entry_timestamp_ms(value)?,
        input: field_u64(usage, "input_tokens"),
        output: field_u64(usage, "output_tokens"),
        cache_read: field_u64(usage, "cache_read_input_tokens"),
        cache_creation: field_u64(usage, "cache_creation_input_tokens"),
        cost_usd: None,
        dedup_key,
    })
}

/// `{"timestamp":…,"type":"event_msg","payload":{"type":"token_count",
/// "info":{"last_token_usage":{…}}}}`
/// `last_token_usage` is this turn's delta (`total_token_usage` is cumulative
/// and would double-count), and its `cached_input_tokens` is a *subset* of
/// `input_tokens`, so the cached part is subtracted out to keep the buckets
/// disjoint like the other CLIs.
fn parse_codex_line(value: &serde_json::Value) -> Option<Sample> {
    if value.get("type").and_then(serde_json::Value::as_str)? != "event_msg" {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(serde_json::Value::as_str)? != "token_count" {
        return None;
    }
    let usage = payload.get("info")?.get("last_token_usage")?;
    let cached = field_u64(usage, "cached_input_tokens");
    Some(Sample {
        ts_ms: entry_timestamp_ms(value)?,
        input: field_u64(usage, "input_tokens").saturating_sub(cached),
        output: field_u64(usage, "output_tokens"),
        cache_read: cached,
        cache_creation: 0,
        cost_usd: None,
        // `token_count` events carry no message/request id, so there is no key
        // to dedup on. Each rollout file is an independent session, so this only
        // risks over-counting if a fork replays telemetry — revisit if seen.
        dedup_key: None,
    })
}

/// `{"timestamp":…,"message":{"usage":{"input":…,"output":…,"cacheRead":…,
/// "cacheWrite":…,"cost":{"total":…}}}}`
/// This CLI computes spend itself, so the cost is reported rather than derived.
fn parse_pi_line(value: &serde_json::Value) -> Option<Sample> {
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    Some(Sample {
        ts_ms: entry_timestamp_ms(value)?,
        input: field_u64(usage, "input"),
        output: field_u64(usage, "output"),
        cache_read: field_u64(usage, "cacheRead"),
        cache_creation: field_u64(usage, "cacheWrite"),
        cost_usd: usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(serde_json::Value::as_f64),
        // The provider's generation id is stable across a resume's replay.
        dedup_key: field_str(message, "responseId"),
    })
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

/// A cheap substring every usage-bearing line contains, used to skip JSON
/// parsing for the overwhelming majority of transcript lines.
struct ProviderSpec {
    name: &'static str,
    prefilter: &'static str,
    parse: fn(&serde_json::Value) -> Option<Sample>,
}

const PROVIDER_SPECS: [ProviderSpec; 3] = [
    ProviderSpec {
        name: "claude",
        prefilter: "\"usage\"",
        parse: parse_claude_line,
    },
    ProviderSpec {
        name: "codex",
        prefilter: "token_count",
        parse: parse_codex_line,
    },
    ProviderSpec {
        name: "pi",
        prefilter: "\"usage\"",
        parse: parse_pi_line,
    },
];

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

/// Session-log root for a CLI, honoring the same home overrides the CLIs use.
fn provider_log_root(name: &str) -> Option<PathBuf> {
    match name {
        "claude" => std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .or_else(|| home_dir().map(|h| h.join(".claude")))
            .map(|dir| dir.join("projects")),
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .or_else(|| home_dir().map(|h| h.join(".codex")))
            .map(|dir| dir.join("sessions")),
        "pi" => home_dir().map(|h| h.join(".pi").join("agent").join("sessions")),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Incremental scanning
// ---------------------------------------------------------------------------

/// Per-file scan position plus the samples it contributed that are still inside
/// the window. Retaining samples (rather than a running total) is what lets the
/// rolling window expire old turns without re-reading the file.
#[derive(Default)]
struct FileCursor {
    offset: u64,
    samples: Vec<Sample>,
}

#[derive(Default)]
struct ProviderScanState {
    cursors: HashMap<PathBuf, FileCursor>,
}

/// Collect `*.jsonl` files under `root` touched at or after `cutoff`. A file
/// last written before the window opened cannot hold an in-window entry.
fn collect_recent_logs(root: &Path, cutoff: SystemTime, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_recent_logs(&path, cutoff, depth + 1, out);
        } else if path.extension().is_some_and(|ext| ext == "jsonl")
            && metadata.modified().is_ok_and(|m| m >= cutoff)
        {
            out.push(path);
        }
    }
}

/// Read the bytes appended since the last scan and parse any usage samples.
/// Returns the number of bytes consumed, which always stops at a line boundary
/// so a half-written trailing line is re-read (not dropped) next time.
fn ingest_new_bytes(path: &Path, spec: &ProviderSpec, cursor: &mut FileCursor) {
    let Ok(mut file) = File::open(path) else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    let size = metadata.len();
    if size < cursor.offset {
        // Truncated or rotated in place: start over rather than read garbage.
        *cursor = FileCursor::default();
    }
    if size == cursor.offset {
        return;
    }
    if file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return;
    }

    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return;
    }
    let Some(last_newline) = buf.iter().rposition(|b| *b == b'\n') else {
        // No complete line yet; leave the offset so it is retried once finished.
        return;
    };
    let complete = &buf[..=last_newline];
    cursor.offset += complete.len() as u64;

    for line in complete.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            continue;
        };
        if !text.contains(spec.prefilter) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        if let Some(sample) = (spec.parse)(&value) {
            cursor.samples.push(sample);
        }
    }
}

/// Scan one provider's logs and total the samples inside the window. Blocking
/// file IO — callers must keep this off the async runtime's worker threads.
fn scan_provider(spec: &ProviderSpec, state: &mut ProviderScanState, now_ms: i64) -> ProviderUsage {
    let cutoff_ms = now_ms - WINDOW.as_millis() as i64;
    let cutoff_time = SystemTime::now() - WINDOW;

    let Some(root) = provider_log_root(spec.name).filter(|root| root.is_dir()) else {
        return ProviderUsage {
            provider: spec.name.to_string(),
            status: UsageStatus::Unavailable,
            window_minutes: WINDOW_MINUTES,
            tokens: TokenTotals::default(),
            cost_usd: None,
            session_count: 0,
            updated_at_ms: now_ms,
        };
    };

    let mut recent = Vec::new();
    collect_recent_logs(&root, cutoff_time, 0, &mut recent);

    // Files that fell out of the window take their samples with them.
    state.cursors.retain(|path, _| recent.contains(path));

    let mut tokens = TokenTotals::default();
    let mut cost = 0.0_f64;
    let mut has_cost = false;
    let mut sessions = 0_u32;
    // Global across this provider's files: the same turn copied into several
    // session files (resume/fork) must be counted once. Rebuilt each scan from
    // the retained in-window samples, so it stays consistent with the window.
    let mut seen_keys = std::collections::HashSet::new();

    for path in recent {
        let cursor = state.cursors.entry(path.clone()).or_default();
        ingest_new_bytes(&path, spec, cursor);
        cursor.samples.retain(|sample| sample.ts_ms >= cutoff_ms);

        let mut contributed = false;
        for sample in &cursor.samples {
            if let Some(key) = &sample.dedup_key {
                if !seen_keys.insert(key.clone()) {
                    continue;
                }
            }
            contributed = true;
            tokens.add(sample);
            if let Some(value) = sample.cost_usd {
                cost += value;
                has_cost = true;
            }
        }
        if contributed {
            sessions += 1;
        }
    }

    ProviderUsage {
        provider: spec.name.to_string(),
        status: UsageStatus::Ok,
        window_minutes: WINDOW_MINUTES,
        tokens,
        cost_usd: has_cost.then_some(cost),
        session_count: sessions,
        updated_at_ms: now_ms,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// Shared on `AppState`: the last snapshot plus the incremental scan cursors, so
/// the expensive first pass happens once per server lifetime.
#[derive(Default)]
pub struct UsageCache {
    snapshot: Mutex<Option<CachedUsage>>,
    scan_state: Mutex<HashMap<&'static str, ProviderScanState>>,
}

struct CachedUsage {
    response: AgentUsageResponse,
    scanned_at: Instant,
}

impl UsageCache {
    pub fn new() -> Self {
        Self::default()
    }

    async fn get_or_scan(&self) -> AgentUsageResponse {
        {
            let guard = self.snapshot.lock().await;
            if let Some(cached) = guard.as_ref() {
                if cached.scanned_at.elapsed() < USAGE_TTL {
                    return cached.response.clone();
                }
            }
        }

        // Hold the scan lock across the blocking pass so concurrent menu opens
        // queue behind one scan instead of each starting their own.
        let mut states = self.scan_state.lock().await;
        let mut owned = std::mem::take(&mut *states);
        let (owned, response) = tokio::task::spawn_blocking(move || {
            let now = now_ms();
            let providers = PROVIDER_SPECS
                .iter()
                .map(|spec| {
                    let state = owned.entry(spec.name).or_default();
                    scan_provider(spec, state, now)
                })
                .collect();
            (owned, AgentUsageResponse { providers })
        })
        .await
        .unwrap_or_else(|_| {
            (
                HashMap::new(),
                AgentUsageResponse {
                    providers: Vec::new(),
                },
            )
        });
        *states = owned;
        drop(states);

        let mut guard = self.snapshot.lock().await;
        *guard = Some(CachedUsage {
            response: response.clone(),
            scanned_at: Instant::now(),
        });
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).expect("valid json")
    }

    #[test]
    fn parses_claude_usage_line() {
        let sample = parse_claude_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z","message":{"usage":{
                "input_tokens":2,"output_tokens":850,
                "cache_read_input_tokens":15394,"cache_creation_input_tokens":29970}}}"#,
        ))
        .expect("sample");
        assert_eq!(sample.input, 2);
        assert_eq!(sample.output, 850);
        assert_eq!(sample.cache_read, 15394);
        assert_eq!(sample.cache_creation, 29970);
        assert_eq!(sample.cost_usd, None);
    }

    #[test]
    fn claude_line_without_usage_is_skipped() {
        assert!(parse_claude_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z","message":{"role":"user"}}"#
        ))
        .is_none());
        // A usage payload with no timestamp cannot be placed in the window.
        assert!(parse_claude_line(&json(r#"{"message":{"usage":{"input_tokens":5}}}"#)).is_none());
    }

    #[test]
    fn codex_subtracts_cached_tokens_from_input() {
        let sample = parse_codex_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z","type":"event_msg","payload":{
                "type":"token_count","info":{"last_token_usage":{
                "input_tokens":18975,"cached_input_tokens":9984,
                "output_tokens":221,"reasoning_output_tokens":92}}}}"#,
        ))
        .expect("sample");
        // Cached tokens are a subset of input and must not be counted twice.
        assert_eq!(sample.input, 18975 - 9984);
        assert_eq!(sample.cache_read, 9984);
        // Reasoning tokens are already inside output_tokens.
        assert_eq!(sample.output, 221);
    }

    #[test]
    fn codex_ignores_non_token_count_events() {
        assert!(parse_codex_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z","type":"event_msg",
                "payload":{"type":"agent_message"}}"#
        ))
        .is_none());
        assert!(parse_codex_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z","type":"response_item"}"#
        ))
        .is_none());
    }

    #[test]
    fn parses_pi_usage_and_cost() {
        let sample = parse_pi_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z","message":{"usage":{
                "input":6030,"output":11,"cacheRead":0,"cacheWrite":0,
                "cost":{"total":0.012148}}}}"#,
        ))
        .expect("sample");
        assert_eq!(sample.input, 6030);
        assert_eq!(sample.output, 11);
        assert_eq!(sample.cost_usd, Some(0.012148));
    }

    #[test]
    fn totals_sum_disjoint_buckets() {
        let mut totals = TokenTotals::default();
        totals.add(&Sample {
            ts_ms: 0,
            input: 1,
            output: 2,
            cache_read: 4,
            cache_creation: 8,
            cost_usd: None,
            dedup_key: None,
        });
        assert_eq!(totals.total, 15);
    }

    #[test]
    fn claude_line_carries_dedup_key() {
        let sample = parse_claude_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z","requestId":"req_1",
                "message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":1,
                "cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
        ))
        .expect("sample");
        assert_eq!(sample.dedup_key.as_deref(), Some("msg_1:req_1"));
    }

    #[test]
    fn claude_line_without_both_id_halves_is_not_deduped() {
        // Missing requestId → no key → the entry is always counted (never
        // silently dropped as a false duplicate).
        let sample = parse_claude_line(&json(
            r#"{"timestamp":"2026-07-19T07:00:00.000Z",
                "message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":1,
                "cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
        ))
        .expect("sample");
        assert_eq!(sample.dedup_key, None);
    }

    /// The incremental cursor is the load-bearing optimization: a second pass
    /// over an appended file must read only the new bytes and must not
    /// double-count what it already ingested.
    #[test]
    fn ingest_is_incremental_and_line_safe() {
        let dir = std::env::temp_dir().join(format!("chro-usage-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("session.jsonl");
        let line = |output: u64| {
            format!(
                r#"{{"timestamp":"2026-07-19T07:00:00.000Z","message":{{"usage":{{"input_tokens":1,"output_tokens":{output},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
            )
        };

        let mut file = File::create(&path).expect("create");
        writeln!(file, "{}", line(10)).expect("write");
        file.flush().expect("flush");

        let spec = &PROVIDER_SPECS[0];
        let mut cursor = FileCursor::default();
        ingest_new_bytes(&path, spec, &mut cursor);
        assert_eq!(cursor.samples.len(), 1);
        let after_first = cursor.offset;

        // Re-scanning an unchanged file adds nothing.
        ingest_new_bytes(&path, spec, &mut cursor);
        assert_eq!(cursor.samples.len(), 1);
        assert_eq!(cursor.offset, after_first);

        // A half-written trailing line is not consumed until it is complete.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append");
        write!(file, "{}", &line(20)[..20]).expect("partial write");
        file.flush().expect("flush");
        ingest_new_bytes(&path, spec, &mut cursor);
        assert_eq!(cursor.samples.len(), 1);
        assert_eq!(cursor.offset, after_first);

        // Once the line is terminated it is picked up exactly once.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append");
        writeln!(file, "{}", &line(20)[20..]).expect("finish write");
        file.flush().expect("flush");
        ingest_new_bytes(&path, spec, &mut cursor);
        assert_eq!(cursor.samples.len(), 2);
        assert_eq!(cursor.samples[1].output, 20);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The dedup path, at the aggregation level: the same (id, requestId) turn
    /// appearing in two files is counted once, an id-less turn is always counted.
    #[test]
    fn aggregation_dedups_repeated_turns() {
        let spec = &PROVIDER_SPECS[0];
        let claude_sample = |id: Option<&str>, req: Option<&str>, out: u64| {
            let mut cursor = FileCursor::default();
            let text = match (id, req) {
                (Some(i), Some(r)) => format!(
                    r#"{{"timestamp":"2026-07-19T07:00:00.000Z","requestId":"{r}","message":{{"id":"{i}","usage":{{"input_tokens":1,"output_tokens":{out},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
                ),
                _ => format!(
                    r#"{{"timestamp":"2026-07-19T07:00:00.000Z","message":{{"usage":{{"input_tokens":1,"output_tokens":{out},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
                ),
            };
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            cursor.samples.push((spec.parse)(&value).unwrap());
            cursor
        };

        let mut seen = std::collections::HashSet::new();
        let mut totals = TokenTotals::default();
        // Same turn in "two files".
        for cursor in [
            claude_sample(Some("m1"), Some("r1"), 10),
            claude_sample(Some("m1"), Some("r1"), 10),
            // Distinct turn.
            claude_sample(Some("m2"), Some("r2"), 20),
            // No id: always counts even if identical to another id-less turn.
            claude_sample(None, None, 5),
            claude_sample(None, None, 5),
        ] {
            for sample in &cursor.samples {
                if let Some(key) = &sample.dedup_key {
                    if !seen.insert(key.clone()) {
                        continue;
                    }
                }
                totals.add(sample);
            }
        }
        // output = 10 (m1, once) + 20 (m2) + 5 + 5 (both id-less) = 40
        assert_eq!(totals.output, 40);
    }
}
