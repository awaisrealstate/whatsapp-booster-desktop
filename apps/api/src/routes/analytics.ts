import { Hono } from 'hono';
import {
  createDb,
  getAnalyticsOverview,
  getMessageTrend,
  getPlatformAnalytics,
} from '@wacrm/db';
import { parsePlatformAdminEmails, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { getUserProfileById, createDb as _createDb, TenantAccessError } from '@wacrm/db';

function parsePeriod(query: URLSearchParams): { fromMs: number; toMs: number } {
  const period = query.get('period') ?? '30d';
  const toMs = Date.now();
  if (period === '7d') return { fromMs: toMs - 7 * 86400_000, toMs };
  if (period === '90d') return { fromMs: toMs - 90 * 86400_000, toMs };
  if (period === 'custom') {
    const from = Number(query.get('from') ?? 0);
    const to = Number(query.get('to') ?? toMs);
    return { fromMs: from || toMs - 30 * 86400_000, toMs: to || toMs };
  }
  // default 30d
  return { fromMs: toMs - 30 * 86400_000, toMs };
}

export function createAnalyticsRoutes() {
  const router = new Hono<{ Bindings: WorkerBindings; Variables: AuthVariables }>();
  router.use('*', requireOrgSession());

  // Own-org analytics overview
  router.get('/overview', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const { fromMs, toMs } = parsePeriod(new URL(c.req.url).searchParams);
    const overview = await getAnalyticsOverview(db, {
      organizationId: ctx.organizationId,
      fromMs,
      toMs,
    });
    return c.json({ overview });
  });

  // Message trend (daily breakdown)
  router.get('/messages', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const { fromMs, toMs } = parsePeriod(new URL(c.req.url).searchParams);
    const trend = await getMessageTrend(db, { organizationId: ctx.organizationId, fromMs, toMs });
    return c.json({ trend, fromMs, toMs });
  });

  // Platform-wide analytics (admin only)
  router.get('/platform', async (c) => {
    const ctx = c.get('orgContext')!;
    const adminEmails = parsePlatformAdminEmails(c.env);
    if (adminEmails.size === 0) {
      throw new TenantAccessError(403, 'PLATFORM_ADMIN_UNCONFIGURED', 'Platform admin not configured.');
    }
    const db = createDb(c.env.DB!);
    const profile = await getUserProfileById(db, ctx.userId);
    if (!profile?.email || !adminEmails.has(profile.email.toLowerCase())) {
      throw new TenantAccessError(403, 'FORBIDDEN', 'Platform admin access required.');
    }
    const { fromMs, toMs } = parsePeriod(new URL(c.req.url).searchParams);
    const analytics = await getPlatformAnalytics(db, { fromMs, toMs });
    return c.json({ analytics });
  });

  return router;
}
