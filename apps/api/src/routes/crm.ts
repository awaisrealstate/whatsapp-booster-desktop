import { Hono } from 'hono';
import { z } from 'zod';
import { previewSpreadsheetImport } from '@wacrm/shared';
import {
  assertOrgPermission,
  createDb,
  CrmError,
  enforcePlanLimit,
  createContact,
  getContactById,
  listContacts,
  updateContact,
  softDeleteContact,
  bulkImportContacts,
  createTag,
  listTags,
  updateTag,
  deleteTag,
  assignTagToContact,
  removeTagFromContact,
  createContactList,
  listContactLists,
  updateContactList,
  deleteContactList,
  addContactsToList,
  removeContactsFromList,
  recordConsent,
  recordStopOptOut,
  checkNumberSuppressed,
  checkCampaignEligibility,
  createOrGetConversation,
  listConversations,
  addMessageToConversation,
  listConversationMessages,
  updateMessageStatus,
  importLegacyStateToOrg,
  checkAndRecordLoginAttempt,
  assertLoginNotRateLimited,
  assignConversation,
  takeOverConversationFromAi,
  returnConversationToAi,
  listConversationAssignmentHistory,
  getConversationById,
  listFilteredConversations,
  getConversationMetricsForOrg,
  updateConversationHandlingStatus,
  CONVERSATION_HANDLING_STATUSES,
  PIPELINE_STAGES,
  CONSENT_STATUSES,
  SUPPRESSION_REASONS,
  CONVERSATION_CHANNELS,
  CONVERSATION_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_SENDER_KINDS,
  MESSAGE_TYPES,
  MESSAGE_STATUSES,
  LIST_SOURCE_TYPES
} from '@wacrm/db';
import type { WorkerBindings } from '../env.ts';
import { parseJsonBody } from '../middleware/validate.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';

const MAX_IMPORT_BASE64_BYTES = 2 * 1024 * 1024;

const CreateContactSchema = z.object({
  phone: z.union([z.string().min(1).max(40), z.number()]),
  name: z.string().max(120).optional(),
  email: z.string().email().max(254).nullable().optional(),
  company: z.string().max(120).nullable().optional(),
  customAttributes: z.record(z.string().max(500)).optional(),
  pipelineStage: z.enum(PIPELINE_STAGES).optional(),
  source: z.string().max(40).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional()
});

const UpdateContactSchema = z.object({
  phone: z.union([z.string().min(1).max(40), z.number()]).optional(),
  name: z.string().max(120).optional(),
  email: z.string().email().max(254).nullable().optional(),
  company: z.string().max(120).nullable().optional(),
  customAttributes: z.record(z.string().max(500)).optional(),
  pipelineStage: z.enum(PIPELINE_STAGES).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional()
});

const ImportPreviewSchema = z.object({
  format: z.enum(['csv', 'tsv', 'xlsx']),
  text: z.string().max(2 * 1024 * 1024).optional(),
  xlsxBase64: z.string().max(3 * 1024 * 1024).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional()
});

const BulkImportSchema = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string().max(120).optional(),
        phone: z.union([z.string().min(1).max(40), z.number()]),
        email: z.string().email().max(254).nullable().optional(),
        company: z.string().max(120).nullable().optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        customVars: z.record(z.string().max(500)).optional()
      })
    )
    .min(1)
    .max(1000),
  listName: z.string().max(120).optional(),
  sourceType: z.enum(LIST_SOURCE_TYPES).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional()
});

const TagSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
});

const TagUpdateSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
});

const AssignTagSchema = z.object({
  tagId: z.string().min(1).max(64)
});

const ListCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  sourceType: z.enum(LIST_SOURCE_TYPES).optional(),
  sourceUrl: z
    .string()
    .url()
    .max(1000)
    .refine((v) => /^https?:\/\//i.test(v), 'sourceUrl must use http:// or https://.')
    .nullable()
    .optional(),
  autoSyncEnabled: z.boolean().optional(),
  syncIntervalMin: z.number().int().min(1).max(1440).optional()
});

const ListUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  autoSyncEnabled: z.boolean().optional(),
  syncIntervalMin: z.number().int().min(1).max(1440).optional()
});

const ListMembersSchema = z.object({
  contactIds: z.array(z.string().min(1).max(64)).min(1).max(500)
});

const ConsentSchema = z.object({
  phone: z.union([z.string().min(1).max(40), z.number()]),
  status: z.enum(CONSENT_STATUSES),
  source: z.string().trim().min(1).max(80),
  proofNote: z.string().max(500).nullable().optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional()
});

const StopOptOutSchema = z.object({
  phone: z.union([z.string().min(1).max(40), z.number()]),
  reason: z.enum(SUPPRESSION_REASONS).optional(),
  source: z.string().max(80).optional(),
  notes: z.string().max(500).nullable().optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional()
});

const CreateConversationSchema = z.object({
  contactId: z.string().min(1).max(64),
  channelType: z.enum(CONVERSATION_CHANNELS).optional(),
  assignedUserId: z.string().max(64).nullable().optional()
});

const CreateMessageSchema = z.object({
  direction: z.enum(MESSAGE_DIRECTIONS),
  senderKind: z.enum(MESSAGE_SENDER_KINDS),
  msgType: z.enum(MESSAGE_TYPES).optional(),
  body: z.string().min(1).max(4096),
  idempotencyKey: z.string().max(128).nullable().optional(),
  providerMessageId: z.string().max(128).nullable().optional(),
  status: z.enum(MESSAGE_STATUSES).optional()
});

const UpdateMessageStatusSchema = z.object({
  status: z.enum(MESSAGE_STATUSES),
  providerMessageId: z.string().max(128).nullable().optional(),
  errorMessage: z.string().max(500).nullable().optional()
});

const AssignConversationSchema = z.object({
  handlerType: z.enum(['team_member', 'owner', 'ai']),
  targetUserId: z.string().max(64).nullable().optional(),
  reason: z.string().max(255).nullable().optional()
});

const TakeoverConversationSchema = z.object({
  reason: z.string().max(255).nullable().optional()
});

const ReturnToAiSchema = z.object({
  reason: z.string().max(255).nullable().optional()
});

const UpdateConversationStatusSchema = z.object({
  handlingStatus: z.enum(CONVERSATION_HANDLING_STATUSES).optional(),
  status: z.enum(CONVERSATION_STATUSES).optional(),
  reason: z.string().max(255).nullable().optional()
});

const LegacyStateSchema = z
  .object({
    contacts: z
      .array(
        z.object({
          id: z.union([z.number(), z.string()]).optional(),
          name: z.string().optional(),
          phone: z.union([z.string(), z.number()]).optional(),
          rawPhone: z.union([z.string(), z.number()]).optional(),
          customVars: z.record(z.string()).optional(),
          status: z.string().optional(),
          errorMessage: z.string().optional(),
          sentAt: z.string().nullable().optional()
        })
      )
      .max(5000)
      .optional(),
    sentPhoneHistory: z
      .record(
        z.object({
          status: z.string().optional(),
          sentAt: z.string().nullable().optional(),
          errorMessage: z.string().optional()
        })
      )
      .optional(),
    currentIndex: z.number().int().min(0).optional(),
    batchSentCount: z.number().int().min(0).optional(),
    dailyLimit: z.number().int().min(1).optional(),
    defaultCountryCode: z.string().optional(),
    template: z.string().max(4096).optional(),
    googleSheetUrl: z.string().max(1000).optional(),
    updatedAt: z.number().optional()
  })
  .passthrough();

const LegacyImportSchema = z.object({
  sourceName: z.string().max(120).optional(),
  listName: z.string().max(120).optional(),
  campaignState: LegacyStateSchema.nullable().optional(),
  localStorageState: LegacyStateSchema.nullable().optional(),
  conflictPolicy: z.enum(['skip_existing', 'merge_missing_fields', 'overwrite_existing']).optional(),
  dryRun: z.boolean().optional()
});

function decodeBase64Bytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  if (binary.length > MAX_IMPORT_BASE64_BYTES) {
    throw new CrmError(400, 'FILE_TOO_LARGE', 'Spreadsheet file exceeds 2 MB import limit.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createCrmRoutes() {
  const crm = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  // Every CRM endpoint enforces authenticated session + organization membership.
  crm.use('*', requireOrgSession());

  // CONTACTS
  crm.post('/contacts', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'crm:write');
    const body = await parseJsonBody(c, CreateContactSchema);
    const db = createDb(c.env.DB!);
    await enforcePlanLimit(db, ctx, 'contacts', 1);
    const contact = await createContact(db, ctx, body);
    return c.json({ contact }, 201);
  });

  crm.get('/contacts', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const stageParam = c.req.query('pipelineStage');
    const pipelineStage =
      stageParam && (PIPELINE_STAGES as readonly string[]).includes(stageParam)
        ? (stageParam as (typeof PIPELINE_STAGES)[number])
        : undefined;

    const result = await listContacts(db, ctx, {
      search: c.req.query('search'),
      pipelineStage,
      tagId: c.req.query('tagId'),
      limit: Number(c.req.query('limit') ?? 50) || 50,
      offset: Number(c.req.query('offset') ?? 0) || 0
    });
    return c.json(result);
  });

  crm.post('/contacts/import/preview', async (c) => {
    const body = await parseJsonBody(c, ImportPreviewSchema);
    try {
      const xlsxBytes = body.xlsxBase64 ? decodeBase64Bytes(body.xlsxBase64) : undefined;
      const preview = await previewSpreadsheetImport({
        format: body.format,
        text: body.text,
        xlsxBytes,
        defaultCountryCode: body.defaultCountryCode ?? '92'
      });
      return c.json({ preview });
    } catch (err) {
      if (err instanceof CrmError) throw err;
      const msg = err instanceof Error ? err.message : 'Unable to parse spreadsheet.';
      const code = msg.startsWith('LEGACY_XLS_UNSUPPORTED') ? 'LEGACY_XLS_UNSUPPORTED' : 'IMPORT_PARSE_ERROR';
      throw new CrmError(422, code, msg);
    }
  });

  crm.post('/contacts/import', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'crm:write');
    const db = createDb(c.env.DB!);
    const rateKey = `crm_import:${ctx.organizationId}`;
    await assertLoginNotRateLimited(db, rateKey);

    const body = await parseJsonBody(c, BulkImportSchema);
    await enforcePlanLimit(db, ctx, 'contacts', body.contacts.length);
    await checkAndRecordLoginAttempt(db, {
      rateKey,
      success: false,
      maxAttempts: 20,
      windowMs: 60 * 1000,
      lockoutMs: 60 * 1000
    });

    const summary = await bulkImportContacts(db, ctx, body);
    return c.json({ summary }, 201);
  });

  crm.get('/contacts/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const contact = await getContactById(db, ctx, c.req.param('id'));
    if (!contact) throw new CrmError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');
    return c.json({ contact });
  });

  crm.patch('/contacts/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, UpdateContactSchema);
    const db = createDb(c.env.DB!);
    const contact = await updateContact(db, ctx, c.req.param('id'), body);
    return c.json({ contact });
  });

  crm.delete('/contacts/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const result = await softDeleteContact(db, ctx, c.req.param('id'));
    return c.json(result);
  });

  // TAGS
  crm.post('/tags', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, TagSchema);
    const db = createDb(c.env.DB!);
    const tag = await createTag(db, ctx, body);
    return c.json({ tag }, 201);
  });

  crm.get('/tags', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listTags(db, ctx);
    return c.json({ items });
  });

  crm.patch('/tags/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, TagUpdateSchema);
    const db = createDb(c.env.DB!);
    const tag = await updateTag(db, ctx, c.req.param('id'), body);
    return c.json({ tag });
  });

  crm.delete('/tags/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const result = await deleteTag(db, ctx, c.req.param('id'));
    return c.json(result);
  });

  crm.post('/contacts/:id/tags', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, AssignTagSchema);
    const db = createDb(c.env.DB!);
    const result = await assignTagToContact(db, ctx, c.req.param('id'), body.tagId);
    return c.json(result, 201);
  });

  crm.delete('/contacts/:id/tags/:tagId', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const result = await removeTagFromContact(db, ctx, c.req.param('id'), c.req.param('tagId'));
    return c.json(result);
  });

  // CONTACT LISTS
  crm.post('/lists', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, ListCreateSchema);
    const db = createDb(c.env.DB!);
    const list = await createContactList(db, ctx, body);
    return c.json({ list }, 201);
  });

  crm.get('/lists', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listContactLists(db, ctx);
    return c.json({ items });
  });

  crm.patch('/lists/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, ListUpdateSchema);
    const db = createDb(c.env.DB!);
    const list = await updateContactList(db, ctx, c.req.param('id'), body);
    return c.json({ list });
  });

  crm.delete('/lists/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const result = await deleteContactList(db, ctx, c.req.param('id'));
    return c.json(result);
  });

  crm.post('/lists/:id/members', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, ListMembersSchema);
    const db = createDb(c.env.DB!);
    const result = await addContactsToList(db, ctx, c.req.param('id'), body.contactIds);
    return c.json(result, 201);
  });

  crm.delete('/lists/:id/members', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, ListMembersSchema);
    const db = createDb(c.env.DB!);
    const result = await removeContactsFromList(db, ctx, c.req.param('id'), body.contactIds);
    return c.json(result);
  });

  // CONSENT & STOP SUPPRESSION
  crm.post('/consent', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, ConsentSchema);
    const db = createDb(c.env.DB!);
    const record = await recordConsent(db, ctx, body);
    return c.json({ consent: record }, 201);
  });

  crm.post('/consent/stop', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, StopOptOutSchema);
    const db = createDb(c.env.DB!);
    const result = await recordStopOptOut(db, ctx, body);
    return c.json(result, 201);
  });

  crm.get('/consent/check', async (c) => {
    const ctx = c.get('orgContext')!;
    const phone = c.req.query('phone');
    if (!phone) throw new CrmError(400, 'PHONE_REQUIRED', 'Query parameter `phone` is required.');
    const db = createDb(c.env.DB!);
    const result = await checkNumberSuppressed(
      db,
      ctx,
      phone,
      c.req.query('defaultCountryCode') ?? '92'
    );
    return c.json(result);
  });

  crm.get('/consent/eligibility', async (c) => {
    const ctx = c.get('orgContext')!;
    const phone = c.req.query('phone');
    if (!phone) throw new CrmError(400, 'PHONE_REQUIRED', 'Query parameter `phone` is required.');
    const db = createDb(c.env.DB!);
    const result = await checkCampaignEligibility(
      db,
      ctx,
      phone,
      c.req.query('defaultCountryCode') ?? '92'
    );
    return c.json(result);
  });

  // CONVERSATIONS & MESSAGES
  crm.post('/conversations', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, CreateConversationSchema);
    const db = createDb(c.env.DB!);
    const conversation = await createOrGetConversation(db, ctx, body);
    return c.json({ conversation }, 201);
  });

  crm.get('/conversations', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const statusParam = c.req.query('status');
    const status =
      statusParam && (CONVERSATION_STATUSES as readonly string[]).includes(statusParam)
        ? (statusParam as (typeof CONVERSATION_STATUSES)[number])
        : undefined;

    const filterParam = c.req.query('filter') as any;
    const searchParam = c.req.query('search') || undefined;

    const items = await listFilteredConversations(db, ctx, {
      filter: filterParam,
      search: searchParam,
      status,
      limit: Number(c.req.query('limit') ?? 50) || 50,
      offset: Number(c.req.query('offset') ?? 0) || 0
    });
    return c.json({ items });
  });

  crm.get('/conversations-metrics', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const metrics = await getConversationMetricsForOrg(db, ctx);
    return c.json({ metrics });
  });

  crm.get('/conversations/:id', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const conversation = await getConversationById(db, ctx, c.req.param('id'));
    if (!conversation) {
      throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
    }
    return c.json({ conversation });
  });

  crm.post('/conversations/:id/assign', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, AssignConversationSchema);
    const db = createDb(c.env.DB!);
    const conversation = await assignConversation(db, ctx, {
      conversationId: c.req.param('id'),
      handlerType: body.handlerType,
      targetUserId: body.targetUserId,
      reason: body.reason
    });
    return c.json({ conversation });
  });

  crm.post('/conversations/:id/takeover', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, TakeoverConversationSchema);
    const db = createDb(c.env.DB!);
    const conversation = await takeOverConversationFromAi(db, ctx, {
      conversationId: c.req.param('id'),
      reason: body.reason
    });
    return c.json({ conversation });
  });

  crm.post('/conversations/:id/return-to-ai', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, ReturnToAiSchema);
    const db = createDb(c.env.DB!);
    const conversation = await returnConversationToAi(db, ctx, {
      conversationId: c.req.param('id'),
      reason: body.reason
    });
    return c.json({ conversation });
  });

  crm.patch('/conversations/:id/status', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, UpdateConversationStatusSchema);
    const db = createDb(c.env.DB!);
    const conversation = await updateConversationHandlingStatus(db, ctx, {
      conversationId: c.req.param('id'),
      handlingStatus: body.handlingStatus,
      status: body.status,
      reason: body.reason
    });
    return c.json({ conversation });
  });

  crm.get('/conversations/:id/assignment-history', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const history = await listConversationAssignmentHistory(db, ctx, c.req.param('id'));
    return c.json({ history });
  });

  crm.get('/conversations/:id/messages', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listConversationMessages(db, ctx, c.req.param('id'));
    return c.json({ items });
  });

  crm.post('/conversations/:id/messages', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, CreateMessageSchema);
    const db = createDb(c.env.DB!);
    const message = await addMessageToConversation(db, ctx, c.req.param('id'), body);
    return c.json({ message }, 201);
  });

  crm.patch('/messages/:id/status', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, UpdateMessageStatusSchema);
    const db = createDb(c.env.DB!);
    const message = await updateMessageStatus(db, ctx, c.req.param('id'), body);
    return c.json({ message });
  });

  // LEGACY STATE IMPORTER
  crm.post('/legacy-import', async (c) => {
    const ctx = c.get('orgContext')!;
    const body = await parseJsonBody(c, LegacyImportSchema);
    if (!body.campaignState && !body.localStorageState) {
      throw new CrmError(
        400,
        'LEGACY_STATE_REQUIRED',
        'Provide campaignState and/or localStorageState.'
      );
    }

    const db = createDb(c.env.DB!);
    const result = await importLegacyStateToOrg(db, ctx, body);
    return c.json(result, result.dryRun ? 200 : 201);
  });

  return crm;
}
