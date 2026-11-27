import { Hono } from 'hono';
import { z } from 'zod';
import {
  assertOrgPermission,
  createDb,
  createTemplate,
  deleteTemplate,
  listTemplates,
  TEMPLATE_APPROVAL_STATUSES,
  TEMPLATE_CATEGORIES
} from '@wacrm/db';
import type { WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CreateTemplateSchema = z.object({
  whatsappAccountId: z.string().min(1).max(64).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  language: z.string().trim().min(2).max(20).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  bodyText: z.string().min(1).max(4096),
  approvalStatus: z.enum(TEMPLATE_APPROVAL_STATUSES).optional()
});

export function createTemplateRoutes() {
  const tpl = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  tpl.use('*', requireOrgSession());

  tpl.get('/', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listTemplates(db, ctx);
    return c.json({ items });
  });

  tpl.post('/', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const body = await parseJsonBody(c, CreateTemplateSchema);
    const db = createDb(c.env.DB!);
    const template = await createTemplate(db, ctx, body);
    return c.json({ template }, 201);
  });

  tpl.delete('/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const db = createDb(c.env.DB!);
    const result = await deleteTemplate(db, ctx, c.req.param('id'));
    return c.json(result);
  });

  return tpl;
}
