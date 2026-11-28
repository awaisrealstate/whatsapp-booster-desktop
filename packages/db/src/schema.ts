import { sqliteTable, text, integer, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

import type { PlanTier } from './plans.ts';

export const ORG_ROLES = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const CONVERSATION_HANDLER_MODES = ['human', 'ai_bot'] as const;
export type ConversationHandlerMode = (typeof CONVERSATION_HANDLER_MODES)[number];

export const OAUTH_PROVIDERS = ['google', 'github'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const INVITE_ROLES = ['admin', 'manager', 'agent'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const CLIENT_TYPES = ['web', 'desktop'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const TOKEN_PURPOSES = ['email_verification', 'password_reset'] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export const PIPELINE_STAGES = ['lead', 'contacted', 'qualified', 'won', 'lost'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const LIST_SOURCE_TYPES = ['manual', 'csv', 'tsv', 'xlsx', 'google_sheet', 'legacy_import'] as const;
export type ListSourceType = (typeof LIST_SOURCE_TYPES)[number];

export const CONSENT_STATUSES = ['opted_in', 'opted_out', 'unknown'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const SUPPRESSION_REASONS = ['stop_keyword', 'manual_opt_out', 'complaint', 'bounce'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const CONVERSATION_CHANNELS = [
  'official_meta_cloud',
  'unofficial_local_desktop',
  'unofficial_bridge',
  'manual_crm'
] as const;
export type ConversationChannelType = (typeof CONVERSATION_CHANNELS)[number];

export const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'snoozed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_HANDLING_STATUSES = [
  'unassigned',
  'assigned_team',
  'assigned_owner',
  'ai_handling',
  'human_handling',
  'waiting_customer',
  'resolved',
  'closed',
  'needs_attention'
] as const;
export type ConversationHandlingStatus = (typeof CONVERSATION_HANDLING_STATUSES)[number];

export const CONVERSATION_ASSIGNMENT_TYPES = [
  'unassigned',
  'team_member',
  'owner',
  'ai'
] as const;
export type ConversationAssignmentType = (typeof CONVERSATION_ASSIGNMENT_TYPES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound', 'internal_note'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_SENDER_KINDS = ['contact', 'agent', 'system'] as const;
export type MessageSenderKind = (typeof MESSAGE_SENDER_KINDS)[number];

export const MESSAGE_TYPES = ['text', 'template', 'image', 'document', 'audio', 'video'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = ['pending', 'queued', 'sent', 'delivered', 'read', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const PROVIDER_TYPES = ['official_meta_cloud', 'unofficial_local_desktop', 'unofficial_bridge'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const WA_CONNECTION_STATUSES = ['connected', 'disconnected', 'qr_pending', 'error'] as const;
export type WaConnectionStatus = (typeof WA_CONNECTION_STATUSES)[number];

export const QR_SESSION_STATUSES = [
  'connecting',
  'waiting_for_scan',
  'connected',
  'disconnected',
  'expired',
  'error'
] as const;
export type QrSessionStatus = (typeof QR_SESSION_STATUSES)[number];

export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION', 'CUSTOM_TEXT'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_APPROVAL_STATUSES = ['LOCAL', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type TemplateApprovalStatus = (typeof TEMPLATE_APPROVAL_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_SCHEDULE_TYPES = ['immediate', 'once', 'recurring'] as const;
export type CampaignScheduleType = (typeof CAMPAIGN_SCHEDULE_TYPES)[number];

export const CAMPAIGN_RECIPIENT_STATUSES = ['pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'] as const;
export type CampaignRecipientStatus = (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

export const WEBHOOK_PROCESSING_STATUSES = ['received', 'processed', 'ignored', 'failed'] as const;
export type WebhookProcessingStatus = (typeof WEBHOOK_PROCESSING_STATUSES)[number];

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  emailVerifiedAt: integer('email_verified_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  defaultCountryCode: text('default_country_code').notNull().default('92'),
  timezone: text('timezone').notNull().default('Asia/Karachi'),
  planTier: text('plan_tier').$type<PlanTier>().notNull().default('free'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export const organizationMembers = sqliteTable(
  'organization_members',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<OrgRole>().notNull().default('agent'),
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_org_members_org_user').on(table.organizationId, table.userId),
    index('idx_org_members_user').on(table.userId),
    index('idx_org_members_org').on(table.organizationId)
  ]
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    activeOrganizationId: text('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null'
    }),
    clientType: text('client_type').$type<ClientType>().notNull().default('web'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_sessions_user').on(table.userId),
    index('idx_sessions_active_org').on(table.activeOrganizationId)
  ]
);

export const verificationTokens = sqliteTable(
  'verification_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    purpose: text('purpose').$type<TokenPurpose>().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_verification_tokens_user').on(table.userId),
    index('idx_verification_tokens_email').on(table.email, table.purpose)
  ]
);

export const authRateLimits = sqliteTable('auth_rate_limits', {
  rateKey: text('rate_key').primaryKey(),
  attemptCount: integer('attempt_count').notNull().default(0),
  windowStartedAt: integer('window_started_at').notNull(),
  lockedUntil: integer('locked_until')
});

// Phase 2 CRM Tables
export const contacts = sqliteTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    rawPhone: text('raw_phone'),
    name: text('name').notNull().default('Valued Client'),
    email: text('email'),
    company: text('company'),
    customAttributesJson: text('custom_attributes_json').notNull().default('{}'),
    pipelineStage: text('pipeline_stage').$type<PipelineStage>().notNull().default('lead'),
    source: text('source').notNull().default('manual'),
    lastInboundAt: integer('last_inbound_at'),
    lastOutboundAt: integer('last_outbound_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_contacts_org_phone_active')
      .on(table.organizationId, table.phone)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_contacts_org_stage').on(table.organizationId, table.pipelineStage, table.deletedAt),
    index('idx_contacts_org_updated').on(table.organizationId, table.updatedAt)
  ]
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#00a884'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('idx_tags_org_name').on(table.organizationId, table.name)]
);

export const contactTags = sqliteTable(
  'contact_tags',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.contactId, table.tagId] }),
    index('idx_contact_tags_org').on(table.organizationId, table.tagId)
  ]
);

export const contactLists = sqliteTable(
  'contact_lists',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sourceType: text('source_type').$type<ListSourceType>().notNull().default('manual'),
    sourceUrl: text('source_url'),
    autoSyncEnabled: integer('auto_sync_enabled').notNull().default(0),
    syncIntervalMin: integer('sync_interval_min').notNull().default(5),
    lastSyncedAt: integer('last_synced_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('idx_contact_lists_org').on(table.organizationId, table.deletedAt, table.updatedAt)]
);

export const listMembers = sqliteTable(
  'list_members',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    listId: text('list_id')
      .notNull()
      .references(() => contactLists.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.contactId] }),
    index('idx_list_members_org').on(table.organizationId, table.listId)
  ]
);

export const consentRecords = sqliteTable(
  'consent_records',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    phone: text('phone').notNull(),
    channel: text('channel').notNull().default('whatsapp'),
    status: text('status').$type<ConsentStatus>().notNull(),
    source: text('source').notNull(),
    proofNote: text('proof_note'),
    recordedByUserId: text('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    recordedAt: integer('recorded_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_consent_org_phone').on(table.organizationId, table.phone, table.recordedAt),
    index('idx_consent_org_contact').on(table.organizationId, table.contactId)
  ]
);

export const suppressionList = sqliteTable(
  'suppression_list',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    reason: text('reason').$type<SuppressionReason>().notNull(),
    source: text('source').notNull(),
    notes: text('notes'),
    suppressedAt: integer('suppressed_at').notNull(),
    liftedAt: integer('lifted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('idx_suppression_org_phone').on(table.organizationId, table.phone)]
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channelType: text('channel_type').$type<ConversationChannelType>().notNull().default('manual_crm'),
    status: text('status').$type<ConversationStatus>().notNull().default('open'),
    handlingStatus: text('handling_status').$type<ConversationHandlingStatus>().notNull().default('unassigned'),
    assignmentType: text('assignment_type').$type<ConversationAssignmentType>().notNull().default('unassigned'),
    assignedUserId: text('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    whatsappAccountId: text('whatsapp_account_id').references(() => whatsappAccounts.id, {
      onDelete: 'set null'
    }),
    handlerMode: text('handler_mode').$type<ConversationHandlerMode>().notNull().default('human'),
    handoffReason: text('handoff_reason'),
    serviceWindowExpiresAt: integer('service_window_expires_at'),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessagePreview: text('last_message_preview'),
    lastMessageAt: integer('last_message_at'),
    remoteJid: text('remote_jid'),
    isGroup: integer('is_group').notNull().default(0),
    groupSubject: text('group_subject'),
    profilePictureUrl: text('profile_picture_url'),
    syncStatus: text('sync_status').notNull().default('synced'),
    lastSyncedAt: integer('last_synced_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_conv_org_inbox').on(table.organizationId, table.status, table.lastMessageAt),
    index('idx_conv_org_contact').on(table.organizationId, table.contactId),
    index('idx_conv_remote_jid').on(table.organizationId, table.remoteJid)
  ]
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<MessageDirection>().notNull(),
    senderKind: text('sender_kind').$type<MessageSenderKind>().notNull(),
    senderUserId: text('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    msgType: text('msg_type').$type<MessageType>().notNull().default('text'),
    body: text('body'),
    providerMessageId: text('provider_message_id'),
    idempotencyKey: text('idempotency_key'),
    status: text('status').$type<MessageStatus>().notNull().default('pending'),
    errorMessage: text('error_message'),
    isDeletedOnWhatsapp: integer('is_deleted_on_whatsapp').notNull().default(0),
    whatsappDeletedAt: integer('whatsapp_deleted_at'),
    isEdited: integer('is_edited').notNull().default(0),
    editedAt: integer('edited_at'),
    mediaUrl: text('media_url'),
    mediaMimeType: text('media_mime_type'),
    mediaFilename: text('media_filename'),
    mediaSizeBytes: integer('media_size_bytes'),
    senderPhone: text('sender_phone'),
    senderName: text('sender_name'),
    remoteJid: text('remote_jid'),
    source: text('source').default('whatsapp'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_msg_org_conv').on(table.organizationId, table.conversationId, table.createdAt),
    uniqueIndex('idx_msg_org_idempotency')
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('idx_msg_org_status').on(table.organizationId, table.status),
    index('idx_msg_org_pmid').on(table.organizationId, table.providerMessageId)
  ]
);

export const legacyImports = sqliteTable(
  'legacy_imports',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    importedByUserId: text('imported_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    sourceName: text('source_name').notNull(),
    templateText: text('template_text'),
    googleSheetUrl: text('google_sheet_url'),
    dailyLimit: integer('daily_limit'),
    batchSentCount: integer('batch_sent_count').notNull().default(0),
    totalContacts: integer('total_contacts').notNull().default(0),
    importedContacts: integer('imported_contacts').notNull().default(0),
    preservedSentCount: integer('preserved_sent_count').notNull().default(0),
    preservedFailedCount: integer('preserved_failed_count').notNull().default(0),
    rawSummaryJson: text('raw_summary_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('idx_legacy_imports_org').on(table.organizationId, table.createdAt)]
);

// Phase 3 & Campaign Engine Tables
export const whatsappAccounts = sqliteTable(
  'whatsapp_accounts',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    providerType: text('provider_type').$type<ProviderType>().notNull().default('official_meta_cloud'),
    phoneNumber: text('phone_number'),
    connectionStatus: text('connection_status').$type<WaConnectionStatus>().notNull().default('disconnected'),
    metaWabaId: text('meta_waba_id'),
    metaPhoneNumberId: text('meta_phone_number_id'),
    metaAccessTokenEnc: text('meta_access_token_enc'),
    metaAppSecretEnc: text('meta_app_secret_enc'),
    metaWebhookVerifyHash: text('meta_webhook_verify_hash'),
    isDefault: integer('is_default').notNull().default(0),
    lastConnectedAt: integer('last_connected_at'),
    lastHealthCheckAt: integer('last_health_check_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_wa_accounts_org').on(table.organizationId),
    uniqueIndex('idx_wa_accounts_meta_phone_id')
      .on(table.metaPhoneNumberId)
      .where(sql`${table.metaPhoneNumberId} IS NOT NULL`),
    index('idx_wa_accounts_verify_hash').on(table.metaWebhookVerifyHash)
  ]
);

export const waQrSessions = sqliteTable(
  'wa_qr_sessions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id')
      .notNull()
      .unique()
      .references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
    status: text('status').$type<QrSessionStatus>().notNull().default('disconnected'),
    qrDataUrl: text('qr_data_url'),
    qrExpiresAt: integer('qr_expires_at'),
    connectedPhone: text('connected_phone'),
    lastConnectedAt: integer('last_connected_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('idx_wa_qr_sessions_org').on(table.organizationId, table.updatedAt)]
);

export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id').references(() => whatsappAccounts.id, {
      onDelete: 'set null'
    }),
    providerType: text('provider_type').$type<ProviderType>().notNull().default('official_meta_cloud'),
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadJson: text('payload_json').notNull(),
    processingStatus: text('processing_status')
      .$type<WebhookProcessingStatus>()
      .notNull()
      .default('received'),
    errorMessage: text('error_message'),
    receivedAt: integer('received_at').notNull(),
    processedAt: integer('processed_at')
  },
  (table) => [
    uniqueIndex('idx_webhook_events_dedup')
      .on(table.whatsappAccountId, table.externalEventId)
      .where(sql`${table.whatsappAccountId} IS NOT NULL`),
    index('idx_webhook_events_org_time').on(table.organizationId, table.receivedAt)
  ]
);

export const templates = sqliteTable(
  'templates',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id').references(() => whatsappAccounts.id, {
      onDelete: 'cascade'
    }),
    name: text('name').notNull(),
    language: text('language').notNull().default('en'),
    category: text('category').$type<TemplateCategory>().notNull().default('UTILITY'),
    bodyText: text('body_text').notNull(),
    headerJson: text('header_json'),
    buttonsJson: text('buttons_json'),
    metaTemplateId: text('meta_template_id'),
    approvalStatus: text('approval_status').$type<TemplateApprovalStatus>().notNull().default('LOCAL'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_templates_org').on(table.organizationId, table.approvalStatus),
    uniqueIndex('idx_templates_meta_sync')
      .on(table.organizationId, table.whatsappAccountId, table.metaTemplateId)
      .where(sql`${table.metaTemplateId} IS NOT NULL`)
  ]
);

export const campaigns = sqliteTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id')
      .notNull()
      .references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
    listId: text('list_id').references(() => contactLists.id, { onDelete: 'set null' }),
    templateId: text('template_id').references(() => templates.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    messageOverride: text('message_override'),
    status: text('status').$type<CampaignStatus>().notNull().default('draft'),
    scheduleType: text('schedule_type').$type<CampaignScheduleType>().notNull().default('immediate'),
    scheduledAt: integer('scheduled_at'),
    timezone: text('timezone').notNull().default('Asia/Karachi'),
    dailyLimit: integer('daily_limit').notNull().default(30),
    totalRecipients: integer('total_recipients').notNull().default(0),
    queuedCount: integer('queued_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    readCount: integer('read_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_campaigns_schedule').on(table.status, table.scheduledAt),
    index('idx_campaigns_org').on(table.organizationId, table.deletedAt, table.createdAt)
  ]
);

export const campaignRecipients = sqliteTable(
  'campaign_recipients',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    contactName: text('contact_name').notNull().default('Valued Client'),
    customVarsJson: text('custom_vars_json').notNull().default('{}'),
    status: text('status').$type<CampaignRecipientStatus>().notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    providerMessageId: text('provider_message_id'),
    errorMessage: text('error_message'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    sentAt: integer('sent_at'),
    deliveredAt: integer('delivered_at'),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_cr_campaign_contact').on(table.campaignId, table.contactId),
    index('idx_cr_due').on(table.campaignId, table.status, table.nextAttemptAt),
    index('idx_cr_provider_msg')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`)
  ]
);

export const usageCounters = sqliteTable(
  'usage_counters',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    periodKey: text('period_key').notNull(),
    outboundMessages: integer('outbound_messages').notNull().default(0),
    aiReplies: integer('ai_replies').notNull().default(0),
    aiNeuronsEst: integer('ai_neurons_est').notNull().default(0),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.periodKey] })]
);

// Phase 5 & Phase 7 Tables: OAuth2, Invites, Audit Logs, Subscriptions & AI Support
export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  provider: text('provider').$type<OAuthProvider>().notNull(),
  codeVerifier: text('code_verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  inviteToken: text('invite_token'),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull()
});

export const oauthAccounts = sqliteTable(
  'oauth_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<OAuthProvider>().notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    email: text('email').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_oauth_provider_account').on(table.provider, table.providerAccountId),
    index('idx_oauth_user').on(table.userId)
  ]
);

export const organizationInvites = sqliteTable(
  'organization_invites',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<InviteRole>().notNull().default('agent'),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: text('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: integer('expires_at').notNull(),
    acceptedAt: integer('accepted_at'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('idx_org_invites_org').on(table.organizationId, table.createdAt)]
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    ipAddress: text('ip_address'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('idx_audit_logs_org').on(table.organizationId, table.createdAt)]
);

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  planTier: text('plan_tier').$type<PlanTier>().notNull().default('free'),
  status: text('status').$type<SubscriptionStatus>().notNull().default('active'),
  billingProvider: text('billing_provider').notNull().default('manual'),
  externalCustomerId: text('external_customer_id'),
  externalSubscriptionId: text('external_subscription_id'),
  currentPeriodStart: integer('current_period_start').notNull(),
  currentPeriodEnd: integer('current_period_end').notNull(),
  cancelAtPeriodEnd: integer('cancel_at_period_end').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export interface BusinessProfile {
  businessName?: string;
  businessDescription?: string;
  productsAndServices?: string;
  pricesAndPackages?: string;
  openingHours?: string;
  faqs?: string;
  location?: string;
  contactInfo?: string;
  customerServiceInstructions?: string;
  preferredLanguage?: string;
  tone?: 'professional' | 'friendly' | 'formal' | 'casual' | string;
  customInstructions?: string;
}

export const aiAgents = sqliteTable('ai_agents', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  modelId: text('model_id').notNull().default('@cf/meta/llama-3.1-8b-instruct-fast'),
  isEnabled: integer('is_enabled').notNull().default(0),
  dailyReplyLimit: integer('daily_reply_limit').notNull().default(50),
  dailyNeuronLimit: integer('daily_neuron_limit').notNull().default(2500),
  supportedLanguages: text('supported_languages').notNull().default('en,ur'),
  handoffKeywordsJson: text('handoff_keywords_json').notNull(),
  businessProfileJson: text('business_profile_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export const knowledgeDocs = sqliteTable(
  'knowledge_docs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    language: text('language').notNull().default('en'),
    category: text('category'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('idx_knowledge_docs_org').on(table.organizationId, table.updatedAt)]
);

// ── Migration 0007: Scheduled Messages ───────────────────────────────────────

export type ScheduledMessageStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
export type ScheduledMessageRecipientType = 'contact' | 'list' | 'phones';

export const scheduledMessages = sqliteTable(
  'scheduled_messages',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    status: text('status')
      .$type<ScheduledMessageStatus>()
      .notNull()
      .default('pending'),
    recipientType: text('recipient_type')
      .$type<ScheduledMessageRecipientType>()
      .notNull(),
    recipientContactIds: text('recipient_contact_ids'),
    recipientListId: text('recipient_list_id'),
    recipientPhones: text('recipient_phones'),
    messageText: text('message_text'),
    templateId: text('template_id'),
    templateVariables: text('template_variables'),
    mediaUrl: text('media_url'),
    mediaType: text('media_type'),
    scheduledAt: integer('scheduled_at').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    executedAt: integer('executed_at'),
    idempotencyKey: text('idempotency_key').unique(),
    errorMessage: text('error_message'),
    providerMessageIds: text('provider_message_ids'),
    recipientCount: integer('recipient_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_scheduled_messages_org_status').on(table.organizationId, table.status, table.scheduledAt),
    index('idx_scheduled_messages_due').on(table.status, table.scheduledAt),
  ]
);

// ── WhatsApp Status Records ───────────────────────────────────────────────────

export type WaStatusRecordStatus = 'draft' | 'publishing' | 'published' | 'failed' | 'scheduled';

export const waStatusRecords = sqliteTable(
  'wa_status_records',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id').notNull(),
    providerType: text('provider_type').notNull().default('unofficial_bridge'),
    contentType: text('content_type').notNull(),
    contentText: text('content_text'),
    mediaUrl: text('media_url'),
    mediaCaption: text('media_caption'),
    backgroundColor: text('background_color'),
    font: text('font'),
    status: text('status')
      .$type<WaStatusRecordStatus>()
      .notNull()
      .default('draft'),
    scheduledAt: integer('scheduled_at'),
    publishedAt: integer('published_at'),
    errorMessage: text('error_message'),
    providerResponse: text('provider_response'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_wa_status_records_org').on(table.organizationId, table.createdAt)]
);

// ── Call Records ─────────────────────────────────────────────────────────────

export const waCallRecords = sqliteTable(
  'wa_call_records',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id').notNull(),
    providerType: text('provider_type').notNull().default('unofficial_bridge'),
    direction: text('direction'),
    fromPhone: text('from_phone'),
    toPhone: text('to_phone'),
    status: text('status'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    durationSeconds: integer('duration_seconds'),
    providerCallId: text('provider_call_id').unique(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_wa_call_records_org').on(table.organizationId, table.startedAt)]
);

// ── AI Business Recommendations ───────────────────────────────────────────────

export type AiRecCategory = 'retention' | 'engagement' | 'campaign' | 'usage' | 'billing' | 'general';
export type AiRiskLevel = 'low' | 'medium' | 'high';

export const aiBusinessRecommendations = sqliteTable(
  'ai_business_recommendations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    targetOrgId: text('target_org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    generatedBy: text('generated_by').notNull().default('system'),
    category: text('category').$type<AiRecCategory>().notNull(),
    riskLevel: text('risk_level').$type<AiRiskLevel>(),
    title: text('title').notNull(),
    evidence: text('evidence').notNull(),
    dateRangeStart: integer('date_range_start'),
    dateRangeEnd: integer('date_range_end'),
    recommendation: text('recommendation').notNull(),
    suggestedAction: text('suggested_action'),
    confidence: text('confidence'),
    isPrediction: integer('is_prediction').notNull().default(0),
    dismissedAt: integer('dismissed_at'),
    actioned_at: integer('actioned_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_ai_recs_org').on(table.organizationId, table.createdAt),
    index('idx_ai_recs_target').on(table.targetOrgId, table.createdAt),
  ]
);

// ── Chat Assignment & AI Human Handover History ──────────────────────────────

export const conversationAssignmentHistory = sqliteTable(
  'conversation_assignment_history',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    previousHandlerType: text('previous_handler_type'),
    previousUserId: text('previous_user_id').references(() => users.id, { onDelete: 'set null' }),
    newHandlerType: text('new_handler_type').notNull(),
    newUserId: text('new_user_id').references(() => users.id, { onDelete: 'set null' }),
    changedByUserId: text('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_conv_assign_hist').on(table.organizationId, table.conversationId, table.createdAt)
  ]
);

// ── Complete WhatsApp Chat History Sync & Permanent CRM Archive ──────────────

export const messageVersions = sqliteTable(
  'message_versions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id'),
    body: text('body'),
    mediaUrl: text('media_url'),
    versionNumber: integer('version_number').notNull().default(1),
    editedAt: integer('edited_at').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_msg_versions_msg').on(table.organizationId, table.messageId, table.versionNumber)
  ]
);

export const messageDeletionEvents = sqliteTable(
  'message_deletion_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id').notNull(),
    deletedByJid: text('deleted_by_jid'),
    deletionType: text('deletion_type').notNull().default('revoke'),
    deletedAt: integer('deleted_at').notNull(),
    rawEventJson: text('raw_event_json'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_msg_deletion_events_msg').on(table.organizationId, table.messageId),
    index('idx_msg_deletion_events_pmid').on(table.organizationId, table.providerMessageId)
  ]
);

export const messageSyncJobs = sqliteTable(
  'message_sync_jobs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    whatsappAccountId: text('whatsapp_account_id')
      .notNull()
      .references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('in_progress'),
    syncType: text('sync_type').notNull().default('history_sync'),
    chatsSynced: integer('chats_synced').notNull().default(0),
    messagesSynced: integer('messages_synced').notNull().default(0),
    contactsSynced: integer('contacts_synced').notNull().default(0),
    isLatest: integer('is_latest').notNull().default(0),
    progress: integer('progress'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at').notNull(),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('idx_msg_sync_jobs_org_acc').on(table.organizationId, table.whatsappAccountId, table.createdAt)
  ]
);

export const messageMedia = sqliteTable(
  'message_media',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id'),
    mediaType: text('media_type').notNull(),
    mimeType: text('mime_type'),
    filePath: text('file_path').notNull(),
    fileSize: integer('file_size'),
    fileHash: text('file_hash'),
    filename: text('filename'),
    caption: text('caption'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_message_media_org_msg').on(table.organizationId, table.messageId)
  ]
);

export const conversationAuditLogs = sqliteTable(
  'conversation_audit_logs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    metadataJson: text('metadata_json'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('idx_conv_audit_logs_conv').on(table.organizationId, table.conversationId, table.createdAt)
  ]
);
