-- Migration 0007: Scheduled Messages, WhatsApp Status, Call Records, AI Recommendations & Chat Assignment History
-- All tables and columns are additive (no DROP, no DELETE, no ALTER COLUMN removal).
-- Existing data is fully preserved.

-- Add handling_status and assignment_type to conversations
ALTER TABLE conversations ADD COLUMN handling_status TEXT NOT NULL DEFAULT 'unassigned';
ALTER TABLE conversations ADD COLUMN assignment_type TEXT NOT NULL DEFAULT 'unassigned';

-- Add business_profile_json to ai_agents for Gemini Chatbot configuration
ALTER TABLE ai_agents ADD COLUMN business_profile_json TEXT;

-- Chat Assignment & AI Human Handover History
CREATE TABLE IF NOT EXISTS conversation_assignment_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  previous_handler_type TEXT,          -- 'unassigned' | 'team_member' | 'owner' | 'ai'
  previous_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  new_handler_type TEXT NOT NULL,      -- 'unassigned' | 'team_member' | 'owner' | 'ai'
  new_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_assign_hist
  ON conversation_assignment_history(organization_id, conversation_id, created_at DESC);

-- Scheduled messages: quick-send composer + individual scheduler
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','cancelled')),
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('contact','list','phones')),
  recipient_contact_ids TEXT,          -- JSON array of contact IDs
  recipient_list_id TEXT REFERENCES contact_lists(id) ON DELETE SET NULL,
  recipient_phones TEXT,               -- JSON array of raw phone numbers (fallback)
  message_text TEXT,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  template_variables TEXT,             -- JSON object
  media_url TEXT,
  media_type TEXT CHECK(media_type IN ('image','video','document','audio') OR media_type IS NULL),
  scheduled_at INTEGER NOT NULL,       -- epoch ms
  timezone TEXT NOT NULL DEFAULT 'UTC',
  executed_at INTEGER,
  idempotency_key TEXT UNIQUE,
  error_message TEXT,
  provider_message_ids TEXT,           -- JSON array
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_org_status
  ON scheduled_messages(organization_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_idempotency
  ON scheduled_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages(status, scheduled_at) WHERE status = 'pending';

-- WhatsApp Status records (Baileys unofficial bridge only)
CREATE TABLE IF NOT EXISTS wa_status_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL DEFAULT 'unofficial_bridge',
  content_type TEXT NOT NULL CHECK(content_type IN ('text','image','video','document')),
  content_text TEXT,
  media_url TEXT,
  media_caption TEXT,
  background_color TEXT,
  font TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','publishing','published','failed','scheduled')),
  scheduled_at INTEGER,
  published_at INTEGER,
  error_message TEXT,
  provider_response TEXT,              -- raw JSON from bridge
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_status_records_org
  ON wa_status_records(organization_id, created_at DESC);

-- Call records placeholder (populated by Baileys call events via QR bridge)
CREATE TABLE IF NOT EXISTS wa_call_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  whatsapp_account_id TEXT NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL DEFAULT 'unofficial_bridge',
  direction TEXT CHECK(direction IN ('inbound','outbound')),
  from_phone TEXT,
  to_phone TEXT,
  status TEXT CHECK(status IN ('missed','answered','rejected','failed')),
  started_at INTEGER,
  ended_at INTEGER,
  duration_seconds INTEGER,
  provider_call_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_call_records_org
  ON wa_call_records(organization_id, started_at DESC);

-- AI business recommendations: retention, engagement, churn risk
CREATE TABLE IF NOT EXISTS ai_business_recommendations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  generated_by TEXT NOT NULL DEFAULT 'system' CHECK(generated_by IN ('system','admin')),
  category TEXT NOT NULL CHECK(category IN ('retention','engagement','campaign','usage','billing','general')),
  risk_level TEXT CHECK(risk_level IN ('low','medium','high')),
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,              -- JSON: observed facts
  date_range_start INTEGER,
  date_range_end INTEGER,
  recommendation TEXT NOT NULL,
  suggested_action TEXT,
  confidence TEXT CHECK(confidence IN ('low','medium','high')),
  is_prediction INTEGER NOT NULL DEFAULT 0,
  dismissed_at INTEGER,
  actioned_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_recs_org
  ON ai_business_recommendations(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_recs_target
  ON ai_business_recommendations(target_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_recs_risk
  ON ai_business_recommendations(risk_level, created_at DESC);
