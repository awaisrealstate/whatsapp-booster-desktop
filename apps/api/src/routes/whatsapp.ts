import { Hono } from 'hono';
import { z } from 'zod';
import {
  MetaCloudProvider,
  ProviderApiError,
  type QrBridgeClient,
  type WhatsAppProvider
} from '@wacrm/providers';
import {
  assertOrgPermission,
  checkAndRecordLoginAttempt,
  connectMetaWhatsappAccount,
  createDb,
  CrmError,
  disconnectWhatsappAccount,
  enforcePlanLimit,
  getDecryptedMetaCredentials,
  getOrCreateQrBridgeAccount,
  getQrSessionForOrg,
  getWhatsappAccountForOrg,
  listWhatsappAccounts,
  recordAuditLog,
  sendConversationReplyViaMeta,
  updateQrSessionState,
  upsertSyncedMetaTemplates,
  verifyAndUpdateMetaAccount
} from '@wacrm/db';
import { createOptionalQrBridgeClient, parseApiConfig, type WorkerBindings } from '../env.ts';
import { requireOrgSession, type AuthVariables } from '../middleware/auth.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const ConnectMetaAccountSchema = z.object({
  label: z.string().trim().min(1).max(120),
  phoneNumber: z.string().max(40).nullable().optional(),
  metaWabaId: z.string().trim().regex(/^\d{5,32}$/, 'metaWabaId must be numeric'),
  metaPhoneNumberId: z.string().trim().regex(/^\d{5,32}$/, 'metaPhoneNumberId must be numeric'),
  accessToken: z.string().trim().min(10).max(1024),
  appSecret: z.string().trim().min(8).max(256).nullable().optional(),
  webhookVerifyToken: z.string().trim().min(6).max(256),
  isDefault: z.boolean().optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional(),
  verifyConnection: z.boolean().optional()
});

const VerifyMetaCredentialsSchema = z.object({
  metaWabaId: z.string().trim().regex(/^\d{5,32}$/, 'metaWabaId must be numeric'),
  metaPhoneNumberId: z.string().trim().regex(/^\d{5,32}$/, 'metaPhoneNumberId must be numeric'),
  accessToken: z.string().trim().min(10).max(1024)
});

const QrStartSchema = z.object({
  accountId: z.string().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  isDefault: z.boolean().optional()
});

const SendConversationMetaSchema = z.object({
  whatsappAccountId: z.string().min(1).max(64).optional(),
  templateId: z.string().min(1).max(64).nullable().optional(),
  body: z.string().max(4096).nullable().optional(),
  idempotencyKey: z.string().max(128).nullable().optional()
});

const UNOFFICIAL_QR_NOTICE =
  'Unofficial WhatsApp Web protocol session. Not affiliated with or endorsed by Meta Official Cloud API; subject to restrictions, disconnects, or account bans.';

function requireBridgeOrFail(env: WorkerBindings, customBridge?: QrBridgeClient): QrBridgeClient {
  const client = createOptionalQrBridgeClient(env, customBridge);
  if (!client) {
    throw new CrmError(
      503,
      'QR_BRIDGE_UNCONFIGURED',
      'Separate Node.js QR service (QR_BRIDGE_URL / QR_BRIDGE_SECRET) is not configured.'
    );
  }
  return client;
}

export function createWhatsappRoutes(customProvider?: WhatsAppProvider, customQrBridge?: QrBridgeClient) {
  const wa = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  wa.use('*', requireOrgSession());

  wa.get('/accounts', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const items = await listWhatsappAccounts(db, ctx);
    return c.json({ items });
  });

  // Option A: Meta Official Cloud API — live credential verification before or after saving
  wa.post('/accounts/meta/verify', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const body = await parseJsonBody(c, VerifyMetaCredentialsSchema);
    const config = parseApiConfig(c.env);
    const provider = customProvider ?? new MetaCloudProvider({ graphVersion: config.metaGraphVersion });
    if (!provider.verifyAccountCredentials) {
      throw new CrmError(500, 'VERIFY_NOT_SUPPORTED', 'Meta provider verification is unavailable.');
    }
    try {
      const result = await provider.verifyAccountCredentials(body.metaPhoneNumberId, body.accessToken);
      return c.json({
        verified: result.valid,
        phoneNumber: result.phoneNumber,
        verifiedName: result.verifiedName
      });
    } catch (err) {
      if (err instanceof ProviderApiError) {
        throw new CrmError(422, err.code, err.message);
      }
      throw err;
    }
  });

  wa.post('/accounts/meta', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const body = await parseJsonBody(c, ConnectMetaAccountSchema);
    const db = createDb(c.env.DB!);
    await enforcePlanLimit(db, ctx, 'whatsappAccounts', 1);
    const config = parseApiConfig(c.env);
    const provider = customProvider ?? new MetaCloudProvider({ graphVersion: config.metaGraphVersion });

    let verifiedPhone = body.phoneNumber ?? null;
    let verifiedName: string | null = null;
    if (body.verifyConnection && provider.verifyAccountCredentials) {
      try {
        const verifyRes = await provider.verifyAccountCredentials(body.metaPhoneNumberId, body.accessToken);
        if (verifyRes.phoneNumber) verifiedPhone = verifyRes.phoneNumber;
        verifiedName = verifyRes.verifiedName;
      } catch (err) {
        if (err instanceof ProviderApiError) {
          throw new CrmError(422, err.code, err.message);
        }
        throw err;
      }
    }

    const account = await connectMetaWhatsappAccount(
      db,
      ctx,
      {
        ...body,
        phoneNumber: verifiedPhone
      },
      c.env.ENCRYPTION_KEY
    );

    await recordAuditLog(db, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'whatsapp_meta.connected',
      entityType: 'whatsapp_account',
      entityId: account?.id ?? null,
      metadata: { verifiedLive: Boolean(body.verifyConnection) }
    });

    return c.json(
      {
        account,
        verifiedName,
        webhookSetup: {
          callbackPath: '/webhooks/meta',
          requiredSignatureHeader: 'X-Hub-Signature-256'
        }
      },
      201
    );
  });

  wa.post('/accounts/:id/verify', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const db = createDb(c.env.DB!);
    const config = parseApiConfig(c.env);
    const provider = customProvider ?? new MetaCloudProvider({ graphVersion: config.metaGraphVersion });
    const result = await verifyAndUpdateMetaAccount(
      db,
      ctx,
      c.req.param('id'),
      c.env.ENCRYPTION_KEY,
      provider
    );
    await recordAuditLog(db, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'whatsapp_meta.verified',
      entityType: 'whatsapp_account',
      entityId: c.req.param('id')
    });
    return c.json(result);
  });

  // Option B: Unofficial WhatsApp Web QR Connection (delegated to separate apps/qr-service)
  wa.post('/accounts/qr/start', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const bridge = requireBridgeOrFail(c.env, customQrBridge);
    const body = await parseJsonBody(c, QrStartSchema);
    const db = createDb(c.env.DB!);

    if (!body.accountId) {
      await enforcePlanLimit(db, ctx, 'whatsappAccounts', 1);
    }

    const rl = await checkAndRecordLoginAttempt(db, {
      rateKey: `qr_ops:${ctx.organizationId}`,
      success: false,
      maxAttempts: 20,
      windowMs: 60_000,
      lockoutMs: 60_000
    });
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSec ?? 60));
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many QR requests; wait a moment before starting a new QR session.'
          }
        },
        429
      );
    }

    const account = await getOrCreateQrBridgeAccount(db, ctx, body);
    try {
      const snapshot = await bridge.startSession({
        organizationId: ctx.organizationId,
        whatsappAccountId: account!.id
      });
      const updated = await updateQrSessionState(db, snapshot);
      await recordAuditLog(db, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'whatsapp_qr.started',
        entityType: 'whatsapp_account',
        entityId: account!.id
      });
      return c.json({
        account: updated,
        session: updated?.qrSession ?? null,
        official: false,
        complianceNotice: UNOFFICIAL_QR_NOTICE
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to reach QR bridge.';
      const updated = await updateQrSessionState(db, {
        organizationId: ctx.organizationId,
        whatsappAccountId: account!.id,
        status: 'error',
        qrDataUrl: null,
        qrExpiresAt: null,
        phoneNumber: null,
        lastConnectedAt: null,
        lastError: errMsg
      });
      if (err instanceof ProviderApiError) {
        return c.json(
          {
            account: updated,
            session: updated?.qrSession ?? null,
            official: false,
            complianceNotice: UNOFFICIAL_QR_NOTICE,
            error: { code: err.code, message: err.message }
          },
          err.statusCode === 429 ? 429 : 502
        );
      }
      throw err;
    }
  });

  wa.get('/accounts/qr/:id/status', async (c) => {
    const ctx = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const accountId = c.req.param('id');
    let account = await getQrSessionForOrg(db, ctx, accountId);

    const bridge = createOptionalQrBridgeClient(c.env, customQrBridge);
    if (bridge) {
      try {
        const snapshot = await bridge.getSessionStatus(ctx.organizationId, accountId);
        account = (await updateQrSessionState(db, snapshot)) ?? account;
      } catch (err) {
        if (err instanceof ProviderApiError) {
          account =
            (await updateQrSessionState(db, {
              organizationId: ctx.organizationId,
              whatsappAccountId: accountId,
              status: 'error',
              qrDataUrl: null,
              qrExpiresAt: null,
              phoneNumber: account.phoneNumber,
              lastConnectedAt: account.lastConnectedAt,
              lastError: err.message
            })) ?? account;
        }
      }
    }

    return c.json({
      account,
      session: account.qrSession,
      official: false,
      complianceNotice: UNOFFICIAL_QR_NOTICE
    });
  });

  wa.post('/accounts/qr/:id/refresh', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const bridge = requireBridgeOrFail(c.env, customQrBridge);
    const db = createDb(c.env.DB!);
    const accountId = c.req.param('id');
    await getQrSessionForOrg(db, ctx, accountId);

    const rl = await checkAndRecordLoginAttempt(db, {
      rateKey: `qr_ops:${ctx.organizationId}`,
      success: false,
      maxAttempts: 20,
      windowMs: 60_000,
      lockoutMs: 60_000
    });
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSec ?? 60));
      return c.json({ error: { code: 'RATE_LIMITED', message: 'QR refresh rate limit reached.' } }, 429);
    }

    try {
      const snapshot = await bridge.refreshSession({
        organizationId: ctx.organizationId,
        whatsappAccountId: accountId
      });
      const updated = await updateQrSessionState(db, snapshot);
      return c.json({
        account: updated,
        session: updated?.qrSession ?? null,
        official: false,
        complianceNotice: UNOFFICIAL_QR_NOTICE
      });
    } catch (err) {
      if (err instanceof ProviderApiError) {
        throw new CrmError(502, err.code, err.message);
      }
      throw err;
    }
  });

  wa.post('/accounts/qr/:id/reconnect', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const bridge = requireBridgeOrFail(c.env, customQrBridge);
    const db = createDb(c.env.DB!);
    const accountId = c.req.param('id');
    await getQrSessionForOrg(db, ctx, accountId);

    try {
      const snapshot = await bridge.reconnectSession({
        organizationId: ctx.organizationId,
        whatsappAccountId: accountId
      });
      const updated = await updateQrSessionState(db, snapshot);
      await recordAuditLog(db, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'whatsapp_qr.reconnected',
        entityType: 'whatsapp_account',
        entityId: accountId
      });
      return c.json({
        account: updated,
        session: updated?.qrSession ?? null,
        official: false,
        complianceNotice: UNOFFICIAL_QR_NOTICE
      });
    } catch (err) {
      if (err instanceof ProviderApiError) {
        throw new CrmError(502, err.code, err.message);
      }
      throw err;
    }
  });

  wa.post('/accounts/qr/:id/disconnect', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const db = createDb(c.env.DB!);
    const accountId = c.req.param('id');
    const existing = await getQrSessionForOrg(db, ctx, accountId);

    const bridge = createOptionalQrBridgeClient(c.env, customQrBridge);
    if (bridge) {
      try {
        await bridge.disconnectSession({
          organizationId: ctx.organizationId,
          whatsappAccountId: accountId
        });
      } catch {
        // Still mark disconnected safely in D1
      }
    }

    const updated = await updateQrSessionState(db, {
      organizationId: ctx.organizationId,
      whatsappAccountId: accountId,
      status: 'disconnected',
      qrDataUrl: null,
      qrExpiresAt: null,
      phoneNumber: existing.phoneNumber,
      lastConnectedAt: existing.lastConnectedAt,
      lastError: null
    });

    await recordAuditLog(db, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'whatsapp_qr.disconnected',
      entityType: 'whatsapp_account',
      entityId: accountId
    });

    return c.json({
      account: updated,
      session: updated?.qrSession ?? null,
      official: false
    });
  });

  wa.post('/accounts/:id/disconnect', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const db = createDb(c.env.DB!);
    const accountId = c.req.param('id');
    const existing = await getWhatsappAccountForOrg(db, ctx, accountId);
    if (!existing) {
      throw new CrmError(404, 'WHATSAPP_ACCOUNT_NOT_FOUND', 'WhatsApp account not found.');
    }

    if (existing.providerType === 'unofficial_bridge') {
      const bridge = createOptionalQrBridgeClient(c.env, customQrBridge);
      if (bridge) {
        try {
          await bridge.disconnectSession({
            organizationId: ctx.organizationId,
            whatsappAccountId: accountId
          });
        } catch {}
      }
      const updated = await updateQrSessionState(db, {
        organizationId: ctx.organizationId,
        whatsappAccountId: accountId,
        status: 'disconnected',
        qrDataUrl: null,
        qrExpiresAt: null,
        phoneNumber: existing.phoneNumber,
        lastConnectedAt: existing.lastConnectedAt,
        lastError: null
      });
      return c.json({ account: updated });
    }

    const account = await disconnectWhatsappAccount(db, ctx, accountId);
    return c.json({ account });
  });

  wa.post('/accounts/:id/sync-templates', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'whatsapp:manage');
    const db = createDb(c.env.DB!);
    const creds = await getDecryptedMetaCredentials(db, ctx, c.req.param('id'), c.env.ENCRYPTION_KEY);
    if (!creds.wabaId) {
      throw new CrmError(422, 'MISSING_WABA_ID', 'metaWabaId is required to sync templates from Meta.');
    }

    const config = parseApiConfig(c.env);
    const provider = customProvider ?? new MetaCloudProvider({ graphVersion: config.metaGraphVersion });
    try {
      const synced = await provider.syncTemplates(creds.wabaId, creds.accessToken);
      const summary = await upsertSyncedMetaTemplates(db, ctx, creds.accountId, synced);
      return c.json({ ...summary, templates: synced });
    } catch (err) {
      if (err instanceof ProviderApiError) {
        throw new CrmError(422, err.code, err.message);
      }
      throw err;
    }
  });

  wa.post('/conversations/:id/send', async (c) => {
    const ctx = c.get('orgContext')!;
    assertOrgPermission(ctx, 'inbox:reply');
    const body = await parseJsonBody(c, SendConversationMetaSchema);
    const db = createDb(c.env.DB!);
    const config = parseApiConfig(c.env);
    const provider = customProvider ?? new MetaCloudProvider({ graphVersion: config.metaGraphVersion });
    const qrBridge = createOptionalQrBridgeClient(c.env, customQrBridge);

    const message = await sendConversationReplyViaMeta(db, ctx, {
      conversationId: c.req.param('id'),
      whatsappAccountId: body.whatsappAccountId,
      templateId: body.templateId,
      body: body.body,
      idempotencyKey: body.idempotencyKey,
      encryptionKey: c.env.ENCRYPTION_KEY,
      provider,
      qrBridge
    });
    return c.json({ message }, 201);
  });

  return wa;
}
