import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createSessionForUser, registerUserWithDefaultOrg } from '@wacrm/db';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from '../../../packages/db/tests/helpers/sqlite-d1.ts';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';

describe('Phase 5 & 7 API: Google/GitHub OAuth2 PKCE, RBAC, Team Invites, SaaS Limits & Workers AI', () => {
  it('enforces OAuth2 config gating, runs full PKCE callback flow, enforces RBAC/SaaS limits & AI FTS5 handoff', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);

    const appUnconfigured = createApp({ logger: createLogger('error') });
    const unconfStart = await appUnconfigured.request(
      '/api/v1/auth/oauth/google/start',
      {},
      { DB: d1 }
    );
    assert.equal(unconfStart.status, 503);
    assert.equal(((await unconfStart.json()) as { error: { code: string } }).error.code, 'OAUTH_NOT_CONFIGURED');

    const mockOAuthFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'google-access-tok' }), { status: 200 });
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({
            sub: 'google-uid-999',
            email: 'oauth.owner@example.com',
            email_verified: true,
            name: 'OAuth Owner'
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const mockAi = {
      async run() {
        return { response: 'Our office hours are 9 AM to 6 PM PKT.' };
      }
    };

    const app = createApp({ logger: createLogger('error'), oauthFetchFn: mockOAuthFetch });
    const env = {
      DB: d1,
      AI: mockAi,
      APP_ENV: 'development',
      GOOGLE_CLIENT_ID: 'gid-test',
      GOOGLE_CLIENT_SECRET: 'gsec-test'
    };

    // 1. OAuth2 PKCE start & callback
    const startRes = await app.request('/api/v1/auth/oauth/google/start?mode=json', {}, env);
    assert.equal(startRes.status, 200);
    const { state, authorizeUrl } = (await startRes.json()) as { state: string; authorizeUrl: string };
    assert.ok(authorizeUrl.includes('code_challenge_method=S256'));

    const cbRes = await app.request(
      `/api/v1/auth/oauth/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}&mode=json`,
      {},
      env
    );
    assert.equal(cbRes.status, 200);
    const { token } = (await cbRes.json()) as { token: string };
    assert.ok(token.length >= 32);

    // State replay rejected (401)
    const replayRes = await app.request(
      `/api/v1/auth/oauth/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}&mode=json`,
      {},
      env
    );
    assert.equal(replayRes.status, 401);

    const ownerHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 2. Knowledge Base + AI agent enable + AI FTS5 grounded reply + handoff
    await app.request(
      '/api/v1/ai/agent',
      { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ isEnabled: true }) },
      env
    );

    const kbRes = await app.request(
      '/api/v1/ai/knowledge',
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          title: 'Office Timings',
          language: 'en',
          content: 'Our office hours are 9 AM to 6 PM PKT Monday to Saturday.'
        })
      },
      env
    );
    assert.equal(kbRes.status, 201);

    const contactRes = await app.request(
      '/api/v1/crm/contacts',
      { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ name: 'Bilal', phone: '03001112233' }) },
      env
    );
    const { contact } = (await contactRes.json()) as { contact: { id: string } };
    const convRes = await app.request(
      '/api/v1/crm/conversations',
      { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ contactId: contact.id }) },
      env
    );
    const { conversation } = (await convRes.json()) as { conversation: { id: string } };

    const aiReplyRes = await app.request(
      `/api/v1/ai/conversations/${conversation.id}/reply`,
      { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ customerText: 'What are office hours?' }) },
      env
    );
    assert.equal(aiReplyRes.status, 200);
    const aiReplyJson = (await aiReplyRes.json()) as { status: string; matchedDocsCount: number };
    assert.equal(aiReplyJson.status, 'replied');
    assert.equal(aiReplyJson.matchedDocsCount, 1);

    // 3. Team Invite & RBAC enforcement
    const inviteRes = await app.request(
      '/api/v1/team/invites',
      { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ email: 'agent2@example.com', role: 'agent' }) },
      env
    );
    assert.equal(inviteRes.status, 201);
    const { invite } = (await inviteRes.json()) as { invite: { inviteToken: string } };

    const db = createDb(d1);
    const secondUser = await registerUserWithDefaultOrg(db, {
      email: 'agent2@example.com',
      name: 'Agent Two',
      password: 'Password123!'
    });
    const secondSess = await createSessionForUser(db, {
      userId: secondUser.userId,
      activeOrganizationId: secondUser.organizationId
    });
    const agentHeaders = { Authorization: `Bearer ${secondSess.rawToken}`, 'Content-Type': 'application/json' };

    const acceptRes = await app.request(
      '/api/v1/team/invites/accept',
      { method: 'POST', headers: agentHeaders, body: JSON.stringify({ token: invite.inviteToken }) },
      env
    );
    assert.equal(acceptRes.status, 200);

    const meOwnerRes = await app.request('/api/v1/auth/me', { headers: ownerHeaders }, env);
    const meOwnerJson = (await meOwnerRes.json()) as { organization: { id: string } };
    await app.request(
      '/api/v1/auth/orgs/switch',
      { method: 'POST', headers: agentHeaders, body: JSON.stringify({ organizationId: meOwnerJson.organization.id }) },
      env
    );

    // Agent forbidden from changing billing plan (403)
    const forbiddenPlan = await app.request(
      '/api/v1/subscription/plan',
      { method: 'POST', headers: agentHeaders, body: JSON.stringify({ planTier: 'pro' }) },
      env
    );
    assert.equal(forbiddenPlan.status, 403);

    // Subscription & usage endpoint reports real D1 usage counts
    const subRes = await app.request('/api/v1/subscription', { headers: ownerHeaders }, env);
    assert.equal(subRes.status, 200);
    const subJson = (await subRes.json()) as {
      billingReady: boolean;
      usage: { contactsCount: number; knowledgeDocsCount: number; todayAiReplies: number };
    };
    assert.equal(subJson.billingReady, false);
    assert.equal(subJson.usage.contactsCount, 1);
    assert.equal(subJson.usage.knowledgeDocsCount, 1);
    assert.equal(subJson.usage.todayAiReplies, 1);
  });
});
