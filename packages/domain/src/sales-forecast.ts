/**
 * WHAT'S COMING (LIN-9): next month's sales, forecast from the company's own
 * sales and nothing else, with a range taken from how far off the same rule
 * was on past months.
 *
 * THE RULE, in the words the screen uses: next month = the same month last
 * year × this year's change. "This year's change" is the last 13 weeks of
 * units against the same 13 weeks a year earlier — the 3-month figure on
 * Sales trends, so the two screens quote one number. Where last year has no
 * record of the month, it falls back to the last 13 weeks' daily average ×
 * the days in the month.
 *
 * WHY THE MOVING AVERAGE IS ONLY THE FALLBACK. Blending it in was the first
 * idea. On the seeded history's checkable months (April to July 2026) a 70/30
 * blend with the 13-week average missed by 13% in total, the rule alone by
 * 11%, and "same as last month" by 19%; counting February and March too, 16%
 * against 12%. An average does not know the season: it drags a February
 * forecast down to December's rain months and holds a June one up at the
 * March rush. The blend did beat the rule on four small materials (6mm, GSB,
 * WMM, dust) and lost on the five that carry the money; one rule, said in one
 * line, was worth more than that.
 *
 * THE RANGE is the rule's own track record. Each past month the rule could
 * have forecast as it does today — a year-earlier month on record, and a
 * change it could measure — is forecast again with only what was known on the
 * same day of the month before (today is the 8th, so May is forecast as of 8
 * April), and the range is as wide as the misses in four months out of five.
 * Months forecast before a change could be measured are left out: they tested
 * "last year as it was", a rule nobody is using now, and on a fast-growing
 * material they doubled the range. Never narrower than ±5%: a crusher's month
 * is not that predictable, whatever the arithmetic says. With under three
 * months to check against — or a forecast made without a measured change —
 * the range is a plain ±25% at the least.
 *
 * Pure: daily units in, numbers out. Nothing here knows about market prices or
 * news, and the screen says so.
 */
import { addDays, addMonths, dayDiff, daysInMonth, firstDayOf, lastDayOf, monthOf } from './calendar.js';
import { matchesFilter, paiseToRupees, YEAR_AGO_DAYS, type SaleLine, type SalesFilter } from './sales-trends.js';

/** The last 13 weeks: the window this year's change and the recent pace are read over. */
export const RECENT_DAYS = 91;
/** With fewer days than this that have a year-earlier record, the change is not measured. */
export const MIN_CHANGE_DAYS = 28;
/** A change beyond these is a customer won or lost, not a trend to carry forward. */
export const CHANGE_LIMITS = { low: 0.5, high: 2 } as const;
export const MIN_RANGE_PCT = 5;
export const MIN_CHECKED_MONTHS = 3;
export const UNCHECKED_RANGE_PCT = 25;
/** The range is as wide as the misses in this share of past months. */
export const RANGE_COVERAGE = 0.8;

const later = (a: string, b: string) => (a > b ? a : b);

/** Units sold per IST day, for the lines the filter lets through. */
export function dailyUnits(lines: readonly SaleLine[], filter?: SalesFilter): Map<string, number> {
  const daily = new Map<string, number>();
  for (const line of lines) {
    if (!matchesFilter(line, filter)) continue;
    daily.set(line.date, (daily.get(line.date) ?? 0) + line.units);
  }
  return daily;
}

/** Units over inclusive dates. */
export function unitsBetween(daily: ReadonlyMap<string, number>, from: string, to: string): number {
  let sum = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) sum += daily.get(d) ?? 0;
  return sum;
}

const unitsIn = (daily: ReadonlyMap<string, number>, month: string) => unitsBetween(daily, firstDayOf(month), lastDayOf(month));

/** Which rule made the forecast. */
export type ForecastBasis = 'last_year' | 'recent';

export interface MonthForecast {
  month: string;
  units: number;
  basis: ForecastBasis;
  /** The same month a year earlier; null when the history does not cover all of it. */
  lastYearUnits: number | null;
  /** The last 13 weeks against the same weeks a year earlier, as a ratio; null when it cannot be measured. */
  change: number | null;
  /** Units a day over the last 13 weeks. */
  recentPerDay: number;
}

/** Forecast `month` with only what was known on `today`. */
export function forecastMonth(daily: ReadonlyMap<string, number>, month: string, today: string, historyFrom: string): MonthForecast {
  const before = addMonths(month, -12);
  const lastYearUnits = firstDayOf(before) >= historyFrom && lastDayOf(before) <= today ? unitsIn(daily, before) : null;

  // This year's change, over the part of the last 13 weeks whose year-earlier
  // weeks are inside the history.
  const changeFrom = later(addDays(today, -(RECENT_DAYS - 1)), addDays(historyFrom, YEAR_AGO_DAYS));
  let change: number | null = null;
  if (dayDiff(changeFrom, today) + 1 >= MIN_CHANGE_DAYS) {
    const now = unitsBetween(daily, changeFrom, today);
    const then = unitsBetween(daily, addDays(changeFrom, -YEAR_AGO_DAYS), addDays(today, -YEAR_AGO_DAYS));
    if (then > 0) change = Math.min(CHANGE_LIMITS.high, Math.max(CHANGE_LIMITS.low, now / then));
  }

  const recentFrom = later(addDays(today, -(RECENT_DAYS - 1)), historyFrom);
  const recentDays = dayDiff(recentFrom, today) + 1;
  const recentPerDay = recentDays > 0 ? unitsBetween(daily, recentFrom, today) / recentDays : 0;

  if (lastYearUnits !== null && lastYearUnits > 0) {
    return { month, units: lastYearUnits * (change ?? 1), basis: 'last_year', lastYearUnits, change, recentPerDay };
  }
  return { month, units: recentPerDay * daysInMonth(month), basis: 'recent', lastYearUnits, change, recentPerDay };
}

export interface BacktestRow {
  month: string;
  actual: number;
  /** The rule, with only what was known on the same day of the month before. */
  forecast: number;
  /** "Same as last month": the last whole month before that day. */
  naive: number;
}

/** The same day of the month in `month`, or its last day when it is shorter. */
function sameDayIn(month: string, day: number): string {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;
}

/**
 * The rule tried on every whole past month it could have forecast as it does
 * today — from a year-earlier month and a measured change — each as of the
 * same day of the month before.
 */
export function backtest(daily: ReadonlyMap<string, number>, today: string, historyFrom: string): BacktestRow[] {
  const day = Number(today.slice(8, 10));
  const lastWhole = addMonths(monthOf(today), -1);
  const rows: BacktestRow[] = [];
  for (let month = addMonths(monthOf(historyFrom), 12); month <= lastWhole; month = addMonths(month, 1)) {
    const asOf = sameDayIn(addMonths(month, -1), day);
    const naiveMonth = addMonths(month, -2);
    const forecast = forecastMonth(daily, month, asOf, historyFrom);
    if (forecast.basis !== 'last_year' || forecast.change === null || firstDayOf(naiveMonth) < historyFrom) continue;
    rows.push({ month, actual: unitsIn(daily, month), forecast: forecast.units, naive: unitsIn(daily, naiveMonth) });
  }
  return rows;
}

export interface BacktestSummary {
  months: number;
  /** All the misses over all the sales, in % — "off by 12% on average". Null with nothing sold. */
  errorPct: number | null;
  naiveErrorPct: number | null;
  /** ± this much around the forecast. */
  rangePct: number;
  /** Past months whose sales fell inside that range around their forecast. */
  held: number;
}

export function summarizeBacktest(rows: readonly BacktestRow[]): BacktestSummary {
  const counted = rows.filter((r) => r.actual > 0 && r.forecast > 0);
  const sold = counted.reduce((s, r) => s + r.actual, 0);
  const missBy = (r: BacktestRow) => (Math.abs(r.actual - r.forecast) / r.forecast) * 100;
  let rangePct = UNCHECKED_RANGE_PCT;
  if (counted.length >= MIN_CHECKED_MONTHS) {
    const misses = counted.map(missBy).sort((a, b) => a - b);
    rangePct = Math.max(MIN_RANGE_PCT, Math.ceil(misses[Math.ceil(RANGE_COVERAGE * misses.length) - 1]!));
  }
  return {
    months: counted.length,
    errorPct: sold > 0 ? (counted.reduce((s, r) => s + Math.abs(r.forecast - r.actual), 0) / sold) * 100 : null,
    naiveErrorPct: sold > 0 ? (counted.reduce((s, r) => s + Math.abs(r.naive - r.actual), 0) / sold) * 100 : null,
    rangePct,
    held: counted.filter((r) => missBy(r) <= rangePct).length,
  };
}

export interface ForecastRange extends MonthForecast {
  low: number;
  high: number;
  rangePct: number;
  checked: BacktestSummary;
}

/**
 * A forecast and its range. A forecast the backtest does not stand for — from
 * the fallback, or without a measured change — is never given a range
 * narrower than the plain ±25%.
 */
export function forecastWithRange(daily: ReadonlyMap<string, number>, month: string, today: string, historyFrom: string): ForecastRange {
  const forecast = forecastMonth(daily, month, today, historyFrom);
  const checked = summarizeBacktest(backtest(daily, today, historyFrom));
  const asChecked = forecast.basis === 'last_year' && forecast.change !== null;
  const rangePct = asChecked ? checked.rangePct : Math.max(UNCHECKED_RANGE_PCT, checked.rangePct);
  return { ...forecast, low: forecast.units * (1 - rangePct / 100), high: forecast.units * (1 + rangePct / 100), rangePct, checked };
}

export interface MaterialForecast extends ForecastRange {
  productCode: string;
}

export interface NextMonthForecast {
  month: string;
  total: ForecastRange;
  /** The most expected first. */
  materials: MaterialForecast[];
  /** Rupees, at each material's own rate over the last 13 weeks. */
  value: string;
}

/**
 * Next month, in total and by material. Each material is forecast on its own
 * history, with its own range — a road material swings with the road season
 * and should not borrow M-Sand's steadiness.
 */
export function forecastNextMonth(lines: readonly SaleLine[], today: string, historyFrom: string, filter?: SalesFilter): NextMonthForecast {
  const month = addMonths(monthOf(today), 1);
  const yearAgo = addDays(today, -YEAR_AGO_DAYS);
  const recentFrom = addDays(today, -(RECENT_DAYS - 1));
  const byMaterial = new Map<string, { daily: Map<string, number>; tenths: number; paise: number }>();
  const total = new Map<string, number>();
  for (const line of lines) {
    if (!matchesFilter(line, filter) || line.date > today) continue;
    total.set(line.date, (total.get(line.date) ?? 0) + line.units);
    let m = byMaterial.get(line.productCode);
    if (!m) {
      m = { daily: new Map(), tenths: 0, paise: 0 };
      byMaterial.set(line.productCode, m);
    }
    m.daily.set(line.date, (m.daily.get(line.date) ?? 0) + line.units);
    if (line.date >= recentFrom) {
      m.tenths += Math.round(line.units * 10);
      m.paise += Math.round(Number.parseFloat(line.value) * 100);
    }
  }

  let valuePaise = 0;
  const materials: MaterialForecast[] = [];
  for (const [productCode, m] of byMaterial) {
    // A material nobody has bought for a year is not coming back next month.
    if (![...m.daily.keys()].some((d) => d >= yearAgo)) continue;
    const forecast = forecastWithRange(m.daily, month, today, historyFrom);
    materials.push({ ...forecast, productCode });
    if (m.tenths > 0) valuePaise += forecast.units * (m.paise / (m.tenths / 10));
  }
  materials.sort((a, b) => b.units - a.units || a.productCode.localeCompare(b.productCode));

  return { month, total: forecastWithRange(total, month, today, historyFrom), materials, value: paiseToRupees(valuePaise) };
}
