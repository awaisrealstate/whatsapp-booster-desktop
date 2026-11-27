import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { AppDatabase } from './client.ts';
import { aiBusinessRecommendations, messages } from './schema.ts';

export interface CreateAiRecommendationInput {
  id: string;
  organizationId: string;
  targetOrgId?: string | null;
  generatedBy: 'system' | 'admin';
  category: 'retention' | 'engagement' | 'campaign' | 'usage' | 'billing' | 'general';
  riskLevel?: 'low' | 'medium' | 'high' | null;
  title: string;
  evidence: Record<string, unknown>;
  dateRangeStart?: number | null;
  dateRangeEnd?: number | null;
  recommendation: string;
  suggestedAction?: string | null;
  confidence?: 'low' | 'medium' | 'high' | null;
  isPrediction?: boolean;
}

export async function createAiRecommendation(db: AppDatabase, input: CreateAiRecommendationInput) {
  const now = Date.now();
  await db.insert(aiBusinessRecommendations).values({
    id: input.id,
    organizationId: input.organizationId,
    targetOrgId: input.targetOrgId ?? null,
    generatedBy: input.generatedBy,
    category: input.category,
    riskLevel: input.riskLevel ?? null,
    title: input.title,
    evidence: JSON.stringify(input.evidence),
    dateRangeStart: input.dateRangeStart ?? null,
    dateRangeEnd: input.dateRangeEnd ?? null,
    recommendation: input.recommendation,
    suggestedAction: input.suggestedAction ?? null,
    confidence: input.confidence ?? null,
    isPrediction: input.isPrediction ? 1 : 0,
    createdAt: now,
  });
  return getAiRecommendationById(db, { id: input.id, organizationId: input.organizationId });
}

export async function getAiRecommendationById(
  db: AppDatabase,
  { id, organizationId }: { id: string; organizationId: string }
) {
  return (
    (await db
      .select()
      .from(aiBusinessRecommendations)
      .where(
        and(
          eq(aiBusinessRecommendations.id, id),
          eq(aiBusinessRecommendations.organizationId, organizationId)
        )
      )
      .get()) ?? null
  );
}

export async function listAiRecommendations(
  db: AppDatabase,
  {
    organizationId,
    targetOrgId,
    limit = 20,
    offset = 0,
  }: {
    organizationId: string;
    targetOrgId?: string | null;
    limit?: number;
    offset?: number;
  }
) {
  const conditions = [eq(aiBusinessRecommendations.organizationId, organizationId)];
  if (targetOrgId) {
    conditions.push(eq(aiBusinessRecommendations.targetOrgId, targetOrgId));
  }
  return db
    .select()
    .from(aiBusinessRecommendations)
    .where(and(...conditions))
    .orderBy(desc(aiBusinessRecommendations.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
}

export async function dismissAiRecommendation(
  db: AppDatabase,
  { id, organizationId }: { id: string; organizationId: string }
) {
  await db
    .update(aiBusinessRecommendations)
    .set({ dismissedAt: Date.now() })
    .where(
      and(
        eq(aiBusinessRecommendations.id, id),
        eq(aiBusinessRecommendations.organizationId, organizationId)
      )
    );
}

/** Generate rule-based recommendations from usage data (no external AI required). */
export async function generateRuleBasedRecommendations(
  db: AppDatabase,
  { organizationId, nowMs }: { organizationId: string; nowMs: number }
): Promise<CreateAiRecommendationInput[]> {
  const recs: CreateAiRecommendationInput[] = [];
  const thirtyDaysAgo = nowMs - 30 * 24 * 60 * 60 * 1000;

  // Check message activity in last 30 days
  const [msgResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), gte(messages.createdAt, thirtyDaysAgo)));

  const msgCount = Number(msgResult?.count ?? 0);

  if (msgCount < 10) {
    recs.push({
      id: `rec_${organizationId}_low_activity_${nowMs}`,
      organizationId,
      generatedBy: 'system',
      category: 'engagement',
      riskLevel: 'medium',
      title: 'Low messaging activity detected',
      evidence: { messages_last_30_days: msgCount },
      dateRangeStart: thirtyDaysAgo,
      dateRangeEnd: nowMs,
      recommendation:
        'Your team has sent fewer than 10 messages in the last 30 days. Consider creating a re-engagement campaign to reconnect with your contacts.',
      suggestedAction: 'Go to Campaigns → Create Campaign → Select your contact list.',
      confidence: 'high',
      isPrediction: false,
    });
  }

  return recs;
}

export async function getPlatformHighRiskRecommendations(db: AppDatabase) {
  return db
    .select({
      id: aiBusinessRecommendations.id,
      organizationId: aiBusinessRecommendations.organizationId,
      category: aiBusinessRecommendations.category,
      riskLevel: aiBusinessRecommendations.riskLevel,
      title: aiBusinessRecommendations.title,
      recommendation: aiBusinessRecommendations.recommendation,
      suggestedAction: aiBusinessRecommendations.suggestedAction,
      confidence: aiBusinessRecommendations.confidence,
      createdAt: aiBusinessRecommendations.createdAt
    })
    .from(aiBusinessRecommendations)
    .where(or(eq(aiBusinessRecommendations.riskLevel, 'high'), eq(aiBusinessRecommendations.riskLevel, 'medium')))
    .orderBy(desc(aiBusinessRecommendations.createdAt))
    .limit(100);
}
