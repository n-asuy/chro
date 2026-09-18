-- Whether a person chose the task's title. A task starts out titled with the
-- first line of its prompt; once the agent's own session title becomes
-- available (Claude Code writes one to the transcript after the first turn)
-- the task adopts it, unless the title is pinned. Renaming pins.
--
-- Backfill: an inferred title is always a line of the prompt, so a title the
-- prompt does not contain was typed by a person and stays as it is. Tasks
-- without a stored prompt were created with an explicit title (CLI, fork,
-- delegation) and are pinned for the same reason. The timestamp fallback used
-- when a prompt has no text is not a person's choice.
ALTER TABLE task_records ADD COLUMN title_pinned INTEGER NOT NULL DEFAULT 0;

UPDATE task_records
SET title_pinned = 1
WHERE title NOT LIKE 'Session ____-__-__ __:__'
  AND (prompt IS NULL OR instr(prompt, title) = 0);
