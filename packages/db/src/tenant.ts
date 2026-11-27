import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { AppDatabase } from './client.ts';
import { hasPermission, type Permission } from './rbac.ts';
import {
  users,
  organizations,
  organizationMembers,
  organizationInvites,
  oauthAccounts,
  oauthStates,
  sessions,
  verificationTokens,
  authRateLimits,
  subscriptions,
  type OrgRole,
  type ClientType,
  type TokenPurpose,
  type OAuthProvider,
  type InviteRole
} from './schema.ts';
import {
  generateOpaqueToken,
  hashPasswordPbkdf2,
  hashTokenSha256,
  verifyPasswordPbkdf2
} from './crypto.ts';

export class TenantAccessError extends Error {
  readonly statusCode: 401 | 403 | 409 | 429;
  readonly code: string;

  constructor(statusCode: 401 | 403 | 409 | 429, code: string, message: string) {
    super(message);
    this.name = 'TenantAccessError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface OrgContext {
  userId: string;
  organizationId: string;
  role: OrgRole;
  sessionId: string;
}

export interface RegisterUserInput {
  email: string;
  name: string;
  password: string;
  organizationName?: string;
  defaultCountryCode?: string;
  timezone?: string;
}

export interface RegisterUserResult {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  organizationSlug: string;
  role: 'owner';
}

function slugifyOrgName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${base || 'workspace'}-${suffix}`;
}

/**
 * Registers a user and automatically creates a default organization with 'owner' membership.
 * Never stores plaintext passwords.
 */
export async function registerUserWithDefaultOrg(
  db: AppDatabase,
  input: RegisterUserInput
): Promise<RegisterUserResult> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const trimmedName = input.name.trim();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Valid email address is required.');
  }
  if (!trimmedName) {
    throw new Error('Name is required.');
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existing.length > 0) {
    throw new TenantAccessError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
  }

  const now = Date.now();
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const orgName = input.organizationName?.trim() || `${trimmedName}'s Workspace`;
  const orgSlug = slugifyOrgName(orgName);
  const passwordHash = await hashPasswordPbkdf2(input.password);

  await db.batch([
    db.insert(users).values({
      id: userId,
      email: normalizedEmail,
      name: trimmedName,
      passwordHash,
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now
    }),
    db.insert(organizations).values({
      id: organizationId,
      name: orgName,
      slug: orgSlug,
      defaultCountryCode: input.defaultCountryCode || '92',
      timezone: input.timezone || 'Asia/Karachi',
      createdAt: now,
      updatedAt: now
    }),
    db.insert(organizationMembers).values({
      id: memberId,
      organizationId,
      userId,
      role: 'owner',
      invitedBy: null,
      createdAt: now
    })
  ]);

  return {
    userId,
    email: normalizedEmail,
    name: trimmedName,
    organizationId,
    organizationSlug: orgSlug,
    role: 'owner'
  };
}

/**
 * Verifies user email + password using PBKDF2-SHA256 without leaking whether the email exists.
 * Note: Caller must enforce rate limiting and Workers CPU gate before calling.
 */
export async function authenticateUserByPassword(
  db: AppDatabase,
  email: string,
  password: string
): Promise<{
  userId: string;
  email: string;
  name: string;
  emailVerifiedAt: number | null;
  defaultOrganizationId: string;
}> {
  const normalizedEmail = email.trim().toLowerCase();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt
    })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  const user = rows[0];
  if (!user || !user.passwordHash) {
    throw new TenantAccessError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const valid = await verifyPasswordPbkdf2(password, user.passwordHash);
  if (!valid) {
    throw new TenantAccessError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const memberships = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.id))
    .limit(1);

  const defaultOrgId = memberships[0]?.organizationId;
  if (!defaultOrgId) {
    throw new TenantAccessError(403, 'ORG_REQUIRED', 'User does not belong to any organization.');
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt,
    defaultOrganizationId: defaultOrgId
  };
}

/**
 * Creates a session storing ONLY the SHA-256 hash of the opaque token in D1.
 */
export async function createSessionForUser(
  db: AppDatabase,
  params: {
    userId: string;
    activeOrganizationId: string;
    clientType?: ClientType;
    ttlMs?: number;
  }
): Promise<{ sessionId: string; rawToken: string; expiresAt: number }> {
  await requireOrgMembership(db, params.userId, params.activeOrganizationId);

  const now = Date.now();
  const expiresAt = now + (params.ttlMs ?? 7 * 24 * 60 * 60 * 1000);
  const sessionId = crypto.randomUUID();
  const rawToken = generateOpaqueToken(32);
  const tokenHash = await hashTokenSha256(rawToken);

  await db.insert(sessions).values({
    id: sessionId,
    userId: params.userId,
    tokenHash,
    activeOrganizationId: params.activeOrganizationId,
    clientType: params.clientType ?? 'web',
    expiresAt,
    createdAt: now
  });

  return { sessionId, rawToken, expiresAt };
}

/**
 * Revokes an active session by ID.
 */
export async function revokeSessionById(db: AppDatabase, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Creates a single-use verification or password-reset token storing ONLY its SHA-256 hash in D1.
 */
export async function createVerificationToken(
  db: AppDatabase,
  params: {
    userId?: string | null;
    email: string;
    purpose: TokenPurpose;
    ttlMs?: number;
  }
): Promise<{ id: string; rawToken: string; expiresAt: number }> {
  const now = Date.now();
  const expiresAt = now + (params.ttlMs ?? 30 * 60 * 1000);
  const id = crypto.randomUUID();
  const rawToken = generateOpaqueToken(32);
  const tokenHash = await hashTokenSha256(rawToken);

  await db.insert(verificationTokens).values({
    id,
    userId: params.userId ?? null,
    email: params.email.trim().toLowerCase(),
    purpose: params.purpose,
    tokenHash,
    expiresAt,
    usedAt: null,
    createdAt: now
  });

  return { id, rawToken, expiresAt };
}

/**
 * D1-backed sliding-window login rate limiter.
 */
export async function checkAndRecordLoginAttempt(
  db: AppDatabase,
  params: {
    rateKey: string;
    success: boolean;
    maxAttempts?: number;
    windowMs?: number;
    lockoutMs?: number;
    now?: number;
  }
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const now = params.now ?? Date.now();
  const maxAttempts = params.maxAttempts ?? 5;
  const windowMs = params.windowMs ?? 15 * 60 * 1000;
  const lockoutMs = params.lockoutMs ?? 15 * 60 * 1000;

  if (params.success) {
    await db.delete(authRateLimits).where(eq(authRateLimits.rateKey, params.rateKey));
    return { allowed: true };
  }

  const rows = await db
    .select()
    .from(authRateLimits)
    .where(eq(authRateLimits.rateKey, params.rateKey))
    .limit(1);

  const existing = rows[0];
  if (existing && existing.lockedUntil && existing.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((existing.lockedUntil - now) / 1000)
    };
  }

  if (!existing || now - existing.windowStartedAt > windowMs) {
    await db
      .insert(authRateLimits)
      .values({
        rateKey: params.rateKey,
        attemptCount: 1,
        windowStartedAt: now,
        lockedUntil: null
      })
      .onConflictDoUpdate({
        target: authRateLimits.rateKey,
        set: {
          attemptCount: 1,
          windowStartedAt: now,
          lockedUntil: null
        }
      });
    return { allowed: true };
  }

  const nextCount = existing.attemptCount + 1;
  const lockedUntil = nextCount >= maxAttempts ? now + lockoutMs : null;

  await db
    .update(authRateLimits)
    .set({
      attemptCount: nextCount,
      lockedUntil
    })
    .where(eq(authRateLimits.rateKey, params.rateKey));

  if (lockedUntil) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil(lockoutMs / 1000)
    };
  }

  return { allowed: true };
}

export async function assertLoginNotRateLimited(
  db: AppDatabase,
  rateKey: string,
  now = Date.now()
): Promise<void> {
  const rows = await db
    .select()
    .from(authRateLimits)
    .where(eq(authRateLimits.rateKey, rateKey))
    .limit(1);
  const existing = rows[0];
  if (existing && existing.lockedUntil && existing.lockedUntil > now) {
    throw new TenantAccessError(
      429,
      'RATE_LIMITED',
      'Too many failed login attempts. Please try again later.'
    );
  }
}

/**
 * Application-layer organization membership & role enforcement.
 */
export async function requireOrgMembership(
  db: AppDatabase,
  userId: string,
  organizationId: string,
  allowedRoles?: readonly OrgRole[]
): Promise<{ organizationId: string; role: OrgRole }> {
  if (!organizationId) {
    throw new TenantAccessError(403, 'ORG_REQUIRED', 'Active organization context is required.');
  }

  const rows = await db
    .select({
      organizationId: organizationMembers.organizationId,
      role: organizationMembers.role
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId)
      )
    )
    .limit(1);

  const membership = rows[0];
  if (!membership) {
    throw new TenantAccessError(
      403,
      'ORG_FORBIDDEN',
      'User does not belong to the requested organization.'
    );
  }

  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
    throw new TenantAccessError(
      403,
      'INSUFFICIENT_ROLE',
      'User role is not permitted to perform this action.'
    );
  }

  return membership;
}

/**
 * Resolves an authenticated OrgContext from a raw bearer token.
 * Rejects expired sessions (401) and unauthorized cross-organization access (403).
 */
export async function resolveSessionContext(
  db: AppDatabase,
  rawToken: string,
  requestedOrgId?: string | null
): Promise<OrgContext> {
  if (!rawToken) {
    throw new TenantAccessError(401, 'UNAUTHORIZED', 'Authentication token is missing.');
  }

  const tokenHash = await hashTokenSha256(rawToken);
  const now = Date.now();

  const sessionRows = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      activeOrganizationId: sessions.activeOrganizationId
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);

  const session = sessionRows[0];
  if (!session) {
    throw new TenantAccessError(401, 'UNAUTHORIZED', 'Session is invalid or expired.');
  }

  const targetOrgId = requestedOrgId?.trim() || session.activeOrganizationId;
  if (!targetOrgId) {
    throw new TenantAccessError(403, 'ORG_REQUIRED', 'No active organization is selected.');
  }

  const membership = await requireOrgMembership(db, session.userId, targetOrgId);
  return {
    userId: session.userId,
    organizationId: membership.organizationId,
    role: membership.role,
    sessionId: session.sessionId
  };
}

/**
 * Fetches authenticated user profile (never includes passwordHash).
 */
export async function getUserProfileById(db: AppDatabase, userId: string) {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

export function assertOrgPermission(ctx: OrgContext, permission: Permission): void {
  if (!hasPermission(ctx.role, permission)) {
    throw new TenantAccessError(
      403,
      'INSUFFICIENT_ROLE',
      `Role '${ctx.role}' lacks permission '${permission}'.`
    );
  }
}

export async function createOAuthState(
  db: AppDatabase,
  params: {
    provider: OAuthProvider;
    redirectUri: string;
    inviteToken?: string | null;
    ttlMs?: number;
  }
): Promise<{ state: string; codeVerifier: string; expiresAt: number }> {
  const now = Date.now();
  const state = generateOpaqueToken(24);
  const codeVerifier = generateOpaqueToken(32);
  const expiresAt = now + (params.ttlMs ?? 10 * 60 * 1000);

  await db.insert(oauthStates).values({
    state,
    provider: params.provider,
    codeVerifier,
    redirectUri: params.redirectUri,
    inviteToken: params.inviteToken ?? null,
    expiresAt,
    usedAt: null,
    createdAt: now
  });

  return { state, codeVerifier, expiresAt };
}

export async function consumeOAuthState(
  db: AppDatabase,
  state: string,
  provider: OAuthProvider
) {
  const now = Date.now();
  const rows = await db
    .select()
    .from(oauthStates)
    .where(
      and(
        eq(oauthStates.state, state),
        eq(oauthStates.provider, provider),
        isNull(oauthStates.usedAt),
        gt(oauthStates.expiresAt, now)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new TenantAccessError(401, 'OAUTH_STATE_INVALID', 'OAuth state is invalid, expired, or already used.');
  }

  await db
    .update(oauthStates)
    .set({ usedAt: now })
    .where(eq(oauthStates.state, state));

  return row;
}

export async function authenticateViaOAuthProfile(
  db: AppDatabase,
  params: {
    provider: OAuthProvider;
    providerAccountId: string;
    email: string;
    emailVerified: boolean;
    name: string;
    inviteToken?: string | null;
    clientType?: ClientType;
  }
) {
  const normalizedEmail = params.email.trim().toLowerCase();
  if (!normalizedEmail || !params.emailVerified) {
    throw new TenantAccessError(
      403,
      'OAUTH_EMAIL_UNVERIFIED',
      'OAuth provider must supply a verified email address.'
    );
  }

  const now = Date.now();
  const existingLink = await db
    .select()
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, params.provider),
        eq(oauthAccounts.providerAccountId, params.providerAccountId)
      )
    )
    .limit(1);

  let userId = existingLink[0]?.userId;
  let defaultOrgId: string | undefined;

  if (!userId) {
    const existingUser = await db
      .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (existingUser[0]) {
      userId = existingUser[0].id;
      if (!existingUser[0].emailVerifiedAt) {
        await db.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, userId));
      }
      await db.insert(oauthAccounts).values({
        id: crypto.randomUUID(),
        userId,
        provider: params.provider,
        providerAccountId: params.providerAccountId,
        email: normalizedEmail,
        createdAt: now,
        updatedAt: now
      });
    } else {
      userId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const subId = crypto.randomUUID();
      const displayName = params.name.trim() || normalizedEmail.split('@')[0] || 'User';
      const orgName = `${displayName}'s Workspace`;

      await db.batch([
        db.insert(users).values({
          id: userId,
          email: normalizedEmail,
          name: displayName,
          passwordHash: null,
          emailVerifiedAt: now,
          createdAt: now,
          updatedAt: now
        }),
        db.insert(oauthAccounts).values({
          id: crypto.randomUUID(),
          userId,
          provider: params.provider,
          providerAccountId: params.providerAccountId,
          email: normalizedEmail,
          createdAt: now,
          updatedAt: now
        }),
        db.insert(organizations).values({
          id: orgId,
          name: orgName,
          slug: slugifyOrgName(orgName),
          defaultCountryCode: '92',
          timezone: 'Asia/Karachi',
          planTier: 'free',
          createdAt: now,
          updatedAt: now
        }),
        db.insert(organizationMembers).values({
          id: memberId,
          organizationId: orgId,
          userId,
          role: 'owner',
          invitedBy: null,
          createdAt: now
        }),
        db.insert(subscriptions).values({
          id: subId,
          organizationId: orgId,
          planTier: 'free',
          status: 'active',
          billingProvider: 'manual',
          currentPeriodStart: now,
          currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
          cancelAtPeriodEnd: 0,
          createdAt: now,
          updatedAt: now
        })
      ]);
      defaultOrgId = orgId;
    }
  }

  if (params.inviteToken?.trim()) {
    try {
      const accepted = await acceptOrganizationInvite(db, {
        rawToken: params.inviteToken.trim(),
        userId,
        userEmail: normalizedEmail
      });
      defaultOrgId = accepted.organizationId;
    } catch {
      // Invalid/expired invite should not prevent OAuth user login into their workspace
    }
  }

  if (!defaultOrgId) {
    const memberships = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .limit(1);
    defaultOrgId = memberships[0]?.organizationId;
  }

  if (!defaultOrgId) {
    throw new TenantAccessError(403, 'ORG_REQUIRED', 'User does not belong to any organization.');
  }

  const session = await createSessionForUser(db, {
    userId,
    activeOrganizationId: defaultOrgId,
    clientType: params.clientType ?? 'web'
  });

  return {
    userId,
    organizationId: defaultOrgId,
    ...session
  };
}

export async function listUserOrganizations(db: AppDatabase, userId: string) {
  return db
    .select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      planTier: organizations.planTier,
      role: organizationMembers.role
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, userId));
}

export async function switchActiveOrganization(
  db: AppDatabase,
  ctx: OrgContext,
  targetOrganizationId: string
) {
  const membership = await requireOrgMembership(db, ctx.userId, targetOrganizationId);
  await db
    .update(sessions)
    .set({ activeOrganizationId: membership.organizationId })
    .where(eq(sessions.id, ctx.sessionId));
  return { organizationId: membership.organizationId, role: membership.role };
}

export async function createAdditionalOrganization(
  db: AppDatabase,
  ctx: OrgContext,
  input: { name: string; defaultCountryCode?: string; timezone?: string }
) {
  const now = Date.now();
  const orgId = crypto.randomUUID();
  const cleanName = input.name.trim();
  if (!cleanName) throw new TenantAccessError(403, 'ORG_REQUIRED', 'Organization name is required.');

  await db.batch([
    db.insert(organizations).values({
      id: orgId,
      name: cleanName,
      slug: slugifyOrgName(cleanName),
      defaultCountryCode: input.defaultCountryCode || '92',
      timezone: input.timezone || 'Asia/Karachi',
      planTier: 'free',
      createdAt: now,
      updatedAt: now
    }),
    db.insert(organizationMembers).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: ctx.userId,
      role: 'owner',
      invitedBy: ctx.userId,
      createdAt: now
    }),
    db.insert(subscriptions).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      planTier: 'free',
      status: 'active',
      billingProvider: 'manual',
      currentPeriodStart: now,
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: 0,
      createdAt: now,
      updatedAt: now
    })
  ]);

  await db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.id, ctx.sessionId));
  return { id: orgId, name: cleanName, role: 'owner' as const };
}

export async function listOrganizationMembers(db: AppDatabase, ctx: OrgContext) {
  return db
    .select({
      memberId: organizationMembers.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: organizationMembers.role,
      createdAt: organizationMembers.createdAt
    })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.organizationId, ctx.organizationId));
}

export async function updateOrganizationMemberRole(
  db: AppDatabase,
  ctx: OrgContext,
  memberId: string,
  newRole: OrgRole
) {
  assertOrgPermission(ctx, 'team:manage');
  if (newRole === 'owner' && ctx.role !== 'owner') {
    throw new TenantAccessError(403, 'INSUFFICIENT_ROLE', 'Only owners can assign owner role.');
  }

  const rows = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, ctx.organizationId),
        eq(organizationMembers.id, memberId)
      )
    )
    .limit(1);
  const target = rows[0];
  if (!target) {
    throw new TenantAccessError(403, 'MEMBER_NOT_FOUND', 'Team member not found.');
  }
  if (target.role === 'owner' && ctx.role !== 'owner') {
    throw new TenantAccessError(403, 'INSUFFICIENT_ROLE', 'Only an owner can modify another owner.');
  }

  await db
    .update(organizationMembers)
    .set({ role: newRole })
    .where(eq(organizationMembers.id, memberId));

  return { memberId, role: newRole };
}

export async function removeOrganizationMember(
  db: AppDatabase,
  ctx: OrgContext,
  memberId: string
) {
  assertOrgPermission(ctx, 'team:manage');
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, ctx.organizationId),
        eq(organizationMembers.id, memberId)
      )
    )
    .limit(1);
  const target = rows[0];
  if (!target) throw new TenantAccessError(403, 'MEMBER_NOT_FOUND', 'Member not found.');
  if (target.role === 'owner') {
    throw new TenantAccessError(403, 'CANNOT_REMOVE_OWNER', 'Organization owner cannot be removed.');
  }

  await db.delete(organizationMembers).where(eq(organizationMembers.id, memberId));
  return { removed: true, memberId };
}

export async function createOrganizationInvite(
  db: AppDatabase,
  ctx: OrgContext,
  input: { email: string; role: InviteRole }
) {
  assertOrgPermission(ctx, 'team:invite');
  const normalizedEmail = input.email.trim().toLowerCase();
  const now = Date.now();
  const rawToken = generateOpaqueToken(24);
  const tokenHash = await hashTokenSha256(rawToken);
  const id = crypto.randomUUID();
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;

  await db.insert(organizationInvites).values({
    id,
    organizationId: ctx.organizationId,
    email: normalizedEmail,
    role: input.role,
    tokenHash,
    invitedByUserId: ctx.userId,
    expiresAt,
    acceptedAt: null,
    createdAt: now
  });

  return { id, email: normalizedEmail, role: input.role, rawToken, expiresAt };
}

export async function listOrganizationInvites(db: AppDatabase, ctx: OrgContext) {
  assertOrgPermission(ctx, 'team:read');
  return db
    .select({
      id: organizationInvites.id,
      email: organizationInvites.email,
      role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt,
      acceptedAt: organizationInvites.acceptedAt,
      createdAt: organizationInvites.createdAt
    })
    .from(organizationInvites)
    .where(eq(organizationInvites.organizationId, ctx.organizationId))
    .orderBy(desc(organizationInvites.createdAt));
}

export async function acceptOrganizationInvite(
  db: AppDatabase,
  params: { rawToken: string; userId: string; userEmail: string }
) {
  const tokenHash = await hashTokenSha256(params.rawToken);
  const now = Date.now();

  const rows = await db
    .select()
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.tokenHash, tokenHash),
        isNull(organizationInvites.acceptedAt),
        gt(organizationInvites.expiresAt, now)
      )
    )
    .limit(1);

  const invite = rows[0];
  if (!invite) {
    throw new TenantAccessError(403, 'INVITE_INVALID', 'Organization invite is invalid or expired.');
  }
  if (invite.email.toLowerCase() !== params.userEmail.trim().toLowerCase()) {
    throw new TenantAccessError(403, 'INVITE_EMAIL_MISMATCH', 'Invite belongs to a different email address.');
  }

  await db
    .insert(organizationMembers)
    .values({
      id: crypto.randomUUID(),
      organizationId: invite.organizationId,
      userId: params.userId,
      role: invite.role,
      invitedBy: invite.invitedByUserId,
      createdAt: now
    })
    .onConflictDoNothing();

  await db
    .update(organizationInvites)
    .set({ acceptedAt: now })
    .where(eq(organizationInvites.id, invite.id));

  return { organizationId: invite.organizationId, role: invite.role };
}

/**
 * Fetches organization metadata scoped strictly by verified OrgContext.
 */
export async function getOrganizationByContext(db: AppDatabase, ctx: OrgContext) {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      defaultCountryCode: organizations.defaultCountryCode,
      timezone: organizations.timezone,
      createdAt: organizations.createdAt
    })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);

  return rows[0] ?? null;
}
