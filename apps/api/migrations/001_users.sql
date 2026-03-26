-- Users table stores authenticated users from Clerk
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Add foreign key reference from invite_codes to users
-- Note: created_by may be 'admin' for API-created codes, so no FK constraint
