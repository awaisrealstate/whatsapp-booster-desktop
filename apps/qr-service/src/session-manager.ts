import crypto from 'node:crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeWASocket,
  type AuthenticationState,
  type BaileysEventMap,
  type ConnectionState,
  type WAMessage
} from '@whiskeysockets/baileys';
import {
  computeBridgeSignature,
  ProviderApiError,
  type QrBridgeInboundEvent,
  type QrBridgeSessionEvent,
  type QrBridgeStatus,
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

export class QrSessionManager {
  private readonly store: EncryptedSessionStore;
  private readonly socketFactory: WaSocketFactory;
  private readonly qrTtlMs: number;
  private readonly bridgeSecret: string;
  private readonly webhookUrl: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly logger = pino({ level: 'info' });

  constructor(options: {
    store: EncryptedSessionStore;
    bridgeSecret: string;
    webhookUrl?: string | null;
    qrTtlMs?: number;
    socketFactory?: WaSocketFactory;
    fetchFn?: typeof fetch;
  }) {
    this.store = options.store;
    this.bridgeSecret = options.bridgeSecret;
    this.webhookUrl = options.webhookUrl?.trim() || null;
    this.qrTtlMs = options.qrTtlMs ?? 60_000;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.socketFactory =
      options.socketFactory ??
      (async ({ auth }) => {
        let version: [number, number, number] | undefined;
        try {
          const v = await fetchLatestWaWebVersion({});
          version = v.version;
        } catch {
          // Baileys falls back to bundled version if metadata endpoint unreachable
        }
        return makeWASocket({
          auth,
          version,
          logger: pino({ level: 'silent' }),
          printQRInTerminal: false,
          browser: Browsers.windows('WhatsApp Booster Pro'),
          syncFullHistory: false,
          markOnlineOnConnect: false
        }) as unknown as MinimalWaSocket;
      });
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

  private async postSignedWebhook(payload: QrBridgeSessionEvent | QrBridgeInboundEvent): Promise<void> {
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

        if (cur.manuallyDisconnected) {
          cur.status = 'disconnected';
          cur.qrDataUrl = null;
          cur.qrExpiresAt = null;
        } else if (statusCode === DisconnectReason.loggedOut) {
          await loaded.clear();
          cur.status = 'disconnected';
          cur.qrDataUrl = null;
          cur.qrExpiresAt = null;
          cur.lastError = 'Session logged out from WhatsApp phone Linked Devices. Scan QR again.';
        } else if (
          loaded.hasExistingCreds &&
          cur.reconnectAttempts < 3 &&
          statusCode !== DisconnectReason.forbidden
        ) {
          cur.reconnectAttempts += 1;
          cur.status = 'connecting';
          cur.lastError = `Reconnecting (${cur.reconnectAttempts}/3): ${reasonText}`;
          const backoffMs = Math.min(2000 * cur.reconnectAttempts, 10_000);
          cur.reconnectTimer = setTimeout(() => {
            void this.openSocket(organizationId, whatsappAccountId, 'reconnect');
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

    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages ?? []) {
        if (!msg.key || msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid ?? '';
        if (!remoteJid.endsWith('@s.whatsapp.net')) continue;
        const body = extractMessageBody(msg);
        if (!body) continue;
        const fromPhone = extractPhoneFromJid(remoteJid);
        if (!fromPhone) continue;

        const providerMessageId = msg.key.id || crypto.randomUUID();
        await this.postSignedWebhook({
          eventType: 'inbound_message',
          eventId: `qr_${providerMessageId}`,
          organizationId,
          whatsappAccountId,
          fromPhone,
          profileName: msg.pushName ?? null,
          providerMessageId,
          body,
          timestampMs: Date.now()
        });
      }
    });

    return this.toSnapshot(session);
  }

  startSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    return this.openSocket(organizationId, whatsappAccountId, 'start');
  }

  refreshSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    return this.openSocket(organizationId, whatsappAccountId, 'refresh');
  }

  reconnectSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    return this.openSocket(organizationId, whatsappAccountId, 'reconnect');
  }

  async getSessionStatus(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    const key = sessionKey(organizationId, whatsappAccountId);
    const existing = this.sessions.get(key);
    if (existing) {
      return this.toSnapshot(existing);
    }

    const hasPersisted = await this.store.hasSessionFile(organizationId, whatsappAccountId);
    return {
      organizationId,
      whatsappAccountId,
      status: 'disconnected',
      qrDataUrl: null,
      qrExpiresAt: null,
      phoneNumber: null,
      lastConnectedAt: null,
      lastError: hasPersisted
        ? 'Persisted encrypted session on disk is offline. Click Reconnect.'
        : null
    };
  }

  async disconnectSession(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
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
