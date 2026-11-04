use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use log_types::LogEntry;
use regex::Regex;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;

/// Hard cap on the bytes of raw execution output persisted per run.
///
/// We never persist the normalized `LogEntry::JsonPatch` snapshots: they are
/// reconstructed on read from the raw protocol via the executor's
/// `replay_log_entries`, and persisting every cumulative snapshot caused an
/// O(n^2) on-disk explosion (single runs reached tens of GB). What remains on
/// disk is the raw provider protocol, which is O(n) in the agent's output. This
/// cap bounds pathological runs (e.g. a command dumping hundreds of MB) so a
/// single run can never exhaust memory or freeze the UI on read.
///
/// The last quarter of the cap is a tail reserve (see [`ExecutionLogWriter`]):
/// a run's final answer arrives last, so the budget must never be spent before
/// the run ends.
pub const MAX_RUN_LOG_BYTES: u64 = 80 * 1024 * 1024;

/// Room kept below the hard cap for the truncation marker itself.
const MARKER_HEADROOM_BYTES: u64 = 1024;

/// File-based JSONL log writer for task run execution logs.
///
/// Writes log entries as newline-delimited JSON to disk. These invariants keep
/// the file bounded and safe at rest:
/// 1. `JsonPatch` entries are dropped (dead weight — reconstructed on read).
/// 2. Base64 media payloads (screenshots the agent reads) are replaced with a
///    size marker; no renderer displays them and they dominate image-heavy runs.
/// 3. Bulk `Stdout`/`Stderr` output is bounded by `max_bytes` in two stages.
///    Up to the bulk budget (three quarters) every line is kept. Past it, only
///    lines of at most `max_bytes / 1024` are kept, so oversized tool results
///    and cumulative snapshots stop while the small lines that end a run (the
///    final answer, the result record) still land. At `max_bytes` all bulk
///    output stops.
/// 4. Known secret material is redacted before it touches disk.
pub struct ExecutionLogWriter {
    file: tokio::fs::File,
    max_bytes: u64,
    bytes_written: u64,
    eliding: bool,
    truncated: bool,
}

impl ExecutionLogWriter {
    pub async fn new(logs_dir: &Path, task_run_id: Uuid) -> std::io::Result<Self> {
        Self::with_limit(logs_dir, task_run_id, MAX_RUN_LOG_BYTES).await
    }

    /// Construct a writer with an explicit byte cap (used by tests).
    pub async fn with_limit(
        logs_dir: &Path,
        task_run_id: Uuid,
        max_bytes: u64,
    ) -> std::io::Result<Self> {
        let dir = logs_dir.join("runs");
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join(format!("{}.jsonl", task_run_id));
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        // Seed the byte budget from any pre-existing content so the cap holds
        // across re-opens (a non-active follow-up append creates a fresh writer
        // against the same file).
        let bytes_written = file.metadata().await.map(|m| m.len()).unwrap_or(0);
        let mut writer = Self {
            file,
            max_bytes,
            bytes_written,
            eliding: false,
            truncated: false,
        };
        writer.eliding = bytes_written >= writer.bulk_budget();
        writer.truncated = bytes_written >= writer.hard_limit();
        Ok(writer)
    }

    fn bulk_budget(&self) -> u64 {
        self.max_bytes - self.max_bytes / 4
    }

    fn tail_line_max(&self) -> u64 {
        self.max_bytes / 1024
    }

    fn hard_limit(&self) -> u64 {
        self.max_bytes.saturating_sub(MARKER_HEADROOM_BYTES)
    }

    pub async fn append_entry(&mut self, entry: &LogEntry) -> std::io::Result<()> {
        // Never persist normalized JSON-Patch snapshots. They are pure dead
        // weight on disk (replay reconstructs them from raw `Stdout`) and are
        // the source of the O(n^2) log explosion.
        if matches!(entry, LogEntry::JsonPatch(_)) {
            return Ok(());
        }

        // Only `Stdout`/`Stderr` are unbounded; control/metadata entries
        // (`SessionId`, `UserPrompt`, `Finished`, ...) are tiny and always pass
        // so session tracking and finalization keep working past the cap.
        let is_bulk = matches!(entry, LogEntry::Stdout(_) | LogEntry::Stderr(_));
        if self.truncated && is_bulk {
            return Ok(());
        }

        let line = serialize_entry(entry)?;
        let len = line.len() as u64;

        if is_bulk && self.bytes_written + len > self.hard_limit() {
            self.truncated = true;
            let marker = LogEntry::Stderr(format!(
                "[chro] execution log truncated: exceeded {} bytes of raw output for this run",
                self.max_bytes
            ));
            return self.write_line(&serialize_entry(&marker)?).await;
        }

        if is_bulk && self.bytes_written + len > self.bulk_budget() && len > self.tail_line_max() {
            if !self.eliding {
                self.eliding = true;
                let marker = LogEntry::Stderr(format!(
                    "[chro] execution log over budget: lines larger than {} bytes are no longer persisted for this run",
                    self.tail_line_max()
                ));
                self.write_line(&serialize_entry(&marker)?).await?;
            }
            return Ok(());
        }

        self.write_line(&line).await
    }

    async fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        self.file.write_all(line.as_bytes()).await?;
        self.bytes_written += line.len() as u64;
        Ok(())
    }

    pub async fn append_entries(&mut self, entries: &[LogEntry]) -> std::io::Result<()> {
        for entry in entries {
            self.append_entry(entry).await?;
        }
        self.file.flush().await
    }
}

/// Serialize a single entry to a JSONL line, eliding media and redacting
/// secrets in bulk output.
fn serialize_entry(entry: &LogEntry) -> std::io::Result<String> {
    let redacted;
    let to_write = match entry {
        LogEntry::Stdout(s) => {
            redacted = LogEntry::Stdout(redact_secrets(&elide_base64_media(s)).into_owned());
            &redacted
        }
        LogEntry::Stderr(s) => {
            redacted = LogEntry::Stderr(redact_secrets(s).into_owned());
            &redacted
        }
        other => other,
    };
    to_write
        .to_json_line()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Resolve the JSONL log file path for a task run.
pub fn log_file_path(logs_dir: &Path, task_run_id: Uuid) -> PathBuf {
    logs_dir.join("runs").join(format!("{}.jsonl", task_run_id))
}

/// Delete the JSONL log file for a task run if it exists.
pub async fn delete_log_file(logs_dir: &Path, task_run_id: Uuid) -> std::io::Result<()> {
    let path = log_file_path(logs_dir, task_run_id);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Read log entries from the JSONL file for a task run.
///
/// Returns an empty vec if the file does not exist. The file is streamed line by
/// line (never loaded whole into memory) and:
/// - persisted `JsonPatch` lines are skipped without parsing — legacy files
///   written before the persistence fix contain huge cumulative json_patch
///   lines that are dead weight (replay rebuilds patches from raw `Stdout`);
/// - retained output is capped at [`MAX_RUN_LOG_BYTES`] so a legacy multi-GB
///   file can no longer OOM the process;
/// - secrets in `Stdout`/`Stderr` are redacted (covers legacy unredacted files).
pub async fn read_log_entries(
    logs_dir: &Path,
    task_run_id: Uuid,
) -> std::io::Result<Vec<LogEntry>> {
    read_log_entries_with_limit(logs_dir, task_run_id, MAX_RUN_LOG_BYTES).await
}

pub async fn read_log_entries_with_limit(
    logs_dir: &Path,
    task_run_id: Uuid,
    max_bytes: u64,
) -> std::io::Result<Vec<LogEntry>> {
    let path = log_file_path(logs_dir, task_run_id);
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };

    let mut reader = BufReader::new(file);
    let mut entries = Vec::new();
    let mut retained_bytes: u64 = 0;
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Skip persisted JSON-Patch lines by prefix, without parsing — avoids
        // allocating multi-MB values from legacy files just to discard them.
        if is_json_patch_line(trimmed) {
            continue;
        }

        let entry = LogEntry::from_json_line(trimmed)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let entry = match entry {
            LogEntry::JsonPatch(_) => continue,
            LogEntry::Stdout(s) => LogEntry::Stdout(redact_secrets(&s).into_owned()),
            LogEntry::Stderr(s) => LogEntry::Stderr(redact_secrets(&s).into_owned()),
            other => other,
        };

        retained_bytes += n as u64;
        entries.push(entry);

        if retained_bytes > max_bytes {
            entries.push(LogEntry::Stderr(
                "[chro] execution log truncated on read: exceeded byte cap".to_string(),
            ));
            break;
        }
    }

    Ok(entries)
}

/// Detect a serialized `LogEntry::JsonPatch` line by prefix. `LogEntry` uses
/// `#[serde(tag = "type", content = "payload")]`, so the tag is always emitted
/// first as compact JSON.
fn is_json_patch_line(line: &str) -> bool {
    line.starts_with(r#"{"type":"json_patch""#)
}

/// Replace the payload of every base64 media source (`{"type":"base64",
/// "data":...}`, the shape providers use for image blocks) in a protocol line
/// with a size marker. Lines without such a source are returned untouched, so
/// only media lines pay for a JSON round-trip.
fn elide_base64_media(line: &str) -> Cow<'_, str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r#""type"\s*:\s*"base64""#).expect("valid base64-media regex"));
    if !re.is_match(line) {
        return Cow::Borrowed(line);
    }
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Cow::Borrowed(line);
    };
    if elide_base64_sources(&mut value) {
        Cow::Owned(value.to_string())
    } else {
        Cow::Borrowed(line)
    }
}

fn elide_base64_sources(value: &mut serde_json::Value) -> bool {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let mut changed = false;
            if map.get("type").and_then(Value::as_str) == Some("base64") {
                if let Some(Value::String(data)) = map.get_mut("data") {
                    *data = format!("[chro: omitted {} bytes of base64 media]", data.len());
                    changed = true;
                }
            }
            for child in map.values_mut() {
                changed |= elide_base64_sources(child);
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| elide_base64_sources(item) | changed),
        _ => false,
    }
}

/// Redact known secret material (auth tokens, API keys, bearer credentials)
/// from a protocol line before it is persisted or returned. These lines are
/// skipped during normalized replay, so redaction has no effect on the rendered
/// conversation — it only prevents secrets from sitting in plaintext on disk or
/// leaking into transcripts/CLI output.
fn redact_secrets(s: &str) -> Cow<'_, str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r#"("(?:authToken|access_token|refresh_token|id_token|api_key|apiKey|client_secret|secret_key)"\s*:\s*")[^"]*(")"#,
        )
        .expect("valid secret-redaction regex")
    });
    re.replace_all(s, "${1}[REDACTED]${2}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_and_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();

        let entries = vec![
            LogEntry::Stdout("hello".into()),
            LogEntry::Stderr("err".into()),
            LogEntry::Finished,
        ];

        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer.append_entries(&entries).await.unwrap();
        }

        let read_back = read_log_entries(dir.path(), run_id).await.unwrap();
        assert_eq!(read_back.len(), 3);
        assert_eq!(read_back[0], LogEntry::Stdout("hello".into()));
        assert!(matches!(read_back[2], LogEntry::Finished));
    }

    #[tokio::test]
    async fn read_missing_file_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let entries = read_log_entries(dir.path(), Uuid::new_v4()).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn delete_missing_file_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        delete_log_file(dir.path(), Uuid::new_v4()).await.unwrap();
    }

    #[tokio::test]
    async fn delete_existing_file_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();
        let log_path = log_file_path(dir.path(), run_id);

        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer
                .append_entry(&LogEntry::Stdout("hello".into()))
                .await
                .unwrap();
        }

        assert!(log_path.exists());
        delete_log_file(dir.path(), run_id).await.unwrap();
        assert!(!log_path.exists());
    }

    #[tokio::test]
    async fn append_is_additive() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();

        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer
                .append_entry(&LogEntry::Stdout("first".into()))
                .await
                .unwrap();
        }
        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer
                .append_entry(&LogEntry::Stdout("second".into()))
                .await
                .unwrap();
        }

        let entries = read_log_entries(dir.path(), run_id).await.unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[tokio::test]
    async fn json_patch_entries_are_not_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();

        let entries = vec![
            LogEntry::Stdout("before".into()),
            LogEntry::JsonPatch(serde_json::json!([
                {"op": "add", "path": "/entries/0", "value": {"type": "STDOUT", "content": "x"}}
            ])),
            LogEntry::Stdout("after".into()),
        ];

        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer.append_entries(&entries).await.unwrap();
        }

        // The on-disk file must not contain any json_patch payload.
        let raw = tokio::fs::read_to_string(log_file_path(dir.path(), run_id))
            .await
            .unwrap();
        assert!(
            !raw.contains("json_patch"),
            "json_patch must not be persisted, got: {raw}"
        );

        let read_back = read_log_entries(dir.path(), run_id).await.unwrap();
        assert_eq!(
            read_back,
            vec![
                LogEntry::Stdout("before".into()),
                LogEntry::Stdout("after".into()),
            ]
        );
    }

    #[tokio::test]
    async fn legacy_json_patch_lines_are_skipped_on_read() {
        // Simulate a legacy file written before the persistence fix: it mixes
        // huge cumulative json_patch lines with the raw stdout source of truth.
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();
        let runs = dir.path().join("runs");
        tokio::fs::create_dir_all(&runs).await.unwrap();
        let path = runs.join(format!("{run_id}.jsonl"));

        let big_patch = LogEntry::JsonPatch(serde_json::json!([
            {"op": "replace", "path": "/entries/0",
             "value": {"type": "STDOUT", "content": "A".repeat(2_000_000)}}
        ]))
        .to_json_line()
        .unwrap();
        let mut contents = String::new();
        contents.push_str(&LogEntry::Stdout("real".into()).to_json_line().unwrap());
        contents.push_str(&big_patch);
        contents.push_str(&LogEntry::Finished.to_json_line().unwrap());
        tokio::fs::write(&path, contents).await.unwrap();

        let read_back = read_log_entries(dir.path(), run_id).await.unwrap();
        assert_eq!(
            read_back,
            vec![LogEntry::Stdout("real".into()), LogEntry::Finished]
        );
    }

    #[tokio::test]
    async fn secrets_are_redacted_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();

        let secret_line =
            r#"{"id":2,"result":{"authMethod":"chatgpt","authToken":"eyJhbGciaSECRET"}}"#;
        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer
                .append_entry(&LogEntry::Stdout(secret_line.into()))
                .await
                .unwrap();
        }

        let raw = tokio::fs::read_to_string(log_file_path(dir.path(), run_id))
            .await
            .unwrap();
        assert!(!raw.contains("eyJhbGciaSECRET"), "token must be redacted");
        assert!(raw.contains("[REDACTED]"), "redaction marker expected");
    }

    #[tokio::test]
    async fn bulk_output_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();
        let cap: u64 = 64 * 1024; // small cap for the test

        {
            let mut writer = ExecutionLogWriter::with_limit(dir.path(), run_id, cap)
                .await
                .unwrap();
            // Write well past the cap in lines small enough to pass the tail
            // reserve (e.g. a command streaming output deltas).
            for _ in 0..8192 {
                writer
                    .append_entry(&LogEntry::Stdout("X".repeat(16)))
                    .await
                    .unwrap();
            }
            // Control entries still pass after truncation.
            writer.append_entry(&LogEntry::Finished).await.unwrap();
        }

        let size = tokio::fs::metadata(log_file_path(dir.path(), run_id))
            .await
            .unwrap()
            .len();
        assert!(size <= cap, "file should be bounded, got {size}");

        let read_back = read_log_entries(dir.path(), run_id).await.unwrap();
        assert!(
            read_back
                .iter()
                .any(|e| matches!(e, LogEntry::Stderr(s) if s.contains("truncated"))),
            "a truncation marker should be present"
        );
        assert!(
            read_back.iter().any(|e| matches!(e, LogEntry::Finished)),
            "control entries must survive truncation"
        );
    }

    fn image_tool_result_line(data: &str) -> String {
        serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [{
                "tool_use_id": "toolu_1",
                "type": "tool_result",
                "content": [{
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": data}
                }]
            }]},
            "session_id": "s1"
        })
        .to_string()
    }

    #[tokio::test]
    async fn base64_media_payloads_are_not_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();
        let data = "iVBORw0KGgo".repeat(30_000);

        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer
                .append_entry(&LogEntry::Stdout(image_tool_result_line(&data)))
                .await
                .unwrap();
        }

        let read_back = read_log_entries(dir.path(), run_id).await.unwrap();
        let [LogEntry::Stdout(line)] = read_back.as_slice() else {
            panic!("expected one stdout entry, got {read_back:?}");
        };
        assert!(!line.contains("iVBORw0KGgo"), "media bytes must be elided");
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        let block = &value["message"]["content"][0];
        assert_eq!(block["tool_use_id"], "toolu_1");
        let source = &block["content"][0]["source"];
        assert_eq!(source["type"], "base64");
        assert_eq!(source["media_type"], "image/png");
        assert_eq!(
            source["data"],
            format!("[chro: omitted {} bytes of base64 media]", data.len())
        );
    }

    #[tokio::test]
    async fn lines_without_media_are_persisted_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();
        // Key order and spacing must survive: only media lines are rewritten.
        let line =
            r#"{"type":"assistant", "message":{"content":[{"type":"text","text":"type base64"}]}}"#;

        {
            let mut writer = ExecutionLogWriter::new(dir.path(), run_id).await.unwrap();
            writer
                .append_entry(&LogEntry::Stdout(line.into()))
                .await
                .unwrap();
        }

        let read_back = read_log_entries(dir.path(), run_id).await.unwrap();
        assert_eq!(read_back, vec![LogEntry::Stdout(line.into())]);
    }

    #[tokio::test]
    async fn small_lines_survive_past_the_bulk_budget() {
        // The tail of a run (the agent's final answer) matters most. Once the
        // bulk budget is spent, oversized lines are dropped but small protocol
        // lines keep being persisted so the conversation still ends where the
        // run ended.
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();
        let cap: u64 = 1024 * 1024;

        {
            let mut writer = ExecutionLogWriter::with_limit(dir.path(), run_id, cap)
                .await
                .unwrap();
            for _ in 0..64 {
                writer
                    .append_entry(&LogEntry::Stdout("X".repeat(32 * 1024)))
                    .await
                    .unwrap();
            }
            writer
                .append_entry(&LogEntry::Stdout(
                    r#"{"type":"result","result":"done"}"#.into(),
                ))
                .await
                .unwrap();
            writer.append_entry(&LogEntry::Finished).await.unwrap();
        }

        let read_back = read_log_entries(dir.path(), run_id).await.unwrap();
        let tail: Vec<_> = read_back.iter().rev().take(2).collect();
        assert_eq!(
            tail,
            vec![
                &LogEntry::Finished,
                &LogEntry::Stdout(r#"{"type":"result","result":"done"}"#.into()),
            ]
        );
        let elision_markers = read_back
            .iter()
            .filter(|e| matches!(e, LogEntry::Stderr(s) if s.contains("over budget")))
            .count();
        assert_eq!(elision_markers, 1, "the elision marker is written once");
        let size = tokio::fs::metadata(log_file_path(dir.path(), run_id))
            .await
            .unwrap()
            .len();
        assert!(size <= cap + 1024, "file must stay bounded, got {size}");
    }

    #[tokio::test]
    async fn reader_returns_everything_the_writer_kept() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::new_v4();
        let cap: u64 = 1024 * 1024;
        let line = "Y".repeat(512);

        {
            let mut writer = ExecutionLogWriter::with_limit(dir.path(), run_id, cap)
                .await
                .unwrap();
            for _ in 0..4096 {
                writer
                    .append_entry(&LogEntry::Stdout(line.clone()))
                    .await
                    .unwrap();
            }
            writer.append_entry(&LogEntry::Finished).await.unwrap();
        }

        let read_back = read_log_entries_with_limit(dir.path(), run_id, cap)
            .await
            .unwrap();
        assert!(
            !read_back
                .iter()
                .any(|e| matches!(e, LogEntry::Stderr(s) if s.contains("on read"))),
            "a file within the writer's cap must not be truncated on read"
        );
        assert!(matches!(read_back.last(), Some(LogEntry::Finished)));
    }
}
