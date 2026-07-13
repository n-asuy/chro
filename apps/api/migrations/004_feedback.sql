-- Feedback submissions collected from the desktop app
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'feedback',
  message TEXT NOT NULL,
  email TEXT,
  name TEXT,
  user_id TEXT,
  app_version TEXT,
  platform TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at
  ON feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_category
  ON feedback (category, created_at DESC);
