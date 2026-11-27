import { Hono } from 'hono';
import { z } from 'zod';
import {
  assertLoginNotRateLimited,
  authenticateUserByPassword,
  authenticateViaOAuthProfile,
  checkAndRecordLoginAttempt,
  consumeOAuthState,
  createAdditionalOrganization,
  createDb,
  createOAuthState,
  createSessionForUser,
  createVerificationToken,
  getOrganizationByContext,
  getRolePermissions,
  getUserProfileById,
  listUserOrganizations,
  registerUserWithDefaultOrg,
  revokeSessionById,
  switchActiveOrganization,
  TenantAccessError,
  type OAuthProvider
} from '@wacrm/db';
import { parseApiConfig, type WorkerBindings } from '../env.ts';
import { parseJsonBody } from '../middleware/validate.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { UnconfiguredEmailSender, type EmailSender } from '../auth/email.ts';

const RegisterSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(128),
  organizationName: z.string().trim().min(1).max(120).optional(),
  clientType: z.enum(['web', 'desktop']).optional()
});

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  clientType: z.enum(['web', 'desktop']).optional()
});

const CreateOrgSchema = z.object({
  name: z.string().trim().min(1).max(120),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional(),
  timezone: z.string().max(64).optional()
});

const SwitchOrgSchema = z.object({
  organizationId: z.string().min(1).max(64)
});

function getClientIp(headerFn: (name: string) => string | undefined): string {
  return (
    headerFn('cf-connecting-ip') ||
    headerFn('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function computePkceChallengeS256(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getOAuthCredentials(env: WorkerBindings, provider: OAuthProvider) {
  if (provider === 'google') {
    const clientId = env.GOOGLE_CLIENT_ID?.trim() || '';
    const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() || '';
    return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
  }
  const clientId = env.GITHUB_CLIENT_ID?.trim() || '';
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim() || '';
  return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

export function createAuthRoutes(
  emailSender: EmailSender = new UnconfiguredEmailSender(),
  oauthFetchFn: typeof fetch = (input, init) => fetch(input, init)
) {
  const auth = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  auth.get('/oauth/providers', (c) => {
    const config = parseApiConfig(c.env);
    return c.json({
      providers: [
        { provider: 'google', configured: config.googleOAuthConfigured, pkce: true },
        { provider: 'github', configured: config.githubOAuthConfigured, pkce: true }
      ],
      passwordAuthEnabled: config.passwordAuthEnabled
    });
  });

  auth.get('/oauth/:provider/start', async (c) => {
    const rawProvider = c.req.param('provider');
    if (rawProvider !== 'google' && rawProvider !== 'github') {
      return c.json({ error: { code: 'UNSUPPORTED_PROVIDER', message: 'Use google or github OAuth2.' } }, 400);
    }
    if (!c.env.DB) {
      throw new TenantAccessError(401, 'DB_UNCONFIGURED', 'Database binding is not configured.');
    }

    const creds = getOAuthCredentials(c.env, rawProvider);
    if (!creds.configured) {
      const config = parseApiConfig(c.env);
      const webAppUrl = config.webAppUrl || c.req.header('referer') || new URL(c.req.url).origin;
      const acceptHeader = c.req.header('accept') || '';
      const isBrowserNav = acceptHeader.includes('text/html') || c.req.header('sec-fetch-dest') === 'document';

      if (isBrowserNav) {
        try {
          const redirectTarget = new URL(webAppUrl);
          redirectTarget.hash = `error=oauth_not_configured&provider=${encodeURIComponent(rawProvider)}`;
          return c.redirect(redirectTarget.toString(), 302);
        } catch {}
      }

      return c.json(
        {
          error: {
            code: 'OAUTH_NOT_CONFIGURED',
            message: `${rawProvider} OAuth2 credentials are not configured on this Worker. Use email & password login or set ${rawProvider.toUpperCase()}_CLIENT_ID and ${rawProvider.toUpperCase()}_CLIENT_SECRET in .dev.vars / Cloudflare secrets.`,
            requestId: c.get('requestId')
          }
        },
        503
      );
    }

    const db = createDb(c.env.DB);
    const origin = new URL(c.req.url).origin;
    const redirectUri = `${origin}/api/v1/auth/oauth/${rawProvider}/callback`;
    const inviteToken = c.req.query('invite') || null;
    const { state, codeVerifier } = await createOAuthState(db, {
      provider: rawProvider,
      redirectUri,
      inviteToken
    });
    const codeChallenge = await computePkceChallengeS256(codeVerifier);

    const authUrl = new URL(
      rawProvider === 'google'
        ? 'https://accounts.google.com/o/oauth2/v2/auth'
        : 'https://github.com/login/oauth/authorize'
    );
    authUrl.searchParams.set('client_id', creds.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set(
      'scope',
      rawProvider === 'google' ? 'openid email profile' : 'read:user user:email'
    );

    if (c.req.query('mode') === 'json') {
      return c.json({ provider: rawProvider, authorizeUrl: authUrl.toString(), state });
    }
    return c.redirect(authUrl.toString(), 302);
  });

  auth.get('/oauth/:provider/callback', async (c) => {
    const rawProvider = c.req.param('provider');
    if (rawProvider !== 'google' && rawProvider !== 'github') {
      return c.json({ error: { code: 'UNSUPPORTED_PROVIDER', message: 'Use google or github OAuth2.' } }, 400);
    }
    if (!c.env.DB) {
      throw new TenantAccessError(401, 'DB_UNCONFIGURED', 'Database binding is not configured.');
    }

    const creds = getOAuthCredentials(c.env, rawProvider);
    if (!creds.configured) {
      return c.json(
        { error: { code: 'OAUTH_NOT_CONFIGURED', message: `${rawProvider} OAuth2 is not configured.` } },
        503
      );
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      throw new TenantAccessError(401, 'OAUTH_CALLBACK_INVALID', 'Missing OAuth code or state parameter.');
    }

    const db = createDb(c.env.DB);
    const savedState = await consumeOAuthState(db, state, rawProvider);

    let providerAccountId = '';
    let email = '';
    let emailVerified = false;
    let name = '';

    if (rawProvider === 'google') {
      const tokenRes = await oauthFetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: savedState.redirectUri,
          code_verifier: savedState.codeVerifier
        }).toString()
      });
      if (!tokenRes.ok) {
        throw new TenantAccessError(401, 'OAUTH_TOKEN_EXCHANGE_FAILED', 'Google token exchange failed.');
      }
      const tokJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokJson.access_token) {
        throw new TenantAccessError(401, 'OAUTH_TOKEN_MISSING', 'Google did not return an access token.');
      }

      const userRes = await oauthFetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokJson.access_token}` }
      });
      if (!userRes.ok) {
        throw new TenantAccessError(401, 'OAUTH_PROFILE_FAILED', 'Failed to fetch Google profile.');
      }
      const profile = (await userRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
      };
      providerAccountId = String(profile.sub ?? '');
      email = String(profile.email ?? '');
      emailVerified = Boolean(profile.email_verified);
      name = String(profile.name ?? email.split('@')[0] ?? 'Google User');
    } else {
      const tokenRes = await oauthFetchFn('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code,
          redirect_uri: savedState.redirectUri,
          code_verifier: savedState.codeVerifier
        })
      });
      if (!tokenRes.ok) {
        throw new TenantAccessError(401, 'OAUTH_TOKEN_EXCHANGE_FAILED', 'GitHub token exchange failed.');
      }
      const tokJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokJson.access_token) {
        throw new TenantAccessError(401, 'OAUTH_TOKEN_MISSING', 'GitHub did not return an access token.');
      }

      const [userRes, emailRes] = await Promise.all([
        oauthFetchFn('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${tokJson.access_token}`, 'User-Agent': 'wacrm-api' }
        }),
        oauthFetchFn('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokJson.access_token}`, 'User-Agent': 'wacrm-api' }
        })
      ]);
      if (!userRes.ok) {
        throw new TenantAccessError(401, 'OAUTH_PROFILE_FAILED', 'Failed to fetch GitHub profile.');
      }
      const ghUser = (await userRes.json()) as { id?: number | string; login?: string; name?: string; email?: string };
      const ghEmails = emailRes.ok
        ? ((await emailRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>)
        : [];
      const verifiedPrimary = ghEmails.find((e) => e.primary && e.verified) ?? ghEmails.find((e) => e.verified);
      providerAccountId = String(ghUser.id ?? '');
      email = String(verifiedPrimary?.email ?? ghUser.email ?? '');
      emailVerified = Boolean(verifiedPrimary?.verified);
      name = String(ghUser.name || ghUser.login || 'GitHub User');
    }

    const sessionResult = await authenticateViaOAuthProfile(db, {
      provider: rawProvider,
      providerAccountId,
      email,
      emailVerified,
      name,
      inviteToken: savedState.inviteToken,
      clientType: 'web'
    });

    const config = parseApiConfig(c.env);
    if (config.webAppUrl && c.req.query('mode') !== 'json') {
      const dest = `${config.webAppUrl.replace(/\/+$/, '')}/#token=${encodeURIComponent(sessionResult.rawToken)}`;
      return c.redirect(dest, 302);
    }

    return c.json({
      token: sessionResult.rawToken,
      expiresAt: sessionResult.expiresAt,
      userId: sessionResult.userId,
      organizationId: sessionResult.organizationId
    });
  });

  auth.post('/register', async (c) => {
    const config = parseApiConfig(c.env);
    if (!config.passwordAuthEnabled) {
      return c.json(
        {
          error: {
            code: 'PASSWORD_AUTH_GATED',
            message:
              'Password registration is disabled until PBKDF2 CPU usage is verified on Cloudflare Workers Free (10 ms CPU limit). Use OAuth2 PKCE or enable PASSWORD_AUTH_ENABLED on Workers Paid.',
            requestId: c.get('requestId')
          }
        },
        503
      );
    }

    if (!c.env.DB) {
      throw new TenantAccessError(401, 'DB_UNCONFIGURED', 'Database binding is not configured.');
    }

    const body = await parseJsonBody(c, RegisterSchema);
    const db = createDb(c.env.DB);
    const registered = await registerUserWithDefaultOrg(db, {
      email: body.email,
      name: body.name,
      password: body.password,
      organizationName: body.organizationName
    });

    const session = await createSessionForUser(db, {
      userId: registered.userId,
      activeOrganizationId: registered.organizationId,
      clientType: body.clientType ?? 'web'
    });

    const verification = await createVerificationToken(db, {
      userId: registered.userId,
      email: registered.email,
      purpose: 'email_verification'
    });

    const emailResult = await emailSender.sendVerificationEmail({
      to: registered.email,
      name: registered.name,
      verificationToken: verification.rawToken,
      expiresAt: verification.expiresAt
    });

    return c.json(
      {
        token: session.rawToken,
        expiresAt: session.expiresAt,
        user: {
          id: registered.userId,
          email: registered.email,
          name: registered.name,
          emailVerified: false
        },
        organization: {
          id: registered.organizationId,
          slug: registered.organizationSlug,
          role: registered.role
        },
        emailVerification: {
          delivered: emailResult.delivered,
          reason: emailResult.reason ?? null
        }
      },
      201
    );
  });

  auth.post('/login', async (c) => {
    const config = parseApiConfig(c.env);
    if (!config.passwordAuthEnabled) {
      return c.json(
        {
          error: {
            code: 'PASSWORD_AUTH_GATED',
            message:
              'Password login is disabled until PBKDF2 CPU usage is verified on Cloudflare Workers Free (10 ms CPU limit). Use OAuth2 PKCE or Workers Paid.',
            requestId: c.get('requestId')
          }
        },
        503
      );
    }

    if (!c.env.DB) {
      throw new TenantAccessError(401, 'DB_UNCONFIGURED', 'Database binding is not configured.');
    }

    const body = await parseJsonBody(c, LoginSchema);
    const db = createDb(c.env.DB);
    const clientIp = getClientIp((name) => c.req.header(name));
    const rateKey = `login:${clientIp}:${body.email.trim().toLowerCase()}`;

    await assertLoginNotRateLimited(db, rateKey);

    try {
      const authenticated = await authenticateUserByPassword(db, body.email, body.password);
      await checkAndRecordLoginAttempt(db, { rateKey, success: true });

      const session = await createSessionForUser(db, {
        userId: authenticated.userId,
        activeOrganizationId: authenticated.defaultOrganizationId,
        clientType: body.clientType ?? 'web'
      });

      return c.json({
        token: session.rawToken,
        expiresAt: session.expiresAt,
        user: {
          id: authenticated.userId,
          email: authenticated.email,
          name: authenticated.name,
          emailVerified: Boolean(authenticated.emailVerifiedAt)
        },
        organizationId: authenticated.defaultOrganizationId
      });
    } catch (err) {
      if (err instanceof TenantAccessError && err.statusCode === 401) {
        const rateStatus = await checkAndRecordLoginAttempt(db, { rateKey, success: false });
        if (!rateStatus.allowed) {
          throw new TenantAccessError(
            429,
            'RATE_LIMITED',
            'Too many failed login attempts. Please try again later.'
          );
        }
      }
      throw err;
    }
  });

  auth.post('/logout', requireOrgSession(), async (c) => {
    const orgContext = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    await revokeSessionById(db, orgContext.sessionId);
    return c.json({ ok: true });
  });

  auth.get('/me', requireOrgSession(), async (c) => {
    const orgContext = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const [user, organization, userOrgs] = await Promise.all([
      getUserProfileById(db, orgContext.userId),
      getOrganizationByContext(db, orgContext),
      listUserOrganizations(db, orgContext.userId)
    ]);

    if (!user || !organization) {
      throw new TenantAccessError(401, 'UNAUTHORIZED', 'Authenticated account no longer exists.');
    }

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: Boolean(user.emailVerifiedAt),
        createdAt: user.createdAt
      },
      organization,
      organizations: userOrgs,
      membership: {
        role: orgContext.role,
        permissions: getRolePermissions(orgContext.role)
      }
    });
  });

  auth.get('/orgs', requireOrgSession(), async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listUserOrganizations(db, ctx.userId);
    return c.json({ items, activeOrganizationId: ctx.organizationId });
  });

  auth.post('/orgs', requireOrgSession(), async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, CreateOrgSchema);
    const db = createDb(c.env.DB!);
    const org = await createAdditionalOrganization(db, ctx, body);
    return c.json({ organization: org }, 201);
  });

  auth.post('/orgs/switch', requireOrgSession(), async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, SwitchOrgSchema);
    const db = createDb(c.env.DB!);
    const switched = await switchActiveOrganization(db, ctx, body.organizationId);
    return c.json(switched);
  });

  return auth;
}
