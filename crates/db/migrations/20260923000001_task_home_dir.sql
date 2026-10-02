-- The directory a task is addressed to, relative to the project root ("" is
-- the root itself). Set explicitly when a session is dispatched from a
-- directory, otherwise derived after the first auto-commit as the lowest
-- common ancestor of the paths that commit touched. NULL until either happens.
ALTER TABLE task_records ADD COLUMN home_dir TEXT;
CREATE INDEX IF NOT EXISTS idx_task_records_home_dir ON task_records(project_id, home_dir);
