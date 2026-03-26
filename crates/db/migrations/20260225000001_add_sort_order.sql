-- Add sort_order column to task_records for kanban drag-and-drop ordering.
-- Default value 0 means "unordered"; the application treats 0 as
-- "sort by updated_at DESC" (backward compatible).
-- Lower sort_order values appear first in the kanban column.

ALTER TABLE task_records ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows: assign sort_order based on updated_at descending
-- per project so the initial order matches what users already see.
UPDATE task_records
SET sort_order = (
    SELECT COUNT(*)
    FROM task_records AS t2
    WHERE t2.project_id = task_records.project_id
      AND t2.status = task_records.status
      AND (t2.updated_at > task_records.updated_at
           OR (t2.updated_at = task_records.updated_at AND t2.id < task_records.id))
) + 1;

CREATE INDEX idx_task_records_sort_order ON task_records(project_id, status, sort_order);
