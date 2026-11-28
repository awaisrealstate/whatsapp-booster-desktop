import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import {
  isStopOptOutText,
  ProviderApiError,
  type ParsedWebhookEvent,
  type ProviderTemplateSummary,
  type QrBridgeInboundEvent,
  type QrBridgeStatus,
  type QrSessionSnapshot,
  type WhatsAppProvider
} from '@wacrm/providers';
import { validatePhoneNumber } from '@wacrm/shared';
import type { AppDatabase } from './client.ts';
import { decryptSecretAesGcm, encryptSecretAesGcm, hashTokenSha256 } from './crypto.ts';
import { CrmError, recordStopOptOut } from './crm.ts';
import type { OrgContext } from './tenant.ts';
import {
  campaignRecipients,
  campaigns,
  contacts,
  conversations,
  messages,
  messageMedia,
  templates,
  waQrSessions,
  webhookEvents,
  whatsappAccounts,
  type QrSessionStatus,
  type TemplateApprovalStatus,
  type TemplateCategory,
  type WaConnectionStatus
} from './schema.ts';

function maskId(val: string | null | undefined): string | null {
  if (!val) return null;
  if (val.length <= 4) return '****';
  return `***${val.slice(-4)}`;
}

function toPublicQrSession(row: typeof waQrSessions.$inferSelect | null | undefined, now = Date.now()) {
  if (!row) return null;
  const expiredNow =
    row.status === 'waiting_for_scan' && row.qrExpiresAt !== null && now > row.qrExpiresAt;
  const effectiveStatus: QrSessionStatus = expiredNow ? 'expired' : row.status;
  return {
    id: row.id,
    organizationId: row.organizationId,
    whatsappAccountId: row.whatsappAccountId,
    status: effectiveStatus,
    qrDataUrl: effectiveStatus === 'waiting_for_scan' ? row.qrDataUrl : null,
    qrExpiresAt: effectiveStatus === 'waiting_for_scan' ? row.qrExpiresAt : null,
    phoneNumber: row.connectedPhone,
    lastConnectedAt: row.lastConnectedAt,
    lastError: effectiveStatus === 'expired' ? row.lastError || 'QR code expired. Click Refresh QR.' : row.lastError,
    updatedAt: row.updatedAt
  };
}

function toPublicWhatsappAccount(
  row: typeof whatsappAccounts.$inferSelect,
  qrRow?: typeof waQrSessions.$inferSelect | null
) {
  const qrSession = toPublicQrSession(qrRow);
  return {
    id: row.id,
    organizationId: row.organizationId,
    label: row.label,
    providerType: row.providerType,
    isOfficial: row.providerType === 'official_meta_cloud',
    phoneNumber: row.phoneNumber,
    connectionStatus: row.connectionStatus,
    qrStatus: qrSession?.status ?? null,
    qrExpiresAt: qrSession?.qrExpiresAt ?? null,
    lastConnectedAt: row.lastConnectedAt ?? qrSession?.lastConnectedAt ?? null,
    metaWabaId: row.metaWabaId,
    metaPhoneNumberId: row.metaPhoneNumberId,
    maskedPhoneNumberId: maskId(row.metaPhoneNumberId),
    hasAccessToken: Boolean(row.metaAccessTokenEnc),
    hasAppSecret: Boolean(row.metaAppSecretEnc),
    hasVerifyToken: Boolean(row.metaWebhookVerifyHash),
    isDefault: Boolean(row.isDefault),
    lastHealthCheckAt: row.lastHealthCheckAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    qrSession
  };
}

export async function connectMetaWhatsappAccount(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    label: string;
    phoneNumber?: string | null;
    metaWabaId: string;
    metaPhoneNumberId: string;
    accessToken: string;
    appSecret?: string | null;
    webhookVerifyToken: string;
    isDefault?: boolean;
    connectionStatus?: WaConnectionStatus;
    defaultCountryCode?: string;
  },
  encryptionKey: string | undefined
) {
  if (!encryptionKey || encryptionKey.trim().length < 16) {
    throw new CrmError(
      400,
      'ENCRYPTION_KEY_UNCONFIGURED',
      'Server ENCRYPTION_KEY (>= 16 chars) is required before storing encrypted WhatsApp credentials.'
    );
  }

  let normalizedPhone: string | null = null;
  if (input.phoneNumber && input.phoneNumber.trim()) {
    const phoneCheck = validatePhoneNumber(input.phoneNumber, input.defaultCountryCode ?? '92');
    if (!phoneCheck.valid) {
      throw new CrmError(422, 'INVALID_PHONE', phoneCheck.reason ?? 'Invalid WhatsApp phone number.');
    }
    normalizedPhone = phoneCheck.phone;
  }

  const metaPhoneNumberId = input.metaPhoneNumberId.trim();
  const existingPhoneId = await db
    .select({ id: whatsappAccounts.id, organizationId: whatsappAccounts.organizationId })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.metaPhoneNumberId, metaPhoneNumberId))
    .limit(1);

  if (existingPhoneId[0]) {
    throw new CrmError(
      409,
      'META_PHONE_ID_IN_USE',
      'This Meta Phone Number ID is already connected to a workspace.'
    );
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const accessTokenEnc = await encryptSecretAesGcm(input.accessToken.trim(), encryptionKey);
  const appSecretEnc = input.appSecret?.trim()
    ? await encryptSecretAesGcm(input.appSecret.trim(), encryptionKey)
    : null;
  const verifyHash = await hashTokenSha256(input.webhookVerifyToken.trim());

  const existingOrgAccounts = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.organizationId, ctx.organizationId));

  const makeDefault = input.isDefault ?? existingOrgAccounts.length === 0;
  if (makeDefault && existingOrgAccounts.length > 0) {
    await db
      .update(whatsappAccounts)
      .set({ isDefault: 0, updatedAt: now })
      .where(eq(whatsappAccounts.organizationId, ctx.organizationId));
  }

  await db.insert(whatsappAccounts).values({
    id,
    organizationId: ctx.organizationId,
    label: input.label.trim(),
    providerType: 'official_meta_cloud',
    phoneNumber: normalizedPhone,
    connectionStatus: input.connectionStatus ?? 'connected',
    metaWabaId: input.metaWabaId.trim(),
    metaPhoneNumberId,
    metaAccessTokenEnc: accessTokenEnc,
    metaAppSecretEnc: appSecretEnc,
    metaWebhookVerifyHash: verifyHash,
    isDefault: makeDefault ? 1 : 0,
    lastConnectedAt: (input.connectionStatus ?? 'connected') === 'connected' ? now : null,
    lastHealthCheckAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now
  });

  return getWhatsappAccountForOrg(db, ctx, id);
}

export async function listWhatsappAccounts(db: AppDatabase, ctx: OrgContext) {
  const [rows, qrRows] = await Promise.all([
    db
      .select()
      .from(whatsappAccounts)
      .where(eq(whatsappAccounts.organizationId, ctx.organizationId))
      .orderBy(desc(whatsappAccounts.isDefault), desc(whatsappAccounts.updatedAt)),
    db
      .select()
      .from(waQrSessions)
      .where(eq(waQrSessions.organizationId, ctx.organizationId))
  ]);
  const qrMap = new Map(qrRows.map((qr) => [qr.whatsappAccountId, qr]));
  return rows.map((row) => toPublicWhatsappAccount(row, qrMap.get(row.id) ?? null));
}

export async function getWhatsappAccountForOrg(
  db: AppDatabase,
  ctx: OrgContext,
  accountId: string
) {
  const [rows, qrRows] = await Promise.all([
    db
      .select()
      .from(whatsappAccounts)
      .where(
        and(eq(whatsappAccounts.organizationId, ctx.organizationId), eq(whatsappAccounts.id, accountId))
      )
      .limit(1),
    db
      .select()
      .from(waQrSessions)
      .where(
        and(
          eq(waQrSessions.organizationId, ctx.organizationId),
          eq(waQrSessions.whatsappAccountId, accountId)
        )
      )
      .limit(1)
  ]);
  return rows[0] ? toPublicWhatsappAccount(rows[0], qrRows[0] ?? null) : null;
}

export async function disconnectWhatsappAccount(
  db: AppDatabase,
  ctx: OrgContext,
  accountId: string
) {
  const rows = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(
      and(eq(whatsappAccounts.organizationId, ctx.organizationId), eq(whatsappAccounts.id, accountId))
    )
    .limit(1);
  if (rows.length === 0) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
  }

  const now = Date.now();
  await db
    .update(whatsappAccounts)
    .set({ connectionStatus: 'disconnected', updatedAt: now })
    .where(
      and(eq(whatsappAccounts.organizationId, ctx.organizationId), eq(whatsappAccounts.id, accountId))
    );

  return getWhatsappAccountForOrg(db, ctx, accountId);
}

export async function getDecryptedMetaCredentials(
  db: AppDatabase,
  ctx: OrgContext,
  accountId: string,
  encryptionKey: string | undefined
): Promise<{
  accountId: string;
  organizationId: string;
  wabaId: string | null;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string | null;
}> {
  if (!encryptionKey || encryptionKey.trim().length < 16) {
    throw new CrmError(400, 'ENCRYPTION_KEY_UNCONFIGURED', 'ENCRYPTION_KEY is required to decrypt credentials.');
  }

  const rows = await db
    .select()
    .from(whatsappAccounts)
    .where(
      and(eq(whatsappAccounts.organizationId, ctx.organizationId), eq(whatsappAccounts.id, accountId))
    )
    .limit(1);

  const account = rows[0];
  if (!account) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
  }
  if (account.providerType !== 'official_meta_cloud') {
    throw new CrmError(422, 'INVALID_PROVIDER_TYPE', 'Selected WhatsApp account is not Official Meta Cloud API.');
  }
  if (!account.metaPhoneNumberId || !account.metaAccessTokenEnc) {
    throw new CrmError(422, 'INCOMPLETE_META_CREDENTIALS', 'Meta credentials are missing on this account.');
  }

  const accessToken = await decryptSecretAesGcm(account.metaAccessTokenEnc, encryptionKey);
  const appSecret = account.metaAppSecretEnc
    ? await decryptSecretAesGcm(account.metaAppSecretEnc, encryptionKey)
    : null;

  return {
    accountId: account.id,
    organizationId: account.organizationId,
    wabaId: account.metaWabaId,
    phoneNumberId: account.metaPhoneNumberId,
    accessToken,
    appSecret
  };
}

export async function findMetaAccountByPhoneNumberId(
  db: AppDatabase,
  phoneNumberId: string
) {
  const rows = await db
    .select({
      id: whatsappAccounts.id,
      organizationId: whatsappAccounts.organizationId,
      metaPhoneNumberId: whatsappAccounts.metaPhoneNumberId,
      metaAppSecretEnc: whatsappAccounts.metaAppSecretEnc
    })
    .from(whatsappAccounts)
    .where(
      and(
        eq(whatsappAccounts.providerType, 'official_meta_cloud'),
        eq(whatsappAccounts.metaPhoneNumberId, phoneNumberId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findMetaAccountByVerifyToken(db: AppDatabase, rawVerifyToken: string) {
  const tokenHash = await hashTokenSha256(rawVerifyToken.trim());
  const rows = await db
    .select({
      id: whatsappAccounts.id,
      organizationId: whatsappAccounts.organizationId
    })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.metaWebhookVerifyHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

// ============================================================================
// TEMPLATES
// ============================================================================

export async function createTemplate(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    whatsappAccountId?: string | null;
    name: string;
    language?: string;
    category?: TemplateCategory;
    bodyText: string;
    approvalStatus?: TemplateApprovalStatus;
  }
) {
  if (input.whatsappAccountId) {
    const acc = await getWhatsappAccountForOrg(db, ctx, input.whatsappAccountId);
    if (!acc) throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(templates).values({
    id,
    organizationId: ctx.organizationId,
    whatsappAccountId: input.whatsappAccountId ?? null,
    name: input.name.trim(),
    language: input.language?.trim() || 'en',
    category: input.category ?? 'CUSTOM_TEXT',
    bodyText: input.bodyText,
    metaTemplateId: null,
    approvalStatus: input.approvalStatus ?? (input.category === 'CUSTOM_TEXT' || !input.category ? 'LOCAL' : 'APPROVED'),
    createdAt: now,
    updatedAt: now
  });

  const rows = await db
    .select()
    .from(templates)
    .where(and(eq(templates.organizationId, ctx.organizationId), eq(templates.id, id)))
    .limit(1);
  return rows[0]!;
}

export async function upsertSyncedMetaTemplates(
  db: AppDatabase,
  ctx: OrgContext,
  whatsappAccountId: string,
  items: readonly ProviderTemplateSummary[]
) {
  const now = Date.now();
  let upserted = 0;

  for (const item of items) {
    const existing = await db
      .select({ id: templates.id })
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, ctx.organizationId),
          eq(templates.whatsappAccountId, whatsappAccountId),
          eq(templates.metaTemplateId, item.metaTemplateId)
        )
      )
      .limit(1);

    if (existing[0]) {
      await db
        .update(templates)
        .set({
          name: item.name,
          language: item.language,
          category: item.category,
          bodyText: item.bodyText,
          approvalStatus: item.approvalStatus,
          updatedAt: now
        })
        .where(eq(templates.id, existing[0].id));
    } else {
      await db.insert(templates).values({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        whatsappAccountId,
        name: item.name,
        language: item.language,
        category: item.category,
        bodyText: item.bodyText,
        metaTemplateId: item.metaTemplateId,
        approvalStatus: item.approvalStatus,
        createdAt: now,
        updatedAt: now
      });
    }
    upserted++;
  }

  return { syncedCount: upserted };
}

export async function listTemplates(db: AppDatabase, ctx: OrgContext) {
  return db
    .select()
    .from(templates)
    .where(eq(templates.organizationId, ctx.organizationId))
    .orderBy(desc(templates.updatedAt));
}

export async function deleteTemplate(db: AppDatabase, ctx: OrgContext, templateId: string) {
  const rows = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.organizationId, ctx.organizationId), eq(templates.id, templateId)))
    .limit(1);
  if (!rows[0]) throw new CrmError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
  await db.delete(templates).where(and(eq(templates.organizationId, ctx.organizationId), eq(templates.id, templateId)));
  return { deleted: true, id: templateId };
}

// ============================================================================
// META WEBHOOK INGESTION (IDEMPOTENT)
// ============================================================================

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5
};

export async function syncCampaignAggregateCounters(
  db: AppDatabase,
  organizationId: string,
  campaignId: string
) {
  const counts = await db
    .select({
      status: campaignRecipients.status,
      count: sql<number>`count(*)`
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.organizationId, organizationId),
        eq(campaignRecipients.campaignId, campaignId)
      )
    )
    .groupBy(campaignRecipients.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of counts) {
    const n = Number(row.count);
    byStatus[row.status] = n;
    total += n;
  }

  const pendingCount = byStatus.pending ?? 0;
  const queuedCount = byStatus.queued ?? 0;
  const sentCount = byStatus.sent ?? 0;
  const deliveredCount = byStatus.delivered ?? 0;
  const readCount = byStatus.read ?? 0;
  const failedCount = byStatus.failed ?? 0;
  const skippedCount = byStatus.skipped ?? 0;

  const campRows = await db
    .select({ status: campaigns.status, completedAt: campaigns.completedAt })
    .from(campaigns)
    .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId)))
    .limit(1);

  const camp = campRows[0];
  if (!camp) return;

  const now = Date.now();
  const shouldComplete = camp.status === 'running' && total > 0 && pendingCount === 0 && queuedCount === 0;

  await db
    .update(campaigns)
    .set({
      totalRecipients: total,
      queuedCount,
      sentCount,
      deliveredCount,
      readCount,
      failedCount,
      skippedCount,
      status: shouldComplete ? 'completed' : camp.status,
      completedAt: shouldComplete ? now : camp.completedAt,
      updatedAt: now
    })
    .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId)));
}

export async function recordAndProcessMetaWebhookEvents(
  db: AppDatabase,
  params: {
    organizationId: string;
    whatsappAccountId: string;
    rawPayload: string;
    events: readonly ParsedWebhookEvent[];
  }
) {
  const now = Date.now();
  const sysCtx: OrgContext = {
    userId: 'system-meta-webhook',
    organizationId: params.organizationId,
    role: 'owner',
    sessionId: 'webhook'
  };

  let processedCount = 0;
  let duplicateEventsSkipped = 0;
  let stopOptOutsRecorded = 0;
  let statusUpdatesApplied = 0;
  const inboundConversations: Array<{ conversationId: string; customerText: string }> = [];

  for (const event of params.events) {
    const existingEvt = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.whatsappAccountId, params.whatsappAccountId),
          eq(webhookEvents.externalEventId, event.eventKey)
        )
      )
      .limit(1);

    if (existingEvt[0]) {
      duplicateEventsSkipped++;
      continue;
    }

    const eventId = crypto.randomUUID();
    await db.insert(webhookEvents).values({
      id: eventId,
      organizationId: params.organizationId,
      whatsappAccountId: params.whatsappAccountId,
      providerType: 'official_meta_cloud',
      externalEventId: event.eventKey,
      eventType: event.kind,
      payloadJson: params.rawPayload,
      processingStatus: 'received',
      receivedAt: now
    });

    if (event.kind === 'inbound_message') {
      const phoneCheck = validatePhoneNumber(event.fromPhone, '92');
      const normalizedPhone = phoneCheck.valid ? phoneCheck.phone : event.fromPhone.replace(/\D/g, '');

      const contactRows = await db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, params.organizationId),
            eq(contacts.phone, normalizedPhone),
            isNull(contacts.deletedAt)
          )
        )
        .limit(1);

      let contactId = contactRows[0]?.id;
      if (!contactId) {
        contactId = crypto.randomUUID();
        const contactName = event.profileName?.trim() || 'WhatsApp Contact';
        await db.insert(contacts).values({
          id: contactId,
          organizationId: params.organizationId,
          phone: normalizedPhone,
          rawPhone: event.fromPhone,
          name: contactName,
          customAttributesJson: JSON.stringify({ name: contactName, phone: normalizedPhone }),
          pipelineStage: 'lead',
          source: 'inbound',
          lastInboundAt: event.timestampMs,
          createdAt: now,
          updatedAt: now
        });
      } else {
        await db
          .update(contacts)
          .set({ lastInboundAt: event.timestampMs, updatedAt: now })
          .where(and(eq(contacts.organizationId, params.organizationId), eq(contacts.id, contactId)));
      }

      const convRows = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, params.organizationId),
            eq(conversations.contactId, contactId),
            eq(conversations.channelType, 'official_meta_cloud')
          )
        )
        .limit(1);

      let convId = convRows[0]?.id;
      const serviceWindowExpiresAt = event.timestampMs + 24 * 60 * 60 * 1000;

      if (!convId) {
        convId = crypto.randomUUID();
        await db.insert(conversations).values({
          id: convId,
          organizationId: params.organizationId,
          contactId,
          whatsappAccountId: params.whatsappAccountId,
          channelType: 'official_meta_cloud',
          status: 'open',
          serviceWindowExpiresAt,
          unreadCount: 1,
          lastMessagePreview: event.body.slice(0, 140),
          lastMessageAt: event.timestampMs,
          createdAt: now,
          updatedAt: now
        });
      } else {
        await db
          .update(conversations)
          .set({
            whatsappAccountId: params.whatsappAccountId,
            serviceWindowExpiresAt,
            unreadCount: (convRows[0]?.unreadCount ?? 0) + 1,
            lastMessagePreview: event.body.slice(0, 140),
            lastMessageAt: event.timestampMs,
            status: 'open',
            updatedAt: now
          })
          .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.id, convId)));
      }

      const idempotencyKey = `wa_in:${event.providerMessageId}`;
      await db
        .insert(messages)
        .values({
          id: crypto.randomUUID(),
          organizationId: params.organizationId,
          conversationId: convId,
          direction: 'inbound',
          senderKind: 'contact',
          msgType: event.msgType,
          body: event.body,
          providerMessageId: event.providerMessageId,
          idempotencyKey,
          status: 'delivered',
          createdAt: event.timestampMs,
          updatedAt: now
        })
        .onConflictDoNothing();

      if (event.isStopKeyword) {
        await recordStopOptOut(db, sysCtx, {
          phone: normalizedPhone,
          reason: 'stop_keyword',
          source: 'meta_webhook',
          notes: `Inbound keyword: ${event.body.slice(0, 100)}`,
          recordedByUserId: null
        });
        stopOptOutsRecorded++;
      } else {
        inboundConversations.push({ conversationId: convId, customerText: event.body });
      }
    } else if (event.kind === 'status_update') {
      const msgRows = await db
        .select({ id: messages.id, status: messages.status })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, params.organizationId),
            eq(messages.providerMessageId, event.providerMessageId)
          )
        )
        .limit(1);

      const msgRow = msgRows[0];
      if (msgRow) {
        const curRank = STATUS_RANK[msgRow.status] ?? 0;
        const nextRank = STATUS_RANK[event.status] ?? 0;
        if (nextRank > curRank || event.status === 'failed') {
          await db
            .update(messages)
            .set({
              status: event.status,
              errorMessage: event.errorMessage ?? undefined,
              updatedAt: now
            })
            .where(and(eq(messages.organizationId, params.organizationId), eq(messages.id, msgRow.id)));
        }
      }

      const rcptRows = await db
        .select({
          id: campaignRecipients.id,
          campaignId: campaignRecipients.campaignId,
          status: campaignRecipients.status,
          deliveredAt: campaignRecipients.deliveredAt,
          readAt: campaignRecipients.readAt
        })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.organizationId, params.organizationId),
            eq(campaignRecipients.providerMessageId, event.providerMessageId)
          )
        )
        .limit(1);

      const rcpt = rcptRows[0];
      if (rcpt) {
        const curRank = STATUS_RANK[rcpt.status] ?? 0;
        const nextRank = STATUS_RANK[event.status] ?? 0;
        if (nextRank > curRank || event.status === 'failed') {
          await db
            .update(campaignRecipients)
            .set({
              status: event.status,
              deliveredAt: event.status === 'delivered' ? event.timestampMs : rcpt.deliveredAt,
              readAt: event.status === 'read' ? event.timestampMs : rcpt.readAt,
              errorMessage: event.errorMessage ?? null,
              updatedAt: now
            })
            .where(
              and(eq(campaignRecipients.organizationId, params.organizationId), eq(campaignRecipients.id, rcpt.id))
            );

          await syncCampaignAggregateCounters(db, params.organizationId, rcpt.campaignId);
          statusUpdatesApplied++;
        }
      }
    }

    await db
      .update(webhookEvents)
      .set({ processingStatus: 'processed', processedAt: Date.now() })
      .where(and(eq(webhookEvents.organizationId, params.organizationId), eq(webhookEvents.id, eventId)));
    processedCount++;
  }

  return {
    processedCount,
    duplicateEventsSkipped,
    stopOptOutsRecorded,
    statusUpdatesApplied,
    inboundConversations
  };
}

export function isRetryableProviderError(err: unknown): { retryable: boolean; message: string } {
  if (err instanceof ProviderApiError) {
    return { retryable: err.retryable, message: `${err.code}: ${err.message}` };
  }
  return {
    retryable: true,
    message: err instanceof Error ? err.message : 'Unexpected provider error'
  };
}

// ============================================================================
// META CREDENTIAL VERIFICATION & QR BRIDGE SESSION MANAGEMENT
// ============================================================================

export async function verifyAndUpdateMetaAccount(
  db: AppDatabase,
  ctx: OrgContext,
  accountId: string,
  encryptionKey: string | undefined,
  provider: WhatsAppProvider
) {
  const creds = await getDecryptedMetaCredentials(db, ctx, accountId, encryptionKey);
  if (!provider.verifyAccountCredentials) {
    throw new CrmError(500, 'VERIFY_NOT_SUPPORTED', 'Provider does not support live credential verification.');
  }

  const now = Date.now();
  try {
    const verification = await provider.verifyAccountCredentials(creds.phoneNumberId, creds.accessToken);
    const existing = await getWhatsappAccountForOrg(db, ctx, accountId);
    const nextPhone = verification.phoneNumber || existing?.phoneNumber || null;

    await db
      .update(whatsappAccounts)
      .set({
        phoneNumber: nextPhone,
        connectionStatus: 'connected',
        lastConnectedAt: now,
        lastHealthCheckAt: now,
        lastError: null,
        updatedAt: now
      })
      .where(
        and(eq(whatsappAccounts.organizationId, ctx.organizationId), eq(whatsappAccounts.id, accountId))
      );

    return {
      verified: true,
      phoneNumber: nextPhone,
      verifiedName: verification.verifiedName,
      account: await getWhatsappAccountForOrg(db, ctx, accountId)
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Meta verification failed.';
    await db
      .update(whatsappAccounts)
      .set({
        connectionStatus: 'error',
        lastHealthCheckAt: now,
        lastError: errMsg,
        updatedAt: now
      })
      .where(
        and(eq(whatsappAccounts.organizationId, ctx.organizationId), eq(whatsappAccounts.id, accountId))
      );

    if (err instanceof ProviderApiError) {
      throw new CrmError(422, err.code, err.message);
    }
    throw err;
  }
}

function mapQrStatusToAccountConnectionStatus(status: QrBridgeStatus): WaConnectionStatus {
  if (status === 'connected') return 'connected';
  if (status === 'disconnected') return 'disconnected';
  if (status === 'error') return 'error';
  return 'qr_pending';
}

export async function getOrCreateQrBridgeAccount(
  db: AppDatabase,
  ctx: OrgContext,
  input: { accountId?: string | null; label?: string | null; isDefault?: boolean }
) {
  const now = Date.now();

  if (input.accountId) {
    const existing = await db
      .select()
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.organizationId, ctx.organizationId),
          eq(whatsappAccounts.id, input.accountId)
        )
      )
      .limit(1);
    if (!existing[0]) {
      throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
    }
    if (existing[0].providerType !== 'unofficial_bridge') {
      throw new CrmError(
        422,
        'INVALID_PROVIDER_TYPE',
        'Selected account uses Official Meta Cloud API; QR actions apply only to unofficial QR sessions.'
      );
    }
    const existingQr = await db
      .select()
      .from(waQrSessions)
      .where(
        and(
          eq(waQrSessions.organizationId, ctx.organizationId),
          eq(waQrSessions.whatsappAccountId, existing[0].id)
        )
      )
      .limit(1);

    if (!existingQr[0]) {
      await db.insert(waQrSessions).values({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        whatsappAccountId: existing[0].id,
        status: 'connecting',
        createdAt: now,
        updatedAt: now
      });
    }
    return getWhatsappAccountForOrg(db, ctx, existing[0].id);
  }

  if (!input.accountId) {
    const existingBridge = await db
      .select()
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.organizationId, ctx.organizationId),
          eq(whatsappAccounts.providerType, 'unofficial_bridge')
        )
      )
      .limit(1);

    if (existingBridge[0]) {
      const existingQr = await db
        .select()
        .from(waQrSessions)
        .where(
          and(
            eq(waQrSessions.organizationId, ctx.organizationId),
            eq(waQrSessions.whatsappAccountId, existingBridge[0].id)
          )
        )
        .limit(1);

      if (!existingQr[0]) {
        await db.insert(waQrSessions).values({
          id: crypto.randomUUID(),
          organizationId: ctx.organizationId,
          whatsappAccountId: existingBridge[0].id,
          status: 'connecting',
          createdAt: now,
          updatedAt: now
        });
      }
      return getWhatsappAccountForOrg(db, ctx, existingBridge[0].id);
    }
  }

  const orgAccounts = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.organizationId, ctx.organizationId));

  const makeDefault = input.isDefault ?? orgAccounts.length === 0;
  if (makeDefault && orgAccounts.length > 0) {
    await db
      .update(whatsappAccounts)
      .set({ isDefault: 0, updatedAt: now })
      .where(eq(whatsappAccounts.organizationId, ctx.organizationId));
  }

  const accountId = crypto.randomUUID();
  const cleanLabel = input.label?.trim() || 'WhatsApp Web QR (Unofficial)';

  await db.insert(whatsappAccounts).values({
    id: accountId,
    organizationId: ctx.organizationId,
    label: cleanLabel,
    providerType: 'unofficial_bridge',
    phoneNumber: null,
    connectionStatus: 'qr_pending',
    isDefault: makeDefault ? 1 : 0,
    lastHealthCheckAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now
  });

  await db.insert(waQrSessions).values({
    id: crypto.randomUUID(),
    organizationId: ctx.organizationId,
    whatsappAccountId: accountId,
    status: 'connecting',
    createdAt: now,
    updatedAt: now
  });

  return getWhatsappAccountForOrg(db, ctx, accountId);
}

export async function updateQrSessionState(db: AppDatabase, snapshot: QrSessionSnapshot) {
  const now = Date.now();
  const accRows = await db
    .select()
    .from(whatsappAccounts)
    .where(
      and(
        eq(whatsappAccounts.organizationId, snapshot.organizationId),
        eq(whatsappAccounts.id, snapshot.whatsappAccountId)
      )
    )
    .limit(1);
  const account = accRows[0];
  if (!account) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'QR WhatsApp account not found.');
  }
  if (account.providerType !== 'unofficial_bridge') {
    throw new CrmError(422, 'INVALID_PROVIDER_TYPE', 'Cannot apply QR state to an Official Meta account.');
  }

  const expiredNow =
    snapshot.status === 'waiting_for_scan' &&
    snapshot.qrExpiresAt !== null &&
    now > snapshot.qrExpiresAt;
  const effectiveStatus: QrSessionStatus = expiredNow ? 'expired' : snapshot.status;
  const mappedConnStatus = mapQrStatusToAccountConnectionStatus(effectiveStatus);

  const normalizedPhone =
    snapshot.phoneNumber && snapshot.phoneNumber.trim()
      ? (() => {
          const check = validatePhoneNumber(snapshot.phoneNumber, '92');
          return check.valid ? check.phone : snapshot.phoneNumber.trim();
        })()
      : null;

  let finalStatus: QrSessionStatus = effectiveStatus;
  let finalError = snapshot.lastError ?? null;
  let connectedPhone = finalStatus === 'connected' ? normalizedPhone ?? account.phoneNumber : account.phoneNumber;

  // Enforce tenant session separation: never allow two different organizations to hold an active session on the same phone number.
  if (finalStatus === 'connected' && connectedPhone) {
    const crossOrgConflict = await db
      .select({ id: whatsappAccounts.id })
      .from(whatsappAccounts)
      .where(
        and(
          ne(whatsappAccounts.organizationId, snapshot.organizationId),
          eq(whatsappAccounts.phoneNumber, connectedPhone),
          eq(whatsappAccounts.connectionStatus, 'connected')
        )
      )
      .limit(1);

    if (crossOrgConflict[0]) {
      finalStatus = 'error';
      connectedPhone = null;
      finalError =
        'This WhatsApp number is already actively connected to another organization. Sessions cannot be shared across tenants.';
    }
  }

  const finalMappedConnStatus = mapQrStatusToAccountConnectionStatus(finalStatus);
  const nextLastConnectedAt =
    finalStatus === 'connected'
      ? snapshot.lastConnectedAt ?? account.lastConnectedAt ?? now
      : account.lastConnectedAt;

  const qrDataUrl = finalStatus === 'waiting_for_scan' ? snapshot.qrDataUrl : null;
  const qrExpiresAt = finalStatus === 'waiting_for_scan' ? snapshot.qrExpiresAt : null;

  await db
    .insert(waQrSessions)
    .values({
      id: crypto.randomUUID(),
      organizationId: snapshot.organizationId,
      whatsappAccountId: snapshot.whatsappAccountId,
      status: finalStatus,
      qrDataUrl,
      qrExpiresAt,
      connectedPhone: connectedPhone ?? null,
      lastConnectedAt: nextLastConnectedAt ?? null,
      lastError: finalError,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [waQrSessions.whatsappAccountId],
      set: {
        status: finalStatus,
        qrDataUrl,
        qrExpiresAt,
        connectedPhone: connectedPhone ?? null,
        lastConnectedAt: nextLastConnectedAt ?? null,
        lastError: finalError,
        updatedAt: now
      }
    });

  await db
    .update(whatsappAccounts)
    .set({
      connectionStatus: finalMappedConnStatus,
      phoneNumber: finalStatus === 'disconnected' ? account.phoneNumber : connectedPhone ?? null,
      lastConnectedAt: nextLastConnectedAt ?? null,
      lastHealthCheckAt: now,
      lastError: finalError,
      updatedAt: now
    })
    .where(
      and(
        eq(whatsappAccounts.organizationId, snapshot.organizationId),
        eq(whatsappAccounts.id, snapshot.whatsappAccountId)
      )
    );

  const orgCtx: OrgContext = {
    userId: 'qr-bridge-sync',
    organizationId: snapshot.organizationId,
    role: 'owner',
    sessionId: 'qr-bridge'
  };
  return getWhatsappAccountForOrg(db, orgCtx, snapshot.whatsappAccountId);
}

export async function getQrSessionForOrg(db: AppDatabase, ctx: OrgContext, accountId: string) {
  const account = await getWhatsappAccountForOrg(db, ctx, accountId);
  if (!account) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
  }
  if (account.providerType !== 'unofficial_bridge') {
    throw new CrmError(422, 'INVALID_PROVIDER_TYPE', 'Selected account is not a QR session.');
  }

  // Persist expiration transition if QR code aged out since last check
  if (account.qrSession?.status === 'expired' && account.lastError !== account.qrSession.lastError) {
    await db
      .update(waQrSessions)
      .set({ status: 'expired', qrDataUrl: null, updatedAt: Date.now() })
      .where(
        and(
          eq(waQrSessions.organizationId, ctx.organizationId),
          eq(waQrSessions.whatsappAccountId, accountId)
        )
      );
  }

  return account;
}

export async function recordQrBridgeInboundMessage(db: AppDatabase, params: QrBridgeInboundEvent) {
  const accRows = await db
    .select({ id: whatsappAccounts.id, providerType: whatsappAccounts.providerType })
    .from(whatsappAccounts)
    .where(
      and(
        eq(whatsappAccounts.organizationId, params.organizationId),
        eq(whatsappAccounts.id, params.whatsappAccountId)
      )
    )
    .limit(1);

  if (!accRows[0]) {
    throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'QR WhatsApp account not found.');
  }
  if (accRows[0].providerType !== 'unofficial_bridge') {
    throw new CrmError(422, 'INVALID_PROVIDER_TYPE', 'Inbound QR event targets a non-QR account.');
  }

  const now = Date.now();
  const sysCtx: OrgContext = {
    userId: 'system-qr-bridge',
    organizationId: params.organizationId,
    role: 'owner',
    sessionId: 'qr-webhook'
  };

  const existingEvt = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.whatsappAccountId, params.whatsappAccountId),
        eq(webhookEvents.externalEventId, params.eventId)
      )
    )
    .limit(1);
  if (existingEvt[0]) {
    return { duplicate: true, conversationId: null, isStopKeyword: false, customerText: params.body };
  }

  const eventId = crypto.randomUUID();
  await db.insert(webhookEvents).values({
    id: eventId,
    organizationId: params.organizationId,
    whatsappAccountId: params.whatsappAccountId,
    providerType: 'unofficial_bridge',
    externalEventId: params.eventId,
    eventType: 'inbound_message',
    payloadJson: JSON.stringify(params),
    processingStatus: 'received',
    receivedAt: now
  });

  const phoneCheck = validatePhoneNumber(params.fromPhone, '92');
  const normalizedPhone = phoneCheck.valid ? phoneCheck.phone : params.fromPhone.replace(/\D/g, '');

  const contactRows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, params.organizationId),
        or(
          eq(contacts.phone, normalizedPhone),
          eq(contacts.phone, `+${normalizedPhone}`),
          eq(contacts.rawPhone, params.fromPhone)
        ),
        isNull(contacts.deletedAt)
      )
    )
    .limit(1);

  let contactId = contactRows[0]?.id;
  if (!contactId) {
    contactId = crypto.randomUUID();
    const contactName = params.profileName?.trim() || 'WhatsApp Contact';
    await db.insert(contacts).values({
      id: contactId,
      organizationId: params.organizationId,
      phone: normalizedPhone,
      rawPhone: params.fromPhone,
      name: contactName,
      customAttributesJson: JSON.stringify({ name: contactName, phone: normalizedPhone }),
      pipelineStage: 'lead',
      source: 'inbound',
      lastInboundAt: params.timestampMs,
      createdAt: now,
      updatedAt: now
    });
  } else {
    await db
      .update(contacts)
      .set({ lastInboundAt: params.timestampMs, updatedAt: now })
      .where(and(eq(contacts.organizationId, params.organizationId), eq(contacts.id, contactId)));
  }

  const convRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, params.organizationId),
        params.remoteJid
          ? or(eq(conversations.remoteJid, params.remoteJid), eq(conversations.contactId, contactId))
          : eq(conversations.contactId, contactId),
        eq(conversations.channelType, 'unofficial_local_desktop')
      )
    )
    .limit(1);

  const isGroup = Boolean(params.isGroup || params.remoteJid?.endsWith('@g.us'));
  const isFromMe = Boolean(params.fromMe);

  let convId = convRows[0]?.id;
  const serviceWindowExpiresAt = params.timestampMs + 24 * 60 * 60 * 1000;

  if (!convId) {
    convId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: convId,
      organizationId: params.organizationId,
      contactId,
      whatsappAccountId: params.whatsappAccountId,
      channelType: 'unofficial_local_desktop',
      status: 'open',
      remoteJid: params.remoteJid || null,
      isGroup: isGroup ? 1 : 0,
      groupSubject: isGroup ? (params.groupSubject || params.profileName || null) : null,
      serviceWindowExpiresAt,
      unreadCount: isFromMe ? 0 : 1,
      lastMessagePreview: params.body.slice(0, 140),
      lastMessageAt: params.timestampMs,
      createdAt: now,
      updatedAt: now
    });
  } else {
    await db
      .update(conversations)
      .set({
        whatsappAccountId: params.whatsappAccountId,
        remoteJid: params.remoteJid || convRows[0]?.remoteJid || null,
        isGroup: isGroup ? 1 : (convRows[0]?.isGroup ?? 0),
        groupSubject: isGroup ? (params.groupSubject || convRows[0]?.groupSubject || null) : convRows[0]?.groupSubject,
        serviceWindowExpiresAt,
        unreadCount: isFromMe ? convRows[0]?.unreadCount ?? 0 : (convRows[0]?.unreadCount ?? 0) + 1,
        lastMessagePreview: params.body.slice(0, 140),
        lastMessageAt: params.timestampMs,
        status: 'open',
        updatedAt: now
      })
      .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.id, convId)));
  }

  const msgId = crypto.randomUUID();
  const direction = isFromMe ? 'outbound' : 'inbound';
  const senderKind = isFromMe ? 'agent' : 'contact';
  const msgType = (['text', 'image', 'video', 'audio', 'document'].includes(params.msgType || '')
    ? params.msgType
    : 'text') as 'text' | 'image' | 'video' | 'audio' | 'document';

  await db
    .insert(messages)
    .values({
      id: msgId,
      organizationId: params.organizationId,
      conversationId: convId,
      direction,
      senderKind,
      msgType,
      body: params.body,
      providerMessageId: params.providerMessageId,
      idempotencyKey: `qr_msg:${params.providerMessageId}`,
      remoteJid: params.remoteJid || null,
      senderPhone: params.fromPhone,
      senderName: params.profileName || null,
      mediaUrl: params.mediaUrl || null,
      mediaMimeType: params.mediaMimeType || null,
      mediaFilename: params.mediaFilename || null,
      mediaSizeBytes: params.mediaSizeBytes || null,
      status: 'delivered',
      source: 'whatsapp',
      createdAt: params.timestampMs,
      updatedAt: now
    })
    .onConflictDoNothing();

  if (params.mediaUrl) {
    await db
      .insert(messageMedia)
      .values({
        id: crypto.randomUUID(),
        organizationId: params.organizationId,
        messageId: msgId,
        providerMessageId: params.providerMessageId,
        mediaType: msgType,
        mimeType: params.mediaMimeType || null,
        filePath: params.mediaUrl,
        fileSize: params.mediaSizeBytes || null,
        filename: params.mediaFilename || null,
        caption: params.body || null,
        createdAt: now
      })
      .onConflictDoNothing();
  }

  const stopDetected = isStopOptOutText(params.body);
  if (stopDetected) {
    await recordStopOptOut(db, sysCtx, {
      phone: normalizedPhone,
      reason: 'stop_keyword',
      source: 'qr_bridge_inbound',
      notes: `Inbound QR keyword: ${params.body.slice(0, 100)}`,
      recordedByUserId: null
    });
  }

  await db
    .update(webhookEvents)
    .set({ processingStatus: 'processed', processedAt: Date.now() })
    .where(and(eq(webhookEvents.organizationId, params.organizationId), eq(webhookEvents.id, eventId)));

  return {
    duplicate: false,
    conversationId: convId,
    isStopKeyword: stopDetected,
    customerText: params.body
  };
}
