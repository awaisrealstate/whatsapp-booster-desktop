import { Hono } from 'hono';
import { z } from 'zod';
import {
  assertOrgPermission,
  createDb,
  createKnowledgeDoc,
  deleteKnowledgeDoc,
  enforcePlanLimit,
  getOrInitAiAgent,
  handleAiSupportForConversation,
  handoffConversationToHuman,
  listKnowledgeDocs,
  searchKnowledgeBase,
  updateAiAgentConfig
} from '@wacrm/db';
import { MetaCloudProvider, type QrBridgeClient, type WhatsAppProvider } from '@wacrm/providers';
import { createOptionalQrBridgeClient, parseApiConfig, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const UpdateAgentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  systemPrompt: z.string().trim().min(10).max(2000).optional(),
  modelId: z.string().trim().min(3).max(120).optional(),
  isEnabled: z.boolean().optional(),
  dailyReplyLimit: z.number().int().min(1).max(10000).optional(),
  dailyNeuronLimit: z.number().int().min(100).max(100000).optional(),
  supportedLanguages: z.string().max(40).optional(),
  handoffKeywords: z.array(z.string().max(50)).max(30).optional()
});

const CreateKnowledgeSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(16000),
  language: z.enum(['en', 'ur']).optional(),
  category: z.string().max(60).nullable().optional()
});

const AiReplySchema = z.object({
  customerText: z.string().trim().min(1).max(4096),
  sendOutboundReply: z.boolean().optional()
});

const HandoffSchema = z.object({
  reason: z.string().max(240).optional()
});

export function createAiRoutes(customProvider?: WhatsAppProvider, customQrBridge?: QrBridgeClient) {
  const ai = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  ai.use('*', requireOrgSession());

  ai.get('/agent', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'ai:read');
    const db = createDb(c.env.DB!);
    const agent = await getOrInitAiAgent(db, ctx);
    const config = parseApiConfig(c.env);
    return c.json({
      agent,
      workersAiConfigured: config.workersAiConfigured
    });
  });

  ai.patch('/agent', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'ai:manage');
    const body = await parseJsonBody(c, UpdateAgentSchema);
    const db = createDb(c.env.DB!);
    const agent = await updateAiAgentConfig(db, ctx, body);
    return c.json({ agent });
  });

  ai.get('/knowledge', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'ai:read');
    const db = createDb(c.env.DB!);
    const items = await listKnowledgeDocs(db, ctx);
    return c.json({ items });
  });

  ai.post('/knowledge', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'ai:manage');
    const body = await parseJsonBody(c, CreateKnowledgeSchema);
    const db = createDb(c.env.DB!);
    await enforcePlanLimit(db, ctx, 'knowledgeDocs', 1);
    const doc = await createKnowledgeDoc(db, ctx, body);
    return c.json({ doc }, 201);
  });

  ai.delete('/knowledge/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'ai:manage');
    const db = createDb(c.env.DB!);
    const result = await deleteKnowledgeDoc(db, ctx, c.req.param('id'));
    return c.json(result);
  });

  ai.get('/knowledge/search', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'ai:read');
    const q = c.req.query('q') || '';
    const items = await searchKnowledgeBase(c.env.DB!, ctx.organizationId, q, 6);
    return c.json({ items });
  });

  ai.post('/conversations/:id/reply', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, AiReplySchema);
    const db = createDb(c.env.DB!);
    const config = parseApiConfig(c.env);
    const provider = customProvider ?? new MetaCloudProvider({ graphVersion: config.metaGraphVersion });

    const result = await handleAiSupportForConversation(db, c.env.DB!, {
      organizationId: ctx.organizationId,
      conversationId: c.req.param('id'),
      customerText: body.customerText,
      aiBinding: c.env.AI,
      encryptionKey: c.env.ENCRYPTION_KEY,
      provider,
      qrBridge: createOptionalQrBridgeClient(c.env, customQrBridge),
      sendOutboundReply: body.sendOutboundReply ?? false
    });
    return c.json(result);
  });

  ai.post('/conversations/:id/handoff', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, HandoffSchema);
    const db = createDb(c.env.DB!);
    const result = await handoffConversationToHuman(
      db,
      ctx,
      c.req.param('id'),
      body.reason || 'Transferred to human agent'
    );
    return c.json(result);
  });

  return ai;
}
