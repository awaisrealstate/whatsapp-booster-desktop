export const MAX_SPINTAX_PASSES = 20;
export const MAX_MESSAGE_LENGTH = 4096;

export interface TemplateContact {
  name?: string | null;
  phone?: string | null;
  customVars?: Record<string, string | number | null | undefined>;
}

export interface FormatMessageOptions {
  spintaxStrategy?: 'random' | 'first';
  maxSpintaxPasses?: number;
  maxLength?: number;
  strictLength?: boolean;
  randomFn?: () => number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Formats a message template with contact variables and bounded Spintax evaluation.
 * - Uses callback replacers so '$', '$$', '$&', '$1', '$100' are inserted literally.
 * - Substitutes {name}/{نام}, {firstname}, {phone}/{number}, and customVars keys.
 * - Evaluates {opt1|opt2} Spintax up to MAX_SPINTAX_PASSES (20) passes.
 * - Enforces MAX_MESSAGE_LENGTH (4096 chars), truncating or throwing if strictLength=true.
 */
export function formatMessageText(
  template: string | null | undefined,
  contact: TemplateContact | null | undefined,
  options: FormatMessageOptions = {}
): string {
  const {
    spintaxStrategy = 'random',
    maxSpintaxPasses = MAX_SPINTAX_PASSES,
    maxLength = MAX_MESSAGE_LENGTH,
    strictLength = false,
    randomFn = Math.random
  } = options;

  const effectiveMaxPasses = Math.min(Math.max(0, Math.floor(maxSpintaxPasses)), MAX_SPINTAX_PASSES);
  const effectiveMaxLength = Math.min(Math.max(1, Math.floor(maxLength)), MAX_MESSAGE_LENGTH);

  let msg = template && template.length > 0 ? template : 'Hi {name}, hope you are doing well!';
  const fullName = (contact?.name && contact.name.trim()) || 'Valued Client';
  const firstName = fullName.split(/\s+/)[0] || fullName;
  const phone = contact?.phone ? String(contact.phone) : '';

  msg = msg.replace(/\{(?:name|نام)\}/gi, () => fullName);
  msg = msg.replace(/\{(?:firstname)\}/gi, () => firstName);
  msg = msg.replace(/\{(?:phone|number)\}/gi, () => phone);

  if (contact?.customVars) {
    for (const [key, rawVal] of Object.entries(contact.customVars)) {
      if (!key) continue;
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'name' || lowerKey === 'نام' || lowerKey === 'firstname' || lowerKey === 'phone' || lowerKey === 'number') {
        continue;
      }
      const escaped = escapeRegExp(key);
      const val = rawVal === null || rawVal === undefined ? '' : String(rawVal);
      msg = msg.replace(new RegExp(`\\{${escaped}\\}`, 'gi'), () => val);
    }
  }

  // Bounded Spintax evaluation: resolves innermost {a|b} tokens up to effectiveMaxPasses passes.
  const spintaxPattern = /\{([^{}]+)\}/g;
  for (let pass = 0; pass < effectiveMaxPasses; pass++) {
    let changed = false;
    msg = msg.replace(spintaxPattern, (fullMatch, inner: string) => {
      if (!inner.includes('|')) {
        return fullMatch;
      }
      const choices = inner.split('|');
      changed = true;
      if (spintaxStrategy === 'first') {
        return (choices[0] ?? '').trim();
      }
      const idx = Math.floor(randomFn() * choices.length);
      return (choices[idx] ?? choices[0] ?? '').trim();
    });
    if (!changed) break;
  }

  if (msg.length > effectiveMaxLength) {
    if (strictLength) {
      throw new Error(`Formatted message exceeds maximum length of ${effectiveMaxLength} characters.`);
    }
    return msg.slice(0, effectiveMaxLength);
  }

  return msg;
}
