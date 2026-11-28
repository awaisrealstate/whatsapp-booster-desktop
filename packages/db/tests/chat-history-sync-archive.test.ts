import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb,
  registerUserWithDefaultOrg,
  createSessionForUser,
  resolveSessionContext,
  getOrCreateQrBridgeAccount,
  updateQrSessionState,
  recordHistorySyncBatch,
  recordMessageRevocation,
  recordMessageEdit,
  getConversationMessageVersions,
  getConversationAuditTimeline,
  getSyncJobStatus,
  recordQrBridgeInboundMessage,
  addMessageToConversation,
  listFilteredConversations,
  listConversationMessages,
  assignConversation,
  messages,
  messageDeletionEvents,
  messageVersions,
  messageSyncJobs,
  messageMedia
} from '../src/index.ts';
import { applyPhase1Migrations, createSqliteD1TestDatabase } from './helpers/sqlite-d1.ts';
import { and, eq } from 'drizzle-orm';

describe('Complete WhatsApp Chat History Sync & Permanent CRM Archive (Local & E2E)', () => {
  it('synchronizes chat history, handles inbound/outbound, preserves deleted messages, tracks edits, and isolates tenants', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    // 1. Setup Tenant Organizations A and B
    const orgA = await registerUserWithDefaultOrg(db, {
      email: 'ownerA@company.com',
      name: 'Owner A',
      password: 'Password123!'
    });
    const orgB = await registerUserWithDefaultOrg(db, {
      email: 'ownerB@company.com',
      name: 'Owner B',
      password: 'Password123!'
    });

    const sessA = await createSessionForUser(db, { userId: orgA.userId, activeOrganizationId: orgA.organizationId });
    const sessB = await createSessionForUser(db, { userId: orgB.userId, activeOrganizationId: orgB.organizationId });
    const ctxA = await resolveSessionContext(db, sessA.rawToken);
    const ctxB = await resolveSessionContext(db, sessB.rawToken);

    // 2. Connect WhatsApp using QR code
    const qrAcc = await getOrCreateQrBridgeAccount(db, ctxA, { label: 'Primary Business Phone' });
    assert.ok(qrAcc);

    await updateQrSessionState(db, {
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      status: 'connected',
      qrDataUrl: null,
      qrExpiresAt: null,
      phoneNumber: '+923001234567',
      lastConnectedAt: Date.now(),
      lastError: null
    });

    // 3. Complete Chat History Sync (Baileys messaging-history.set simulation)
    const historyPayload = {
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      syncType: 'FULL',
      progress: 50,
      isLatest: false,
      chats: [
        {
          id: '923009998877@s.whatsapp.net',
          name: 'VIP Client Ali',
          unreadCount: 2,
          lastMessageTimestamp: 1700000000,
          isGroup: false
        },
        {
          id: '123456789-group@g.us',
          name: 'VIP Wholesale Group',
          unreadCount: 0,
          lastMessageTimestamp: 1700001000,
          isGroup: true
        }
      ],
      contacts: [
        {
          id: '923009998877@s.whatsapp.net',
          name: 'VIP Client Ali',
          notify: 'Ali Buyer'
        }
      ],
      messages: [
        {
          providerMessageId: 'hist_msg_001',
          remoteJid: '923009998877@s.whatsapp.net',
          fromMe: false, // Inbound customer inquiry
          senderPhone: '+923009998877',
          senderName: 'Ali Buyer',
          body: 'Hello, what are your bulk software pricing tiers?',
          msgType: 'text' as const,
          timestampMs: 1700000000000
        },
        {
          providerMessageId: 'hist_msg_002',
          remoteJid: '923009998877@s.whatsapp.net',
          fromMe: true, // Outbound reply from phone
          senderPhone: '+923001234567',
          senderName: 'Owner A',
          body: 'Hello Ali! Pro Tier is $49/mo and Enterprise is $199/mo.',
          msgType: 'text' as const,
          timestampMs: 1700000500000
        },
        {
          providerMessageId: 'hist_msg_media_003',
          remoteJid: '923009998877@s.whatsapp.net',
          fromMe: false,
          senderPhone: '+923009998877',
          senderName: 'Ali Buyer',
          body: 'Here is our company purchase order document',
          msgType: 'document' as const,
          mediaUrl: '/media/orgA/acc1/hist_msg_media_003.pdf',
          mediaMimeType: 'application/pdf',
          mediaFilename: 'PO_November_2026.pdf',
          mediaSizeBytes: 142857,
          timestampMs: 1700000600000
        },
        {
          providerMessageId: 'hist_msg_grp_004',
          remoteJid: '123456789-group@g.us',
          fromMe: false,
          senderPhone: '+923214445566',
          senderName: 'Group Member Sara',
          body: 'Welcome everyone to the Wholesale Group!',
          msgType: 'text' as const,
          timestampMs: 1700001000000
        }
      ]
    };

    const syncBatch1 = await recordHistorySyncBatch(db, historyPayload);
    assert.equal(syncBatch1.chatsProcessed, 2);
    assert.equal(syncBatch1.messagesImported, 4);

    // 4. Verify conversations and messages in CRM
    const convList = await listFilteredConversations(db, ctxA, { filter: 'all' });
    assert.equal(convList.length, 2, 'Should have imported both 1-on-1 and group conversations');

    const aliConv = convList.find((c) => c.contactPhone === '+923009998877' || c.remoteJid === '923009998877@s.whatsapp.net');
    assert.ok(aliConv, 'Ali conversation should exist');
    assert.equal(aliConv.syncStatus, 'synced');
    assert.equal(aliConv.isGroup, 0);

    const grpConv = convList.find((c) => c.remoteJid === '123456789-group@g.us');
    assert.ok(grpConv, 'Group conversation should exist');
    assert.equal(grpConv.isGroup, 1);
    assert.equal(grpConv.groupSubject, 'VIP Wholesale Group');

    // 5. Test Filters: Groups Only, Unread Only
    const groupsOnly = await listFilteredConversations(db, ctxA, { filter: 'groups' });
    assert.equal(groupsOnly.length, 1);
    assert.equal(groupsOnly[0]?.remoteJid, '123456789-group@g.us');

    const unreadOnly = await listFilteredConversations(db, ctxA, { filter: 'unread' });
    assert.equal(unreadOnly.length, 1);
    assert.equal(unreadOnly[0]?.remoteJid, '923009998877@s.whatsapp.net');

    // 6. Inspect Messages in chronological order
    const aliMessages = await listConversationMessages(db, ctxA, aliConv.id);
    assert.equal(aliMessages.length, 3);
    assert.equal(aliMessages[0]?.providerMessageId, 'hist_msg_001');
    assert.equal(aliMessages[0]?.direction, 'inbound');
    assert.equal(aliMessages[1]?.providerMessageId, 'hist_msg_002');
    assert.equal(aliMessages[1]?.direction, 'outbound');
    assert.equal(aliMessages[2]?.providerMessageId, 'hist_msg_media_003');
    assert.equal(aliMessages[2]?.msgType, 'document');
    assert.equal(aliMessages[2]?.mediaFilename, 'PO_November_2026.pdf');

    // Check media table record
    const mediaRecords = await db
      .select()
      .from(messageMedia)
      .where(and(eq(messageMedia.organizationId, ctxA.organizationId), eq(messageMedia.providerMessageId, 'hist_msg_media_003')));
    assert.equal(mediaRecords.length, 1);
    assert.equal(mediaRecords[0]?.fileSize, 142857);

    // 7. Receive a new Live WhatsApp message
    const liveInbound = await recordQrBridgeInboundMessage(db, {
      eventType: 'inbound_message',
      eventId: 'evt_live_001',
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      fromPhone: '+923009998877',
      profileName: 'Ali Buyer',
      providerMessageId: 'live_msg_005',
      body: 'Can I pay via Bank Transfer?',
      timestampMs: 1700002000000,
      remoteJid: '923009998877@s.whatsapp.net',
      fromMe: false,
      msgType: 'text'
    });
    assert.equal(liveInbound.duplicate, false);

    // 8. Send reply from CRM
    const crmReply = await addMessageToConversation(db, ctxA, aliConv.id, {
      direction: 'outbound',
      senderKind: 'agent',
      body: 'Yes, our IBAN is PK36SCBL0000001123456701',
      providerMessageId: 'crm_out_006',
      status: 'delivered'
    });
    assert.ok(crmReply);

    // 9. CRITICAL ANTI-DELETE TEST:
    // Customer deletes message 'hist_msg_001' on WhatsApp ("Delete for Everyone")
    const revokeResult = await recordMessageRevocation(db, {
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      providerMessageId: 'hist_msg_001',
      remoteJid: '923009998877@s.whatsapp.net',
      deletedByJid: '923009998877@s.whatsapp.net',
      deletedAtMs: Date.now()
    });
    assert.equal(revokeResult.preserved, true);

    // Confirm message is NOT deleted in DB!
    const updatedMessages = await listConversationMessages(db, ctxA, aliConv.id);
    const revokedMsg = updatedMessages.find((m) => m.providerMessageId === 'hist_msg_001');
    assert.ok(revokedMsg, 'Archived message MUST still exist in database!');
    assert.equal(revokedMsg.isDeletedOnWhatsapp, 1, 'Message must be flagged as deleted on WhatsApp');
    assert.ok(revokedMsg.whatsappDeletedAt, 'Must record deletion timestamp');
    assert.equal(revokedMsg.body, 'Hello, what are your bulk software pricing tiers?', 'Original content MUST be preserved!');

    // Check message_deletion_events table
    const deletionEvents = await db
      .select()
      .from(messageDeletionEvents)
      .where(and(eq(messageDeletionEvents.organizationId, ctxA.organizationId), eq(messageDeletionEvents.providerMessageId, 'hist_msg_001')));
    assert.equal(deletionEvents.length, 1);
    assert.equal(deletionEvents[0]?.deletionType, 'revoke');

    // 10. CRITICAL MESSAGE EDIT TEST:
    // Message 'live_msg_005' was edited on WhatsApp
    const editResult = await recordMessageEdit(db, {
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      providerMessageId: 'live_msg_005',
      newBody: 'Can I pay via Bank Transfer or Credit Card? (Edited)',
      editedAtMs: Date.now()
    });
    assert.equal(editResult.updated, true);
    assert.equal(editResult.versionNumber, 1);

    // Confirm new message body and version history
    const editedMsgList = await listConversationMessages(db, ctxA, aliConv.id);
    const editedMsg = editedMsgList.find((m) => m.providerMessageId === 'live_msg_005');
    assert.ok(editedMsg);
    assert.equal(editedMsg.body, 'Can I pay via Bank Transfer or Credit Card? (Edited)');
    assert.equal(editedMsg.isEdited, 1);

    // Retrieve previous version from message_versions
    const versions = await getConversationMessageVersions(db, ctxA, editedMsg.id);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.body, 'Can I pay via Bank Transfer?');
    assert.equal(versions[0]?.versionNumber, 1);

    // 11. Idempotency on Reconnect / Repeated Sync:
    // WhatsApp reconnects and fires the same history batch again
    const syncBatch2 = await recordHistorySyncBatch(db, historyPayload);
    assert.equal(syncBatch2.messagesImported, 0, 'Re-syncing existing messages must import 0 duplicates');

    const totalAliMsgs = await listConversationMessages(db, ctxA, aliConv.id);
    // hist_msg_001, hist_msg_002, hist_msg_media_003, live_msg_005, crm_out_006 = exactly 5 messages
    assert.equal(totalAliMsgs.length, 5, 'Must not create duplicate messages');

    // 12. Check Sync Job Status
    const syncStatus = await getSyncJobStatus(db, ctxA, qrAcc.id);
    assert.ok(syncStatus);
    assert.equal(syncStatus.chatsSynced, 2);
    assert.equal(syncStatus.messagesSynced, 4);

    // 13. Audit Timeline & Team Assignment
    await assignConversation(db, ctxA, {
      conversationId: aliConv.id,
      handlerType: 'team_member',
      reason: 'Lead qualified by AI'
    });

    const auditTimeline = await getConversationAuditTimeline(db, ctxA, aliConv.id);
    assert.ok(auditTimeline.length >= 2, 'Audit timeline should record message deletion and assignment');
    const deleteAudit = auditTimeline.find((a) => a.action === 'message_deleted_on_whatsapp');
    assert.ok(deleteAudit, 'Audit log must record WhatsApp deletion event');

    // 14. Strict Tenant Isolation
    // Org B queries conversations and messages
    const orgBConvs = await listFilteredConversations(db, ctxB, { filter: 'all' });
    assert.equal(orgBConvs.length, 0, 'Org B must not see any of Org A conversations');

    const orgBMsgs = await db
      .select()
      .from(messages)
      .where(eq(messages.organizationId, ctxB.organizationId));
    assert.equal(orgBMsgs.length, 0, 'Org B must not have any messages');

    const orgBVersions = await db
      .select()
      .from(messageVersions)
      .where(eq(messageVersions.organizationId, ctxB.organizationId));
    assert.equal(orgBVersions.length, 0, 'Org B must not access Org A message versions');

    const orgBDeletions = await db
      .select()
      .from(messageDeletionEvents)
      .where(eq(messageDeletionEvents.organizationId, ctxB.organizationId));
    assert.equal(orgBDeletions.length, 0, 'Org B must not access Org A deletion records');
  });
});
