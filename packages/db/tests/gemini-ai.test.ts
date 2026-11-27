import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb,
  registerUserWithDefaultOrg,
  createContact,
  createOrGetConversation,
  addMessageToConversation,
  getOrInitAiAgent,
  updateAiAgentConfig,
  buildBusinessProfilePrompt,
  handleAiSupportForConversation,
  analyzeConversationLeads,
  type OrgContext,
  type BusinessProfile
} from '../src/index.ts';
import { applyPhase1Migrations, createSqliteD1TestDatabase } from './helpers/sqlite-d1.ts';

describe('Google Gemini AI Chatbot & Business Profile Integration', () => {
  it('saves, loads, and formats business profile knowledge', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const reg = await registerUserWithDefaultOrg(db, {
      email: 'bizowner@example.com',
      name: 'Owner Ali',
      password: 'Password123!'
    });
    const ctx: OrgContext = {
      userId: reg.userId,
      organizationId: reg.organizationId,
      role: 'owner',
      sessionId: 'sess-owner'
    };

    const initial = await getOrInitAiAgent(db, ctx);
    assert.equal(initial.name, 'WhatsApp Support Assistant');
    assert.deepEqual(initial.businessProfile, {});

    const profile: BusinessProfile = {
      businessName: 'SuperStore Electronics',
      businessDescription: 'Leading retailer of gadgets and home appliances in Pakistan.',
      productsAndServices: 'Smartphones, Laptops, LED TVs, Air Conditioners.',
      pricesAndPackages: 'Laptops start at PKR 80,000. Smart TVs start at PKR 65,000.',
      openingHours: 'Mon-Sat 10:00 AM - 10:00 PM',
      location: 'Main Gulberg III, Lahore, Pakistan',
      contactInfo: 'Phone: +92-42-111-222-333, Email: help@superstore.pk',
      faqs: 'Q: Is cash on delivery available? A: Yes, COD is available nationwide.',
      customerServiceInstructions: 'Always verify customer city before confirming COD availability.',
      preferredLanguage: 'English and Urdu',
      tone: 'friendly and welcoming',
      customInstructions: 'Do not discuss competitors.'
    };

    const updated = await updateAiAgentConfig(db, ctx, {
      name: 'SuperStore AI Bot',
      modelId: 'gemini-1.5-flash',
      isEnabled: true,
      businessProfile: profile
    });

    assert.equal(updated.name, 'SuperStore AI Bot');
    assert.equal(updated.modelId, 'gemini-1.5-flash');
    assert.equal(updated.isEnabled, true);
    assert.equal(updated.businessProfile.businessName, 'SuperStore Electronics');
    assert.equal(updated.businessProfile.openingHours, 'Mon-Sat 10:00 AM - 10:00 PM');

    const promptText = buildBusinessProfilePrompt(updated.businessProfile);
    assert.ok(promptText.includes('Business Name: SuperStore Electronics'));
    assert.ok(promptText.includes('Main Gulberg III, Lahore'));
    assert.ok(promptText.includes('Laptops start at PKR 80,000'));
    assert.ok(promptText.includes('cash on delivery'));
  });

  it('generates natural grounded replies via Gemini using business profile knowledge', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const reg = await registerUserWithDefaultOrg(db, {
      email: 'geminitest@example.com',
      name: 'Test Owner',
      password: 'Password123!'
    });
    const ctx: OrgContext = {
      userId: reg.userId,
      organizationId: reg.organizationId,
      role: 'owner',
      sessionId: 'sess-owner'
    };

    await updateAiAgentConfig(db, ctx, {
      isEnabled: true,
      modelId: 'gemini-1.5-flash',
      businessProfile: {
        businessName: 'Mega Logistics',
        openingHours: 'Mon-Fri 9:00 AM - 6:00 PM',
        pricesAndPackages: 'Standard delivery is PKR 250.'
      }
    });

    const contact = await createContact(db, ctx, {
      phone: '+923009998877',
      name: 'Tariq Mehmood'
    });
    assert.ok(contact);
    const conv = await createOrGetConversation(db, ctx, {
      contactId: contact.id,
      channelType: 'official_meta_cloud'
    });

    let mockFetchCalled = false;
    const mockGeminiFetch: typeof fetch = async (input, init) => {
      mockFetchCalled = true;
      const url = String(input);
      assert.ok(url.includes('gemini-1.5-flash'));
      assert.ok(url.includes('key=secret-gemini-key'));

      const body = JSON.parse(String(init?.body));
      assert.ok(body.system_instruction.parts[0].text.includes('Mega Logistics'));
      assert.ok(body.system_instruction.parts[0].text.includes('Standard delivery is PKR 250'));
      assert.equal(body.contents[0].parts[0].text, 'What are your delivery charges?');

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'Our standard delivery charge is PKR 250.' }]
              },
              finishReason: 'STOP'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const replyResult = await handleAiSupportForConversation(db, d1, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      customerText: 'What are your delivery charges?',
      geminiApiKey: 'secret-gemini-key',
      geminiFetchFn: mockGeminiFetch,
      sendOutboundReply: false
    });

    assert.equal(mockFetchCalled, true);
    assert.equal(replyResult.status, 'replied');
    assert.ok(replyResult.replyText?.includes('PKR 250'));
  });

  it('triggers safe human handoff when Gemini outputs [HANDOFF] or customer requests human', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const reg = await registerUserWithDefaultOrg(db, {
      email: 'handoff@example.com',
      name: 'Handoff Owner',
      password: 'Password123!'
    });
    const ctx: OrgContext = {
      userId: reg.userId,
      organizationId: reg.organizationId,
      role: 'owner',
      sessionId: 'sess-owner'
    };

    await updateAiAgentConfig(db, ctx, {
      isEnabled: true,
      businessProfile: { businessName: 'Test Biz' },
      handoffKeywords: ['human', 'agent', 'support']
    });

    const contact = await createContact(db, ctx, {
      phone: '+923005551234',
      name: 'Hamza'
    });
    assert.ok(contact);
    const conv = await createOrGetConversation(db, ctx, {
      contactId: contact.id,
      channelType: 'official_meta_cloud'
    });

    // 1. Keyword handoff
    const handoffRes = await handleAiSupportForConversation(db, d1, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      customerText: 'Please connect me to a human support agent.',
      geminiApiKey: 'secret-gemini-key',
      sendOutboundReply: false
    });
    assert.equal(handoffRes.status, 'handoff');

    // 2. Gemini model returning [HANDOFF]
    const mockHandoffFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: '[HANDOFF]' }] },
              finishReason: 'STOP'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const modelHandoffRes = await handleAiSupportForConversation(db, d1, {
      organizationId: ctx.organizationId,
      conversationId: conv.id,
      customerText: 'Can I get a custom refund on order #999?',
      geminiApiKey: 'secret-gemini-key',
      geminiFetchFn: mockHandoffFetch,
      sendOutboundReply: false
    });
    assert.equal(modelHandoffRes.status, 'handoff');
  });

  it('analyzes customer leads and retention using analyzeConversationLeads', async () => {
    const { sqlite, d1 } = createSqliteD1TestDatabase();
    applyPhase1Migrations(sqlite);
    const db = createDb(d1);

    const reg = await registerUserWithDefaultOrg(db, {
      email: 'leads@example.com',
      name: 'Leads Owner',
      password: 'Password123!'
    });
    const ctx: OrgContext = {
      userId: reg.userId,
      organizationId: reg.organizationId,
      role: 'owner',
      sessionId: 'sess-owner'
    };

    await updateAiAgentConfig(db, ctx, {
      businessProfile: { businessName: 'RealEstate Booster' }
    });

    const contact = await createContact(db, ctx, {
      phone: '+923218889900',
      name: 'Usman Ghani'
    });
    assert.ok(contact);
    const conv = await createOrGetConversation(db, ctx, {
      contactId: contact.id,
      channelType: 'official_meta_cloud'
    });

    await addMessageToConversation(db, ctx, conv.id, {
      direction: 'inbound',
      senderKind: 'contact',
      msgType: 'text',
      body: 'I am interested in 1-kanal plots in DHA Phase 6. What are the current prices?'
    });

    const mockAnalysisFetch: typeof fetch = async () => {
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
                      followUpReason: 'Customer ready to buy DHA Phase 6 plot',
                      churnRisk: 'low',
                      sentiment: 'positive',
                      customerNeeds: ['1-kanal plot', 'DHA Phase 6'],
                      suggestedAction: 'Send price list and call customer today',
                      summary: 'High intent buyer asking for 1 kanal DHA 6 inventory.'
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

    const analysis = await analyzeConversationLeads(db, ctx, {
      conversationId: conv.id,
      geminiApiKey: 'test-key',
      fetchFn: mockAnalysisFetch
    });

    assert.equal(analysis.leadIntentScore, 'high');
    assert.equal(analysis.pricingQueryDetected, true);
    assert.equal(analysis.followUpRequired, true);
    assert.ok(analysis.suggestedAction.includes('price list'));
  });
});
