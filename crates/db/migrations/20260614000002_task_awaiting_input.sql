-- Runtime flag: the agent is blocked on an AskUserQuestion approval and is
-- waiting for the user to answer. Denormalized runtime state (same pattern as
-- active_session_id) so the task list / inbox can show a "waiting" indicator
-- and fire an input-needed notification without a per-run approval lookup.
-- Always cleared when the active session ends, so a stale flag cannot outlive
-- a finished run.
ALTER TABLE task_records
    ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0
        CHECK (awaiting_input IN (0, 1));
