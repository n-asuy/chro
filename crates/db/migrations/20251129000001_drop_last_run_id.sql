CREATE TABLE task_records_new (
    id                  TEXT PRIMARY KEY NOT NULL,
    project_id          TEXT NOT NULL,
    parent_task_id      TEXT,
    title               TEXT NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    due_at              TEXT,
    branch              TEXT,
    worktree_path       TEXT,
    worktree_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (worktree_deleted IN (0, 1)),
    active_session_id   TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (project_id) REFERENCES project_records(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_task_id) REFERENCES task_records(id) ON DELETE SET NULL,
    FOREIGN KEY (active_session_id) REFERENCES task_sessions(id) ON DELETE SET NULL
);

INSERT INTO task_records_new (id, project_id, parent_task_id, title, description, status, due_at, branch, worktree_path, worktree_deleted, active_session_id, created_at, updated_at)
SELECT id, project_id, parent_task_id, title, description, status, due_at, branch, worktree_path, worktree_deleted, active_session_id, created_at, updated_at
FROM task_records;

DROP TABLE task_records;
ALTER TABLE task_records_new RENAME TO task_records;

CREATE INDEX idx_task_records_project_id ON task_records(project_id);
CREATE INDEX idx_task_records_parent_task_id ON task_records(parent_task_id);
CREATE INDEX idx_task_records_status ON task_records(status);
