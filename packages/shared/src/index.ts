export {
  MIN_PHONE_DIGITS,
  MAX_PHONE_DIGITS,
  normalizePhoneNumber,
  validatePhoneNumber,
  type PhoneValidationResult
} from './phone.ts';

export {
  validateContactInput,
  mergeContactsPreserveProgress,
  findNextPendingIndex,
  type ContactDispatchStatus,
  type ContactInput,
  type ContactRecord,
  type SentHistoryEntry,
  type SentPhoneHistory,
  type ContactValidationResult,
  type SmartMergeResult
} from './contact.ts';

export {
  MAX_SPINTAX_PASSES,
  MAX_MESSAGE_LENGTH,
  formatMessageText,
  type TemplateContact,
  type FormatMessageOptions
} from './template.ts';

export {
  sanitizeCsvCell,
  formatCsvRow,
  exportContactsToCsv,
  escapeHtml,
  parseCSVText
} from './csv.ts';

export {
  detectSpreadsheetColumns,
  detectSpreadsheetColumnsByData,
  isLegacyBinaryXls,
  parseXlsxRows,
  buildContactImportPreview,
  previewSpreadsheetImport,
  type DetectedColumns,
  type ImportedContactRow,
  type InvalidImportRow,
  type DuplicateImportRow,
  type SpreadsheetImportPreview
} from './importer.ts';

export {
  buildLegacyMigrationPlan,
  type LegacyConflictPolicy,
  type LegacyContactEntry,
  type LegacySentHistoryEntry,
  type LegacyOrchestratorState,
  type NormalizedLegacyContact,
  type ReconciledLegacyMigrationPlan
} from './legacy-import.ts';
