import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from './client.ts';
import type { OrgContext } from './tenant.ts';
import { waStatusRecords } from './schema.ts';

export interface CreateWaStatusInput {
  id: string;
  organizationId: string;
  whatsappAccountId: string;
  contentType: 'text' | 'image' | 'video' | 'document';
  contentText?: string | null;
  mediaUrl?: string | null;
  mediaCaption?: string | null;
  backgroundColor?: string | null;
  font?: string | null;
  scheduledAt?: number | null;
}

export async function createWaStatus(db: AppDatabase, input: CreateWaStatusInput) {
  const now = Date.now();
  await db.insert(waStatusRecords).values({
    id: input.id,
    organizationId: input.organizationId,
    whatsappAccountId: input.whatsappAccountId,
    providerType: 'unofficial_bridge',
    contentType: input.contentType,
    contentText: input.contentText ?? null,
    mediaUrl: input.mediaUrl ?? null,
    mediaCaption: input.mediaCaption ?? null,
    backgroundColor: input.backgroundColor ?? null,
    font: input.font ?? null,
    status: input.scheduledAt ? 'scheduled' : 'draft',
    scheduledAt: input.scheduledAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return getWaStatusById(db, { id: input.id, organizationId: input.organizationId });
}

export async function getWaStatusById(
  db: AppDatabase,
  { id, organizationId }: { id: string; organizationId: string }
) {
  return (
    (await db
      .select()
      .from(waStatusRecords)
      .where(and(eq(waStatusRecords.id, id), eq(waStatusRecords.organizationId, organizationId)))
      .get()) ?? null
  );
}

export async function listWaStatuses(
  db: AppDatabase,
  { organizationId, limit = 50, offset = 0 }: { organizationId: string; limit?: number; offset?: number }
) {
  return db
    .select()
    .from(waStatusRecords)
    .where(eq(waStatusRecords.organizationId, organizationId))
    .orderBy(desc(waStatusRecords.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
}

export async function updateWaStatusRecord(
  db: AppDatabase,
  {
    id,
    organizationId,
    status,
    publishedAt,
    errorMessage,
    providerResponse,
  }: {
    id: string;
    organizationId: string;
    status: 'draft' | 'publishing' | 'published' | 'failed' | 'scheduled';
    publishedAt?: number | null;
    errorMessage?: string | null;
    providerResponse?: string | null;
  }
) {
  await db
    .update(waStatusRecords)
    .set({ status, publishedAt, errorMessage, providerResponse, updatedAt: Date.now() })
    .where(and(eq(waStatusRecords.id, id), eq(waStatusRecords.organizationId, organizationId)));
}

export async function deleteWaStatus(
  db: AppDatabase,
  { id, organizationId }: { id: string; organizationId: string }
) {
  await db
    .delete(waStatusRecords)
    .where(and(eq(waStatusRecords.id, id), eq(waStatusRecords.organizationId, organizationId)));
}
