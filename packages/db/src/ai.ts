import { and, desc, eq, sql } from 'drizzle-orm';
import {
  MetaCloudProvider,
  QrBridgeClient,
  type WhatsAppProvider,
  generateGeminiContent,
  analyzeLeadsAndRetentionWithGemini,
  DEFAULT_GEMINI_MODEL,
  type LeadRetentionAnalysisResult
} from '@wacrm/providers';
import type { AppDatabase } from './client.ts';
import { CrmError, checkCampaignEligibility } from './crm.ts';
import { getPlanDefinition } from './plans.ts';
import { recordAuditLog } from './saas.ts';
import type { OrgContext } from './tenant.ts';
import { getDecryptedMetaCredentials, getWhatsappAccountForOrg } from './whatsapp.ts';
import {
  aiAgents,
  contacts,
  conversations,
  conversationAssignmentHistory,
  knowledgeDocs,
  messages,
  organizations,
  usageCounters,
  type BusinessProfile
} from './schema.ts';

export interface WorkersAiBinding {
  run(
    model: string,
    inputs: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      max_tokens?: number;
      temperature?: number;
    }
  ): Promise<{ response?: string } | string>;
}

const DEFAULT_HANDOFF_KEYWORDS = [
  'agent',
  'human',
  'representative',
  'complaint',
  'manager',
  'support',
  'مدد',
  'نمائندہ',
  'شکایت'
];

function getUtcDayKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function parseKeywords(rawJson: string | null | undefined): string[] {
  if (!rawJson) return [...DEFAULT_HANDOFF_KEYWORDS];
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
    }
  } catch {}
  return [...DEFAULT_HANDOFF_KEYWORDS];
}

function parseBusinessProfile(rawJson: string | null | undefined): BusinessProfile {
  if (!rawJson) return {};
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && typeof parsed === 'object') return parsed as BusinessProfile;
  } catch {}
  return {};
}

export function buildBusinessProfilePrompt(profile?: BusinessProfile | null): string {
  if (!profile) return '';
  const sections: string[] = [];

  if (profile.businessName?.trim()) sections.push(`Business Name: ${profile.businessName.trim()}`);
  if (profile.businessDescription?.trim()) sections.push(`Description: ${profile.businessDescription.trim()}`);
  if (profile.productsAndServices?.trim()) sections.push(`Products & Services:\n${profile.productsAndServices.trim()}`);
  if (profile.pricesAndPackages?.trim()) sections.push(`Prices & Packages:\n${profile.pricesAndPackages.trim()}`);
  if (profile.openingHours?.trim()) sections.push(`Opening Hours: ${profile.openingHours.trim()}`);
  if (profile.location?.trim()) sections.push(`Location: ${profile.location.trim()}`);
  if (profile.contactInfo?.trim()) sections.push(`Contact Info: ${profile.contactInfo.trim()}`);
  if (profile.faqs?.trim()) sections.push(`Frequently Asked Questions (FAQs):\n${profile.faqs.trim()}`);
  if (profile.customerServiceInstructions?.trim()) sections.push(`Customer Service Instructions: ${profile.customerServiceInstructions.trim()}`);
  if (profile.preferredLanguage?.trim()) sections.push(`Preferred Language: ${profile.preferredLanguage.trim()}`);
  if (profile.tone?.trim()) sections.push(`Tone: ${profile.tone.trim()}`);
  if (profile.customInstructions?.trim()) sections.push(`Custom Instructions: ${profile.customInstructions.trim()}`);

  if (sections.length === 0) return '';
  return `=== BUSINESS PROFILE & KNOWLEDGE ===\n${sections.join('\n\n')}`;
}

export function detectHumanHandoffRequest(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  return keywords.some((kw) => kw && lower.includes(kw.toLowerCase()));
}

function buildFtsQueryTerms(text: string): string {
  // Strip FTS5 operators & punctuation, keep Unicode letters/digits >= 2 chars
  const tokens = text
    .replace(/["'*():^~]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export async function getOrInitAiAgent(db: AppDatabase, ctx: OrgContext) {
  const rows = await db
    .select()
    .from(aiAgents)
    .where(eq(aiAgents.organizationId, ctx.organizationId))
    .limit(1);

  if (rows[0]) {
    return {
      ...rows[0],
      isEnabled: Boolean(rows[0].isEnabled),
      handoffKeywords: parseKeywords(rows[0].handoffKeywordsJson),
      businessProfile: parseBusinessProfile(rows[0].businessProfileJson)
    };
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await db
    .insert(aiAgents)
    .values({
      id,
      organizationId: ctx.organizationId,
      name: 'WhatsApp Support Assistant',
      systemPrompt:
        'You are a polite customer support assistant for our organization. Respond in English or Urdu matching the customer language using ONLY the provided Knowledge Base facts. Never guess or invent prices, policies, or dates. If the Knowledge Base lacks the answer, respond with [HANDOFF].',
      modelId: DEFAULT_GEMINI_MODEL,
      isEnabled: 0,
      dailyReplyLimit: 50,
      dailyNeuronLimit: 2500,
      supportedLanguages: 'en,ur',
      handoffKeywordsJson: JSON.stringify(DEFAULT_HANDOFF_KEYWORDS),
      businessProfileJson: null,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing();

  const created = await db
    .select()
    .from(aiAgents)
    .where(eq(aiAgents.organizationId, ctx.organizationId))
    .limit(1);
  return {
    ...created[0]!,
    isEnabled: Boolean(created[0]!.isEnabled),
    handoffKeywords: parseKeywords(created[0]!.handoffKeywordsJson),
    businessProfile: parseBusinessProfile(created[0]!.businessProfileJson)
  };
}

export async function updateAiAgentConfig(
  db: AppDatabase,
  ctx: OrgContext,
  patch: {
    name?: string;
    systemPrompt?: string;
    modelId?: string;
    isEnabled?: boolean;
    dailyReplyLimit?: number;
    dailyNeuronLimit?: number;
    supportedLanguages?: string;
    handoffKeywords?: string[];
    businessProfile?: BusinessProfile | null;
  }
) {
  const current = await getOrInitAiAgent(db, ctx);
  const now = Date.now();

  await db
    .update(aiAgents)
    .set({
      name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
      systemPrompt:
        patch.systemPrompt !== undefined
          ? patch.systemPrompt.trim() || current.systemPrompt
          : current.systemPrompt,
      modelId: patch.modelId !== undefined ? patch.modelId.trim() || current.modelId : current.modelId,
      isEnabled: patch.isEnabled !== undefined ? (patch.isEnabled ? 1 : 0) : current.isEnabled ? 1 : 0,
      dailyReplyLimit:
        patch.dailyReplyLimit !== undefined
          ? Math.min(Math.max(1, patch.dailyReplyLimit), 10_000)
          : current.dailyReplyLimit,
      dailyNeuronLimit:
        patch.dailyNeuronLimit !== undefined
          ? Math.min(Math.max(100, patch.dailyNeuronLimit), 100_000)
          : current.dailyNeuronLimit,
      supportedLanguages: patch.supportedLanguages ?? current.supportedLanguages,
      handoffKeywordsJson:
        patch.handoffKeywords !== undefined
          ? JSON.stringify(patch.handoffKeywords.map((k) => k.trim()).filter(Boolean))
          : current.handoffKeywordsJson,
      businessProfileJson:
        patch.businessProfile !== undefined
          ? patch.businessProfile
            ? JSON.stringify(patch.businessProfile)
            : null
          : current.businessProfileJson,
      updatedAt: now
    })
    .where(eq(aiAgents.organizationId, ctx.organizationId));

  await recordAuditLog(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'ai_agent.updated',
    entityType: 'ai_agent',
    entityId: current.id,
    metadata: { isEnabled: patch.isEnabled ?? current.isEnabled }
  });

  return getOrInitAiAgent(db, ctx);
}

export async function createKnowledgeDoc(
  db: AppDatabase,
  ctx: OrgContext,
  input: { title: string; content: string; language?: string; category?: string | null }
) {
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(knowledgeDocs).values({
    id,
    organizationId: ctx.organizationId,
    title: input.title.trim(),
    content: input.content.trim(),
    language: input.language?.trim() || 'en',
    category: input.category?.trim() || null,
    createdByUserId: ctx.userId,
    createdAt: now,
    updatedAt: now
  });

  const rows = await db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.organizationId, ctx.organizationId), eq(knowledgeDocs.id, id)))
    .limit(1);
  return rows[0]!;
}

export async function listKnowledgeDocs(db: AppDatabase, ctx: OrgContext) {
  return db
    .select()
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.organizationId, ctx.organizationId))
    .orderBy(desc(knowledgeDocs.updatedAt));
}

export async function deleteKnowledgeDoc(db: AppDatabase, ctx: OrgContext, docId: string) {
  const rows = await db
    .select({ id: knowledgeDocs.id })
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.organizationId, ctx.organizationId), eq(knowledgeDocs.id, docId)))
    .limit(1);
  if (!rows[0]) throw new CrmError(404, 'KNOWLEDGE_DOC_NOT_FOUND', 'Knowledge document not found.');
  await db
    .delete(knowledgeDocs)
    .where(and(eq(knowledgeDocs.organizationId, ctx.organizationId), eq(knowledgeDocs.id, docId)));
  return { deleted: true, id: docId };
}

/**
 * Searches organization-isolated knowledge docs using SQLite FTS5 (`knowledge_fts`).
 */
export async function searchKnowledgeBase(
  d1: D1Database,
  organizationId: string,
  queryText: string,
  limit = 4
): Promise<Array<{ docId: string; title: string; content: string; language: string }>> {
  const safeLimit = Math.min(Math.max(1, limit), 10);
  const ftsQuery = buildFtsQueryTerms(queryText);

  if (ftsQuery) {
    try {
      const res = await d1
        .prepare(
          `SELECT kd.id AS docId, kd.title AS title, kd.content AS content, kd.language AS language
           FROM knowledge_fts kf
           JOIN knowledge_docs kd ON kd.id = kf.doc_id
           WHERE kf.organization_id = ? AND knowledge_fts MATCH ?
           LIMIT ?`
        )
        .bind(organizationId, ftsQuery, safeLimit)
        .all<{ docId: string; title: string; content: string; language: string }>();

      if (res.results && res.results.length > 0) {
        return res.results;
      }
    } catch {
      // Fallback to parameterized LIKE if non-ASCII script triggers FTS tokenizer mismatch
    }
  }

  const trimmed = queryText.trim().slice(0, 60);
  if (!trimmed) return [];
  const likePattern = `%${trimmed}%`;
  const likeRes = await d1
    .prepare(
      `SELECT id AS docId, title, content, language
       FROM knowledge_docs
       WHERE organization_id = ? AND (title LIKE ? OR content LIKE ?)
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .bind(organizationId, likePattern, likePattern, safeLimit)
    .all<{ docId: string; title: string; content: string; language: string }>();

  return likeRes.results ?? [];
}

export async function handoffConversationToHuman(
  db: AppDatabase,
  ctx: OrgContext,
  conversationId: string,
  reason = 'Transferred to human support'
) {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, ctx.organizationId),
        eq(conversations.id, conversationId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');

  await db
    .update(conversations)
    .set({
      handlerMode: 'human',
      handoffReason: reason.trim().slice(0, 240),
      status: 'open',
      updatedAt: Date.now()
    })
    .where(eq(conversations.id, conversationId));

  return { conversationId, handlerMode: 'human' as const, handoffReason: reason };
}

export async function handleAiSupportForConversation(
  db: AppDatabase,
  d1: D1Database,
  params: {
    organizationId: string;
    conversationId: string;
    customerText: string;
    aiBinding?: WorkersAiBinding;
    geminiApiKey?: string;
    geminiFetchFn?: typeof fetch;
    encryptionKey?: string;
    provider?: WhatsAppProvider;
    qrBridge?: QrBridgeClient;
    sendOutboundReply?: boolean;
    now?: number;
  }
): Promise<{
  status: 'replied' | 'handoff' | 'disabled' | 'no_knowledge' | 'quota_exceeded' | 'ai_unavailable' | 'blocked';
  replyText: string | null;
  reason: string;
  matchedDocsCount: number;
  providerMessageId: string | null;
}> {
  const now = params.now ?? Date.now();
  const sysCtx: OrgContext = {
    userId: 'system-ai-bot',
    organizationId: params.organizationId,
    role: 'owner',
    sessionId: 'ai-support'
  };

  const agent = await getOrInitAiAgent(db, sysCtx);
  if (!agent.isEnabled) {
    return {
      status: 'disabled',
      replyText: null,
      reason: 'AI customer support is disabled for this organization.',
      matchedDocsCount: 0,
      providerMessageId: null
    };
  }

  const convRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, params.organizationId),
        eq(conversations.id, params.conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) {
    throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }
  const currentConv = conv;

  const contactRows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, params.organizationId), eq(contacts.id, currentConv.contactId)))
    .limit(1);
  const contact = contactRows[0];
  if (!contact) throw new CrmError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');

  // 0. Human operator protection: Never reply while a human operator is handling or conversation is assigned to human
  const isHumanHandled =
    currentConv.assignmentType === 'owner' ||
    currentConv.assignmentType === 'team_member' ||
    currentConv.handlingStatus === 'human_handling' ||
    currentConv.handlingStatus === 'assigned_owner' ||
    currentConv.handlingStatus === 'assigned_team' ||
    (currentConv.handlerMode === 'human' && currentConv.assignmentType !== 'unassigned' && currentConv.assignmentType !== 'ai');

  if (isHumanHandled) {
    return {
      status: 'blocked',
      replyText: null,
      reason: 'Conversation is currently handled by a human operator. AI automatic replies are paused.',
      matchedDocsCount: 0,
      providerMessageId: null
    };
  }

  async function recordEscalation(reason: string) {
    await db
      .update(conversations)
      .set({
        handlerMode: 'human',
        handlingStatus: 'needs_attention',
        handoffReason: reason,
        updatedAt: now
      })
      .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.id, currentConv.id)));

    const historyId = `cah_${crypto.randomUUID().replace(/-/g, '')}`;
    await db.insert(conversationAssignmentHistory).values({
      id: historyId,
      organizationId: params.organizationId,
      conversationId: currentConv.id,
      previousHandlerType: currentConv.assignmentType,
      previousUserId: currentConv.assignedUserId,
      newHandlerType: 'unassigned',
      newUserId: null,
      changedByUserId: null,
      reason: `AI Escalation: ${reason}`,
      createdAt: now
    });
  }

  // 1. Check STOP suppression / opt-out strictly
  const elig = await checkCampaignEligibility(db, sysCtx, contact.phone);
  if (!elig.eligible) {
    return {
      status: 'blocked',
      replyText: null,
      reason: `Contact is opted out (${elig.reason}).`,
      matchedDocsCount: 0,
      providerMessageId: null
    };
  }

  // 2. Human handoff keyword check
  if (detectHumanHandoffRequest(params.customerText, agent.handoffKeywords)) {
    await recordEscalation('Customer requested human agent');
    return {
      status: 'handoff',
      replyText: null,
      reason: 'Customer requested human handoff.',
      matchedDocsCount: 0,
      providerMessageId: null
    };
  }

  // 3. Enforce organization daily AI limit & SaaS plan daily AI cap
  const orgRow = await db
    .select({ planTier: organizations.planTier })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  const planCap = getPlanDefinition(orgRow[0]?.planTier).dailyAiReplies;
  const effectiveDailyLimit = Math.min(agent.dailyReplyLimit, planCap);

  const dayKey = getUtcDayKey(now);
  const usageRow = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.organizationId, params.organizationId), eq(usageCounters.periodKey, dayKey)))
    .limit(1);
  const currentAiReplies = usageRow[0]?.aiReplies ?? 0;
  const currentAiNeurons = usageRow[0]?.aiNeuronsEst ?? 0;

  if (currentAiReplies >= effectiveDailyLimit || currentAiNeurons >= agent.dailyNeuronLimit) {
    await recordEscalation('Daily AI limit reached');
    return {
      status: 'quota_exceeded',
      replyText: null,
      reason: 'Daily AI usage quota exceeded; handed off to human.',
      matchedDocsCount: 0,
      providerMessageId: null
    };
  }

  // 4. Grounding: Check Business Profile and Knowledge Base documents
  const matchedDocs = await searchKnowledgeBase(d1, params.organizationId, params.customerText, 4);
  const businessProfilePrompt = buildBusinessProfilePrompt(agent.businessProfile);
  const hasKnowledge = Boolean(businessProfilePrompt.trim()) || matchedDocs.length > 0;

  if (!hasKnowledge) {
    await recordEscalation('No knowledge base match');
    return {
      status: 'no_knowledge',
      replyText: null,
      reason: 'No matching Knowledge Base or Business Profile configured; conversation assigned to human agent.',
      matchedDocsCount: 0,
      providerMessageId: null
    };
  }

  // 5. Verify AI engine availability: Gemini API or Workers AI binding
  const hasGemini = Boolean(params.geminiApiKey?.trim());
  const hasWorkersAi = Boolean(params.aiBinding);

  if (!hasGemini && !hasWorkersAi) {
    await recordEscalation('AI_ENGINE_UNCONFIGURED');
    return {
      status: 'ai_unavailable',
      replyText: null,
      reason: 'Neither Google Gemini API (GEMINI_API_KEY) nor Cloudflare Workers AI binding (env.AI) is configured.',
      matchedDocsCount: matchedDocs.length,
      providerMessageId: null
    };
  }

  // 6. Load recent conversation history for context
  const recentHistory = await db
    .select({ direction: messages.direction, body: messages.body })
    .from(messages)
    .where(and(eq(messages.organizationId, params.organizationId), eq(messages.conversationId, currentConv.id)))
    .orderBy(desc(messages.createdAt))
    .limit(6);

  const knowledgeContext = matchedDocs.length > 0
    ? `\n\nKNOWLEDGE BASE ARTICLES:\n` +
      matchedDocs
        .map((d, i) => `[Doc ${i + 1}: ${d.title} (${d.language})]\n${d.content}`)
        .join('\n\n')
    : '';

  const systemInstruction =
    `${agent.systemPrompt}\n\nSTRICT RULES:\n` +
    `1. Answer using ONLY the provided Business Profile and Knowledge Base. Do NOT invent prices, timings, links, or policies not stated.\n` +
    `2. Reply in the customer's language (${agent.businessProfile?.preferredLanguage || 'English or Urdu'}).\n` +
    `3. Conversation tone: ${agent.businessProfile?.tone || 'polite and helpful'}.\n` +
    `4. If the Business Profile and Knowledge Base do not contain the answer, respond strictly with [HANDOFF].\n\n` +
    (businessProfilePrompt ? `${businessProfilePrompt}\n` : '') +
    knowledgeContext;

  let rawAnswer = '';

  if (hasGemini) {
    const geminiContents: Array<{ role: 'user' | 'model'; text: string }> = [
      ...recentHistory
        .reverse()
        .filter((m) => Boolean(m.body))
        .map((m) => ({
          role: (m.direction === 'inbound' ? 'user' : 'model') as 'user' | 'model',
          text: String(m.body)
        })),
      { role: 'user', text: params.customerText }
    ];

    const modelToUse = agent.modelId && agent.modelId.toLowerCase().includes('gemini')
      ? agent.modelId
      : DEFAULT_GEMINI_MODEL;

    try {
      const geminiRes = await generateGeminiContent({
        apiKey: params.geminiApiKey!,
        model: modelToUse,
        systemInstruction,
        contents: geminiContents,
        temperature: 0.2,
        maxOutputTokens: 400,
        fetchFn: params.geminiFetchFn
      });
      rawAnswer = geminiRes.text;
    } catch (err) {
      await recordEscalation('Gemini AI invocation error');
      return {
        status: 'ai_unavailable',
        replyText: null,
        reason: err instanceof Error ? err.message : 'Google Gemini API call failed.',
        matchedDocsCount: matchedDocs.length,
        providerMessageId: null
      };
    }
  } else {
    // Workers AI fallback
    const llmMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemInstruction },
      ...recentHistory
        .reverse()
        .filter((m) => Boolean(m.body))
        .map((m) => ({
          role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: String(m.body)
        })),
      { role: 'user', content: params.customerText }
    ];

    try {
      const aiOut = await params.aiBinding!.run(agent.modelId, {
        messages: llmMessages,
        max_tokens: 300,
        temperature: 0.2
      });
      rawAnswer = typeof aiOut === 'string' ? aiOut : String(aiOut?.response ?? '');
    } catch (err) {
      await recordEscalation('Workers AI invocation error');
      return {
        status: 'ai_unavailable',
        replyText: null,
        reason: err instanceof Error ? err.message : 'Workers AI call failed.',
        matchedDocsCount: matchedDocs.length,
        providerMessageId: null
      };
    }
  }

  const trimmedReply = rawAnswer.trim();
  if (!trimmedReply || trimmedReply.toUpperCase().includes('[HANDOFF]')) {
    await recordEscalation('AI triggered safe handoff');
    return {
      status: 'handoff',
      replyText: null,
      reason: 'AI could not answer confidently from knowledge base; handed off to human.',
      matchedDocsCount: matchedDocs.length,
      providerMessageId: null
    };
  }

  // Send via linked WhatsApp provider (Meta Cloud API inside 24h window OR connected QR Bridge)
  let providerMessageId: string | null = null;
  if (params.sendOutboundReply && conv.whatsappAccountId) {
    const linkedAcc = await getWhatsappAccountForOrg(db, sysCtx, conv.whatsappAccountId);
    if (linkedAcc?.providerType === 'unofficial_bridge') {
      if (params.qrBridge) {
        const res = await params.qrBridge.sendTextMessage({
          organizationId: params.organizationId,
          whatsappAccountId: conv.whatsappAccountId,
          toPhone: contact.phone,
          text: trimmedReply.slice(0, 4096)
        });
        providerMessageId = res.providerMessageId;
      }
    } else if (params.encryptionKey) {
      const creds = await getDecryptedMetaCredentials(db, sysCtx, conv.whatsappAccountId, params.encryptionKey);
      const provider = params.provider ?? new MetaCloudProvider();
      const res = await provider.sendFreeformText({
        phoneNumberId: creds.phoneNumberId,
        accessToken: creds.accessToken,
        toPhone: contact.phone,
        body: trimmedReply.slice(0, 4096),
        serviceWindowExpiresAt: conv.serviceWindowExpiresAt,
        now
      });
      providerMessageId = res.providerMessageId;
    }
  }

  // Persist AI message & usage counters
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    organizationId: params.organizationId,
    conversationId: conv.id,
    direction: 'outbound',
    senderKind: 'system',
    msgType: 'text',
    body: trimmedReply.slice(0, 4096),
    providerMessageId,
    status: providerMessageId ? 'sent' : 'pending',
    createdAt: now,
    updatedAt: now
  });

  await db
    .update(conversations)
    .set({
      handlerMode: 'ai_bot',
      assignmentType: 'ai',
      handlingStatus: 'ai_handling',
      handoffReason: null,
      lastMessagePreview: trimmedReply.slice(0, 140),
      lastMessageAt: now,
      updatedAt: now
    })
    .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.id, conv.id)));

  const estNeurons = Math.max(10, Math.ceil((trimmedReply.length + knowledgeContext.length) / 20));
  await db
    .insert(usageCounters)
    .values({
      organizationId: params.organizationId,
      periodKey: dayKey,
      outboundMessages: providerMessageId ? 1 : 0,
      aiReplies: 1,
      aiNeuronsEst: estNeurons,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [usageCounters.organizationId, usageCounters.periodKey],
      set: {
        outboundMessages: sql`${usageCounters.outboundMessages} + ${providerMessageId ? 1 : 0}`,
        aiReplies: sql`${usageCounters.aiReplies} + 1`,
        aiNeuronsEst: sql`${usageCounters.aiNeuronsEst} + ${estNeurons}`,
        updatedAt: now
      }
    });

  return {
    status: 'replied',
    replyText: trimmedReply.slice(0, 4096),
    reason: 'Grounded AI reply generated from organization Knowledge Base.',
    matchedDocsCount: matchedDocs.length,
    providerMessageId
  };
}

export async function analyzeConversationLeads(
  db: AppDatabase,
  ctx: OrgContext,
  params: {
    conversationId: string;
    geminiApiKey: string;
    model?: string;
    fetchFn?: typeof fetch;
  }
): Promise<LeadRetentionAnalysisResult> {
  const conv = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, ctx.organizationId),
        eq(conversations.id, params.conversationId)
      )
    )
    .limit(1);

  if (!conv[0]) throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');

  const contact = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        eq(contacts.id, conv[0].contactId)
      )
    )
    .limit(1);

  const msgRows = await db
    .select({
      direction: messages.direction,
      body: messages.body,
      createdAt: messages.createdAt
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.conversationId, params.conversationId)
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(30);

  const agent = await getOrInitAiAgent(db, ctx);

  return analyzeLeadsAndRetentionWithGemini({
    apiKey: params.geminiApiKey,
    model: params.model || (agent.modelId.toLowerCase().includes('gemini') ? agent.modelId : DEFAULT_GEMINI_MODEL),
    businessProfile: agent.businessProfile,
    customerName: contact[0]?.name,
    customerPhone: contact[0]?.phone,
    messages: msgRows
      .reverse()
      .filter((m) => Boolean(m.body))
      .map((m) => ({
        direction: m.direction as 'inbound' | 'outbound',
        body: String(m.body),
        timestamp: m.createdAt
      })),
    fetchFn: params.fetchFn
  });
}

