-- Add slug columns to entities that appear in URLs.
-- Slugs are short (8-char) alphanumeric identifiers for human-friendly URLs.
-- UUIDs remain the primary keys; slugs are lookup-only.

-- project_records
ALTER TABLE project_records ADD COLUMN slug TEXT;

UPDATE project_records
SET slug = lower(substr(hex(id), 1, 8))
WHERE slug IS NULL;

CREATE UNIQUE INDEX idx_project_records_slug ON project_records(slug);

-- task_records
ALTER TABLE task_records ADD COLUMN prompt TEXT;

ALTER TABLE task_records ADD COLUMN slug TEXT;

UPDATE task_records
SET slug = lower(substr(hex(id), 1, 8))
WHERE slug IS NULL;

CREATE UNIQUE INDEX idx_task_records_slug ON task_records(slug);

-- task_runs
ALTER TABLE task_runs ADD COLUMN slug TEXT;

UPDATE task_runs
SET slug = lower(substr(hex(id), 1, 8))
WHERE slug IS NULL;

CREATE UNIQUE INDEX idx_task_runs_slug ON task_runs(slug);

-- Bump schema version
UPDATE app_meta SET value = '3' WHERE key = 'db_schema_version';
