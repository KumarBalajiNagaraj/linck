/**
 * HEADS-UP (LIN-9): what in the sales history deserves a look before it
 * becomes a problem.
 *
 * Five rules, each plain enough to say in one line, each returning a code and
 * its numbers — the screen words them in English and Tamil and says what each
 * is based on:
 *
 *   stock_short       A pile that runs out within two weeks at next month's
 *                     expected pace — per site, because stock at one crusher
 *                     does not load a lorry at the other. New crushing is not
 *                     counted, so this is "how long the heap lasts", the
 *                     question to put to the plant.
 *   customer_stopped  A regular buyer gone quiet for three of their usual gaps
 *                     (Sales trends uses the same rule), who was still buying
 *                     in the last four months — an old loss is not news.
 *   customer_less     A buyer whose last 30 days are 40% under their usual 30
 *                     days, beyond what the whole business moved by: in the
 *                     rain months everyone buys less, and that is the season,
 *                     not the customer.
 *   material_rising   A material up 20% or more on the same 13 weeks last year,
 *                     and big enough to matter (5% of units or more).
 *   season            The coming months, read off the same months last year: a
 *                     month that ran 20% under a usual month, or 15% over.
 *
 * Pure: the caller passes the lines, the stock and today's date.
 */
import { addDays, addMonths, daysInMonth, firstDayOf, lastDayOf, monthOf } from './calendar.js';
import { dailyUnits, forecastMonth, unitsBetween } from './sales-forecast.js';
import { customerStandings, matchesFilter, planPeriod, salesByMaterial, type SaleLine, type SalesFilter } from './sales-trends.js';

export type HeadsUp =
  | { kind: 'stock_short'; productCode: string; siteId: string; days: number; stockUnits: number; perDay: number }
  | { kind: 'customer_stopped'; customerId: string; daysSince: number; usualGapDays: number }
  | { kind: 'customer_less'; customerId: string; dropPct: number }
  | { kind: 'material_rising'; productCode: string; risePct: number }
  | { kind: 'season'; month: string; lastYearMonth: string; changePct: number };

export const STOCK_WARN_DAYS = 14;
export const LESS_THAN_USUAL_PCT = 40;
export const RISING_FAST_PCT = 20;
export const RISING_MIN_SHARE_PCT = 5;
/** A month last year this far under a usual month is a slow season ahead; this far over, a busy one. */
export const SEASON_LOW = 0.8;
export const SEASON_HIGH = 1.15;
export const SEASON_LOOKAHEAD_MONTHS = 4;

export interface StockRow {
  productCode: string;
  siteId: string;
  units: number;
}

/** Piles that run out within `withinDays` at next month's expected pace, soonest first. */
export function stockHeadsUps(
  lines: readonly SaleLine[],
  stock: readonly StockRow[],
  today: string,
  historyFrom: string,
  withinDays = STOCK_WARN_DAYS,
): HeadsUp[] {
  const next = addMonths(monthOf(today), 1);
  const out: HeadsUp[] = [];
  for (const row of stock) {
    const forecast = forecastMonth(dailyUnits(lines, { siteId: row.siteId, productCode: row.productCode }), next, today, historyFrom);
    const perDay = forecast.units / daysInMonth(next);
    if (perDay <= 0) continue;
    const days = row.units / perDay;
    if (days <= withinDays) {
      out.push({ kind: 'stock_short', productCode: row.productCode, siteId: row.siteId, days: Math.floor(days), stockUnits: row.units, perDay });
    }
  }
  return out.sort((a, b) => (a.kind === 'stock_short' && b.kind === 'stock_short' ? a.days - b.days : 0));
}

/** Customers who stopped, then customers buying far under their usual — the longest silence and the deepest fall first. */
export function customerHeadsUps(lines: readonly SaleLine[], today: string, filter?: SalesFilter): HeadsUp[] {
  const scope: SalesFilter = { siteId: filter?.siteId ?? null };
  const recentFrom = addDays(today, -29);
  const usualFrom = addDays(today, -119);
  const usualTo = addDays(today, -30);
  const recent = new Map<string, number>();
  const usual = new Map<string, number>();
  let allRecent = 0;
  let allUsual = 0;
  for (const line of lines) {
    if (!matchesFilter(line, scope) || line.date > today || line.date < usualFrom) continue;
    if (line.date >= recentFrom) {
      recent.set(line.customerId, (recent.get(line.customerId) ?? 0) + line.units);
      allRecent += line.units;
    } else if (line.date <= usualTo) {
      usual.set(line.customerId, (usual.get(line.customerId) ?? 0) + line.units);
      allUsual += line.units;
    }
  }
  // Their usual is three months long; the last 30 days are one.
  const businessRatio = allUsual > 0 ? allRecent / (allUsual / 3) : 1;
  const standings = customerStandings(lines, today, scope);

  const stopped: HeadsUp[] = [];
  const less: HeadsUp[] = [];
  for (const [customerId, usualUnits] of usual) {
    const standing = standings.get(customerId);
    if (standing?.stopped && standing.daysSince !== null && standing.usualGapDays !== null) {
      stopped.push({ kind: 'customer_stopped', customerId, daysSince: standing.daysSince, usualGapDays: standing.usualGapDays });
      continue;
    }
    const ratio = (recent.get(customerId) ?? 0) / (usualUnits / 3);
    if (ratio <= (1 - LESS_THAN_USUAL_PCT / 100) * businessRatio) {
      less.push({ kind: 'customer_less', customerId, dropPct: Math.round((1 - ratio) * 100) });
    }
  }
  const daysOf = (h: HeadsUp) => (h.kind === 'customer_stopped' ? h.daysSince : 0);
  const dropOf = (h: HeadsUp) => (h.kind === 'customer_less' ? h.dropPct : 0);
  return [...stopped.sort((a, b) => daysOf(b) - daysOf(a)), ...less.sort((a, b) => dropOf(b) - dropOf(a))];
}

/** Materials whose last 13 weeks beat the same weeks last year by 20% or more — Sales trends' 3-month figure. */
export function materialHeadsUps(lines: readonly SaleLine[], today: string, historyFrom: string, filter?: SalesFilter): HeadsUp[] {
  const plan = planPeriod('3m', today, historyFrom);
  if (plan.comparedCount < plan.buckets.length) return [];
  return salesByMaterial(lines, plan, { siteId: filter?.siteId ?? null })
    .filter((m) => m.unitsPct !== null && m.unitsPct >= RISING_FAST_PCT && m.unitsSharePct >= RISING_MIN_SHARE_PCT)
    .map((m): HeadsUp => ({ kind: 'material_rising', productCode: m.productCode, risePct: Math.round(m.unitsPct ?? 0) }))
    .sort((a, b) => (a.kind === 'material_rising' && b.kind === 'material_rising' ? b.risePct - a.risePct : 0));
}

/**
 * The season ahead, from last year: of the next four months, the one that ran
 * furthest under a usual month (units a day against the twelve whole months
 * to last month). Failing that, the one furthest over. A slow season is the
 * warning worth having, so it wins.
 */
export function seasonHeadsUp(
  lines: readonly SaleLine[],
  today: string,
  historyFrom: string,
  filter?: SalesFilter,
  lookAhead = SEASON_LOOKAHEAD_MONTHS,
): HeadsUp | null {
  const daily = dailyUnits(lines, { siteId: filter?.siteId ?? null });
  const lastWhole = addMonths(monthOf(today), -1);
  let units = 0;
  let days = 0;
  let months = 0;
  for (let m = lastWhole; months < 12 && firstDayOf(m) >= historyFrom; m = addMonths(m, -1), months++) {
    units += unitsBetween(daily, firstDayOf(m), lastDayOf(m));
    days += daysInMonth(m);
  }
  if (months < 6 || units <= 0) return null;
  const usualPerDay = units / days;

  const ahead: { month: string; lastYearMonth: string; ratio: number }[] = [];
  for (let k = 1; k <= lookAhead; k++) {
    const month = addMonths(monthOf(today), k);
    const lastYearMonth = addMonths(month, -12);
    if (firstDayOf(lastYearMonth) < historyFrom || lastDayOf(lastYearMonth) > today) continue;
    const perDay = unitsBetween(daily, firstDayOf(lastYearMonth), lastDayOf(lastYearMonth)) / daysInMonth(lastYearMonth);
    ahead.push({ month, lastYearMonth, ratio: perDay / usualPerDay });
  }
  const lowest = [...ahead].sort((a, b) => a.ratio - b.ratio)[0];
  const highest = [...ahead].sort((a, b) => b.ratio - a.ratio)[0];
  const pick = lowest && lowest.ratio <= SEASON_LOW ? lowest : highest && highest.ratio >= SEASON_HIGH ? highest : null;
  return pick ? { kind: 'season', month: pick.month, lastYearMonth: pick.lastYearMonth, changePct: Math.round((pick.ratio - 1) * 100) } : null;
}

/** Every heads-up for the sites in scope, the most urgent kind first. */
export function salesHeadsUps(input: {
  lines: readonly SaleLine[];
  stock: readonly StockRow[];
  today: string;
  historyFrom: string;
  siteId?: string | null | undefined;
}): HeadsUp[] {
  const filter: SalesFilter = { siteId: input.siteId ?? null };
  const stock = input.siteId ? input.stock.filter((s) => s.siteId === input.siteId) : input.stock;
  const season = seasonHeadsUp(input.lines, input.today, input.historyFrom, filter);
  return [
    ...stockHeadsUps(input.lines, stock, input.today, input.historyFrom),
    ...customerHeadsUps(input.lines, input.today, filter),
    ...materialHeadsUps(input.lines, input.today, input.historyFrom, filter),
    ...(season ? [season] : []),
  ];
}
