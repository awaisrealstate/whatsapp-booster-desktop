-- Phase 1A Foundation Migration (Cloudflare D1 / SQLite)
-- Safe idempotent DDL: creates core multi-tenant identity & organization tables only.
-- Note: Cloudflare D1 enforces foreign keys; local SQLite tests should enable PRAGMA foreign_keys = ON.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  default_country_code TEXT NOT NULL DEFAULT '92',
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'admin', 'agent', 'viewer')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_user
  ON organization_members(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user
  ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org
  ON organization_members(organization_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  active_organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  client_type TEXT NOT NULL DEFAULT 'web' CHECK (client_type IN ('web', 'desktop')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active_org
  ON sessions(active_organization_id);
