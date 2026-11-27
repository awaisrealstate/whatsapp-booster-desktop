/**
 * WhatsApp CRM Pro - Universal Data Parser
 * Supports:
 * - Pakistani Number Normalization (0092, +92, 92, 03xx, 3xx)
 * - Native Microsoft Excel (.xlsx, .xls) via bundled SheetJS
 * - Direct Copy-Paste from Microsoft Excel / Excel Online
 * - Google Sheets Live Share Link
 * - OneDrive / Microsoft 365 Shared Links
 * - CSV, TSV, and Delimited TXT
 */

window.WACRMParser = (function () {
  'use strict';

  /**
   * Pakistani & International Phone Normalizer
   * Accepts:
   * 923184681002 -> 923184681002
   * 00923184681002 -> 923184681002
   * +923184681002 -> 923184681002
   * 03184681002 -> 923184681002
   * 3184681002 -> 923184681002
   */
  function normalizePhone(rawPhone, defaultCountryCode = '92') {
    if (!rawPhone) return '';

    let cleaned = String(rawPhone).trim().replace(/[\s\-\(\)\.\–\—]/g, '');
    if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);

    cleaned = cleaned.replace(/\D/g, '');
    if (!cleaned) return '';

    // Handle 0092 prefix -> converts 0092318... to 92318...
    if (cleaned.startsWith('0092')) {
      cleaned = cleaned.substring(2);
    } else if (cleaned.startsWith('00')) {
      cleaned = cleaned.substring(2);
    }

    // 1. Pakistani format: already has 92 (12 digits, e.g. 923184681002)
    if (cleaned.startsWith('92') && (cleaned.length === 12 || cleaned.length === 11)) {
      return cleaned;
    }

    // 2. Pakistani local format: starts with 03 (11 digits, e.g. 03184681002) -> 923184681002
    if (cleaned.startsWith('03') && cleaned.length === 11) {
      return '92' + cleaned.substring(1);
    }

    // 3. Pakistani without 0: starts with 3 (10 digits, e.g. 3184681002) -> 923184681002
    if (cleaned.startsWith('3') && cleaned.length === 10) {
      return '92' + cleaned;
    }

    // 4. General national format: starts with 0
    const cc = String(defaultCountryCode).replace(/\D/g, '') || '92';
    if (cleaned.startsWith('0') && cleaned.length >= 9 && cleaned.length <= 11) {
      return cc + cleaned.substring(1);
    }

    // 5. Short 10 digits
    if (cleaned.length === 10 && !cleaned.startsWith(cc)) {
      return cc + cleaned;
    }

    return cleaned;
  }

  function parseCSVText(text) {
    if (!text) return [];

    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.substr(1);
    }

    const firstLine = text.split(/\r\n|\r|\n/)[0] || '';
    let delimiter = ',';
    const commaCount = (firstLine.match(/,/g) || []).length;
    const semiCount = (firstLine.match(/;/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;

    if (semiCount > commaCount && semiCount > tabCount) delimiter = ';';
    else if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';

    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;
    let i = 0;
    const len = text.length;

    while (i < len) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          currentCell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = !inQuotes;
          i++;
          continue;
        }
      }

      if (!inQuotes) {
        if (char === delimiter) {
          currentRow.push(currentCell.trim());
          currentCell = '';
          i++;
          continue;
        }

        if (char === '\r' || char === '\n') {
          if (char === '\r' && nextChar === '\n') {
            i++;
          }
          currentRow.push(currentCell.trim());
          if (currentRow.some(c => c !== '')) {
            rows.push(currentRow);
          }
          currentRow = [];
          currentCell = '';
          i++;
          continue;
        }
      }

      currentCell += char;
      i++;
    }

    if (currentCell.length > 0 || currentRow.length > 0) {
      currentRow.push(currentCell.trim());
      if (currentRow.some(c => c !== '')) {
        rows.push(currentRow);
      }
    }

    return rows;
  }

  function detectColumns(headers) {
    const phoneKeywords = ['phone', 'mobile', 'whatsapp', 'number', 'cell', 'contact', 'tel', 'cellphone', 'موبائل', 'نمبر'];
    const nameKeywords = ['name', 'fullname', 'full_name', 'first_name', 'firstname', 'client', 'customer', 'person', 'lead', 'نام'];
    const companyKeywords = ['company', 'organization', 'business', 'tag', 'category'];

    let phoneIndex = -1;
    let nameIndex = -1;
    let companyIndex = -1;

    headers.forEach((h, idx) => {
      const lower = String(h).toLowerCase().trim().replace(/[\s_\-]/g, '');
      if (phoneIndex === -1 && phoneKeywords.some(kw => lower.includes(kw))) {
        phoneIndex = idx;
      }
      if (nameIndex === -1 && nameKeywords.some(kw => lower.includes(kw))) {
        nameIndex = idx;
      }
      if (companyIndex === -1 && companyKeywords.some(kw => lower.includes(kw))) {
        companyIndex = idx;
      }
    });

    return { phoneIndex, nameIndex, companyIndex };
  }

  function detectColumnsByData(rows) {
    if (!rows.length) return { phoneIndex: 0, nameIndex: 1, companyIndex: -1 };

    const colScores = [];
    const sampleRows = rows.slice(0, 15);

    sampleRows.forEach(row => {
      row.forEach((val, idx) => {
        if (!colScores[idx]) colScores[idx] = { phoneScore: 0, nameScore: 0 };
        const clean = String(val).replace(/[\s\-\+\(\)]/g, '');
        if (/^\d{8,15}$/.test(clean)) {
          colScores[idx].phoneScore++;
        } else if (/[a-zA-Z\u0600-\u06FF]/.test(val) && !/^\d+$/.test(clean)) {
          colScores[idx].nameScore++;
        }
      });
    });

    let bestPhoneIdx = 0;
    let maxPhoneScore = -1;
    let bestNameIdx = 1;
    let maxNameScore = -1;

    colScores.forEach((score, idx) => {
      if (score.phoneScore > maxPhoneScore) {
        maxPhoneScore = score.phoneScore;
        bestPhoneIdx = idx;
      }
    });

    colScores.forEach((score, idx) => {
      if (idx !== bestPhoneIdx && score.nameScore > maxNameScore) {
        maxNameScore = score.nameScore;
        bestNameIdx = idx;
      }
    });

    return { phoneIndex: bestPhoneIdx, nameIndex: bestNameIdx, companyIndex: -1 };
  }

  function rowsToContacts(rows, defaultCountryCode = '92') {
    if (!rows || rows.length === 0) return [];

    let headers = [];
    let dataRows = [];
    let hasHeader = false;

    const firstRow = rows[0];
    const detected = detectColumns(firstRow);

    if (detected.phoneIndex !== -1 || detected.nameIndex !== -1) {
      hasHeader = true;
      headers = firstRow;
      dataRows = rows.slice(1);
    } else {
      const firstRowLooksLikeData = firstRow.some(val => {
        const clean = String(val).replace(/[\s\-\+\(\)]/g, '');
        return /^\d{8,15}$/.test(clean);
      });

      if (!firstRowLooksLikeData) {
        hasHeader = true;
        headers = firstRow;
        dataRows = rows.slice(1);
      } else {
        hasHeader = false;
        dataRows = rows;
      }
    }

    let { phoneIndex, nameIndex } = hasHeader ? detectColumns(headers) : { phoneIndex: -1, nameIndex: -1 };

    if (phoneIndex === -1 || nameIndex === -1) {
      const byData = detectColumnsByData(dataRows);
      if (phoneIndex === -1) phoneIndex = byData.phoneIndex;
      if (nameIndex === -1) nameIndex = byData.nameIndex;
    }

    const contacts = [];
    let idCounter = 1;

    dataRows.forEach(row => {
      if (!row || row.length === 0) return;

      const rawPhone = row[phoneIndex] || '';
      const rawName = row[nameIndex] || '';
      const normalizedPhone = normalizePhone(rawPhone, defaultCountryCode);

      if (!normalizedPhone && !rawName) return;

      const customVars = {};
      row.forEach((cellVal, colIdx) => {
        const headerName = (headers[colIdx] && headers[colIdx].trim()) || `col_${colIdx + 1}`;
        customVars[headerName.toLowerCase()] = String(cellVal || '').trim();
        customVars[`var${colIdx + 1}`] = String(cellVal || '').trim();
      });

      contacts.push({
        id: idCounter++,
        name: String(rawName).trim() || 'Valued Client',
        phone: normalizedPhone,
        rawPhone: String(rawPhone).trim(),
        customVars,
        status: 'pending',
        errorMessage: '',
        sentAt: null
      });
    });

    return contacts;
  }

  function parseExcelArrayBuffer(arrayBuffer, defaultCountryCode = '92') {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS engine not found.');
    }

    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error('Empty or invalid Excel workbook.');
    }

    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    return rowsToContacts(rawRows, defaultCountryCode);
  }

  function formatGoogleSheetUrl(url) {
    if (!url) return '';
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match || !match[1]) return url;
    const sheetId = match[1];

    const gidMatch = url.match(/[#&?]gid=([0-9]+)/);
    const gid = gidMatch ? `&gid=${gidMatch[1]}` : '';

    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gid}`;
  }

  async function fetchLiveSpreadsheet(sheetUrl, defaultCountryCode = '92') {
    const trimmed = sheetUrl.trim();
    const isOneDrive = /1drv\.ms|onedrive\.live\.com|sharepoint\.com|office\.com/i.test(trimmed);
    const isGoogleDocs = /docs\.google\.com\/spreadsheets/i.test(trimmed);

    if (isOneDrive) {
      let downloadUrl = trimmed;
      if (downloadUrl.includes('onedrive.live.com/view.aspx')) {
        downloadUrl = downloadUrl.replace('/view.aspx', '/download.aspx');
      } else if (!downloadUrl.includes('download=1')) {
        downloadUrl += (downloadUrl.includes('?') ? '&' : '?') + 'download=1';
      }

      try {
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`Status ${response.status}`);
        const buffer = await response.arrayBuffer();
        return parseExcelArrayBuffer(buffer, defaultCountryCode);
      } catch (e) {
        throw new Error(
          'Microsoft Excel Online requires login permissions to download directly via link.\n\n' +
          '💡 Easy 1-second solutions for Excel Online:\n' +
          '1. Direct Copy-Paste: Select cells in Excel Online (Ctrl+C) and paste into the "Manual Paste" box.\n' +
          '2. Download File: Click File -> Save As -> Download a Copy (.xlsx) and drop it into the dropzone.'
        );
      }
    }

    if (isGoogleDocs) {
      const fetchViaHost = (targetUrl) =>
        new Promise((resolve) => {
          if (!window.parent || window.parent === window) return resolve('');
          const reqId = `gs_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const onMsg = (ev) => {
            if (ev.source !== window.parent || !ev.data || ev.data.action !== 'HOST_GOOGLE_SHEET_RESULT' || ev.data.requestId !== reqId) return;
            window.removeEventListener('message', onMsg);
            resolve(ev.data.ok ? ev.data.text || '' : '');
          };
          window.addEventListener('message', onMsg);
          setTimeout(() => { window.removeEventListener('message', onMsg); resolve(''); }, 10_000);
          window.parent.postMessage({ action: 'HOST_FETCH_GOOGLE_SHEET', requestId: reqId, url: targetUrl }, '*');
        });

      const exportUrl = formatGoogleSheetUrl(trimmed);
      let csvText = '';
      try {
        const response = await fetch(exportUrl);
        if (response.ok) {
          csvText = await response.text();
        }
      } catch (e) {}
      if (!csvText) {
        csvText = await fetchViaHost(exportUrl);
      }

      // Fallback to gviz API if export was blocked or returned HTML login
      if (!csvText || csvText.includes('<!DOCTYPE html>') || csvText.includes('<html')) {
        const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (match && match[1]) {
          const gvizUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv`;
          try {
            const gvizResp = await fetch(gvizUrl);
            if (gvizResp.ok) csvText = await gvizResp.text();
          } catch (e) {}
          if (!csvText) {
            csvText = await fetchViaHost(gvizUrl);
          }
        }
      }

      if (csvText && !csvText.includes('<!DOCTYPE html>')) {
        const rows = parseCSVText(csvText);
        return rowsToContacts(rows, defaultCountryCode);
      } else {
        throw new Error(
          'Google Sheet Sync Notice:\n\n' +
          'گوگل شیٹ تک رسائی کے لیے ضروری ہے کہ شیٹ پبلک ہو۔\n' +
          '1. گوگل شیٹ میں اوپر دائیں طرف "Share" کا بٹن دبائیں۔\n' +
          '2. "General access" کو "Anyone with the link" (Viewer) پر سیٹ کریں۔\n\n' +
          '💡 متبادل آسان طریقہ: گوگل شیٹ سے نام اور نمبر سلیکٹ کر کے کاپی (Ctrl+C) کریں اور نیچے "Quick Paste from Excel (Ctrl+V)" میں پیسٹ کر کے امپورٹ کر لیں۔'
        );
      }
    }

    try {
      const response = await fetch(trimmed);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      return rowsToContacts(parseCSVText(text), defaultCountryCode);
    } catch (err) {
      throw new Error(`Unable to read spreadsheet link: ${err.message}`);
    }
  }

  function parseCSV(rawText, defaultCountryCode = '92') {
    const rows = parseCSVText(rawText);
    return rowsToContacts(rows, defaultCountryCode);
  }

  function parseManualInput(text, defaultCountryCode = '92') {
    if (!text || !text.trim()) return [];

    const lines = text.split(/\r?\n/);
    const rows = [];

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (trimmed.includes('\t')) {
        rows.push(trimmed.split('\t').map(s => s.trim()));
      } else if (trimmed.includes(',')) {
        rows.push(trimmed.split(',').map(s => s.trim()));
      } else if (trimmed.includes(';')) {
        rows.push(trimmed.split(';').map(s => s.trim()));
      } else {
        const parts = trimmed.split(/\s+/);
        const firstIsPhone = /^\+?\d[\d\-\(\)\s]{6,}\d$/.test(parts[0]);
        if (firstIsPhone) {
          rows.push([parts.slice(1).join(' '), parts[0]]);
        } else {
          rows.push([parts.slice(0, -1).join(' '), parts[parts.length - 1]]);
        }
      }
    });

    return rowsToContacts(rows, defaultCountryCode);
  }

  return {
    normalizePhone,
    parseExcelArrayBuffer,
    fetchLiveSpreadsheet,
    parseCSV,
    parseManualInput
  };
})();
