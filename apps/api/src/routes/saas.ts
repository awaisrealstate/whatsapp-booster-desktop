import { Hono } from 'hono';
import { z } from 'zod';
import {
  acceptOrganizationInvite,
  adminUpdateCustomerOrganizationPlan,
  assertOrgPermission,
  createDb,
  createOrganizationInvite,
  enforcePlanLimit,
  getOrganizationSubscriptionAndUsage,
  getRolePermissions,
  getUserProfileById,
  INVITE_ROLES,
  listAuditLogs,
  listOrganizationInvites,
  listOrganizationMembers,
  listOrganizationsForPlatformAdmin,
  ORG_ROLES,
  removeOrganizationMember,
  SUBSCRIPTION_STATUSES,
  TenantAccessError,
  updateOrganizationMemberRole,
  updateOrganizationPlanManual,
  updateOrganizationSettings,
  getPlatformAdminConversationsOverview,
  recordAuditLog
} from '@wacrm/db';
import { parseApiConfig, parsePlatformAdminEmails, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const UpdateOrgSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional(),
  timezone: z.string().trim().min(2).max(64).optional()
});

const InviteCreateSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(INVITE_ROLES)
});

const AcceptInviteSchema = z.object({
  token: z.string().min(16).max(256)
});

const UpdateRoleSchema = z.object({
  role: z.enum(ORG_ROLES)
});

const UpdatePlanSchema = z.object({
  planTier: z.enum(['free', 'pro', 'business']),
  status: z.enum(SUBSCRIPTION_STATUSES).optional()
});

export function createSaasRoutes() {
  const saas = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  const authGuard = requireOrgSession();
  saas.use('/org/*', authGuard);
  saas.use('/team/*', authGuard);
  saas.use('/subscription', authGuard);
  saas.use('/subscription/*', authGuard);
  saas.use('/admin/*', authGuard);

  async function assertPlatformAdmin(
    env: WorkerBindings,
    userId: string
  ): Promise<{ userId: string; email: string }> {
    const adminEmails = parsePlatformAdminEmails(env);
    if (adminEmails.size === 0) {
      throw new TenantAccessError(
        403,
        'PLATFORM_ADMIN_UNCONFIGURED',
        'Platform admin access is not enabled on this environment.'
      );
    }
    const db = createDb(env.DB!);
    const profile = await getUserProfileById(db, userId);
    if (!profile || !adminEmails.has(profile.email.trim().toLowerCase())) {
      throw new TenantAccessError(
        403,
        'PLATFORM_ADMIN_REQUIRED',
        'Platform owner admin privileges are required for this endpoint.'
      );
    }
    return { userId: profile.id, email: profile.email };
  }

  // Organization Settings & Audit Logs
  saas.patch('/org/settings', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'org:manage_settings');
    const body = await parseJsonBody(c, UpdateOrgSettingsSchema);
    const db = createDb(c.env.DB!);
    const organization = await updateOrganizationSettings(db, ctx, body);
    return c.json({ organization });
  });

  saas.get('/org/audit-logs', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'audit:read');
    const db = createDb(c.env.DB!);
    const items = await listAuditLogs(db, ctx, Number(c.req.query('limit') ?? 50) || 50);
    return c.json({ items });
  });

  // Team Members, Roles & Permissions
  saas.get('/team/roles', (c) => {
    const ctx = c.get('orgContext')!;
    return c.json({
      currentRole: ctx.role,
      currentPermissions: getRolePermissions(ctx.role),
      roles: ORG_ROLES.map((role) => ({
        role,
        permissions: getRolePermissions(role)
      }))
    });
  });

  saas.get('/team/members', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'team:read');
    const db = createDb(c.env.DB!);
    const items = await listOrganizationMembers(db, ctx);
    return c.json({ items });
  });

  saas.patch('/team/members/:id/role', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, UpdateRoleSchema);
    const db = createDb(c.env.DB!);
    const result = await updateOrganizationMemberRole(db, ctx, c.req.param('id'), body.role);
    return c.json(result);
  });

  saas.delete('/team/members/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const result = await removeOrganizationMember(db, ctx, c.req.param('id'));
    return c.json(result);
  });

  // Invitations
  saas.get('/team/invites', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listOrganizationInvites(db, ctx);
    return c.json({ items });
  });

  saas.post('/team/invites', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, InviteCreateSchema);
    const db = createDb(c.env.DB!);
    await enforcePlanLimit(db, ctx, 'teamMembers', 1);
    const invite = await createOrganizationInvite(db, ctx, body);
    return c.json(
      {
        invite: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
          inviteToken: invite.rawToken
        },
        emailDelivered: false,
        emailNotice:
          'Copy and share the inviteToken (or ?invite= OAuth link) manually; no automated email provider is active.'
      },
      201
    );
  });

  saas.post('/team/invites/accept', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, AcceptInviteSchema);
    const db = createDb(c.env.DB!);
    const profile = await import('@wacrm/db').then((m) => m.getUserProfileById(db, ctx.userId));
    if (!profile) return c.json({ error: { code: 'UNAUTHORIZED', message: 'User not found.' } }, 401);
    const accepted = await acceptOrganizationInvite(db, {
      rawToken: body.token,
      userId: ctx.userId,
      userEmail: profile.email
    });
    return c.json(accepted);
  });

  // Subscription & Usage Tracking
  saas.get('/subscription', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const data = await getOrganizationSubscriptionAndUsage(db, ctx);
    return c.json(data);
  });

  saas.post('/subscription/plan', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'org:manage_billing');
    const body = await parseJsonBody(c, UpdatePlanSchema);
    const db = createDb(c.env.DB!);
    const data = await updateOrganizationPlanManual(db, ctx, body);
    return c.json(data);
  });

  // Platform Owner Admin Endpoints (Manage customers, plans, subscriptions & system health ONLY;
  // NEVER accesses, shares, or merges customer WhatsApp sessions or credentials)
  saas.get('/admin/overview', async (c) => {
    const ctx = c.get('orgContext')!;
    await assertPlatformAdmin(c.env, ctx.userId);
    const db = createDb(c.env.DB!);
    const config = parseApiConfig(c.env);
    const organizations = await listOrganizationsForPlatformAdmin(db);
    return c.json({
      systemHealth: {
        status: 'ok',
        database: 'ok',
        encryptionConfigured: config.encryptionConfigured,
        workersAiConfigured: config.workersAiConfigured,
        qrBridgeConfigured: config.qrBridgeConfigured
      },
      organizations
    });
  });

  saas.post('/admin/organizations/:orgId/plan', async (c) => {
    const ctx = c.get('orgContext')!;
    const admin = await assertPlatformAdmin(c.env, ctx.userId);
    const body = await parseJsonBody(c, UpdatePlanSchema);
    const db = createDb(c.env.DB!);
    const updated = await adminUpdateCustomerOrganizationPlan(db, {
      actorUserId: admin.userId,
      targetOrganizationId: c.req.param('orgId'),
      planTier: body.planTier,
      status: body.status
    });
    return c.json(updated);
  });

  saas.get('/admin/conversations/overview', async (c) => {
    const ctx = c.get('orgContext')!;
    const admin = await assertPlatformAdmin(c.env, ctx.userId);
    const db = createDb(c.env.DB!);

    await recordAuditLog(db, {
      organizationId: ctx.organizationId,
      actorUserId: admin.userId,
      action: 'platform_admin.conversations_inspected',
      entityType: 'platform',
      entityId: null
    });

    const overview = await getPlatformAdminConversationsOverview(db);
    return c.json(overview);
  });

  return saas;
}
