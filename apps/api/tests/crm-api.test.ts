import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';
import { createDb, registerUserWithDefaultOrg, createSessionForUser } from '@wacrm/db';
import {
  createSqliteD1TestDatabase,
  applyPhase1Migrations
} from '../../../packages/db/tests/helpers/sqlite-d1.ts';

function buildMinimalXlsxBase64(rows: string[][]): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sheetRowsXml = rows
    .map((row, rIdx) => {
      const cellsXml = row
        .map((val, cIdx) => `<c r="${String.fromCharCode(65 + cIdx)}${rIdx + 1}" t="inlineStr"><is><t>${esc(val)}</t></is></c>`)
        .join('');
      return `<row r="${rIdx + 1}">${cellsXml}</row>`;
    })
    .join('');

  const files = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
      )
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
      )
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
      )
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      )
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRowsXml}</sheetData></worksheet>`
      )
    }
  ];

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(file.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    localParts.push(lh, nameBuf, compressed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(file.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + compressed.length;
  }
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cd, eocd]).toString('base64');
}

async function createTestContext() {
  const { sqlite, d1 } = createSqliteD1TestDatabase();
  applyPhase1Migrations(sqlite);
  const db = createDb(d1);

  const alice = await registerUserWithDefaultOrg(db, {
    email: 'alice@example.com',
    name: 'Alice',
    password: 'Password123!'
  });
  const bob = await registerUserWithDefaultOrg(db, {
    email: 'bob@example.com',
    name: 'Bob',
    password: 'Password123!'
  });
  const aliceSession = await createSessionForUser(db, {
    userId: alice.userId,
    activeOrganizationId: alice.organizationId
  });
  const bobSession = await createSessionForUser(db, {
    userId: bob.userId,
    activeOrganizationId: bob.organizationId
  });

  const app = createApp({ logger: createLogger('error') });
  const env = { DB: d1, APP_ENV: 'development' };

  return { app, env, alice, bob, aliceToken: aliceSession.rawToken, bobToken: bobSession.rawToken };
}

describe('Phase 2 CRM API Authorization, Contacts, Lists, Tags, Consent & Conversations', () => {
  it('blocks unauthenticated (401) and cross-organization (403 / 404) CRM requests', async () => {
    const { app, env, alice, bobToken } = await createTestContext();

    const unauth = await app.request('/api/v1/crm/contacts', {}, env);
    assert.equal(unauth.status, 401);

    const crossHeader = await app.request(
      '/api/v1/crm/contacts',
      {
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'X-Organization-Id': alice.organizationId
        }
      },
      env
    );
    assert.equal(crossHeader.status, 403);
  });

  it('executes full CRM workflow across contacts, tags, lists, consent, conversations & legacy import', async () => {
    const { app, env, aliceToken, bobToken } = await createTestContext();
    const authHeaders = {
      Authorization: `Bearer ${aliceToken}`,
      'Content-Type': 'application/json'
    };

    // 1. Contact CRUD + search + soft delete
    const createRes = await app.request(
      '/api/v1/crm/contacts',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Hamza Tariq', phone: '0312-9990011', company: 'Alpha' })
      },
      env
    );
    assert.equal(createRes.status, 201);
    const { contact } = (await createRes.json()) as { contact: { id: string; phone: string } };
    assert.equal(contact.phone, '923129990011');

    // Bob cannot read Alice's contact
    const bobRead = await app.request(
      `/api/v1/crm/contacts/${contact.id}`,
      { headers: { Authorization: `Bearer ${bobToken}` } },
      env
    );
    assert.equal(bobRead.status, 404);

    // 2. Preview XLSX & reject legacy .xls
    const xlsxBase64 = buildMinimalXlsxBase64([
      ['نام', 'نمبر', 'کمپنی'],
      ['Bilal', '0322-5556677', 'Sterling']
    ]);
    const previewRes = await app.request(
      '/api/v1/crm/contacts/import/preview',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ format: 'xlsx', xlsxBase64 })
      },
      env
    );
    assert.equal(previewRes.status, 200);
    const previewJson = (await previewRes.json()) as { preview: { validContacts: Array<{ phone: string }> } };
    assert.equal(previewJson.preview.validContacts[0]?.phone, '923225556677');

    const xlsBytesBase64 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).toString('base64');
    const xlsRejectRes = await app.request(
      '/api/v1/crm/contacts/import/preview',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ format: 'xlsx', xlsxBase64: xlsBytesBase64 })
      },
      env
    );
    assert.equal(xlsRejectRes.status, 422);

    // 3. Bulk import + List + Tag
    const importRes = await app.request(
      '/api/v1/crm/contacts/import',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          listName: 'Phase 2 Import',
          contacts: previewJson.preview.validContacts
        })
      },
      env
    );
    assert.equal(importRes.status, 201);

    const tagRes = await app.request(
      '/api/v1/crm/tags',
      { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Priority' }) },
      env
    );
    const { tag } = (await tagRes.json()) as { tag: { id: string } };
    const assignRes = await app.request(
      `/api/v1/crm/contacts/${contact.id}/tags`,
      { method: 'POST', headers: authHeaders, body: JSON.stringify({ tagId: tag.id }) },
      env
    );
    assert.equal(assignRes.status, 201);

    // 4. Consent & STOP opt-out survives soft delete
    const stopRes = await app.request(
      '/api/v1/crm/consent/stop',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ phone: '03129990011', reason: 'stop_keyword' })
      },
      env
    );
    assert.equal(stopRes.status, 201);

    const delRes = await app.request(
      `/api/v1/crm/contacts/${contact.id}`,
      { method: 'DELETE', headers: authHeaders },
      env
    );
    assert.equal(delRes.status, 200);

    const eligRes = await app.request(
      '/api/v1/crm/consent/eligibility?phone=03129990011',
      { headers: authHeaders },
      env
    );
    const eligJson = (await eligRes.json()) as { eligible: boolean };
    assert.equal(eligJson.eligible, false);

    // 5. Conversations & Messages
    const contactsListRes = await app.request('/api/v1/crm/contacts', { headers: authHeaders }, env);
    const contactsList = (await contactsListRes.json()) as { items: Array<{ id: string }> };
    const importedId = contactsList.items[0]!.id;

    const convRes = await app.request(
      '/api/v1/crm/conversations',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ contactId: importedId })
      },
      env
    );
    assert.equal(convRes.status, 201);
    const { conversation } = (await convRes.json()) as { conversation: { id: string } };

    const msgRes = await app.request(
      `/api/v1/crm/conversations/${conversation.id}/messages`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          direction: 'outbound',
          senderKind: 'agent',
          body: 'Welcome to CRM!'
        })
      },
      env
    );
    assert.equal(msgRes.status, 201);

    // 6. Legacy State Import (Dry Run then Commit)
    const dryRes = await app.request(
      '/api/v1/crm/legacy-import',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          dryRun: true,
          campaignState: {
            contacts: [{ name: 'Legacy User', phone: '03451112233', status: 'sent' }],
            sentPhoneHistory: { '923451112233': { status: 'sent', sentAt: '12:00 PM' } }
          }
        })
      },
      env
    );
    assert.equal(dryRes.status, 200);
    const dryJson = (await dryRes.json()) as { dryRun: boolean; summary: { wouldCreate: number } };
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.summary.wouldCreate, 1);

    const commitRes = await app.request(
      '/api/v1/crm/legacy-import',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          dryRun: false,
          campaignState: {
            contacts: [{ name: 'Legacy User', phone: '03451112233', status: 'sent' }],
            sentPhoneHistory: { '923451112233': { status: 'sent', sentAt: '12:00 PM' } }
          }
        })
      },
      env
    );
    assert.equal(commitRes.status, 201);

    // 7. Rejects javascript: sourceUrl on list creation and returns 409 on duplicate tag rename
    const badListRes = await app.request(
      '/api/v1/crm/lists',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Bad URL List', sourceUrl: 'javascript:alert(1)' })
      },
      env
    );
    assert.equal(badListRes.status, 400);

    const secondTagRes = await app.request(
      '/api/v1/crm/tags',
      { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Warm' }) },
      env
    );
    assert.equal(secondTagRes.status, 201);
    const secondTagJson = (await secondTagRes.json()) as { tag: { id: string } };
    const dupRenameRes = await app.request(
      `/api/v1/crm/tags/${secondTagJson.tag.id}`,
      { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ name: 'Priority' }) },
      env
    );
    assert.equal(dupRenameRes.status, 409);
  });
});
