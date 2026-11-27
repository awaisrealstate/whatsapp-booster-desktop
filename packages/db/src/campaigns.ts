import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { formatMessageText } from '@wacrm/shared';
import { MetaCloudProvider, ProviderApiError, QrBridgeClient, type WhatsAppProvider } from '@wacrm/providers';
import type { AppDatabase } from './client.ts';
import { CrmError, checkCampaignEligibility } from './crm.ts';
import type { OrgContext } from './tenant.ts';
import {
  getDecryptedMetaCredentials,
  getWhatsappAccountForOrg,
  isRetryableProviderError,
  syncCampaignAggregateCounters
} from './whatsapp.ts';
import {
  campaignRecipients,
  campaigns,
  consentRecords,
  contactLists,
  contacts,
  conversations,
  listMembers,
  messages,
  suppressionList,
  templates,
  usageCounters,
  type CampaignScheduleType
} from './schema.ts';

const RECIPIENT_INSERT_BATCH_SIZE = 15;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [10_000, 30_000, 90_000] as const;

export interface CampaignQueueMessageBody {
  organizationId: string;
  campaignId: string;
  recipientIds: string[];
}

export interface CampaignQueueProducer {
  sendBatch(messages: Array<{ body: CampaignQueueMessageBody }>): Promise<unknown>;
}

function getUtcPeriodKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function extractBodyParameters(templateBody: string, vars: Record<string, string>): string[] {
  const matches = templateBody.match(/\{\{(\d+)\}\}/g);
  if (!matches || matches.length === 0) return [];
  const highest = matches.reduce((max, tok) => Math.max(max, Number(tok.replace(/\D/g, ''))), 0);
  const params: string[] = [];
  for (let i = 1; i <= highest; i++) {
    if (i === 1) params.push(vars.name || 'Valued Client');
    else if (i === 2) params.push(vars.company || vars[`var${i}`] || vars.phone || '');
    else params.push(vars[`var${i}`] ?? '');
  }
  return params;
}

function parseJsonVars(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {}
  return {};
}

// ============================================================================
// CAMPAIGNS CRUD & LIFECYCLE
// ============================================================================

export async function createCampaign(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    name: string;
    whatsappAccountId: string;
    listId: string;
    templateId?: string | null;
    messageOverride?: string | null;
    scheduleType?: CampaignScheduleType;
    scheduledAt?: number | null;
    timezone?: string;
    dailyLimit?: number;
  }
) {
  const account = await getWhatsappAccountForOrg(db, ctx, input.whatsappAccountId);
  if (!account) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
  }

  const listRows = await db
    .select()
    .from(contactLists)
    .where(
      and(
        eq(contactLists.organizationId, ctx.organizationId),
        eq(contactLists.id, input.listId),
        isNull(contactLists.deletedAt)
      )
    )
    .limit(1);
  if (!listRows[0]) {
    throw new CrmError(404, 'LIST_NOT_FOUND', 'Target contact list not found.');
  }

  let tpl: typeof templates.$inferSelect | null = null;
  if (input.templateId) {
    const tplRows = await db
      .select()
      .from(templates)
      .where(and(eq(templates.organizationId, ctx.organizationId), eq(templates.id, input.templateId)))
      .limit(1);
    if (!tplRows[0]) throw new CrmError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
    tpl = tplRows[0];
  }

  if (!tpl && !input.messageOverride?.trim()) {
    throw new CrmError(400, 'MESSAGE_REQUIRED', 'Provide either templateId or messageOverride.');
  }

  const now = Date.now();
  const scheduleType = input.scheduleType ?? 'immediate';
  if (scheduleType === 'once' && (!input.scheduledAt || input.scheduledAt <= 0)) {
    throw new CrmError(400, 'SCHEDULE_TIME_REQUIRED', 'scheduledAt timestamp is required for scheduled campaigns.');
  }

  const initialStatus =
    scheduleType === 'once' && input.scheduledAt && input.scheduledAt > now ? 'scheduled' : 'draft';

  const campaignId = crypto.randomUUID();
  await db.insert(campaigns).values({
    id: campaignId,
    organizationId: ctx.organizationId,
    whatsappAccountId: input.whatsappAccountId,
    listId: input.listId,
    templateId: tpl?.id ?? null,
    name: input.name.trim(),
    messageOverride: input.messageOverride?.trim() || null,
    status: initialStatus,
    scheduleType,
    scheduledAt: input.scheduledAt ?? null,
    timezone: input.timezone?.trim() || 'Asia/Karachi',
    dailyLimit: Math.min(Math.max(1, input.dailyLimit ?? 30), 10_000),
    createdByUserId: ctx.userId,
    createdAt: now,
    updatedAt: now
  });

  // Materialize active list members into durable D1 campaign_recipients
  const memberContacts = await db
    .select({
      contactId: contacts.id,
      phone: contacts.phone,
      name: contacts.name,
      customAttributesJson: contacts.customAttributesJson
    })
    .from(listMembers)
    .innerJoin(contacts, eq(listMembers.contactId, contacts.id))
    .where(
      and(
        eq(listMembers.organizationId, ctx.organizationId),
        eq(listMembers.listId, input.listId),
        isNull(contacts.deletedAt)
      )
    );

  // Preload active suppressions + latest opt-outs once per campaign creation
  const suppressedRows = await db
    .select({ phone: suppressionList.phone, reason: suppressionList.reason })
    .from(suppressionList)
    .where(
      and(eq(suppressionList.organizationId, ctx.organizationId), isNull(suppressionList.liftedAt))
    );
  const suppressedMap = new Map(suppressedRows.map((s) => [s.phone, s.reason]));

  const optedOutRows = await db
    .select({ phone: consentRecords.phone, status: consentRecords.status })
    .from(consentRecords)
    .where(eq(consentRecords.organizationId, ctx.organizationId))
    .orderBy(desc(consentRecords.recordedAt));
  const latestConsentMap = new Map<string, string>();
  for (const row of optedOutRows) {
    if (!latestConsentMap.has(row.phone)) {
      latestConsentMap.set(row.phone, row.status);
    }
  }

  const inserts = memberContacts.map((mc) => {
    const supReason = suppressedMap.get(mc.phone);
    const consentStatus = latestConsentMap.get(mc.phone);
    const skipReason = supReason
      ? `SUPPRESSED:${supReason}`
      : consentStatus === 'opted_out'
        ? 'OPTED_OUT'
        : null;

    return db.insert(campaignRecipients).values({
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      campaignId,
      contactId: mc.contactId,
      phone: mc.phone,
      contactName: mc.name,
      customVarsJson: mc.customAttributesJson || '{}',
      status: skipReason ? 'skipped' : 'pending',
      idempotencyKey: `camp:${campaignId}:contact:${mc.contactId}`,
      errorMessage: skipReason,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    });
  });

  for (let i = 0; i < inserts.length; i += RECIPIENT_INSERT_BATCH_SIZE) {
    const slice = inserts.slice(i, i + RECIPIENT_INSERT_BATCH_SIZE);
    const first = slice[0];
    if (first) await db.batch([first, ...slice.slice(1)]);
  }

  await syncCampaignAggregateCounters(db, ctx.organizationId, campaignId);
  return getCampaignById(db, ctx, campaignId);
}

export async function listCampaigns(db: AppDatabase, ctx: OrgContext) {
  return db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.organizationId, ctx.organizationId), isNull(campaigns.deletedAt)))
    .orderBy(desc(campaigns.createdAt));
}

export async function getCampaignById(db: AppDatabase, ctx: OrgContext, campaignId: string) {
  const rows = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.organizationId, ctx.organizationId),
        eq(campaigns.id, campaignId),
        isNull(campaigns.deletedAt)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function transitionCampaignStatus(
  db: AppDatabase,
  ctx: OrgContext,
  campaignId: string,
  action: 'launch' | 'pause' | 'resume' | 'cancel'
) {
  const camp = await getCampaignById(db, ctx, campaignId);
  if (!camp) throw new CrmError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');

  const now = Date.now();
  let nextStatus = camp.status;
  let startedAt = camp.startedAt;

  if (action === 'launch') {
    if (!['draft', 'scheduled', 'paused'].includes(camp.status)) {
      throw new CrmError(409, 'INVALID_CAMPAIGN_STATE', `Cannot launch campaign in status '${camp.status}'.`);
    }
    nextStatus = 'running';
    startedAt = camp.startedAt ?? now;
  } else if (action === 'pause') {
    if (!['running', 'scheduled'].includes(camp.status)) {
      throw new CrmError(409, 'INVALID_CAMPAIGN_STATE', `Cannot pause campaign in status '${camp.status}'.`);
    }
    nextStatus = 'paused';
  } else if (action === 'resume') {
    if (camp.status !== 'paused') {
      throw new CrmError(409, 'INVALID_CAMPAIGN_STATE', 'Only paused campaigns can be resumed.');
    }
    nextStatus = 'running';
    startedAt = camp.startedAt ?? now;
  } else if (action === 'cancel') {
    if (['completed', 'cancelled'].includes(camp.status)) {
      throw new CrmError(409, 'INVALID_CAMPAIGN_STATE', `Campaign is already '${camp.status}'.`);
    }
    nextStatus = 'cancelled';
  }

  await db
    .update(campaigns)
    .set({ status: nextStatus, startedAt, updatedAt: now })
    .where(and(eq(campaigns.organizationId, ctx.organizationId), eq(campaigns.id, campaignId)));

  await syncCampaignAggregateCounters(db, ctx.organizationId, campaignId);
  return getCampaignById(db, ctx, campaignId);
}

export async function getCampaignReport(db: AppDatabase, ctx: OrgContext, campaignId: string) {
  const campaign = await getCampaignById(db, ctx, campaignId);
  if (!campaign) throw new CrmError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');

  const recipients = await db
    .select({
      id: campaignRecipients.id,
      contactId: campaignRecipients.contactId,
      phone: campaignRecipients.phone,
      contactName: campaignRecipients.contactName,
      status: campaignRecipients.status,
      providerMessageId: campaignRecipients.providerMessageId,
      errorMessage: campaignRecipients.errorMessage,
      attemptCount: campaignRecipients.attemptCount,
      sentAt: campaignRecipients.sentAt,
      deliveredAt: campaignRecipients.deliveredAt,
      readAt: campaignRecipients.readAt
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.organizationId, ctx.organizationId),
        eq(campaignRecipients.campaignId, campaignId)
      )
    );

  return { campaign, recipients };
}

// ============================================================================
// INBOX CONVERSATION OUTBOUND SEND VIA OFFICIAL META CLOUD API
// ============================================================================

export async function sendConversationReplyViaMeta(
  db: AppDatabase,
  ctx: OrgContext,
  params: {
    conversationId: string;
    whatsappAccountId?: string | null;
    templateId?: string | null;
    body?: string | null;
    idempotencyKey?: string | null;
    encryptionKey: string | undefined;
    provider?: WhatsAppProvider;
    qrBridge?: QrBridgeClient;
  }
) {
  const convRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, ctx.organizationId),
        eq(conversations.id, params.conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');

  const contactRows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        eq(contacts.id, conv.contactId),
        isNull(contacts.deletedAt)
      )
    )
    .limit(1);
  const contact = contactRows[0];
  if (!contact) throw new CrmError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');

  const eligibility = await checkCampaignEligibility(db, ctx, contact.phone);
  if (!eligibility.eligible) {
    throw new CrmError(
      422,
      'CONTACT_SUPPRESSED',
      `Cannot send WhatsApp message: recipient is opted out (${eligibility.reason}).`
    );
  }

  if (params.idempotencyKey) {
    const dup = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, ctx.organizationId),
          eq(messages.idempotencyKey, params.idempotencyKey)
        )
      )
      .limit(1);
    if (dup[0]) return dup[0];
  }

  const targetAccountId = params.whatsappAccountId || conv.whatsappAccountId;
  if (!targetAccountId) {
    throw new CrmError(400, 'WHATSAPP_ACCOUNT_REQUIRED', 'No WhatsApp account linked to send this message.');
  }

  const targetAccount = await getWhatsappAccountForOrg(db, ctx, targetAccountId);
  if (!targetAccount) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
  }

  const now = Date.now();
  let tpl: typeof templates.$inferSelect | null = null;
  if (params.templateId) {
    const tplRows = await db
      .select()
      .from(templates)
      .where(and(eq(templates.organizationId, ctx.organizationId), eq(templates.id, params.templateId)))
      .limit(1);
    if (!tplRows[0]) throw new CrmError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
    tpl = tplRows[0];
  }

  const vars = parseJsonVars(contact.customAttributesJson);
  let renderedBody = '';
  let sendResult;
  const targetChannelType =
    targetAccount.providerType === 'unofficial_bridge' ? 'unofficial_local_desktop' : 'official_meta_cloud';

  try {
    if (targetAccount.providerType === 'unofficial_bridge') {
      if (targetAccount.connectionStatus !== 'connected') {
        throw new CrmError(
          422,
          'QR_SESSION_NOT_CONNECTED',
          'QR WhatsApp session is not connected. Scan or reconnect before sending.'
        );
      }
      if (!params.qrBridge) {
        throw new CrmError(503, 'QR_BRIDGE_UNCONFIGURED', 'QR session service is not configured.');
      }
      const rawText = params.body?.trim() || tpl?.bodyText || '';
      if (!rawText) throw new CrmError(400, 'MESSAGE_BODY_REQUIRED', 'Message body is required.');
      renderedBody = formatMessageText(rawText, { name: contact.name, phone: contact.phone, customVars: vars });
      sendResult = await params.qrBridge.sendTextMessage({
        organizationId: ctx.organizationId,
        whatsappAccountId: targetAccount.id,
        toPhone: contact.phone,
        text: renderedBody
      });
    } else {
      const creds = await getDecryptedMetaCredentials(db, ctx, targetAccountId, params.encryptionKey);
      const provider = params.provider ?? new MetaCloudProvider();

      if (tpl && tpl.approvalStatus === 'APPROVED' && tpl.category !== 'CUSTOM_TEXT') {
        const bodyParams = extractBodyParameters(tpl.bodyText, vars);
        renderedBody = tpl.bodyText;
        sendResult = await provider.sendTemplateMessage({
          phoneNumberId: creds.phoneNumberId,
          accessToken: creds.accessToken,
          toPhone: contact.phone,
          templateName: tpl.name,
          languageCode: tpl.language,
          bodyParameters: bodyParams
        });
      } else {
        const rawText = params.body?.trim() || tpl?.bodyText || '';
        if (!rawText) throw new CrmError(400, 'MESSAGE_BODY_REQUIRED', 'Message body is required.');
        renderedBody = formatMessageText(rawText, { name: contact.name, phone: contact.phone, customVars: vars });
        const windowExpires =
          conv.serviceWindowExpiresAt ??
          (contact.lastInboundAt ? contact.lastInboundAt + 24 * 60 * 60 * 1000 : null);
        sendResult = await provider.sendFreeformText({
          phoneNumberId: creds.phoneNumberId,
          accessToken: creds.accessToken,
          toPhone: contact.phone,
          body: renderedBody,
          serviceWindowExpiresAt: windowExpires,
          now
        });
      }
    }
  } catch (err) {
    if (err instanceof ProviderApiError) {
      throw new CrmError(err.statusCode === 401 ? 400 : 422, err.code, err.message);
    }
    throw err;
  }

  const msgId = crypto.randomUUID();
  await db.insert(messages).values({
    id: msgId,
    organizationId: ctx.organizationId,
    conversationId: conv.id,
    direction: 'outbound',
    senderKind: 'agent',
    senderUserId: ctx.userId,
    msgType:
      targetAccount.providerType === 'official_meta_cloud' && tpl && tpl.approvalStatus === 'APPROVED'
        ? 'template'
        : 'text',
    body: renderedBody,
    providerMessageId: sendResult.providerMessageId,
    idempotencyKey: params.idempotencyKey ?? null,
    status: 'sent',
    createdAt: now,
    updatedAt: now
  });

  await db
    .update(conversations)
    .set({
      whatsappAccountId: targetAccountId,
      channelType: targetChannelType,
      lastMessagePreview: renderedBody.slice(0, 140),
      lastMessageAt: now,
      updatedAt: now
    })
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, conv.id)));

  await db
    .insert(usageCounters)
    .values({ organizationId: ctx.organizationId, periodKey: getUtcPeriodKey(now), outboundMessages: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: [usageCounters.organizationId, usageCounters.periodKey],
      set: {
        outboundMessages: sql`${usageCounters.outboundMessages} + 1`,
        updatedAt: now
      }
    });

  const rows = await db.select().from(messages).where(eq(messages.id, msgId)).limit(1);
  return rows[0]!;
}

// ============================================================================
// DURABLE CLOUD CAMPAIGN EXECUTION (QUEUE CONSUMER & CRON TICK)
// ============================================================================

export async function processCampaignRecipientBatch(
  db: AppDatabase,
  options: {
    message: CampaignQueueMessageBody;
    encryptionKey: string | undefined;
    provider?: WhatsAppProvider;
    qrBridge?: QrBridgeClient;
    now?: number;
  }
): Promise<{
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
  hasRetryableErrors: boolean;
}> {
  const now = options.now ?? Date.now();
  const { organizationId, campaignId, recipientIds } = options.message;

  if (recipientIds.length === 0) {
    return { sent: 0, skipped: 0, failed: 0, retried: 0, hasRetryableErrors: false };
  }

  const campRows = await db
    .select()
    .from(campaigns)
    .where(
      and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId), isNull(campaigns.deletedAt))
    )
    .limit(1);
  const camp = campRows[0];
  if (!camp) {
    return { sent: 0, skipped: 0, failed: 0, retried: 0, hasRetryableErrors: false };
  }

  // If campaign was paused or cancelled while queued, revert queued recipients safely to pending
  if (camp.status !== 'running') {
    for (let i = 0; i < recipientIds.length; i += 80) {
      const slice = recipientIds.slice(i, i + 80);
      await db
        .update(campaignRecipients)
        .set({ status: 'pending', updatedAt: now })
        .where(
          and(
            eq(campaignRecipients.organizationId, organizationId),
            eq(campaignRecipients.campaignId, campaignId),
            eq(campaignRecipients.status, 'queued'),
            inArray(campaignRecipients.id, slice)
          )
        );
    }
    await syncCampaignAggregateCounters(db, organizationId, campaignId);
    return { sent: 0, skipped: 0, failed: 0, retried: 0, hasRetryableErrors: false };
  }

  const sysCtx: OrgContext = {
    userId: camp.createdByUserId || 'system-campaign-worker',
    organizationId,
    role: 'owner',
    sessionId: 'worker'
  };

  const campAccount = await getWhatsappAccountForOrg(db, sysCtx, camp.whatsappAccountId);
  if (!campAccount) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'Campaign WhatsApp account not found.');
  }
  const isQrBridge = campAccount.providerType === 'unofficial_bridge';
  const creds = isQrBridge
    ? null
    : await getDecryptedMetaCredentials(db, sysCtx, camp.whatsappAccountId, options.encryptionKey);
  const provider = options.provider ?? new MetaCloudProvider();
  const channelType = isQrBridge ? 'unofficial_local_desktop' : 'official_meta_cloud';

  let tpl: typeof templates.$inferSelect | null = null;
  if (camp.templateId) {
    const tplRows = await db
      .select()
      .from(templates)
      .where(and(eq(templates.organizationId, organizationId), eq(templates.id, camp.templateId)))
      .limit(1);
    tpl = tplRows[0] ?? null;
  }

  const periodKey = getUtcPeriodKey(now);
  const usageRows = await db
    .select({ outboundMessages: usageCounters.outboundMessages })
    .from(usageCounters)
    .where(and(eq(usageCounters.organizationId, organizationId), eq(usageCounters.periodKey, periodKey)))
    .limit(1);
  let sentToday = usageRows[0]?.outboundMessages ?? 0;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let retried = 0;
  let hasRetryableErrors = false;

  for (const recipientId of recipientIds) {
    const rcptRows = await db
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.organizationId, organizationId),
          eq(campaignRecipients.campaignId, campaignId),
          eq(campaignRecipients.id, recipientId)
        )
      )
      .limit(1);
    const rcpt = rcptRows[0];
    if (!rcpt || !['pending', 'queued'].includes(rcpt.status)) {
      continue;
    }

    // 1. Idempotency check against messages table (prevents duplicate sends on Queue replay)
    const priorMsg = await db
      .select({ id: messages.id, providerMessageId: messages.providerMessageId })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.idempotencyKey, rcpt.idempotencyKey)))
      .limit(1);
    if (priorMsg[0]?.providerMessageId) {
      await db
        .update(campaignRecipients)
        .set({
          status: 'sent',
          providerMessageId: priorMsg[0].providerMessageId,
          sentAt: rcpt.sentAt ?? now,
          updatedAt: now
        })
        .where(and(eq(campaignRecipients.organizationId, organizationId), eq(campaignRecipients.id, rcpt.id)));
      sent++;
      continue;
    }

    // 2. Daily limit enforcement
    if (sentToday >= camp.dailyLimit) {
      await db
        .update(campaignRecipients)
        .set({
          status: 'pending',
          nextAttemptAt: now + 60 * 60 * 1000,
          updatedAt: now
        })
        .where(and(eq(campaignRecipients.organizationId, organizationId), eq(campaignRecipients.id, rcpt.id)));
      continue;
    }

    // 3. Re-check consent & STOP suppression right before dispatch
    const eligibility = await checkCampaignEligibility(db, sysCtx, rcpt.phone);
    if (!eligibility.eligible) {
      await db
        .update(campaignRecipients)
        .set({
          status: 'skipped',
          errorMessage: eligibility.reason ?? 'SUPPRESSED',
          updatedAt: now
        })
        .where(and(eq(campaignRecipients.organizationId, organizationId), eq(campaignRecipients.id, rcpt.id)));
      skipped++;
      continue;
    }

    const vars = parseJsonVars(rcpt.customVarsJson);
    const contactRows = await db
      .select({ lastInboundAt: contacts.lastInboundAt })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, rcpt.contactId)))
      .limit(1);
    const windowExpires = contactRows[0]?.lastInboundAt
      ? contactRows[0].lastInboundAt + 24 * 60 * 60 * 1000
      : null;

    let renderedBody = '';
    try {
      let sendRes;
      if (isQrBridge) {
        if (campAccount.connectionStatus !== 'connected') {
          throw new ProviderApiError(
            422,
            'QR_SESSION_NOT_CONNECTED',
            'QR WhatsApp session is not connected.',
            true
          );
        }
        if (!options.qrBridge) {
          throw new ProviderApiError(
            503,
            'QR_BRIDGE_UNCONFIGURED',
            'QR bridge service is not configured.',
            false
          );
        }
        const rawTpl = camp.messageOverride || tpl?.bodyText || '';
        renderedBody = formatMessageText(rawTpl, {
          name: rcpt.contactName,
          phone: rcpt.phone,
          customVars: vars
        });
        sendRes = await options.qrBridge.sendTextMessage({
          organizationId,
          whatsappAccountId: campAccount.id,
          toPhone: rcpt.phone,
          text: renderedBody
        });
      } else if (tpl && tpl.approvalStatus === 'APPROVED' && tpl.category !== 'CUSTOM_TEXT') {
        const bodyParams = extractBodyParameters(tpl.bodyText, { name: rcpt.contactName, phone: rcpt.phone, ...vars });
        renderedBody = tpl.bodyText;
        sendRes = await provider.sendTemplateMessage({
          phoneNumberId: creds!.phoneNumberId,
          accessToken: creds!.accessToken,
          toPhone: rcpt.phone,
          templateName: tpl.name,
          languageCode: tpl.language,
          bodyParameters: bodyParams
        });
      } else {
        const rawTpl = camp.messageOverride || tpl?.bodyText || '';
        renderedBody = formatMessageText(rawTpl, {
          name: rcpt.contactName,
          phone: rcpt.phone,
          customVars: vars
        });
        sendRes = await provider.sendFreeformText({
          phoneNumberId: creds!.phoneNumberId,
          accessToken: creds!.accessToken,
          toPhone: rcpt.phone,
          body: renderedBody,
          serviceWindowExpiresAt: windowExpires,
          now
        });
      }

      // Persist conversation + message idempotently
      const existingConv = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.contactId, rcpt.contactId),
            eq(conversations.channelType, channelType)
          )
        )
        .limit(1);

      let convId = existingConv[0]?.id;
      if (!convId) {
        convId = crypto.randomUUID();
        await db.insert(conversations).values({
          id: convId,
          organizationId,
          contactId: rcpt.contactId,
          whatsappAccountId: camp.whatsappAccountId,
          channelType,
          status: 'open',
          lastMessagePreview: renderedBody.slice(0, 140),
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now
        });
      } else {
        await db
          .update(conversations)
          .set({ lastMessagePreview: renderedBody.slice(0, 140), lastMessageAt: now, updatedAt: now })
          .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, convId)));
      }

      await db
        .insert(messages)
        .values({
          id: crypto.randomUUID(),
          organizationId,
          conversationId: convId,
          direction: 'outbound',
          senderKind: 'system',
          msgType: !isQrBridge && tpl && tpl.approvalStatus === 'APPROVED' ? 'template' : 'text',
          body: renderedBody,
          providerMessageId: sendRes.providerMessageId,
          idempotencyKey: rcpt.idempotencyKey,
          status: 'sent',
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoNothing();

      await db
        .update(campaignRecipients)
        .set({
          status: 'sent',
          providerMessageId: sendRes.providerMessageId,
          sentAt: now,
          errorMessage: null,
          updatedAt: now
        })
        .where(and(eq(campaignRecipients.organizationId, organizationId), eq(campaignRecipients.id, rcpt.id)));

      await db
        .insert(usageCounters)
        .values({ organizationId, periodKey, outboundMessages: 1, updatedAt: now })
        .onConflictDoUpdate({
          target: [usageCounters.organizationId, usageCounters.periodKey],
          set: {
            outboundMessages: sql`${usageCounters.outboundMessages} + 1`,
            updatedAt: now
          }
        });

      sentToday++;
      sent++;
    } catch (err) {
      const info = isRetryableProviderError(err);
      const nextAttemptCount = rcpt.attemptCount + 1;
      if (info.retryable && nextAttemptCount < MAX_RETRY_ATTEMPTS) {
        const delayMs = RETRY_BACKOFF_MS[Math.min(nextAttemptCount - 1, RETRY_BACKOFF_MS.length - 1)] ?? 60_000;
        await db
          .update(campaignRecipients)
          .set({
            status: 'pending',
            attemptCount: nextAttemptCount,
            nextAttemptAt: now + delayMs,
            errorMessage: info.message,
            updatedAt: now
          })
          .where(and(eq(campaignRecipients.organizationId, organizationId), eq(campaignRecipients.id, rcpt.id)));
        retried++;
        hasRetryableErrors = true;
      } else {
        await db
          .update(campaignRecipients)
          .set({
            status: 'failed',
            attemptCount: nextAttemptCount,
            errorMessage: info.message,
            updatedAt: now
          })
          .where(and(eq(campaignRecipients.organizationId, organizationId), eq(campaignRecipients.id, rcpt.id)));
        failed++;
      }
    }
  }

  await syncCampaignAggregateCounters(db, organizationId, campaignId);
  return { sent, skipped, failed, retried, hasRetryableErrors };
}

export async function runScheduledCampaignTick(
  db: AppDatabase,
  options: {
    now?: number;
    jobsQueue?: CampaignQueueProducer;
    encryptionKey: string | undefined;
    provider?: WhatsAppProvider;
    qrBridge?: QrBridgeClient;
    maxBatchRecipients?: number;
    inlineFallbackLimit?: number;
  }
) {
  const now = options.now ?? Date.now();
  const batchChunkSize = Math.min(Math.max(1, options.maxBatchRecipients ?? 10), 25);

  // 1. Promote due scheduled campaigns -> running (D1 remains source of truth until due)
  const dueScheduled = await db
    .select({ id: campaigns.id, organizationId: campaigns.organizationId })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.status, 'scheduled'),
        lte(campaigns.scheduledAt, now),
        isNull(campaigns.deletedAt)
      )
    )
    .limit(20);

  for (const camp of dueScheduled) {
    await db
      .update(campaigns)
      .set({ status: 'running', startedAt: now, updatedAt: now })
      .where(eq(campaigns.id, camp.id));
  }

  // 2. Scan running campaigns for due pending recipients
  const runningCampaigns = await db
    .select({ id: campaigns.id, organizationId: campaigns.organizationId })
    .from(campaigns)
    .where(and(eq(campaigns.status, 'running'), isNull(campaigns.deletedAt)))
    .limit(25);

  let promotedCount = dueScheduled.length;
  let queuedBatches = 0;
  let queuedRecipients = 0;
  let queueQuotaFallback = false;
  let inlineProcessed = 0;

  for (const camp of runningCampaigns) {
    const dueRecipients = await db
      .select({ id: campaignRecipients.id })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.organizationId, camp.organizationId),
          eq(campaignRecipients.campaignId, camp.id),
          eq(campaignRecipients.status, 'pending'),
          or(isNull(campaignRecipients.nextAttemptAt), lte(campaignRecipients.nextAttemptAt, now))
        )
      )
      .limit(50);

    if (dueRecipients.length === 0) {
      await syncCampaignAggregateCounters(db, camp.organizationId, camp.id);
      continue;
    }

    const batches: CampaignQueueMessageBody[] = [];
    for (let i = 0; i < dueRecipients.length; i += batchChunkSize) {
      batches.push({
        organizationId: camp.organizationId,
        campaignId: camp.id,
        recipientIds: dueRecipients.slice(i, i + batchChunkSize).map((r) => r.id)
      });
    }

    if (options.jobsQueue) {
      try {
        await options.jobsQueue.sendBatch(batches.map((b) => ({ body: b })));
        for (const batch of batches) {
          await db
            .update(campaignRecipients)
            .set({ status: 'queued', updatedAt: now })
            .where(inArray(campaignRecipients.id, batch.recipientIds));
          queuedBatches++;
          queuedRecipients += batch.recipientIds.length;
        }
        await syncCampaignAggregateCounters(db, camp.organizationId, camp.id);
        continue;
      } catch {
        // Queue quota exhausted (10k ops/day Free limit) or unavailable -> leave recipients 'pending' in D1!
        queueQuotaFallback = true;
      }
    }

    // Inline fallback when no Queue binding or Queue quota exhausted
    const inlineSlice = batches[0];
    if (inlineSlice && (options.inlineFallbackLimit ?? 10) > 0) {
      const cappedIds = inlineSlice.recipientIds.slice(0, options.inlineFallbackLimit ?? 10);
      await processCampaignRecipientBatch(db, {
        message: {
          organizationId: camp.organizationId,
          campaignId: camp.id,
          recipientIds: cappedIds
        },
        encryptionKey: options.encryptionKey,
        provider: options.provider,
        qrBridge: options.qrBridge,
        now
      });
      inlineProcessed += cappedIds.length;
    }
  }

  return {
    promotedCount,
    queuedBatches,
    queuedRecipients,
    queueQuotaFallback,
    inlineProcessed
  };
}
