import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { AppDatabase } from './client.ts';
import type { OrgContext } from './tenant.ts';
import { CrmError } from './crm.ts';
import { recordAuditLog } from './saas.ts';
import {
  conversations,
  conversationAssignmentHistory,
  users,
  contacts,
  organizationMembers,
  type ConversationAssignmentType,
  type ConversationHandlingStatus,
  type ConversationStatus
} from './schema.ts';

export interface AssignConversationInput {
  conversationId: string;
  handlerType: 'team_member' | 'owner' | 'ai';
  targetUserId?: string | null;
  reason?: string | null;
}

export interface TakeoverInput {
  conversationId: string;
  reason?: string | null;
}

export interface ReturnToAiInput {
  conversationId: string;
  reason?: string | null;
}

export interface UpdateConversationStatusInput {
  conversationId: string;
  handlingStatus?: ConversationHandlingStatus;
  status?: ConversationStatus;
  reason?: string | null;
}

export async function getConversationById(
  db: AppDatabase,
  ctx: OrgContext,
  conversationId: string
) {
  const rows = await db
    .select({
      id: conversations.id,
      organizationId: conversations.organizationId,
      contactId: conversations.contactId,
      channelType: conversations.channelType,
      status: conversations.status,
      handlingStatus: conversations.handlingStatus,
      assignmentType: conversations.assignmentType,
      assignedUserId: conversations.assignedUserId,
      whatsappAccountId: conversations.whatsappAccountId,
      handlerMode: conversations.handlerMode,
      handoffReason: conversations.handoffReason,
      serviceWindowExpiresAt: conversations.serviceWindowExpiresAt,
      unreadCount: conversations.unreadCount,
      lastMessagePreview: conversations.lastMessagePreview,
      lastMessageAt: conversations.lastMessageAt,
      remoteJid: conversations.remoteJid,
      isGroup: conversations.isGroup,
      groupSubject: conversations.groupSubject,
      profilePictureUrl: conversations.profilePictureUrl,
      syncStatus: conversations.syncStatus,
      lastSyncedAt: conversations.lastSyncedAt,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      assignedUserName: users.name,
      assignedUserEmail: users.email
    })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .leftJoin(users, eq(conversations.assignedUserId, users.id))
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, conversationId)))
    .limit(1);

  return rows[0] ?? null;
}

export async function assignConversation(
  db: AppDatabase,
  ctx: OrgContext,
  input: AssignConversationInput
) {
  const now = Date.now();
  const conv = await getConversationById(db, ctx, input.conversationId);
  if (!conv) {
    throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }

  // Permission rule: If conversation is assigned to Owner, regular team members cannot take over without owner/admin role
  if (conv.assignmentType === 'owner' && ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new CrmError(
      403,
      'PERMISSION_DENIED',
      'This conversation is assigned to the Business Owner. Only the owner or an admin can reassign it.'
    );
  }

  let newHandlerType: ConversationAssignmentType = input.handlerType;
  let newHandlingStatus: ConversationHandlingStatus = 'unassigned';
  let newAssignedUserId: string | null = null;
  let newHandlerMode: 'human' | 'ai_bot' = 'human';

  if (input.handlerType === 'ai') {
    newHandlerType = 'ai';
    newHandlingStatus = 'ai_handling';
    newAssignedUserId = null;
    newHandlerMode = 'ai_bot';
  } else if (input.handlerType === 'owner') {
    newHandlerType = 'owner';
    newHandlingStatus = 'assigned_owner';
    newHandlerMode = 'human';

    // Find the organization's owner user ID
    if (ctx.role === 'owner') {
      newAssignedUserId = ctx.userId;
    } else {
      const ownerRow = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, ctx.organizationId),
            eq(organizationMembers.role, 'owner')
          )
        )
        .limit(1);
      newAssignedUserId = ownerRow[0]?.userId ?? ctx.userId;
    }
  } else if (input.handlerType === 'team_member') {
    newHandlerType = 'team_member';
    newHandlingStatus = 'assigned_team';
    newHandlerMode = 'human';
    newAssignedUserId = input.targetUserId ?? ctx.userId;
  }

  // Update conversation record
  await db
    .update(conversations)
    .set({
      assignmentType: newHandlerType,
      handlingStatus: newHandlingStatus,
      assignedUserId: newAssignedUserId,
      handlerMode: newHandlerMode,
      handoffReason: input.handlerType === 'ai' ? null : conv.handoffReason,
      updatedAt: now
    })
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, input.conversationId)));

  // Record assignment history
  const historyId = `cah_${crypto.randomUUID().replace(/-/g, '')}`;
  await db.insert(conversationAssignmentHistory).values({
    id: historyId,
    organizationId: ctx.organizationId,
    conversationId: input.conversationId,
    previousHandlerType: conv.assignmentType,
    previousUserId: conv.assignedUserId,
    newHandlerType,
    newUserId: newAssignedUserId,
    changedByUserId: ctx.userId,
    reason: input.reason?.trim() || (input.handlerType === 'ai' ? 'Handover to AI Chatbot' : 'Assigned to human operator'),
    createdAt: now
  });

  // Audit log
  await recordAuditLog(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'conversation.assignment_changed',
    entityType: 'conversation',
    entityId: input.conversationId,
    metadata: {
      previousHandlerType: conv.assignmentType,
      newHandlerType,
      assignedUserId: newAssignedUserId,
      reason: input.reason
    }
  });

  return getConversationById(db, ctx, input.conversationId);
}

export async function takeOverConversationFromAi(
  db: AppDatabase,
  ctx: OrgContext,
  input: TakeoverInput
) {
  const handlerType: 'owner' | 'team_member' = ctx.role === 'owner' ? 'owner' : 'team_member';
  const updated = await assignConversation(db, ctx, {
    conversationId: input.conversationId,
    handlerType,
    targetUserId: ctx.userId,
    reason: input.reason || 'Human takeover from AI'
  });

  // Explicitly set handling status to human_handling
  if (updated) {
    await db
      .update(conversations)
      .set({
        handlingStatus: 'human_handling',
        updatedAt: Date.now()
      })
      .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, input.conversationId)));
  }

  return getConversationById(db, ctx, input.conversationId);
}

export async function returnConversationToAi(
  db: AppDatabase,
  ctx: OrgContext,
  input: ReturnToAiInput
) {
  return assignConversation(db, ctx, {
    conversationId: input.conversationId,
    handlerType: 'ai',
    reason: input.reason || 'Returned to AI Chatbot'
  });
}

export async function updateConversationHandlingStatus(
  db: AppDatabase,
  ctx: OrgContext,
  input: UpdateConversationStatusInput
) {
  const conv = await getConversationById(db, ctx, input.conversationId);
  if (!conv) {
    throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.handlingStatus) patch.handlingStatus = input.handlingStatus;
  if (input.status) patch.status = input.status;

  await db
    .update(conversations)
    .set(patch as any)
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, input.conversationId)));

  if (input.handlingStatus && input.handlingStatus !== conv.handlingStatus) {
    const historyId = `cah_${crypto.randomUUID().replace(/-/g, '')}`;
    await db.insert(conversationAssignmentHistory).values({
      id: historyId,
      organizationId: ctx.organizationId,
      conversationId: input.conversationId,
      previousHandlerType: conv.assignmentType,
      previousUserId: conv.assignedUserId,
      newHandlerType: conv.assignmentType,
      newUserId: conv.assignedUserId,
      changedByUserId: ctx.userId,
      reason: input.reason || `Status changed to ${input.handlingStatus}`,
      createdAt: Date.now()
    });
  }

  return getConversationById(db, ctx, input.conversationId);
}

export async function listConversationAssignmentHistory(
  db: AppDatabase,
  ctx: OrgContext,
  conversationId: string
) {
  // Ensure conversation belongs to organization
  const conv = await getConversationById(db, ctx, conversationId);
  if (!conv) {
    throw new CrmError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }

  const rows = await db
    .select({
      id: conversationAssignmentHistory.id,
      conversationId: conversationAssignmentHistory.conversationId,
      previousHandlerType: conversationAssignmentHistory.previousHandlerType,
      previousUserId: conversationAssignmentHistory.previousUserId,
      newHandlerType: conversationAssignmentHistory.newHandlerType,
      newUserId: conversationAssignmentHistory.newUserId,
      changedByUserId: conversationAssignmentHistory.changedByUserId,
      reason: conversationAssignmentHistory.reason,
      createdAt: conversationAssignmentHistory.createdAt
    })
    .from(conversationAssignmentHistory)
    .where(
      and(
        eq(conversationAssignmentHistory.organizationId, ctx.organizationId),
        eq(conversationAssignmentHistory.conversationId, conversationId)
      )
    )
    .orderBy(desc(conversationAssignmentHistory.createdAt))
    .limit(50);

  // Collect user IDs to fetch names
  const userIds = new Set<string>();
  for (const r of rows) {
    if (r.previousUserId) userIds.add(r.previousUserId);
    if (r.newUserId) userIds.add(r.newUserId);
    if (r.changedByUserId) userIds.add(r.changedByUserId);
  }

  const userMap = new Map<string, { name: string; email: string }>();
  if (userIds.size > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, Array.from(userIds)));
    for (const u of userRows) {
      userMap.set(u.id, { name: u.name, email: u.email });
    }
  }

  return rows.map((r) => ({
    ...r,
    previousUserName: r.previousUserId ? userMap.get(r.previousUserId)?.name ?? null : null,
    newUserName: r.newUserId ? userMap.get(r.newUserId)?.name ?? null : null,
    changedByUserName: r.changedByUserId ? userMap.get(r.changedByUserId)?.name ?? null : null
  }));
}

export interface ListFilteredConversationsParams {
  filter?: 'all' | 'my' | 'owner' | 'ai' | 'human' | 'unassigned' | 'needs_attention' | 'resolved' | 'unread' | 'groups' | 'archived';
  search?: string;
  status?: ConversationStatus;
  limit?: number;
  offset?: number;
}

export async function listFilteredConversations(
  db: AppDatabase,
  ctx: OrgContext,
  params: ListFilteredConversationsParams = {}
) {
  const conditions = [eq(conversations.organizationId, ctx.organizationId)];

  if (params.status) {
    conditions.push(eq(conversations.status, params.status));
  }

  // Handler/Assignment and category filter
  if (params.filter === 'my') {
    conditions.push(eq(conversations.assignedUserId, ctx.userId));
  } else if (params.filter === 'owner') {
    conditions.push(
      or(
        eq(conversations.assignmentType, 'owner'),
        eq(conversations.handlingStatus, 'assigned_owner')
      )!
    );
  } else if (params.filter === 'ai') {
    conditions.push(
      or(
        eq(conversations.assignmentType, 'ai'),
        eq(conversations.handlerMode, 'ai_bot'),
        eq(conversations.handlingStatus, 'ai_handling')
      )!
    );
  } else if (params.filter === 'human') {
    conditions.push(
      or(
        eq(conversations.handlerMode, 'human'),
        eq(conversations.handlingStatus, 'human_handling'),
        eq(conversations.assignmentType, 'team_member'),
        eq(conversations.assignmentType, 'owner')
      )!
    );
  } else if (params.filter === 'unassigned') {
    conditions.push(
      or(
        eq(conversations.assignmentType, 'unassigned'),
        eq(conversations.handlingStatus, 'unassigned')
      )!
    );
  } else if (params.filter === 'needs_attention') {
    conditions.push(eq(conversations.handlingStatus, 'needs_attention'));
  } else if (params.filter === 'resolved') {
    conditions.push(
      or(
        eq(conversations.status, 'resolved'),
        eq(conversations.handlingStatus, 'resolved')
      )!
    );
  } else if (params.filter === 'unread') {
    conditions.push(sql`${conversations.unreadCount} > 0`);
  } else if (params.filter === 'groups') {
    conditions.push(eq(conversations.isGroup, 1));
  } else if (params.filter === 'archived') {
    conditions.push(eq(conversations.status, 'archived'));
  }

  const rows = await db
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      channelType: conversations.channelType,
      status: conversations.status,
      handlingStatus: conversations.handlingStatus,
      assignmentType: conversations.assignmentType,
      assignedUserId: conversations.assignedUserId,
      assignedUserName: users.name,
      assignedUserEmail: users.email,
      handlerMode: conversations.handlerMode,
      handoffReason: conversations.handoffReason,
      unreadCount: conversations.unreadCount,
      lastMessagePreview: conversations.lastMessagePreview,
      lastMessageAt: conversations.lastMessageAt,
      remoteJid: conversations.remoteJid,
      isGroup: conversations.isGroup,
      groupSubject: conversations.groupSubject,
      profilePictureUrl: conversations.profilePictureUrl,
      syncStatus: conversations.syncStatus,
      lastSyncedAt: conversations.lastSyncedAt,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt
    })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .leftJoin(users, eq(conversations.assignedUserId, users.id))
    .where(and(...conditions))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.updatedAt))
    .limit(params.limit ?? 50)
    .offset(params.offset ?? 0);

  if (params.search && params.search.trim()) {
    const q = params.search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (r.contactName && r.contactName.toLowerCase().includes(q)) ||
        (r.contactPhone && r.contactPhone.includes(q)) ||
        (r.groupSubject && r.groupSubject.toLowerCase().includes(q))
    );
  }

  return rows;
}

export async function getConversationMetricsForOrg(db: AppDatabase, ctx: OrgContext) {
  const result = await db
    .select({
      total: sql<number>`COUNT(*)`,
      aiHandled: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'ai' OR ${conversations.handlerMode} = 'ai_bot' THEN 1 ELSE 0 END)`,
      ownerHandled: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'owner' THEN 1 ELSE 0 END)`,
      teamHandled: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'team_member' THEN 1 ELSE 0 END)`,
      unassigned: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'unassigned' AND ${conversations.handlerMode} != 'ai_bot' THEN 1 ELSE 0 END)`,
      needsAttention: sql<number>`SUM(CASE WHEN ${conversations.handlingStatus} = 'needs_attention' THEN 1 ELSE 0 END)`,
      resolved: sql<number>`SUM(CASE WHEN ${conversations.status} = 'resolved' OR ${conversations.handlingStatus} = 'resolved' THEN 1 ELSE 0 END)`
    })
    .from(conversations)
    .where(eq(conversations.organizationId, ctx.organizationId));

  const row = result[0];
  return {
    total: Number(row?.total ?? 0),
    aiHandled: Number(row?.aiHandled ?? 0),
    ownerHandled: Number(row?.ownerHandled ?? 0),
    teamHandled: Number(row?.teamHandled ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
    needsAttention: Number(row?.needsAttention ?? 0),
    resolved: Number(row?.resolved ?? 0)
  };
}

export async function getPlatformAdminConversationsOverview(db: AppDatabase) {
  const metrics = await db
    .select({
      total: sql<number>`COUNT(*)`,
      aiHandled: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'ai' OR ${conversations.handlerMode} = 'ai_bot' THEN 1 ELSE 0 END)`,
      ownerHandled: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'owner' THEN 1 ELSE 0 END)`,
      teamHandled: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'team_member' THEN 1 ELSE 0 END)`,
      unassigned: sql<number>`SUM(CASE WHEN ${conversations.assignmentType} = 'unassigned' AND ${conversations.handlerMode} != 'ai_bot' THEN 1 ELSE 0 END)`,
      needsAttention: sql<number>`SUM(CASE WHEN ${conversations.handlingStatus} = 'needs_attention' THEN 1 ELSE 0 END)`
    })
    .from(conversations);

  const escalations = await db
    .select()
    .from(conversationAssignmentHistory)
    .where(sql`${conversationAssignmentHistory.reason} LIKE 'AI Escalation%'`)
    .orderBy(desc(conversationAssignmentHistory.createdAt))
    .limit(20);

  const row = metrics[0];
  return {
    metrics: {
      total: Number(row?.total ?? 0),
      aiHandled: Number(row?.aiHandled ?? 0),
      ownerHandled: Number(row?.ownerHandled ?? 0),
      teamHandled: Number(row?.teamHandled ?? 0),
      unassigned: Number(row?.unassigned ?? 0),
      needsAttention: Number(row?.needsAttention ?? 0)
    },
    escalations
  };
}
