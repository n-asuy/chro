-- Allow 'delegate' and 'handoff' as context-ref kinds.
--
-- Together they form the lifecycle-communication backbone:
--   delegate — broker-authored provenance on a spawned task, pointing at the
--              task that delegated the work. Its digest is pushed into the
--              child's boot prompt at spawn (the only guaranteed first
--              delivery).
--   handoff  — broker-authored completion report on the delegating task,
--              pointing at the child whose run finished. Doubles as the
--              outcome-ledger row; its arrival wakes the delegating session.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- Column order, defaults, foreign keys and indexes are preserved verbatim from
-- 20260715000001_context_ref_kind_fork.sql, with the two kinds added.

PRAGMA foreign_keys = OFF;

CREATE TABLE task_context_refs_new (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    task_session_id     TEXT,
    task_run_id         TEXT,
    kind                TEXT NOT NULL
                            CHECK (kind IN ('session', 'task', 'file', 'directory', 'skill', 'image', 'fork', 'delegate', 'handoff')),
    target_task_id      TEXT,
    target_session_id   TEXT,
    path                TEXT,
    branch              TEXT,
    mode                TEXT NOT NULL DEFAULT 'link',
    label               TEXT,
    metadata_json       TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (task_id) REFERENCES task_records(id) ON DELETE CASCADE,
    FOREIGN KEY (task_session_id) REFERENCES task_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (target_task_id) REFERENCES task_records(id) ON DELETE SET NULL,
    FOREIGN KEY (target_session_id) REFERENCES task_sessions(id) ON DELETE SET NULL
);

INSERT INTO task_context_refs_new (
    id, task_id, task_session_id, task_run_id, kind, target_task_id,
    target_session_id, path, branch, mode, label, metadata_json,
    sort_order, created_at, updated_at
)
SELECT
    id, task_id, task_session_id, task_run_id, kind, target_task_id,
    target_session_id, path, branch, mode, label, metadata_json,
    sort_order, created_at, updated_at
FROM task_context_refs;

DROP TABLE task_context_refs;

ALTER TABLE task_context_refs_new RENAME TO task_context_refs;

CREATE INDEX idx_task_context_refs_task ON task_context_refs(task_id, sort_order);
CREATE INDEX idx_task_context_refs_session ON task_context_refs(task_session_id, sort_order);
CREATE INDEX idx_task_context_refs_run ON task_context_refs(task_run_id, sort_order);
CREATE INDEX idx_task_context_refs_target_task ON task_context_refs(target_task_id);
CREATE INDEX idx_task_context_refs_target_session ON task_context_refs(target_session_id);

PRAGMA foreign_keys = ON;
