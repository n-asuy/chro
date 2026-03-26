-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Schema version management
CREATE TABLE app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO app_meta(key, value) VALUES ('db_schema_version', '1');

CREATE TABLE project_records (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    git_repo_path   TEXT NOT NULL UNIQUE,
    setup_script    TEXT,
    dev_script      TEXT,
    cleanup_script  TEXT,
    copy_files      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE TABLE agent_profiles (
    id              TEXT PRIMARY KEY,
    provider        TEXT,
    model           TEXT,
    type            TEXT NOT NULL,
    capabilities    TEXT, -- JSON
    owner_user_id   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE TABLE task_records (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    parent_task_id      TEXT,
    title               TEXT NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled')),
    due_at              TEXT,
    branch              TEXT,
    worktree_path       TEXT,  -- Local only
    last_run_id         TEXT,  -- FK to task_runs, nullable
    worktree_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (worktree_deleted IN (0, 1)),
    active_session_id   TEXT,  -- FK to task_sessions, nullable
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (project_id) REFERENCES project_records(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_task_id) REFERENCES task_records(id) ON DELETE SET NULL,
    FOREIGN KEY (last_run_id) REFERENCES task_runs(id) ON DELETE SET NULL,
    FOREIGN KEY (active_session_id) REFERENCES task_sessions(id) ON DELETE SET NULL
);

CREATE INDEX idx_task_records_project ON task_records(project_id);
CREATE INDEX idx_task_records_parent ON task_records(parent_task_id);
CREATE INDEX idx_task_records_status ON task_records(status);

CREATE TABLE task_runs (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL,
    execution_mode          TEXT NOT NULL DEFAULT 'local'
                                CHECK (execution_mode IN ('local', 'remote')),
    status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    run_reason              TEXT,
    executor_action         TEXT,
    executor_action_type    TEXT,
    exit_code               INTEGER,
    dropped                 INTEGER NOT NULL DEFAULT 0 CHECK (dropped IN (0, 1)),
    before_head_commit      TEXT,
    after_head_commit       TEXT,
    -- Remote execution fields (nullable)
    executor_job_id         TEXT UNIQUE,     -- Remote only
    s3_prefix               TEXT,            -- Remote only
    logs_uri                TEXT,            -- Remote only
    summary_uri             TEXT,            -- Remote only
    diffs_prefix            TEXT,            -- Remote only
    logs_retrieval_failed   INTEGER NOT NULL DEFAULT 0 CHECK (logs_retrieval_failed IN (0, 1)),
    started_at              TEXT,
    completed_at            TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (task_id) REFERENCES task_records(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_runs_task ON task_runs(task_id);
CREATE INDEX idx_task_runs_status ON task_runs(status);
CREATE INDEX idx_task_runs_execution_mode ON task_runs(execution_mode);

CREATE TABLE task_run_logs (
    task_run_id     TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    logs_jsonl      TEXT NOT NULL,  -- NDJSON format, max 10MB per chunk
    byte_size       INTEGER NOT NULL,
    inserted_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    PRIMARY KEY (task_run_id, sequence_number),
    FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_run_logs_run ON task_run_logs(task_run_id);

CREATE TABLE task_sessions (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL,
    task_run_id             TEXT,
    agent_profile_id        TEXT NOT NULL,
    external_session_id     TEXT,  -- Optional, for external system tracking
    prompt                  TEXT,
    summary                 TEXT,
    handoff_from_session_id TEXT,
    worktree_commit         TEXT,
    state_snapshot          TEXT,  -- JSON
    created_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (task_id) REFERENCES task_records(id) ON DELETE CASCADE,
    FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE SET NULL,
    FOREIGN KEY (agent_profile_id) REFERENCES agent_profiles(id) ON DELETE RESTRICT,
    FOREIGN KEY (handoff_from_session_id) REFERENCES task_sessions(id) ON DELETE SET NULL
);

CREATE INDEX idx_task_sessions_task ON task_sessions(task_id);
CREATE INDEX idx_task_sessions_agent ON task_sessions(agent_profile_id);

CREATE TABLE task_merges (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    merge_type          TEXT,
    target_branch_name  TEXT,
    merge_commit        TEXT,
    pr_number           INTEGER,
    pr_url              TEXT,
    pr_status           TEXT,
    pr_merged_at        TEXT,
    pr_merge_commit_sha TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    reverted_at         TEXT,
    FOREIGN KEY (task_id) REFERENCES task_records(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_merges_task ON task_merges(task_id);

CREATE TABLE task_drafts (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    retry_task_run_id   TEXT,
    draft_type          TEXT NOT NULL DEFAULT 'initial'
                            CHECK (draft_type IN ('initial', 'retry', 'follow_up')),
    prompt              TEXT,
    image_ids           TEXT,  -- JSON array
    queued              INTEGER NOT NULL DEFAULT 0 CHECK (queued IN (0, 1)),
    sending             INTEGER NOT NULL DEFAULT 0 CHECK (sending IN (0, 1)),
    version             INTEGER NOT NULL DEFAULT 1,
    variant             TEXT,  -- Optional: A/B test or alternate approach identifier
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (task_id) REFERENCES task_records(id) ON DELETE CASCADE,
    FOREIGN KEY (retry_task_run_id) REFERENCES task_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_task_drafts_task ON task_drafts(task_id);

CREATE TABLE task_templates (
    id          TEXT PRIMARY KEY,
    project_id  TEXT,  -- NULL = global template
    template_name TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (project_id) REFERENCES project_records(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_templates_project ON task_templates(project_id);

CREATE UNIQUE INDEX idx_task_templates_global_name
    ON task_templates(template_name)
    WHERE project_id IS NULL;

CREATE UNIQUE INDEX idx_task_templates_project_name
    ON task_templates(project_id, template_name)
    WHERE project_id IS NOT NULL;

CREATE TABLE task_recurrences (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    parent_task_id  TEXT,
    last_task_id    TEXT,
    title           TEXT NOT NULL,
    description     TEXT,
    image_ids       TEXT,  -- JSON array
    starts_at       TEXT,
    frequency       TEXT,
    interval        INTEGER,
    timezone        TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'completed')),
    next_run_at     TEXT,
    last_run_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (project_id) REFERENCES project_records(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_task_id) REFERENCES task_records(id) ON DELETE SET NULL,
    FOREIGN KEY (last_task_id) REFERENCES task_records(id) ON DELETE SET NULL
);

CREATE INDEX idx_task_recurrences_project ON task_recurrences(project_id);
CREATE INDEX idx_task_recurrences_next_run ON task_recurrences(status, next_run_at);

CREATE TABLE asset_images (
    id              TEXT PRIMARY KEY,
    file_path       TEXT NOT NULL,
    original_name   TEXT NOT NULL,
    mime_type       TEXT,
    size_bytes      INTEGER NOT NULL,
    hash            TEXT NOT NULL UNIQUE,  -- SHA-256 for deduplication
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE UNIQUE INDEX idx_asset_images_hash ON asset_images(hash);

CREATE TABLE task_image_links (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    image_id    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (task_id) REFERENCES task_records(id) ON DELETE CASCADE,
    FOREIGN KEY (image_id) REFERENCES asset_images(id) ON DELETE CASCADE,
    UNIQUE(task_id, image_id)
);

CREATE INDEX idx_task_image_links_task ON task_image_links(task_id);
CREATE INDEX idx_task_image_links_image ON task_image_links(image_id);
