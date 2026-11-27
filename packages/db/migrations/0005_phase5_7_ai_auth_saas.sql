-- Phase 5 & Phase 7 Migration: AI Customer Support, Knowledge FTS5, Complete OAuth2/RBAC Auth, Audit Logs & SaaS Plans

-- 1. Expand organization_members roles to include 'owner', 'admin', 'manager', 'agent', 'viewer'
CREATE TABLE IF NOT EXISTS organization_members_new (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'admin', 'manager', 'agent', 'viewer')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO organization_members_new (id, organization_id, user_id, role, invited_by, created_at)
SELECT id, organization_id, user_id, role, invited_by, created_at FROM organization_members;

DROP TABLE organization_members;
ALTER TABLE organization_members_new RENAME TO organization_members;

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_user
  ON organization_members(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user
  ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org
  ON organization_members(organization_id);

-- 2. OAuth2 PKCE states & linked OAuth provider accounts
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  invite_token TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_provider_account
  ON oauth_accounts(provider, provider_account_id);
CREATE INDEX IF NOT EXISTS idx_oauth_user
  ON oauth_accounts(user_id);

-- 3. Organization Invitations & Audit Logs
CREATE TABLE IF NOT EXISTS organization_invites (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'manager', 'agent')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_invites_org
  ON organization_invites(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org
  ON audit_logs(organization_id, created_at DESC);

-- 4. SaaS Subscriptions & Organization Plan Tier
ALTER TABLE organizations
  ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro', 'business'));

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro', 'business')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'past_due', 'canceled')),
  billing_provider TEXT NOT NULL DEFAULT 'manual',
  external_customer_id TEXT,
  external_subscription_id TEXT,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 5. AI Customer Support Agents & Knowledge Base (D1 FTS5 synced via triggers)
CREATE TABLE IF NOT EXISTS ai_agents (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'WhatsApp Support Assistant',
  system_prompt TEXT NOT NULL DEFAULT 'You are a helpful customer support assistant for our business. Reply politely in the customer''s language (English or Urdu) using ONLY the provided knowledge base. If the answer is not in the knowledge base, say you will transfer to a human agent.',
  model_id TEXT NOT NULL DEFAULT '@cf/meta/llama-3.1-8b-instruct-fast',
  is_enabled INTEGER NOT NULL DEFAULT 0,
  daily_reply_limit INTEGER NOT NULL DEFAULT 50,
  daily_neuron_limit INTEGER NOT NULL DEFAULT 2500,
  supported_languages TEXT NOT NULL DEFAULT 'en,ur',
  handoff_keywords_json TEXT NOT NULL DEFAULT '["agent","human","representative","complaint","manager","support","مدد","نمائندہ","شکایت"]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_org
  ON knowledge_docs(organization_id, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  doc_id UNINDEXED,
  organization_id UNINDEXED,
  title,
  content
);

CREATE TRIGGER IF NOT EXISTS trg_knowledge_docs_ai AFTER INSERT ON knowledge_docs BEGIN
  INSERT INTO knowledge_fts(doc_id, organization_id, title, content)
  VALUES (new.id, new.organization_id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_docs_au AFTER UPDATE ON knowledge_docs BEGIN
  DELETE FROM knowledge_fts WHERE doc_id = old.id AND organization_id = old.organization_id;
  INSERT INTO knowledge_fts(doc_id, organization_id, title, content)
  VALUES (new.id, new.organization_id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_docs_ad AFTER DELETE ON knowledge_docs BEGIN
  DELETE FROM knowledge_fts WHERE doc_id = old.id AND organization_id = old.organization_id;
END;

-- 6. Conversation handoff tracking & daily AI usage counters
ALTER TABLE conversations
  ADD COLUMN handler_mode TEXT NOT NULL DEFAULT 'human' CHECK (handler_mode IN ('human', 'ai_bot'));
ALTER TABLE conversations
  ADD COLUMN handoff_reason TEXT;

ALTER TABLE usage_counters
  ADD COLUMN ai_replies INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_counters
  ADD COLUMN ai_neurons_est INTEGER NOT NULL DEFAULT 0;
