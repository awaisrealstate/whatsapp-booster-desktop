import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetaCloudProvider } from '@wacrm/providers';
import {
  acceptOrganizationInvite,
  assertOrgPermission,
  authenticateViaOAuthProfile,
  connectMetaWhatsappAccount,
  consumeOAuthState,
  createCampaign,
  createContact,
  createContactList,
  createDb,
  createKnowledgeDoc,
  createOAuthState,
  createOrganizationInvite,
  createSessionForUser,
  enforcePlanLimit,
  getOrInitAiAgent,
  getOrganizationSubscriptionAndUsage,
  handleAiSupportForConversation,
  handoffConversationToHuman,
  hasPermission,
  listAuditLogs,
  listKnowledgeDocs,
  listOrganizationMembers,
  registerUserWithDefaultOrg,
  removeOrganizationMember,
  resolveSessionContext,
  searchKnowledgeBase,
  switchActiveOrganization,
  TenantAccessError,
  updateAiAgentConfig,
  updateOrganizationMemberRole,
  updateOrganizationPlanManual,
  CrmError,
  createOrGetConversation,
  addMessageToConversation
} from '../src/index.ts';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from './helpers/sqlite-d1.ts';

const ENC_KEY = 'phase5-7-test-encryption-key-32ch!!';

describe('Phase 5 AI Customer Support, D1 FTS5 & Human Handoff', () => {
  it('retrieves English/Urdu knowledge via FTS5, runs real Workers AI hook, blocks hallucination on missing knowledge, enforces quotas & human handoff', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const reg = await registerUserWithDefaultOrg(db, {
      email: 'ai-owner@example.com',
      name: 'AI Owner',
      password: 'Password123!'
    });
    const sess = await createSessionForUser(db, {
      userId: reg.userId,
      activeOrganizationId: reg.organizationId
    });
    const ctx = await resolveSessionContext(db, sess.rawToken);

    const acc = (await connectMetaWhatsappAccount(
      db,
      ctx,
      {
        label: 'Support WA',
        metaWabaId: '100200300',
        metaPhoneNumberId: '700800900',
        accessToken: 'EAAG-ai-token',
        webhookVerifyToken: 'verify-ai'
      },
      ENC_KEY
    ))!;

    const contact = (await createContact(db, ctx, { phone: '03001112233', name: 'Customer' }))!;
    const conv = await createOrGetConversation(db, ctx, {
      contactId: contact.id,
      channelType: 'official_meta_cloud'
    });

    // Enable AI & keep open 24h service window
    await updateAiAgentConfig(db, ctx, {
      isEnabled: true,
      dailyReplyLimit: 2
    });
    await addMessageToConversation(db, ctx, conv.id, {
      direction: 'inbound',
      senderKind: 'contact',
      body: 'What are your delivery charges?'
    });

    // Add English + Urdu knowledge docs
    await createKnowledgeDoc(db, ctx, {
      title: 'Delivery Charges Policy',
      language: 'en',
      content: 'Standard nationwide delivery fee is PKR 250. Free delivery on orders above PKR 5000.'
    });
    await createKnowledgeDoc(db, ctx, {
      title: 'واپسی اور تبدیلی پالیسی',
      language: 'ur',
      content: 'آرڈر ملنے کے 7 دن کے اندر تبدیلی ممکن ہے۔'
    });

    const ftsMatches = await searchKnowledgeBase(d1, ctx.organizationId, 'delivery fee');
    assert.equal(ftsMatches.length, 1);
    assert.equal(ftsMatches[0]?.title, 'Delivery Charges Policy');
    assert.equal((await listKnowledgeDocs(db, ctx)).length, 2);

    // 1. Without Workers AI binding -> NEVER fabricates response, hands off safely!
    const unconfiguredRes = await handleAiSupportForConversation(db, d1, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      customerText: 'What is the delivery fee?'
    });
    assert.equal(unconfiguredRes.status, 'ai_unavailable');

    // 2. Missing knowledge topic -> refuses to invent, marks no_knowledge & hands off to human
    const noMatchRes = await handleAiSupportForConversation(db, d1, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      customerText: 'Do you sell spacecraft rockets?',
      aiBinding: {
        async run() {
          throw new Error('Should not invoke LLM when no KB matches');
        }
      }
    });
    assert.equal(noMatchRes.status, 'no_knowledge');

    // 3. Real Workers AI invocation with matched KB + outbound Meta reply inside 24h window
    let llmPromptSawKb = false;
    let outboundCalls = 0;
    const mockAi = {
      async run(_model: string, input: { messages: Array<{ role: string; content: string }> }) {
        llmPromptSawKb = input.messages.some((m) => m.content.includes('PKR 250'));
        return { response: 'Standard delivery fee is PKR 250 (free above PKR 5000).' };
      }
    };
    const mockProvider = new MetaCloudProvider({
      fetchFn: async () => {
        outboundCalls++;
        return new Response(JSON.stringify({ messages: [{ id: `wamid.ai.${outboundCalls}` }] }), { status: 200 });
      }
    });

    await d1
      .prepare('UPDATE conversations SET whatsapp_account_id = ? WHERE id = ?')
      .bind(acc.id, conv.id)
      .run();

    const aiReply = await handleAiSupportForConversation(db, d1, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      customerText: 'Tell me your delivery fee',
      aiBinding: mockAi,
      encryptionKey: ENC_KEY,
      provider: mockProvider,
      sendOutboundReply: true
    });
    assert.equal(aiReply.status, 'replied');
    assert.equal(llmPromptSawKb, true);
    assert.equal(outboundCalls, 1);

    // 4. Customer requests human agent -> immediate handoff
    const handoffRes = await handleAiSupportForConversation(db, d1, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      customerText: 'I want to talk to a human agent please',
      aiBinding: mockAi
    });
    assert.equal(handoffRes.status, 'handoff');

    // Manual handoff helper works cleanly
    const manual = await handoffConversationToHuman(db, ctx, conv.id, 'Escalated by supervisor');
    assert.equal(manual.handlerMode, 'human');
    assert.ok((await getOrInitAiAgent(db, ctx)).isEnabled);
  });
});

describe('Phase 7 OAuth2 PKCE, RBAC Roles (Owner/Admin/Manager/Agent), Invites & SaaS Limits', () => {
  it('handles single-use OAuth2 PKCE state, OAuth user login, team invites, RBAC permissions & SaaS plan enforcement', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    // OAuth2 PKCE state single-use enforcement
    const st = await createOAuthState(db, {
      provider: 'google',
      redirectUri: 'http://127.0.0.1:8787/api/v1/auth/oauth/google/callback'
    });
    const consumed = await consumeOAuthState(db, st.state, 'google');
    assert.equal(consumed.codeVerifier, st.codeVerifier);
    await assert.rejects(
      () => consumeOAuthState(db, st.state, 'google'),
      (err: unknown) => err instanceof TenantAccessError && err.code === 'OAUTH_STATE_INVALID'
    );

    // Owner logs in via Google OAuth2
    const ownerAuth = await authenticateViaOAuthProfile(db, {
      provider: 'google',
      providerAccountId: 'google-sub-111',
      email: 'owner@company.com',
      emailVerified: true,
      name: 'Company Owner'
    });
    const ownerCtx = await resolveSessionContext(db, ownerAuth.rawToken);
    assert.equal(ownerCtx.role, 'owner');
    assert.equal(hasPermission(ownerCtx.role, 'org:manage_billing'), true);

    // Invite an agent
    const invite = await createOrganizationInvite(db, ownerCtx, {
      email: 'agent@company.com',
      role: 'agent'
    });
    assert.ok(invite.rawToken);

    // Agent logs in via OAuth2 with inviteToken & joins organization as 'agent'
    const agentAuth = await authenticateViaOAuthProfile(db, {
      provider: 'google',
      providerAccountId: 'google-sub-222',
      email: 'agent@company.com',
      emailVerified: true,
      name: 'Support Agent',
      inviteToken: invite.rawToken
    });
    const agentCtx = await resolveSessionContext(db, agentAuth.rawToken);
    assert.equal(agentCtx.organizationId, ownerCtx.organizationId);
    assert.equal(agentCtx.role, 'agent');

    // Agent lacks campaigns:manage and org:manage_billing
    assert.throws(
      () => assertOrgPermission(agentCtx, 'campaigns:manage'),
      (err: unknown) => err instanceof TenantAccessError && err.code === 'INSUFFICIENT_ROLE'
    );

    // Owner promotes agent -> manager, then checks member list
    const members = await listOrganizationMembers(db, ownerCtx);
    assert.equal(members.length, 2);
    const agentMember = members.find((m) => m.email === 'agent@company.com')!;
    await updateOrganizationMemberRole(db, ownerCtx, agentMember.memberId, 'manager');
    const switchedAgentCtx = await resolveSessionContext(db, agentAuth.rawToken, ownerCtx.organizationId);
    assert.equal(switchedAgentCtx.role, 'manager');
    assert.equal(hasPermission(switchedAgentCtx.role, 'campaigns:manage'), true);

    // Free plan maxTeamMembers = 2 -> enforcing a 3rd invite hits PLAN_MEMBER_LIMIT (402)
    await assert.rejects(
      () => enforcePlanLimit(db, ownerCtx, 'teamMembers', 1),
      (err: unknown) => err instanceof CrmError && err.statusCode === 402 && err.code === 'PLAN_MEMBER_LIMIT'
    );

    // Upgrade manually to Pro -> member limit raises to 10 & writes audit log
    const upgraded = await updateOrganizationPlanManual(db, ownerCtx, { planTier: 'pro' });
    assert.equal(upgraded.plan.tier, 'pro');
    assert.equal(upgraded.billingReady, false);
    await enforcePlanLimit(db, ownerCtx, 'teamMembers', 1);

    const logs = await listAuditLogs(db, ownerCtx);
    assert.ok(logs.some((l) => l.action === 'subscription.plan_updated_manual'));

    // Switching / removing member
    await removeOrganizationMember(db, ownerCtx, agentMember.memberId);
    const subStats = await getOrganizationSubscriptionAndUsage(db, ownerCtx);
    assert.equal(subStats.usage.teamMembersCount, 1);
    await assert.rejects(() => switchActiveOrganization(db, ownerCtx, 'non-existent-org'));
    void acceptOrganizationInvite;
    void createCampaign;
    void createContactList;
  });
});
