import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import type { AppDatabase } from './client.ts';
import { CrmError } from './crm.ts';
import { getPlanDefinition, PLAN_CATALOG, type PlanTier } from './plans.ts';
import type { OrgContext } from './tenant.ts';
import {
  auditLogs,
  campaigns,
  contacts,
  knowledgeDocs,
  organizationMembers,
  organizations,
  subscriptions,
  usageCounters,
  whatsappAccounts,
  type SubscriptionStatus
} from './schema.ts';

function getMonthPrefix(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function getDayKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export async function recordAuditLog(
  db: AppDatabase,
  params: {
    organizationId: string;
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  }
) {
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    organizationId: params.organizationId,
    actorUserId: params.actorUserId ?? null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    metadataJson: JSON.stringify(params.metadata ?? {}),
    ipAddress: params.ipAddress ?? null,
    createdAt: Date.now()
  });
}

export async function listAuditLogs(db: AppDatabase, ctx: OrgContext, limit = 50) {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, ctx.organizationId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(safeLimit);

  return rows.map((r) => ({
    ...r,
    metadata: (() => {
      try {
        return JSON.parse(r.metadataJson);
      } catch {
        return {};
      }
    })()
  }));
}

export async function ensureOrganizationSubscription(db: AppDatabase, organizationId: string) {
  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);
  if (existing[0]) return existing[0];

  const orgRows = await db
    .select({ planTier: organizations.planTier })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const now = Date.now();
  const id = crypto.randomUUID();
  const tier: PlanTier = orgRows[0]?.planTier ?? 'free';
  await db
    .insert(subscriptions)
    .values({
      id,
      organizationId,
      planTier: tier,
      status: 'active',
      billingProvider: 'manual',
      currentPeriodStart: now,
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: 0,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);
  return rows[0]!;
}

export async function getOrganizationSubscriptionAndUsage(
  db: AppDatabase,
  ctx: OrgContext,
  nowMs = Date.now()
) {
  const subscription = await ensureOrganizationSubscription(db, ctx.organizationId);
  const plan = getPlanDefinition(subscription.planTier);
  const dayKey = getDayKey(nowMs);
  const monthPrefix = `${getMonthPrefix(nowMs)}%`;

  const [
    contactCountRow,
    campaignCountRow,
    docCountRow,
    memberCountRow,
    waAccountCountRow,
    dayUsageRow,
    monthMsgRow
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(and(eq(contacts.organizationId, ctx.organizationId), isNull(contacts.deletedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, ctx.organizationId), isNull(campaigns.deletedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.organizationId, ctx.organizationId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, ctx.organizationId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappAccounts)
      .where(eq(whatsappAccounts.organizationId, ctx.organizationId)),
    db
      .select({
        outboundMessages: usageCounters.outboundMessages,
        aiReplies: usageCounters.aiReplies,
        aiNeuronsEst: usageCounters.aiNeuronsEst
      })
      .from(usageCounters)
      .where(
        and(eq(usageCounters.organizationId, ctx.organizationId), eq(usageCounters.periodKey, dayKey))
      )
      .limit(1),
    db
      .select({ total: sql<number>`coalesce(sum(${usageCounters.outboundMessages}), 0)` })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.organizationId, ctx.organizationId),
          like(usageCounters.periodKey, monthPrefix)
        )
      )
  ]);

  return {
    subscription: {
      ...subscription,
      cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd)
    },
    plan,
    catalog: Object.values(PLAN_CATALOG),
    billingReady: false,
    billingNotice:
      'Billing is running in manual/admin plan-assignment mode. External payment gateway checkout is intentionally disabled until explicitly approved.',
    usage: {
      contactsCount: Number(contactCountRow[0]?.count ?? 0),
      campaignsCount: Number(campaignCountRow[0]?.count ?? 0),
      knowledgeDocsCount: Number(docCountRow[0]?.count ?? 0),
      teamMembersCount: Number(memberCountRow[0]?.count ?? 0),
      whatsappAccountsCount: Number(waAccountCountRow[0]?.count ?? 0),
      todayOutboundMessages: Number(dayUsageRow[0]?.outboundMessages ?? 0),
      todayAiReplies: Number(dayUsageRow[0]?.aiReplies ?? 0),
      todayAiNeuronsEst: Number(dayUsageRow[0]?.aiNeuronsEst ?? 0),
      monthlyOutboundMessages: Number(monthMsgRow[0]?.total ?? 0)
    }
  };
}

export async function enforcePlanLimit(
  db: AppDatabase,
  ctx: OrgContext,
  metric:
    | 'contacts'
    | 'campaigns'
    | 'knowledgeDocs'
    | 'teamMembers'
    | 'whatsappAccounts'
    | 'monthlyMessages'
    | 'dailyAiReplies',
  delta = 1
) {
  const { plan, usage } = await getOrganizationSubscriptionAndUsage(db, ctx);

  if (metric === 'whatsappAccounts' && usage.whatsappAccountsCount + delta > plan.maxWhatsappAccounts) {
    throw new CrmError(
      402,
      'PLAN_WHATSAPP_ACCOUNT_LIMIT',
      `${plan.displayName} plan allows up to ${plan.maxWhatsappAccounts} WhatsApp account(s). Upgrade plan for multiple WhatsApp connections.`
    );
  }

  if (metric === 'contacts' && usage.contactsCount + delta > plan.maxContacts) {
    throw new CrmError(
      402,
      'PLAN_CONTACT_LIMIT',
      `${plan.displayName} plan limit reached (${plan.maxContacts} contacts max).`
    );
  }
  if (metric === 'campaigns' && usage.campaignsCount + delta > plan.maxCampaigns) {
    throw new CrmError(
      402,
      'PLAN_CAMPAIGN_LIMIT',
      `${plan.displayName} plan limit reached (${plan.maxCampaigns} campaigns max).`
    );
  }
  if (metric === 'knowledgeDocs' && usage.knowledgeDocsCount + delta > plan.maxKnowledgeDocs) {
    throw new CrmError(
      402,
      'PLAN_KNOWLEDGE_LIMIT',
      `${plan.displayName} plan limit reached (${plan.maxKnowledgeDocs} knowledge docs max).`
    );
  }
  if (metric === 'teamMembers' && usage.teamMembersCount + delta > plan.maxTeamMembers) {
    throw new CrmError(
      402,
      'PLAN_MEMBER_LIMIT',
      `${plan.displayName} plan limit reached (${plan.maxTeamMembers} team members max).`
    );
  }
  if (metric === 'monthlyMessages' && usage.monthlyOutboundMessages + delta > plan.monthlyOutboundMessages) {
    throw new CrmError(
      402,
      'PLAN_MESSAGE_LIMIT',
      `${plan.displayName} plan monthly outbound message limit reached (${plan.monthlyOutboundMessages}/month).`
    );
  }
  if (metric === 'dailyAiReplies' && usage.todayAiReplies + delta > plan.dailyAiReplies) {
    throw new CrmError(
      402,
      'PLAN_AI_LIMIT',
      `${plan.displayName} plan daily AI reply limit reached (${plan.dailyAiReplies}/day).`
    );
  }
}

export async function updateOrganizationPlanManual(
  db: AppDatabase,
  ctx: OrgContext,
  input: { planTier: PlanTier }
) {
  await ensureOrganizationSubscription(db, ctx.organizationId);
  const now = Date.now();

  await db
    .update(subscriptions)
    .set({
      planTier: input.planTier,
      billingProvider: 'manual',
      updatedAt: now
    })
    .where(eq(subscriptions.organizationId, ctx.organizationId));

  await db
    .update(organizations)
    .set({ planTier: input.planTier, updatedAt: now })
    .where(eq(organizations.id, ctx.organizationId));

  await recordAuditLog(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'subscription.plan_updated_manual',
    entityType: 'subscription',
    entityId: ctx.organizationId,
    metadata: { planTier: input.planTier, billingProvider: 'manual' }
  });

  return getOrganizationSubscriptionAndUsage(db, ctx);
}

export async function updateOrganizationSettings(
  db: AppDatabase,
  ctx: OrgContext,
  patch: {
    name?: string;
    defaultCountryCode?: string;
    timezone?: string;
  }
) {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new CrmError(404, 'ORG_NOT_FOUND', 'Organization not found.');

  const now = Date.now();
  await db
    .update(organizations)
    .set({
      name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
      defaultCountryCode:
        patch.defaultCountryCode !== undefined ? patch.defaultCountryCode.trim() : existing.defaultCountryCode,
      timezone: patch.timezone !== undefined ? patch.timezone.trim() : existing.timezone,
      updatedAt: now
    })
    .where(eq(organizations.id, ctx.organizationId));

  await recordAuditLog(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'organization.settings_updated',
    entityType: 'organization',
    entityId: ctx.organizationId
  });

  const updated = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  return updated[0]!;
}

/**
 * Platform Owner Admin: returns non-secret organization & subscription health metrics.
 * Never returns customer WhatsApp credentials, tokens, QR payloads, contacts, or message contents.
 */
export async function listOrganizationsForPlatformAdmin(db: AppDatabase) {
  const [orgs, subs, waStats, memberStats] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        planTier: organizations.planTier,
        createdAt: organizations.createdAt
      })
      .from(organizations)
      .orderBy(desc(organizations.createdAt)),
    db
      .select({
        organizationId: subscriptions.organizationId,
        planTier: subscriptions.planTier,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd
      })
      .from(subscriptions),
    db
      .select({
        organizationId: whatsappAccounts.organizationId,
        connectionStatus: whatsappAccounts.connectionStatus,
        providerType: whatsappAccounts.providerType
      })
      .from(whatsappAccounts),
    db
      .select({
        organizationId: organizationMembers.organizationId,
        count: sql<number>`count(*)`
      })
      .from(organizationMembers)
      .groupBy(organizationMembers.organizationId)
  ]);

  const subByOrg = new Map(subs.map((s) => [s.organizationId, s]));
  const membersByOrg = new Map(memberStats.map((m) => [m.organizationId, Number(m.count)]));
  const waByOrg = new Map<string, { total: number; connected: number }>();

  for (const w of waStats) {
    const cur = waByOrg.get(w.organizationId) ?? { total: 0, connected: 0 };
    cur.total += 1;
    if (w.connectionStatus === 'connected') cur.connected += 1;
    waByOrg.set(w.organizationId, cur);
  }

  return orgs.map((org) => {
    const sub = subByOrg.get(org.id);
    const wa = waByOrg.get(org.id) ?? { total: 0, connected: 0 };
    return {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      planTier: sub?.planTier ?? org.planTier,
      subscriptionStatus: sub?.status ?? 'active',
      memberCount: membersByOrg.get(org.id) ?? 0,
      whatsappAccountsCount: wa.total,
      connectedWhatsappAccountsCount: wa.connected,
      createdAt: org.createdAt
    };
  });
}

/**
 * Platform Owner Admin: updates a customer organization's subscription tier/status strictly
 * without accessing, altering, or merging customer WhatsApp sessions.
 */
export async function adminUpdateCustomerOrganizationPlan(
  db: AppDatabase,
  input: {
    actorUserId: string;
    targetOrganizationId: string;
    planTier: PlanTier;
    status?: SubscriptionStatus;
  }
) {
  const orgRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, input.targetOrganizationId))
    .limit(1);
  if (!orgRows[0]) {
    throw new CrmError(404, 'ORG_NOT_FOUND', 'Customer organization not found.');
  }

  await ensureOrganizationSubscription(db, input.targetOrganizationId);
  const now = Date.now();

  await db
    .update(subscriptions)
    .set({
      planTier: input.planTier,
      status: input.status ?? 'active',
      billingProvider: 'manual',
      updatedAt: now
    })
    .where(eq(subscriptions.organizationId, input.targetOrganizationId));

  await db
    .update(organizations)
    .set({ planTier: input.planTier, updatedAt: now })
    .where(eq(organizations.id, input.targetOrganizationId));

  await recordAuditLog(db, {
    organizationId: input.targetOrganizationId,
    actorUserId: input.actorUserId,
    action: 'platform_admin.subscription_updated',
    entityType: 'subscription',
    entityId: input.targetOrganizationId,
    metadata: { planTier: input.planTier, status: input.status ?? 'active' }
  });

  return {
    organizationId: input.targetOrganizationId,
    planTier: input.planTier,
    status: input.status ?? 'active',
    plan: getPlanDefinition(input.planTier)
  };
}
