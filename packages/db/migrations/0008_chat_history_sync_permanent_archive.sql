-- Migration 0008: Complete WhatsApp Chat History Sync & Permanent CRM Archive
-- Fully additive migration (no DROP, no destructive changes).
-- Preserves all existing conversations, messages, and settings.

-- 1. Extend conversations for group and history sync tracking
ALTER TABLE conversations ADD COLUMN remote_jid TEXT;
ALTER TABLE conversations ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN group_subject TEXT;
ALTER TABLE conversations ADD COLUMN profile_picture_url TEXT;
ALTER TABLE conversations ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced';
ALTER TABLE conversations ADD COLUMN last_synced_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_conv_remote_jid
  ON conversations(organization_id, remote_jid) WHERE remote_jid IS NOT NULL;

-- 2. Extend messages for permanent archive protection, media, and edits
ALTER TABLE messages ADD COLUMN is_deleted_on_whatsapp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN whatsapp_deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN is_edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN media_url TEXT;
ALTER TABLE messages ADD COLUMN media_mime_type TEXT;
ALTER TABLE messages ADD COLUMN media_filename TEXT;
ALTER TABLE messages ADD COLUMN media_size_bytes INTEGER;
ALTER TABLE messages ADD COLUMN sender_phone TEXT;
ALTER TABLE messages ADD COLUMN sender_name TEXT;
ALTER TABLE messages ADD COLUMN remote_jid TEXT;
ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'whatsapp';

CREATE INDEX IF NOT EXISTS idx_msg_org_pmid
  ON messages(organization_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_is_deleted
  ON messages(organization_id, is_deleted_on_whatsapp) WHERE is_deleted_on_whatsapp = 1;

-- 3. Message edit versions (preserved before overwriting)
CREATE TABLE IF NOT EXISTS message_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_message_id TEXT,
  body TEXT,
  media_url TEXT,
  version_number INTEGER NOT NULL DEFAULT 1,
  edited_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_versions_msg
  ON message_versions(organization_id, message_id, version_number DESC);

-- 4. Message deletion events (when deleted for everyone on WhatsApp)
CREATE TABLE IF NOT EXISTS message_deletion_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  deleted_by_jid TEXT,
  deletion_type TEXT NOT NULL DEFAULT 'revoke',
  deleted_at INTEGER NOT NULL,
  raw_event_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_deletion_events_msg
  ON message_deletion_events(organization_id, message_id);
CREATE INDEX IF NOT EXISTS idx_msg_deletion_events_pmid
  ON message_deletion_events(organization_id, provider_message_id);

-- 5. Chat history synchronization tracking jobs
CREATE TABLE IF NOT EXISTS message_sync_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('pending','in_progress','completed','partial','failed')),
  sync_type TEXT NOT NULL DEFAULT 'history_sync',
  chats_synced INTEGER NOT NULL DEFAULT 0,
  messages_synced INTEGER NOT NULL DEFAULT 0,
  contacts_synced INTEGER NOT NULL DEFAULT 0,
  is_latest INTEGER NOT NULL DEFAULT 0,
  progress INTEGER,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_sync_jobs_org_acc
  ON message_sync_jobs(organization_id, whatsapp_account_id, created_at DESC);

-- 6. Media archive table for downloaded images, videos, voice notes, documents
CREATE TABLE IF NOT EXISTS message_media (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  provider_message_id TEXT,
  media_type TEXT NOT NULL CHECK(media_type IN ('image','video','document','audio','sticker')),
  mime_type TEXT,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  file_hash TEXT,
  filename TEXT,
  caption TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_media_org_msg
  ON message_media(organization_id, message_id);

-- 7. Conversation audit logs (team monitoring, accountability & customer timeline)
CREATE TABLE IF NOT EXISTS conversation_audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','ai','system','customer')),
  actor_id TEXT,
  action TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_audit_logs_conv
  ON conversation_audit_logs(organization_id, conversation_id, created_at DESC);
