import { useMemo } from 'react';
import { formatINR, formatINRCompact, formatTime, monthNumber, type Instant, type MoneyInput } from '@linck/domain';
import { monthNames, moneyUnits } from '../../i18n/format.js';
import { useLang, type Lang } from '../../i18n/lang.js';
import { useWords } from '../../i18n/words.js';

/**
 * Every rupee and date on the sales trend screens, formatted in one place.
 *
 * The compact rupee figure ends in the reader's own unit word (₹12.40 L /
 * ₹12.40 லட்சம்) and short months are named in the reader's language, both
 * from the app-wide words in `i18n/format.ts`, so these screens read like the
 * rest of Linck. The screens call these and nothing else.
 */

/** Spelled out, for a month named in a sentence ("September", "செப்டம்பர்"). */
const MONTHS_FULL: Record<Lang, readonly string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ta: ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'],
};

export interface SalesFormat {
  /** `₹12.40 L` / `₹12.40 லட்சம்` — for tiles, cells and axis ticks. */
  money: (value: MoneyInput) => string;
  /** `₹12,40,000` — the hover behind a compact figure. */
  moneyExact: (value: MoneyInput) => string;
  /** `08 Aug` from `2026-08-08`. */
  dayMonth: (date: string) => string;
  /** `08 Aug 2026` from `2026-08-08`. */
  dayMonthYear: (date: string) => string;
  /** `Aug` from `2026-08`. */
  month: (month: string) => string;
  /** `Aug 2026` from `2026-08`. */
  monthYear: (month: string) => string;
  /** `September` from `2026-09` — a month named in a sentence. */
  monthName: (month: string) => string;
  /** `14:42` — the as-of time. */
  time: (instant: Instant) => string;
}

export function useSalesFormat(): SalesFormat {
  const lang = useLang((s) => s.lang);
  const units = useWords(moneyUnits);
  const months = useWords(monthNames);
  return useMemo(() => {
    const short = (month: string) => months[monthNumber(month) - 1] ?? month;
    return {
      money: (value) => formatINRCompact(value, units),
      moneyExact: (value) => formatINR(value, { decimals: 0 }),
      dayMonth: (date) => `${date.slice(8, 10)} ${short(date.slice(0, 7))}`,
      dayMonthYear: (date) => `${date.slice(8, 10)} ${short(date.slice(0, 7))} ${date.slice(0, 4)}`,
      month: short,
      monthYear: (month) => `${short(month)} ${month.slice(0, 4)}`,
      monthName: (month) => MONTHS_FULL[lang][monthNumber(month) - 1] ?? month,
      time: (instant) => formatTime(instant),
    };
  }, [lang, units, months]);
}
