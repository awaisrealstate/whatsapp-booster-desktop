-- Phase 1B Auth Foundation Migration (Cloudflare D1 / SQLite)
-- Adds verification_tokens (SHA-256 token hashes only) and auth_rate_limits for login protection.

CREATE TABLE IF NOT EXISTS verification_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_tokens_user
  ON verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_email
  ON verification_tokens(email, purpose);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key TEXT PRIMARY KEY NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  locked_until INTEGER
);
