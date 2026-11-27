import { Hono } from 'hono';
import { z } from 'zod';
import {
  createAiRecommendation,
  createDb,
  dismissAiRecommendation,
  generateRuleBasedRecommendations,
  listAiRecommendations,
  getPlatformHighRiskRecommendations,
  TenantAccessError,
  getUserProfileById,
} from '@wacrm/db';
import { parsePlatformAdminEmails, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';

export function createBusinessAiRoutes() {
  const router = new Hono<{ Bindings: WorkerBindings; Variables: AuthVariables }>();
  router.use('*', requireOrgSession());

  // List AI recommendations for own org
  router.get('/recommendations', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
    const offset = Number(c.req.query('offset') ?? 0);
    const items = await listAiRecommendations(db, {
      organizationId: ctx.organizationId,
      limit,
      offset,
    });
    return c.json({ items, limit, offset });
  });

  // Generate recommendations for own org (rule-based, no external AI required)
  router.post('/recommendations/generate', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const recs = await generateRuleBasedRecommendations(db, {
      organizationId: ctx.organizationId,
      nowMs: Date.now(),
    });
    const created = [];
    for (const rec of recs) {
      try {
        const r = await createAiRecommendation(db, rec);
        if (r) created.push(r);
      } catch {
        // skip duplicates
      }
    }
    return c.json({ generated: created.length, recommendations: created });
  });

  // Dismiss a recommendation
  router.post('/recommendations/:id/dismiss', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    await dismissAiRecommendation(db, { id: c.req.param('id'), organizationId: ctx.organizationId });
    return c.json({ dismissed: true });
  });

  // Platform admin: AI retention across all orgs
  router.get('/retention', async (c) => {
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
    // Return high/medium risk items across all orgs (no cross-tenant data leakage — just aggregated recs)
    const items = await getPlatformHighRiskRecommendations(db).catch(() => []);
    return c.json({ items });
  });

  return router;
}
