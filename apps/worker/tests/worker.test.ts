import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetaCloudProvider } from '@wacrm/providers';
import {
  connectMetaWhatsappAccount,
  createCampaign,
  createContact,
  createContactList,
  createDb,
  createSessionForUser,
  createTemplate,
  getCampaignById,
  registerUserWithDefaultOrg,
  resolveSessionContext,
  addContactsToList,
  type CampaignQueueMessageBody
} from '@wacrm/db';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from '../../../packages/db/tests/helpers/sqlite-d1.ts';
import { createWorkerHandlers } from '../src/index.ts';

const ENC_KEY = 'worker-test-encryption-key-32chars!';

describe('Cloudflare Worker Cron (scheduled) & Queue Consumer', () => {
  it('promotes due scheduled campaigns via Cron, dispatches via Queue, and acks messages cleanly', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const alice = await registerUserWithDefaultOrg(db, {
      email: 'worker@example.com',
      name: 'Worker Owner',
      password: 'Password123!'
    });
    const sess = await createSessionForUser(db, {
      userId: alice.userId,
      activeOrganizationId: alice.organizationId
    });
    const ctx = await resolveSessionContext(db, sess.rawToken);

    const account = (await connectMetaWhatsappAccount(
      db,
      ctx,
      {
        label: 'Worker WA',
        metaWabaId: '100200300',
        metaPhoneNumberId: '400500600',
        accessToken: 'EAAG-worker-token',
        webhookVerifyToken: 'verify-worker'
      },
      ENC_KEY
    ))!;

    const tpl = await createTemplate(db, ctx, {
      whatsappAccountId: account.id,
      name: 'worker_notice',
      language: 'en_US',
      category: 'UTILITY',
      bodyText: 'Notice for {{1}}',
      approvalStatus: 'APPROVED'
    });

    const contact = (await createContact(db, ctx, { phone: '03005554433', name: 'WorkerLead' }))!;
    const list = await createContactList(db, ctx, { name: 'Worker Audience' });
    await addContactsToList(db, ctx, list.id, [contact.id]);

    const camp = (await createCampaign(db, ctx, {
      name: 'Cron Triggered Campaign',
      whatsappAccountId: account.id,
      listId: list.id,
      templateId: tpl.id,
      scheduleType: 'once',
      scheduledAt: Date.now() - 1000
    }))!;

    // Update campaign back to scheduled past-due so Cron promotes it
    await d1.prepare("UPDATE campaigns SET status = 'scheduled' WHERE id = ?").bind(camp.id).run();

    const sentQueuePayloads: CampaignQueueMessageBody[] = [];
    const mockQueue = {
      async sendBatch(msgs: Iterable<MessageSendRequest<CampaignQueueMessageBody>>) {
        for (const m of msgs) sentQueuePayloads.push(m.body);
      }
    } as unknown as Queue<CampaignQueueMessageBody>;

    let metaCalls = 0;
    const provider = new MetaCloudProvider({
      fetchFn: async () => {
        metaCalls++;
        return new Response(
          JSON.stringify({ messages: [{ id: `wamid.worker.${metaCalls}` }], contacts: [{ wa_id: '923005554433' }] }),
          { status: 200 }
        );
      }
    });

    const handlers = createWorkerHandlers({ provider });
    await handlers.scheduled(
      { cron: '*/2 * * * *', scheduledTime: Date.now(), noRetry() {} },
      { DB: d1, JOBS_QUEUE: mockQueue, ENCRYPTION_KEY: ENC_KEY }
    );

    assert.equal(sentQueuePayloads.length, 1);

    let acked = 0;
    let retried = 0;
    const batch = {
      queue: 'wacrm-jobs',
      messages: sentQueuePayloads.map((body, idx) => ({
        id: `qmsg-${idx}`,
        timestamp: new Date(),
        attempts: 1,
        body,
        ack() {
          acked++;
        },
        retry() {
          retried++;
        }
      })),
      ackAll() {},
      retryAll() {}
    } as unknown as MessageBatch<CampaignQueueMessageBody>;

    await handlers.queue(batch, { DB: d1, ENCRYPTION_KEY: ENC_KEY });

    assert.equal(acked, 1);
    assert.equal(retried, 0);
    assert.equal(metaCalls, 1);

    const updatedCamp = (await getCampaignById(db, ctx, camp.id))!;
    assert.equal(updatedCamp.status, 'completed');
    assert.equal(updatedCamp.sentCount, 1);

    const healthRes = await handlers.fetch(new Request('https://engine.local/health'), {
      DB: d1,
      JOBS_QUEUE: mockQueue,
      ENCRYPTION_KEY: ENC_KEY
    });
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {
      ok: boolean;
      service: string;
      bindings: { database: boolean; queue: boolean; encryptionConfigured: boolean };
    };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'wacrm-engine');
    assert.equal(healthJson.bindings.database, true);
    assert.equal(healthJson.bindings.queue, true);
    assert.equal(healthJson.bindings.encryptionConfigured, true);

    const notFoundRes = await handlers.fetch(new Request('https://engine.local/unknown'), {});
    assert.equal(notFoundRes.status, 404);
  });
});
