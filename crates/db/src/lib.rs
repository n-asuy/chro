use std::{future::Future, io, path::Path, pin::Pin, sync::Arc, time::Duration};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePoolOptions},
    Error, Pool, Sqlite,
};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const RECLAIM_MIN_FREE_PAGES: i64 = 512;
const RECLAIM_MIN_FREE_BYTES: i64 = 8 * 1024 * 1024;
const RECLAIM_MIN_FREE_RATIO: f64 = 0.20;

type AfterConnectHook = dyn for<'a> Fn(
        &'a mut SqliteConnection,
    ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>>
    + Send
    + Sync
    + 'static;

pub mod models;
pub mod slug;
pub mod types;

/// Database service providing connection pool and utilities
#[derive(Clone)]
pub struct DBService {
    pool: Pool<Sqlite>,
}

impl DBService {
    /// Create a new DBService with default database path
    ///
    /// Database will be created at the default location if it doesn't exist.
    /// Migrations will be run automatically.
    pub async fn new() -> Result<Self, Error> {
        Self::new_with_path(Self::default_path()).await
    }

    /// Create a new DBService with custom database path
    ///
    /// # Arguments
    /// * `db_path` - Path to the SQLite database file
    pub async fn new_with_path<P: AsRef<Path>>(db_path: P) -> Result<Self, Error> {
        let pool = Self::create_pool(db_path, None).await?;
        Ok(Self { pool })
    }

    /// Create a DBService with a SQLite `after_connect` hook.
    pub async fn new_with_hook<F>(hook: F) -> Result<Self, Error>
    where
        F: for<'a> Fn(
            &'a mut SqliteConnection,
        ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>>,
        F: Send + Sync + 'static,
    {
        Self::new_with_path_and_hook(Self::default_path(), hook).await
    }

    /// Create a DBService that attaches an `after_connect` hook for each pool connection.
    pub async fn new_with_path_and_hook<P, F>(db_path: P, hook: F) -> Result<Self, Error>
    where
        P: AsRef<Path>,
        F: for<'a> Fn(
            &'a mut SqliteConnection,
        ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>>,
        F: Send + Sync + 'static,
    {
        let hook_arc: Arc<AfterConnectHook> = Arc::new(hook);
        let pool = Self::create_pool(db_path, Some(hook_arc)).await?;
        Ok(Self { pool })
    }

    /// Get a reference to the connection pool
    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }

    /// Get the current database schema version
    pub async fn schema_version(&self) -> Result<i32, Error> {
        let row: (String,) =
            sqlx::query_as("SELECT value FROM app_meta WHERE key = 'db_schema_version'")
                .fetch_one(&self.pool)
                .await?;

        row.0.parse::<i32>().map_err(|e| {
            Error::Decode(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Invalid schema version: {}", e),
            )))
        })
    }

    /// Get default database path
    ///
    /// Returns path to db.sqlite in the application data directory.
    /// On macOS: ~/Library/Application Support/chro/db.sqlite
    /// On Linux: ~/.local/share/chro/db.sqlite
    /// On Windows: %APPDATA%/chro/db.sqlite
    pub fn default_path() -> std::path::PathBuf {
        let data_dir = if cfg!(target_os = "macos") {
            dirs::data_local_dir()
        } else {
            dirs::data_dir()
        }
        .unwrap_or_else(|| std::path::PathBuf::from("."));

        data_dir.join("chro").join("db.sqlite")
    }

    /// Run lightweight SQLite maintenance and compact the DB file only when a
    /// meaningful amount of space is sitting in the freelist.
    pub async fn reclaim_space_if_needed(&self) -> Result<bool, Error> {
        sqlx::query("PRAGMA optimize").execute(&self.pool).await?;

        let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&self.pool)
            .await?;
        let freelist_count: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&self.pool)
            .await?;

        if page_count <= 0 || freelist_count < RECLAIM_MIN_FREE_PAGES {
            return Ok(false);
        }

        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(&self.pool)
            .await?;
        let free_bytes = freelist_count.saturating_mul(page_size);
        let free_ratio = freelist_count as f64 / page_count as f64;

        if free_bytes < RECLAIM_MIN_FREE_BYTES || free_ratio < RECLAIM_MIN_FREE_RATIO {
            return Ok(false);
        }

        sqlx::query("VACUUM").execute(&self.pool).await?;
        Ok(true)
    }

    async fn create_pool<P>(
        db_path: P,
        hook: Option<Arc<AfterConnectHook>>,
    ) -> Result<Pool<Sqlite>, Error>
    where
        P: AsRef<Path>,
    {
        let db_path = db_path.as_ref();

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to create database directory: {}", e),
                ))
            })?;
        }

        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(15))
            .journal_mode(SqliteJournalMode::Delete);

        let pool = if let Some(hook) = hook {
            SqlitePoolOptions::new()
                .max_connections(10)
                .after_connect(move |conn, _| {
                    let hook = hook.clone();
                    Box::pin(async move {
                        hook(conn).await?;
                        Ok(())
                    })
                })
                .connect_with(options)
                .await?
        } else {
            SqlitePoolOptions::new()
                .max_connections(10)
                .connect_with(options)
                .await?
        };

        migrate_legacy_task_run_logs(&pool, db_path).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(pool)
    }
}

/// Move logs written by pre-JSONL versions out of SQLite before the schema
/// migration drops `task_run_logs`.
///
/// The DB transaction is committed only after every missing run file has been
/// atomically installed. If file I/O fails, the table remains available for a
/// later retry. A non-empty JSONL file is already the canonical source for that
/// run and is therefore never overwritten with older DB chunks.
async fn migrate_legacy_task_run_logs(pool: &Pool<Sqlite>, db_path: &Path) -> Result<u64, Error> {
    let table_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_run_logs')",
    )
    .fetch_one(pool)
    .await?;
    if !table_exists {
        return Ok(0);
    }

    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let result = async {
        let table_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_run_logs')",
        )
        .fetch_one(&mut *conn)
        .await?;

        if !table_exists {
            return Ok(0);
        }

        let run_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT DISTINCT task_run_id FROM task_run_logs ORDER BY task_run_id")
                .fetch_all(&mut *conn)
                .await?;
        let runs_dir = db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("logs")
            .join("runs");
        tokio::fs::create_dir_all(&runs_dir)
            .await
            .map_err(Error::Io)?;

        let mut exported = 0_u64;
        for run_id in run_ids {
            let target = runs_dir.join(format!("{run_id}.jsonl"));
            match tokio::fs::metadata(&target).await {
                Ok(metadata) if metadata.len() > 0 => continue,
                Ok(_) => tokio::fs::remove_file(&target).await.map_err(Error::Io)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(Error::Io(error)),
            }

            let temporary = runs_dir.join(format!(".{run_id}.jsonl.migrating"));
            let mut file = tokio::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)
                .await
                .map_err(Error::Io)?;

            let mut last_sequence = -1_i64;
            loop {
                let chunk: Option<(i64, String)> = sqlx::query_as(
                    "SELECT sequence_number, logs_jsonl
                     FROM task_run_logs
                     WHERE task_run_id = ? AND sequence_number > ?
                     ORDER BY sequence_number ASC
                     LIMIT 1",
                )
                .bind(run_id)
                .bind(last_sequence)
                .fetch_optional(&mut *conn)
                .await?;

                let Some((sequence, logs_jsonl)) = chunk else {
                    break;
                };
                file.write_all(logs_jsonl.as_bytes())
                    .await
                    .map_err(Error::Io)?;
                if !logs_jsonl.is_empty() && !logs_jsonl.ends_with('\n') {
                    file.write_all(b"\n").await.map_err(Error::Io)?;
                }
                last_sequence = sequence;
            }

            file.flush().await.map_err(Error::Io)?;
            file.sync_all().await.map_err(Error::Io)?;
            drop(file);
            tokio::fs::rename(&temporary, &target)
                .await
                .map_err(Error::Io)?;
            exported += 1;
        }

        sqlx::query("DROP TABLE task_run_logs")
            .execute(&mut *conn)
            .await?;
        Ok(exported)
    }
    .await;

    match result {
        Ok(exported) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            if exported > 0 {
                tracing::info!(exported, "migrated legacy task run logs to JSONL");
            }
            Ok(exported)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create_legacy_log_db(db_path: &Path, run_id: Uuid, chunks: &[&str]) {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE task_run_logs (
                task_run_id TEXT NOT NULL,
                sequence_number INTEGER NOT NULL,
                logs_jsonl TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (task_run_id, sequence_number)
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (sequence, chunk) in chunks.iter().enumerate() {
            sqlx::query(
                "INSERT INTO task_run_logs (task_run_id, sequence_number, logs_jsonl, byte_size)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(run_id)
            .bind(sequence as i64)
            .bind(chunk)
            .bind(chunk.len() as i64)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool.close().await;
    }

    #[tokio::test]
    async fn test_db_creation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");

        let db = DBService::new_with_path(&db_path).await.unwrap();
        assert!(db_path.exists());

        // Verify schema version
        let version = db.schema_version().await.unwrap();
        assert_eq!(version, 5);
    }

    #[tokio::test]
    async fn test_db_creation_with_nested_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("nested").join("deep").join("test.db");

        // Should create parent directories automatically
        let _db = DBService::new_with_path(&db_path).await.unwrap();
        assert!(db_path.exists());
        assert!(db_path.parent().unwrap().exists());
    }

    #[tokio::test]
    async fn legacy_task_run_logs_are_exported_before_table_is_dropped() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("legacy.db");
        let run_id = Uuid::new_v4();
        create_legacy_log_db(
            &db_path,
            run_id,
            &[
                r#"{"type":"stdout","payload":"one"}"#,
                r#"{"type":"finished"}"#,
            ],
        )
        .await;

        let db = DBService::new_with_path(&db_path).await.unwrap();
        let log_path = temp_dir
            .path()
            .join("logs")
            .join("runs")
            .join(format!("{run_id}.jsonl"));
        let migrated = tokio::fs::read_to_string(log_path).await.unwrap();
        assert_eq!(
            migrated,
            "{\"type\":\"stdout\",\"payload\":\"one\"}\n{\"type\":\"finished\"}\n"
        );

        let table_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_run_logs')",
        )
        .fetch_one(db.pool())
        .await
        .unwrap();
        assert!(!table_exists);
    }

    #[tokio::test]
    async fn legacy_log_export_keeps_an_existing_canonical_jsonl() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("existing.db");
        let run_id = Uuid::new_v4();
        create_legacy_log_db(&db_path, run_id, &["legacy"]).await;
        let runs_dir = temp_dir.path().join("logs").join("runs");
        tokio::fs::create_dir_all(&runs_dir).await.unwrap();
        let log_path = runs_dir.join(format!("{run_id}.jsonl"));
        tokio::fs::write(&log_path, "canonical\n").await.unwrap();

        DBService::new_with_path(&db_path).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(log_path).await.unwrap(),
            "canonical\n"
        );
    }

    #[tokio::test]
    async fn legacy_log_table_survives_when_jsonl_export_fails() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("failed.db");
        let run_id = Uuid::new_v4();
        create_legacy_log_db(&db_path, run_id, &["legacy"]).await;
        tokio::fs::write(temp_dir.path().join("logs"), "not a directory")
            .await
            .unwrap();

        assert!(DBService::new_with_path(&db_path).await.is_err());

        let options = SqliteConnectOptions::new().filename(&db_path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_run_logs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[tokio::test]
    async fn test_global_template_uniqueness() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = DBService::new_with_path(&db_path).await.unwrap();

        // Insert first global template
        sqlx::query(
            "INSERT INTO task_templates (id, project_id, template_name, title)
             VALUES (randomblob(16), NULL, 'daily-standup', 'Daily Standup')",
        )
        .execute(db.pool())
        .await
        .unwrap();

        // Try to insert duplicate global template - should fail
        let result = sqlx::query(
            "INSERT INTO task_templates (id, project_id, template_name, title)
             VALUES (randomblob(16), NULL, 'daily-standup', 'Another Standup')",
        )
        .execute(db.pool())
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_project_template_uniqueness() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = DBService::new_with_path(&db_path).await.unwrap();

        // Create a project first
        let project_id = uuid::Uuid::new_v4().as_bytes().to_vec();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path)
             VALUES (?, 'test-project', '/tmp/test')",
        )
        .bind(&project_id)
        .execute(db.pool())
        .await
        .unwrap();

        // Insert first project template
        sqlx::query(
            "INSERT INTO task_templates (id, project_id, template_name, title)
             VALUES (randomblob(16), ?, 'code-review', 'Code Review')",
        )
        .bind(&project_id)
        .execute(db.pool())
        .await
        .unwrap();

        // Try to insert duplicate project template - should fail
        let result = sqlx::query(
            "INSERT INTO task_templates (id, project_id, template_name, title)
             VALUES (randomblob(16), ?, 'code-review', 'Another Review')",
        )
        .bind(&project_id)
        .execute(db.pool())
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn reclaim_space_runs_when_freelist_is_large() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("reclaim.db");
        let db = DBService::new_with_path(&db_path).await.unwrap();

        sqlx::query("CREATE TABLE reclaim_test (payload BLOB NOT NULL)")
            .execute(db.pool())
            .await
            .unwrap();

        for _ in 0..700 {
            sqlx::query("INSERT INTO reclaim_test (payload) VALUES (zeroblob(16384))")
                .execute(db.pool())
                .await
                .unwrap();
        }

        sqlx::query("DELETE FROM reclaim_test")
            .execute(db.pool())
            .await
            .unwrap();

        let reclaimed = db.reclaim_space_if_needed().await.unwrap();
        assert!(reclaimed);
    }
}
