/**
 * Calendar arithmetic on IST business dates.
 *
 * `date.ts` turns instants into IST calendar dates. Once a figure is filed
 * under its day (`YYYY-MM-DD`) or month (`YYYY-MM`), the sums and comparisons
 * work on those strings alone, through these helpers. Every one of them reads
 * a date as UTC midnight and writes it back from the UTC fields, so no time
 * zone can move a day.
 */

const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** Days since 1 Jan 1970 for a `YYYY-MM-DD` date. */
export function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** The `YYYY-MM-DD` date of a day number. */
export function dateOfDay(day: number): string {
  const d = new Date(day * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(date: string, days: number): string {
  return dateOfDay(dayNumber(date) + days);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function dayDiff(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

/** `2026-08-08` → `2026-08`. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** Months from `from` to `to`. Negative when `to` is earlier. */
export function monthDiff(from: string, to: string): number {
  return Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)) - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)));
}

export function firstDayOf(month: string): string {
  return `${month}-01`;
}

export function lastDayOf(month: string): string {
  return addDays(firstDayOf(addMonths(month, 1)), -1);
}

export function daysInMonth(month: string): number {
  return dayDiff(firstDayOf(month), firstDayOf(addMonths(month, 1)));
}

/** 1 = January … 12 = December. */
export function monthNumber(month: string): number {
  return Number(month.slice(5, 7));
}
