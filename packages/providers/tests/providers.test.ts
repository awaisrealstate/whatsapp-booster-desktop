import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetaCloudProvider, ProviderApiError, isStopOptOutText } from '../src/index.ts';

async function computeMetaSig(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('STOP keyword detection', () => {
  it('recognizes English and Urdu STOP opt-out keywords accurately', () => {
    assert.equal(isStopOptOutText('STOP'), true);
    assert.equal(isStopOptOutText('  stop. '), true);
    assert.equal(isStopOptOutText('Unsubscribe!'), true);
    assert.equal(isStopOptOutText('opt out'), true);
    assert.equal(isStopOptOutText('روکیں'), true);
    assert.equal(isStopOptOutText('Please send me pricing details'), false);
    assert.equal(isStopOptOutText(''), false);
  });
});

describe('MetaCloudProvider webhook challenge, HMAC-SHA256 signature & payload parsing', () => {
  it('verifies GET webhook hub.challenge using verify token or SHA-256 hash', async () => {
    const provider = new MetaCloudProvider();
    const ok = await provider.verifyWebhookChallenge({
      mode: 'subscribe',
      verifyToken: 'my-secret-verify-token',
      challenge: 'challenge-12345',
      expectedVerifyToken: 'my-secret-verify-token'
    });
    assert.deepEqual(ok, { valid: true, challenge: 'challenge-12345' });

    const bad = await provider.verifyWebhookChallenge({
      mode: 'subscribe',
      verifyToken: 'wrong-token',
      challenge: 'challenge-12345',
      expectedVerifyToken: 'my-secret-verify-token'
    });
    assert.deepEqual(bad, { valid: false, challenge: null });
  });

  it('verifies X-Hub-Signature-256 strictly using constant-time HMAC-SHA256', async () => {
    const provider = new MetaCloudProvider();
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const appSecret = 'meta-app-secret-xyz';
    const validSig = await computeMetaSig(payload, appSecret);

    assert.equal(await provider.verifyWebhookSignature(payload, validSig, appSecret), true);
    assert.equal(await provider.verifyWebhookSignature(payload + ' ', validSig, appSecret), false);
    assert.equal(await provider.verifyWebhookSignature(payload, 'sha256=deadbeef', appSecret), false);
    assert.equal(await provider.verifyWebhookSignature(payload, undefined, appSecret), false);
  });

  it('parses inbound messages (including STOP) and delivery status updates from Meta payload', () => {
    const provider = new MetaCloudProvider();
    const events = provider.parseWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '100200300400' },
                contacts: [{ wa_id: '923001112233', profile: { name: 'Ali Khan' } }],
                messages: [
                  {
                    id: 'wamid.in.1',
                    from: '923001112233',
                    timestamp: '1795000000',
                    type: 'text',
                    text: { body: 'STOP' }
                  }
                ],
                statuses: [
                  {
                    id: 'wamid.out.1',
                    status: 'delivered',
                    timestamp: '1795000010',
                    recipient_id: '923215556677'
                  },
                  {
                    id: 'wamid.out.2',
                    status: 'failed',
                    timestamp: '1795000020',
                    recipient_id: '923339998877',
                    errors: [{ code: 131026, message: 'Message undeliverable' }]
                  }
                ]
              }
            }
          ]
        }
      ]
    });

    assert.equal(events.length, 3);
    assert.equal(events[0]?.kind, 'inbound_message');
    if (events[0]?.kind === 'inbound_message') {
      assert.equal(events[0].isStopKeyword, true);
      assert.equal(events[0].profileName, 'Ali Khan');
    }
    assert.equal(events[1]?.kind, 'status_update');
    if (events[1]?.kind === 'status_update') {
      assert.equal(events[1].status, 'delivered');
    }
    if (events[2]?.kind === 'status_update') {
      assert.equal(events[2].status, 'failed');
      assert.equal(events[2].errorCode, '131026');
    }
  });
});

describe('MetaCloudProvider messaging, 24h window & error retry classification', () => {
  it('enforces 24h customer care window for freeform text and calls Graph API for approved templates', async () => {
    const calls: Array<{ url: string; body: string; auth: string }> = [];
    const provider = new MetaCloudProvider({
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          body: String(init?.body ?? ''),
          auth: String((init?.headers as Record<string, string>)?.Authorization ?? '')
        });
        return new Response(
          JSON.stringify({
            messages: [{ id: 'wamid.sent.999' }],
            contacts: [{ wa_id: '923001234567' }]
          }),
          { status: 200 }
        );
      }
    });

    // Freeform fails when outside 24h window
    await assert.rejects(
      () =>
        provider.sendFreeformText({
          phoneNumberId: '123456789',
          accessToken: 'token-abc',
          toPhone: '923001234567',
          body: 'Hello!',
          serviceWindowExpiresAt: 1000,
          now: 2000
        }),
      (err: unknown) => err instanceof ProviderApiError && err.code === 'OUTSIDE_24H_WINDOW' && !err.retryable
    );

    // Template send succeeds even outside 24h window
    const res = await provider.sendTemplateMessage({
      phoneNumberId: '123456789',
      accessToken: 'token-abc',
      toPhone: '+92 300 1234567',
      templateName: 'promo_launch',
      languageCode: 'en_US',
      bodyParameters: ['Ali']
    });
    assert.equal(res.providerMessageId, 'wamid.sent.999');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://graph.facebook.com/v21.0/123456789/messages');
  });

  it('marks HTTP 429/5xx Meta errors retryable and HTTP 400 non-retryable', async () => {
    const rateLimited = new MetaCloudProvider({
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { code: 130429, message: 'Throughput limit hit' } }), { status: 429 })
    });
    await assert.rejects(
      () =>
        rateLimited.sendTemplateMessage({
          phoneNumberId: '123456789',
          accessToken: 'token',
          toPhone: '923001234567',
          templateName: 'hello_world',
          languageCode: 'en_US'
        }),
      (err: unknown) => err instanceof ProviderApiError && err.retryable === true
    );

    const badRequest = new MetaCloudProvider({
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { code: 132001, message: 'Template does not exist' } }), { status: 400 })
    });
    await assert.rejects(
      () =>
        badRequest.sendTemplateMessage({
          phoneNumberId: '123456789',
          accessToken: 'token',
          toPhone: '923001234567',
          templateName: 'missing_tpl',
          languageCode: 'en_US'
        }),
      (err: unknown) => err instanceof ProviderApiError && err.retryable === false
    );
  });
});
