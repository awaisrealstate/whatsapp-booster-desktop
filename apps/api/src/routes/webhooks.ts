import { Hono } from 'hono';
import {
  MetaCloudProvider,
  verifyBridgeSignature,
  type QrBridgeClient,
  type QrBridgeWebhookPayload,
  type WhatsAppProvider
} from '@wacrm/providers';
import {
  createDb,
  decryptSecretAesGcm,
  findMetaAccountByPhoneNumberId,
  findMetaAccountByVerifyToken,
  handleAiSupportForConversation,
  recordAndProcessMetaWebhookEvents,
  recordQrBridgeInboundMessage,
  TenantAccessError,
  updateQrSessionState
} from '@wacrm/db';
import { createOptionalQrBridgeClient, type WorkerBindings } from '../env.ts';
import type { AuthVariables } from '../middleware/auth.ts';

function extractPhoneNumberId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }> }> }).entry;
  if (!Array.isArray(entries)) return null;
  for (const e of entries) {
    for (const ch of e?.changes ?? []) {
      const pid = ch?.value?.metadata?.phone_number_id;
      if (typeof pid === 'string' && pid.trim()) return pid.trim();
    }
  }
  return null;
}

export function createWebhookRoutes(metaProvider?: WhatsAppProvider, customQrBridge?: QrBridgeClient) {
  const webhooks = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  // Official Meta Webhook Verification Challenge
  webhooks.get('/meta', async (c) => {
    const mode = c.req.query('hub.mode');
    const verifyToken = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    const provider = metaProvider ?? new MetaCloudProvider();

    if (mode !== 'subscribe' || !verifyToken || !challenge) {
      return c.json({ error: { code: 'WEBHOOK_VERIFY_FAILED', message: 'Missing Meta verification parameters.' } }, 403);
    }

    // Check D1 registered WhatsApp accounts first, then optional worker fallback token
    let matched = false;
    if (c.env.DB) {
      const db = createDb(c.env.DB);
      const account = await findMetaAccountByVerifyToken(db, verifyToken);
      if (account) matched = true;
    }

    if (!matched && c.env.META_WEBHOOK_VERIFY_TOKEN) {
      const result = await provider.verifyWebhookChallenge({
        mode,
        verifyToken,
        challenge,
        expectedVerifyToken: c.env.META_WEBHOOK_VERIFY_TOKEN
      });
      if (result.valid && result.challenge) {
        return c.text(result.challenge, 200);
      }
    }

    if (!matched) {
      return c.json({ error: { code: 'WEBHOOK_VERIFY_FAILED', message: 'Invalid Meta verify token.' } }, 403);
    }

    return c.text(challenge, 200);
  });

  // Official Meta Webhook Ingestion (HMAC-SHA256 X-Hub-Signature-256 required)
  webhooks.post('/meta', async (c) => {
    if (!c.env.DB) {
      throw new TenantAccessError(401, 'DB_UNCONFIGURED', 'Database binding is not configured.');
    }

    const rawBody = await c.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Invalid webhook JSON payload.' } }, 400);
    }

    const phoneNumberId = extractPhoneNumberId(payload);
    if (!phoneNumberId) {
      return c.json({ error: { code: 'MISSING_PHONE_NUMBER_ID', message: 'Webhook payload missing phone_number_id metadata.' } }, 400);
    }

    const db = createDb(c.env.DB);
    const account = await findMetaAccountByPhoneNumberId(db, phoneNumberId);
    if (!account) {
      return c.json({ error: { code: 'UNKNOWN_WHATSAPP_ACCOUNT', message: 'WhatsApp account not registered.' } }, 404);
    }

    let appSecret = c.env.META_APP_SECRET?.trim() || '';
    if (account.metaAppSecretEnc) {
      if (!c.env.ENCRYPTION_KEY || c.env.ENCRYPTION_KEY.trim().length < 16) {
        return c.json({ error: { code: 'ENCRYPTION_KEY_UNCONFIGURED', message: 'Cannot decrypt webhook app secret.' } }, 500);
      }
      appSecret = await decryptSecretAesGcm(account.metaAppSecretEnc, c.env.ENCRYPTION_KEY);
    }

    if (!appSecret) {
      return c.json({ error: { code: 'WEBHOOK_SECRET_MISSING', message: 'Meta App Secret is not configured for signature verification.' } }, 401);
    }

    const provider = metaProvider ?? new MetaCloudProvider();
    const signatureHeader = c.req.header('x-hub-signature-256');
    const signatureValid = await provider.verifyWebhookSignature(rawBody, signatureHeader, appSecret);
    if (!signatureValid) {
      return c.json({ error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'X-Hub-Signature-256 verification failed.' } }, 401);
    }

    const events = provider.parseWebhookPayload(payload);
    const result = await recordAndProcessMetaWebhookEvents(db, {
      organizationId: account.organizationId,
      whatsappAccountId: account.id,
      rawPayload: rawBody,
      events
    });

    // Dispatch AI support replies safely if inbound messages exist
    if (result.inboundConversations.length > 0) {
      if (c.env.JOBS_QUEUE) {
        try {
          await c.env.JOBS_QUEUE.sendBatch(
            result.inboundConversations.map((ic) => ({
              body: {
                kind: 'ai_reply' as const,
                organizationId: account.organizationId,
                conversationId: ic.conversationId,
                customerText: ic.customerText
              }
            }))
          );
        } catch {
          // Leave queued AI optional when Queue quota exhausted
        }
      } else if (c.env.AI) {
        for (const ic of result.inboundConversations.slice(0, 3)) {
          await handleAiSupportForConversation(db, c.env.DB, {
            organizationId: account.organizationId,
            conversationId: ic.conversationId,
            customerText: ic.customerText,
            aiBinding: c.env.AI,
            encryptionKey: c.env.ENCRYPTION_KEY,
            provider,
            sendOutboundReply: true
          });
        }
      }
    }

    return c.json({ ok: true, ...result }, 200);
  });

  // Unofficial QR Bridge Webhook (HMAC-SHA256 X-Bridge-Signature required)
  webhooks.post('/qr-bridge', async (c) => {
    if (!c.env.DB) {
      throw new TenantAccessError(401, 'DB_UNCONFIGURED', 'Database binding is not configured.');
    }
    const bridgeSecret = c.env.QR_BRIDGE_SECRET?.trim() || '';
    if (bridgeSecret.length < 16) {
      return c.json(
        { error: { code: 'QR_BRIDGE_SECRET_UNCONFIGURED', message: 'QR bridge secret not configured.' } },
        503
      );
    }

    const rawBody = await c.req.text();
    const validSig = await verifyBridgeSignature({
      secret: bridgeSecret,
      timestampHeader: c.req.header('x-bridge-timestamp'),
      signatureHeader: c.req.header('x-bridge-signature'),
      method: 'POST',
      path: new URL(c.req.url).pathname,
      rawBody
    });

    if (!validSig) {
      return c.json(
        { error: { code: 'INVALID_BRIDGE_SIGNATURE', message: 'Bridge HMAC signature verification failed.' } },
        401
      );
    }

    let payload: QrBridgeWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as QrBridgeWebhookPayload;
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON webhook body.' } }, 400);
    }

    const db = createDb(c.env.DB);
    if (payload.eventType === 'session_update') {
      const account = await updateQrSessionState(db, {
        organizationId: payload.organizationId,
        whatsappAccountId: payload.whatsappAccountId,
        status: payload.status,
        qrDataUrl: payload.qrDataUrl ?? null,
        qrExpiresAt: payload.qrExpiresAt ?? null,
        phoneNumber: payload.phoneNumber ?? null,
        lastConnectedAt: payload.lastConnectedAt ?? null,
        lastError: payload.lastError ?? null
      });
      return c.json({ ok: true, eventType: 'session_update', account }, 200);
    }

    if (payload.eventType === 'inbound_message') {
      const res = await recordQrBridgeInboundMessage(db, payload);
      if (!res.duplicate && !res.isStopKeyword && res.conversationId) {
        const provider = metaProvider ?? new MetaCloudProvider();
        const qrBridge = createOptionalQrBridgeClient(c.env, customQrBridge);
        if (c.env.JOBS_QUEUE) {
          try {
            await c.env.JOBS_QUEUE.sendBatch([
              {
                body: {
                  kind: 'ai_reply' as const,
                  organizationId: payload.organizationId,
                  conversationId: res.conversationId,
                  customerText: res.customerText
                }
              }
            ]);
          } catch {}
        } else if (c.env.AI) {
          await handleAiSupportForConversation(db, c.env.DB, {
            organizationId: payload.organizationId,
            conversationId: res.conversationId,
            customerText: res.customerText,
            aiBinding: c.env.AI,
            encryptionKey: c.env.ENCRYPTION_KEY,
            provider,
            qrBridge,
            sendOutboundReply: true
          });
        }
      }
      return c.json({ ok: true, eventType: 'inbound_message', ...res }, 200);
    }

    return c.json({ error: { code: 'UNSUPPORTED_EVENT', message: 'Unknown QR bridge eventType.' } }, 400);
  });

  return webhooks;
}
