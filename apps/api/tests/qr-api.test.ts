import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBridgeSignature,
  MetaCloudProvider,
  QrBridgeClient,
  verifyBridgeSignature,
  type QrSessionSnapshot
} from '@wacrm/providers';
import { createDb, createSessionForUser, registerUserWithDefaultOrg } from '@wacrm/db';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from '../../../packages/db/tests/helpers/sqlite-d1.ts';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';

const ENC_KEY = 'api-qr-test-encryption-key-32-chars!!';
const BRIDGE_SECRET = 'api-qr-test-bridge-secret-32-chars!!';

describe('Dual WhatsApp Connection API: Meta Official API + Unofficial QR Service E2E', () => {
  it('supports Option A Meta live verification alongside Option B QR flow, webhooks & strict tenant isolation', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const alice = await registerUserWithDefaultOrg(db, {
      email: 'alice-qr@example.com',
      name: 'Alice',
      password: 'Password123!'
    });
    const bob = await registerUserWithDefaultOrg(db, {
      email: 'bob-qr@example.com',
      name: 'Bob',
      password: 'Password123!'
    });
    const aliceSess = await createSessionForUser(db, { userId: alice.userId, activeOrganizationId: alice.organizationId });
    const bobSess = await createSessionForUser(db, { userId: bob.userId, activeOrganizationId: bob.organizationId });

    const bridgeSessions = new Map<string, QrSessionSnapshot>();
    const bridgeSent: Array<{ organizationId: string; whatsappAccountId: string; toPhone: string; text: string }> = [];

    const qrUrl = 'http://qr-service.internal';
    const bridgeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const reqUrl = new URL(url);
      const method = (init?.method || 'GET').toUpperCase();
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const lowerHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) lowerHeaders[k.toLowerCase()] = v;

      const validSig = await verifyBridgeSignature({
        secret: BRIDGE_SECRET,
        timestampHeader: lowerHeaders['x-bridge-timestamp'],
        signatureHeader: lowerHeaders['x-bridge-signature'],
        method,
        path: `${reqUrl.pathname}${reqUrl.search}`,
        rawBody
      });
      if (!validSig) {
        return new Response(
          JSON.stringify({ error: { code: 'INVALID_BRIDGE_SIGNATURE', message: 'Bad HMAC' } }),
          { status: 401 }
        );
      }

      if (method === 'GET' && reqUrl.pathname === '/internal/sessions/status') {
        const orgId = reqUrl.searchParams.get('organizationId') || '';
        const accId = reqUrl.searchParams.get('whatsappAccountId') || '';
        const snap = bridgeSessions.get(`${orgId}:${accId}`) ?? {
          organizationId: orgId,
          whatsappAccountId: accId,
          status: 'disconnected',
          qrDataUrl: null,
          qrExpiresAt: null,
          phoneNumber: null,
          lastConnectedAt: null,
          lastError: null
        };
        return new Response(JSON.stringify(snap), { status: 200 });
      }

      const body = JSON.parse(rawBody || '{}') as Record<string, string>;
      const key = `${body.organizationId}:${body.whatsappAccountId}`;

      if (reqUrl.pathname === '/internal/sessions/start' || reqUrl.pathname === '/internal/sessions/refresh') {
        const snap: QrSessionSnapshot = {
          organizationId: body.organizationId!,
          whatsappAccountId: body.whatsappAccountId!,
          status: 'waiting_for_scan',
          qrDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          qrExpiresAt: Date.now() + 60_000,
          phoneNumber: null,
          lastConnectedAt: null,
          lastError: null
        };
        bridgeSessions.set(key, snap);
        return new Response(JSON.stringify(snap), { status: 200 });
      }

      if (reqUrl.pathname === '/internal/sessions/reconnect') {
        const prev = bridgeSessions.get(key);
        const snap: QrSessionSnapshot = {
          organizationId: body.organizationId!,
          whatsappAccountId: body.whatsappAccountId!,
          status: 'connected',
          qrDataUrl: null,
          qrExpiresAt: null,
          phoneNumber: prev?.phoneNumber || '+923331112233',
          lastConnectedAt: Date.now(),
          lastError: null
        };
        bridgeSessions.set(key, snap);
        return new Response(JSON.stringify(snap), { status: 200 });
      }

      if (reqUrl.pathname === '/internal/sessions/disconnect') {
        const prev = bridgeSessions.get(key);
        const snap: QrSessionSnapshot = {
          organizationId: body.organizationId!,
          whatsappAccountId: body.whatsappAccountId!,
          status: 'disconnected',
          qrDataUrl: null,
          qrExpiresAt: null,
          phoneNumber: prev?.phoneNumber || null,
          lastConnectedAt: prev?.lastConnectedAt || null,
          lastError: null
        };
        bridgeSessions.set(key, snap);
        return new Response(JSON.stringify(snap), { status: 200 });
      }

      if (reqUrl.pathname === '/internal/messages/send') {
        bridgeSent.push({
          organizationId: body.organizationId!,
          whatsappAccountId: body.whatsappAccountId!,
          toPhone: body.toPhone!,
          text: body.text!
        });
        return new Response(
          JSON.stringify({ providerMessageId: 'qr_sent_e2e_1', recipientWaId: body.toPhone }),
          { status: 200 }
        );
      }

      return new Response('{}', { status: 404 });
    };

    const mockMetaProvider = new MetaCloudProvider({
      fetchFn: async () =>
        new Response(
          JSON.stringify({ id: '555666777', display_phone_number: '+92 300 9998877', verified_name: 'Meta Store' }),
          { status: 200 }
        )
    });

    const app = createApp({
      logger: createLogger('error'),
      metaProvider: mockMetaProvider,
      qrBridge: new QrBridgeClient({ baseUrl: qrUrl, secret: BRIDGE_SECRET, fetchFn: bridgeFetch })
    });

    const env = {
        DB: d1,
        APP_ENV: 'production',
        ENCRYPTION_KEY: ENC_KEY,
        QR_BRIDGE_URL: qrUrl,
        QR_BRIDGE_SECRET: BRIDGE_SECRET
      };

      // 1. Fails closed (503) when QR Bridge env vars are omitted and no override is used
      const unconfiguredApp = createApp({ logger: createLogger('error'), metaProvider: mockMetaProvider });
      const unconfiguredRes = await unconfiguredApp.request(
        '/api/v1/whatsapp/accounts/qr/start',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        },
        { DB: d1, ENCRYPTION_KEY: ENC_KEY }
      );
      assert.equal(unconfiguredRes.status, 503);

      // 2. Option A: Meta live credential check & verified connect
      const metaVerifyRes = await app.request(
        '/api/v1/whatsapp/accounts/meta/verify',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            metaWabaId: '999000111',
            metaPhoneNumberId: '555666777',
            accessToken: 'EAAG-valid-secret-token'
          })
        },
        env
      );
      assert.equal(metaVerifyRes.status, 200);
      const metaVerifyBody = (await metaVerifyRes.json()) as { verified: boolean; phoneNumber: string };
      assert.equal(metaVerifyBody.verified, true);
      assert.equal(metaVerifyBody.phoneNumber, '+92 300 9998877');

      const metaSaveRes = await app.request(
        '/api/v1/whatsapp/accounts/meta',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Official Meta Line',
            metaWabaId: '999000111',
            metaPhoneNumberId: '555666777',
            accessToken: 'EAAG-valid-secret-token',
            appSecret: 'meta-app-secret-1234',
            webhookVerifyToken: 'verify-token-999',
            verifyConnection: true
          })
        },
        env
      );
      assert.equal(metaSaveRes.status, 201);

      // 3. SaaS limit allows 1 WhatsApp number on Free; upgrading to Pro unlocks adding Option B QR alongside Meta
      const blockedQrOnFree = await app.request(
        '/api/v1/whatsapp/accounts/qr/start',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Blocked 2nd On Free' })
        },
        env
      );
      assert.equal(blockedQrOnFree.status, 402);

      const upgradeRes = await app.request(
        '/api/v1/subscription/plan',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ planTier: 'pro' })
        },
        env
      );
      assert.equal(upgradeRes.status, 200);

      // Option B: Start Unofficial QR session -> waiting_for_scan with safe DataURL
      const qrStartRes = await app.request(
        '/api/v1/whatsapp/accounts/qr/start',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Test QR Device' })
        },
        env
      );
      assert.equal(qrStartRes.status, 200);
      const qrStartBody = (await qrStartRes.json()) as {
        account: { id: string; providerType: string; isOfficial: boolean };
        session: { status: string; qrDataUrl: string | null };
        official: boolean;
        complianceNotice: string;
      };
      assert.equal(qrStartBody.official, false);
      assert.equal(qrStartBody.account.providerType, 'unofficial_bridge');
      assert.equal(qrStartBody.account.isOfficial, false);
      assert.equal(qrStartBody.session.status, 'waiting_for_scan');
      assert.ok(qrStartBody.session.qrDataUrl?.startsWith('data:image/png;base64,'));
      assert.match(qrStartBody.complianceNotice, /unofficial/i);
      assert.equal(JSON.stringify(qrStartBody).includes('noiseKey'), false);

      const qrAccountId = qrStartBody.account.id;

      // Cross-org isolation: Bob cannot check, refresh, or disconnect Alice's QR session
      const bobStatus = await app.request(
        `/api/v1/whatsapp/accounts/qr/${qrAccountId}/status`,
        { headers: { Authorization: `Bearer ${bobSess.rawToken}` } },
        env
      );
      assert.equal(bobStatus.status, 404);

      const bobDisconnect = await app.request(
        `/api/v1/whatsapp/accounts/qr/${qrAccountId}/disconnect`,
        { method: 'POST', headers: { Authorization: `Bearer ${bobSess.rawToken}` } },
        env
      );
      assert.equal(bobDisconnect.status, 404);

      // Simulate Linked Devices scan completion pushed via signed QR bridge webhook
      const sessEvtBody = JSON.stringify({
        eventType: 'session_update',
        organizationId: alice.organizationId,
        whatsappAccountId: qrAccountId,
        status: 'connected',
        phoneNumber: '+923331112233',
        lastConnectedAt: Date.now()
      });
      const sessTs = Date.now();
      const sessSig = await computeBridgeSignature(BRIDGE_SECRET, sessTs, 'POST', '/webhooks/qr-bridge', sessEvtBody);
      const sessWebhookRes = await app.request(
        '/webhooks/qr-bridge',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Timestamp': String(sessTs),
            'X-Bridge-Signature': sessSig
          },
          body: sessEvtBody
        },
        env
      );
      assert.equal(sessWebhookRes.status, 200);

      // Update mock bridge server snapshot too and query status endpoint
      bridgeSessions.set(`${alice.organizationId}:${qrAccountId}`, {
        organizationId: alice.organizationId,
        whatsappAccountId: qrAccountId,
        status: 'connected',
        qrDataUrl: null,
        qrExpiresAt: null,
        phoneNumber: '+923331112233',
        lastConnectedAt: Date.now(),
        lastError: null
      });

      const connectedRes = await app.request(
        `/api/v1/whatsapp/accounts/qr/${qrAccountId}/status`,
        { headers: { Authorization: `Bearer ${aliceSess.rawToken}` } },
        env
      );
      const connectedBody = (await connectedRes.json()) as {
        account: { phoneNumber: string; connectionStatus: string; lastConnectedAt: number };
        session: { status: string };
      };
      assert.equal(connectedBody.session.status, 'connected');
      assert.equal(connectedBody.account.connectionStatus, 'connected');
      assert.equal(connectedBody.account.phoneNumber, '923331112233');
      assert.ok(connectedBody.account.lastConnectedAt > 0);

      // 4. Signed /webhooks/qr-bridge security check & inbound message recording
      const badWebhook = await app.request(
        '/webhooks/qr-bridge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Signature': 'v1=0000' },
          body: '{}'
        },
        env
      );
      assert.equal(badWebhook.status, 401);

      const inboundPayload = JSON.stringify({
        eventType: 'inbound_message',
        eventId: 'qr_evt_in_1',
        organizationId: alice.organizationId,
        whatsappAccountId: qrAccountId,
        fromPhone: '+923001234567',
        profileName: 'Customer One',
        providerMessageId: 'qr_in_msg_1',
        body: 'Hello from WhatsApp',
        timestampMs: Date.now()
      });
      const ts = Date.now();
      const sig = await computeBridgeSignature(BRIDGE_SECRET, ts, 'POST', '/webhooks/qr-bridge', inboundPayload);
      const okWebhook = await app.request(
        '/webhooks/qr-bridge',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Timestamp': String(ts),
            'X-Bridge-Signature': sig
          },
          body: inboundPayload
        },
        env
      );
      assert.equal(okWebhook.status, 200);
      const webhookResBody = (await okWebhook.json()) as { conversationId: string };
      assert.ok(webhookResBody.conversationId);

      // Send reply back through QR session
      const sendRes = await app.request(
        `/api/v1/whatsapp/conversations/${webhookResBody.conversationId}/send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ whatsappAccountId: qrAccountId, body: 'Reply via QR Bridge' })
        },
        env
      );
      assert.equal(sendRes.status, 201);
      assert.equal(bridgeSent[0]?.text, 'Reply via QR Bridge');

      // Disconnect & Reconnect checks
      const discRes = await app.request(
        `/api/v1/whatsapp/accounts/qr/${qrAccountId}/disconnect`,
        { method: 'POST', headers: { Authorization: `Bearer ${aliceSess.rawToken}` } },
        env
      );
      assert.equal(discRes.status, 200);
      assert.equal(((await discRes.json()) as { session: { status: string } }).session.status, 'disconnected');

      const recRes = await app.request(
        `/api/v1/whatsapp/accounts/qr/${qrAccountId}/reconnect`,
        { method: 'POST', headers: { Authorization: `Bearer ${aliceSess.rawToken}` } },
        env
      );
      assert.equal(recRes.status, 200);
      assert.equal(((await recRes.json()) as { session: { status: string } }).session.status, 'connected');
  });
});
