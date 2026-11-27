import { validatePhoneNumber } from './phone.ts';

export type ContactDispatchStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface ContactInput {
  name?: string | null;
  phone?: string | number | null;
  rawPhone?: string | number | null;
  company?: string | null;
  customVars?: Record<string, string>;
}

export interface ContactRecord {
  id: number;
  name: string;
  phone: string;
  rawPhone: string;
  customVars: Record<string, string>;
  status: ContactDispatchStatus;
  errorMessage: string;
  sentAt: string | null;
}

export interface SentHistoryEntry {
  status: 'sent' | 'failed';
  sentAt: string | null;
  errorMessage: string;
}

export type SentPhoneHistory = Record<string, SentHistoryEntry>;

export interface ContactValidationResult {
  valid: boolean;
  contact?: {
    name: string;
    phone: string;
    rawPhone: string;
    customVars: Record<string, string>;
  };
  errors: string[];
}

export interface SmartMergeResult {
  contacts: ContactRecord[];
  sentPhoneHistory: SentPhoneHistory;
  nextIndex: number;
  pendingCount: number;
  preservedSent: number;
  newlyAdded: number;
}

/**
 * Validates and normalizes an incoming contact record.
 * Intentional improvement: rejects invalid/short/long phone numbers instead of keeping malformed digits.
 */
export function validateContactInput(
  input: ContactInput,
  defaultCountryCode = '92'
): ContactValidationResult {
  const errors: string[] = [];
  const raw = input.rawPhone ?? input.phone ?? '';
  const phoneCheck = validatePhoneNumber(raw, defaultCountryCode);

  if (!phoneCheck.valid) {
    errors.push(phoneCheck.reason ?? 'Invalid phone number.');
  }

  const trimmedName = String(input.name ?? '').trim();
  if (trimmedName.length > 120) {
    errors.push('Contact name must be 120 characters or fewer.');
  }

  const name = trimmedName || 'Valued Client';
  const company = String(input.company ?? input.customVars?.company ?? '').trim();

  const customVars: Record<string, string> = {};
  if (input.customVars) {
    for (const [key, val] of Object.entries(input.customVars)) {
      if (!key) continue;
      customVars[key] = String(val ?? '').trim();
    }
  }
  customVars.name = name;
  customVars.phone = phoneCheck.phone;
  if (company) {
    customVars.company = company;
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    contact: {
      name,
      phone: phoneCheck.phone,
      rawPhone: String(raw).trim() || phoneCheck.phone,
      customVars
    },
    errors: []
  };
}

/**
 * Pure Smart Merge preserved from ui/bridge.js:
 * Merges incoming contacts with existing contacts + persistent sentPhoneHistory
 * so sent/failed statuses are preserved and duplicate phone numbers are skipped.
 */
export function mergeContactsPreserveProgress(
  existingContacts: readonly Partial<ContactRecord>[],
  incomingContacts: readonly ContactInput[],
  sentPhoneHistory: SentPhoneHistory = {},
  defaultCountryCode = '92'
): SmartMergeResult {
  const statusByPhone: SentPhoneHistory = { ...sentPhoneHistory };

  for (const existing of existingContacts) {
    const check = validatePhoneNumber(existing.phone ?? existing.rawPhone, defaultCountryCode);
    if (!check.valid) continue;
    if (existing.status === 'sent' || existing.status === 'failed') {
      statusByPhone[check.phone] = {
        status: existing.status,
        sentAt: existing.sentAt ?? null,
        errorMessage: existing.errorMessage ?? ''
      };
    }
  }

  const seen = new Set<string>();
  const merged: ContactRecord[] = [];
  let preservedSent = 0;
  let newlyAdded = 0;

  for (const item of incomingContacts) {
    const validated = validateContactInput(item, defaultCountryCode);
    if (!validated.valid || !validated.contact) continue;

    const clean = validated.contact.phone;
    if (seen.has(clean)) continue;
    seen.add(clean);

    const prior = statusByPhone[clean];
    let status: ContactDispatchStatus = 'pending';
    let sentAt: string | null = null;
    let errorMessage = '';

    if (prior && (prior.status === 'sent' || prior.status === 'failed')) {
      status = prior.status;
      sentAt = prior.sentAt ?? null;
      errorMessage = prior.errorMessage ?? '';
      if (status === 'sent') preservedSent++;
    } else {
      newlyAdded++;
    }

    merged.push({
      id: merged.length + 1,
      name: validated.contact.name,
      phone: clean,
      rawPhone: validated.contact.rawPhone,
      customVars: validated.contact.customVars,
      status,
      errorMessage,
      sentAt
    });
  }

  const firstPendingIndex = merged.findIndex((c) => c.status === 'pending');
  const nextIndex = firstPendingIndex === -1 ? merged.length : firstPendingIndex;
  const pendingCount = merged.filter((c) => c.status === 'pending').length;

  return {
    contacts: merged,
    sentPhoneHistory: statusByPhone,
    nextIndex,
    pendingCount,
    preservedSent,
    newlyAdded
  };
}

export function findNextPendingIndex(contacts: readonly Pick<ContactRecord, 'status'>[]): number {
  const idx = contacts.findIndex((c) => c.status === 'pending');
  return idx === -1 ? contacts.length : idx;
}
