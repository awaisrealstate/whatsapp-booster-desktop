import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';
import {
  createDb,
  registerUserWithDefaultOrg,
  createSessionForUser,
  createOrganizationInvite,
  acceptOrganizationInvite
} from '@wacrm/db';
import {
  createSqliteD1TestDatabase,
  applyPhase1Migrations
} from '../../../packages/db/tests/helpers/sqlite-d1.ts';

async function createAssignmentTestContext() {
  const { sqlite, d1 } = createSqliteD1TestDatabase();
  applyPhase1Migrations(sqlite);
  const db = createDb(d1);

  // Alice is Owner of Org A
  const alice = await registerUserWithDefaultOrg(db, {
    email: 'alice@example.com',
    name: 'Alice Owner',
    password: 'Password123!'
  });

  // Charlie is a team member (agent) in Org A
  const charlie = await registerUserWithDefaultOrg(db, {
    email: 'charlie@example.com',
    name: 'Charlie Agent',
    password: 'Password123!'
  });
  const invite = await createOrganizationInvite(db, {
    userId: alice.userId,
    organizationId: alice.organizationId,
    role: 'owner',
    sessionId: 'sess'
  }, {
    email: 'charlie@example.com',
    role: 'agent'
  });
  await acceptOrganizationInvite(db, {
    rawToken: invite.rawToken,
    userId: charlie.userId,
    userEmail: 'charlie@example.com'
  });

  // Bob is Owner of Org B (for tenant isolation tests)
  const bob = await registerUserWithDefaultOrg(db, {
    email: 'bob@example.com',
    name: 'Bob Other',
    password: 'Password123!'
  });

  const aliceSession = await createSessionForUser(db, {
    userId: alice.userId,
    activeOrganizationId: alice.organizationId
  });
  const charlieSession = await createSessionForUser(db, {
    userId: charlie.userId,
    activeOrganizationId: alice.organizationId
  });
  const bobSession = await createSessionForUser(db, {
    userId: bob.userId,
    activeOrganizationId: bob.organizationId
  });

  const app = createApp({ logger: createLogger('error') });
  const env = { DB: d1, APP_ENV: 'development', PASSWORD_AUTH_ENABLED: 'true' };

  return {
    app,
    env,
    alice,
    charlie,
    bob,
    aliceToken: aliceSession.rawToken,
    charlieToken: charlieSession.rawToken,
    bobToken: bobSession.rawToken
  };
}

describe('Chat Assignment & AI Human Handover API', () => {
  it('manages conversation assignment, takeover, return-to-ai, history, metrics & tenant isolation', async () => {
    const { app, env, aliceToken, charlieToken, bobToken, charlie } = await createAssignmentTestContext();

    // 1. Create a contact and conversation in Org A
    const contactRes = await app.request(
      '/api/v1/crm/contacts',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phone: '923001234567', name: 'Zahid Client' })
      },
      env
    );
    assert.equal(contactRes.status, 201);
    const { contact } = await contactRes.json() as any;

    const convRes = await app.request(
      '/api/v1/crm/conversations',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ contactId: contact.id, channelType: 'manual_crm' })
      },
      env
    );
    assert.equal(convRes.status, 201);
    const { conversation: conv } = await convRes.json() as any;
    assert.ok(conv.id);

    // 2. Assign to AI Chatbot (Option C)
    const assignAiRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}/assign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ handlerType: 'ai', reason: 'Bot activated' })
      },
      env
    );
    assert.equal(assignAiRes.status, 200);
    const { conversation: aiConv } = await assignAiRes.json() as any;
    assert.equal(aiConv.assignmentType, 'ai');
    assert.equal(aiConv.handlingStatus, 'ai_handling');
    assert.equal(aiConv.handlerMode, 'ai_bot');

    // 3. Human Takeover from AI (Option A / Team Member)
    const takeoverRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}/takeover`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${charlieToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'Charlie taking over chat' })
      },
      env
    );
    assert.equal(takeoverRes.status, 200);
    const { conversation: takenConv } = await takeoverRes.json() as any;
    assert.equal(takenConv.assignmentType, 'team_member');
    assert.equal(takenConv.handlingStatus, 'human_handling');
    assert.equal(takenConv.handlerMode, 'human');
    assert.equal(takenConv.assignedUserId, charlie.userId);

    // 4. Assign to Business Owner (Option B)
    const assignOwnerRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}/assign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ handlerType: 'owner', reason: 'Owner taking responsibility' })
      },
      env
    );
    assert.equal(assignOwnerRes.status, 200);
    const { conversation: ownerConv } = await assignOwnerRes.json() as any;
    assert.equal(ownerConv.assignmentType, 'owner');
    assert.equal(ownerConv.handlingStatus, 'assigned_owner');

    // 5. Team Member CANNOT take over an owner-assigned conversation (403)
    const forbiddenTakeoverRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}/assign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${charlieToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ handlerType: 'team_member', targetUserId: charlie.userId })
      },
      env
    );
    assert.equal(forbiddenTakeoverRes.status, 403);

    // 6. Return to AI Chatbot
    const returnAiRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}/return-to-ai`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: 'Issue resolved, returning to AI' })
      },
      env
    );
    assert.equal(returnAiRes.status, 200);
    const { conversation: returnedConv } = await returnAiRes.json() as any;
    assert.equal(returnedConv.assignmentType, 'ai');
    assert.equal(returnedConv.handlingStatus, 'ai_handling');

    // 7. Check Assignment History
    const historyRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}/assignment-history`,
      {
        headers: { Authorization: `Bearer ${aliceToken}` }
      },
      env
    );
    assert.equal(historyRes.status, 200);
    const { history } = await historyRes.json() as any;
    assert.ok(history.length >= 4);

    // 8. Test Inbox Filters (filter=ai, filter=owner, filter=unassigned)
    const filterAiRes = await app.request(
      '/api/v1/crm/conversations?filter=ai',
      { headers: { Authorization: `Bearer ${aliceToken}` } },
      env
    );
    assert.equal(filterAiRes.status, 200);
    const { items: aiItems } = await filterAiRes.json() as any;
    assert.ok(aiItems.some((i: any) => i.id === conv.id));

    // 9. Metrics endpoint
    const metricsRes = await app.request(
      '/api/v1/crm/conversations-metrics',
      { headers: { Authorization: `Bearer ${aliceToken}` } },
      env
    );
    assert.equal(metricsRes.status, 200);
    const { metrics } = await metricsRes.json() as any;
    assert.equal(metrics.total, 1);
    assert.equal(metrics.aiHandled, 1);

    // 10. Tenant Isolation: Bob (Org B) cannot view or assign Org A conversation
    const bobGetRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}`,
      { headers: { Authorization: `Bearer ${bobToken}` } },
      env
    );
    assert.equal(bobGetRes.status, 404);

    const bobAssignRes = await app.request(
      `/api/v1/crm/conversations/${conv.id}/assign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ handlerType: 'owner' })
      },
      env
    );
    assert.equal(bobAssignRes.status, 404);
  });
});
