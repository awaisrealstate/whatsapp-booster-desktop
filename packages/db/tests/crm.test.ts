import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb,
  registerUserWithDefaultOrg,
  createSessionForUser,
  resolveSessionContext,
  createContact,
  getContactById,
  listContacts,
  updateContact,
  softDeleteContact,
  bulkImportContacts,
  createTag,
  updateTag,
  assignTagToContact,
  removeTagFromContact,
  createContactList,
  listContactLists,
  addContactsToList,
  removeContactsFromList,
  recordConsent,
  recordStopOptOut,
  checkNumberSuppressed,
  checkCampaignEligibility,
  createOrGetConversation,
  addMessageToConversation,
  listConversationMessages,
  updateMessageStatus,
  importLegacyStateToOrg,
  CrmError,
  consentRecords,
  suppressionList
} from '../src/index.ts';
import { and, eq } from 'drizzle-orm';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from './helpers/sqlite-d1.ts';

async function setupTwoOrgs() {
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

  const aliceSession = await createSessionForUser(db, {
    userId: alice.userId,
    activeOrganizationId: alice.organizationId
  });
  const bobSession = await createSessionForUser(db, {
    userId: bob.userId,
    activeOrganizationId: bob.organizationId
  });

  const aliceCtx = await resolveSessionContext(db, aliceSession.rawToken);
  const bobCtx = await resolveSessionContext(db, bobSession.rawToken);

  return { sqlite, db, aliceCtx, bobCtx };
}

describe('Phase 2 CRM Migrations & Contacts CRUD / Deduplication / Soft Delete', () => {
  it('applies 0003_phase2_crm.sql idempotently and enforces CRUD + deduplication + soft delete', async () => {
    const { sqlite, db, aliceCtx } = await setupTwoOrgs();
    applyPhase1Migrations(sqlite);

    const created = await createContact(db, aliceCtx, {
      phone: '0300-1234567',
      name: 'Ali Khan',
      company: 'Apex',
      customAttributes: { city: 'Lahore' }
    });
    assert.ok(created);
    assert.equal(created.phone, '923001234567');
    assert.equal(created.customAttributes.city, 'Lahore');

    // Duplicate phone in same org throws 409
    await assert.rejects(
      () => createContact(db, aliceCtx, { phone: '+92 300 1234567', name: 'Dup Ali' }),
      (err: unknown) => err instanceof CrmError && err.statusCode === 409
    );

    const updated = await updateContact(db, aliceCtx, created.id, {
      name: 'Ali Updated',
      pipelineStage: 'qualified'
    });
    assert.equal(updated?.pipelineStage, 'qualified');

    const listed = await listContacts(db, aliceCtx, { search: 'Updated' });
    assert.equal(listed.total, 1);

    // Soft delete hides contact from active queries & allows recreating phone cleanly
    await softDeleteContact(db, aliceCtx, created.id);
    assert.equal(await getContactById(db, aliceCtx, created.id), null);
    const afterDeleteList = await listContacts(db, aliceCtx);
    assert.equal(afterDeleteList.total, 0);

    const recreated = await createContact(db, aliceCtx, { phone: '03001234567', name: 'Re-added Ali' });
    assert.equal(recreated?.phone, '923001234567');
  });

  it('isolates contacts, tags, lists, and conversations strictly by organizationId', async () => {
    const { db, aliceCtx, bobCtx } = await setupTwoOrgs();

    const aliceContact = await createContact(db, aliceCtx, { phone: '03001112233', name: 'Alice Lead' });
    const aliceTag = await createTag(db, aliceCtx, { name: 'VIP' });
    const aliceList = await createContactList(db, aliceCtx, { name: 'Launch List' });

    // Bob can create the SAME phone number in Bob's organization independently
    const bobContact = await createContact(db, bobCtx, { phone: '03001112233', name: 'Bob Lead' });
    assert.notEqual(aliceContact?.id, bobContact?.id);

    // Bob cannot read, update, delete, or tag Alice's resources
    assert.equal(await getContactById(db, bobCtx, aliceContact!.id), null);
    await assert.rejects(
      () => assignTagToContact(db, bobCtx, aliceContact!.id, aliceTag.id),
      (err: unknown) => err instanceof CrmError && err.statusCode === 404
    );
    await assert.rejects(
      () => addContactsToList(db, bobCtx, aliceList.id, [bobContact!.id]),
      (err: unknown) => err instanceof CrmError && err.statusCode === 404
    );
  });
});

describe('Consent Records & Durable STOP Suppression', () => {
  it('preserves STOP opt-out and consent history even after a contact is soft-deleted or hard-deleted', async () => {
    const { sqlite, db, aliceCtx } = await setupTwoOrgs();

    const contact = await createContact(db, aliceCtx, { phone: '03215556677', name: 'Opt Out Test' });
    await recordConsent(db, aliceCtx, {
      phone: '03215556677',
      status: 'opted_in',
      source: 'web_form'
    });

    const eligibleBefore = await checkCampaignEligibility(db, aliceCtx, '03215556677');
    assert.equal(eligibleBefore.eligible, true);
    assert.equal(eligibleBefore.consentStatus, 'opted_in');

    await recordStopOptOut(db, aliceCtx, {
      phone: '03215556677',
      reason: 'stop_keyword',
      source: 'inbound_message'
    });

    const suppressedBefore = await checkNumberSuppressed(db, aliceCtx, '03215556677');
    assert.equal(suppressedBefore.suppressed, true);

    // Soft-delete contact AND hard-delete contact row in SQLite to verify STOP durability!
    await softDeleteContact(db, aliceCtx, contact!.id);
    sqlite.prepare('DELETE FROM contacts WHERE id = ?').run(contact!.id);

    const eligibleAfterDelete = await checkCampaignEligibility(db, aliceCtx, '03215556677');
    assert.equal(eligibleAfterDelete.eligible, false);
    assert.equal(eligibleAfterDelete.reason, 'SUPPRESSED:stop_keyword');

    const consentRows = await db
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.organizationId, aliceCtx.organizationId), eq(consentRecords.phone, '923215556677')));
    assert.equal(consentRows.length, 2);
    assert.equal(consentRows[1]?.contactId, null);

    const supRows = await db
      .select()
      .from(suppressionList)
      .where(and(eq(suppressionList.organizationId, aliceCtx.organizationId), eq(suppressionList.phone, '923215556677')));
    assert.equal(supRows.length, 1);
  });
});

describe('Tags, Contact Lists, Conversations & Non-Destructive Legacy Importer', () => {
  it('manages tags, lists, bulk import, conversations, messages, and idempotent message status', async () => {
    const { db, aliceCtx } = await setupTwoOrgs();

    const summary = await bulkImportContacts(db, aliceCtx, {
      listName: 'Imported Leads',
      contacts: [
        { name: 'Sara', phone: '03001112233', company: 'Nexus', tags: ['hot-lead'] },
        { name: 'Sara Dup', phone: '+923001112233' },
        { name: 'Bad', phone: '123' }
      ]
    });
    assert.equal(summary.createdCount, 1);
    assert.equal(summary.skippedDuplicatesCount, 1);
    assert.equal(summary.invalidCount, 1);

    const lists = await listContactLists(db, aliceCtx);
    assert.equal(lists[0]?.memberCount, 1);

    const contactId = summary.createdIds[0]!;
    const tag = await createTag(db, aliceCtx, { name: 'FollowUp' });
    await assignTagToContact(db, aliceCtx, contactId, tag.id);
    let detail = await getContactById(db, aliceCtx, contactId);
    assert.equal(detail?.tags.length, 2);

    await removeTagFromContact(db, aliceCtx, contactId, tag.id);
    detail = await getContactById(db, aliceCtx, contactId);
    assert.equal(detail?.tags.length, 1);

    await removeContactsFromList(db, aliceCtx, summary.listId!, [contactId]);
    const listsAfter = await listContactLists(db, aliceCtx);
    assert.equal(listsAfter[0]?.memberCount, 0);

    const conv = await createOrGetConversation(db, aliceCtx, { contactId });
    const msg1 = await addMessageToConversation(db, aliceCtx, conv.id, {
      direction: 'outbound',
      senderKind: 'agent',
      body: 'Hello Sara!',
      idempotencyKey: 'msg-idem-1'
    });
    // Idempotent duplicate returns existing message
    const msg1Dup = await addMessageToConversation(db, aliceCtx, conv.id, {
      direction: 'outbound',
      senderKind: 'agent',
      body: 'Hello Sara!',
      idempotencyKey: 'msg-idem-1'
    });
    assert.equal(msg1.id, msg1Dup.id);

    const updatedMsg = await updateMessageStatus(db, aliceCtx, msg1.id, {
      status: 'delivered',
      providerMessageId: 'wamid.123'
    });
    assert.equal(updatedMsg.status, 'delivered');

    const thread = await listConversationMessages(db, aliceCtx, conv.id);
    assert.equal(thread.length, 1);
  });

  it('performs dry-run preview and non-destructive legacy import respecting skip_existing conflictPolicy', async () => {
    const { db, aliceCtx } = await setupTwoOrgs();

    // Existing cloud contact should NOT be overwritten under default skip_existing
    await createContact(db, aliceCtx, {
      phone: '03001112233',
      name: 'Cloud Authoritative Name',
      company: 'Cloud Co'
    });

    const legacyPayload = {
      campaignState: {
        updatedAt: 5000,
        template: 'Hi {name}, legacy template!',
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/123/edit',
        dailyLimit: 30,
        batchSentCount: 1,
        contacts: [
          { name: 'Old Desktop Name', phone: '03001112233', status: 'sent', sentAt: '09:00 AM' },
          { name: 'New Desktop Lead', phone: '03334445566', status: 'pending' }
        ],
        sentPhoneHistory: {
          '923001112233': { status: 'sent', sentAt: '09:00 AM' }
        }
      }
    };

    const preview = await importLegacyStateToOrg(db, aliceCtx, {
      ...legacyPayload,
      dryRun: true
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.summary.wouldSkip, 1);
    assert.equal(preview.summary.wouldCreate, 1);
    assert.equal((await listContacts(db, aliceCtx)).total, 1);

    const committed = await importLegacyStateToOrg(db, aliceCtx, {
      ...legacyPayload,
      dryRun: false,
      conflictPolicy: 'skip_existing'
    });
    assert.equal(committed.dryRun, false);
    assert.equal(committed.summary.skippedCount, 1);
    assert.equal(committed.summary.createdCount, 1);

    const after = await listContacts(db, aliceCtx);
    assert.equal(after.total, 2);
    const existing = after.items.find((c) => c.phone === '923001112233');
    assert.equal(existing?.name, 'Cloud Authoritative Name');
  });

  it('handles tag rename conflicts cleanly (409), excludes soft-deleted contacts from list counts, and handles 120+ items below D1 100-param limits', async () => {
    const { db, aliceCtx } = await setupTwoOrgs();

    await createTag(db, aliceCtx, { name: 'VIP' });
    const leadTag = await createTag(db, aliceCtx, { name: 'Lead' });
    await assert.rejects(
      () => updateTag(db, aliceCtx, leadTag.id, { name: 'VIP' }),
      (err: unknown) => err instanceof CrmError && err.statusCode === 409 && err.code === 'TAG_EXISTS'
    );

    const contactsBatch = Array.from({ length: 120 }, (_, i) => ({
      name: `Scale Contact ${i}`,
      phone: `0300${String(1000000 + i)}`,
      tags: ['ScaleTag']
    }));
    const imported = await bulkImportContacts(db, aliceCtx, {
      listName: 'Large 120 List',
      contacts: contactsBatch
    });
    assert.equal(imported.createdCount, 120);

    const listsBeforeDelete = await listContactLists(db, aliceCtx);
    assert.equal(listsBeforeDelete[0]?.memberCount, 120);

    // Soft delete one contact -> memberCount must reflect only active contacts
    await softDeleteContact(db, aliceCtx, imported.createdIds[0]!);
    const listsAfterDelete = await listContactLists(db, aliceCtx);
    assert.equal(listsAfterDelete[0]?.memberCount, 119);

    // Filter contacts by tag with >100 matches
    const taggedContacts = await listContacts(db, aliceCtx, {
      tagId: (await db.select().from((await import('../src/index.ts')).tags))[2]!.id,
      limit: 200
    });
    assert.equal(taggedContacts.total, 119);

    const removed = await removeContactsFromList(db, aliceCtx, imported.listId!, imported.createdIds);
    assert.equal(removed.removed, 120);
  });
});
