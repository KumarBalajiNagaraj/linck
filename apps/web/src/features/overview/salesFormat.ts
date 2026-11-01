import { useMemo } from 'react';
import { formatINR, formatINRCompact, formatTime, monthNumber, type Instant, type MoneyInput } from '@linck/domain';
import { useLang, type Lang } from '../../i18n/lang.js';

/**
 * Every rupee and date on the sales trend screens, formatted in one place.
 *
 * Kept to this file on purpose: the shared compact formatter is about to
 * learn Tamil units (a hook in the web app), and a day-and-month formatter
 * that follows the language is coming with it. When they land, swapping
 * `formatINRCompact` and the month tables below for them is a change to this
 * file only — the screens call these and nothing else.
 */

const MONTHS: Record<Lang, readonly string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ta: ['ஜன.', 'பிப்.', 'மார்ச்', 'ஏப்.', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக.', 'செப்.', 'அக்.', 'நவ.', 'டிச.'],
};

export interface SalesFormat {
  /** `₹12.40 L` — for tiles, cells and axis ticks. */
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
  /** `14:42` — the as-of time. */
  time: (instant: Instant) => string;
}

export function useSalesFormat(): SalesFormat {
  const lang = useLang((s) => s.lang);
  return useMemo(() => {
    const months = MONTHS[lang];
    const monthName = (month: string) => months[monthNumber(month) - 1] ?? month;
    return {
      money: (value) => formatINRCompact(value),
      moneyExact: (value) => formatINR(value, { decimals: 0 }),
      dayMonth: (date) => `${date.slice(8, 10)} ${monthName(date.slice(0, 7))}`,
      dayMonthYear: (date) => `${date.slice(8, 10)} ${monthName(date.slice(0, 7))} ${date.slice(0, 4)}`,
      month: monthName,
      monthYear: (month) => `${monthName(month)} ${month.slice(0, 4)}`,
      time: (instant) => formatTime(instant),
    };
  }, [lang]);
}
