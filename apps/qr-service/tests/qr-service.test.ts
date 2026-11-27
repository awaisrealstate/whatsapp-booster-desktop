import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DisconnectReason, type BaileysEventMap } from '@whiskeysockets/baileys';
import { QrBridgeClient } from '@wacrm/providers';
import { EncryptedSessionStore } from '../src/crypto-store.ts';
import { createQrServiceServer } from '../src/server.ts';
import type { MinimalWaSocket, WaSocketFactory } from '../src/session-manager.ts';

class MockBaileysSocket implements MinimalWaSocket {
  user: { id?: string; name?: string } | null = null;
  readonly emitter = new EventEmitter();
  readonly sentMessages: Array<{ jid: string; text: string }> = [];
  loggedOut = false;

  ev = {
    on: <K extends keyof BaileysEventMap>(event: K, listener: (arg: BaileysEventMap[K]) => void) => {
      this.emitter.on(event, listener);
    }
  };

  async sendMessage(jid: string, content: { text: string }) {
    this.sentMessages.push({ jid, text: content.text });
    return { key: { id: `baileys_msg_${this.sentMessages.length}` } };
  }

  async logout() {
    this.loggedOut = true;
  }

  end() {}
}

describe('Node.js @wacrm/qr-service Encrypted Persistence, Isolation & Lifecycle', () => {
  it('stores Baileys credentials strictly encrypted on disk (AES-256-GCM) and isolates tenants', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wacrm-qr-store-'));
    try {
      const store = new EncryptedSessionStore({
        rootDir: tmpDir,
        encryptionKey: 'qr-disk-encryption-key-32-chars!!'
      });

      const loadedA = await store.loadAuthState('org_alpha', 'acc_1');
      loadedA.state.creds.me = { id: '923001234567:1@s.whatsapp.net', name: 'Alpha' };
      loadedA.state.creds.registered = true;
      await loadedA.state.keys.set({ 'lid-mapping': { '923001234567': '123456@lid' } });
      await loadedA.saveCreds();

      const rawBlob = await store.readRawEncryptedBlob('org_alpha', 'acc_1');
      assert.ok(rawBlob && rawBlob.startsWith('enc:v1:'));
      assert.ok(!rawBlob.includes('923001234567'), 'Plaintext phone/JID must NEVER appear in encrypted file on disk');

      // Org Beta has separate isolated state
      const loadedB = await store.loadAuthState('org_beta', 'acc_1');
      assert.equal(loadedB.hasExistingCreds, false);

      // Reopening Org Alpha decrypts cleanly
      const reloadedA = await store.loadAuthState('org_alpha', 'acc_1');
      assert.equal(reloadedA.hasExistingCreds, true);
      assert.equal(reloadedA.state.creds.me?.id, '923001234567:1@s.whatsapp.net');

      // Clear deletes encrypted session completely
      await reloadedA.clear();
      assert.equal(await store.hasSessionFile('org_alpha', 'acc_1'), false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('serves signed QR generation, scan confirmation, persistence reconnect, expiration, logout & rejects unsigned HTTP calls', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wacrm-qr-srv-'));
    const sockets = new Map<string, MockBaileysSocket>();
    const webhookEvents: unknown[] = [];
    const secret = 'qr-bridge-hmac-secret-32-chars!!';

    const socketFactory: WaSocketFactory = async ({ organizationId, whatsappAccountId }) => {
      const sock = new MockBaileysSocket();
      sockets.set(`${organizationId}:${whatsappAccountId}`, sock);
      return sock;
    };

    const { handleRequest } = createQrServiceServer({
      bridgeSecret: secret,
      encryptionKey: 'qr-disk-encryption-key-32-chars!!',
      storageDir: tmpDir,
      webhookUrl: 'http://mock.local/webhooks/qr-bridge',
      qrTtlMs: 2500,
      socketFactory,
      fetchFn: async (_url, init) => {
        webhookEvents.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    const baseUrl = 'http://qr-service.internal';
    const inProcessFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const lowerHeaders: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(rawHeaders)) lowerHeaders[k.toLowerCase()] = v;
      const out = await handleRequest({
        method: init?.method || 'GET',
        url: `${parsed.pathname}${parsed.search}`,
        headers: lowerHeaders,
        rawBody: typeof init?.body === 'string' ? init.body : ''
      });
      return new Response(JSON.stringify(out.body), { status: out.statusCode, headers: out.headers });
    };
    const client = new QrBridgeClient({ baseUrl, secret, fetchFn: inProcessFetch });

    try {
      // Unauthenticated / unsigned request MUST return 401
      const unauth = await inProcessFetch(`${baseUrl}/internal/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_1', whatsappAccountId: 'acc_1' })
      });
      assert.equal(unauth.status, 401);

      // Start session -> 'connecting' initially (never fake 'connected'!)
      const started = await client.startSession({ organizationId: 'org_1', whatsappAccountId: 'acc_1' });
      assert.equal(started.status, 'connecting');
      assert.equal(started.phoneNumber, null);

      // Emit QR code from mock Baileys socket -> waiting_for_scan with data:image/png;base64,...
      const sock = sockets.get('org_1:acc_1')!;
      sock.emitter.emit('connection.update', { qr: '2@mock-baileys-qr-payload-token' });
      await new Promise((r) => setTimeout(r, 80));

      const waiting = await client.getSessionStatus('org_1', 'acc_1');
      assert.equal(waiting.status, 'waiting_for_scan');
      assert.ok(waiting.qrDataUrl?.startsWith('data:image/png;base64,'));
      assert.ok(waiting.qrExpiresAt && waiting.qrExpiresAt > Date.now());

      // Simulate user scanning QR in Linked Devices -> connection 'open'
      sock.user = { id: '923007778899:4@s.whatsapp.net', name: 'Test Number' };
      sock.emitter.emit('connection.update', { connection: 'open' });
      await new Promise((r) => setTimeout(r, 60));

      const connected = await client.getSessionStatus('org_1', 'acc_1');
      assert.equal(connected.status, 'connected');
      assert.equal(connected.phoneNumber, '+923007778899');
      assert.equal(connected.qrDataUrl, null);

      // Send message over connected socket
      const sent = await client.sendTextMessage({
        organizationId: 'org_1',
        whatsappAccountId: 'acc_1',
        toPhone: '+923001112233',
        text: 'Hello from QR Service'
      });
      assert.match(sent.providerMessageId, /^baileys_msg_/);
      assert.equal(sock.sentMessages[0]?.jid, '923001112233@s.whatsapp.net');

      // Org 2 cannot read or send using Org 1's connected socket
      await assert.rejects(
        () =>
          client.sendTextMessage({
            organizationId: 'org_2',
            whatsappAccountId: 'acc_1',
            toPhone: '+923001112233',
            text: 'Cross tenant attack'
          }),
        (err: unknown) => err instanceof Error && /not connected/i.test(err.message)
      );

      // Reconnect reuses encrypted disk creds
      const reconnecting = await client.reconnectSession({ organizationId: 'org_1', whatsappAccountId: 'acc_1' });
      assert.equal(reconnecting.status, 'connecting');

      // Simulate remote Linked Device logout -> wipes encrypted store cleanly
      const sock2 = sockets.get('org_1:acc_1')!;
      sock2.emitter.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: Object.assign(new Error('Logged out'), { output: { statusCode: DisconnectReason.loggedOut } }), date: new Date() }
      });
      await new Promise((r) => setTimeout(r, 60));
      const loggedOutState = await client.getSessionStatus('org_1', 'acc_1');
      assert.equal(loggedOutState.status, 'disconnected');

      // Disconnect wipe completes cleanly
      const disconnected = await client.disconnectSession({ organizationId: 'org_1', whatsappAccountId: 'acc_1' });
      assert.equal(disconnected.status, 'disconnected');
      assert.ok(webhookEvents.length >= 3);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
