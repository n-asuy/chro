-- A short status line the session's agent or a person sets ("fix implemented;
-- running tests"). Shown on the session's row. NULL until someone sets it.
ALTER TABLE task_records ADD COLUMN note TEXT;

-- Messages sent to a session while a turn was in flight. Each becomes the
-- next turn, oldest first, once the session is idle again.
CREATE TABLE session_queue (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (task_id) REFERENCES task_records(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_queue_task ON session_queue(task_id, created_at);
