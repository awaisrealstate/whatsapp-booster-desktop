import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeWASocket,
  proto,
  type AuthenticationState,
  type BaileysEventMap,
  type ConnectionState,
  type WAMessage
} from '@whiskeysockets/baileys';
import {
  computeBridgeSignature,
  ProviderApiError,
  type QrBridgeHistorySyncMessage,
  type QrBridgeInboundEvent,
  type QrBridgeSessionEvent,
  type QrBridgeStatus,
  type QrBridgeWebhookPayload,
  type QrSessionSnapshot,
  type SendMessageResult
} from '@wacrm/providers';
import type { EncryptedSessionStore } from './crypto-store.ts';

export interface MinimalWaSocket {
  user?: { id?: string; name?: string } | null;
  ev: {
    on<K extends keyof BaileysEventMap>(event: K, listener: (arg: BaileysEventMap[K]) => void): void;
  };
  sendMessage(
    jid: string,
    content: { text: string }
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  logout?(): Promise<void>;
  end?(error?: Error): void;
}

export type WaSocketFactory = (opts: {
  organizationId: string;
  whatsappAccountId: string;
  auth: AuthenticationState;
}) => Promise<MinimalWaSocket>;

interface ManagedSession {
  organizationId: string;
  whatsappAccountId: string;
  status: QrBridgeStatus;
  qrDataUrl: string | null;
  qrExpiresAt: number | null;
  phoneNumber: string | null;
  lastConnectedAt: number | null;
  lastError: string | null;
  reconnectAttempts: number;
  manuallyDisconnected: boolean;
  expiryTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  socket: MinimalWaSocket | null;
}

function sessionKey(organizationId: string, whatsappAccountId: string): string {
  return `${organizationId}:${whatsappAccountId}`;
}

export function extractPhoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const userPart = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = userPart.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

function formatToWhatsAppJid(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new ProviderApiError(422, 'INVALID_RECIPIENT_PHONE', 'Recipient phone must have 8..15 digits.', false);
  }
  return `${digits}@s.whatsapp.net`;
}

function extractMessageBody(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  );
}

function getMediaDetails(msg: WAMessage): {
  isMedia: boolean;
  type: 'image' | 'video' | 'audio' | 'document' | 'other';
  mimetype?: string;
  filename?: string;
  caption?: string;
} {
  const m = msg.message;
  if (!m) return { isMedia: false, type: 'other' };
  if (m.imageMessage) {
    return {
      isMedia: true,
      type: 'image',
      mimetype: m.imageMessage.mimetype || 'image/jpeg',
      caption: m.imageMessage.caption || undefined
    };
  }
  if (m.videoMessage) {
    return {
      isMedia: true,
      type: 'video',
      mimetype: m.videoMessage.mimetype || 'video/mp4',
      caption: m.videoMessage.caption || undefined
    };
  }
  if (m.audioMessage) {
    return {
      isMedia: true,
      type: 'audio',
      mimetype: m.audioMessage.mimetype || 'audio/ogg',
      caption: undefined
    };
  }
  if (m.documentMessage) {
    return {
      isMedia: true,
      type: 'document',
      mimetype: m.documentMessage.mimetype || 'application/octet-stream',
      filename: m.documentMessage.fileName || undefined,
      caption: m.documentMessage.caption || undefined
    };
  }
  return { isMedia: false, type: 'other' };
}

async function downloadAndSaveMedia(
  msg: WAMessage,
  mediaDir: string,
  organizationId: string,
  whatsappAccountId: string
): Promise<{ mediaUrl?: string; mediaMimeType?: string; mediaFilename?: string; mediaSizeBytes?: number }> {
  try {
    const details = getMediaDetails(msg);
    if (!details.isMedia) return {};
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    if (!buffer || buffer.length === 0) return {};

    const msgId = msg.key?.id || crypto.randomUUID();
    let ext = 'bin';
    if (details.type === 'image') ext = 'jpg';
    else if (details.type === 'video') ext = 'mp4';
    else if (details.type === 'audio') ext = 'ogg';
    else if (details.type === 'document') {
      const match = details.filename?.match(/\.([a-zA-Z0-9]+)$/);
      ext = match && match[1] ? match[1].toLowerCase() : 'pdf';
    }

    const filename = `${msgId}.${ext}`;
    const targetDir = path.join(mediaDir, organizationId, whatsappAccountId);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, filename);
    await fs.promises.writeFile(filePath, buffer);

    return {
      mediaUrl: `/media/${organizationId}/${whatsappAccountId}/${filename}`,
      mediaMimeType: details.mimetype,
      mediaFilename: details.filename || filename,
      mediaSizeBytes: buffer.length
    };
  } catch {
    return {};
  }
}

export class QrSessionManager {
  private readonly store: EncryptedSessionStore;
  private readonly socketFactory: WaSocketFactory;
  private readonly qrTtlMs: number;
  private readonly bridgeSecret: string;
  private readonly webhookUrl: string | null;
  private readonly mediaDir: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly opLocks = new Map<string, Promise<unknown>>();
  private readonly logger = pino({ level: 'info' });

  constructor(options: {
    store: EncryptedSessionStore;
    bridgeSecret: string;
    webhookUrl?: string | null;
    mediaDir?: string | null;
    qrTtlMs?: number;
    socketFactory?: WaSocketFactory;
    fetchFn?: typeof fetch;
  }) {
    this.store = options.store;
    this.bridgeSecret = options.bridgeSecret;
    this.webhookUrl = options.webhookUrl?.trim() || null;
    this.mediaDir = options.mediaDir?.trim() || null;
    this.qrTtlMs = options.qrTtlMs ?? 60_000;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.socketFactory =
      options.socketFactory ??
      (async ({ auth }) => {
        let version: [number, number, number] | undefined;
        try {
          const v = await fetchLatestWaWebVersion({});
          if (!v.error && Array.isArray(v.version) && v.version.length === 3) {
            version = v.version as [number, number, number];
          }
        } catch {
          // Baileys falls back to bundled version if metadata endpoint unreachable
        }
        return makeWASocket({
          auth,
          version,
          logger: pino({ level: 'silent' }),
          printQRInTerminal: false,
          browser: Browsers.windows('WhatsApp Booster Pro'),
          syncFullHistory: true,
          markOnlineOnConnect: false
        }) as unknown as MinimalWaSocket;
      });
  }

  private withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.opLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.opLocks.set(key, next);
    return next;
  }

  getActiveSessionCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'connected' || s.status === 'waiting_for_scan' || s.status === 'connecting') {
        count++;
      }
    }
    return count;
  }

  private clearTimers(s: ManagedSession) {
    if (s.expiryTimer) {
      clearTimeout(s.expiryTimer);
      s.expiryTimer = null;
    }
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
  }

  private toSnapshot(s: ManagedSession): QrSessionSnapshot {
    if (s.status === 'waiting_for_scan' && s.qrExpiresAt !== null && Date.now() > s.qrExpiresAt) {
      s.status = 'expired';
      s.qrDataUrl = null;
      s.qrExpiresAt = null;
      s.lastError = 'QR code expired before scanning. Click Refresh QR to generate a new code.';
    }

    return {
      organizationId: s.organizationId,
      whatsappAccountId: s.whatsappAccountId,
      status: s.status,
      qrDataUrl: s.status === 'waiting_for_scan' ? s.qrDataUrl : null,
      qrExpiresAt: s.status === 'waiting_for_scan' ? s.qrExpiresAt : null,
      phoneNumber: s.phoneNumber,
      lastConnectedAt: s.lastConnectedAt,
      lastError: s.lastError
    };
  }

  private async postSignedWebhook(payload: QrBridgeWebhookPayload): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const url = new URL(this.webhookUrl);
      const rawBody = JSON.stringify(payload);
      const ts = Date.now();
      const sig = await computeBridgeSignature(
        this.bridgeSecret,
        ts,
        'POST',
        url.pathname,
        rawBody
      );
      await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts),
          'X-Bridge-Signature': sig
        },
        body: rawBody
      });
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'QR webhook callback failed');
    }
  }

  private async openSocket(
    organizationId: string,
    whatsappAccountId: string,
    mode: 'start' | 'refresh' | 'reconnect'
  ): Promise<QrSessionSnapshot> {
    const key = sessionKey(organizationId, whatsappAccountId);
    let session = this.sessions.get(key);
    if (session) {
      this.clearTimers(session);
      if (session.socket) {
        try {
          session.socket.end?.();
        } catch {}
        session.socket = null;
      }
    } else {
      session = {
        organizationId,
        whatsappAccountId,
        status: 'connecting',
        qrDataUrl: null,
        qrExpiresAt: null,
        phoneNumber: null,
        lastConnectedAt: null,
        lastError: null,
        reconnectAttempts: 0,
        manuallyDisconnected: false,
        expiryTimer: null,
        reconnectTimer: null,
        socket: null
      };
      this.sessions.set(key, session);
    }

    if (mode === 'refresh') {
      await this.store.clearSession(organizationId, whatsappAccountId);
    }

    const loaded = await this.store.loadAuthState(organizationId, whatsappAccountId);
    if (mode === 'reconnect' && !loaded.hasExistingCreds) {
      session.status = 'disconnected';
      session.lastError = 'No encrypted WhatsApp Web session found on disk. Scan a fresh QR code.';
      return this.toSnapshot(session);
    }

    if (mode !== 'reconnect') {
      session.reconnectAttempts = 0;
    }
    session.phoneNumber =
      mode === 'refresh'
        ? null
        : (extractPhoneFromJid(loaded.state.creds.me?.id) ?? session.phoneNumber);
    session.status = 'connecting';
    session.manuallyDisconnected = false;
    session.qrDataUrl = null;
    session.qrExpiresAt = null;
    session.lastError = null;

    const sock = await this.socketFactory({
      organizationId,
      whatsappAccountId,
      auth: loaded.state
    });
    session.socket = sock;

    sock.ev.on('creds.update', async () => {
      await loaded.saveCreds();
    });

    sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const cur = this.sessions.get(key);
      if (!cur || cur.socket !== sock) return;

      if (update.qr) {
        this.clearTimers(cur);
        const qrDataUrl = await QRCode.toDataURL(update.qr, { width: 280, margin: 2 });
        cur.status = 'waiting_for_scan';
        cur.qrDataUrl = qrDataUrl;
        cur.qrExpiresAt = Date.now() + this.qrTtlMs;
        cur.lastError = null;

        cur.expiryTimer = setTimeout(() => {
          if (cur.status === 'waiting_for_scan') {
            cur.status = 'expired';
            cur.qrDataUrl = null;
            cur.qrExpiresAt = null;
            cur.lastError = 'QR code expired before scanning. Click Refresh QR to try again.';
            void this.postSignedWebhook({
              eventType: 'session_update',
              ...this.toSnapshot(cur)
            });
          }
        }, this.qrTtlMs);

        await this.postSignedWebhook({
          eventType: 'session_update',
          ...this.toSnapshot(cur)
        });
      }

      if (update.connection === 'open') {
        this.clearTimers(cur);
        cur.status = 'connected';
        cur.qrDataUrl = null;
        cur.qrExpiresAt = null;
        cur.reconnectAttempts = 0;
        cur.lastError = null;
        cur.lastConnectedAt = Date.now();
        cur.phoneNumber = extractPhoneFromJid(sock.user?.id) ?? cur.phoneNumber;
        if (sock.user?.id && !loaded.state.creds.me) {
          loaded.state.creds.me = { id: sock.user.id, name: sock.user.name };
        }
        if (sock.user?.id || loaded.state.creds.me) {
          loaded.state.creds.registered = true;
        }
        await loaded.saveCreds();

        await this.postSignedWebhook({
          eventType: 'session_update',
          ...this.toSnapshot(cur)
        });
      }

      if (update.connection === 'close') {
        this.clearTimers(cur);
        cur.socket = null;
        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const reasonText =
          update.lastDisconnect?.error instanceof Error
            ? update.lastDisconnect.error.message
            : 'WhatsApp Web connection closed.';
        const hasPersistedCreds = Boolean(
          loaded.hasExistingCreds || loaded.state.creds.me?.id || loaded.state.creds.registered
        );
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;

        if (cur.manuallyDisconnected) {
          cur.status = 'disconnected';
          cur.qrDataUrl = null;
          cur.qrExpiresAt = null;
        } else if (statusCode === DisconnectReason.loggedOut) {
          await loaded.clear();
          cur.status = 'disconnected';
          cur.qrDataUrl = null;
          cur.qrExpiresAt = null;
          cur.phoneNumber = null;
          cur.lastError = 'Session logged out from WhatsApp phone Linked Devices. Scan QR again.';
        } else if (
          (isRestartRequired || hasPersistedCreds) &&
          cur.reconnectAttempts < 3 &&
          statusCode !== DisconnectReason.forbidden
        ) {
          if (sock.user?.id && !loaded.state.creds.me) {
            loaded.state.creds.me = { id: sock.user.id, name: sock.user.name };
          }
          try {
            await loaded.saveCreds();
          } catch {
            // Preserve best-effort save before restart reconnect
          }
          cur.reconnectAttempts += 1;
          cur.status = 'connecting';
          cur.qrDataUrl = null;
          cur.qrExpiresAt = null;
          cur.lastError = isRestartRequired
            ? 'Finishing WhatsApp Web pairing handshake...'
            : `Reconnecting (${cur.reconnectAttempts}/3): ${reasonText}`;
          const backoffMs = isRestartRequired ? 400 : Math.min(2000 * cur.reconnectAttempts, 10_000);
          cur.reconnectTimer = setTimeout(() => {
            void this.reconnectSession(organizationId, whatsappAccountId);
          }, backoffMs);
        } else {
          cur.status = 'error';
          cur.qrDataUrl = null;
          cur.qrExpiresAt = null;
          cur.lastError = reasonText;
        }

        await this.postSignedWebhook({
          eventType: 'session_update',
          ...this.toSnapshot(cur)
        });
      }
    });

    // ── History Sync Listener ──────────────────────────────────────────────
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
      try {
        this.logger.info(
          {
            organizationId,
            whatsappAccountId,
            chatsCount: chats?.length ?? 0,
            messagesCount: messages?.length ?? 0,
            contactsCount: contacts?.length ?? 0,
            isLatest
          },
          'Received Baileys messaging-history.set event'
        );

        const mappedChats = (chats ?? [])
          .filter((c) => Boolean(c.id))
          .map((c) => ({
            id: c.id!,
            name: c.name || (c as { subject?: string }).subject || null,
            unreadCount: c.unreadCount ?? 0,
            lastMessageTimestamp: typeof c.conversationTimestamp === 'number' ? c.conversationTimestamp : null,
            isGroup: Boolean(c.id?.endsWith('@g.us'))
          }));

        const mappedContacts = (contacts ?? [])
          .filter((c) => Boolean(c.id))
          .map((c) => ({
            id: c.id!,
            name: c.name || null,
            notify: c.notify || null,
            verifiedName: c.verifiedName || null
          }));

        const BATCH_SIZE = 50;
        const rawMessages = messages ?? [];
        const totalBatches = Math.max(1, Math.ceil(rawMessages.length / BATCH_SIZE));

        for (let i = 0; i < totalBatches; i++) {
          const chunk = rawMessages.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
          const isLastBatch = i === totalBatches - 1;

          const processedChunk: QrBridgeHistorySyncMessage[] = [];
          for (const msg of chunk) {
            if (!msg.key?.id || !msg.key?.remoteJid) continue;
            const primaryJid = msg.key.remoteJid;
            if (primaryJid === 'status@broadcast') continue;

            const fromMe = Boolean(msg.key.fromMe);
            const altJid = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
            const effectiveJid = primaryJid.endsWith('@lid') && altJid?.endsWith('@s.whatsapp.net')
              ? altJid
              : primaryJid;
            const participant = msg.key.participant || effectiveJid;
            const senderPhone = extractPhoneFromJid(participant) || extractPhoneFromJid(effectiveJid);

            const body = extractMessageBody(msg);
            const details = getMediaDetails(msg);

            let mediaInfo: { mediaUrl?: string; mediaMimeType?: string; mediaFilename?: string; mediaSizeBytes?: number } = {};
            if (details.isMedia && this.mediaDir) {
              mediaInfo = await downloadAndSaveMedia(msg, this.mediaDir, organizationId, whatsappAccountId);
            }

            const ts = typeof msg.messageTimestamp === 'number'
              ? msg.messageTimestamp * 1000
              : (msg.messageTimestamp as { low?: number } | undefined)?.low
                ? (msg.messageTimestamp as { low: number }).low * 1000
                : Date.now();

            processedChunk.push({
              providerMessageId: msg.key.id,
              remoteJid: primaryJid,
              fromMe,
              senderPhone: senderPhone ? (senderPhone.startsWith('+') ? senderPhone : `+${senderPhone}`) : null,
              senderName: msg.pushName || null,
              body,
              msgType: details.isMedia ? details.type : 'text',
              mediaUrl: mediaInfo.mediaUrl,
              mediaMimeType: mediaInfo.mediaMimeType,
              mediaFilename: mediaInfo.mediaFilename,
              mediaSizeBytes: mediaInfo.mediaSizeBytes,
              timestampMs: ts
            });
          }

          await this.postSignedWebhook({
            eventType: 'history_sync',
            eventId: `sync_${organizationId}_${whatsappAccountId}_${Date.now()}_${i}`,
            organizationId,
            whatsappAccountId,
            syncType: typeof syncType === 'number' ? String(syncType) : (syncType || 'history_sync'),
            progress: progress ?? (isLatest && isLastBatch ? 100 : Math.round(((i + 1) / totalBatches) * 100)),
            isLatest: Boolean(isLatest && isLastBatch),
            chats: i === 0 ? mappedChats : [],
            contacts: i === 0 ? mappedContacts : [],
            messages: processedChunk,
            timestampMs: Date.now()
          });
        }
      } catch (err) {
        this.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Error handling messaging-history.set');
      }
    });

    // ── Incremental Chat Updates ───────────────────────────────────────────
    sock.ev.on('chats.upsert', async (newChats) => {
      try {
        const mapped = (newChats ?? [])
          .filter((c) => Boolean(c.id))
          .map((c) => ({
            id: c.id!,
            name: c.name || null,
            unreadCount: c.unreadCount ?? 0,
            lastMessageTimestamp: typeof c.conversationTimestamp === 'number' ? c.conversationTimestamp : null,
            isGroup: Boolean(c.id?.endsWith('@g.us'))
          }));
        if (mapped.length > 0) {
          await this.postSignedWebhook({
            eventType: 'history_sync',
            eventId: `chats_${Date.now()}`,
            organizationId,
            whatsappAccountId,
            isLatest: false,
            chats: mapped,
            messages: [],
            timestampMs: Date.now()
          });
        }
      } catch {}
    });

    // ── Inbound & Outbound Live Message Upsert ──────────────────────────────
    sock.ev.on('messages.upsert', async (upsert) => {
      try {
        for (const msg of upsert.messages ?? []) {
          if (!msg.key?.id || !msg.key?.remoteJid) continue;
          const primaryJid = msg.key.remoteJid;
          if (primaryJid === 'status@broadcast') continue;

          // Check for revoke (anti-delete) or edit protocol message
          const protoMsg = msg.message?.protocolMessage;
          if (protoMsg) {
            if (protoMsg.type === proto.Message.ProtocolMessage.Type.REVOKE && protoMsg.key?.id) {
              await this.postSignedWebhook({
                eventType: 'message_revoked',
                eventId: `rev_${protoMsg.key.id}_${Date.now()}`,
                organizationId,
                whatsappAccountId,
                providerMessageId: protoMsg.key.id,
                remoteJid: primaryJid,
                deletedByJid: protoMsg.key.participant || primaryJid,
                deletedAtMs: Date.now()
              });
              continue;
            }
            if (
              protoMsg.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
              protoMsg.key?.id &&
              protoMsg.editedMessage
            ) {
              const newBody = extractMessageBody({ message: protoMsg.editedMessage } as WAMessage) || '';
              await this.postSignedWebhook({
                eventType: 'message_edited',
                eventId: `edit_${protoMsg.key.id}_${Date.now()}`,
                organizationId,
                whatsappAccountId,
                providerMessageId: protoMsg.key.id,
                remoteJid: primaryJid,
                newBody,
                editedAtMs: Date.now()
              });
              continue;
            }
          }

          const fromMe = Boolean(msg.key.fromMe);
          const body = extractMessageBody(msg);
          const details = getMediaDetails(msg);

          if (!body && !details.isMedia) continue;

          let mediaInfo: { mediaUrl?: string; mediaMimeType?: string; mediaFilename?: string; mediaSizeBytes?: number } = {};
          if (details.isMedia && this.mediaDir) {
            mediaInfo = await downloadAndSaveMedia(msg, this.mediaDir, organizationId, whatsappAccountId);
          }

          const isGroup = primaryJid.endsWith('@g.us');
          const altJid = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
          const effectiveJid = primaryJid.endsWith('@lid') && altJid?.endsWith('@s.whatsapp.net')
            ? altJid
            : primaryJid;
          const participant = msg.key.participant || effectiveJid;
          const fromPhone = extractPhoneFromJid(participant) || extractPhoneFromJid(effectiveJid) || primaryJid;
          const providerMessageId = msg.key.id;

          const ts = typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp * 1000
            : (msg.messageTimestamp as { low?: number } | undefined)?.low
              ? (msg.messageTimestamp as { low: number }).low * 1000
              : Date.now();

          await this.postSignedWebhook({
            eventType: 'inbound_message',
            eventId: `qr_${providerMessageId}`,
            organizationId,
            whatsappAccountId,
            fromPhone: fromPhone.startsWith('+') ? fromPhone : `+${fromPhone}`,
            profileName: msg.pushName ?? null,
            providerMessageId,
            body: body || (details.isMedia ? `[${details.type}]` : ''),
            timestampMs: ts,
            remoteJid: primaryJid,
            isGroup,
            fromMe,
            msgType: details.isMedia ? details.type : 'text',
            mediaUrl: mediaInfo.mediaUrl,
            mediaMimeType: mediaInfo.mediaMimeType,
            mediaFilename: mediaInfo.mediaFilename,
            mediaSizeBytes: mediaInfo.mediaSizeBytes
          });
        }
      } catch (err) {
        this.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Error handling messages.upsert');
      }
    });

    // ── Live Message Updates (Revokes & Edits) ──────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
      try {
        for (const update of updates ?? []) {
          const key = update.key;
          if (!key?.id) continue;
          const updateMsg = (update as { update?: { message?: proto.IMessage } }).update?.message;
          const protoMsg = updateMsg?.protocolMessage;
          if (protoMsg) {
            if (protoMsg.type === proto.Message.ProtocolMessage.Type.REVOKE && protoMsg.key?.id) {
              await this.postSignedWebhook({
                eventType: 'message_revoked',
                eventId: `rev_${protoMsg.key.id}_${Date.now()}`,
                organizationId,
                whatsappAccountId,
                providerMessageId: protoMsg.key.id,
                remoteJid: key.remoteJid,
                deletedByJid: protoMsg.key.participant || key.remoteJid,
                deletedAtMs: Date.now()
              });
            } else if (
              protoMsg.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
              protoMsg.key?.id &&
              protoMsg.editedMessage
            ) {
              const newBody = extractMessageBody({ message: protoMsg.editedMessage } as WAMessage) || '';
              await this.postSignedWebhook({
                eventType: 'message_edited',
                eventId: `edit_${protoMsg.key.id}_${Date.now()}`,
                organizationId,
                whatsappAccountId,
                providerMessageId: protoMsg.key.id,
                remoteJid: key.remoteJid,
                newBody,
                editedAtMs: Date.now()
              });
            }
          }
        }
      } catch (err) {
        this.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Error handling messages.update');
      }
    });

    return this.toSnapshot(session);
  }

  startSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    return this.withSessionLock(sessionKey(organizationId, whatsappAccountId), () =>
      this.openSocket(organizationId, whatsappAccountId, 'start')
    );
  }

  refreshSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    return this.withSessionLock(sessionKey(organizationId, whatsappAccountId), () =>
      this.openSocket(organizationId, whatsappAccountId, 'refresh')
    );
  }

  reconnectSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    return this.withSessionLock(sessionKey(organizationId, whatsappAccountId), () =>
      this.openSocket(organizationId, whatsappAccountId, 'reconnect')
    );
  }

  async restorePersistedSessions(): Promise<{ restored: number; skipped: number; failed: number }> {
    const keys = await this.store.listPersistedSessionKeys();
    let restored = 0;
    let skipped = 0;
    let failed = 0;
    for (const { organizationId, whatsappAccountId } of keys) {
      try {
        const summary = await this.store.readPersistedSummary(organizationId, whatsappAccountId);
        if (!summary?.hasExistingCreds) {
          skipped++;
          continue;
        }
        await this.reconnectSession(organizationId, whatsappAccountId);
        restored++;
      } catch (err) {
        failed++;
        this.logger.warn(
          {
            organizationId,
            whatsappAccountId,
            err: err instanceof Error ? err.message : String(err)
          },
          'Failed to restore persisted QR session on startup'
        );
      }
    }
    return { restored, skipped, failed };
  }

  async getSessionStatus(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    const key = sessionKey(organizationId, whatsappAccountId);
    const existing = this.sessions.get(key);
    if (existing) {
      return this.toSnapshot(existing);
    }

    try {
      const persisted = await this.store.readPersistedSummary(organizationId, whatsappAccountId);
      return {
        organizationId,
        whatsappAccountId,
        status: 'disconnected',
        qrDataUrl: null,
        qrExpiresAt: null,
        phoneNumber: persisted?.phoneNumber ?? null,
        lastConnectedAt: null,
        lastError: persisted?.hasExistingCreds
          ? 'Persisted encrypted session on disk is offline. Click Reconnect.'
          : null
      };
    } catch (err) {
      return {
        organizationId,
        whatsappAccountId,
        status: 'error',
        qrDataUrl: null,
        qrExpiresAt: null,
        phoneNumber: null,
        lastConnectedAt: null,
        lastError: err instanceof Error ? err.message : 'Unable to decrypt persisted session.'
      };
    }
  }

  async disconnectSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    return this.withSessionLock(sessionKey(organizationId, whatsappAccountId), async () => {
      const key = sessionKey(organizationId, whatsappAccountId);
      const cur = this.sessions.get(key);
      if (cur) {
        cur.manuallyDisconnected = true;
        this.clearTimers(cur);
        if (cur.socket) {
          try {
            await cur.socket.logout?.();
          } catch {}
          try {
            cur.socket.end?.();
          } catch {}
          cur.socket = null;
        }
        cur.status = 'disconnected';
        cur.qrDataUrl = null;
        cur.qrExpiresAt = null;
        cur.lastError = null;
      }

      await this.store.clearSession(organizationId, whatsappAccountId);

      const snapshot: QrSessionSnapshot = {
        organizationId,
        whatsappAccountId,
        status: 'disconnected',
        qrDataUrl: null,
        qrExpiresAt: null,
        phoneNumber: cur?.phoneNumber ?? null,
        lastConnectedAt: cur?.lastConnectedAt ?? null,
        lastError: null
      };
      await this.postSignedWebhook({ eventType: 'session_update', ...snapshot });
      return snapshot;
    });
  }

  async sendTextMessage(input: {
    organizationId: string;
    whatsappAccountId: string;
    toPhone: string;
    text: string;
  }): Promise<SendMessageResult> {
    const key = sessionKey(input.organizationId, input.whatsappAccountId);
    const session = this.sessions.get(key);
    if (!session || session.status !== 'connected' || !session.socket) {
      throw new ProviderApiError(
        422,
        'QR_SESSION_NOT_CONNECTED',
        'WhatsApp Web QR session is not connected for this organization.',
        true
      );
    }
    const jid = formatToWhatsAppJid(input.toPhone);
    const sent = await session.socket.sendMessage(jid, { text: input.text });
    return {
      providerMessageId: sent?.key?.id || `qr_out_${crypto.randomUUID()}`,
      recipientWaId: jid.split('@')[0] ?? null
    };
  }
}
