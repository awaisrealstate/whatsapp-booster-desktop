import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb,
  registerUserWithDefaultOrg,
  createOrganizationInvite,
  acceptOrganizationInvite,
  createContact,
  createOrGetConversation,
  addMessageToConversation,
  listConversationMessages,
  assignConversation,
  takeOverConversationFromAi,
  returnConversationToAi,
  listConversationAssignmentHistory,
  getConversationById,
  listFilteredConversations,
  getConversationMetricsForOrg,
  handleAiSupportForConversation,
  createKnowledgeDoc,
  updateAiAgentConfig,
  type OrgContext
} from '../src/index.ts';
import { applyPhase1Migrations, createSqliteD1TestDatabase } from './helpers/sqlite-d1.ts';

describe('Chat Assignment & AI Human Handover System', () => {
  it('enforces 3 assignment options (team member, owner, AI), takeover, return to AI, history, and tenant isolation', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    // 1. Setup Org A with Owner and Agent
    const ownerReg = await registerUserWithDefaultOrg(db, {
      email: 'owner@example.com',
      name: 'Owner Alice',
      password: 'Password123!'
    });
    const ownerCtx: OrgContext = {
      userId: ownerReg.userId,
      organizationId: ownerReg.organizationId,
      role: 'owner',
      sessionId: 'sess-owner'
    };

    const bobReg = await registerUserWithDefaultOrg(db, {
      email: 'bob@example.com',
      name: 'Agent Bob',
      password: 'Password123!'
    });
    const invite = await createOrganizationInvite(db, ownerCtx, {
      email: 'bob@example.com',
      role: 'agent'
    });
    await acceptOrganizationInvite(db, {
      rawToken: invite.rawToken,
      userId: bobReg.userId,
      userEmail: 'bob@example.com'
    });

    const agentCtx: OrgContext = {
      userId: bobReg.userId,
      organizationId: ownerReg.organizationId,
      role: 'agent',
      sessionId: 'sess-agent'
    };

    // Org B for tenant isolation tests
    const orgBReg = await registerUserWithDefaultOrg(db, {
      email: 'owner-b@example.com',
      name: 'Owner Bob',
      password: 'Password123!'
    });
    const orgBCtx: OrgContext = {
      userId: orgBReg.userId,
      organizationId: orgBReg.organizationId,
      role: 'owner',
      sessionId: 'sess-org-b'
    };

    // Create a contact and conversation in Org A
    const contact = (await createContact(db, ownerCtx, {
      phone: '03001234567',
      name: 'Client Zahid'
    }))!;
    const conv = await createOrGetConversation(db, ownerCtx, {
      contactId: contact.id,
      channelType: 'official_meta_cloud'
    });
    assert.ok(conv);

    // Initial state: unassigned
    const initial = await getConversationById(db, ownerCtx, conv.id);
    assert.equal(initial?.assignmentType, 'unassigned');

    // 2. Option C: Assign to AI Chatbot
    const assignedAi = await assignConversation(db, ownerCtx, {
      conversationId: conv.id,
      handlerType: 'ai',
      reason: 'AI auto-responder activated'
    });
    assert.equal(assignedAi?.assignmentType, 'ai');
    assert.equal(assignedAi?.handlingStatus, 'ai_handling');
    assert.equal(assignedAi?.handlerMode, 'ai_bot');
    assert.equal(assignedAi?.assignedUserId, null);

    // Setup AI agent & Knowledge doc
    await updateAiAgentConfig(db, ownerCtx, { isEnabled: true });
    await createKnowledgeDoc(db, ownerCtx, {
      title: 'Pricing FAQ',
      content: 'Pro plan costs $29 per month.',
      language: 'en'
    });

    // Simulated Workers AI mock
    const mockAiBinding = {
      async run() {
        return { response: 'Pro plan costs $29 per month.' };
      }
    };

    // Verify AI replies when AI handling is enabled
    const aiReplyResult = await handleAiSupportForConversation(db, d1, {
      organizationId: ownerCtx.organizationId,
      conversationId: conv.id,
      customerText: 'How much is Pro plan?',
      aiBinding: mockAiBinding
    });
    assert.equal(aiReplyResult.status, 'replied');

    // 3. Human Takeover: Option A / Agent or Owner takes over from AI
    const takenOver = await takeOverConversationFromAi(db, agentCtx, {
      conversationId: conv.id,
      reason: 'Agent Bob stepping in to help'
    });
    assert.equal(takenOver?.assignmentType, 'team_member');
    assert.equal(takenOver?.handlingStatus, 'human_handling');
    assert.equal(takenOver?.handlerMode, 'human');
    assert.equal(takenOver?.assignedUserId, agentCtx.userId);

    // 4. Verify AI DOES NOT reply when human handling is active (Rule #2)
    const blockedAiResult = await handleAiSupportForConversation(db, d1, {
      organizationId: ownerCtx.organizationId,
      conversationId: conv.id,
      customerText: 'Are there discounts?',
      aiBinding: mockAiBinding
    });
    assert.equal(blockedAiResult.status, 'blocked');
    assert.ok(blockedAiResult.reason.includes('handled by a human operator'));

    // Add a message from human
    await addMessageToConversation(db, agentCtx, conv.id, {
      direction: 'outbound',
      senderKind: 'agent',
      body: 'Hello Zahid, Bob here from support.'
    });

    // Verify previous messages remain visible
    const msgs = await listConversationMessages(db, ownerCtx, conv.id);
    assert.ok(msgs.length >= 2); // AI reply + human reply

    // 5. Option B: Assign to Business Owner
    const assignedOwner = await assignConversation(db, ownerCtx, {
      conversationId: conv.id,
      handlerType: 'owner',
      reason: 'Escalated to business owner for VIP deal'
    });
    assert.equal(assignedOwner?.assignmentType, 'owner');
    assert.equal(assignedOwner?.handlingStatus, 'assigned_owner');
    assert.equal(assignedOwner?.handlerMode, 'human');
    assert.equal(assignedOwner?.assignedUserId, ownerCtx.userId);

    // 6. Permission check: Regular team member CANNOT take over an owner-assigned conversation
    await assert.rejects(
      async () => {
        await assignConversation(db, agentCtx, {
          conversationId: conv.id,
          handlerType: 'team_member',
          targetUserId: agentCtx.userId,
          reason: 'Bob trying to take over owner conversation'
        });
      },
      (err: any) => err.statusCode === 403 && err.code === 'PERMISSION_DENIED'
    );

    // Owner CAN reassign it or return to AI
    const returnedToAi = await returnConversationToAi(db, ownerCtx, {
      conversationId: conv.id,
      reason: 'VIP inquiry completed, returning to bot'
    });
    assert.equal(returnedToAi?.assignmentType, 'ai');
    assert.equal(returnedToAi?.handlingStatus, 'ai_handling');
    assert.equal(returnedToAi?.handlerMode, 'ai_bot');

    // 7. Verify Assignment History was tracked for all transitions
    const history = await listConversationAssignmentHistory(db, ownerCtx, conv.id);
    assert.ok(history.length >= 4);
    assert.equal(history[0]?.newHandlerType, 'ai'); // Most recent first
    assert.ok(history[0]?.reason?.includes('returning to bot'));

    // 8. Inbox Filters: test filtering by 'ai', 'owner', 'human', etc.
    const aiFiltered = await listFilteredConversations(db, ownerCtx, { filter: 'ai' });
    assert.ok(aiFiltered.some((c) => c.id === conv.id));

    const humanFiltered = await listFilteredConversations(db, ownerCtx, { filter: 'human' });
    assert.ok(!humanFiltered.some((c) => c.id === conv.id)); // conv is now AI

    // Metrics check
    const metrics = await getConversationMetricsForOrg(db, ownerCtx);
    assert.equal(metrics.total, 1);
    assert.equal(metrics.aiHandled, 1);

    // 9. Tenant Isolation: Org B cannot see or manipulate Org A's conversation
    const orgBView = await getConversationById(db, orgBCtx, conv.id);
    assert.equal(orgBView, null);

    await assert.rejects(
      async () => {
        await assignConversation(db, orgBCtx, {
          conversationId: conv.id,
          handlerType: 'owner'
        });
      },
      (err: any) => err.statusCode === 404 && err.code === 'CONVERSATION_NOT_FOUND'
    );
  });
});
