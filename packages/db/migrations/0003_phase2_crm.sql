-- Phase 2 CRM Migration (Cloudflare D1 / SQLite)
-- Adds contacts, tags, contact_tags, contact_lists, list_members, consent_records,
-- suppression_list, conversations, messages, and legacy_imports.
-- All tenant-owned records enforce organization_id isolation.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  raw_phone TEXT,
  name TEXT NOT NULL DEFAULT 'Valued Client',
  email TEXT,
  company TEXT,
  custom_attributes_json TEXT NOT NULL DEFAULT '{}',
  pipeline_stage TEXT NOT NULL DEFAULT 'lead' CHECK (pipeline_stage IN ('lead', 'contacted', 'qualified', 'won', 'lost')),
  source TEXT NOT NULL DEFAULT 'manual',
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_org_phone_active
  ON contacts(organization_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_org_stage
  ON contacts(organization_id, pipeline_stage, deleted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_org_updated
  ON contacts(organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#00a884',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_org_name
  ON tags(organization_id, name);

CREATE TABLE IF NOT EXISTS contact_tags (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (contact_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_tags_org
  ON contact_tags(organization_id, tag_id);

CREATE TABLE IF NOT EXISTS contact_lists (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'csv', 'tsv', 'xlsx', 'google_sheet', 'legacy_import')),
  source_url TEXT,
  auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
  sync_interval_min INTEGER NOT NULL DEFAULT 5,
  last_synced_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_lists_org
  ON contact_lists(organization_id, deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS list_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_list_members_org
  ON list_members(organization_id, list_id);

-- Preserves opt-in and STOP opt-out history even if a contact row is soft- or hard-deleted.
CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  status TEXT NOT NULL CHECK (status IN ('opted_in', 'opted_out', 'unknown')),
  source TEXT NOT NULL,
  proof_note TEXT,
  recorded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_org_phone
  ON consent_records(organization_id, phone, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_org_contact
  ON consent_records(organization_id, contact_id);

-- Durable STOP / suppression table keyed by (organization_id, phone); never deleted on contact delete.
CREATE TABLE IF NOT EXISTS suppression_list (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('stop_keyword', 'manual_opt_out', 'complaint', 'bounce')),
  source TEXT NOT NULL,
  notes TEXT,
  suppressed_at INTEGER NOT NULL,
  lifted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_org_phone
  ON suppression_list(organization_id, phone);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL DEFAULT 'manual_crm' CHECK (channel_type IN ('official_meta_cloud', 'unofficial_local_desktop', 'manual_crm')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'snoozed')),
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  service_window_expires_at INTEGER,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_org_inbox
  ON conversations(organization_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_org_contact
  ON conversations(organization_id, contact_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal_note')),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('contact', 'agent', 'system')),
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  msg_type TEXT NOT NULL DEFAULT 'text' CHECK (msg_type IN ('text', 'template', 'image', 'document', 'audio')),
  body TEXT,
  provider_message_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_org_conv
  ON messages(organization_id, conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_org_idempotency
  ON messages(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_org_status
  ON messages(organization_id, status);

CREATE TABLE IF NOT EXISTS legacy_imports (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  imported_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_name TEXT NOT NULL,
  template_text TEXT,
  google_sheet_url TEXT,
  daily_limit INTEGER,
  batch_sent_count INTEGER NOT NULL DEFAULT 0,
  total_contacts INTEGER NOT NULL DEFAULT 0,
  imported_contacts INTEGER NOT NULL DEFAULT 0,
  preserved_sent_count INTEGER NOT NULL DEFAULT 0,
  preserved_failed_count INTEGER NOT NULL DEFAULT 0,
  raw_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_legacy_imports_org
  ON legacy_imports(organization_id, created_at DESC);
