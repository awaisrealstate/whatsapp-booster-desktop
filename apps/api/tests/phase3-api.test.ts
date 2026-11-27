import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetaCloudProvider } from '@wacrm/providers';
import { createDb, createSessionForUser, registerUserWithDefaultOrg } from '@wacrm/db';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from '../../../packages/db/tests/helpers/sqlite-d1.ts';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';

const TEST_ENC_KEY = 'api-phase3-encryption-key-32-chars!!';

async function signWebhook(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('Phase 3 API: Meta Cloud API, Webhooks, 24h Window, Templates & Cloud Campaigns', () => {
  it('enforces auth & tenant isolation on whatsapp/templates/campaigns and verifies Meta webhooks strictly', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const alice = await registerUserWithDefaultOrg(db, {
      email: 'alice@example.com',
      name: 'Alice',
      password: 'Password123!'
    });
    const bob = await registerUserWithDefaultOrg(db, {
      email: 'bob@example.com',
      name: 'Bob',
      password: 'Password123!'
    });
    const aliceSess = await createSessionForUser(db, {
      userId: alice.userId,
      activeOrganizationId: alice.organizationId
    });
    const bobSess = await createSessionForUser(db, {
      userId: bob.userId,
      activeOrganizationId: bob.organizationId
    });

    const outboundCalls: Array<{ url: string; body: unknown }> = [];
    const mockProvider = new MetaCloudProvider({
      fetchFn: async (url, init) => {
        const u = String(url);
        if (u.includes('/message_templates')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'meta-tpl-100',
                  name: 'spring_promo',
                  language: 'en_US',
                  category: 'MARKETING',
                  status: 'APPROVED',
                  components: [{ type: 'BODY', text: 'Hi {{1}}, special offer for {{2}}!' }]
                }
              ]
            }),
            { status: 200 }
          );
        }
        outboundCalls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(
          JSON.stringify({ messages: [{ id: `wamid.api.${outboundCalls.length}` }], contacts: [{ wa_id: '923001112233' }] }),
          { status: 200 }
        );
      }
    });

    const app = createApp({ logger: createLogger('error'), metaProvider: mockProvider });
    const env = { DB: d1, APP_ENV: 'development', ENCRYPTION_KEY: TEST_ENC_KEY };

    // Unauthenticated routes rejected
    assert.equal((await app.request('/api/v1/whatsapp/accounts', {}, env)).status, 401);
    assert.equal((await app.request('/api/v1/campaigns', {}, env)).status, 401);
    assert.equal((await app.request('/api/v1/templates', {}, env)).status, 401);

    const aliceHeaders = { Authorization: `Bearer ${aliceSess.rawToken}`, 'Content-Type': 'application/json' };
    const bobHeaders = { Authorization: `Bearer ${bobSess.rawToken}`, 'Content-Type': 'application/json' };

    // 1. Connect Meta Cloud account (encrypted credentials never echoed back)
    const connRes = await app.request(
      '/api/v1/whatsapp/accounts/meta',
      {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          label: 'Official WA Business',
          phoneNumber: '03000001111',
          metaWabaId: '888999000111',
          metaPhoneNumberId: '1234500001',
          accessToken: 'EAAG-very-secret-access-token',
          appSecret: 'super-secret-app-secret',
          webhookVerifyToken: 'verify-secret-token-2026'
        })
      },
      env
    );
    assert.equal(connRes.status, 201);
    const connText = await connRes.text();
    assert.equal(connText.includes('EAAG-very-secret-access-token'), false);
    assert.equal(connText.includes('super-secret-app-secret'), false);
    const { account } = JSON.parse(connText) as { account: { id: string } };

    // Bob cannot access Alice's WhatsApp account or sync her templates
    const bobSync = await app.request(
      `/api/v1/whatsapp/accounts/${account.id}/sync-templates`,
      { method: 'POST', headers: bobHeaders },
      env
    );
    assert.equal(bobSync.status, 404);

    // 2. Sync Meta Templates
    const syncRes = await app.request(
      `/api/v1/whatsapp/accounts/${account.id}/sync-templates`,
      { method: 'POST', headers: aliceHeaders },
      env
    );
    assert.equal(syncRes.status, 200);

    const tplListRes = await app.request('/api/v1/templates', { headers: aliceHeaders }, env);
    const { items: tpls } = (await tplListRes.json()) as { items: Array<{ id: string; name: string }> };
    assert.equal(tpls.length, 1);
    assert.equal(tpls[0]?.name, 'spring_promo');

    // 3. Create Contacts & List + STOP opt-out contact
    const c1Res = await app.request(
      '/api/v1/crm/contacts',
      { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ name: 'Ali Khan', phone: '03001112233', company: 'Acme' }) },
      env
    );
    const { contact: c1 } = (await c1Res.json()) as { contact: { id: string } };

    const c2Res = await app.request(
      '/api/v1/crm/contacts',
      { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ name: 'Blocked User', phone: '03219998877' }) },
      env
    );
    const { contact: c2 } = (await c2Res.json()) as { contact: { id: string } };

    await app.request(
      '/api/v1/crm/consent/stop',
      { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ phone: '03219998877' }) },
      env
    );

    const listRes = await app.request(
      '/api/v1/crm/lists',
      { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ name: 'Meta Campaign List' }) },
      env
    );
    const { list } = (await listRes.json()) as { list: { id: string } };

    await app.request(
      `/api/v1/crm/lists/${list.id}/members`,
      { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ contactIds: [c1.id, c2.id] }) },
      env
    );

    // 4. Test 24h customer care window enforcement on Inbox direct reply
    const convRes = await app.request(
      '/api/v1/crm/conversations',
      { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ contactId: c1.id, channelType: 'official_meta_cloud' }) },
      env
    );
    const { conversation } = (await convRes.json()) as { conversation: { id: string } };

    const blockedFreeform = await app.request(
      `/api/v1/whatsapp/conversations/${conversation.id}/send`,
      {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ whatsappAccountId: account.id, body: 'Hi freeform outside window' })
      },
      env
    );
    assert.equal(blockedFreeform.status, 422);

    // 5. Create & Launch Campaign using approved Meta template -> dispatch-tick sends to Ali, skips Blocked User
    const campRes = await app.request(
      '/api/v1/campaigns',
      {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          name: 'Spring Meta Launch',
          whatsappAccountId: account.id,
          listId: list.id,
          templateId: tpls[0]!.id
        })
      },
      env
    );
    assert.equal(campRes.status, 201);
    const { campaign } = (await campRes.json()) as { campaign: { id: string } };

    // Bob cannot view or launch Alice's campaign
    assert.equal((await app.request(`/api/v1/campaigns/${campaign.id}`, { headers: bobHeaders }, env)).status, 404);

    assert.equal(
      (await app.request(`/api/v1/campaigns/${campaign.id}/launch`, { method: 'POST', headers: aliceHeaders }, env)).status,
      200
    );

    const tickRes = await app.request(
      `/api/v1/campaigns/${campaign.id}/dispatch-tick`,
      { method: 'POST', headers: aliceHeaders },
      env
    );
    assert.equal(tickRes.status, 200);
    const tickJson = (await tickRes.json()) as { campaign: { status: string; sentCount: number; skippedCount: number } };
    assert.equal(tickJson.campaign.status, 'completed');
    assert.equal(tickJson.campaign.sentCount, 1);
    assert.equal(tickJson.campaign.skippedCount, 1);
    assert.equal(outboundCalls.length, 1);

    // 6. Meta Webhook Challenge & HMAC-SHA256 Signed Events
    const badVerify = await app.request(
      '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc',
      {},
      env
    );
    assert.equal(badVerify.status, 403);

    const okVerify = await app.request(
      '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-secret-token-2026&hub.challenge=meta-ch-99',
      {},
      env
    );
    assert.equal(okVerify.status, 200);
    assert.equal(await okVerify.text(), 'meta-ch-99');

    const webhookBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1234500001' },
                contacts: [{ wa_id: '923001112233', profile: { name: 'Ali Khan' } }],
                messages: [
                  {
                    id: 'wamid.in.hello',
                    from: '923001112233',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hi, thanks!' }
                  }
                ],
                statuses: [
                  {
                    id: 'wamid.api.1',
                    status: 'read',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: '923001112233'
                  }
                ]
              }
            }
          ]
        }
      ]
    });

    // Reject missing/invalid X-Hub-Signature-256
    const badSigRes = await app.request(
      '/webhooks/meta',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) },
        body: webhookBody
      },
      env
    );
    assert.equal(badSigRes.status, 401);

    // Valid signature succeeds, marks campaign readCount=1 AND opens 24h window so Inbox reply now succeeds!
    const goodSig = await signWebhook(webhookBody, 'super-secret-app-secret');
    const goodWebhookRes = await app.request(
      '/webhooks/meta',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': goodSig },
        body: webhookBody
      },
      env
    );
    assert.equal(goodWebhookRes.status, 200);

    const reportRes = await app.request(`/api/v1/campaigns/${campaign.id}/report`, { headers: aliceHeaders }, env);
    const reportJson = (await reportRes.json()) as { campaign: { readCount: number } };
    assert.equal(reportJson.campaign.readCount, 1);

    // Now freeform reply in 24h window succeeds!
    const convsRes = await app.request('/api/v1/crm/conversations', { headers: aliceHeaders }, env);
    const { items: convs } = (await convsRes.json()) as { items: Array<{ id: string; contactPhone: string }> };
    const metaConv = convs.find((c) => c.contactPhone === '923001112233')!;

    const replyOk = await app.request(
      `/api/v1/whatsapp/conversations/${metaConv.id}/send`,
      {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ whatsappAccountId: account.id, body: 'Happy to help, Ali!' })
      },
      env
    );
    assert.equal(replyOk.status, 201);
  });
});
