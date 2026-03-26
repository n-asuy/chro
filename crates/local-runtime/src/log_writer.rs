use std::path::{Path, PathBuf};

use log_types::LogEntry;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

/// File-based JSONL log writer for task run execution logs.
///
/// Writes log entries as newline-delimited JSON to disk, replacing
/// SQLite-based storage to eliminate write lock contention during
/// agent execution.
pub struct ExecutionLogWriter {
    file: tokio::fs::File,
}

impl ExecutionLogWriter {
    pub async fn new(logs_dir: &Path, task_run_id: Uuid) -> std::io::Result<Self> {
        let dir = logs_dir.join("runs");
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join(format!("{}.jsonl", task_run_id));
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        Ok(Self { file })
    }

    pub async fn append_entry(&mut self, entry: &LogEntry) -> std::io::Result<()> {
        let line = entry
            .to_json_line()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        self.file.write_all(line.as_bytes()).await
    }

    pub async fn append_entries(&mut self, entries: &[LogEntry]) -> std::io::Result<()> {
        for entry in entries {
            self.append_entry(entry).await?;
        }
        self.file.flush().await
    }
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

/// Read all log entries from the JSONL file for a task run.
/// Returns an empty vec if the file does not exist.
pub async fn read_log_entries(
    logs_dir: &Path,
    task_run_id: Uuid,
) -> std::io::Result<Vec<LogEntry>> {
    let path = log_file_path(logs_dir, task_run_id);
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => parse_jsonl_entries(&content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn parse_jsonl_entries(content: &str) -> std::io::Result<Vec<LogEntry>> {
    let mut entries = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let entry = LogEntry::from_json_line(line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        entries.push(entry);
    }
    Ok(entries)
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
}
