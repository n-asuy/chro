-- Store prompt/session context references as first-class task graph data.
-- Prompt tags remain a rendered interchange format; this table is the
-- canonical relationship store for traversal and UI provenance.

CREATE TABLE task_context_refs (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    task_session_id     TEXT,
    task_run_id         TEXT,
    kind                TEXT NOT NULL
                            CHECK (kind IN ('session', 'task', 'file', 'directory', 'skill', 'image')),
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

CREATE INDEX idx_task_context_refs_task ON task_context_refs(task_id, sort_order);
CREATE INDEX idx_task_context_refs_session ON task_context_refs(task_session_id, sort_order);
CREATE INDEX idx_task_context_refs_run ON task_context_refs(task_run_id, sort_order);
CREATE INDEX idx_task_context_refs_target_task ON task_context_refs(target_task_id);
CREATE INDEX idx_task_context_refs_target_session ON task_context_refs(target_session_id);

UPDATE app_meta SET value = '4' WHERE key = 'db_schema_version';
