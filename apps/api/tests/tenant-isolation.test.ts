import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBridgeSignature,
  MetaCloudProvider,
  QrBridgeClient,
  verifyBridgeSignature,
  type QrSessionSnapshot
} from '@wacrm/providers';
import {
  createDb,
  createSessionForUser,
  organizationMembers,
  registerUserWithDefaultOrg
} from '@wacrm/db';
import {
  applyPhase1Migrations,
  createSqliteD1TestDatabase
} from '../../../packages/db/tests/helpers/sqlite-d1.ts';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';

const ENC_KEY = 'tenant-iso-encryption-key-32chars!';
const BRIDGE_SECRET = 'tenant-iso-bridge-secret-32-chars!';
const OWNER_ADMIN_EMAIL = 'platform.owner@example.com';

describe('Strict Owner & Customer Multi-Tenant WhatsApp & CRM Isolation', () => {
  it('enforces independent Owner/Customer connections, blocks cross-tenant access, enforces SaaS limits & separates Admin management', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    // 1. Create Platform Owner (with Owner's own separate org) + Customer A + Customer B + Customer A Viewer
    const owner = await registerUserWithDefaultOrg(db, {
      email: OWNER_ADMIN_EMAIL,
      name: 'Platform Owner',
      organizationName: 'Owner HQ Workspace',
      password: 'Password123!'
    });
    const custA = await registerUserWithDefaultOrg(db, {
      email: 'cust.a@example.com',
      name: 'Customer A',
      organizationName: 'Customer A Co',
      password: 'Password123!'
    });
    const custB = await registerUserWithDefaultOrg(db, {
      email: 'cust.b@example.com',
      name: 'Customer B',
      organizationName: 'Customer B Co',
      password: 'Password123!'
    });
    const custAViewer = await registerUserWithDefaultOrg(db, {
      email: 'viewer.a@example.com',
      name: 'Viewer A',
      password: 'Password123!'
    });
    await db.insert(organizationMembers).values({
      id: crypto.randomUUID(),
      organizationId: custA.organizationId,
      userId: custAViewer.userId,
      role: 'viewer',
      createdAt: Date.now()
    });

    const ownerSess = await createSessionForUser(db, {
      userId: owner.userId,
      activeOrganizationId: owner.organizationId
    });
    const custASess = await createSessionForUser(db, {
      userId: custA.userId,
      activeOrganizationId: custA.organizationId
    });
    const custBSess = await createSessionForUser(db, {
      userId: custB.userId,
      activeOrganizationId: custB.organizationId
    });
    const viewerSess = await createSessionForUser(db, {
      userId: custAViewer.userId,
      activeOrganizationId: custA.organizationId
    });

    const bridgeSessions = new Map<string, QrSessionSnapshot>();
    const bridgeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const reqUrl = new URL(url);
      const method = (init?.method || 'GET').toUpperCase();
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const lowerHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) lowerHeaders[k.toLowerCase()] = v;

      const sigValid = await verifyBridgeSignature({
        secret: BRIDGE_SECRET,
        timestampHeader: lowerHeaders['x-bridge-timestamp'],
        signatureHeader: lowerHeaders['x-bridge-signature'],
        method,
        path: `${reqUrl.pathname}${reqUrl.search}`,
        rawBody
      });
      if (!sigValid) {
        return new Response(JSON.stringify({ error: { code: 'INVALID_BRIDGE_SIGNATURE', message: 'Bad HMAC' } }), {
          status: 401
        });
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
      const snap: QrSessionSnapshot = {
        organizationId: body.organizationId!,
        whatsappAccountId: body.whatsappAccountId!,
        status: reqUrl.pathname.endsWith('/disconnect')
          ? 'disconnected'
          : reqUrl.pathname.endsWith('/reconnect')
            ? 'connected'
            : 'waiting_for_scan',
        qrDataUrl:
          reqUrl.pathname.endsWith('/start') || reqUrl.pathname.endsWith('/refresh')
            ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
            : null,
        qrExpiresAt: Date.now() + 60_000,
        phoneNumber: null,
        lastConnectedAt: null,
        lastError: null
      };
      bridgeSessions.set(key, snap);
      return new Response(JSON.stringify(snap), { status: 200 });
    };

    const metaProvider = new MetaCloudProvider({
      fetchFn: async (url) => {
        const u = String(url);
        if (u.includes('100001')) {
          return new Response(JSON.stringify({ id: '100001', display_phone_number: '+92 300 0000001', verified_name: 'OwnerHQ' }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: '200002', display_phone_number: '+92 300 0000002', verified_name: 'CustA' }), { status: 200 });
      }
    });

    const app = createApp({
      logger: createLogger('error'),
      metaProvider,
      qrBridge: new QrBridgeClient({ baseUrl: 'http://qr-service.internal', secret: BRIDGE_SECRET, fetchFn: bridgeFetch })
    });

    const env = {
      DB: d1,
      APP_ENV: 'production',
      ENCRYPTION_KEY: ENC_KEY,
      QR_BRIDGE_URL: 'http://qr-service.internal',
      QR_BRIDGE_SECRET: BRIDGE_SECRET,
      PLATFORM_ADMIN_EMAILS: OWNER_ADMIN_EMAIL
    };

    // 2. Owner connects their own separate QR session (phone 923001110001)
    const ownerQrRes = await app.request(
      '/api/v1/whatsapp/accounts/qr/start',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Owner QR Line' })
      },
      env
    );
    assert.equal(ownerQrRes.status, 200);
    const ownerQrId = ((await ownerQrRes.json()) as { account: { id: string } }).account.id;

    // Confirm Owner's QR connected via signed webhook
    const ownerConnPayload = JSON.stringify({
      eventType: 'session_update',
      organizationId: owner.organizationId,
      whatsappAccountId: ownerQrId,
      status: 'connected',
      phoneNumber: '+923001110001',
      lastConnectedAt: Date.now()
    });
    const ts1 = Date.now();
    await app.request(
      '/webhooks/qr-bridge',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts1),
          'X-Bridge-Signature': await computeBridgeSignature(BRIDGE_SECRET, ts1, 'POST', '/webhooks/qr-bridge', ownerConnPayload)
        },
        body: ownerConnPayload
      },
      env
    );

    // 3. Customer A connects Meta API on Free plan (limit = 1 account)
    const custAMetaRes = await app.request(
      '/api/v1/whatsapp/accounts/meta',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custASess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Cust A Official',
          metaWabaId: '88001122',
          metaPhoneNumberId: '200002',
          accessToken: 'EAAG-cust-a-secret',
          appSecret: 'cust-a-app-secret',
          webhookVerifyToken: 'cust-a-verify-token',
          verifyConnection: true
        })
      },
      env
    );
    assert.equal(custAMetaRes.status, 201);
    const custAMetaId = ((await custAMetaRes.json()) as { account: { id: string } }).account.id;

    // Customer A cannot add a 2nd WhatsApp account while on Free plan (maxWhatsappAccounts = 1 -> 402)
    const secondOnFree = await app.request(
      '/api/v1/whatsapp/accounts/qr/start',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custASess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Cust A Second QR' })
      },
      env
    );
    assert.equal(secondOnFree.status, 402);

    // 4. Customer users MUST be blocked from /api/v1/admin/* (403 PLATFORM_ADMIN_REQUIRED)
    const custAdminAttempt = await app.request(
      '/api/v1/admin/overview',
      { headers: { Authorization: `Bearer ${custASess.rawToken}` } },
      env
    );
    assert.equal(custAdminAttempt.status, 403);

    // 5. Platform Owner Admin views system overview & upgrades Customer A to Pro (without seeing tokens/QR/messages)
    const adminOverview = await app.request(
      '/api/v1/admin/overview',
      { headers: { Authorization: `Bearer ${ownerSess.rawToken}` } },
      env
    );
    assert.equal(adminOverview.status, 200);
    const adminBodyText = await adminOverview.text();
    assert.equal(adminBodyText.includes('EAAG-cust-a-secret'), false);
    assert.equal(adminBodyText.includes('qrDataUrl'), false);

    const adminUpgradeRes = await app.request(
      `/api/v1/admin/organizations/${custA.organizationId}/plan`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ planTier: 'pro', status: 'active' })
      },
      env
    );
    assert.equal(adminUpgradeRes.status, 200);

    // Now on Pro (maxWhatsappAccounts = 5), Customer A can add multiple WhatsApp accounts
    const custAQrRes = await app.request(
      '/api/v1/whatsapp/accounts/qr/start',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custASess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Cust A Test QR' })
      },
      env
    );
    assert.equal(custAQrRes.status, 200);
    const custAQrId = ((await custAQrRes.json()) as { account: { id: string } }).account.id;

    // 6. Owner Admin MUST NOT access Customer A's WhatsApp QR session or contacts!
    const ownerReadCustQr = await app.request(
      `/api/v1/whatsapp/accounts/qr/${custAQrId}/status`,
      { headers: { Authorization: `Bearer ${ownerSess.rawToken}` } },
      env
    );
    assert.equal(ownerReadCustQr.status, 404);

    // 7. Customer B connects their own QR session & attempts cross-tenant attacks against Customer A & Owner
    const custBQrRes = await app.request(
      '/api/v1/whatsapp/accounts/qr/start',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custBSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Cust B QR' })
      },
      env
    );
    assert.equal(custBQrRes.status, 200);
    const custBQrId = ((await custBQrRes.json()) as { account: { id: string } }).account.id;

    // Upgrade Customer B to Pro via Platform Admin so plan allowance permits multiple accounts, then verify 409 duplicate phone ID still blocks
    await app.request(
      `/api/v1/admin/organizations/${custB.organizationId}/plan`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ planTier: 'pro', status: 'active' })
      },
      env
    );

    // Attempt to reuse Customer A's Meta Phone Number ID -> 409 META_PHONE_ID_IN_USE
    const dupMeta = await app.request(
      '/api/v1/whatsapp/accounts/meta',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custBSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Hijack Meta',
          metaWabaId: '88001122',
          metaPhoneNumberId: '200002',
          accessToken: 'EAAG-attacker',
          webhookVerifyToken: 'verify-attack'
        })
      },
      env
    );
    assert.equal(dupMeta.status, 409);

    // Attempt cross-org QR status, start-with-ID, refresh, reconnect, disconnect & Meta verify -> ALL 404
    for (const [method, url, body] of [
      ['GET', `/api/v1/whatsapp/accounts/qr/${custAQrId}/status`, undefined],
      ['POST', '/api/v1/whatsapp/accounts/qr/start', JSON.stringify({ accountId: ownerQrId })],
      ['POST', `/api/v1/whatsapp/accounts/qr/${custAQrId}/refresh`, undefined],
      ['POST', `/api/v1/whatsapp/accounts/qr/${custAQrId}/reconnect`, undefined],
      ['POST', `/api/v1/whatsapp/accounts/qr/${custAQrId}/disconnect`, undefined],
      ['POST', `/api/v1/whatsapp/accounts/${custAMetaId}/verify`, undefined],
      ['POST', `/api/v1/whatsapp/accounts/${custAMetaId}/sync-templates`, undefined],
      ['POST', `/api/v1/whatsapp/accounts/${ownerQrId}/disconnect`, undefined]
    ] as const) {
      const res = await app.request(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${custBSess.rawToken}`,
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body
        },
        env
      );
      assert.equal(res.status, 404, `Expected 404 for cross-tenant ${method} ${url}`);
    }

    // Cross-tenant active phone collision: Customer B cannot claim Owner's currently connected QR phone (+923001110001)
    const hijackPhonePayload = JSON.stringify({
      eventType: 'session_update',
      organizationId: custB.organizationId,
      whatsappAccountId: custBQrId,
      status: 'connected',
      phoneNumber: '+923001110001',
      lastConnectedAt: Date.now()
    });
    const ts2 = Date.now();
    const collisionRes = await app.request(
      '/webhooks/qr-bridge',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts2),
          'X-Bridge-Signature': await computeBridgeSignature(BRIDGE_SECRET, ts2, 'POST', '/webhooks/qr-bridge', hijackPhonePayload)
        },
        body: hijackPhonePayload
      },
      env
    );
    assert.equal(collisionRes.status, 200);
    const collisionBody = (await collisionRes.json()) as {
      account: { connectionStatus: string; phoneNumber: string | null; lastError: string };
    };
    assert.equal(collisionBody.account.connectionStatus, 'error');
    assert.equal(collisionBody.account.phoneNumber, null);
    assert.match(collisionBody.account.lastError, /already actively connected/i);

    // Cross-tenant inbound message & reply send check
    const createContactA = await app.request(
      '/api/v1/crm/contacts',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custASess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cust A Lead', phone: '03004445566' })
      },
      env
    );
    const contactAId = ((await createContactA.json()) as { contact: { id: string } }).contact.id;

    const createConvA = await app.request(
      '/api/v1/crm/conversations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custASess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contactAId, channelType: 'unofficial_local_desktop' })
      },
      env
    );
    const convAId = ((await createConvA.json()) as { conversation: { id: string } }).conversation.id;

    // Customer B CANNOT read Customer A's messages or send to Customer A's conversation
    const bobMsgs = await app.request(
      `/api/v1/crm/conversations/${convAId}/messages`,
      { headers: { Authorization: `Bearer ${custBSess.rawToken}` } },
      env
    );
    assert.equal(bobMsgs.status, 404);

    const bobSend = await app.request(
      `/api/v1/whatsapp/conversations/${convAId}/send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${custBSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsappAccountId: custBQrId, body: 'Unauthorized send' })
      },
      env
    );
    assert.equal(bobSend.status, 404);

    // RBAC check: Viewer inside Customer A's org CANNOT connect/disconnect QR or send messages (403)
    const viewerQrStart = await app.request(
      '/api/v1/whatsapp/accounts/qr/start',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Blocked' })
      },
      env
    );
    assert.equal(viewerQrStart.status, 403);

    const viewerSend = await app.request(
      `/api/v1/whatsapp/conversations/${convAId}/send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerSess.rawToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsappAccountId: custAQrId, body: 'Blocked' })
      },
      env
    );
    assert.equal(viewerSend.status, 403);
  });
});
