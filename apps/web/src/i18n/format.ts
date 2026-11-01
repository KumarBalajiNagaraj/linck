import { useCallback } from 'react';
import {
  ENGLISH_COMPACT_UNITS,
  ENGLISH_MONTHS_SHORT,
  formatDayMonth,
  formatINRCompact,
  type CompactUnits,
  type Instant,
  type MoneyInput,
} from '@linck/domain';
import type { Lang } from './lang.js';
import { useWords, words, wordsNow } from './words.js';

/**
 * Figures and dates in the reader's language.
 *
 * `@linck/domain` formats without knowing languages; the words it needs — the
 * unit a compact rupee figure ends in, the short month names — come from here.
 * Digits, the rupee sign and the 08-08-2026 date stay the same in both
 * languages (docs/WRITING.md).
 */

/** ₹4.50 L is ₹4.50 லட்சம் to a Tamil reader: K, L and Cr are English letters. */
export const moneyUnits = words<CompactUnits>({
  en: ENGLISH_COMPACT_UNITS,
  ta: { thousand: 'ஆயிரம்', lakh: 'லட்சம்', crore: 'கோடி' },
});

/** Short month names, January first, as a Tamil calendar or newspaper prints them. */
export const monthNames = words<readonly string[]>({
  en: ENGLISH_MONTHS_SHORT,
  ta: ['ஜன.', 'பிப்.', 'மார்ச்', 'ஏப்.', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக.', 'செப்.', 'அக்.', 'நவ.', 'டிச.'],
});

/**
 * `₹4.50 L` / `₹4.50 லட்சம்`. Re-renders when the language switches.
 * Always pair the figure with a `title` carrying the full-precision value.
 */
export function useInrCompact(): (value: MoneyInput) => string {
  const units = useWords(moneyUnits);
  return useCallback((value: MoneyInput) => formatINRCompact(value, units), [units]);
}

/** The same, for code outside a component. Does not re-render on its own. */
export function inrCompactNow(value: MoneyInput, lang?: Lang): string {
  return formatINRCompact(value, wordsNow(moneyUnits, lang));
}

/**
 * `08 Aug` / `08 ஆக.` — the one shape for a day on a chart axis or a timeline,
 * on every screen. Takes an instant or a plain `YYYY-MM-DD`.
 */
export function useDayMonth(): (value: Instant | null | undefined) => string {
  const months = useWords(monthNames);
  return useCallback((value: Instant | null | undefined) => formatDayMonth(value, months), [months]);
}
