import { Hono } from 'hono';
import { z } from 'zod';
import {
  assertOrgPermission,
  cancelScheduledMessage,
  createDb,
  createScheduledMessage,
  CrmError,
  getScheduledMessageById,
  getWhatsappAccountForOrg,
  listScheduledMessages,
} from '@wacrm/db';
import { MetaCloudProvider, QrBridgeClient, type WhatsAppProvider } from '@wacrm/providers';
import { createOptionalQrBridgeClient, parseApiConfig, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const ScheduleSchema = z.object({
  whatsappAccountId: z.string().min(1).max(64),
  recipientType: z.enum(['contact', 'list', 'phones']),
  recipientContactIds: z.array(z.string()).nullable().optional(),
  recipientListId: z.string().nullable().optional(),
  recipientPhones: z.array(z.string()).nullable().optional(),
  messageText: z.string().max(4096).nullable().optional(),
  templateId: z.string().nullable().optional(),
  templateVariables: z.record(z.string()).nullable().optional(),
  mediaUrl: z.string().url().nullable().optional(),
  mediaType: z.enum(['image', 'video', 'document', 'audio']).nullable().optional(),
  scheduledAt: z.number().int().min(1),
  timezone: z.string().default('UTC'),
  idempotencyKey: z.string().max(128).nullable().optional(),
});

const SendNowSchema = ScheduleSchema.omit({ scheduledAt: true, timezone: true });

export function createComposerRoutes(
  customProvider?: WhatsAppProvider,
  customQrBridge?: QrBridgeClient
) {
  const router = new Hono<{ Bindings: WorkerBindings; Variables: AuthVariables }>();
  router.use('*', requireOrgSession());

  // Schedule a message for future delivery
  router.post('/schedule', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, ScheduleSchema);
    const db = createDb(c.env.DB!);

    // Verify whatsapp account belongs to org
    const account = await getWhatsappAccountForOrg(db, ctx, body.whatsappAccountId);
    if (!account) throw new CrmError(404, 'ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');

    const id = `sm_${crypto.randomUUID().replace(/-/g, '')}`;
    const msg = await createScheduledMessage(db, {
      id,
      organizationId: ctx.organizationId,
      whatsappAccountId: body.whatsappAccountId,
      createdByUserId: ctx.userId,
      recipientType: body.recipientType,
      recipientContactIds: body.recipientContactIds,
      recipientListId: body.recipientListId,
      recipientPhones: body.recipientPhones,
      messageText: body.messageText,
      templateId: body.templateId,
      templateVariables: body.templateVariables as Record<string, string> | null | undefined,
      mediaUrl: body.mediaUrl,
      mediaType: body.mediaType,
      scheduledAt: body.scheduledAt,
      timezone: body.timezone,
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ scheduledMessage: msg }, 201);
  });

  // List scheduled messages
  router.get('/', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const status = c.req.query('status') as 'pending' | 'sent' | 'failed' | 'cancelled' | undefined;
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
    const offset = Number(c.req.query('offset') ?? 0);
    const items = await listScheduledMessages(db, {
      organizationId: ctx.organizationId,
      status,
      limit,
      offset,
    });
    return c.json({ items, limit, offset });
  });

  // Get single scheduled message
  router.get('/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const msg = await getScheduledMessageById(db, {
      id: c.req.param('id'),
      organizationId: ctx.organizationId,
    });
    if (!msg) throw new CrmError(404, 'NOT_FOUND', 'Scheduled message not found.');
    return c.json({ scheduledMessage: msg });
  });

  // Cancel a pending scheduled message
  router.delete('/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const db = createDb(c.env.DB!);
    const msg = await cancelScheduledMessage(db, {
      id: c.req.param('id'),
      organizationId: ctx.organizationId,
    });
    if (!msg) throw new CrmError(404, 'NOT_FOUND', 'Scheduled message not found or already processed.');
    return c.json({ scheduledMessage: msg });
  });

  return router;
}
