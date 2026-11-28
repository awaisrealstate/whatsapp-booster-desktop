import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb,
  registerUserWithDefaultOrg,
  createSessionForUser,
  revokeSessionById,
  resolveSessionContext,
  requireOrgMembership,
  getOrganizationByContext,
  createVerificationToken,
  checkAndRecordLoginAttempt,
  hashPasswordPbkdf2,
  verifyPasswordPbkdf2,
  hashTokenSha256,
  PBKDF2_MAX_WORKERS_ITERATIONS,
  TenantAccessError,
  users,
  sessions,
  verificationTokens
} from '../src/index.ts';
import { eq } from 'drizzle-orm';
import { createSqliteD1TestDatabase, applyPhase1Migrations } from './helpers/sqlite-d1.ts';

describe('Phase 1A/1B/2 Database Schema & Migrations', () => {
  it('applies all migrations idempotently with exact expected tables', () => {
    const { sqlite } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    applyPhase1Migrations(sqlite);

    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name != '_test_migrations' AND name NOT LIKE 'knowledge_fts%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;

    assert.deepEqual(
      tables.map((t) => t.name),
      [
        'ai_agents',
        'ai_business_recommendations',
        'audit_logs',
        'auth_rate_limits',
        'campaign_recipients',
        'campaigns',
        'consent_records',
        'contact_lists',
        'contact_tags',
        'contacts',
        'conversation_assignment_history',
        'conversation_audit_logs',
        'conversations',
        'knowledge_docs',
        'legacy_imports',
        'list_members',
        'message_deletion_events',
        'message_media',
        'message_sync_jobs',
        'message_versions',
        'messages',
        'oauth_accounts',
        'oauth_states',
        'organization_invites',
        'organization_members',
        'organizations',
        'scheduled_messages',
        'sessions',
        'subscriptions',
        'suppression_list',
        'tags',
        'templates',
        'usage_counters',
        'users',
        'verification_tokens',
        'wa_call_records',
        'wa_qr_sessions',
        'wa_status_records',
        'webhook_events',
        'whatsapp_accounts'
      ]
    );
  });

  it('enforces foreign keys and verification_tokens CHECK constraints', () => {
    const { sqlite } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);

    assert.throws(() => {
      sqlite
        .prepare(
          'INSERT INTO organization_members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('m1', 'missing-org', 'missing-user', 'owner', Date.now());
    });

    assert.throws(() => {
      sqlite
        .prepare(
          'INSERT INTO verification_tokens (id, user_id, email, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run('vt1', null, 'a@b.com', 'invalid_purpose', 'hash1', Date.now() + 1000, Date.now());
    });
  });
});

describe('Password, Session Expiration, Verification Tokens & Rate Limiting', () => {
  it('hashes passwords via PBKDF2-SHA256 within Workers 100k limit and verifies', async () => {
    const hash = await hashPasswordPbkdf2('StrongPass#2026');
    assert.ok(hash.startsWith(`pbkdf2_sha256$${PBKDF2_MAX_WORKERS_ITERATIONS}$`));
    assert.ok(!hash.includes('StrongPass#2026'));

    assert.equal(await verifyPasswordPbkdf2('StrongPass#2026', hash), true);
    assert.equal(await verifyPasswordPbkdf2('WrongPassword', hash), false);

    await assert.rejects(() => hashPasswordPbkdf2('short'), /at least 8 characters/);
    await assert.rejects(() => hashPasswordPbkdf2('StrongPass#2026', 150_000), /100000/);
  });

  it('stores only SHA-256 tokenHash for sessions and verification_tokens, and rejects expired sessions', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const reg = await registerUserWithDefaultOrg(db, {
      email: 'alice@example.com',
      name: 'Alice',
      password: 'Password123!'
    });

    const activeSession = await createSessionForUser(db, {
      userId: reg.userId,
      activeOrganizationId: reg.organizationId,
      clientType: 'web'
    });

    const storedRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, activeSession.sessionId));
    assert.notEqual(storedRows[0]?.tokenHash, activeSession.rawToken);
    assert.equal(storedRows[0]?.tokenHash, await hashTokenSha256(activeSession.rawToken));

    // Expired session rejected with 401
    const expiredSession = await createSessionForUser(db, {
      userId: reg.userId,
      activeOrganizationId: reg.organizationId,
      ttlMs: -1000
    });
    await assert.rejects(
      () => resolveSessionContext(db, expiredSession.rawToken),
      (err: unknown) => err instanceof TenantAccessError && err.statusCode === 401
    );

    // Revoked session rejected with 401
    await revokeSessionById(db, activeSession.sessionId);
    await assert.rejects(
      () => resolveSessionContext(db, activeSession.rawToken),
      (err: unknown) => err instanceof TenantAccessError && err.statusCode === 401
    );

    // Verification token stores SHA-256 hash only
    const vt = await createVerificationToken(db, {
      userId: reg.userId,
      email: 'alice@example.com',
      purpose: 'password_reset'
    });
    const vtRows = await db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.id, vt.id));
    assert.equal(vtRows[0]?.tokenHash, await hashTokenSha256(vt.rawToken));
    assert.notEqual(vtRows[0]?.tokenHash, vt.rawToken);
  });

  it('enforces D1-backed sliding-window login rate limiting', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const now = 1_000_000;
    for (let i = 0; i < 4; i++) {
      const res = await checkAndRecordLoginAttempt(db, {
        rateKey: 'login:1.2.3.4:user@example.com',
        success: false,
        maxAttempts: 5,
        now
      });
      assert.equal(res.allowed, true);
    }

    const fifth = await checkAndRecordLoginAttempt(db, {
      rateKey: 'login:1.2.3.4:user@example.com',
      success: false,
      maxAttempts: 5,
      now
    });
    assert.equal(fifth.allowed, false);
    assert.ok((fifth.retryAfterSec ?? 0) > 0);
  });
});

describe('Default Organization & Organization Isolation', () => {
  it('creates a default owner organization on registration and isolates cross-org access', async () => {
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

    assert.equal(alice.role, 'owner');
    assert.notEqual(alice.organizationId, bob.organizationId);

    const aliceRow = await db.select().from(users).where(eq(users.id, alice.userId));
    assert.ok(aliceRow[0]?.passwordHash && !aliceRow[0].passwordHash.includes('Password123!'));

    const aliceSession = await createSessionForUser(db, {
      userId: alice.userId,
      activeOrganizationId: alice.organizationId
    });

    const ctx = await resolveSessionContext(db, aliceSession.rawToken, alice.organizationId);
    assert.equal(ctx.organizationId, alice.organizationId);
    const org = await getOrganizationByContext(db, ctx);
    assert.equal(org?.id, alice.organizationId);

    await assert.rejects(
      () => resolveSessionContext(db, aliceSession.rawToken, bob.organizationId),
      (err: unknown) => err instanceof TenantAccessError && err.statusCode === 403
    );

    await assert.rejects(
      () => requireOrgMembership(db, alice.userId, alice.organizationId, ['viewer']),
      (err: unknown) => err instanceof TenantAccessError && err.statusCode === 403
    );
  });
});
