import { and, desc, eq, asc, isNull, like, or, inArray, ne, sql } from 'drizzle-orm';
import {
  validatePhoneNumber,
  buildLegacyMigrationPlan,
  type LegacyConflictPolicy,
  type LegacyOrchestratorState
} from '@wacrm/shared';
import type { AppDatabase } from './client.ts';
import type { OrgContext } from './tenant.ts';
import {
  contacts,
  tags,
  contactTags,
  contactLists,
  listMembers,
  consentRecords,
  suppressionList,
  conversations,
  messages,
  legacyImports,
  type PipelineStage,
  type ListSourceType,
  type ConsentStatus,
  type SuppressionReason,
  type ConversationChannelType,
  type ConversationStatus,
  type MessageDirection,
  type MessageSenderKind,
  type MessageType,
  type MessageStatus
} from './schema.ts';

export type CrmStatusCode = 400 | 402 | 403 | 404 | 409 | 422 | 500 | 502 | 503;

export class CrmError extends Error {
  readonly statusCode: CrmStatusCode;
  readonly code: string;

  constructor(statusCode: CrmStatusCode, code: string, message: string) {
    super(message);
    this.name = 'CrmError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const D1_SAFE_IN_CHUNK_SIZE = 80;

function chunkArray<T>(items: readonly T[], size = D1_SAFE_IN_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function parseJsonObject(jsonText: string | null | undefined): Record<string, string> {
  if (!jsonText) return {};
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {}
  return {};
}

// ============================================================================
// CONTACTS
// ============================================================================

export async function createContact(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    phone: string | number;
    name?: string;
    email?: string | null;
    company?: string | null;
    customAttributes?: Record<string, string>;
    pipelineStage?: PipelineStage;
    source?: string;
    defaultCountryCode?: string;
  }
) {
  const phoneCheck = validatePhoneNumber(input.phone, input.defaultCountryCode ?? '92');
  if (!phoneCheck.valid) {
    throw new CrmError(422, 'INVALID_PHONE', phoneCheck.reason ?? 'Invalid phone number.');
  }

  const existing = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        eq(contacts.phone, phoneCheck.phone),
        isNull(contacts.deletedAt)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    throw new CrmError(409, 'DUPLICATE_CONTACT', 'A contact with this phone number already exists.');
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const name = input.name?.trim() || 'Valued Client';
  const customAttrs: Record<string, string> = {
    ...(input.customAttributes ?? {}),
    name,
    phone: phoneCheck.phone
  };
  if (input.company?.trim()) customAttrs.company = input.company.trim();

  await db.insert(contacts).values({
    id,
    organizationId: ctx.organizationId,
    phone: phoneCheck.phone,
    rawPhone: String(input.phone).trim(),
    name,
    email: input.email?.trim().toLowerCase() || null,
    company: input.company?.trim() || null,
    customAttributesJson: JSON.stringify(customAttrs),
    pipelineStage: input.pipelineStage ?? 'lead',
    source: input.source ?? 'manual',
    deletedAt: null,
    createdAt: now,
    updatedAt: now
  });

  return getContactById(db, ctx, id);
}

export async function getContactById(db: AppDatabase, ctx: OrgContext, contactId: string) {
  const rows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        eq(contacts.id, contactId),
        isNull(contacts.deletedAt)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const tagRows = await db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(contactTags)
    .innerJoin(tags, eq(contactTags.tagId, tags.id))
    .where(
      and(eq(contactTags.organizationId, ctx.organizationId), eq(contactTags.contactId, contactId))
    );

  const suppression = await checkNumberSuppressed(db, ctx, row.phone);

  return {
    ...row,
    customAttributes: parseJsonObject(row.customAttributesJson),
    tags: tagRows,
    isSuppressed: suppression.suppressed
  };
}

export async function listContacts(
  db: AppDatabase,
  ctx: OrgContext,
  params: {
    search?: string;
    pipelineStage?: PipelineStage;
    tagId?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const limit = Math.min(Math.max(1, params.limit ?? 50), 200);
  const offset = Math.max(0, params.offset ?? 0);

  const conditions = [
    eq(contacts.organizationId, ctx.organizationId),
    isNull(contacts.deletedAt)
  ];

  if (params.pipelineStage) {
    conditions.push(eq(contacts.pipelineStage, params.pipelineStage));
  }

  if (params.search && params.search.trim()) {
    const q = `%${params.search.trim()}%`;
    conditions.push(
      or(
        like(contacts.name, q),
        like(contacts.phone, q),
        like(contacts.company, q),
        like(contacts.email, q)
      )!
    );
  }

  if (params.tagId) {
    const taggedSubquery = db
      .select({ contactId: contactTags.contactId })
      .from(contactTags)
      .where(
        and(eq(contactTags.organizationId, ctx.organizationId), eq(contactTags.tagId, params.tagId))
      );
    conditions.push(inArray(contacts.id, taggedSubquery));
  }

  const items = await db
    .select()
    .from(contacts)
    .where(and(...conditions))
    .orderBy(desc(contacts.updatedAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(contacts)
    .where(and(...conditions));

  return {
    items: items.map((r) => ({
      ...r,
      customAttributes: parseJsonObject(r.customAttributesJson)
    })),
    total: Number(countRows[0]?.count ?? 0),
    limit,
    offset
  };
}

export async function updateContact(
  db: AppDatabase,
  ctx: OrgContext,
  contactId: string,
  patch: {
    name?: string;
    phone?: string | number;
    email?: string | null;
    company?: string | null;
    customAttributes?: Record<string, string>;
    pipelineStage?: PipelineStage;
    defaultCountryCode?: string;
  }
) {
  const current = await getContactById(db, ctx, contactId);
  if (!current) {
    throw new CrmError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');
  }

  let nextPhone = current.phone;
  let nextRawPhone = current.rawPhone;
  if (patch.phone !== undefined) {
    const check = validatePhoneNumber(patch.phone, patch.defaultCountryCode ?? '92');
    if (!check.valid) {
      throw new CrmError(422, 'INVALID_PHONE', check.reason ?? 'Invalid phone number.');
    }
    if (check.phone !== current.phone) {
      const dup = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, ctx.organizationId),
            eq(contacts.phone, check.phone),
            isNull(contacts.deletedAt)
          )
        )
        .limit(1);
      if (dup.length > 0) {
        throw new CrmError(409, 'DUPLICATE_CONTACT', 'Another active contact already uses this phone.');
      }
    }
    nextPhone = check.phone;
    nextRawPhone = String(patch.phone).trim();
  }

  const nextName = patch.name !== undefined ? patch.name.trim() || 'Valued Client' : current.name;
  const nextCompany = patch.company !== undefined ? (patch.company?.trim() || null) : current.company;
  const mergedAttrs: Record<string, string> = {
    ...current.customAttributes,
    ...(patch.customAttributes ?? {}),
    name: nextName,
    phone: nextPhone
  };
  if (nextCompany) mergedAttrs.company = nextCompany;

  await db
    .update(contacts)
    .set({
      name: nextName,
      phone: nextPhone,
      rawPhone: nextRawPhone,
      email: patch.email !== undefined ? (patch.email?.trim().toLowerCase() || null) : current.email,
      company: nextCompany,
      customAttributesJson: JSON.stringify(mergedAttrs),
      pipelineStage: patch.pipelineStage ?? current.pipelineStage,
      updatedAt: Date.now()
    })
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.id, contactId)));

  return getContactById(db, ctx, contactId);
}

/**
 * Soft-deletes a contact. NEVER deletes consent_records or suppression_list rows.
 */
export async function softDeleteContact(db: AppDatabase, ctx: OrgContext, contactId: string) {
  const existing = await getContactById(db, ctx, contactId);
  if (!existing) {
    throw new CrmError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');
  }

  const now = Date.now();
  await db
    .update(contacts)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.id, contactId)));

  return { deleted: true, id: contactId, deletedAt: now };
}

export async function bulkImportContacts(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    contacts: Array<{
      name?: string;
      phone: string | number;
      email?: string | null;
      company?: string | null;
      tags?: string[];
      customVars?: Record<string, string>;
    }>;
    listName?: string;
    sourceType?: ListSourceType;
    defaultCountryCode?: string;
  }
) {
  const now = Date.now();
  const cc = input.defaultCountryCode ?? '92';

  const existingActive = await db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), isNull(contacts.deletedAt)));

  const existingByPhone = new Map(existingActive.map((c) => [c.phone, c.id]));
  const suppressedRows = await db
    .select({ phone: suppressionList.phone })
    .from(suppressionList)
    .where(and(eq(suppressionList.organizationId, ctx.organizationId), isNull(suppressionList.liftedAt)));
  const suppressedSet = new Set(suppressedRows.map((s) => s.phone));

  let optionalListId: string | null = null;
  if (input.listName?.trim()) {
    const list = await createContactList(db, ctx, {
      name: input.listName.trim(),
      sourceType: input.sourceType ?? 'csv'
    });
    optionalListId = list.id;
  }

  let createdCount = 0;
  let skippedDuplicatesCount = 0;
  let invalidCount = 0;
  let suppressedCount = 0;
  const createdIds: string[] = [];
  const memberContactIds: string[] = [];
  const seenInBatch = new Set<string>();
  const errors: Array<{ index: number; phone: string; reason: string }> = [];

  // Preload organization tags to minimize D1 queries
  const orgTags = await listTags(db, ctx);
  const tagMap = new Map(orgTags.map((t) => [t.name.toLowerCase(), t.id]));

  for (let idx = 0; idx < input.contacts.length; idx++) {
    const item = input.contacts[idx]!;
    const check = validatePhoneNumber(item.phone, cc);
    if (!check.valid) {
      invalidCount++;
      errors.push({ index: idx, phone: String(item.phone ?? ''), reason: check.reason ?? 'Invalid phone.' });
      continue;
    }

    if (seenInBatch.has(check.phone)) {
      skippedDuplicatesCount++;
      continue;
    }
    seenInBatch.add(check.phone);

    if (suppressedSet.has(check.phone)) {
      suppressedCount++;
    }

    let contactId = existingByPhone.get(check.phone);
    if (contactId) {
      skippedDuplicatesCount++;
    } else {
      contactId = crypto.randomUUID();
      const name = item.name?.trim() || 'Valued Client';
      const customAttrs: Record<string, string> = {
        ...(item.customVars ?? {}),
        name,
        phone: check.phone
      };
      if (item.company?.trim()) customAttrs.company = item.company.trim();

      await db.insert(contacts).values({
        id: contactId,
        organizationId: ctx.organizationId,
        phone: check.phone,
        rawPhone: String(item.phone).trim(),
        name,
        email: item.email?.trim().toLowerCase() || null,
        company: item.company?.trim() || null,
        customAttributesJson: JSON.stringify(customAttrs),
        pipelineStage: 'lead',
        source: input.sourceType ?? 'csv',
        deletedAt: null,
        createdAt: now,
        updatedAt: now
      });

      existingByPhone.set(check.phone, contactId);
      createdCount++;
      createdIds.push(contactId);
    }

    memberContactIds.push(contactId);

    if (Array.isArray(item.tags)) {
      for (const rawTag of item.tags) {
        const tagName = rawTag.trim();
        if (!tagName) continue;
        let tagId = tagMap.get(tagName.toLowerCase());
        if (!tagId) {
          const createdTag = await createTag(db, ctx, { name: tagName });
          tagId = createdTag.id;
          tagMap.set(tagName.toLowerCase(), tagId);
        }
        await db
          .insert(contactTags)
          .values({ organizationId: ctx.organizationId, contactId, tagId, createdAt: now })
          .onConflictDoNothing();
      }
    }
  }

  if (optionalListId && memberContactIds.length > 0) {
    await addContactsToList(db, ctx, optionalListId, memberContactIds);
  }

  return {
    totalSubmitted: input.contacts.length,
    createdCount,
    skippedDuplicatesCount,
    invalidCount,
    suppressedInImportCount: suppressedCount,
    listId: optionalListId,
    createdIds,
    errors
  };
}

// ============================================================================
// TAGS
// ============================================================================

export async function createTag(
  db: AppDatabase,
  ctx: OrgContext,
  input: { name: string; color?: string }
) {
  const name = input.name.trim();
  if (!name) throw new CrmError(400, 'INVALID_TAG', 'Tag name is required.');

  const existing = await db
    .select()
    .from(tags)
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.name, name)))
    .limit(1);
  if (existing.length > 0) {
    throw new CrmError(409, 'TAG_EXISTS', 'Tag with this name already exists.');
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(tags).values({
    id,
    organizationId: ctx.organizationId,
    name,
    color: input.color?.trim() || '#00a884',
    createdAt: now,
    updatedAt: now
  });

  const rows = await db
    .select()
    .from(tags)
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, id)))
    .limit(1);
  return rows[0]!;
}

export async function listTags(db: AppDatabase, ctx: OrgContext) {
  return db
    .select()
    .from(tags)
    .where(eq(tags.organizationId, ctx.organizationId))
    .orderBy(asc(tags.name));
}

export async function updateTag(
  db: AppDatabase,
  ctx: OrgContext,
  tagId: string,
  patch: { name?: string; color?: string }
) {
  const rows = await db
    .select()
    .from(tags)
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, tagId)))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new CrmError(404, 'TAG_NOT_FOUND', 'Tag not found.');

  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!nextName) throw new CrmError(400, 'INVALID_TAG', 'Tag name cannot be empty.');

  if (nextName !== existing.name) {
    const conflict = await db
      .select({ id: tags.id })
      .from(tags)
      .where(
        and(
          eq(tags.organizationId, ctx.organizationId),
          eq(tags.name, nextName),
          ne(tags.id, tagId)
        )
      )
      .limit(1);
    if (conflict.length > 0) {
      throw new CrmError(409, 'TAG_EXISTS', 'Tag with this name already exists.');
    }
  }

  await db
    .update(tags)
    .set({
      name: nextName,
      color: patch.color !== undefined ? patch.color.trim() : existing.color,
      updatedAt: Date.now()
    })
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, tagId)));

  const updated = await db
    .select()
    .from(tags)
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, tagId)))
    .limit(1);
  return updated[0]!;
}

export async function deleteTag(db: AppDatabase, ctx: OrgContext, tagId: string) {
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, tagId)))
    .limit(1);
  if (rows.length === 0) throw new CrmError(404, 'TAG_NOT_FOUND', 'Tag not found.');

  await db
    .delete(tags)
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, tagId)));
  return { deleted: true, id: tagId };
}

export async function assignTagToContact(
  db: AppDatabase,
  ctx: OrgContext,
  contactId: string,
  tagId: string
) {
  const contact = await getContactById(db, ctx, contactId);
  if (!contact) throw new CrmError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');

  const tagRows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, tagId)))
    .limit(1);
  if (tagRows.length === 0) throw new CrmError(404, 'TAG_NOT_FOUND', 'Tag not found.');

  await db
    .insert(contactTags)
    .values({
      organizationId: ctx.organizationId,
      contactId,
      tagId,
      createdAt: Date.now()
    })
    .onConflictDoNothing();

  return { assigned: true, contactId, tagId };
}

export async function removeTagFromContact(
  db: AppDatabase,
  ctx: OrgContext,
  contactId: string,
  tagId: string
) {
  await db
    .delete(contactTags)
    .where(
      and(
        eq(contactTags.organizationId, ctx.organizationId),
        eq(contactTags.contactId, contactId),
        eq(contactTags.tagId, tagId)
      )
    );
  return { removed: true, contactId, tagId };
}

// ============================================================================
// CONTACT LISTS
// ============================================================================

export async function createContactList(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    name: string;
    description?: string | null;
    sourceType?: ListSourceType;
    sourceUrl?: string | null;
    autoSyncEnabled?: boolean;
    syncIntervalMin?: number;
  }
) {
  const name = input.name.trim();
  if (!name) throw new CrmError(400, 'INVALID_LIST', 'List name is required.');

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(contactLists).values({
    id,
    organizationId: ctx.organizationId,
    name,
    description: input.description?.trim() || null,
    sourceType: input.sourceType ?? 'manual',
    sourceUrl: input.sourceUrl?.trim() || null,
    autoSyncEnabled: input.autoSyncEnabled ? 1 : 0,
    syncIntervalMin: Math.max(1, input.syncIntervalMin ?? 5),
    deletedAt: null,
    createdAt: now,
    updatedAt: now
  });

  const rows = await db
    .select()
    .from(contactLists)
    .where(and(eq(contactLists.organizationId, ctx.organizationId), eq(contactLists.id, id)))
    .limit(1);
  return rows[0]!;
}

export async function listContactLists(db: AppDatabase, ctx: OrgContext) {
  const lists = await db
    .select()
    .from(contactLists)
    .where(and(eq(contactLists.organizationId, ctx.organizationId), isNull(contactLists.deletedAt)))
    .orderBy(desc(contactLists.updatedAt));

  const counts = await db
    .select({
      listId: listMembers.listId,
      count: sql<number>`count(*)`
    })
    .from(listMembers)
    .innerJoin(contacts, eq(listMembers.contactId, contacts.id))
    .where(and(eq(listMembers.organizationId, ctx.organizationId), isNull(contacts.deletedAt)))
    .groupBy(listMembers.listId);

  const countMap = new Map(counts.map((c) => [c.listId, Number(c.count)]));
  return lists.map((l) => ({
    ...l,
    memberCount: countMap.get(l.id) ?? 0
  }));
}

export async function updateContactList(
  db: AppDatabase,
  ctx: OrgContext,
  listId: string,
  patch: {
    name?: string;
    description?: string | null;
    autoSyncEnabled?: boolean;
    syncIntervalMin?: number;
  }
) {
  const rows = await db
    .select()
    .from(contactLists)
    .where(
      and(
        eq(contactLists.organizationId, ctx.organizationId),
        eq(contactLists.id, listId),
        isNull(contactLists.deletedAt)
      )
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new CrmError(404, 'LIST_NOT_FOUND', 'Contact list not found.');

  await db
    .update(contactLists)
    .set({
      name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
      description: patch.description !== undefined ? (patch.description?.trim() || null) : existing.description,
      autoSyncEnabled: patch.autoSyncEnabled !== undefined ? (patch.autoSyncEnabled ? 1 : 0) : existing.autoSyncEnabled,
      syncIntervalMin: patch.syncIntervalMin !== undefined ? Math.max(1, patch.syncIntervalMin) : existing.syncIntervalMin,
      updatedAt: Date.now()
    })
    .where(and(eq(contactLists.organizationId, ctx.organizationId), eq(contactLists.id, listId)));

  const updated = await db
    .select()
    .from(contactLists)
    .where(and(eq(contactLists.organizationId, ctx.organizationId), eq(contactLists.id, listId)))
    .limit(1);
  return updated[0]!;
}

export async function deleteContactList(db: AppDatabase, ctx: OrgContext, listId: string) {
  const rows = await db
    .select({ id: contactLists.id })
    .from(contactLists)
    .where(
      and(
        eq(contactLists.organizationId, ctx.organizationId),
        eq(contactLists.id, listId),
        isNull(contactLists.deletedAt)
      )
    )
    .limit(1);
  if (rows.length === 0) throw new CrmError(404, 'LIST_NOT_FOUND', 'Contact list not found.');

  const now = Date.now();
  await db
    .update(contactLists)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(contactLists.organizationId, ctx.organizationId), eq(contactLists.id, listId)));

  return { deleted: true, id: listId, deletedAt: now };
}

export async function addContactsToList(
  db: AppDatabase,
  ctx: OrgContext,
  listId: string,
  contactIds: readonly string[]
) {
  const listRows = await db
    .select({ id: contactLists.id })
    .from(contactLists)
    .where(
      and(
        eq(contactLists.organizationId, ctx.organizationId),
        eq(contactLists.id, listId),
        isNull(contactLists.deletedAt)
      )
    )
    .limit(1);
  if (listRows.length === 0) throw new CrmError(404, 'LIST_NOT_FOUND', 'Contact list not found.');

  const uniqueContactIds = Array.from(new Set(contactIds));
  if (uniqueContactIds.length === 0) return { added: 0 };

  const validContactIds: string[] = [];
  for (const idChunk of chunkArray(uniqueContactIds, D1_SAFE_IN_CHUNK_SIZE)) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, ctx.organizationId),
          inArray(contacts.id, idChunk),
          isNull(contacts.deletedAt)
        )
      );
    for (const row of rows) {
      validContactIds.push(row.id);
    }
  }

  const now = Date.now();
  const inserts = validContactIds.map((contactId) =>
    db
      .insert(listMembers)
      .values({ organizationId: ctx.organizationId, listId, contactId, addedAt: now })
      .onConflictDoNothing()
  );

  for (const stmtChunk of chunkArray(inserts, 20)) {
    const first = stmtChunk[0];
    if (!first) continue;
    await db.batch([first, ...stmtChunk.slice(1)]);
  }

  return { added: validContactIds.length, listId };
}

export async function removeContactsFromList(
  db: AppDatabase,
  ctx: OrgContext,
  listId: string,
  contactIds: readonly string[]
) {
  const uniqueContactIds = Array.from(new Set(contactIds));
  if (uniqueContactIds.length === 0) return { removed: 0 };
  for (const idChunk of chunkArray(uniqueContactIds, D1_SAFE_IN_CHUNK_SIZE)) {
    await db
      .delete(listMembers)
      .where(
        and(
          eq(listMembers.organizationId, ctx.organizationId),
          eq(listMembers.listId, listId),
          inArray(listMembers.contactId, idChunk)
        )
      );
  }
  return { removed: uniqueContactIds.length, listId };
}

// ============================================================================
// CONSENT & STOP SUPPRESSION
// ============================================================================

export async function recordConsent(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    phone: string | number;
    status: ConsentStatus;
    source: string;
    proofNote?: string | null;
    defaultCountryCode?: string;
  }
) {
  const check = validatePhoneNumber(input.phone, input.defaultCountryCode ?? '92');
  if (!check.valid) {
    throw new CrmError(422, 'INVALID_PHONE', check.reason ?? 'Invalid phone number.');
  }

  const matchedContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        eq(contacts.phone, check.phone),
        isNull(contacts.deletedAt)
      )
    )
    .limit(1);

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(consentRecords).values({
    id,
    organizationId: ctx.organizationId,
    contactId: matchedContacts[0]?.id ?? null,
    phone: check.phone,
    channel: 'whatsapp',
    status: input.status,
    source: input.source.trim(),
    proofNote: input.proofNote?.trim() || null,
    recordedByUserId: ctx.userId,
    recordedAt: now,
    createdAt: now,
    updatedAt: now
  });

  if (input.status === 'opted_out') {
    await db
      .insert(suppressionList)
      .values({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        phone: check.phone,
        reason: 'manual_opt_out',
        source: input.source.trim(),
        notes: input.proofNote?.trim() || null,
        suppressedAt: now,
        liftedAt: null,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [suppressionList.organizationId, suppressionList.phone],
        set: {
          reason: 'manual_opt_out',
          source: input.source.trim(),
          notes: input.proofNote?.trim() || null,
          suppressedAt: now,
          liftedAt: null,
          updatedAt: now
        }
      });
  } else if (input.status === 'opted_in') {
    await db
      .update(suppressionList)
      .set({ liftedAt: now, updatedAt: now })
      .where(
        and(
          eq(suppressionList.organizationId, ctx.organizationId),
          eq(suppressionList.phone, check.phone),
          isNull(suppressionList.liftedAt)
        )
      );
  }

  return {
    id,
    phone: check.phone,
    status: input.status,
    source: input.source.trim(),
    recordedAt: now
  };
}

export async function recordStopOptOut(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    phone: string | number;
    reason?: SuppressionReason;
    source?: string;
    notes?: string | null;
    defaultCountryCode?: string;
    recordedByUserId?: string | null;
  }
) {
  const check = validatePhoneNumber(input.phone, input.defaultCountryCode ?? '92');
  if (!check.valid) {
    throw new CrmError(422, 'INVALID_PHONE', check.reason ?? 'Invalid phone number.');
  }

  const matchedContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, ctx.organizationId),
        eq(contacts.phone, check.phone),
        isNull(contacts.deletedAt)
      )
    )
    .limit(1);

  const now = Date.now();
  const reason = input.reason ?? 'stop_keyword';
  const source = input.source?.trim() || 'inbound_stop';

  await db.insert(consentRecords).values({
    id: crypto.randomUUID(),
    organizationId: ctx.organizationId,
    contactId: matchedContacts[0]?.id ?? null,
    phone: check.phone,
    channel: 'whatsapp',
    status: 'opted_out',
    source,
    proofNote: input.notes?.trim() || `Suppressed (${reason})`,
    recordedByUserId: input.recordedByUserId === undefined ? ctx.userId : input.recordedByUserId,
    recordedAt: now,
    createdAt: now,
    updatedAt: now
  });

  await db
    .insert(suppressionList)
    .values({
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      phone: check.phone,
      reason,
      source,
      notes: input.notes?.trim() || null,
      suppressedAt: now,
      liftedAt: null,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [suppressionList.organizationId, suppressionList.phone],
      set: {
        reason,
        source,
        notes: input.notes?.trim() || null,
        suppressedAt: now,
        liftedAt: null,
        updatedAt: now
      }
    });

  return { phone: check.phone, suppressed: true, reason, suppressedAt: now };
}

export async function checkNumberSuppressed(
  db: AppDatabase,
  ctx: OrgContext,
  rawPhone: string | number,
  defaultCountryCode = '92'
) {
  const check = validatePhoneNumber(rawPhone, defaultCountryCode);
  if (!check.valid) {
    throw new CrmError(422, 'INVALID_PHONE', check.reason ?? 'Invalid phone number.');
  }

  const rows = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.organizationId, ctx.organizationId),
        eq(suppressionList.phone, check.phone),
        isNull(suppressionList.liftedAt)
      )
    )
    .limit(1);

  const entry = rows[0];
  return {
    phone: check.phone,
    suppressed: Boolean(entry),
    reason: entry?.reason ?? null,
    suppressedAt: entry?.suppressedAt ?? null
  };
}

export async function checkCampaignEligibility(
  db: AppDatabase,
  ctx: OrgContext,
  rawPhone: string | number,
  defaultCountryCode = '92'
): Promise<{
  phone: string;
  eligible: boolean;
  consentStatus: ConsentStatus;
  reason: string | null;
}> {
  const suppression = await checkNumberSuppressed(db, ctx, rawPhone, defaultCountryCode);
  const latestConsentRows = await db
    .select({ status: consentRecords.status })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organizationId, ctx.organizationId),
        eq(consentRecords.phone, suppression.phone)
      )
    )
    .orderBy(desc(consentRecords.recordedAt))
    .limit(1);

  const consentStatus: ConsentStatus = latestConsentRows[0]?.status ?? 'unknown';

  if (suppression.suppressed) {
    return {
      phone: suppression.phone,
      eligible: false,
      consentStatus: 'opted_out',
      reason: `SUPPRESSED:${suppression.reason}`
    };
  }

  if (consentStatus === 'opted_out') {
    return {
      phone: suppression.phone,
      eligible: false,
      consentStatus,
      reason: 'OPTED_OUT'
    };
  }

  return {
    phone: suppression.phone,
    eligible: true,
    consentStatus,
    reason: null
  };
}

// ============================================================================
// CONVERSATIONS & MESSAGES
// ============================================================================

export async function createOrGetConversation(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    contactId: string;
    channelType?: ConversationChannelType;
    assignedUserId?: string | null;
  }
) {
  const contact = await getContactById(db, ctx, input.contactId);
  if (!contact) throw new CrmError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');

  const channelType = input.channelType ?? 'manual_crm';
  const existing = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, ctx.organizationId),
        eq(conversations.contactId, input.contactId),
        eq(conversations.channelType, channelType)
      )
    )
    .limit(1);

  if (existing[0]) return existing[0];

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(conversations).values({
    id,
    organizationId: ctx.organizationId,
    contactId: input.contactId,
    channelType,
    status: 'open',
    assignedUserId: input.assignedUserId ?? null,
    unreadCount: 0,
    createdAt: now,
    updatedAt: now
  });

  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, id)))
    .limit(1);
  return rows[0]!;
}

export async function listConversations(
  db: AppDatabase,
  ctx: OrgContext,
  params: { status?: ConversationStatus; limit?: number; offset?: number } = {}
) {
  const limit = Math.min(Math.max(1, params.limit ?? 50), 200);
  const offset = Math.max(0, params.offset ?? 0);

  const conditions = [eq(conversations.organizationId, ctx.organizationId)];
  if (params.status) {
    conditions.push(eq(conversations.status, params.status));
  }

  return db
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      channelType: conversations.channelType,
      status: conversations.status,
      assignedUserId: conversations.assignedUserId,
      unreadCount: conversations.unreadCount,
      lastMessagePreview: conversations.lastMessagePreview,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt
    })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.updatedAt))
    .limit(limit)
    .offset(offset);
}

export async function addMessageToConversation(
  db: AppDatabase,
  ctx: OrgContext,
  conversationId: string,
  input: {
    direction: MessageDirection;
    senderKind: MessageSenderKind;
    msgType?: MessageType;
    body: string;
    idempotencyKey?: string | null;
    providerMessageId?: string | null;
    status?: MessageStatus;
  }
) {
  const convRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, ctx.organizationId),
        eq(conversations.id, conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');

  if (input.idempotencyKey) {
    const dup = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, ctx.organizationId),
          eq(messages.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (dup[0]) return dup[0];
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const status: MessageStatus =
    input.status ?? (input.direction === 'inbound' ? 'delivered' : 'pending');

  await db.insert(messages).values({
    id,
    organizationId: ctx.organizationId,
    conversationId,
    direction: input.direction,
    senderKind: input.senderKind,
    senderUserId: input.senderKind === 'agent' ? ctx.userId : null,
    msgType: input.msgType ?? 'text',
    body: input.body,
    providerMessageId: input.providerMessageId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    status,
    createdAt: now,
    updatedAt: now
  });

  await db
    .update(conversations)
    .set({
      lastMessagePreview: input.body.slice(0, 140),
      lastMessageAt: now,
      unreadCount: input.direction === 'inbound' ? conv.unreadCount + 1 : conv.unreadCount,
      serviceWindowExpiresAt:
        input.direction === 'inbound' ? now + 24 * 60 * 60 * 1000 : conv.serviceWindowExpiresAt,
      updatedAt: now
    })
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, conversationId)));

  const inserted = await db
    .select()
    .from(messages)
    .where(and(eq(messages.organizationId, ctx.organizationId), eq(messages.id, id)))
    .limit(1);
  return inserted[0]!;
}

export async function listConversationMessages(
  db: AppDatabase,
  ctx: OrgContext,
  conversationId: string
) {
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, ctx.organizationId),
        eq(conversations.id, conversationId)
      )
    )
    .limit(1);
  if (convRows.length === 0) {
    throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }

  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.conversationId, conversationId)
      )
    )
    .orderBy(asc(messages.createdAt));
}

export async function updateMessageStatus(
  db: AppDatabase,
  ctx: OrgContext,
  messageId: string,
  input: { status: MessageStatus; providerMessageId?: string | null; errorMessage?: string | null }
) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.organizationId, ctx.organizationId), eq(messages.id, messageId)))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new CrmError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');

  await db
    .update(messages)
    .set({
      status: input.status,
      providerMessageId: input.providerMessageId !== undefined ? input.providerMessageId : existing.providerMessageId,
      errorMessage: input.errorMessage !== undefined ? input.errorMessage : existing.errorMessage,
      updatedAt: Date.now()
    })
    .where(and(eq(messages.organizationId, ctx.organizationId), eq(messages.id, messageId)));

  const updated = await db
    .select()
    .from(messages)
    .where(and(eq(messages.organizationId, ctx.organizationId), eq(messages.id, messageId)))
    .limit(1);
  return updated[0]!;
}

// ============================================================================
// NON-DESTRUCTIVE LEGACY STATE IMPORTER
// ============================================================================

export async function importLegacyStateToOrg(
  db: AppDatabase,
  ctx: OrgContext,
  input: {
    sourceName?: string;
    listName?: string;
    campaignState?: LegacyOrchestratorState | null;
    localStorageState?: LegacyOrchestratorState | null;
    conflictPolicy?: LegacyConflictPolicy;
    dryRun?: boolean;
  }
) {
  const plan = buildLegacyMigrationPlan({
    campaignState: input.campaignState,
    localStorageState: input.localStorageState
  });
  const conflictPolicy: LegacyConflictPolicy = input.conflictPolicy ?? 'skip_existing';
  const dryRun = input.dryRun ?? true;

  const existingContacts = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), isNull(contacts.deletedAt)));
  const existingMap = new Map(existingContacts.map((c) => [c.phone, c]));

  let wouldCreate = 0;
  let wouldUpdate = 0;
  let wouldSkip = 0;
  const conflicts: Array<{ phone: string; existingName: string; incomingName: string; action: string }> = [];

  for (const item of plan.contacts) {
    const existing = existingMap.get(item.phone);
    if (!existing) {
      wouldCreate++;
    } else if (conflictPolicy === 'skip_existing') {
      wouldSkip++;
      conflicts.push({
        phone: item.phone,
        existingName: existing.name,
        incomingName: item.name,
        action: 'skip'
      });
    } else {
      wouldUpdate++;
      conflicts.push({
        phone: item.phone,
        existingName: existing.name,
        incomingName: item.name,
        action: conflictPolicy === 'overwrite_existing' ? 'overwrite' : 'merge_missing'
      });
    }
  }

  if (dryRun) {
    return {
      dryRun: true,
      conflictPolicy,
      sourceChosen: plan.sourceChosen,
      templateText: plan.templateText,
      googleSheetUrl: plan.googleSheetUrl,
      dailyLimit: plan.dailyLimit,
      batchSentCount: plan.batchSentCount,
      summary: {
        totalLegacyContacts: plan.contacts.length,
        invalidContactsCount: plan.invalidContactsCount,
        sentCount: plan.sentCount,
        failedCount: plan.failedCount,
        pendingCount: plan.pendingCount,
        wouldCreate,
        wouldUpdate,
        wouldSkip
      },
      tagsToEnsure: plan.tagsToEnsure,
      conflicts
    };
  }

  const now = Date.now();
  const list = await createContactList(db, ctx, {
    name: input.listName?.trim() || `Legacy Import (${new Date(now).toISOString().slice(0, 10)})`,
    sourceType: 'legacy_import',
    sourceUrl: plan.googleSheetUrl
  });

  // Ensure tags exist
  const orgTags = await listTags(db, ctx);
  const tagMap = new Map(orgTags.map((t) => [t.name.toLowerCase(), t.id]));
  for (const tagName of plan.tagsToEnsure) {
    if (!tagMap.has(tagName.toLowerCase())) {
      const created = await createTag(db, ctx, { name: tagName });
      tagMap.set(tagName.toLowerCase(), created.id);
    }
  }

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const memberIds: string[] = [];

  for (const item of plan.contacts) {
    const existing = existingMap.get(item.phone);
    let contactId: string;

    if (!existing) {
      contactId = crypto.randomUUID();
      await db.insert(contacts).values({
        id: contactId,
        organizationId: ctx.organizationId,
        phone: item.phone,
        rawPhone: item.rawPhone,
        name: item.name,
        email: null,
        company: item.company,
        customAttributesJson: JSON.stringify(item.customVars),
        pipelineStage: item.legacyStatus === 'sent' ? 'contacted' : 'lead',
        source: 'legacy_import',
        deletedAt: null,
        createdAt: now,
        updatedAt: now
      });
      createdCount++;
    } else if (conflictPolicy === 'skip_existing') {
      contactId = existing.id;
      skippedCount++;
    } else if (conflictPolicy === 'merge_missing_fields') {
      contactId = existing.id;
      const existingAttrs = parseJsonObject(existing.customAttributesJson);
      const mergedAttrs = { ...item.customVars, ...existingAttrs };
      await db
        .update(contacts)
        .set({
          name: existing.name === 'Valued Client' && item.name !== 'Valued Client' ? item.name : existing.name,
          company: existing.company ?? item.company,
          customAttributesJson: JSON.stringify(mergedAttrs),
          updatedAt: now
        })
        .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.id, existing.id)));
      updatedCount++;
    } else {
      contactId = existing.id;
      await db
        .update(contacts)
        .set({
          name: item.name,
          company: item.company,
          customAttributesJson: JSON.stringify(item.customVars),
          updatedAt: now
        })
        .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.id, existing.id)));
      updatedCount++;
    }

    memberIds.push(contactId);

    const statusTagName = `legacy:${item.legacyStatus}`;
    for (const tName of ['legacy-import', statusTagName]) {
      const tId = tagMap.get(tName);
      if (tId) {
        await db
          .insert(contactTags)
          .values({ organizationId: ctx.organizationId, contactId, tagId: tId, createdAt: now })
          .onConflictDoNothing();
      }
    }
  }

  if (memberIds.length > 0) {
    await addContactsToList(db, ctx, list.id, memberIds);
  }

  const importId = crypto.randomUUID();
  await db.insert(legacyImports).values({
    id: importId,
    organizationId: ctx.organizationId,
    importedByUserId: ctx.userId,
    sourceName: input.sourceName?.trim() || 'campaign_state.json',
    templateText: plan.templateText,
    googleSheetUrl: plan.googleSheetUrl,
    dailyLimit: plan.dailyLimit,
    batchSentCount: plan.batchSentCount,
    totalContacts: plan.contacts.length,
    importedContacts: createdCount + updatedCount,
    preservedSentCount: plan.sentCount,
    preservedFailedCount: plan.failedCount,
    rawSummaryJson: JSON.stringify({
      sourceChosen: plan.sourceChosen,
      conflictPolicy,
      currentIndex: plan.currentIndex,
      pendingCount: plan.pendingCount,
      skippedCount
    }),
    createdAt: now,
    updatedAt: now
  });

  return {
    dryRun: false,
    importId,
    listId: list.id,
    conflictPolicy,
    sourceChosen: plan.sourceChosen,
    templateText: plan.templateText,
    googleSheetUrl: plan.googleSheetUrl,
    summary: {
      totalLegacyContacts: plan.contacts.length,
      invalidContactsCount: plan.invalidContactsCount,
      sentCount: plan.sentCount,
      failedCount: plan.failedCount,
      pendingCount: plan.pendingCount,
      createdCount,
      updatedCount,
      skippedCount
    }
  };
}
