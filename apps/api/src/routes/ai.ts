import { Hono } from 'hono';
import { z } from 'zod';
import {
  analyzeConversationLeads,
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
  updateAiAgentConfig,
  type BusinessProfile
} from '@wacrm/db';
import { MetaCloudProvider, type QrBridgeClient, type WhatsAppProvider } from '@wacrm/providers';
import { createOptionalQrBridgeClient, parseApiConfig, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const BusinessProfileSchema = z.object({
  businessName: z.string().trim().max(120).optional(),
  businessDescription: z.string().trim().max(2000).optional(),
  productsAndServices: z.string().trim().max(4000).optional(),
  pricesAndPackages: z.string().trim().max(4000).optional(),
  openingHours: z.string().trim().max(500).optional(),
  faqs: z.string().trim().max(8000).optional(),
  location: z.string().trim().max(500).optional(),
  contactInfo: z.string().trim().max(500).optional(),
  customerServiceInstructions: z.string().trim().max(2000).optional(),
  preferredLanguage: z.string().trim().max(50).optional(),
  tone: z.string().trim().max(50).optional(),
  customInstructions: z.string().trim().max(4000).optional()
}).nullable().optional();

const UpdateAgentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  systemPrompt: z.string().trim().min(10).max(2000).optional(),
  modelId: z.string().trim().min(3).max(120).optional(),
  isEnabled: z.boolean().optional(),
  dailyReplyLimit: z.number().int().min(1).max(10000).optional(),
  dailyNeuronLimit: z.number().int().min(100).max(100000).optional(),
  supportedLanguages: z.string().max(40).optional(),
  handoffKeywords: z.array(z.string().max(50)).max(30).optional(),
  businessProfile: BusinessProfileSchema
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
      workersAiConfigured: config.workersAiConfigured,
      geminiConfigured: config.geminiConfigured,
      availableModels: [
        { id: 'gemini-1.5-flash', name: 'Google Gemini 1.5 Flash (Recommended - Fast & Natural)', provider: 'google' },
        { id: 'gemini-2.0-flash', name: 'Google Gemini 2.0 Flash (Next-Gen Gemini)', provider: 'google' },
        { id: 'gemini-1.5-pro', name: 'Google Gemini 1.5 Pro (Deep Business Reasoning)', provider: 'google' },
        { id: '@cf/meta/llama-3.1-8b-instruct-fast', name: 'Meta Llama 3.1 8B (Cloudflare Workers AI)', provider: 'cloudflare' }
      ]
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
      geminiApiKey: c.env.GEMINI_API_KEY,
      encryptionKey: c.env.ENCRYPTION_KEY,
      provider,
      qrBridge: createOptionalQrBridgeClient(c.env, customQrBridge),
      sendOutboundReply: body.sendOutboundReply ?? false
    });
    return c.json(result);
  });

  ai.post('/conversations/:id/analyze-leads', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'crm:read');
    const db = createDb(c.env.DB!);
    const geminiKey = c.env.GEMINI_API_KEY?.trim();
    if (!geminiKey) {
      return c.json(
        {
          error: {
            code: 'GEMINI_NOT_CONFIGURED',
            message: 'Google Gemini API key (GEMINI_API_KEY) is not configured on this Worker.'
          }
        },
        503
      );
    }
    const analysis = await analyzeConversationLeads(db, ctx, {
      conversationId: c.req.param('id'),
      geminiApiKey: geminiKey
    });
    return c.json({ analysis });
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
