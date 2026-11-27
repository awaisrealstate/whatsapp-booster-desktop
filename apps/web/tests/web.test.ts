import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Cloud CRM Web Dashboard (apps/web) 15-module coverage & security hygiene', () => {
  const webDir = path.resolve(import.meta.dirname, '..');
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');

  it('includes all 15 required SaaS dashboard modules', () => {
    for (const viewId of [
      'view-overview',
      'view-contacts',
      'view-lists',
      'view-tags',
      'view-conversations',
      'view-whatsapp',
      'view-templates',
      'view-campaigns',
      'view-reports',
      'view-ai-support',
      'view-knowledge',
      'view-team',
      'view-roles',
      'view-subscription',
      'view-settings'
    ]) {
      assert.ok(html.includes(viewId), `Missing ${viewId}`);
    }
  });

  it('uses escapeHtml and sanitizeCsvCell, OAuth2 buttons, avoids xlsx@0.18.5 and 1s polling burn', () => {
    assert.ok(js.includes('export function escapeHtml('));
    assert.ok(js.includes('export function sanitizeCsvCell('));
    assert.ok(js.includes('/api/v1/auth/oauth/'));
    assert.ok(!js.includes('xlsx.full.min.js'));
    assert.ok(js.includes("ext === 'xls'"));
    assert.ok(js.includes('20_000'));
  });

  it('includes Option A (Official Meta API) and Option B (Unofficial QR Code) UI + compliance notice', () => {
    assert.ok(html.includes('Option A: Meta Official Cloud API'));
    assert.ok(html.includes('Option B: Connect Using QR Code'));
    assert.ok(html.includes('Official Meta API'));
    assert.ok(html.includes('Unofficial WhatsApp Web Session – Baileys'));
    assert.ok(html.includes('Session disconnection'));
    assert.ok(html.includes('Compatibility changes'));
    assert.ok(html.includes('WhatsApp account restrictions'));
    assert.ok(html.includes('Potential account bans'));
    assert.ok(html.includes('qr-compliance-banner'));
    assert.ok(html.includes('btn-qr-refresh'));
    assert.ok(html.includes('btn-qr-reconnect'));
    assert.ok(html.includes('btn-qr-disconnect'));
    assert.ok(js.includes('export function formatQrStatusLabel('));
    assert.ok(js.includes('/api/v1/whatsapp/accounts/qr/start'));
    assert.ok(js.includes('/api/v1/whatsapp/accounts/meta/verify'));
  });
});
