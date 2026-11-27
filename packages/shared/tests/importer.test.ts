import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  previewSpreadsheetImport,
  buildLegacyMigrationPlan,
  isLegacyBinaryXls
} from '../src/index.ts';

/**
 * Builds a minimal valid OpenXML .xlsx ZIP buffer in memory using Node's built-in zlib
 * so tests exercise real `read-excel-file/universal` parsing end-to-end without xlsx@0.18.5.
 */
function buildMinimalXlsxBuffer(rows: string[][]): Uint8Array {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const sheetRowsXml = rows
    .map((row, rIdx) => {
      const cellsXml = row
        .map((val, cIdx) => {
          const col = String.fromCharCode(65 + cIdx);
          return `<c r="${col}${rIdx + 1}" t="inlineStr"><is><t>${esc(val)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rIdx + 1}">${cellsXml}</row>`;
    })
    .join('');

  const files: Array<{ name: string; data: Uint8Array }> = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>'
      )
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>'
      )
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
      )
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>'
      )
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<sheetData>${sheetRowsXml}</sheetData></worksheet>`
      )
    }
  ];

  // Minimal CRC32 table for ZIP generation
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

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(file.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(file.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

describe('Phase 2 Contact Importer (CSV, TSV, XLSX, Urdu & Legacy .xls guard)', () => {
  it('parses Urdu and English headers, normalizes +92 & international numbers, detects duplicates & invalid rows', async () => {
    const csv = [
      'نام,موبائل,کمپنی,ایمیل,Tags',
      'Ali Khan,0300-1234567,Apex,ali@apex.pk,"vip,lahore"',
      'Ali Dup,+92 300 1234567,Apex,,',
      'UK Client,+44 7911 123456,London Co,uk@london.co,international',
      'Bad Contact,123,BadCo,,'
    ].join('\n');

    const preview = await previewSpreadsheetImport({
      format: 'csv',
      text: csv,
      defaultCountryCode: '92'
    });

    assert.equal(preview.totalDataRows, 4);
    assert.equal(preview.validContacts.length, 2);
    assert.equal(preview.duplicates.length, 1);
    assert.equal(preview.invalidRows.length, 1);

    assert.equal(preview.validContacts[0]?.phone, '923001234567');
    assert.equal(preview.validContacts[0]?.company, 'Apex');
    assert.deepEqual(preview.validContacts[0]?.tags, ['vip', 'lahore']);
    assert.equal(preview.validContacts[1]?.phone, '447911123456');
  });

  it('parses TSV paste rows without headers using data-content column detection', async () => {
    const tsv = '03211112233\tUsman Tariq\n03334445566\tZainab Fatima';
    const preview = await previewSpreadsheetImport({
      format: 'tsv',
      text: tsv
    });

    assert.equal(preview.validContacts.length, 2);
    assert.equal(preview.validContacts[0]?.phone, '923211112233');
    assert.equal(preview.validContacts[0]?.name, 'Usman Tariq');
    assert.equal(preview.validContacts[1]?.phone, '923334445566');
  });

  it('parses modern .xlsx buffer safely using read-excel-file/universal', async () => {
    const xlsxBytes = buildMinimalXlsxBuffer([
      ['Name', 'Phone', 'Company', 'City'],
      ['Sara Ahmed', '0345-9876543', 'Crescent', 'Karachi'],
      ['Invalid Row', '0000', 'None', 'N/A']
    ]);

    const preview = await previewSpreadsheetImport({
      format: 'xlsx',
      xlsxBytes,
      defaultCountryCode: '92'
    });

    assert.equal(preview.validContacts.length, 1);
    assert.equal(preview.invalidRows.length, 1);
    assert.equal(preview.validContacts[0]?.phone, '923459876543');
    assert.equal(preview.validContacts[0]?.customVars.city, 'Karachi');
  });

  it('rejects legacy binary .xls OLE2 files explicitly without touching xlsx@0.18.5', async () => {
    const fakeOle2Xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    assert.equal(isLegacyBinaryXls(fakeOle2Xls), true);

    await assert.rejects(
      () => previewSpreadsheetImport({ format: 'xlsx', xlsxBytes: fakeOle2Xls }),
      /LEGACY_XLS_UNSUPPORTED/
    );
  });
});

describe('Legacy State Reconciliation (campaign_state.json vs localStorage)', () => {
  it('reconciles fresher localStorage state and unions sentPhoneHistory without losing sent progress', () => {
    const plan = buildLegacyMigrationPlan({
      campaignState: {
        updatedAt: 1000,
        template: 'Old template',
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
        dailyLimit: 30,
        batchSentCount: 1,
        contacts: [
          { name: 'Ali', phone: '03001112233', status: 'sent', sentAt: '10:00 AM' },
          { name: 'Sara', phone: '03212223344', status: 'pending' }
        ],
        sentPhoneHistory: {
          '923001112233': { status: 'sent', sentAt: '10:00 AM' }
        }
      },
      localStorageState: {
        updatedAt: 2000,
        template: 'New template {name}',
        batchSentCount: 2,
        contacts: [
          { name: 'Ali', phone: '03001112233', status: 'sent', sentAt: '10:00 AM' },
          { name: 'Sara', phone: '03212223344', status: 'failed', errorMessage: 'Not on WA' },
          { name: 'Usman', phone: '03334445566', status: 'pending' }
        ],
        sentPhoneHistory: {
          '923212223344': { status: 'failed', errorMessage: 'Not on WA' }
        }
      }
    });

    assert.equal(plan.sourceChosen, 'merged_both');
    assert.equal(plan.templateText, 'New template {name}');
    assert.equal(plan.contacts.length, 3);
    assert.equal(plan.sentCount, 1);
    assert.equal(plan.failedCount, 1);
    assert.equal(plan.pendingCount, 1);
    assert.ok(plan.tagsToEnsure.includes('legacy:sent'));
    assert.ok(plan.tagsToEnsure.includes('legacy:failed'));
  });
});
