-- Execution location is chosen once per conversation. Credentials never enter DB.
CREATE TABLE session_execution_locations (
    task_id BLOB PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
    location TEXT NOT NULL CHECK (location IN ('computer', 'cloud')),
    instance_id TEXT,
    endpoint TEXT
);
-- Existing conversations have already chosen their execution location.
INSERT INTO session_execution_locations (task_id, location)
SELECT DISTINCT task_id, 'computer' FROM task_runs;
