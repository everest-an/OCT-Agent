/**
 * friendly-errors — maps raw MissionErrorCode / reason text into
 * user-friendly strings via i18n. Keeps the mapping in one place so the UI
 * components stay dumb.
 */

import type { TranslateFunc } from '../../lib/i18n';

const KNOWN_CODES = [
  'timeout',
  'agent_crash',
  'context_overflow',
  'permission_denied',
  'tool_rejected',
  'network_error',
  'unknown',
] as const;
type KnownCode = typeof KNOWN_CODES[number];

function isKnownCode(code: string): code is KnownCode {
  return (KNOWN_CODES as readonly string[]).includes(code);
}

/**
 * Turn a (code, raw) pair into a friendly single-sentence explanation.
 * - Known codes map to their localized sentence.
 * - Unknown codes fall back to the raw message (if any) or a generic copy.
 */
export function friendlyErrorMessage(
  input: { code?: string; raw?: string },
  t: TranslateFunc,
): string {
  const code = (input.code || '').trim();
  const raw = (input.raw || '').trim();

  if (code && isKnownCode(code)) {
    return t(`missionFlow.error.${code}`, raw || code);
  }

  // Heuristics: scan raw text for common patterns.
  if (raw) {
    if (/timeout|idle/i.test(raw)) return t('missionFlow.error.timeout', raw);
    if (/permission|denied/i.test(raw)) return t('missionFlow.error.permission_denied', raw);
    if (/network|ECONN|socket|fetch failed/i.test(raw)) return t('missionFlow.error.network_error', raw);
    if (/context.*overflow|token.*limit/i.test(raw)) return t('missionFlow.error.context_overflow', raw);
    return raw;
  }

  return t('missionFlow.error.unknown', 'Something unexpected happened. You can retry or cancel.');
}
