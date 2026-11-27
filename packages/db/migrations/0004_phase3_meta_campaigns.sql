-- Phase 3 & Core Campaign Engine Migration (Cloudflare D1 / SQLite)
-- Adds whatsapp_accounts, webhook_events, templates, campaigns, campaign_recipients, usage_counters,
-- plus whatsapp_account_id on conversations and provider_message_id lookup index on messages.

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'official_meta_cloud' CHECK (provider_type IN ('official_meta_cloud', 'unofficial_local_desktop', 'unofficial_bridge')),
  phone_number TEXT,
  connection_status TEXT NOT NULL DEFAULT 'disconnected' CHECK (connection_status IN ('connected', 'disconnected', 'qr_pending', 'error')),
  meta_waba_id TEXT,
  meta_phone_number_id TEXT,
  meta_access_token_enc TEXT,
  meta_app_secret_enc TEXT,
  meta_webhook_verify_hash TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_health_check_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_accounts_org
  ON whatsapp_accounts(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_accounts_meta_phone_id
  ON whatsapp_accounts(meta_phone_number_id) WHERE meta_phone_number_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_accounts_verify_hash
  ON whatsapp_accounts(meta_webhook_verify_hash);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  provider_type TEXT NOT NULL DEFAULT 'official_meta_cloud',
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  error_message TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_dedup
  ON webhook_events(whatsapp_account_id, external_event_id) WHERE whatsapp_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_events_org_time
  ON webhook_events(organization_id, received_at DESC);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION', 'CUSTOM_TEXT')),
  body_text TEXT NOT NULL,
  header_json TEXT,
  buttons_json TEXT,
  meta_template_id TEXT,
  approval_status TEXT NOT NULL DEFAULT 'LOCAL' CHECK (approval_status IN ('LOCAL', 'PENDING', 'APPROVED', 'REJECTED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_org
  ON templates(organization_id, approval_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_meta_sync
  ON templates(organization_id, whatsapp_account_id, meta_template_id) WHERE meta_template_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  list_id TEXT REFERENCES contact_lists(id) ON DELETE SET NULL,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  message_override TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  schedule_type TEXT NOT NULL DEFAULT 'immediate' CHECK (schedule_type IN ('immediate', 'once', 'recurring')),
  scheduled_at INTEGER,
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  daily_limit INTEGER NOT NULL DEFAULT 30,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_at INTEGER,
  completed_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaigns_schedule
  ON campaigns(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_org
  ON campaigns(organization_id, deleted_at, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT 'Valued Client',
  custom_vars_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_message_id TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  sent_at INTEGER,
  delivered_at INTEGER,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_campaign_contact
  ON campaign_recipients(campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_cr_due
  ON campaign_recipients(campaign_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_cr_provider_msg
  ON campaign_recipients(provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS usage_counters (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  outbound_messages INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_msg_provider_id
  ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN whatsapp_account_id TEXT REFERENCES whatsapp_accounts(id) ON DELETE SET NULL;
