import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from './client.ts';
import type { OrgContext } from './tenant.ts';
import { scheduledMessages } from './schema.ts';

export interface CreateScheduledMessageInput {
  id: string;
  organizationId: string;
  whatsappAccountId: string;
  createdByUserId: string;
  recipientType: 'contact' | 'list' | 'phones';
  recipientContactIds?: string[] | null;
  recipientListId?: string | null;
  recipientPhones?: string[] | null;
  messageText?: string | null;
  templateId?: string | null;
  templateVariables?: Record<string, string> | null;
  mediaUrl?: string | null;
  mediaType?: 'image' | 'video' | 'document' | 'audio' | null;
  scheduledAt: number;
  timezone?: string;
  idempotencyKey?: string | null;
  recipientCount?: number;
}

export interface UpdateScheduledMessageStatusInput {
  id: string;
  organizationId: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  executedAt?: number | null;
  errorMessage?: string | null;
  providerMessageIds?: string[] | null;
  sentCount?: number;
  failedCount?: number;
}

export async function createScheduledMessage(
  db: AppDatabase,
  input: CreateScheduledMessageInput
) {
  const now = Date.now();
  await db.insert(scheduledMessages).values({
    id: input.id,
    organizationId: input.organizationId,
    whatsappAccountId: input.whatsappAccountId,
    createdByUserId: input.createdByUserId,
    status: 'pending',
    recipientType: input.recipientType,
    recipientContactIds: input.recipientContactIds ? JSON.stringify(input.recipientContactIds) : null,
    recipientListId: input.recipientListId ?? null,
    recipientPhones: input.recipientPhones ? JSON.stringify(input.recipientPhones) : null,
    messageText: input.messageText ?? null,
    templateId: input.templateId ?? null,
    templateVariables: input.templateVariables ? JSON.stringify(input.templateVariables) : null,
    mediaUrl: input.mediaUrl ?? null,
    mediaType: input.mediaType ?? null,
    scheduledAt: input.scheduledAt,
    timezone: input.timezone ?? 'UTC',
    idempotencyKey: input.idempotencyKey ?? null,
    recipientCount: input.recipientCount ?? 0,
    sentCount: 0,
    failedCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return getScheduledMessageById(db, { id: input.id, organizationId: input.organizationId });
}

export async function getScheduledMessageById(
  db: AppDatabase,
  { id, organizationId }: { id: string; organizationId: string }
) {
  const row = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.organizationId, organizationId)))
    .get();
  return row ?? null;
}

export interface ListScheduledMessagesOptions {
  organizationId: string;
  status?: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  limit?: number;
  offset?: number;
}

export async function listScheduledMessages(db: AppDatabase, opts: ListScheduledMessagesOptions) {
  const conditions = [eq(scheduledMessages.organizationId, opts.organizationId)];
  if (opts.status) {
    conditions.push(eq(scheduledMessages.status, opts.status));
  }
  const rows = await db
    .select()
    .from(scheduledMessages)
    .where(and(...conditions))
    .orderBy(desc(scheduledMessages.scheduledAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
    .all();
  return rows;
}

export async function cancelScheduledMessage(
  db: AppDatabase,
  { id, organizationId }: { id: string; organizationId: string }
) {
  await db
    .update(scheduledMessages)
    .set({ status: 'cancelled', updatedAt: Date.now() })
    .where(
      and(
        eq(scheduledMessages.id, id),
        eq(scheduledMessages.organizationId, organizationId),
        eq(scheduledMessages.status, 'pending')
      )
    );
  return getScheduledMessageById(db, { id, organizationId });
}

export async function updateScheduledMessageStatus(
  db: AppDatabase,
  input: UpdateScheduledMessageStatusInput
) {
  const patch: Record<string, unknown> = {
    status: input.status,
    updatedAt: Date.now(),
  };
  if (input.executedAt !== undefined) patch.executedAt = input.executedAt;
  if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage;
  if (input.providerMessageIds !== undefined)
    patch.providerMessageIds = input.providerMessageIds ? JSON.stringify(input.providerMessageIds) : null;
  if (input.sentCount !== undefined) patch.sentCount = input.sentCount;
  if (input.failedCount !== undefined) patch.failedCount = input.failedCount;

  await db
    .update(scheduledMessages)
    .set(patch as Parameters<typeof db.update>[0] extends infer T ? any : never)
    .where(
      and(
        eq(scheduledMessages.id, input.id),
        eq(scheduledMessages.organizationId, input.organizationId)
      )
    );
}

export interface GetScheduledMessagesForExecutionOptions {
  nowMs: number;
  limit?: number;
}

export async function getScheduledMessagesForExecution(
  db: AppDatabase,
  opts: GetScheduledMessagesForExecutionOptions
) {
  const rows = await db
    .select()
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.status, 'pending'),
        lte(scheduledMessages.scheduledAt, opts.nowMs)
      )
    )
    .orderBy(asc(scheduledMessages.scheduledAt))
    .limit(opts.limit ?? 50)
    .all();
  return rows;
}
