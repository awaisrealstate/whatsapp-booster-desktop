import { Hono } from 'hono';
import { z } from 'zod';
import { MetaCloudProvider, type QrBridgeClient, type WhatsAppProvider } from '@wacrm/providers';
import {
  assertOrgPermission,
  CAMPAIGN_SCHEDULE_TYPES,
  createCampaign,
  createDb,
  CrmError,
  enforcePlanLimit,
  getCampaignById,
  getCampaignReport,
  listCampaigns,
  runScheduledCampaignTick,
  transitionCampaignStatus
} from '@wacrm/db';
import { createOptionalQrBridgeClient, parseApiConfig, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CreateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  whatsappAccountId: z.string().min(1).max(64),
  listId: z.string().min(1).max(64),
  templateId: z.string().min(1).max(64).nullable().optional(),
  messageOverride: z.string().max(4096).nullable().optional(),
  scheduleType: z.enum(CAMPAIGN_SCHEDULE_TYPES).optional(),
  scheduledAt: z.number().int().positive().nullable().optional(),
  timezone: z.string().max(64).optional(),
  dailyLimit: z.number().int().min(1).max(10000).optional()
});

export function createCampaignRoutes(customProvider?: WhatsAppProvider, customQrBridge?: QrBridgeClient) {
  const routes = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  routes.use('*', requireOrgSession());

  routes.get('/', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listCampaigns(db, ctx);
    return c.json({ items });
  });

  routes.post('/', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'campaigns:manage');
    const body = await parseJsonBody(c, CreateCampaignSchema);
    const db = createDb(c.env.DB!);
    await enforcePlanLimit(db, ctx, 'campaigns', 1);
    const campaign = await createCampaign(db, ctx, body);
    return c.json({ campaign }, 201);
  });

  routes.get('/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const campaign = await getCampaignById(db, ctx, c.req.param('id'));
    if (!campaign) throw new CrmError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
    return c.json({ campaign });
  });

  routes.get('/:id/report', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const report = await getCampaignReport(db, ctx, c.req.param('id'));
    return c.json(report);
  });

  routes.post('/:id/launch', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'campaigns:manage');
    const db = createDb(c.env.DB!);
    const campaign = await transitionCampaignStatus(db, ctx, c.req.param('id'), 'launch');
    return c.json({ campaign });
  });

  routes.post('/:id/pause', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'campaigns:manage');
    const db = createDb(c.env.DB!);
    const campaign = await transitionCampaignStatus(db, ctx, c.req.param('id'), 'pause');
    return c.json({ campaign });
  });

  routes.post('/:id/resume', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'campaigns:manage');
    const db = createDb(c.env.DB!);
    const campaign = await transitionCampaignStatus(db, ctx, c.req.param('id'), 'resume');
    return c.json({ campaign });
  });

  routes.post('/:id/cancel', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'campaigns:manage');
    const db = createDb(c.env.DB!);
    const campaign = await transitionCampaignStatus(db, ctx, c.req.param('id'), 'cancel');
    return c.json({ campaign });
  });

  routes.post('/:id/dispatch-tick', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'campaigns:manage');
    const db = createDb(c.env.DB!);
    const existing = await getCampaignById(db, ctx, c.req.param('id'));
    if (!existing) throw new CrmError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');

    const config = parseApiConfig(c.env);
    const provider = customProvider ?? new MetaCloudProvider({ graphVersion: config.metaGraphVersion });
    const qrBridge = createOptionalQrBridgeClient(c.env, customQrBridge);
    const summary = await runScheduledCampaignTick(db, {
      jobsQueue: c.env.JOBS_QUEUE,
      encryptionKey: c.env.ENCRYPTION_KEY,
      provider,
      qrBridge,
      inlineFallbackLimit: 10
    });
    const campaign = await getCampaignById(db, ctx, existing.id);
    return c.json({ summary, campaign });
  });

  return routes;
}
