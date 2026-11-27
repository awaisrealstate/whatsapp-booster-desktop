import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';
import { createDb, registerUserWithDefaultOrg, createSessionForUser } from '@wacrm/db';
import {
  createSqliteD1TestDatabase,
  applyPhase1Migrations
} from '../../../packages/db/tests/helpers/sqlite-d1.ts';

describe('API Health, Status & Security Headers', () => {
  it('GET /health returns 200 with X-Content-Type-Options: nosniff', async () => {
    const logs: string[] = [];
    const app = createApp({ logger: createLogger('info', (l) => logs.push(l)) });

    const res = await app.request('/health', {}, { APP_ENV: 'development', ALLOWED_ORIGINS: '' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const json = (await res.json()) as { ok: boolean; service: string; checks: { database: string } };
    assert.equal(json.ok, true);
    assert.equal(json.service, 'wacrm-api');
    assert.equal(json.checks.database, 'unconfigured');
    assert.ok(logs.length >= 1);
  });

  it('GET /api/v1/status sets Cache-Control: no-store and redacts secrets', async () => {
    const app = createApp({ logger: createLogger('error') });
    const res = await app.request(
      '/api/v1/status',
      {},
      { APP_ENV: 'staging', SESSION_SECRET: 'top-secret-value', ENCRYPTION_KEY: 'super-secret-key' }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const text = await res.text();
    assert.ok(!text.includes('top-secret-value'));
    assert.ok(!text.includes('super-secret-key'));

    const json = JSON.parse(text) as { status: string; phase: string };
    assert.equal(json.status, 'ok');
    assert.equal(json.phase, 'final');
  });

  it('recursively redacts secrets inside nested logger objects and arrays', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (line) => lines.push(line));
    logger.info('audit_test', {
      user: 'alice',
      password: 'plain-password',
      headers: [{ authorization: 'Bearer raw-secret' }, { cookie: 'sid=xyz' }],
      nested: { apiKey: 'key-123', tokenHash: 'hash-456', safeField: 'ok' }
    });

    assert.equal(lines.length, 1);
    const parsed = lines[0]!;
    assert.ok(!parsed.includes('plain-password'));
    assert.ok(!parsed.includes('raw-secret'));
    assert.ok(!parsed.includes('sid=xyz'));
    assert.ok(!parsed.includes('key-123'));
    assert.ok(!parsed.includes('hash-456'));
    assert.ok(parsed.includes('"safeField":"ok"'));
  });
});

describe('CORS Allowlist, Expose Headers & Request Validation', () => {
  it('allows explicitly configured origins, exposes X-Request-Id, and rejects unlisted origins', async () => {
    const app = createApp({ logger: createLogger('error') });
    const env = { ALLOWED_ORIGINS: 'https://app.wacrm.example,http://localhost:5173' };

    const okRes = await app.request(
      '/api/v1/status',
      { headers: { Origin: 'https://app.wacrm.example' } },
      env
    );
    assert.equal(okRes.headers.get('access-control-allow-origin'), 'https://app.wacrm.example');
    assert.equal(okRes.headers.get('access-control-expose-headers'), 'X-Request-Id');

    const deniedRes = await app.request(
      '/api/v1/status',
      { headers: { Origin: 'https://evil.example' } },
      env
    );
    assert.equal(deniedRes.headers.get('access-control-allow-origin'), null);

    const deniedPreflight = await app.request(
      '/api/v1/status',
      { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } },
      env
    );
    assert.equal(deniedPreflight.status, 403);
  });

  it('validates POST /api/v1/validate/contact requests and returns 400 on malformed JSON', async () => {
    const app = createApp({ logger: createLogger('error') });

    const badJson = await app.request('/api/v1/validate/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid'
    });
    assert.equal(badJson.status, 400);

    const valid = await app.request('/api/v1/validate/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ali Khan',
        phone: '0300-1234567',
        template: 'Hi {firstname}!'
      })
    });
    assert.equal(valid.status, 200);
    const json = (await valid.json()) as { valid: boolean; contact: { phone: string }; preview: string };
    assert.equal(json.valid, true);
    assert.equal(json.contact.phone, '923001234567');
    assert.equal(json.preview, 'Hi Ali!');
  });
});

describe('Authentication Foundation, Rate Limiting & Organization Isolation', () => {
  it('gates password register/login with 503 when PASSWORD_AUTH_ENABLED is not true', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const app = createApp({ logger: createLogger('error') });

    const reg = await app.request(
      '/api/v1/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', name: 'Alice', password: 'Password123!' })
      },
      { DB: d1, APP_ENV: 'production' }
    );
    assert.equal(reg.status, 503);
    const json = (await reg.json()) as { error: { code: string } };
    assert.equal(json.error.code, 'PASSWORD_AUTH_GATED');
  });

  it('supports register, login, me, logout, session revocation, rate limiting, and org isolation when enabled', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const app = createApp({ logger: createLogger('error') });
    const env = { DB: d1, APP_ENV: 'development', PASSWORD_AUTH_ENABLED: 'true' };

    // 1. Register creates user + default org + unconfigured email notice
    const regRes = await app.request(
      '/api/v1/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          name: 'Alice',
          password: 'Password123!',
          organizationName: 'Alice Studio'
        })
      },
      env
    );
    assert.equal(regRes.status, 201);
    const regJson = (await regRes.json()) as {
      token: string;
      user: { id: string; email: string; emailVerified: boolean };
      organization: { id: string; role: string };
      emailVerification: { delivered: boolean; reason: string };
    };
    assert.ok(regJson.token.length >= 32);
    assert.equal(regJson.user.emailVerified, false);
    assert.equal(regJson.organization.role, 'owner');
    assert.equal(regJson.emailVerification.delivered, false);
    assert.equal(regJson.emailVerification.reason, 'EMAIL_PROVIDER_NOT_CONFIGURED');

    // 2. GET /api/v1/auth/me returns profile and org with Cache-Control: no-store
    const meRes = await app.request(
      '/api/v1/auth/me',
      { headers: { Authorization: `Bearer ${regJson.token}` } },
      env
    );
    assert.equal(meRes.status, 200);
    assert.equal(meRes.headers.get('cache-control'), 'no-store');
    const meJson = (await meRes.json()) as { user: { email: string }; organization: { name: string } };
    assert.equal(meJson.user.email, 'alice@example.com');
    assert.equal(meJson.organization.name, 'Alice Studio');

    // 3. Cross-org check on /api/v1/orgs/current
    const db = createDb(d1);
    const bob = await registerUserWithDefaultOrg(db, {
      email: 'bob@example.com',
      name: 'Bob',
      password: 'Password123!'
    });

    const crossOrg = await app.request(
      '/api/v1/orgs/current',
      {
        headers: {
          Authorization: `Bearer ${regJson.token}`,
          'X-Organization-Id': bob.organizationId
        }
      },
      env
    );
    assert.equal(crossOrg.status, 403);

    // 4. Logout revokes session
    const logoutRes = await app.request(
      '/api/v1/auth/logout',
      { method: 'POST', headers: { Authorization: `Bearer ${regJson.token}` } },
      env
    );
    assert.equal(logoutRes.status, 200);

    const afterLogout = await app.request(
      '/api/v1/auth/me',
      { headers: { Authorization: `Bearer ${regJson.token}` } },
      env
    );
    assert.equal(afterLogout.status, 401);

    // 5. Login succeeds with valid password
    const loginRes = await app.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'Password123!' })
      },
      env
    );
    assert.equal(loginRes.status, 200);

    // 6. Rate limiting triggers 429 after 5 failed attempts
    for (let i = 0; i < 4; i++) {
      const badLogin = await app.request(
        '/api/v1/auth/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
          body: JSON.stringify({ email: 'alice@example.com', password: 'WrongPassword!' })
        },
        env
      );
      assert.equal(badLogin.status, 401);
    }
    const fifthBadLogin = await app.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'WrongPassword!' })
      },
      env
    );
    assert.equal(fifthBadLogin.status, 429);

    // 7. Expired session check via DB helper
    const expired = await createSessionForUser(db, {
      userId: bob.userId,
      activeOrganizationId: bob.organizationId,
      ttlMs: -5000
    });
    const expiredMe = await app.request(
      '/api/v1/auth/me',
      { headers: { Authorization: `Bearer ${expired.rawToken}` } },
      env
    );
    assert.equal(expiredMe.status, 401);
  });
});
