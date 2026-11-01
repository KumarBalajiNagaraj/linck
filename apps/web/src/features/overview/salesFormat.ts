import { useMemo } from 'react';
import { formatINR, formatINRCompact, formatTime, monthNumber, type Instant, type MoneyInput } from '@linck/domain';
import { monthNames, moneyUnits } from '../../i18n/format.js';
import { useWords } from '../../i18n/words.js';

/**
 * Every rupee and date on the sales trend screens, formatted in one place.
 *
 * The compact rupee figure ends in the reader's own unit word (₹12.40 L /
 * ₹12.40 லட்சம்) and months are named in the reader's language, both from the
 * app-wide words in `i18n/format.ts`, so these screens read like the rest of
 * Linck. The screens call these and nothing else.
 */

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
  /** `14:42` — the as-of time. */
  time: (instant: Instant) => string;
}

export function useSalesFormat(): SalesFormat {
  const units = useWords(moneyUnits);
  const months = useWords(monthNames);
  return useMemo(() => {
    const monthName = (month: string) => months[monthNumber(month) - 1] ?? month;
    return {
      money: (value) => formatINRCompact(value, units),
      moneyExact: (value) => formatINR(value, { decimals: 0 }),
      dayMonth: (date) => `${date.slice(8, 10)} ${monthName(date.slice(0, 7))}`,
      dayMonthYear: (date) => `${date.slice(8, 10)} ${monthName(date.slice(0, 7))} ${date.slice(0, 4)}`,
      month: monthName,
      monthYear: (month) => `${monthName(month)} ${month.slice(0, 4)}`,
      time: (instant) => formatTime(instant),
    };
  }, [units, months]);
}
