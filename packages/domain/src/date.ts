/**
 * Dates.
 *
 * Everything from the API is ISO-8601 UTC. Everything displayed is IST.
 *
 * The business day is an IST CALENDAR date, not a UTC date: a night-shift
 * production run and a 23:40 dispatch both belong to the same IST day, and
 * `new Date().toISOString().slice(0,10)` gets that wrong for five and a half
 * hours out of every twenty-four. A lint rule bans that expression.
 */

const IST_OFFSET_MIN = 330; // UTC+05:30

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DAYMON_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
});

export type Instant = string | Date;

function toDate(v: Instant): Date {
  return v instanceof Date ? v : new Date(v);
}

/** `08-08-2026` */
export function formatDate(v: Instant | null | undefined): string {
  if (!v) return '–';
  return DATE_FMT.format(toDate(v)).replace(/\//g, '-');
}

/** `08-08-2026 14:32` */
export function formatDateTime(v: Instant | null | undefined): string {
  if (!v) return '–';
  return DATETIME_FMT.format(toDate(v)).replace(/\//g, '-').replace(',', '');
}

/** `14:32` — used by the as-of stamp. */
export function formatTime(v: Instant | null | undefined): string {
  if (!v) return '–';
  return TIME_FMT.format(toDate(v));
}

/** `08 Aug` — compact axis and timeline labels. */
export function formatDayMonth(v: Instant | null | undefined): string {
  if (!v) return '–';
  return DAYMON_FMT.format(toDate(v));
}

/** The IST calendar date an instant belongs to, as `YYYY-MM-DD`. */
export function businessDate(v: Instant = new Date()): string {
  const d = toDate(v);
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Indian financial year: 1 April – 31 March, labelled `2026-27`.
 * Every statutory series, every ageing bucket and every P&L is keyed to it.
 */
export function fiscalYearOf(v: Instant = new Date()): string {
  const iso = businessDate(v);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Q1 = Apr–Jun. Not the calendar quarter. */
export function fiscalQuarter(v: Instant = new Date()): 1 | 2 | 3 | 4 {
  const month = Number(businessDate(v).slice(5, 7));
  if (month >= 4 && month <= 6) return 1;
  if (month >= 7 && month <= 9) return 2;
  if (month >= 10 && month <= 12) return 3;
  return 4;
}

/** `2026-27` → the IST date range it covers. */
export function fyRange(label: string): { from: string; to: string } {
  const startYear = Number(label.slice(0, 4));
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

/** Whole days between two IST calendar dates. Negative = the first is later. */
export function daysBetween(from: Instant, to: Instant): number {
  const a = Date.parse(`${businessDate(from)}T00:00:00Z`);
  const b = Date.parse(`${businessDate(to)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Days until expiry, from today (IST). Negative means already expired.
 * Drives the document register, which is the whole point of the accounts
 * team keying insurance and permit end dates by hand.
 */
export function daysUntil(target: Instant, now: Instant = new Date()): number {
  return daysBetween(now, target);
}

export const DATE_RANGE_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
  'this_fy',
  'this_fy_to_date',
  'last_fy',
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const DATE_RANGE_LABEL: Record<DateRangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  this_fy: 'This FY',
  this_fy_to_date: 'This FY to date',
  last_fy: 'Last FY',
};
