import type { ContactRecord } from './contact.ts';

const FORMULA_PREFIX_RE = /^\s*[=+\-@\t\r\n]/;

/**
 * Neutralizes CSV/Excel formula injection (DDE / spreadsheet formula execution)
 * by prefixing values starting with (optional leading whitespace +) '=', '+', '-', '@',
 * tab, carriage return, or newline with a single quote.
 */
export function sanitizeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = FORMULA_PREFIX_RE.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function formatCsvRow(cells: readonly unknown[]): string {
  return cells.map(sanitizeCsvCell).join(',');
}

export function exportContactsToCsv(contacts: readonly ContactRecord[]): string {
  const header = 'ID,Name,Phone,Company,Status,DispatchedAt,Error';
  const rows = contacts.map((c) => {
    const company = c.customVars?.company ?? '';
    return formatCsvRow([
      c.id,
      c.name,
      c.phone,
      company,
      c.status,
      c.sentAt ?? '',
      c.errorMessage
    ]);
  });
  return [header, ...rows].join('\n');
}

/**
 * Escapes HTML special characters for safe DOM table rendering.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

/**
 * RFC-style CSV / TSV / semicolon parser extracted from ui/lib/csv-parser.js.
 */
export function parseCSVText(text: string): string[][] {
  if (!text) return [];

  let source = text;
  if (source.charCodeAt(0) === 0xfeff) {
    source = source.slice(1);
  }

  const firstLine = source.split(/\r\n|\r|\n/)[0] ?? '';
  let delimiter = ',';
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semiCount = (firstLine.match(/;/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;

  if (semiCount > commaCount && semiCount > tabCount) delimiter = ';';
  else if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const nextChar = source[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes) {
      if (char === delimiter) {
        currentRow.push(currentCell.trim());
        currentCell = '';
        continue;
      }

      if (char === '\r' || char === '\n') {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        currentRow.push(currentCell.trim());
        if (currentRow.some((cell) => cell !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
        continue;
      }
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}
