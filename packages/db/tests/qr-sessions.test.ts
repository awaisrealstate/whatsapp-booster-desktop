import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addContactsToList,
  createCampaign,
  createContact,
  createContactList,
  createDb,
  createOrGetConversation,
  createSessionForUser,
  getOrCreateQrBridgeAccount,
  getQrSessionForOrg,
  listWhatsappAccounts,
  recordQrBridgeInboundMessage,
  registerUserWithDefaultOrg,
  resolveSessionContext,
  runScheduledCampaignTick,
  sendConversationReplyViaMeta,
  transitionCampaignStatus,
  updateQrSessionState,
  verifyAndUpdateMetaAccount
} from '../src/index.ts';
import { MetaCloudProvider, QrBridgeClient } from '@wacrm/providers';
import { applyPhase1Migrations, createSqliteD1TestDatabase } from './helpers/sqlite-d1.ts';

const ENC_KEY = 'db-qr-sessions-encryption-key-32chars!';

describe('Migration 0006 QR Bridge Sessions, Isolation & Multi-Provider Dispatch', () => {
  it('tracks QR lifecycle (connecting -> waiting_for_scan -> expired -> connected), isolates orgs & dispatches messages', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const orgA = await registerUserWithDefaultOrg(db, {
      email: 'qra@example.com',
      name: 'Org A',
      password: 'Password123!'
    });
    const orgB = await registerUserWithDefaultOrg(db, {
      email: 'qrb@example.com',
      name: 'Org B',
      password: 'Password123!'
    });
    const sessA = await createSessionForUser(db, { userId: orgA.userId, activeOrganizationId: orgA.organizationId });
    const sessB = await createSessionForUser(db, { userId: orgB.userId, activeOrganizationId: orgB.organizationId });
    const ctxA = await resolveSessionContext(db, sessA.rawToken);
    const ctxB = await resolveSessionContext(db, sessB.rawToken);

    const qrAcc = await getOrCreateQrBridgeAccount(db, ctxA, { label: 'Test QR Phone' });
    assert.ok(qrAcc);
    assert.equal(qrAcc.providerType, 'unofficial_bridge');
    assert.equal(qrAcc.isOfficial, false);
    assert.equal(qrAcc.qrStatus, 'connecting');

    // Org B cannot read Org A's QR session
    await assert.rejects(() => getQrSessionForOrg(db, ctxB, qrAcc.id), /not found/i);

    // Waiting for scan -> Expired automatically if past qrExpiresAt
    const pastTs = Date.now() - 5000;
    await updateQrSessionState(db, {
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      status: 'waiting_for_scan',
      qrDataUrl: 'data:image/png;base64,TESTQR',
      qrExpiresAt: pastTs,
      phoneNumber: null,
      lastConnectedAt: null,
      lastError: null
    });

    const expiredState = await getQrSessionForOrg(db, ctxA, qrAcc.id);
    assert.equal(expiredState.qrStatus, 'expired');
    assert.equal(expiredState.qrSession?.qrDataUrl, null);

    // Confirm connected state ONLY when backend sends status='connected'
    const connectedAt = Date.now();
    await updateQrSessionState(db, {
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      status: 'connected',
      qrDataUrl: null,
      qrExpiresAt: null,
      phoneNumber: '03001112233',
      lastConnectedAt: connectedAt,
      lastError: null
    });

    const accounts = await listWhatsappAccounts(db, ctxA);
    assert.equal(accounts[0]?.connectionStatus, 'connected');
    assert.equal(accounts[0]?.phoneNumber, '923001112233');
    assert.equal(accounts[0]?.lastConnectedAt, connectedAt);

    // Dispatch campaign + conversation reply through QrBridgeClient without disturbing Meta
    const sentTexts: Array<{ toPhone: string; text: string }> = [];
    const mockQrBridge = new QrBridgeClient({
      baseUrl: 'http://127.0.0.1:8790',
      secret: 'bridge-secret-32-characters-minimum!',
      fetchFn: async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as { toPhone: string; text: string };
        sentTexts.push(parsed);
        return new Response(
          JSON.stringify({ providerMessageId: `qr_msg_${sentTexts.length}`, recipientWaId: parsed.toPhone }),
          { status: 200 }
        );
      }
    });

    const c1 = await createContact(db, ctxA, { name: 'Ali', phone: '03005556677' });
    const list = await createContactList(db, ctxA, { name: 'QR Test List' });
    await addContactsToList(db, ctxA, list!.id, [c1!.id]);

    const camp = await createCampaign(db, ctxA, {
      name: 'QR Test Campaign',
      whatsappAccountId: qrAcc.id,
      listId: list!.id,
      messageOverride: 'Hello {name} from QR'
    });
    await transitionCampaignStatus(db, ctxA, camp!.id, 'launch');
    const tick = await runScheduledCampaignTick(db, {
      encryptionKey: ENC_KEY,
      qrBridge: mockQrBridge,
      inlineFallbackLimit: 5
    });
    assert.equal(tick.inlineProcessed, 1);
    assert.equal(sentTexts[0]?.text, 'Hello Ali from QR');

    const conv = await createOrGetConversation(db, ctxA, {
      contactId: c1!.id,
      channelType: 'unofficial_local_desktop'
    });
    const reply = await sendConversationReplyViaMeta(db, ctxA, {
      conversationId: conv!.id,
      whatsappAccountId: qrAcc.id,
      body: 'Follow up reply',
      encryptionKey: ENC_KEY,
      qrBridge: mockQrBridge
    });
    assert.equal(reply.status, 'sent');
    assert.equal(sentTexts.length, 2);

    // Inbound QR message + STOP keyword auto-suppression
    const stopEvt = await recordQrBridgeInboundMessage(db, {
      eventType: 'inbound_message',
      eventId: 'evt-qr-stop-1',
      organizationId: ctxA.organizationId,
      whatsappAccountId: qrAcc.id,
      fromPhone: '+923005556677',
      profileName: 'Ali',
      providerMessageId: 'qr_in_stop_1',
      body: 'STOP',
      timestampMs: Date.now()
    });
    assert.equal(stopEvt.isStopKeyword, true);
  });

  it('keeps Meta Cloud API credential verification and encryption fully working alongside QR accounts', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const org = await registerUserWithDefaultOrg(db, {
      email: 'meta@example.com',
      name: 'Meta Owner',
      password: 'Password123!'
    });
    const sess = await createSessionForUser(db, { userId: org.userId, activeOrganizationId: org.organizationId });
    const ctx = await resolveSessionContext(db, sess.rawToken);

    const { connectMetaWhatsappAccount } = await import('../src/whatsapp.ts');
    const metaAcc = await connectMetaWhatsappAccount(
      db,
      ctx,
      {
        label: 'Meta Main',
        metaWabaId: '9988776655',
        metaPhoneNumberId: '1122334455',
        accessToken: 'EAAG-live-secret-token',
        appSecret: 'meta-secret-1234',
        webhookVerifyToken: 'verify-me-1234'
      },
      ENC_KEY
    );

    const provider = new MetaCloudProvider({
      fetchFn: async () =>
        new Response(
          JSON.stringify({ id: '1122334455', display_phone_number: '+92 321 4445566', verified_name: 'Pro CRM' }),
          { status: 200 }
        )
    });

    const verified = await verifyAndUpdateMetaAccount(db, ctx, metaAcc!.id, ENC_KEY, provider);
    assert.equal(verified.verified, true);
    assert.equal(verified.phoneNumber, '+92 321 4445566');
    assert.equal(verified.verifiedName, 'Pro CRM');
    assert.equal(verified.account?.isOfficial, true);
  });
});
