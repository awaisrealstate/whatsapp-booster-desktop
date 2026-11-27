const STOP_KEYWORDS = new Set([
  'STOP',
  'STOPALL',
  'STOP ALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'OPT OUT',
  'OPTOUT',
  'REMOVE',
  'روکیں',
  'بند',
  'بند کریں'
]);

/**
 * Checks whether an inbound customer message represents an explicit opt-out request.
 */
export function isStopOptOutText(text: string | null | undefined): boolean {
  if (!text) return false;
  const cleaned = text
    .trim()
    .replace(/[.!,?؟۔]+$/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();

  if (!cleaned) return false;
  return STOP_KEYWORDS.has(cleaned);
}
