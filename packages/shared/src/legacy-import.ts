import { validatePhoneNumber } from './phone.ts';

export type LegacyConflictPolicy = 'skip_existing' | 'merge_missing_fields' | 'overwrite_existing';

export interface LegacyContactEntry {
  id?: number | string;
  name?: string;
  phone?: string | number;
  rawPhone?: string | number;
  customVars?: Record<string, string>;
  status?: string;
  errorMessage?: string;
  sentAt?: string | null;
}

export interface LegacySentHistoryEntry {
  status?: string;
  sentAt?: string | null;
  errorMessage?: string;
}

export interface LegacyOrchestratorState {
  contacts?: LegacyContactEntry[];
  sentPhoneHistory?: Record<string, LegacySentHistoryEntry>;
  currentIndex?: number;
  batchSentCount?: number;
  dailyLimit?: number;
  defaultCountryCode?: string;
  template?: string;
  googleSheetUrl?: string;
  updatedAt?: number;
}

export interface NormalizedLegacyContact {
  phone: string;
  rawPhone: string;
  name: string;
  company: string | null;
  customVars: Record<string, string>;
  legacyStatus: 'sent' | 'failed' | 'pending';
  sentAt: string | null;
  errorMessage: string;
}

export interface ReconciledLegacyMigrationPlan {
  defaultCountryCode: string;
  templateText: string | null;
  googleSheetUrl: string | null;
  dailyLimit: number | null;
  batchSentCount: number;
  currentIndex: number;
  sourceChosen: 'campaign_state_json' | 'local_storage' | 'merged_both';
  contacts: NormalizedLegacyContact[];
  invalidContactsCount: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  tagsToEnsure: string[];
}

function normalizeLegacyStatus(status: string | undefined): 'sent' | 'failed' | 'pending' {
  if (status === 'sent') return 'sent';
  if (status === 'failed') return 'failed';
  return 'pending';
}

/**
 * Reconciles user_data/campaign_state.json and optional browser localStorage
 * (wacrm_desktop_state.wacrm_engine_state) non-destructively.
 * Newer `updatedAt` wins for scalar metadata, while sentPhoneHistory unions progress
 * so already-sent numbers are never downgraded back to pending.
 */
export function buildLegacyMigrationPlan(params: {
  campaignState?: LegacyOrchestratorState | null;
  localStorageState?: LegacyOrchestratorState | null;
}): ReconciledLegacyMigrationPlan {
  const fileState = params.campaignState ?? null;
  const lsState = params.localStorageState ?? null;

  if (!fileState && !lsState) {
    throw new Error('At least one legacy state object (campaignState or localStorageState) is required.');
  }

  const fileUpdated = Number(fileState?.updatedAt ?? 0);
  const lsUpdated = Number(lsState?.updatedAt ?? 0);
  const primary = fileState && lsState
    ? (lsUpdated > fileUpdated ? lsState : fileState)
    : (fileState ?? lsState)!;
  const secondary = primary === fileState ? lsState : fileState;

  const sourceChosen: ReconciledLegacyMigrationPlan['sourceChosen'] =
    fileState && lsState ? 'merged_both' : fileState ? 'campaign_state_json' : 'local_storage';

  const defaultCountryCode = String(primary.defaultCountryCode || secondary?.defaultCountryCode || '92').replace(/\D/g, '') || '92';

  // Union sentPhoneHistory giving precedence to 'sent' > 'failed'
  const mergedHistory: Record<string, { status: 'sent' | 'failed'; sentAt: string | null; errorMessage: string }> = {};

  for (const source of [secondary, primary]) {
    if (!source?.sentPhoneHistory) continue;
    for (const [rawPhone, entry] of Object.entries(source.sentPhoneHistory)) {
      const check = validatePhoneNumber(rawPhone, defaultCountryCode);
      if (!check.valid) continue;
      const st = normalizeLegacyStatus(entry?.status);
      if (st === 'pending') continue;
      const prev = mergedHistory[check.phone];
      if (!prev || st === 'sent') {
        mergedHistory[check.phone] = {
          status: st,
          sentAt: entry?.sentAt ?? prev?.sentAt ?? null,
          errorMessage: entry?.errorMessage ?? ''
        };
      }
    }
  }

  const contactsByPhone = new Map<string, NormalizedLegacyContact>();
  let invalidContactsCount = 0;

  for (const source of [secondary, primary]) {
    if (!Array.isArray(source?.contacts)) continue;
    for (const item of source.contacts) {
      const check = validatePhoneNumber(item.phone ?? item.rawPhone, defaultCountryCode);
      if (!check.valid) {
        invalidContactsCount++;
        continue;
      }

      const historyEntry = mergedHistory[check.phone];
      const itemStatus = normalizeLegacyStatus(item.status);
      const effectiveStatus: 'sent' | 'failed' | 'pending' =
        historyEntry?.status === 'sent' || itemStatus === 'sent'
          ? 'sent'
          : historyEntry?.status === 'failed' || itemStatus === 'failed'
            ? 'failed'
            : 'pending';

      const prev = contactsByPhone.get(check.phone);
      const company = String(item.customVars?.company ?? prev?.company ?? '').trim() || null;
      const name = String(item.name ?? '').trim() || prev?.name || 'Valued Client';

      const customVars: Record<string, string> = {
        ...(prev?.customVars ?? {}),
        ...(item.customVars ?? {}),
        name,
        phone: check.phone
      };
      if (company) customVars.company = company;

      contactsByPhone.set(check.phone, {
        phone: check.phone,
        rawPhone: String(item.rawPhone ?? item.phone ?? check.phone).trim(),
        name,
        company,
        customVars,
        legacyStatus: effectiveStatus,
        sentAt: item.sentAt ?? historyEntry?.sentAt ?? prev?.sentAt ?? null,
        errorMessage: item.errorMessage ?? historyEntry?.errorMessage ?? prev?.errorMessage ?? ''
      });
    }
  }

  // Ensure phone numbers present only in sentPhoneHistory are also preserved
  for (const [phone, entry] of Object.entries(mergedHistory)) {
    if (!contactsByPhone.has(phone)) {
      contactsByPhone.set(phone, {
        phone,
        rawPhone: phone,
        name: 'Valued Client',
        company: null,
        customVars: { name: 'Valued Client', phone },
        legacyStatus: entry.status,
        sentAt: entry.sentAt,
        errorMessage: entry.errorMessage
      });
    }
  }

  const contacts = Array.from(contactsByPhone.values());
  let sentCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  for (const c of contacts) {
    if (c.legacyStatus === 'sent') sentCount++;
    else if (c.legacyStatus === 'failed') failedCount++;
    else pendingCount++;
  }

  const tagsToEnsure = ['legacy-import'];
  if (sentCount > 0) tagsToEnsure.push('legacy:sent');
  if (failedCount > 0) tagsToEnsure.push('legacy:failed');
  if (pendingCount > 0) tagsToEnsure.push('legacy:pending');

  return {
    defaultCountryCode,
    templateText: primary.template ?? secondary?.template ?? null,
    googleSheetUrl: primary.googleSheetUrl || secondary?.googleSheetUrl || null,
    dailyLimit: typeof primary.dailyLimit === 'number' ? primary.dailyLimit : null,
    batchSentCount: Number(primary.batchSentCount ?? 0),
    currentIndex: Number(primary.currentIndex ?? 0),
    sourceChosen,
    contacts,
    invalidContactsCount,
    sentCount,
    failedCount,
    pendingCount,
    tagsToEnsure
  };
}
