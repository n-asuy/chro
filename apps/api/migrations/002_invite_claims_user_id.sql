-- Recreate invite_claims with user_id column and email as nullable
-- SQLite doesn't support ALTER COLUMN, so we recreate the table

CREATE TABLE invite_claims_new (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES invite_codes(code) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  email TEXT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO invite_claims_new (id, code, email, name, created_at)
SELECT id, code, email, name, created_at FROM invite_claims;

DROP TABLE invite_claims;

ALTER TABLE invite_claims_new RENAME TO invite_claims;

CREATE INDEX IF NOT EXISTS idx_invite_claims_code
  ON invite_claims (code);

CREATE INDEX IF NOT EXISTS idx_invite_claims_email
  ON invite_claims (email);

CREATE INDEX IF NOT EXISTS idx_invite_claims_user_id
  ON invite_claims (user_id);
