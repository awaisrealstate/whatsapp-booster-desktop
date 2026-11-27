import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Legacy dashboard.js security hygiene regressions', () => {
  const dashboardPath = path.resolve(import.meta.dirname, '../../../ui/dashboard.js');
  const source = fs.readFileSync(dashboardPath, 'utf8');

  it('escapes c.id in audience table HTML rendering', () => {
    assert.ok(source.includes('<td>${escapeHtml(c.id || idx + 1)}</td>'));
    assert.ok(!source.includes('<td>${c.id || idx + 1}</td>'));
  });

  it('neutralizes CSV formula injection including newline and leading whitespace in btn-export-csv', () => {
    assert.ok(source.includes('function sanitizeCsvCell(value)'));
    assert.ok(source.includes('/^\\s*[=+\\-@\\t\\r\\n]/.test(str)'));
    assert.ok(source.includes('sanitizeCsvCell(c.name'));
    assert.ok(source.includes('sanitizeCsvCell(co)'));
    assert.ok(source.includes('sanitizeCsvCell(c.errorMessage'));
  });
});

describe('Hardened Electron shell security regressions', () => {
  const rootDir = path.resolve(import.meta.dirname, '../../..');
  const mainJs = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const preloadMain = fs.readFileSync(path.join(rootDir, 'preload-main.js'), 'utf8');
  const bridgeJs = fs.readFileSync(path.join(rootDir, 'ui/bridge.js'), 'utf8');

  it('enforces nodeIntegration=false, contextIsolation=true, webSecurity=true, sandbox=true & contextBridge preload', () => {
    assert.ok(mainJs.includes('nodeIntegration: false'));
    assert.ok(mainJs.includes('contextIsolation: true'));
    assert.ok(mainJs.includes('webSecurity: true'));
    assert.ok(mainJs.includes('sandbox: true'));
    assert.ok(!mainJs.includes('nodeIntegration: true'));
    assert.ok(preloadMain.includes('contextBridge.exposeInMainWorld'));
    assert.ok(!indexHtml.includes("require('electron')"));
    assert.ok(indexHtml.includes('event.source !== dashboardFrame.contentWindow'));
    assert.ok(bridgeJs.includes('event.source !== window.parent'));
  });
});
