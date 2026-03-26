ALTER TABLE task_runs
    ADD COLUMN branch_name TEXT;
ALTER TABLE task_runs
    ADD COLUMN target_branch TEXT;
ALTER TABLE task_runs
    ADD COLUMN container_ref TEXT;
ALTER TABLE task_runs
    ADD COLUMN workspace_path TEXT;
ALTER TABLE task_runs
    ADD COLUMN executor_label TEXT;
ALTER TABLE task_runs
    ADD COLUMN resume_session_id TEXT;
ALTER TABLE task_runs
    ADD COLUMN worktree_deleted INTEGER NOT NULL DEFAULT 0 CHECK (worktree_deleted IN (0, 1));

-- Bump schema version
UPDATE app_meta SET value = '2' WHERE key = 'db_schema_version';
