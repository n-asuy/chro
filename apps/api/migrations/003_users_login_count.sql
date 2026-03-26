-- Add login_count column to track user login frequency
ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;
