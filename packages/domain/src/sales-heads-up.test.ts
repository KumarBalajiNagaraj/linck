import { describe, expect, it } from 'vitest';
import { SALES_HISTORY, SALES_HISTORY_FROM, SALES_HISTORY_TO, STOCK } from '../../mock/src/index.js';
import { addDays, dayDiff } from './calendar.js';
import { customerHeadsUps, materialHeadsUps, salesHeadsUps, seasonHeadsUp, stockHeadsUps } from './sales-heads-up.js';
import type { SaleLine } from './sales-trends.js';

const TODAY = '2026-08-08';
const FROM = '2025-02-01';

/** One line a day from `from` to `to`, inclusive. */
const everyDay = (from: string, to: string, units: number, over: Partial<SaleLine> = {}): SaleLine[] =>
  Array.from({ length: dayDiff(from, to) + 1 }, (_, i) => ({
    date: addDays(from, i),
    customerId: 'c1',
    productCode: 'MSAND',
    siteId: 'krp',
    units,
    value: (units * 6000).toFixed(2),
    ...over,
  }));

describe('stockHeadsUps', () => {
  // Ten units a day at Karapakkam, all through the history.
  const lines = everyDay(FROM, TODAY, 10);

  it('warns when a pile lasts two weeks or less at next month\'s pace, soonest first', () => {
    const stock = [
      { productCode: 'MSAND', siteId: 'krp', units: 120 },
      { productCode: 'MSAND', siteId: 'krp', units: 55 },
      { productCode: 'MSAND', siteId: 'krp', units: 400 },
    ];
    expect(stockHeadsUps(lines, stock, TODAY, FROM).map((h) => (h.kind === 'stock_short' ? h.days : -1))).toEqual([5, 12]);
  });

  it('reads each site\'s own sales: a pile nobody buys from never runs short', () => {
    expect(stockHeadsUps(lines, [{ productCode: 'MSAND', siteId: 'tvl', units: 1 }], TODAY, FROM)).toEqual([]);
  });
});

describe('customerHeadsUps', () => {
  it('names a regular buyer who went quiet, with how long and how often they used to buy', () => {
    const lines = [...everyDay(FROM, TODAY, 10, { customerId: 'steady' }), ...everyDay(FROM, '2026-06-26', 5, { customerId: 'gone' })];
    expect(customerHeadsUps(lines, TODAY)).toEqual([{ kind: 'customer_stopped', customerId: 'gone', daysSince: 43, usualGapDays: 1 }]);
  });

  it('names a buyer far under their usual while the rest buy as before', () => {
    const lines = [
      ...everyDay(FROM, TODAY, 10, { customerId: 'steady' }),
      ...everyDay(FROM, '2026-07-09', 10, { customerId: 'slows' }),
      ...everyDay('2026-07-10', TODAY, 4, { customerId: 'slows' }),
    ];
    expect(customerHeadsUps(lines, TODAY)).toEqual([{ kind: 'customer_less', customerId: 'slows', dropPct: 60 }]);
  });

  it('blames the season, not the customer, when everyone buys less', () => {
    const lines = ['a', 'b', 'c'].flatMap((id) => [
      ...everyDay(FROM, '2026-07-09', 10, { customerId: id }),
      ...everyDay('2026-07-10', TODAY, id === 'c' ? 4 : 5, { customerId: id }),
    ]);
    // Everyone halved; c is a little worse, not 40% worse than the rest.
    expect(customerHeadsUps(lines, TODAY)).toEqual([]);
  });

  it('leaves out an old loss', () => {
    const lines = [...everyDay(FROM, TODAY, 10, { customerId: 'steady' }), ...everyDay(FROM, '2025-12-31', 5, { customerId: 'long-gone' })];
    expect(customerHeadsUps(lines, TODAY)).toEqual([]);
  });
});

describe('materialHeadsUps', () => {
  it('names a material up a fifth or more on the same weeks last year, if it is big enough to matter', () => {
    const lines = [
      ...everyDay(FROM, TODAY, 100, { productCode: 'AGG20' }),
      ...everyDay(FROM, '2025-12-31', 50),
      ...everyDay('2026-01-01', TODAY, 65),
      ...everyDay(FROM, '2025-12-31', 2, { productCode: 'AGG10' }),
      ...everyDay('2026-01-01', TODAY, 3, { productCode: 'AGG10' }),
    ];
    // M-Sand +30% and a third of the units; 10mm +50% but under 2%.
    expect(materialHeadsUps(lines, TODAY, FROM)).toEqual([{ kind: 'material_rising', productCode: 'MSAND', risePct: 30 }]);
  });

  it('says nothing without a whole year-earlier quarter to compare', () => {
    expect(materialHeadsUps(everyDay('2026-01-01', TODAY, 10), TODAY, '2026-01-01')).toEqual([]);
  });
});

describe('seasonHeadsUp', () => {
  it('warns of a month that ran well under a usual month last year', () => {
    const lines = everyDay(FROM, TODAY, 1).map((l) => ({ ...l, units: l.date.slice(5, 7) === '11' ? 50 : 100 }));
    // 50 a day against a usual 96: about half.
    expect(seasonHeadsUp(lines, TODAY, FROM)).toEqual({ kind: 'season', month: '2026-11', lastYearMonth: '2025-11', changePct: -48 });
  });

  it('names a busy month ahead when there is no slow one', () => {
    const lines = everyDay(FROM, TODAY, 1).map((l) => ({ ...l, units: l.date.slice(5, 7) === '10' ? 130 : 100 }));
    expect(seasonHeadsUp(lines, TODAY, FROM)).toMatchObject({ month: '2026-10', changePct: 27 });
  });

  it('stays quiet when the months ahead were ordinary', () => {
    expect(seasonHeadsUp(everyDay(FROM, TODAY, 100), TODAY, FROM)).toBeNull();
  });
});

/*
 * The stories seeded into the mock history must come out as heads-ups, worded
 * by kind on the screen.
 */
describe('on the seeded sales history', () => {
  const all = salesHeadsUps({ lines: SALES_HISTORY, stock: STOCK, today: SALES_HISTORY_TO, historyFrom: SALES_HISTORY_FROM });

  it('finds Alliance Infra stopped six weeks ago and Radiance buying far less', () => {
    expect(all).toContainEqual({ kind: 'customer_stopped', customerId: 'cus-05', daysSince: 43, usualGapDays: 1 });
    expect(all.find((h) => h.kind === 'customer_less')).toMatchObject({ customerId: 'cus-03' });
  });

  it('finds M-Sand rising fast, and the rain months coming', () => {
    expect(all.find((h) => h.kind === 'material_rising')).toMatchObject({ productCode: 'MSAND' });
    const season = all.find((h) => h.kind === 'season');
    expect(season).toMatchObject({ month: '2026-11' });
    expect(season?.kind === 'season' ? season.changePct : 0).toBeLessThanOrEqual(-30);
  });

  it('finds M-Sand at Thiruvallur running short first, and puts stock first', () => {
    expect(all[0]).toMatchObject({ kind: 'stock_short', productCode: 'MSAND', siteId: 'site-tvl' });
    const kinds = all.map((h) => h.kind);
    expect(kinds.indexOf('customer_stopped')).toBeGreaterThan(kinds.lastIndexOf('stock_short'));
  });

  it('keeps to one site when one is chosen', () => {
    const krp = salesHeadsUps({ lines: SALES_HISTORY, stock: STOCK, today: SALES_HISTORY_TO, historyFrom: SALES_HISTORY_FROM, siteId: 'site-krp' });
    expect(krp.every((h) => h.kind !== 'stock_short' || h.siteId === 'site-krp')).toBe(true);
  });
});
