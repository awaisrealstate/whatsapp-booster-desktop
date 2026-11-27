import { readSheet } from 'read-excel-file/universal';
import { parseCSVText } from './csv.ts';
import { validatePhoneNumber } from './phone.ts';

export interface DetectedColumns {
  phoneIndex: number;
  nameIndex: number;
  companyIndex: number;
  emailIndex: number;
  tagIndex: number;
}

export interface ImportedContactRow {
  rowNumber: number;
  name: string;
  phone: string;
  rawPhone: string;
  email: string | null;
  company: string | null;
  tags: string[];
  customVars: Record<string, string>;
}

export interface InvalidImportRow {
  rowNumber: number;
  rawPhone: string;
  rawName: string;
  reasons: string[];
}

export interface DuplicateImportRow {
  rowNumber: number;
  phone: string;
  rawName: string;
}

export interface SpreadsheetImportPreview {
  totalDataRows: number;
  headers: string[];
  detectedColumns: DetectedColumns;
  validContacts: ImportedContactRow[];
  duplicates: DuplicateImportRow[];
  invalidRows: InvalidImportRow[];
}

const PHONE_KEYWORDS = [
  'phone', 'mobile', 'whatsapp', 'number', 'cell', 'contact', 'tel', 'cellphone',
  'موبائل', 'نمبر', 'فون', 'واٹسایپ'
];
const NAME_KEYWORDS = [
  'name', 'fullname', 'full_name', 'first_name', 'firstname', 'client', 'customer',
  'person', 'lead', 'نام'
];
const COMPANY_KEYWORDS = ['company', 'organization', 'business', 'firm', 'کمپنی', 'ادارہ'];
const EMAIL_KEYWORDS = ['email', 'mail', 'ایمیل'];
const TAG_KEYWORDS = ['tag', 'tags', 'category', 'label', 'group', 'کیٹیگری', 'ٹیگ'];

export function detectSpreadsheetColumns(headers: readonly string[]): DetectedColumns {
  let phoneIndex = -1;
  let nameIndex = -1;
  let companyIndex = -1;
  let emailIndex = -1;
  let tagIndex = -1;

  headers.forEach((h, idx) => {
    const normalized = String(h ?? '')
      .toLowerCase()
      .trim()
      .replace(/[\s_-]/g, '');
    if (!normalized) return;

    if (phoneIndex === -1 && PHONE_KEYWORDS.some((kw) => normalized.includes(kw))) {
      phoneIndex = idx;
    } else if (nameIndex === -1 && NAME_KEYWORDS.some((kw) => normalized.includes(kw))) {
      nameIndex = idx;
    } else if (companyIndex === -1 && COMPANY_KEYWORDS.some((kw) => normalized.includes(kw))) {
      companyIndex = idx;
    } else if (emailIndex === -1 && EMAIL_KEYWORDS.some((kw) => normalized.includes(kw))) {
      emailIndex = idx;
    } else if (tagIndex === -1 && TAG_KEYWORDS.some((kw) => normalized.includes(kw))) {
      tagIndex = idx;
    }
  });

  return { phoneIndex, nameIndex, companyIndex, emailIndex, tagIndex };
}

export function detectSpreadsheetColumnsByData(rows: readonly string[][]): DetectedColumns {
  if (rows.length === 0) {
    return { phoneIndex: 0, nameIndex: 1, companyIndex: -1, emailIndex: -1, tagIndex: -1 };
  }

  const colScores: Array<{ phoneScore: number; nameScore: number; emailScore: number }> = [];
  const sampleRows = rows.slice(0, 15);

  for (const row of sampleRows) {
    row.forEach((val, idx) => {
      if (!colScores[idx]) {
        colScores[idx] = { phoneScore: 0, nameScore: 0, emailScore: 0 };
      }
      const str = String(val ?? '').trim();
      const clean = str.replace(/[\s\-+()]/g, '');
      if (/^\d{8,15}$/.test(clean)) {
        colScores[idx]!.phoneScore++;
      } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
        colScores[idx]!.emailScore++;
      } else if (/[a-zA-Z\u0600-\u06FF]/.test(str) && !/^\d+$/.test(clean)) {
        colScores[idx]!.nameScore++;
      }
    });
  }

  let bestPhoneIdx = 0;
  let maxPhoneScore = -1;
  colScores.forEach((score, idx) => {
    if (score.phoneScore > maxPhoneScore) {
      maxPhoneScore = score.phoneScore;
      bestPhoneIdx = idx;
    }
  });

  let bestNameIdx = bestPhoneIdx === 0 ? 1 : 0;
  let maxNameScore = -1;
  colScores.forEach((score, idx) => {
    if (idx !== bestPhoneIdx && score.nameScore > maxNameScore) {
      maxNameScore = score.nameScore;
      bestNameIdx = idx;
    }
  });

  let bestEmailIdx = -1;
  colScores.forEach((score, idx) => {
    if (idx !== bestPhoneIdx && idx !== bestNameIdx && score.emailScore > 0 && bestEmailIdx === -1) {
      bestEmailIdx = idx;
    }
  });

  return {
    phoneIndex: bestPhoneIdx,
    nameIndex: bestNameIdx,
    companyIndex: -1,
    emailIndex: bestEmailIdx,
    tagIndex: -1
  };
}

/**
 * Checks OLE2 Compound Document magic bytes (D0 CF 11 E0 A1 B1 1A E1) used by legacy binary .xls files.
 */
export function isLegacyBinaryXls(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  );
}

/**
 * Safely parses modern .xlsx files using MIT-licensed `read-excel-file/universal`
 * (zero reliance on vulnerable xlsx@0.18.5). Rejects legacy binary .xls explicitly.
 */
export async function parseXlsxRows(input: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) {
    throw new Error('Spreadsheet file is empty.');
  }

  if (isLegacyBinaryXls(bytes)) {
    throw new Error(
      'LEGACY_XLS_UNSUPPORTED: Legacy binary .xls files are not supported by the safe cloud parser. Please re-save the file as .xlsx or .csv.'
    );
  }

  const sheetData = await readSheet(bytes);
  return sheetData.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return '';
      if (cell instanceof Date) return cell.toISOString();
      return String(cell).trim();
    })
  );
}

export function buildContactImportPreview(
  rows: readonly (readonly unknown[])[],
  defaultCountryCode = '92'
): SpreadsheetImportPreview {
  const normalizedRows: string[][] = rows
    .map((row) => row.map((cell) => String(cell ?? '').trim()))
    .filter((row) => row.some((cell) => cell !== ''));

  if (normalizedRows.length === 0) {
    return {
      totalDataRows: 0,
      headers: [],
      detectedColumns: { phoneIndex: 0, nameIndex: 1, companyIndex: -1, emailIndex: -1, tagIndex: -1 },
      validContacts: [],
      duplicates: [],
      invalidRows: []
    };
  }

  const firstRow = normalizedRows[0]!;
  const headerDetect = detectSpreadsheetColumns(firstRow);
  let hasHeader = headerDetect.phoneIndex !== -1 || headerDetect.nameIndex !== -1;

  if (!hasHeader) {
    const firstRowHasPhone = firstRow.some((val) => /^\d{8,15}$/.test(val.replace(/[\s\-+()]/g, '')));
    hasHeader = !firstRowHasPhone;
  }

  const headers = hasHeader ? firstRow : firstRow.map((_, idx) => `col_${idx + 1}`);
  const dataRows = hasHeader ? normalizedRows.slice(1) : normalizedRows;
  const detected = hasHeader ? detectSpreadsheetColumns(headers) : detectSpreadsheetColumnsByData(dataRows);

  if (detected.phoneIndex === -1 || detected.nameIndex === -1) {
    const fallback = detectSpreadsheetColumnsByData(dataRows);
    if (detected.phoneIndex === -1) detected.phoneIndex = fallback.phoneIndex;
    if (detected.nameIndex === -1) detected.nameIndex = fallback.nameIndex;
    if (detected.emailIndex === -1) detected.emailIndex = fallback.emailIndex;
  }

  const seenPhones = new Set<string>();
  const validContacts: ImportedContactRow[] = [];
  const duplicates: DuplicateImportRow[] = [];
  const invalidRows: InvalidImportRow[] = [];

  dataRows.forEach((row, idx) => {
    const rowNumber = (hasHeader ? 2 : 1) + idx;
    const rawPhone = row[detected.phoneIndex] ?? '';
    const rawName = row[detected.nameIndex] ?? '';
    const rawCompany = detected.companyIndex >= 0 ? row[detected.companyIndex] ?? '' : '';
    const rawEmail = detected.emailIndex >= 0 ? row[detected.emailIndex] ?? '' : '';
    const rawTags = detected.tagIndex >= 0 ? row[detected.tagIndex] ?? '' : '';

    const phoneCheck = validatePhoneNumber(rawPhone, defaultCountryCode);
    if (!phoneCheck.valid) {
      invalidRows.push({
        rowNumber,
        rawPhone,
        rawName,
        reasons: [phoneCheck.reason ?? 'Invalid phone number.']
      });
      return;
    }

    if (seenPhones.has(phoneCheck.phone)) {
      duplicates.push({
        rowNumber,
        phone: phoneCheck.phone,
        rawName: rawName || 'Valued Client'
      });
      return;
    }
    seenPhones.add(phoneCheck.phone);

    const customVars: Record<string, string> = {};
    row.forEach((cellVal, colIdx) => {
      const hName = headers[colIdx]?.trim() || `col_${colIdx + 1}`;
      customVars[hName.toLowerCase()] = cellVal;
      customVars[`var${colIdx + 1}`] = cellVal;
    });

    const tags = rawTags
      .split(/[,;|]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= 40);

    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail.toLowerCase() : null;
    const name = rawName.trim().slice(0, 120) || 'Valued Client';
    const company = rawCompany.trim().slice(0, 120) || null;

    if (company) customVars.company = company;
    customVars.name = name;
    customVars.phone = phoneCheck.phone;

    validContacts.push({
      rowNumber,
      name,
      phone: phoneCheck.phone,
      rawPhone,
      email,
      company,
      tags,
      customVars
    });
  });

  return {
    totalDataRows: dataRows.length,
    headers,
    detectedColumns: detected,
    validContacts,
    duplicates,
    invalidRows
  };
}

export async function previewSpreadsheetImport(params: {
  format: 'csv' | 'tsv' | 'xlsx';
  text?: string;
  xlsxBytes?: ArrayBuffer | Uint8Array;
  defaultCountryCode?: string;
}): Promise<SpreadsheetImportPreview> {
  let rows: string[][];
  if (params.format === 'xlsx') {
    if (!params.xlsxBytes) {
      throw new Error('XLSX binary payload is required.');
    }
    rows = await parseXlsxRows(params.xlsxBytes);
  } else {
    rows = parseCSVText(params.text ?? '');
  }
  return buildContactImportPreview(rows, params.defaultCountryCode ?? '92');
}
