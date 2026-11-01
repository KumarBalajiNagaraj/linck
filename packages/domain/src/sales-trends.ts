/**
 * SALES TRENDS (LIN-7): the director's sales by time, by customer and by
 * material, each against the same days a year earlier.
 *
 * Pure. The caller hands in the daily sales lines and today's IST date;
 * nothing here reads a clock. Units are summed in tenths and money in whole
 * paise, so a period's parts always add up to its total exactly, and money
 * leaves as a decimal string again.
 *
 * COMPARING WITH LAST YEAR. A day or a week is compared with the one 52 weeks
 * earlier (364 days), so a Sunday is set against a Sunday and the weekly
 * rhythm does not show up as a change. A month is compared with the same
 * calendar month. A bucket counts in a comparison only when its whole
 * year-earlier span is inside the history; where only part of a period has a
 * year-earlier record, the change is worked out on that part alone and the
 * result says how many buckets it covers. Comparing a whole year with half a
 * year would print a fall that never happened.
 */
import { addDays, addMonths, dateOfDay, dayNumber, firstDayOf, lastDayOf, monthOf } from './calendar.js';

/** One day's sales of one material, to one customer, from one site. */
export interface SaleLine {
  /** IST calendar date, `YYYY-MM-DD`. */
  date: string;
  customerId: string;
  productCode: string;
  siteId: string;
  /** Trade units sold. 1 unit = 100 cft. */
  units: number;
  /** Rupees before GST, as a decimal string. */
  value: string;
}

/** Which lines to count. An absent or null field does not filter. */
export interface SalesFilter {
  customerId?: string | null | undefined;
  productCode?: string | null | undefined;
  siteId?: string | null | undefined;
}

export interface SalesAmount {
  units: number;
  /** Rupees, as a decimal string. */
  value: string;
}

export function matchesFilter(line: SaleLine, filter: SalesFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.customerId && line.customerId !== filter.customerId) return false;
  if (filter.productCode && line.productCode !== filter.productCode) return false;
  if (filter.siteId && line.siteId !== filter.siteId) return false;
  return true;
}

/* ------------------------------------------------------------ whole numbers */

interface Sum {
  tenths: number;
  paise: number;
}

const toPaise = (value: string) => Math.round(Number.parseFloat(value) * 100);
const toTenths = (units: number) => Math.round(units * 10);
const zero = (): Sum => ({ tenths: 0, paise: 0 });

function addLine(sum: Sum, line: SaleLine) {
  sum.tenths += toTenths(line.units);
  sum.paise += toPaise(line.value);
}

function addSum(into: Sum, from: Sum) {
  into.tenths += from.tenths;
  into.paise += from.paise;
}

/** Whole paise as a rupee string: `1234567` → `'12345.67'`. */
export function paiseToRupees(paise: number): string {
  const whole = Math.round(paise);
  const abs = Math.abs(whole);
  return `${whole < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const amountOf = (sum: Sum): SalesAmount => ({ units: sum.tenths / 10, value: paiseToRupees(sum.paise) });

/** Rupees per unit, to the paisa, or null when nothing was sold. */
export function ratePerUnit(amount: SalesAmount): string | null {
  if (amount.units <= 0) return null;
  return paiseToRupees(toPaise(amount.value) / amount.units);
}

/** Percentage change, or null when there is nothing earlier to compare with. */
export function changePct(now: number, before: number): number | null {
  return before > 0 ? ((now - before) / before) * 100 : null;
}

/* ------------------------------------------------------------------ periods */

export type TrendPeriod = '30d' | '3m' | '12m';
export const TREND_PERIODS: readonly TrendPeriod[] = ['30d', '3m', '12m'];

/** How the over-time view is cut: by day for 30 days, by week for 3 months, by month for 12. */
export type TrendGrain = 'day' | 'week' | 'month';

export interface DateSpan {
  /** Inclusive IST dates. */
  from: string;
  to: string;
}

export interface TrendBucket {
  /** The bucket's last day (`YYYY-MM-DD`) for days and weeks; `YYYY-MM` for months. */
  key: string;
  span: DateSpan;
  lastYear: DateSpan;
  /** The whole year-earlier span is inside the history. */
  compared: boolean;
}

export interface PeriodPlan {
  period: TrendPeriod;
  grain: TrendGrain;
  span: DateSpan;
  buckets: TrendBucket[];
  /** How many buckets compare like for like with last year. */
  comparedCount: number;
}

/** 52 weeks: the day a year ago that falls on the same weekday. */
export const YEAR_AGO_DAYS = 364;

/**
 * The period's spans and buckets.
 *
 * 30 days and 3 months (13 weeks) end today. 12 months are the twelve whole
 * calendar months before this one — a month eight days old drawn beside full
 * months would read as a collapse.
 */
export function planPeriod(period: TrendPeriod, today: string, historyFrom: string): PeriodPlan {
  let buckets: TrendBucket[];
  let grain: TrendGrain;
  if (period === '12m') {
    grain = 'month';
    const last = addMonths(monthOf(today), -1);
    buckets = Array.from({ length: 12 }, (_, i) => {
      const month = addMonths(last, i - 11);
      const before = addMonths(month, -12);
      return {
        key: month,
        span: { from: firstDayOf(month), to: lastDayOf(month) },
        lastYear: { from: firstDayOf(before), to: lastDayOf(before) },
        compared: firstDayOf(before) >= historyFrom,
      };
    });
  } else {
    grain = period === '30d' ? 'day' : 'week';
    const size = period === '30d' ? 1 : 7;
    const count = period === '30d' ? 30 : 13;
    const start = addDays(today, -(size * count - 1));
    buckets = Array.from({ length: count }, (_, i) => {
      const from = addDays(start, i * size);
      const to = addDays(from, size - 1);
      const lastYear = { from: addDays(from, -YEAR_AGO_DAYS), to: addDays(to, -YEAR_AGO_DAYS) };
      return { key: to, span: { from, to }, lastYear, compared: lastYear.from >= historyFrom };
    });
  }
  return {
    period,
    grain,
    span: { from: buckets[0]!.span.from, to: buckets[buckets.length - 1]!.span.to },
    buckets,
    comparedCount: buckets.filter((b) => b.compared).length,
  };
}

/** For each date in the plan: the bucket it falls in this year, and the one it stands for a year earlier. */
function indexDays(plan: PeriodPlan): Map<string, { now: number; lastYear: number }> {
  const index = new Map<string, { now: number; lastYear: number }>();
  const slot = (date: string) => {
    let s = index.get(date);
    if (!s) {
      s = { now: -1, lastYear: -1 };
      index.set(date, s);
    }
    return s;
  };
  plan.buckets.forEach((b, i) => {
    for (let d = dayNumber(b.span.from); d <= dayNumber(b.span.to); d++) slot(dateOfDay(d)).now = i;
    if (!b.compared) return;
    for (let d = dayNumber(b.lastYear.from); d <= dayNumber(b.lastYear.to); d++) slot(dateOfDay(d)).lastYear = i;
  });
  return index;
}

/* ---------------------------------------------------------------- over time */

export interface TrendPoint {
  key: string;
  span: DateSpan;
  now: SalesAmount;
  /** Null when the history does not reach back to the year-earlier span. */
  lastYear: SalesAmount | null;
}

/** Like-for-like: the compared buckets only, this year against last. */
export interface YearComparison {
  /** How many buckets are compared, of how many in the period. */
  buckets: number;
  of: number;
  now: SalesAmount;
  lastYear: SalesAmount;
  valuePct: number | null;
  unitsPct: number | null;
}

export interface SalesOverTime {
  points: TrendPoint[];
  total: SalesAmount;
  /** Null when no part of the period has a year-earlier record. */
  compared: YearComparison | null;
}

export function salesOverTime(lines: readonly SaleLine[], plan: PeriodPlan, filter?: SalesFilter): SalesOverTime {
  const index = indexDays(plan);
  const now = plan.buckets.map(zero);
  const lastYear = plan.buckets.map(zero);
  for (const line of lines) {
    const slot = index.get(line.date);
    if (!slot || !matchesFilter(line, filter)) continue;
    if (slot.now >= 0) addLine(now[slot.now]!, line);
    if (slot.lastYear >= 0) addLine(lastYear[slot.lastYear]!, line);
  }

  const total = zero();
  const comparedNow = zero();
  const comparedBefore = zero();
  plan.buckets.forEach((b, i) => {
    addSum(total, now[i]!);
    if (!b.compared) return;
    addSum(comparedNow, now[i]!);
    addSum(comparedBefore, lastYear[i]!);
  });

  return {
    points: plan.buckets.map((b, i) => ({
      key: b.key,
      span: b.span,
      now: amountOf(now[i]!),
      lastYear: b.compared ? amountOf(lastYear[i]!) : null,
    })),
    total: amountOf(total),
    compared:
      plan.comparedCount === 0
        ? null
        : {
            buckets: plan.comparedCount,
            of: plan.buckets.length,
            now: amountOf(comparedNow),
            lastYear: amountOf(comparedBefore),
            valuePct: changePct(comparedNow.paise, comparedBefore.paise),
            unitsPct: changePct(comparedNow.tenths, comparedBefore.tenths),
          },
  };
}

/* ------------------------------------------------------------- by customer */

/** Never under three weeks: a customer who buys every day can still skip a fortnight. */
export const STOPPED_MIN_DAYS = 21;
/** Stopped means quiet for three of their usual gaps between orders. */
export const STOPPED_GAP_TIMES = 3;
/** How far back their usual gap between orders is read. */
export const USUAL_GAP_WINDOW_DAYS = 120;
/** A fall this large on last year is flagged. */
export const SHARP_FALL_PCT = 40;

/** Where a customer stands today, whatever period is on screen. */
export interface CustomerStanding {
  lastBoughtOn: string | null;
  daysSince: number | null;
  /** Median days between their orders before the last one; null with too few orders to say. */
  usualGapDays: number | null;
  stopped: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Has each customer stopped buying?
 *
 * Quiet for three of their usual gaps between orders, and never less than
 * three weeks. "Usual" is the median gap over the four months before their
 * last order, so one long wait does not set it. With fewer than three gaps to
 * go on there is no usual, and nobody is called stopped on a guess.
 */
export function customerStandings(lines: readonly SaleLine[], today: string, filter?: SalesFilter): Map<string, CustomerStanding> {
  const orderDays = new Map<string, Set<number>>();
  const end = dayNumber(today);
  for (const line of lines) {
    if (line.units <= 0 || !matchesFilter(line, filter)) continue;
    const day = dayNumber(line.date);
    if (day > end) continue;
    let days = orderDays.get(line.customerId);
    if (!days) {
      days = new Set();
      orderDays.set(line.customerId, days);
    }
    days.add(day);
  }

  const out = new Map<string, CustomerStanding>();
  for (const [customerId, set] of orderDays) {
    const days = [...set].sort((a, b) => a - b);
    const last = days[days.length - 1]!;
    const recent = days.filter((d) => d >= last - USUAL_GAP_WINDOW_DAYS);
    const gaps = recent.slice(1).map((d, i) => d - recent[i]!);
    const usualGapDays = gaps.length >= 3 ? median(gaps) : null;
    const daysSince = end - last;
    out.set(customerId, {
      lastBoughtOn: dateOfDay(last),
      daysSince,
      usualGapDays,
      stopped: usualGapDays !== null && daysSince >= Math.max(STOPPED_MIN_DAYS, STOPPED_GAP_TIMES * usualGapDays),
    });
  }
  return out;
}

export type CustomerFlag = 'stopped' | 'fell';

export interface CustomerTrend {
  customerId: string;
  /** The whole period. */
  now: SalesAmount;
  /** Share of the period's sales value, 0–100. */
  sharePct: number;
  /** Like for like on last year; null when not compared or nothing then. */
  valuePct: number | null;
  /** Compared, bought nothing a year earlier, buys now. */
  isNew: boolean;
  /** Rupees per step across the period, for a sparkline only. */
  spark: number[];
  standing: CustomerStanding | null;
  /** Stopped buying (today), or fell sharply on last year (this period). */
  flag: CustomerFlag | null;
}

/**
 * The sparkline's steps. Weeks or months follow the period's own buckets; 30
 * days are drawn as the last four weeks, because a customer's day-by-day
 * orders are a comb of spikes, not a trend.
 */
function sparkIndex(plan: PeriodPlan): { steps: number; at: Map<string, number> } {
  const at = new Map<string, number>();
  if (plan.grain === 'day') {
    const start = dayNumber(plan.span.to) - 27;
    for (let d = start; d <= dayNumber(plan.span.to); d++) at.set(dateOfDay(d), Math.floor((d - start) / 7));
    return { steps: 4, at };
  }
  plan.buckets.forEach((b, i) => {
    for (let d = dayNumber(b.span.from); d <= dayNumber(b.span.to); d++) at.set(dateOfDay(d), i);
  });
  return { steps: plan.buckets.length, at };
}

/**
 * Every customer who bought in the period or in its year-earlier part, the
 * biggest first. Their standing (stopped or not) is read with the same site
 * filter but across every material — a builder who stops buying one grade has
 * not stopped buying.
 */
export function salesByCustomer(lines: readonly SaleLine[], plan: PeriodPlan, today: string, filter?: SalesFilter): CustomerTrend[] {
  const index = indexDays(plan);
  const spark = sparkIndex(plan);
  const rows = new Map<string, { now: Sum; comparedNow: Sum; comparedBefore: Sum; spark: number[] }>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { now: zero(), comparedNow: zero(), comparedBefore: zero(), spark: Array<number>(spark.steps).fill(0) };
      rows.set(id, r);
    }
    return r;
  };

  let totalPaise = 0;
  for (const line of lines) {
    const slot = index.get(line.date);
    if (!slot || !matchesFilter(line, filter)) continue;
    if (slot.now >= 0) {
      const r = row(line.customerId);
      addLine(r.now, line);
      totalPaise += toPaise(line.value);
      if (plan.buckets[slot.now]!.compared) addLine(r.comparedNow, line);
      const step = spark.at.get(line.date);
      if (step !== undefined) r.spark[step]! += toPaise(line.value) / 100;
    }
    if (slot.lastYear >= 0) addLine(row(line.customerId).comparedBefore, line);
  }

  const standings = customerStandings(lines, today, { siteId: filter?.siteId ?? null });
  const compared = plan.comparedCount > 0;

  const out = [...rows.entries()].map(([customerId, r]) => {
    const valuePct = compared ? changePct(r.comparedNow.paise, r.comparedBefore.paise) : null;
    const standing = standings.get(customerId) ?? null;
    const trend: CustomerTrend = {
      customerId,
      now: amountOf(r.now),
      sharePct: totalPaise > 0 ? (r.now.paise / totalPaise) * 100 : 0,
      valuePct,
      isNew: compared && r.comparedBefore.paise === 0 && r.comparedNow.paise > 0,
      spark: r.spark.map((v) => Math.round(v)),
      standing,
      flag: standing?.stopped ? 'stopped' : valuePct !== null && valuePct <= -SHARP_FALL_PCT ? 'fell' : null,
    };
    return { trend, now: r.now.paise, before: r.comparedBefore.paise };
  });
  return out
    .sort((a, b) => b.now - a.now || b.before - a.before || a.trend.customerId.localeCompare(b.trend.customerId))
    .map((x) => x.trend);
}

/* ------------------------------------------------------------- by material */

export interface MaterialTrend {
  productCode: string;
  now: SalesAmount;
  /** Share of the period's units, 0–100. */
  unitsSharePct: number;
  /** Like for like on last year; null when not compared or nothing then. */
  unitsPct: number | null;
  valuePct: number | null;
  isNew: boolean;
}

/** Every material sold in the period or its year-earlier part, the most units first. */
export function salesByMaterial(lines: readonly SaleLine[], plan: PeriodPlan, filter?: SalesFilter): MaterialTrend[] {
  const index = indexDays(plan);
  const rows = new Map<string, { now: Sum; comparedNow: Sum; comparedBefore: Sum }>();
  const row = (code: string) => {
    let r = rows.get(code);
    if (!r) {
      r = { now: zero(), comparedNow: zero(), comparedBefore: zero() };
      rows.set(code, r);
    }
    return r;
  };

  let totalTenths = 0;
  for (const line of lines) {
    const slot = index.get(line.date);
    if (!slot || !matchesFilter(line, filter)) continue;
    if (slot.now >= 0) {
      const r = row(line.productCode);
      addLine(r.now, line);
      totalTenths += toTenths(line.units);
      if (plan.buckets[slot.now]!.compared) addLine(r.comparedNow, line);
    }
    if (slot.lastYear >= 0) addLine(row(line.productCode).comparedBefore, line);
  }

  const compared = plan.comparedCount > 0;
  const out = [...rows.entries()].map(([productCode, r]) => {
    const trend: MaterialTrend = {
      productCode,
      now: amountOf(r.now),
      unitsSharePct: totalTenths > 0 ? (r.now.tenths / totalTenths) * 100 : 0,
      unitsPct: compared ? changePct(r.comparedNow.tenths, r.comparedBefore.tenths) : null,
      valuePct: compared ? changePct(r.comparedNow.paise, r.comparedBefore.paise) : null,
      isNew: compared && r.comparedBefore.tenths === 0 && r.comparedNow.tenths > 0,
    };
    return { trend, now: r.now.tenths, before: r.comparedBefore.tenths };
  });
  return out
    .sort((a, b) => b.now - a.now || b.before - a.before || a.trend.productCode.localeCompare(b.trend.productCode))
    .map((x) => x.trend);
}
