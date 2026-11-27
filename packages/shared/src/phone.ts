export const MIN_PHONE_DIGITS = 8;
export const MAX_PHONE_DIGITS = 15;

export interface PhoneValidationResult {
  valid: boolean;
  phone: string;
  reason?: string;
}

/**
 * Normalizes Pakistani and international phone numbers to digits-only E.164 form
 * (without leading '+'), preserving legacy behavior from ui/lib/csv-parser.js.
 */
export function normalizePhoneNumber(
  rawPhone: string | number | null | undefined,
  defaultCountryCode = '92'
): string {
  if (rawPhone === null || rawPhone === undefined) return '';

  let cleaned = String(rawPhone)
    .trim()
    .replace(/[\s\-().\u2013\u2014]/g, '');

  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }

  cleaned = cleaned.replace(/\D/g, '');
  if (!cleaned) return '';

  if (cleaned.startsWith('0092')) {
    cleaned = cleaned.substring(2);
  } else if (cleaned.startsWith('00')) {
    cleaned = cleaned.substring(2);
  }

  // Pakistani international format (923xxxxxxxxx or 92xxxxxxxxx)
  if (cleaned.startsWith('92') && (cleaned.length === 12 || cleaned.length === 11)) {
    return cleaned;
  }

  // Pakistani local format (03xxxxxxxxx -> 923xxxxxxxxx)
  if (cleaned.startsWith('03') && cleaned.length === 11) {
    return '92' + cleaned.substring(1);
  }

  // Pakistani mobile without leading 0 (3xxxxxxxxx -> 923xxxxxxxxx)
  if (cleaned.startsWith('3') && cleaned.length === 10) {
    return '92' + cleaned;
  }

  const cc = String(defaultCountryCode || '92').replace(/\D/g, '') || '92';

  // Generic national format starting with 0
  if (cleaned.startsWith('0') && cleaned.length >= 9 && cleaned.length <= 11) {
    return cc + cleaned.substring(1);
  }

  // Short 10-digit local number without country code prefix
  if (cleaned.length === 10 && !cleaned.startsWith(cc)) {
    return cc + cleaned;
  }

  return cleaned;
}

/**
 * Validates and normalizes a phone number.
 * Intentional improvement over legacy normalizePhone(): enforces E.164 digit bounds (8..15)
 * and rejects placeholder/all-zero numbers.
 */
export function validatePhoneNumber(
  rawPhone: string | number | null | undefined,
  defaultCountryCode = '92'
): PhoneValidationResult {
  const normalized = normalizePhoneNumber(rawPhone, defaultCountryCode);
  if (!normalized) {
    return { valid: false, phone: '', reason: 'Phone number is empty or contains no digits.' };
  }

  if (/^0+$/.test(normalized)) {
    return { valid: false, phone: '', reason: 'Phone number cannot consist solely of zeros.' };
  }

  if (normalized.length < MIN_PHONE_DIGITS) {
    return {
      valid: false,
      phone: normalized,
      reason: `Phone number must have at least ${MIN_PHONE_DIGITS} digits.`
    };
  }

  if (normalized.length > MAX_PHONE_DIGITS) {
    return {
      valid: false,
      phone: normalized,
      reason: `Phone number must not exceed ${MAX_PHONE_DIGITS} digits.`
    };
  }

  return { valid: true, phone: normalized };
}
