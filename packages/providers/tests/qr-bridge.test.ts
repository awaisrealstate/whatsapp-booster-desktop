import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBridgeSignature,
  MetaCloudProvider,
  ProviderApiError,
  QrBridgeClient,
  verifyBridgeSignature
} from '../src/index.ts';

describe('Meta Credential Verification & Signed QR Bridge Client', () => {
  it('verifies Meta Cloud API phone credentials and throws ProviderApiError on invalid token', async () => {
    const okProvider = new MetaCloudProvider({
      fetchFn: async (url) => {
        assert.match(String(url), /\/12345678\?fields=display_phone_number,verified_name$/);
        return new Response(
          JSON.stringify({
            id: '12345678',
            display_phone_number: '+92 300 1112233',
            verified_name: 'Awais Official Store'
          }),
          { status: 200 }
        );
      }
    });

    const verified = await okProvider.verifyAccountCredentials('12345678', 'EAAG-valid-token');
    assert.equal(verified.valid, true);
    assert.equal(verified.phoneNumber, '+92 300 1112233');
    assert.equal(verified.verifiedName, 'Awais Official Store');

    const failProvider = new MetaCloudProvider({
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token.' } }), {
          status: 401
        })
    });

    await assert.rejects(
      () => failProvider.verifyAccountCredentials('12345678', 'bad-token'),
      (err: unknown) => err instanceof ProviderApiError && err.code === 'META_190' && err.retryable === false
    );
  });

  it('computes and verifies HMAC-SHA256 QR Bridge signatures with replay window', async () => {
    const secret = 'test-qr-bridge-secret-32-chars!!';
    const now = 1_700_000_000_000;
    const body = JSON.stringify({ organizationId: 'org-1', whatsappAccountId: 'acc-1' });
    const sig = await computeBridgeSignature(secret, now, 'POST', '/internal/sessions/start', body);

    assert.equal(
      await verifyBridgeSignature({
        secret,
        timestampHeader: String(now),
        signatureHeader: sig,
        method: 'POST',
        path: '/internal/sessions/start',
        rawBody: body,
        nowMs: now + 30_000
      }),
      true
    );

    // Reject expired timestamp (> 5 min skew) and tampered body
    assert.equal(
      await verifyBridgeSignature({
        secret,
        timestampHeader: String(now),
        signatureHeader: sig,
        method: 'POST',
        path: '/internal/sessions/start',
        rawBody: body,
        nowMs: now + 10 * 60_000
      }),
      false
    );

    assert.equal(
      await verifyBridgeSignature({
        secret,
        timestampHeader: String(now),
        signatureHeader: sig,
        method: 'POST',
        path: '/internal/sessions/start',
        rawBody: '{"tampered":true}',
        nowMs: now
      }),
      false
    );
  });

  it('signs outgoing QR Bridge client calls and rejects missing secret', async () => {
    assert.throws(() => new QrBridgeClient({ baseUrl: 'http://127.0.0.1:8790', secret: 'short' }));

    let capturedSig = '';
    const client = new QrBridgeClient({
      baseUrl: 'http://127.0.0.1:8790',
      secret: 'qr-bridge-secret-32-chars-minimum!',
      fetchFn: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        capturedSig = headers['X-Bridge-Signature'] || '';
        return new Response(
          JSON.stringify({
            organizationId: 'org-1',
            whatsappAccountId: 'acc-1',
            status: 'waiting_for_scan',
            qrDataUrl: 'data:image/png;base64,AAA',
            qrExpiresAt: Date.now() + 60_000,
            phoneNumber: null,
            lastConnectedAt: null,
            lastError: null
          }),
          { status: 200 }
        );
      }
    });

    const snap = await client.startSession({ organizationId: 'org-1', whatsappAccountId: 'acc-1' });
    assert.equal(snap.status, 'waiting_for_scan');
    assert.match(capturedSig, /^v1=[0-9a-f]{64}$/);
  });
});
