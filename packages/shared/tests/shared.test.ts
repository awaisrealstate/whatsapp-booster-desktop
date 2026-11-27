import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhoneNumber,
  validatePhoneNumber,
  validateContactInput,
  mergeContactsPreserveProgress,
  formatMessageText,
  MAX_SPINTAX_PASSES,
  MAX_MESSAGE_LENGTH,
  sanitizeCsvCell,
  exportContactsToCsv,
  escapeHtml,
  parseCSVText
} from '../src/index.ts';

describe('Phone normalization & validation', () => {
  it('normalizes Pakistani formats consistently', () => {
    assert.equal(normalizePhoneNumber('0300-1234567'), '923001234567');
    assert.equal(normalizePhoneNumber('+92 300 1234567'), '923001234567');
    assert.equal(normalizePhoneNumber('00923001234567'), '923001234567');
    assert.equal(normalizePhoneNumber('3001234567'), '923001234567');
    assert.equal(normalizePhoneNumber('923001234567'), '923001234567');
  });

  it('normalizes international numbers with defaultCountryCode fallback', () => {
    assert.equal(normalizePhoneNumber('0712345678', '44'), '44712345678');
    assert.equal(normalizePhoneNumber('+1 (555) 234-5678', '1'), '15552345678');
  });

  it('rejects invalid, empty, too-short, too-long, and all-zero phone numbers', () => {
    assert.equal(validatePhoneNumber('').valid, false);
    assert.equal(validatePhoneNumber('abc-def').valid, false);
    assert.equal(validatePhoneNumber('0000000000').valid, false);
    assert.equal(validatePhoneNumber('12345').valid, false);
    assert.equal(validatePhoneNumber('12345678901234567').valid, false);
    assert.equal(validatePhoneNumber('03001234567').valid, true);
  });
});

describe('Contact validation & smart merge', () => {
  it('validates contact input and defaults blank names safely', () => {
    const ok = validateContactInput({ name: '  ', phone: '03001234567', company: 'Acme' });
    assert.equal(ok.valid, true);
    assert.equal(ok.contact?.name, 'Valued Client');
    assert.equal(ok.contact?.phone, '923001234567');
    assert.equal(ok.contact?.customVars.company, 'Acme');

    const bad = validateContactInput({ name: 'Test', phone: '123' });
    assert.equal(bad.valid, false);
  });

  it('preserves sent/failed history and skips duplicates on smart merge', () => {
    const existing = [
      { id: 1, name: 'Ali', phone: '923001112233', status: 'sent' as const, sentAt: '10:00 AM', errorMessage: '' }
    ];
    const incoming = [
      { name: 'Ali', phone: '03001112233' },
      { name: 'Ali Dup', phone: '+923001112233' },
      { name: 'Sara', phone: '03212223344' },
      { name: 'Invalid', phone: '99' }
    ];

    const res = mergeContactsPreserveProgress(existing, incoming, {});
    assert.equal(res.contacts.length, 2);
    assert.equal(res.preservedSent, 1);
    assert.equal(res.newlyAdded, 1);
    assert.equal(res.contacts[0]?.status, 'sent');
    assert.equal(res.contacts[1]?.status, 'pending');
    assert.equal(res.nextIndex, 1);
  });
});

describe('Template variables, dollar literals, Spintax bounds & length limits', () => {
  it('substitutes variables including Urdu {نام}, {firstname}, {phone}, and customVars', () => {
    const rendered = formatMessageText(
      'Salam {نام} ({firstname}), phone {phone}, firm {company}.',
      { name: 'Usman Tariq', phone: '923001234567', customVars: { company: 'Crescent' } }
    );
    assert.equal(rendered, 'Salam Usman Tariq (Usman), phone 923001234567, firm Crescent.');
  });

  it('inserts $$, $&, $1, $100 and other dollar combinations literally', () => {
    const rendered = formatMessageText(
      'Name: {name} | First: {firstname} | Phone: {phone} | Offer: {offer}',
      {
        name: '$$ $& $1 $100 $\' $`',
        phone: '$99',
        customVars: {
          offer: 'Save $100 today ($$ / $& / $1 / $99)'
        }
      }
    );
    assert.equal(
      rendered,
      "Name: $$ $& $1 $100 $' $` | First: $$ | Phone: $99 | Offer: Save $100 today ($$ / $& / $1 / $99)"
    );
  });

  it('evaluates Spintax and stops cleanly at MAX_SPINTAX_PASSES = 20', () => {
    const deterministic = formatMessageText(
      '{Hi|Hello} {name}, {good morning|greetings}!',
      { name: 'Zainab' },
      { spintaxStrategy: 'first' }
    );
    assert.equal(deterministic, 'Hi Zainab, good morning!');

    let nested = 'END';
    for (let i = 0; i < 25; i++) {
      nested = `{A${i}|${nested}}`;
    }
    const bounded = formatMessageText(nested, { name: 'Test' }, {
      randomFn: () => 0.99
    });
    assert.equal(MAX_SPINTAX_PASSES, 20);
    assert.equal(typeof bounded, 'string');
    assert.ok(bounded.length > 0);
  });

  it('enforces MAX_MESSAGE_LENGTH = 4096 characters', () => {
    assert.equal(MAX_MESSAGE_LENGTH, 4096);
    const huge = 'A'.repeat(5000);
    const truncated = formatMessageText(huge, { name: 'Ali' });
    assert.equal(truncated.length, 4096);

    assert.throws(() => {
      formatMessageText(huge, { name: 'Ali' }, { strictLength: true });
    }, /4096/);
  });
});

describe('CSV formula injection & HTML escaping regression tests', () => {
  it('neutralizes =, +, -, @, tab, CR, newline and leading whitespace before formula chars', () => {
    assert.equal(sanitizeCsvCell('=CMD("calc")'), `"'=CMD(""calc"")"`);
    assert.equal(sanitizeCsvCell('+1+1'), `"'${'+1+1'}"`);
    assert.equal(sanitizeCsvCell('-2+3'), `"'-2+3"`);
    assert.equal(sanitizeCsvCell('@SUM(1,2)'), `"'@SUM(1,2)"`);
    assert.equal(sanitizeCsvCell('\t=1'), `"'\t=1"`);
    assert.equal(sanitizeCsvCell('\r=1'), `"'\r=1"`);
    assert.equal(sanitizeCsvCell('\n=1'), `"'\n=1"`);
    assert.equal(sanitizeCsvCell('  =1+2'), `"'  =1+2"`);
    assert.equal(sanitizeCsvCell(' \t@SUM(A1)'), `"' \t@SUM(A1)"`);
  });

  it('preserves normal CSV values, leading-space text, Unicode and Urdu text', () => {
    assert.equal(sanitizeCsvCell('Ali Khan'), '"Ali Khan"');
    assert.equal(sanitizeCsvCell('  Normal Name'), '"  Normal Name"');
    assert.equal(sanitizeCsvCell('پاکستان زندہ باد — 🚀'), '"پاکستان زندہ باد — 🚀"');
    assert.equal(sanitizeCsvCell('12345'), '"12345"');
  });

  it('exports contact CSV safely with formula neutralization', () => {
    const csv = exportContactsToCsv([
      {
        id: 1,
        name: '=HYPERLINK("http://evil.example","Click")',
        phone: '923001234567',
        rawPhone: '03001234567',
        customVars: { company: '  +EvilCorp' },
        status: 'failed',
        errorMessage: '\n@bad_error',
        sentAt: null
      }
    ]);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"",""Click"")"`));
    assert.ok(csv.includes(`"'  +EvilCorp"`));
    assert.ok(csv.includes(`"'\n@bad_error"`));
  });

  it('escapes HTML special chars for safe rendering including IDs', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml(42), '42');
  });

  it('parses quoted CSV and TSV lines cleanly', () => {
    const rows = parseCSVText('Name,Phone\n"Khan, Ali",03001234567\nSara,03219876543');
    assert.deepEqual(rows, [
      ['Name', 'Phone'],
      ['Khan, Ali', '03001234567'],
      ['Sara', '03219876543']
    ]);
  });
});
