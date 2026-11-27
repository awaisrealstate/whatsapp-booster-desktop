import { and, desc, eq, gte, lte, or, sql } from 'drizzle-orm';
import type { AppDatabase } from './client.ts';
import {
  campaigns,
  contacts,
  conversations,
  messages,
  organizations,
  users,
  whatsappAccounts
} from './schema.ts';

export interface AnalyticsOverviewOptions {
  organizationId: string;
  fromMs: number;
  toMs: number;
}

export interface AnalyticsOverview {
  periodMs: { from: number; to: number };
  totalMessages: number;
  outboundMessages: number;
  inboundMessages: number;
  deliveredMessages: number;
  readMessages: number;
  failedMessages: number;
  deliveryRate: number;
  readRate: number;
  totalContacts: number;
  newContacts: number;
  totalConversations: number;
  newConversations: number;
  activeCampaigns: number;
  completedCampaigns: number;
}

export async function getAnalyticsOverview(
  db: AppDatabase,
  opts: AnalyticsOverviewOptions
): Promise<AnalyticsOverview> {
  const [msgStats] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      outbound: sql<number>`SUM(CASE WHEN ${messages.direction} = 'outbound' THEN 1 ELSE 0 END)`,
      inbound: sql<number>`SUM(CASE WHEN ${messages.direction} = 'inbound' THEN 1 ELSE 0 END)`,
      delivered: sql<number>`SUM(CASE WHEN ${messages.status} = 'delivered' THEN 1 ELSE 0 END)`,
      readCount: sql<number>`SUM(CASE WHEN ${messages.status} = 'read' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${messages.status} = 'failed' THEN 1 ELSE 0 END)`
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, opts.organizationId),
        gte(messages.createdAt, opts.fromMs),
        lte(messages.createdAt, opts.toMs)
      )
    );

  const [contactStats] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      newCount: sql<number>`SUM(CASE WHEN ${contacts.createdAt} >= ${opts.fromMs} THEN 1 ELSE 0 END)`
    })
    .from(contacts)
    .where(eq(contacts.organizationId, opts.organizationId));

  const [convoStats] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      newCount: sql<number>`SUM(CASE WHEN ${conversations.createdAt} >= ${opts.fromMs} AND ${conversations.createdAt} <= ${opts.toMs} THEN 1 ELSE 0 END)`
    })
    .from(conversations)
    .where(eq(conversations.organizationId, opts.organizationId));

  const [campStats] = await db
    .select({
      active: sql<number>`SUM(CASE WHEN ${campaigns.status} = 'running' OR ${campaigns.status} = 'scheduled' THEN 1 ELSE 0 END)`,
      completed: sql<number>`SUM(CASE WHEN ${campaigns.status} = 'completed' THEN 1 ELSE 0 END)`
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.organizationId, opts.organizationId),
        gte(campaigns.createdAt, opts.fromMs),
        lte(campaigns.createdAt, opts.toMs)
      )
    );

  const total = Number(msgStats?.total ?? 0);
  const outbound = Number(msgStats?.outbound ?? 0);
  const delivered = Number(msgStats?.delivered ?? 0);
  const readCount = Number(msgStats?.readCount ?? 0);

  return {
    periodMs: { from: opts.fromMs, to: opts.toMs },
    totalMessages: total,
    outboundMessages: outbound,
    inboundMessages: Number(msgStats?.inbound ?? 0),
    deliveredMessages: delivered,
    readMessages: readCount,
    failedMessages: Number(msgStats?.failed ?? 0),
    deliveryRate: outbound > 0 ? Math.round((delivered / outbound) * 100) : 0,
    readRate: outbound > 0 ? Math.round((readCount / outbound) * 100) : 0,
    totalContacts: Number(contactStats?.total ?? 0),
    newContacts: Number(contactStats?.newCount ?? 0),
    totalConversations: Number(convoStats?.total ?? 0),
    newConversations: Number(convoStats?.newCount ?? 0),
    activeCampaigns: Number(campStats?.active ?? 0),
    completedCampaigns: Number(campStats?.completed ?? 0)
  };
}

export interface MessageTrendPoint {
  date: string;
  outbound: number;
  inbound: number;
  failed: number;
}

export async function getMessageTrend(
  db: AppDatabase,
  { organizationId, fromMs, toMs }: AnalyticsOverviewOptions
): Promise<MessageTrendPoint[]> {
  try {
    const rows = await db
      .select({
        day: sql<string>`date(${messages.createdAt} / 1000, 'unixepoch')`,
        outbound: sql<number>`SUM(CASE WHEN ${messages.direction} = 'outbound' THEN 1 ELSE 0 END)`,
        inbound: sql<number>`SUM(CASE WHEN ${messages.direction} = 'inbound' THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN ${messages.status} = 'failed' THEN 1 ELSE 0 END)`
      })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, organizationId),
          gte(messages.createdAt, fromMs),
          lte(messages.createdAt, toMs)
        )
      )
      .groupBy(sql`day`)
      .orderBy(sql`day ASC`);

    return (rows ?? []).map((r) => ({
      date: r.day,
      outbound: Number(r.outbound ?? 0),
      inbound: Number(r.inbound ?? 0),
      failed: Number(r.failed ?? 0)
    }));
  } catch {
    return [];
  }
}

export interface PlatformAnalytics {
  totalOrganizations: number;
  totalUsers: number;
  totalMessages: number;
  totalContacts: number;
  totalCampaigns: number;
  activeWhatsappAccounts: number;
  periodMs: { from: number; to: number };
}

export async function getPlatformAnalytics(
  db: AppDatabase,
  { fromMs, toMs }: { fromMs: number; toMs: number }
): Promise<PlatformAnalytics> {
  const [
    [orgs],
    [usersCount],
    [msgs],
    [contactsCount],
    [camps],
    [accounts]
  ] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(organizations),
    db.select({ count: sql<number>`COUNT(*)` }).from(users),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(messages)
      .where(and(gte(messages.createdAt, fromMs), lte(messages.createdAt, toMs))),
    db.select({ count: sql<number>`COUNT(*)` }).from(contacts),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(campaigns)
      .where(and(gte(campaigns.createdAt, fromMs), lte(campaigns.createdAt, toMs))),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(whatsappAccounts)
      .where(eq(whatsappAccounts.connectionStatus, 'connected'))
  ]);

  return {
    totalOrganizations: Number(orgs?.count ?? 0),
    totalUsers: Number(usersCount?.count ?? 0),
    totalMessages: Number(msgs?.count ?? 0),
    totalContacts: Number(contactsCount?.count ?? 0),
    totalCampaigns: Number(camps?.count ?? 0),
    activeWhatsappAccounts: Number(accounts?.count ?? 0),
    periodMs: { from: fromMs, to: toMs }
  };
}
