import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateGeminiContent,
  analyzeLeadsAndRetentionWithGemini,
  GeminiApiError,
  DEFAULT_GEMINI_MODEL
} from '../src/gemini.ts';

describe('Gemini Provider Unit Tests', () => {
  it('throws GeminiApiError when API key is missing', async () => {
    await assert.rejects(
      async () => {
        await generateGeminiContent({
          apiKey: '',
          contents: [{ role: 'user', text: 'Hello' }]
        });
      },
      (err: unknown) => err instanceof GeminiApiError
    );
  });

  it('throws GeminiApiError when prompt contents are empty', async () => {
    await assert.rejects(
      async () => {
        await generateGeminiContent({
          apiKey: 'test-key',
          contents: [{ role: 'user', text: '   ' }]
        });
      },
      (err: unknown) => err instanceof GeminiApiError
    );
  });

  it('generates content successfully using mock fetch', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      assert.ok(url.includes('gemini-1.5-flash'));
      assert.ok(url.includes('key=test-gemini-key'));

      const body = JSON.parse(String(init?.body));
      assert.equal(body.contents.length, 1);
      assert.equal(body.contents[0].parts[0].text, 'What are your hours?');
      assert.ok(body.system_instruction.parts[0].text.includes('Store Assistant'));

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'We are open Mon-Fri 9am to 6pm.' }]
              },
              finishReason: 'STOP'
            }
          ],
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 12,
            totalTokenCount: 27
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await generateGeminiContent({
      apiKey: 'test-gemini-key',
      systemInstruction: 'Store Assistant: Answer politely.',
      contents: [{ role: 'user', text: 'What are your hours?' }],
      fetchFn: mockFetch
    });

    assert.equal(res.text, 'We are open Mon-Fri 9am to 6pm.');
    assert.equal(res.model, DEFAULT_GEMINI_MODEL);
    assert.equal(res.totalTokens, 27);
  });

  it('handles quota exceeded 429 response cleanly', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Resource has been exhausted (e.g. check quota).',
            status: 'RESOURCE_EXHAUSTED'
          }
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    };

    await assert.rejects(
      async () => {
        await generateGeminiContent({
          apiKey: 'test-key',
          contents: [{ role: 'user', text: 'test' }],
          fetchFn: mockFetch
        });
      },
      /QUOTA_EXCEEDED/
    );
  });

  it('analyzes leads and customer retention properly', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      leadIntentScore: 'high',
                      isInterested: true,
                      pricingQueryDetected: true,
                      followUpRequired: true,
                      followUpReason: 'Customer inquired about 500-seat enterprise plan',
                      churnRisk: 'low',
                      sentiment: 'positive',
                      customerNeeds: ['Bulk messaging', 'Multi-agent inbox'],
                      suggestedAction: 'Send enterprise proposal and schedule a demo',
                      summary: 'Customer wants enterprise quote for 500 agents.'
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const analysis = await analyzeLeadsAndRetentionWithGemini({
      apiKey: 'test-key',
      customerName: 'Muhammad Ali',
      customerPhone: '+923001234567',
      businessProfile: { businessName: 'WhatsApp Booster' },
      messages: [
        { direction: 'inbound', body: 'Hi, what are the enterprise pricing packages?' }
      ],
      fetchFn: mockFetch
    });

    assert.equal(analysis.leadIntentScore, 'high');
    assert.equal(analysis.isInterested, true);
    assert.equal(analysis.pricingQueryDetected, true);
    assert.equal(analysis.followUpRequired, true);
    assert.equal(analysis.sentiment, 'positive');
    assert.ok(analysis.suggestedAction.includes('enterprise proposal'));
  });
});
