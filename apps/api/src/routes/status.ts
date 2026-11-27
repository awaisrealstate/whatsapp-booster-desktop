import { Hono } from 'hono';
import { z } from 'zod';
import {
  assertOrgPermission,
  createDb,
  createWaStatus,
  CrmError,
  deleteWaStatus,
  getWhatsappAccountForOrg,
  listWaStatuses,
  updateWaStatusRecord,
} from '@wacrm/db';
import { type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const UNOFFICIAL_ONLY_NOTICE =
  'WhatsApp Status publishing is only available via the unofficial QR Bridge (Baileys). ' +
  'The Official Meta Cloud API does not support personal Status posting via business accounts.';

const CreateStatusSchema = z.object({
  whatsappAccountId: z.string().min(1).max(64),
  contentType: z.enum(['text', 'image', 'video', 'document']),
  contentText: z.string().max(700).nullable().optional(),
  mediaUrl: z.string().url().nullable().optional(),
  mediaCaption: z.string().max(700).nullable().optional(),
  backgroundColor: z.string().max(20).nullable().optional(),
  font: z.string().max(50).nullable().optional(),
  scheduledAt: z.number().int().nullable().optional(),
});

export function createStatusRoutes() {
  const router = new Hono<{ Bindings: WorkerBindings; Variables: AuthVariables }>();
  router.use('*', requireOrgSession());

  router.get('/', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
    const offset = Number(c.req.query('offset') ?? 0);
    const items = await listWaStatuses(db, { organizationId: ctx.organizationId, limit, offset });
    return c.json({ items, limit, offset, notice: UNOFFICIAL_ONLY_NOTICE });
  });

  router.post('/', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, CreateStatusSchema);
    const db = createDb(c.env.DB!);

    // Verify account and check it uses unofficial bridge
    const account = await getWhatsappAccountForOrg(db, ctx, body.whatsappAccountId);
    if (!account) throw new CrmError(404, 'ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
    if (account.providerType !== 'unofficial_bridge') {
      throw new CrmError(
        422,
        'PROVIDER_CAPABILITY_MISSING',
        UNOFFICIAL_ONLY_NOTICE
      );
    }

    const id = `wsr_${crypto.randomUUID().replace(/-/g, '')}`;
    const record = await createWaStatus(db, {
      id,
      organizationId: ctx.organizationId,
      whatsappAccountId: body.whatsappAccountId,
      contentType: body.contentType,
      contentText: body.contentText,
      mediaUrl: body.mediaUrl,
      mediaCaption: body.mediaCaption,
      backgroundColor: body.backgroundColor,
      font: body.font,
      scheduledAt: body.scheduledAt,
    });

    return c.json({ statusRecord: record, notice: UNOFFICIAL_ONLY_NOTICE }, 201);
  });

  router.delete('/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const db = createDb(c.env.DB!);
    await deleteWaStatus(db, { id: c.req.param('id'), organizationId: ctx.organizationId });
    return c.json({ deleted: true });
  });

  return router;
}
