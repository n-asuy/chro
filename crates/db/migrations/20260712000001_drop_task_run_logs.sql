-- Execution logs have been stored as per-run JSONL files since the local
-- runtime moved them out of SQLite to avoid write-lock contention. Before this
-- migration runs, DBService exports any remaining legacy chunks atomically.
DROP TABLE IF EXISTS task_run_logs;

UPDATE app_meta SET value = '5' WHERE key = 'db_schema_version';
