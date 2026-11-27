import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetaCloudProvider } from '@wacrm/providers';
import {
  createDb,
  registerUserWithDefaultOrg,
  createSessionForUser,
  resolveSessionContext,
  encryptSecretAesGcm,
  decryptSecretAesGcm,
  connectMetaWhatsappAccount,
  getWhatsappAccountForOrg,
  getDecryptedMetaCredentials,
  createTemplate,
  createContact,
  createContactList,
  addContactsToList,
  recordStopOptOut,
  createCampaign,
  transitionCampaignStatus,
  getCampaignById,
  getCampaignReport,
  runScheduledCampaignTick,
  processCampaignRecipientBatch,
  recordAndProcessMetaWebhookEvents,
  checkCampaignEligibility,
  CrmError
} from '../src/index.ts';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from './helpers/sqlite-d1.ts';

const TEST_ENC_KEY = 'phase3-test-encryption-key-32-chars!!';

async function setupEnv() {
  const { sqlite, d1 } = createSqliteD1TestDatabase();
  applyPhase1Migrations(sqlite);
  const db = createDb(d1);

  const alice = await registerUserWithDefaultOrg(db, {
    email: 'alice@example.com',
    name: 'Alice',
    password: 'Password123!'
  });
  const aliceSession = await createSessionForUser(db, {
    userId: alice.userId,
    activeOrganizationId: alice.organizationId
  });
  const ctx = await resolveSessionContext(db, aliceSession.rawToken);

  return { sqlite, db, ctx };
}

describe('Phase 3 AES-256-GCM Secret Storage & Meta Account Management', () => {
  it('encrypts/decrypts Meta tokens via AES-256-GCM and never returns secrets in public queries', async () => {
    const enc = await encryptSecretAesGcm('EAAG-super-secret-token', TEST_ENC_KEY);
    assert.ok(enc.startsWith('enc:v1:'));
    assert.ok(!enc.includes('EAAG-super-secret-token'));
    assert.equal(await decryptSecretAesGcm(enc, TEST_ENC_KEY), 'EAAG-super-secret-token');
    await assert.rejects(() => decryptSecretAesGcm(enc, 'wrong-encryption-key-123456'));

    const { db, ctx } = await setupEnv();
    const account = await connectMetaWhatsappAccount(
      db,
      ctx,
      {
        label: 'Primary Business WA',
        phoneNumber: '03001234567',
        metaWabaId: '98765432100',
        metaPhoneNumberId: '112233445566',
        accessToken: 'EAAG-live-meta-token',
        appSecret: 'meta-app-secret-123',
        webhookVerifyToken: 'verify-me-2026'
      },
      TEST_ENC_KEY
    );

    assert.ok(account);
    assert.equal(account.hasAccessToken, true);
    assert.equal(account.hasAppSecret, true);
    assert.equal(account.hasVerifyToken, true);
    assert.equal(JSON.stringify(account).includes('EAAG-live-meta-token'), false);
    assert.equal(JSON.stringify(account).includes('meta-app-secret-123'), false);

    const creds = await getDecryptedMetaCredentials(db, ctx, account.id, TEST_ENC_KEY);
    assert.equal(creds.accessToken, 'EAAG-live-meta-token');
    assert.equal(creds.appSecret, 'meta-app-secret-123');
  });

  it('rejects storing Meta credentials when ENCRYPTION_KEY is missing or too short', async () => {
    const { db, ctx } = await setupEnv();
    await assert.rejects(
      () =>
        connectMetaWhatsappAccount(
          db,
          ctx,
          {
            label: 'Bad Key Test',
            metaWabaId: '98765432100',
            metaPhoneNumberId: '112233445566',
            accessToken: 'token',
            webhookVerifyToken: 'verify'
          },
          'short'
        ),
      (err: unknown) => err instanceof CrmError && err.code === 'ENCRYPTION_KEY_UNCONFIGURED'
    );
  });
});

describe('Phase 3 Durable Cloud Campaigns, Idempotency, STOP Suppression & Queue Retries', () => {
  it('enforces scheduled campaigns, STOP skipping, daily limit, idempotency, retries & Queue quota fallback', async () => {
    const { db, ctx } = await setupEnv();
    const account = (await connectMetaWhatsappAccount(
      db,
      ctx,
      {
        label: 'Cloud WA',
        metaWabaId: '555666777888',
        metaPhoneNumberId: '999888777666',
        accessToken: 'EAAG-token',
        appSecret: 'app-secret',
        webhookVerifyToken: 'verify-tok'
      },
      TEST_ENC_KEY
    ))!;

    const tpl = await createTemplate(db, ctx, {
      whatsappAccountId: account.id,
      name: 'welcome_offer',
      language: 'en_US',
      category: 'UTILITY',
      bodyText: 'Hello {{1}}, welcome to {{2}}!',
      approvalStatus: 'APPROVED'
    });

    const c1 = (await createContact(db, ctx, { phone: '03001112233', name: 'Ali' }))!;
    const c2 = (await createContact(db, ctx, { phone: '03214445566', name: 'Sara' }))!;
    const c3 = (await createContact(db, ctx, { phone: '03337778899', name: 'OptedOut' }))!;

    await recordStopOptOut(db, ctx, { phone: '03337778899', reason: 'stop_keyword' });

    const list = await createContactList(db, ctx, { name: 'Promo Audience' });
    await addContactsToList(db, ctx, list.id, [c1.id, c2.id, c3.id]);

    const futureAt = Date.now() + 60_000;
    const camp = (await createCampaign(db, ctx, {
      name: 'Scheduled Launch',
      whatsappAccountId: account.id,
      listId: list.id,
      templateId: tpl.id,
      scheduleType: 'once',
      scheduledAt: futureAt,
      dailyLimit: 2
    }))!;

    assert.equal(camp.status, 'scheduled');
    assert.equal(camp.totalRecipients, 3);
    assert.equal(camp.skippedCount, 1);

    let sendAttempts = 0;
    let saraRateLimitedOnce = false;
    const mockProvider = new MetaCloudProvider({
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { to?: string };
        sendAttempts++;
        // First send to Sara simulates temporary 429 rate limit regardless of row order, succeeds on retry
        if (body.to === '923214445566' && !saraRateLimitedOnce) {
          saraRateLimitedOnce = true;
          return new Response(JSON.stringify({ error: { code: 130429, message: 'Rate limited' } }), { status: 429 });
        }
        return new Response(
          JSON.stringify({ messages: [{ id: `wamid.sent.${sendAttempts}` }], contacts: [{ wa_id: body.to }] }),
          { status: 200 }
        );
      }
    });

    // Before scheduledAt: Cron leaves future campaign in D1
    const earlyTick = await runScheduledCampaignTick(db, {
      now: futureAt - 10_000,
      encryptionKey: TEST_ENC_KEY,
      provider: mockProvider
    });
    assert.equal(earlyTick.promotedCount, 0);

    // At scheduledAt with failing Queue (quota exhausted): falls back safely without losing jobs!
    const enqueuedMessages: Array<{ organizationId: string; campaignId: string; recipientIds: string[] }> = [];
    const quotaExhaustedQueue = {
      async sendBatch() {
        throw new Error('Queue daily operation quota exceeded');
      }
    };
    const fallbackTick = await runScheduledCampaignTick(db, {
      now: futureAt + 1000,
      jobsQueue: quotaExhaustedQueue,
      encryptionKey: TEST_ENC_KEY,
      provider: mockProvider,
      inlineFallbackLimit: 0
    });
    assert.equal(fallbackTick.promotedCount, 1);
    assert.equal(fallbackTick.queueQuotaFallback, true);
    assert.equal((await getCampaignById(db, ctx, camp.id))?.status, 'running');

    // Healthy Queue enqueues batch & worker processes it (Ali sends, Sara gets retryable 429)
    const healthyQueue = {
      async sendBatch(msgs: Array<{ body: { organizationId: string; campaignId: string; recipientIds: string[] } }>) {
        for (const m of msgs) enqueuedMessages.push(m.body);
      }
    };
    const queuedTick = await runScheduledCampaignTick(db, {
      now: futureAt + 1500,
      jobsQueue: healthyQueue,
      encryptionKey: TEST_ENC_KEY
    });
    assert.equal(queuedTick.queuedRecipients, 2);

    const firstPass = await processCampaignRecipientBatch(db, {
      message: enqueuedMessages[0]!,
      encryptionKey: TEST_ENC_KEY,
      provider: mockProvider,
      now: futureAt + 2000
    });
    assert.equal(firstPass.sent, 1);
    assert.equal(firstPass.retried, 1);
    assert.equal(firstPass.hasRetryableErrors, true);

    // Replaying the SAME Queue message after backoff retries ONLY Sara (idempotency prevents duplicate send to Ali!)
    const retryPass = await processCampaignRecipientBatch(db, {
      message: enqueuedMessages[0]!,
      encryptionKey: TEST_ENC_KEY,
      provider: mockProvider,
      now: futureAt + 15_000
    });
    assert.equal(retryPass.sent, 1);
    assert.equal(retryPass.retried, 0);

    const finalCamp = (await getCampaignById(db, ctx, camp.id))!;
    assert.equal(finalCamp.status, 'completed');
    assert.equal(finalCamp.sentCount, 2);
    assert.equal(finalCamp.skippedCount, 1);
    assert.equal(sendAttempts, 3); // 1 Ali + 2 Sara (retry) = 3 total API calls, never duplicate Ali or OptedOut!

    // Webhook status callback updates campaign delivered_count & inbound STOP auto-suppresses
    const reportBefore = await getCampaignReport(db, ctx, camp.id);
    const aliWamid = reportBefore.recipients.find((r) => r.phone === '923001112233')?.providerMessageId;
    assert.ok(aliWamid);

    const events = mockProvider.parseWebhookPayload({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '999888777666' },
                contacts: [{ wa_id: '923001112233', profile: { name: 'Ali' } }],
                messages: [
                  {
                    id: 'wamid.in.stop1',
                    from: '923001112233',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'STOP' }
                  }
                ],
                statuses: [
                  {
                    id: aliWamid,
                    status: 'delivered',
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

    const whResult = await recordAndProcessMetaWebhookEvents(db, {
      organizationId: ctx.organizationId,
      whatsappAccountId: account.id,
      rawPayload: '{}',
      events
    });
    assert.equal(whResult.stopOptOutsRecorded, 1);
    assert.equal(whResult.statusUpdatesApplied, 1);

    // Duplicate webhook event delivery is idempotently skipped
    const whDup = await recordAndProcessMetaWebhookEvents(db, {
      organizationId: ctx.organizationId,
      whatsappAccountId: account.id,
      rawPayload: '{}',
      events
    });
    assert.equal(whDup.duplicateEventsSkipped, 2);

    const updatedReport = await getCampaignReport(db, ctx, camp.id);
    assert.equal(updatedReport.campaign.deliveredCount, 1);
    assert.equal((await checkCampaignEligibility(db, ctx, '03001112233')).eligible, false);
  });

  it('supports pause and resume campaign transitions cleanly', async () => {
    const { db, ctx } = await setupEnv();
    const account = (await connectMetaWhatsappAccount(
      db,
      ctx,
      {
        label: 'WA Pause Test',
        metaWabaId: '123456',
        metaPhoneNumberId: '654321',
        accessToken: 'EAAG-tok',
        webhookVerifyToken: 'verify'
      },
      TEST_ENC_KEY
    ))!;
    const list = await createContactList(db, ctx, { name: 'List' });
    const contact = (await createContact(db, ctx, { phone: '03001112244', name: 'PauseLead' }))!;
    await addContactsToList(db, ctx, list.id, [contact.id]);

    const camp = (await createCampaign(db, ctx, {
      name: 'Pausable Campaign',
      whatsappAccountId: account.id,
      listId: list.id,
      messageOverride: 'Hello!'
    }))!;

    const launched = (await transitionCampaignStatus(db, ctx, camp.id, 'launch'))!;
    assert.equal(launched.status, 'running');
    const paused = (await transitionCampaignStatus(db, ctx, camp.id, 'pause'))!;
    assert.equal(paused.status, 'paused');
    const resumed = (await transitionCampaignStatus(db, ctx, camp.id, 'resume'))!;
    assert.equal(resumed.status, 'running');
  });
});
