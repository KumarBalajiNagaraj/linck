import { describe, expect, it } from 'vitest';
import { PRODUCTS, SALES_HISTORY, SALES_HISTORY_FROM, SALES_HISTORY_TO } from '../../mock/src/index.js';
import { addDays, dayDiff, monthOf } from './calendar.js';
import {
  backtest,
  dailyUnits,
  forecastMonth,
  forecastNextMonth,
  forecastWithRange,
  summarizeBacktest,
  UNCHECKED_RANGE_PCT,
  type BacktestRow,
} from './sales-forecast.js';
import type { SaleLine } from './sales-trends.js';

const TODAY = '2026-08-08';
const FROM = '2025-02-01';

/** Units every day from `from` to `to`, by a rule of the date. */
function history(from: string, to: string, unitsOn: (date: string) => number): Map<string, number> {
  const daily = new Map<string, number>();
  for (let i = 0; i <= dayDiff(from, to); i++) {
    const date = addDays(from, i);
    daily.set(date, unitsOn(date));
  }
  return daily;
}

/** 100 a day in 2025, 120 a day from 2026: this year runs 20% ahead. */
const growing = history(FROM, TODAY, (d) => (d < '2026-01-01' ? 100 : 120));

describe('forecastMonth', () => {
  it('takes the same month last year when nothing has changed', () => {
    const flat = history(FROM, TODAY, () => 100);
    expect(forecastMonth(flat, '2026-09', TODAY, FROM)).toMatchObject({ units: 3000, basis: 'last_year', lastYearUnits: 3000, change: 1 });
  });

  it('carries this year\'s change over the last 13 weeks onto last year\'s month', () => {
    const f = forecastMonth(growing, '2026-09', TODAY, FROM);
    expect(f.change).toBeCloseTo(1.2, 9);
    expect(f.units).toBeCloseTo(3600, 6);
  });

  it('keeps the season: a rain month last year stays a rain month', () => {
    const rainy = history(FROM, TODAY, (d) => (d.slice(5, 7) === '11' ? 40 : 100));
    expect(forecastMonth(rainy, '2026-11', TODAY, FROM).units).toBe(1200);
  });

  it('caps the change, so one customer won does not double the year', () => {
    const jump = history(FROM, TODAY, (d) => (d < '2026-01-01' ? 100 : 500));
    expect(forecastMonth(jump, '2026-09', TODAY, FROM).change).toBe(2);
  });

  it('falls back to the last 13 weeks\' pace when last year has no record of the month', () => {
    const young = history('2026-01-01', TODAY, () => 50);
    expect(forecastMonth(young, '2026-09', TODAY, '2026-01-01')).toMatchObject({ basis: 'recent', lastYearUnits: null, units: 1500 });
  });

  it('does not measure a change over less than four weeks of year-earlier record', () => {
    // History from 20 July 2025: only 21 days of this year have a twin.
    const short = history('2025-07-20', TODAY, () => 100);
    expect(forecastMonth(short, '2026-09', TODAY, '2025-07-20')).toMatchObject({ basis: 'last_year', change: null, units: 3000 });
  });

  it('never reads past the day it stands on', () => {
    const later = new Map(growing);
    later.set('2026-09-15', 1_000_000);
    expect(forecastMonth(later, '2026-09', TODAY, FROM).units).toBeCloseTo(3600, 6);
  });
});

describe('backtest', () => {
  it('tries each past month as of the same day of the month before, against "same as last month"', () => {
    const rows = backtest(growing, TODAY, FROM);
    // February and March 2026 could not measure a change yet, so they test a
    // different rule and are left out.
    expect(rows.map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07']);
    const april = rows[0]!;
    expect(april.actual).toBe(3600);
    expect(april.forecast).toBeCloseTo(3600, 6);
    expect(april.naive).toBe(28 * 120); // February 2026
  });

  it('is not fooled by what happened after the day it stands on', () => {
    // A collapse in July is not visible from 8 June.
    const crash = history(FROM, TODAY, (d) => (d >= '2026-07-01' ? 10 : 100));
    const july = backtest(crash, TODAY, FROM).find((r) => r.month === '2026-07')!;
    expect(july.forecast).toBe(3100);
    expect(july.actual).toBe(310);
  });
});

describe('summarizeBacktest', () => {
  const row = (actual: number, forecast: number, naive = actual): BacktestRow => ({ month: '2026-01', actual, forecast, naive });

  it('reports the misses over the sales, and the naive rule\'s beside them', () => {
    const s = summarizeBacktest([row(100, 110, 150), row(100, 90, 50), row(200, 200, 200)]);
    expect(s.errorPct).toBeCloseTo(5, 9);
    expect(s.naiveErrorPct).toBeCloseTo(25, 9);
  });

  it('draws the range as wide as four misses in five, never under 5%', () => {
    const misses = [1, 2, 3, 4, 30].map((pct) => row(100 + pct, 100));
    expect(summarizeBacktest(misses)).toMatchObject({ rangePct: 5, held: 4, months: 5 });
    const wider = [5, 8, 12, 20, 30].map((pct) => row(100 - pct, 100));
    expect(summarizeBacktest(wider)).toMatchObject({ rangePct: 20, held: 4 });
  });

  it('gives a plain wide range with too few months to check', () => {
    expect(summarizeBacktest([row(100, 100), row(100, 100)]).rangePct).toBe(UNCHECKED_RANGE_PCT);
  });
});

describe('forecastWithRange', () => {
  it('spreads the range evenly around the forecast', () => {
    const f = forecastWithRange(growing, '2026-09', TODAY, FROM);
    expect(f.rangePct).toBe(5); // the rule never missed here
    expect(f.low).toBeCloseTo(3600 * 0.95, 6);
    expect(f.high).toBeCloseTo(3600 * 1.05, 6);
  });

  it('never trusts the fallback more than the plain range', () => {
    const young = history('2026-01-01', TODAY, () => 50);
    expect(forecastWithRange(young, '2026-09', TODAY, '2026-01-01').rangePct).toBe(UNCHECKED_RANGE_PCT);
  });
});

describe('forecastNextMonth', () => {
  const line = (date: string, productCode: string, units: number, value: string): SaleLine => ({
    date,
    customerId: 'c1',
    productCode,
    siteId: 'krp',
    units,
    value,
  });

  it('forecasts each material on its own and prices it at its own recent rate', () => {
    const lines: SaleLine[] = [];
    for (let i = 0; i <= dayDiff(FROM, TODAY); i++) {
      const date = addDays(FROM, i);
      lines.push(line(date, 'MSAND', 10, '60000.00'), line(date, 'AGG40', 2, '10000.00'));
    }
    lines.push(line('2023-01-05', 'OLD', 5, '5000.00'));
    const next = forecastNextMonth(lines, TODAY, '2023-01-05');
    expect(next.month).toBe('2026-09');
    expect(next.materials.map((m) => [m.productCode, m.units])).toEqual([
      ['MSAND', 300],
      ['AGG40', 60],
    ]);
    expect(next.total.units).toBe(360);
    expect(next.value).toBe('2100000.00');
  });
});

/*
 * The seeded history: 18 months up to 8 August 2026, with the seasons and the
 * customers' stories in it. The rule has to beat "same as last month" on it,
 * or it has no business on the director's screen.
 */
describe('on the seeded sales history', () => {
  const next = forecastNextMonth(SALES_HISTORY, SALES_HISTORY_TO, SALES_HISTORY_FROM);

  it('beats "same as last month" in total', () => {
    const checked = next.total.checked;
    expect(checked.months).toBe(4);
    expect(checked.errorPct!).toBeLessThan(checked.naiveErrorPct!);
    // About 11% off against about 19% at the time of writing.
    expect(checked.errorPct!).toBeLessThan(15);
    expect(checked.naiveErrorPct!).toBeGreaterThan(15);
  });

  it('beats it on every material, and on all of them together', () => {
    let miss = 0;
    let naiveMiss = 0;
    let sold = 0;
    for (const m of next.materials) {
      expect(m.checked.errorPct!, m.productCode).toBeLessThan(m.checked.naiveErrorPct!);
      const rows = backtest(dailyUnits(SALES_HISTORY, { productCode: m.productCode }), SALES_HISTORY_TO, SALES_HISTORY_FROM);
      for (const r of rows) {
        miss += Math.abs(r.forecast - r.actual);
        naiveMiss += Math.abs(r.naive - r.actual);
        sold += r.actual;
      }
    }
    expect(miss / sold).toBeLessThan(naiveMiss / sold);
  });

  it('forecasts September for every material sold this year, with a range the past supports', () => {
    expect(next.month).toBe(monthOf(addDays(SALES_HISTORY_TO, 31)));
    expect(next.materials.map((m) => m.productCode).sort()).toEqual(PRODUCTS.map((p) => p.code).sort());
    expect(next.total.basis).toBe('last_year');
    expect(next.total.low).toBeLessThan(next.total.units);
    expect(next.total.high).toBeGreaterThan(next.total.units);
    expect(next.total.rangePct).toBeLessThanOrEqual(UNCHECKED_RANGE_PCT);
    // The parts are forecast separately but land close to the whole.
    const parts = next.materials.reduce((s, m) => s + m.units, 0);
    expect(Math.abs(parts - next.total.units) / next.total.units).toBeLessThan(0.02);
  });
});
