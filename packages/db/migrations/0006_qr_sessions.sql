-- Migration 0006: Add non-destructive QR Bridge session tracking table & last_connected_at
-- Preserves existing whatsapp_accounts rows, FKs, and Meta Official Cloud API behavior.

ALTER TABLE whatsapp_accounts
  ADD COLUMN last_connected_at INTEGER;

CREATE TABLE IF NOT EXISTS wa_qr_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (
    status IN ('connecting', 'waiting_for_scan', 'connected', 'disconnected', 'expired', 'error')
  ),
  qr_data_url TEXT,
  qr_expires_at INTEGER,
  connected_phone TEXT,
  last_connected_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_qr_sessions_org
  ON wa_qr_sessions(organization_id, updated_at DESC);
