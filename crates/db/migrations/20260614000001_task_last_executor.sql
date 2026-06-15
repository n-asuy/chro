-- Denormalize the coding agent a task last ran with onto the task record so the
-- session tab can show the agent's logo without a per-task run lookup. This
-- mirrors how `branch` / `worktree_path` are cached on the task from its runs.
ALTER TABLE task_records ADD COLUMN last_executor TEXT;

-- Backfill from each task's most recent run. `executor_label` is normally a full
-- ExecutorProfileId JSON (`{"executor":"CLAUDE_CODE",...}`) but may be a bare
-- agent string ("CLAUDE_CODE") in the serialization-failure fallback path. The
-- json_valid guard keeps json_extract from erroring on the non-JSON form, so we
-- always end up with the bare agent kind.
UPDATE task_records
SET last_executor = (
    SELECT CASE
        WHEN json_valid(runs.executor_label)
            THEN json_extract(runs.executor_label, '$.executor')
        ELSE runs.executor_label
    END
    FROM task_runs runs
    WHERE runs.task_id = task_records.id
      AND runs.executor_label IS NOT NULL
    ORDER BY runs.created_at DESC
    LIMIT 1
);
