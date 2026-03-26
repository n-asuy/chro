PRAGMA foreign_keys = ON;

-- Waitlist entries store inbound requests for access
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  use_case TEXT,
  invite_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_waitlist_status
  ON waitlist_entries (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at
  ON waitlist_entries (created_at DESC);

-- Invite codes gate sign-ups and can be claimed multiple times
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  note TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_by_email TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_created_at
  ON invite_codes (created_at DESC);

-- Invite claims audit how codes are used
CREATE TABLE IF NOT EXISTS invite_claims (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES invite_codes(code) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invite_claims_code
  ON invite_claims (code);

CREATE INDEX IF NOT EXISTS idx_invite_claims_email
  ON invite_claims (email);
