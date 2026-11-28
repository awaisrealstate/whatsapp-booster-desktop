import { and, desc, eq, asc, isNull, inArray, or, sql } from 'drizzle-orm';
import { normalizePhoneNumber } from '@wacrm/shared';
import type {
  QrBridgeHistorySyncChat,
  QrBridgeHistorySyncContact,
  QrBridgeHistorySyncMessage
} from '@wacrm/providers';
import type { AppDatabase } from './client.ts';
import type { OrgContext } from './tenant.ts';
import {
  contacts,
  conversations,
  messages,
  messageVersions,
  messageDeletionEvents,
  messageSyncJobs,
  messageMedia,
  conversationAuditLogs,
  type MessageDirection,
  type MessageSenderKind,
  type MessageType
} from './schema.ts';

export interface HistorySyncBatchParams {
  organizationId: string;
  whatsappAccountId: string;
  syncType?: string | null;
  progress?: number | null;
  isLatest?: boolean;
  chats: QrBridgeHistorySyncChat[];
  contacts?: QrBridgeHistorySyncContact[];
  messages: QrBridgeHistorySyncMessage[];
  timestampMs?: number;
}

export interface HistorySyncBatchResult {
  chatsProcessed: number;
  messagesImported: number;
  contactsProcessed: number;
  isLatest: boolean;
  jobId: string;
}

function extractPhoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const userPart = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = userPart.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export async function recordHistorySyncBatch(
  db: AppDatabase,
  params: HistorySyncBatchParams
): Promise<HistorySyncBatchResult> {
  const now = Date.now();
  const orgId = params.organizationId;
  const accountId = params.whatsappAccountId;

  // 1. Maintain or create active sync job
  let jobId: string = crypto.randomUUID();
  const existingJob = await db
    .select()
    .from(messageSyncJobs)
    .where(
      and(
        eq(messageSyncJobs.organizationId, orgId),
        eq(messageSyncJobs.whatsappAccountId, accountId),
        eq(messageSyncJobs.status, 'in_progress')
      )
    )
    .orderBy(desc(messageSyncJobs.createdAt))
    .limit(1);

  if (existingJob[0]) {
    jobId = existingJob[0].id;
  } else {
    await db.insert(messageSyncJobs).values({
      id: jobId,
      organizationId: orgId,
      whatsappAccountId: accountId,
      status: 'in_progress',
      syncType: params.syncType || 'history_sync',
      chatsSynced: 0,
      messagesSynced: 0,
      contactsSynced: 0,
      isLatest: params.isLatest ? 1 : 0,
      progress: params.progress ?? 0,
      startedAt: now,
      createdAt: now,
      updatedAt: now
    });
  }

  // 2. Process Contacts & build contact cache
  const contactMap = new Map<string, string>(); // jid or phone -> contactId
  let contactsProcessed = 0;

  for (const c of params.contacts ?? []) {
    if (!c.id) continue;
    const phoneDigits = extractPhoneFromJid(c.id);
    const phone = phoneDigits ? normalizePhoneNumber(phoneDigits) : c.id;
    const displayName = c.name?.trim() || c.notify?.trim() || c.verifiedName?.trim() || `WhatsApp ${phoneDigits || c.id}`;

    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, orgId),
          or(eq(contacts.phone, phone), eq(contacts.phone, `+${phone}`))
        )
      )
      .limit(1);

    if (existing[0]) {
      contactMap.set(c.id, existing[0].id);
      if (phoneDigits) {
        contactMap.set(phoneDigits, existing[0].id);
        contactMap.set(`+${phoneDigits}`, existing[0].id);
      }
    } else {
      const newContactId = crypto.randomUUID();
      await db
        .insert(contacts)
        .values({
          id: newContactId,
          organizationId: orgId,
          phone,
          rawPhone: c.id,
          name: displayName,
          customAttributesJson: JSON.stringify({ name: displayName, jid: c.id }),
          pipelineStage: 'lead',
          source: 'history_sync',
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoNothing();

      contactMap.set(c.id, newContactId);
      if (phoneDigits) {
        contactMap.set(phoneDigits, newContactId);
        contactMap.set(`+${phoneDigits}`, newContactId);
      }
      contactsProcessed++;
    }
  }

  // 3. Process Chats & build conversation cache (remoteJid -> conversationId)
  const convMap = new Map<string, string>();
  let chatsProcessed = 0;

  for (const chat of params.chats ?? []) {
    if (!chat.id) continue;
    const isGroup = Boolean(chat.isGroup || chat.id.endsWith('@g.us'));
    const phoneDigits = isGroup ? null : extractPhoneFromJid(chat.id);
    const phone = phoneDigits ? normalizePhoneNumber(phoneDigits) : chat.id;

    // Resolve or create contact
    let contactId = contactMap.get(chat.id) || (phoneDigits ? (contactMap.get(phoneDigits) || contactMap.get(`+${phoneDigits}`)) : undefined);
    if (!contactId) {
      const existing = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, orgId),
            or(eq(contacts.phone, phone), eq(contacts.phone, `+${phone}`))
          )
        )
        .limit(1);

      if (existing[0]) {
        contactId = existing[0].id;
      } else {
        contactId = crypto.randomUUID();
        const contactName = chat.name?.trim() || (isGroup ? 'WhatsApp Group' : `WhatsApp ${phoneDigits || phone}`);
        await db
          .insert(contacts)
          .values({
            id: contactId,
            organizationId: orgId,
            phone,
            rawPhone: chat.id,
            name: contactName,
            customAttributesJson: JSON.stringify({ name: contactName, jid: chat.id, isGroup }),
            pipelineStage: isGroup ? 'qualified' : 'lead',
            source: 'history_sync',
            createdAt: now,
            updatedAt: now
          })
          .onConflictDoNothing();
      }
      contactMap.set(chat.id, contactId);
      if (phoneDigits) {
        contactMap.set(phoneDigits, contactId);
        contactMap.set(`+${phoneDigits}`, contactId);
      }
    }

    // Resolve or create conversation
    const existingConv = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, orgId),
          or(eq(conversations.remoteJid, chat.id), eq(conversations.contactId, contactId)),
          eq(conversations.channelType, 'unofficial_local_desktop')
        )
      )
      .limit(1);

    let convId: string;
    if (existingConv[0]) {
      convId = existingConv[0].id;
      await db
        .update(conversations)
        .set({
          remoteJid: chat.id,
          isGroup: isGroup ? 1 : 0,
          groupSubject: isGroup ? (chat.name || null) : null,
          syncStatus: 'synced',
          lastSyncedAt: now,
          updatedAt: now
        })
        .where(and(eq(conversations.organizationId, orgId), eq(conversations.id, convId)));
    } else {
      convId = crypto.randomUUID();
      await db
        .insert(conversations)
        .values({
          id: convId,
          organizationId: orgId,
          contactId,
          whatsappAccountId: accountId,
          channelType: 'unofficial_local_desktop',
          status: 'open',
          remoteJid: chat.id,
          isGroup: isGroup ? 1 : 0,
          groupSubject: isGroup ? (chat.name || null) : null,
          syncStatus: 'synced',
          lastSyncedAt: now,
          unreadCount: chat.unreadCount ?? 0,
          lastMessageAt: chat.lastMessageTimestamp ? chat.lastMessageTimestamp * 1000 : null,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoNothing();
      chatsProcessed++;
    }
    convMap.set(chat.id, convId);
  }

  // 4. Ingest Historical Messages
  let messagesImported = 0;

  for (const m of params.messages ?? []) {
    if (!m.providerMessageId || !m.remoteJid) continue;
    const remoteJid = m.remoteJid;

    // Resolve conversation
    let convId = convMap.get(remoteJid);
    if (!convId) {
      // Find or create conversation dynamically
      const isGroup = remoteJid.endsWith('@g.us');
      const phoneDigits = isGroup ? null : extractPhoneFromJid(remoteJid);
      const phone = phoneDigits ? `+${phoneDigits}` : remoteJid;

      let contactId = contactMap.get(remoteJid) || (phoneDigits ? contactMap.get(phoneDigits) : undefined);
      if (!contactId) {
        const existing = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.organizationId, orgId), eq(contacts.phone, phone)))
          .limit(1);

        if (existing[0]) {
          contactId = existing[0].id;
        } else {
          contactId = crypto.randomUUID();
          const contactName = m.senderName?.trim() || (isGroup ? 'WhatsApp Group' : `WhatsApp ${phone}`);
          await db
            .insert(contacts)
            .values({
              id: contactId,
              organizationId: orgId,
              phone,
              rawPhone: remoteJid,
              name: contactName,
              customAttributesJson: JSON.stringify({ name: contactName, jid: remoteJid, isGroup }),
              pipelineStage: 'lead',
              source: 'history_sync',
              createdAt: now,
              updatedAt: now
            })
            .onConflictDoNothing();
        }
        contactMap.set(remoteJid, contactId);
        if (phoneDigits) contactMap.set(phoneDigits, contactId);
      }

      const existingConv = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, orgId),
            eq(conversations.contactId, contactId),
            eq(conversations.channelType, 'unofficial_local_desktop')
          )
        )
        .limit(1);

      if (existingConv[0]) {
        convId = existingConv[0].id;
      } else {
        convId = crypto.randomUUID();
        await db
          .insert(conversations)
          .values({
            id: convId,
            organizationId: orgId,
            contactId,
            whatsappAccountId: accountId,
            channelType: 'unofficial_local_desktop',
            status: 'open',
            remoteJid,
            isGroup: isGroup ? 1 : 0,
            syncStatus: 'synced',
            lastSyncedAt: now,
            unreadCount: 0,
            lastMessageAt: m.timestampMs,
            lastMessagePreview: (m.body || '').slice(0, 140),
            createdAt: now,
            updatedAt: now
          })
          .onConflictDoNothing();
      }
      convMap.set(remoteJid, convId);
    }

    const direction: MessageDirection = m.fromMe ? 'outbound' : 'inbound';
    const senderKind: MessageSenderKind = m.fromMe ? 'agent' : 'contact';
    const msgId = crypto.randomUUID();
    const msgType: MessageType = (['text', 'image', 'video', 'audio', 'document'].includes(m.msgType)
      ? m.msgType
      : 'text') as MessageType;

    const inserted = await db
      .insert(messages)
      .values({
        id: msgId,
        organizationId: orgId,
        conversationId: convId,
        direction,
        senderKind,
        msgType,
        body: m.body || '',
        providerMessageId: m.providerMessageId,
        idempotencyKey: `qr_sync:${m.providerMessageId}`,
        remoteJid: m.remoteJid,
        senderPhone: m.senderPhone || null,
        senderName: m.senderName || null,
        mediaUrl: m.mediaUrl || null,
        mediaMimeType: m.mediaMimeType || null,
        mediaFilename: m.mediaFilename || null,
        mediaSizeBytes: m.mediaSizeBytes || null,
        status: 'delivered',
        source: 'whatsapp',
        createdAt: m.timestampMs,
        updatedAt: now
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });

    if (inserted[0]?.id) {
      messagesImported++;

      // If media exists, record in messageMedia
      if (m.mediaUrl) {
        await db
          .insert(messageMedia)
          .values({
            id: crypto.randomUUID(),
            organizationId: orgId,
            messageId: inserted[0].id,
            providerMessageId: m.providerMessageId,
            mediaType: msgType,
            mimeType: m.mediaMimeType || null,
            filePath: m.mediaUrl,
            fileSize: m.mediaSizeBytes || null,
            filename: m.mediaFilename || null,
            caption: m.body || null,
            createdAt: now
          })
          .onConflictDoNothing();
      }

      // Update conversation last message preview/timestamp if newer
      await db
        .update(conversations)
        .set({
          lastMessagePreview: (m.body || `[${msgType}]`).slice(0, 140),
          lastMessageAt: m.timestampMs,
          updatedAt: now
        })
        .where(
          and(
            eq(conversations.organizationId, orgId),
            eq(conversations.id, convId),
            sql`${conversations.lastMessageAt} IS NULL OR ${conversations.lastMessageAt} <= ${m.timestampMs}`
          )
        );
    }
  }

  // 5. Update sync job progress
  const finalStatus = params.isLatest ? 'completed' : 'in_progress';
  await db
    .update(messageSyncJobs)
    .set({
      chatsSynced: sql`${messageSyncJobs.chatsSynced} + ${chatsProcessed}`,
      messagesSynced: sql`${messageSyncJobs.messagesSynced} + ${messagesImported}`,
      contactsSynced: sql`${messageSyncJobs.contactsSynced} + ${contactsProcessed}`,
      isLatest: params.isLatest ? 1 : 0,
      progress: params.progress ?? (params.isLatest ? 100 : 50),
      status: finalStatus,
      completedAt: params.isLatest ? now : null,
      updatedAt: now
    })
    .where(and(eq(messageSyncJobs.organizationId, orgId), eq(messageSyncJobs.id, jobId)));

  return {
    chatsProcessed,
    messagesImported,
    contactsProcessed,
    isLatest: Boolean(params.isLatest),
    jobId
  };
}

export async function recordMessageRevocation(
  db: AppDatabase,
  params: {
    organizationId: string;
    whatsappAccountId: string;
    providerMessageId: string;
    remoteJid?: string | null;
    deletedByJid?: string | null;
    deletedAtMs?: number;
    rawEventJson?: string | null;
  }
): Promise<{ preserved: boolean; messageId: string | null; conversationId: string | null }> {
  const now = Date.now();
  const deletedAt = params.deletedAtMs ?? now;

  const msgRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      body: messages.body,
      isDeletedOnWhatsapp: messages.isDeletedOnWhatsapp
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, params.organizationId),
        eq(messages.providerMessageId, params.providerMessageId)
      )
    )
    .limit(1);

  const msg = msgRows[0];

  // Mark message as deleted on WhatsApp, NEVER remove from messages table!
  if (msg) {
    await db
      .update(messages)
      .set({
        isDeletedOnWhatsapp: 1,
        whatsappDeletedAt: deletedAt,
        updatedAt: now
      })
      .where(and(eq(messages.organizationId, params.organizationId), eq(messages.id, msg.id)));

    // Record deletion event
    await db.insert(messageDeletionEvents).values({
      id: crypto.randomUUID(),
      organizationId: params.organizationId,
      conversationId: msg.conversationId,
      messageId: msg.id,
      providerMessageId: params.providerMessageId,
      deletedByJid: params.deletedByJid || null,
      deletionType: 'revoke',
      deletedAt,
      rawEventJson: params.rawEventJson || null,
      createdAt: now
    });

    // Record conversation audit log
    await db.insert(conversationAuditLogs).values({
      id: crypto.randomUUID(),
      organizationId: params.organizationId,
      conversationId: msg.conversationId,
      actorType: params.deletedByJid ? 'customer' : 'system',
      actorId: params.deletedByJid || null,
      action: 'message_deleted_on_whatsapp',
      metadataJson: JSON.stringify({
        providerMessageId: params.providerMessageId,
        deletedByJid: params.deletedByJid,
        deletedAt,
        archivedCopyPreserved: true
      }),
      createdAt: now
    });

    return {
      preserved: true,
      messageId: msg.id,
      conversationId: msg.conversationId
    };
  }

  // If message row not yet received, still record the deletion event so it won't be lost
  await db.insert(messageDeletionEvents).values({
    id: crypto.randomUUID(),
    organizationId: params.organizationId,
    conversationId: null,
    messageId: null,
    providerMessageId: params.providerMessageId,
    deletedByJid: params.deletedByJid || null,
    deletionType: 'revoke',
    deletedAt,
    rawEventJson: params.rawEventJson || null,
    createdAt: now
  });

  return {
    preserved: true,
    messageId: null,
    conversationId: null
  };
}

export async function recordMessageEdit(
  db: AppDatabase,
  params: {
    organizationId: string;
    whatsappAccountId: string;
    providerMessageId: string;
    remoteJid?: string | null;
    newBody: string;
    editedAtMs?: number;
  }
): Promise<{ updated: boolean; messageId: string | null; versionNumber: number }> {
  const now = Date.now();
  const editedAt = params.editedAtMs ?? now;

  const msgRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      body: messages.body,
      mediaUrl: messages.mediaUrl
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, params.organizationId),
        eq(messages.providerMessageId, params.providerMessageId)
      )
    )
    .limit(1);

  const msg = msgRows[0];
  if (!msg) {
    return { updated: false, messageId: null, versionNumber: 0 };
  }

  // Count existing versions to determine next version number
  const existingVersions = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageVersions)
    .where(
      and(
        eq(messageVersions.organizationId, params.organizationId),
        eq(messageVersions.messageId, msg.id)
      )
    );

  const nextVersionNumber = (existingVersions[0]?.count ?? 0) + 1;

  // Archive old message body in messageVersions
  await db.insert(messageVersions).values({
    id: crypto.randomUUID(),
    organizationId: params.organizationId,
    messageId: msg.id,
    providerMessageId: params.providerMessageId,
    body: msg.body,
    mediaUrl: msg.mediaUrl || null,
    versionNumber: nextVersionNumber,
    editedAt,
    createdAt: now
  });

  // Update messages with new body and edited flag
  await db
    .update(messages)
    .set({
      body: params.newBody,
      isEdited: 1,
      editedAt,
      updatedAt: now
    })
    .where(and(eq(messages.organizationId, params.organizationId), eq(messages.id, msg.id)));

  // Record audit log
  await db.insert(conversationAuditLogs).values({
    id: crypto.randomUUID(),
    organizationId: params.organizationId,
    conversationId: msg.conversationId,
    actorType: 'customer',
    action: 'message_edited_on_whatsapp',
    metadataJson: JSON.stringify({
      providerMessageId: params.providerMessageId,
      versionNumber: nextVersionNumber,
      editedAt
    }),
    createdAt: now
  });

  return {
    updated: true,
    messageId: msg.id,
    versionNumber: nextVersionNumber
  };
}

export async function getConversationMessageVersions(
  db: AppDatabase,
  ctx: OrgContext,
  messageId: string
) {
  return db
    .select()
    .from(messageVersions)
    .where(
      and(
        eq(messageVersions.organizationId, ctx.organizationId),
        eq(messageVersions.messageId, messageId)
      )
    )
    .orderBy(asc(messageVersions.versionNumber));
}

export async function getConversationAuditTimeline(
  db: AppDatabase,
  ctx: OrgContext,
  conversationId: string
) {
  return db
    .select()
    .from(conversationAuditLogs)
    .where(
      and(
        eq(conversationAuditLogs.organizationId, ctx.organizationId),
        eq(conversationAuditLogs.conversationId, conversationId)
      )
    )
    .orderBy(desc(conversationAuditLogs.createdAt));
}

export async function getSyncJobStatus(
  db: AppDatabase,
  ctx: OrgContext,
  whatsappAccountId?: string
) {
  const conditions = [eq(messageSyncJobs.organizationId, ctx.organizationId)];
  if (whatsappAccountId) {
    conditions.push(eq(messageSyncJobs.whatsappAccountId, whatsappAccountId));
  }

  const jobs = await db
    .select()
    .from(messageSyncJobs)
    .where(and(...conditions))
    .orderBy(desc(messageSyncJobs.createdAt))
    .limit(1);

  return jobs[0] ?? null;
}
