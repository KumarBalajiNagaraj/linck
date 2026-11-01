import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysInMonth, dayDiff, lastDayOf, monthDiff, weekdayOf } from './calendar.js';
import {
  changePct,
  customerStandings,
  paiseToRupees,
  planPeriod,
  ratePerUnit,
  salesByCustomer,
  salesByMaterial,
  salesOverTime,
  YEAR_AGO_DAYS,
  type SaleLine,
} from './sales-trends.js';

const TODAY = '2026-08-08';
const FROM = '2025-02-01';

const line = (date: string, units: number, value: string, over: Partial<SaleLine> = {}): SaleLine => ({
  date,
  customerId: 'c1',
  productCode: 'MSAND',
  siteId: 'krp',
  units,
  value,
  ...over,
});

/** One line a day from `from` to `to`, inclusive. */
const everyDay = (from: string, to: string, units: number, value: string, over: Partial<SaleLine> = {}) =>
  Array.from({ length: dayDiff(from, to) + 1 }, (_, i) => line(addDays(from, i), units, value, over));

describe('calendar', () => {
  it('steps months across the year end and knows month lengths', () => {
    expect(addMonths('2025-11', 3)).toBe('2026-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthDiff('2025-02', '2026-08')).toBe(18);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(lastDayOf('2026-07')).toBe('2026-07-31');
  });

  it('reads weekdays from the date alone', () => {
    expect(weekdayOf('2026-08-08')).toBe(6); // a Saturday
    expect(weekdayOf(addDays('2026-08-08', -YEAR_AGO_DAYS))).toBe(6);
  });
});

describe('planPeriod', () => {
  it('cuts 30 days by day, ending today, against the same weekdays a year ago', () => {
    const plan = planPeriod('30d', TODAY, FROM);
    expect(plan.grain).toBe('day');
    expect(plan.span).toEqual({ from: '2026-07-10', to: TODAY });
    expect(plan.buckets).toHaveLength(30);
    const last = plan.buckets[29]!;
    expect(last.lastYear).toEqual({ from: '2025-08-09', to: '2025-08-09' });
    expect(weekdayOf(last.lastYear.from)).toBe(weekdayOf(last.span.from));
    expect(plan.comparedCount).toBe(30);
  });

  it('cuts 3 months into 13 whole weeks', () => {
    const plan = planPeriod('3m', TODAY, FROM);
    expect(plan.grain).toBe('week');
    expect(plan.buckets).toHaveLength(13);
    expect(dayDiff(plan.span.from, plan.span.to) + 1).toBe(91);
    expect(plan.buckets.every((b) => dayDiff(b.span.from, b.span.to) === 6)).toBe(true);
  });

  it('takes 12 whole months before this one, and compares only those a year of history covers', () => {
    const plan = planPeriod('12m', TODAY, FROM);
    expect(plan.grain).toBe('month');
    expect(plan.buckets.map((b) => b.key)).toEqual([
      '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01',
      '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
    ]);
    // History from February 2025: August 2024 to January 2025 have no record.
    expect(plan.buckets.filter((b) => b.compared).map((b) => b.key)).toEqual([
      '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
    ]);
    expect(plan.comparedCount).toBe(6);
  });
});

describe('salesOverTime', () => {
  it('adds money in paise, so ten paise and twenty make thirty', () => {
    const plan = planPeriod('30d', TODAY, FROM);
    const result = salesOverTime([line(TODAY, 1.1, '0.10'), line(TODAY, 2.2, '0.20')], plan);
    expect(result.total).toEqual({ units: 3.3, value: '0.30' });
  });

  it('puts each day in its bucket and its year-ago twin beside it', () => {
    const plan = planPeriod('30d', TODAY, FROM);
    const result = salesOverTime([line(TODAY, 10, '60000.00'), line('2025-08-09', 8, '40000.00'), line('2025-08-08', 99, '1.00')], plan);
    const last = result.points[29]!;
    expect(last.now).toEqual({ units: 10, value: '60000.00' });
    expect(last.lastYear).toEqual({ units: 8, value: '40000.00' });
    // 365 days back is the twin of the day before, not of today.
    expect(result.points[28]!.lastYear).toEqual({ units: 99, value: '1.00' });
    expect(result.compared?.valuePct).toBeCloseTo(((60000 - 40001) / 40001) * 100, 6);
    expect(result.compared?.unitsPct).toBeCloseTo(((10 - 107) / 107) * 100, 6);
  });

  it('compares only the months last year covers — never a year against half a year', () => {
    const plan = planPeriod('12m', TODAY, FROM);
    // The same 100 units every day for the whole history: no change at all.
    const lines = everyDay(FROM, '2026-07-31', 100, '500000.00');
    const result = salesOverTime(lines, plan);
    expect(result.compared).toMatchObject({ buckets: 6, of: 12 });
    expect(result.compared?.valuePct).toBeCloseTo(0, 6);
    expect(result.points[0]!.lastYear).toBeNull();
    expect(result.points[11]!.lastYear?.units).toBe(3100);
  });

  it('says there is nothing to compare when the history is younger than a year', () => {
    const plan = planPeriod('30d', TODAY, '2026-01-01');
    expect(salesOverTime([line(TODAY, 1, '1.00')], plan).compared).toBeNull();
  });

  it('counts only the lines the filter lets through', () => {
    const plan = planPeriod('30d', TODAY, FROM);
    const lines = [line(TODAY, 1, '1.00'), line(TODAY, 2, '2.00', { productCode: 'AGG20' }), line(TODAY, 4, '4.00', { siteId: 'tvl' })];
    expect(salesOverTime(lines, plan, { productCode: 'MSAND' }).total.units).toBe(5);
    expect(salesOverTime(lines, plan, { productCode: 'MSAND', siteId: 'krp' }).total.units).toBe(1);
    expect(salesOverTime(lines, plan, { customerId: null }).total.units).toBe(7);
  });
});

describe('customerStandings', () => {
  it('calls a daily buyer stopped after three quiet weeks, not after two', () => {
    const daily = everyDay('2026-04-01', '2026-07-18', 5, '30000.00');
    expect(customerStandings(daily, TODAY).get('c1')).toMatchObject({ usualGapDays: 1, daysSince: 21, stopped: true });
    expect(customerStandings(daily, '2026-08-01').get('c1')).toMatchObject({ daysSince: 14, stopped: false });
  });

  it('measures quiet against the customer\'s own rhythm', () => {
    // Every 30 days: forty days without an order is not a stop yet.
    const monthly = [0, 30, 60, 90, 120].map((d) => line(addDays('2026-02-20', d), 20, '100000.00'));
    const standing = customerStandings(monthly, addDays('2026-06-20', 40)).get('c1')!;
    expect(standing.usualGapDays).toBe(30);
    expect(standing.stopped).toBe(false);
    expect(customerStandings(monthly, addDays('2026-06-20', 90)).get('c1')!.stopped).toBe(true);
  });

  it('does not guess with too few orders to know their rhythm', () => {
    const twice = [line('2026-01-05', 5, '1.00'), line('2026-01-07', 5, '1.00')];
    expect(customerStandings(twice, TODAY).get('c1')).toMatchObject({ usualGapDays: null, stopped: false });
  });

  it('ignores lines after today and lines with no units', () => {
    const lines = [...everyDay('2026-06-01', '2026-06-30', 5, '1.00'), line('2026-08-20', 5, '1.00'), line('2026-08-01', 0, '0.00')];
    expect(customerStandings(lines, TODAY).get('c1')?.lastBoughtOn).toBe('2026-06-30');
  });
});

describe('salesByCustomer', () => {
  const plan = planPeriod('30d', TODAY, FROM);
  const lastYear = (date: string) => addDays(date, -YEAR_AGO_DAYS);

  it('lists the biggest first, with share, change and the customer\'s flag', () => {
    const lines = [
      // Grows: 60 now against 40.
      ...everyDay('2026-07-10', TODAY, 6, '6000.00', { customerId: 'grows' }),
      ...everyDay(lastYear('2026-07-10'), lastYear(TODAY), 4, '4000.00', { customerId: 'grows' }),
      // Falls by half.
      ...everyDay('2026-07-10', TODAY, 2, '2000.00', { customerId: 'falls' }),
      ...everyDay(lastYear('2026-07-10'), lastYear(TODAY), 4, '4000.00', { customerId: 'falls' }),
      // New this year.
      ...everyDay('2026-07-10', TODAY, 2, '2000.00', { customerId: 'new' }),
      // Bought every day until five weeks ago, and last year too.
      ...everyDay('2026-03-01', '2026-07-04', 3, '3000.00', { customerId: 'gone' }),
      ...everyDay(lastYear('2026-07-10'), lastYear(TODAY), 3, '3000.00', { customerId: 'gone' }),
    ];
    const rows = salesByCustomer(lines, plan, TODAY);
    expect(rows.map((r) => r.customerId)).toEqual(['grows', 'falls', 'new', 'gone']);

    const [grows, falls, isNew, gone] = rows as [typeof rows[0], typeof rows[0], typeof rows[0], typeof rows[0]];
    expect(grows.valuePct).toBeCloseTo(50, 6);
    expect(grows.sharePct).toBeCloseTo(60, 6);
    expect(grows.flag).toBeNull();
    expect(falls.valuePct).toBeCloseTo(-50, 6);
    expect(falls.flag).toBe('fell');
    expect(isNew).toMatchObject({ isNew: true, valuePct: null, flag: null });
    // Stopped outranks the fall it also shows.
    expect(gone.now.value).toBe('0.00');
    expect(gone.valuePct).toBeCloseTo(-100, 6);
    expect(gone.flag).toBe('stopped');
    expect(gone.standing).toMatchObject({ lastBoughtOn: '2026-07-04', daysSince: 35 });
  });

  it('draws 30 days as four weekly steps', () => {
    const lines = everyDay('2026-07-10', TODAY, 1, '100.00');
    expect(salesByCustomer(lines, plan, TODAY)[0]!.spark).toEqual([700, 700, 700, 700]);
  });

  it('reads stopped across every material, even when one material is on screen', () => {
    const lines = [
      ...everyDay('2026-04-01', TODAY, 3, '3000.00', { productCode: 'AGG20' }),
      ...everyDay('2026-04-01', '2026-06-30', 3, '3000.00'),
      ...everyDay(lastYear('2026-07-10'), lastYear(TODAY), 3, '3000.00'),
    ];
    const msand = salesByCustomer(lines, plan, TODAY, { productCode: 'MSAND' })[0]!;
    expect(msand.flag).toBe('fell');
    expect(msand.standing?.stopped).toBe(false);
  });
});

describe('salesByMaterial', () => {
  it('shares and compares by units, the most first', () => {
    const plan = planPeriod('30d', TODAY, FROM);
    const lines = [
      line(TODAY, 30, '180000.00'),
      line(TODAY, 10, '50000.00', { productCode: 'AGG40' }),
      line(addDays(TODAY, -YEAR_AGO_DAYS), 20, '110000.00'),
      line(addDays(TODAY, -YEAR_AGO_DAYS), 10, '50000.00', { productCode: 'AGG40' }),
    ];
    const rows = salesByMaterial(lines, plan);
    expect(rows.map((r) => [r.productCode, r.unitsSharePct, r.unitsPct])).toEqual([
      ['MSAND', 75, 50],
      ['AGG40', 25, 0],
    ]);
    expect(rows[0]!.valuePct).toBeCloseTo(63.64, 2);
  });
});

describe('numbers', () => {
  it('writes paise as rupees, negative too', () => {
    expect(paiseToRupees(1234567)).toBe('12345.67');
    expect(paiseToRupees(-5)).toBe('-0.05');
    expect(paiseToRupees(0)).toBe('0.00');
  });

  it('gives the rate per unit to the paisa, and none for nothing sold', () => {
    expect(ratePerUnit({ units: 3, value: '18000.00' })).toBe('6000.00');
    expect(ratePerUnit({ units: 3, value: '100.00' })).toBe('33.33');
    expect(ratePerUnit({ units: 0, value: '0.00' })).toBeNull();
  });

  it('has no change against nothing', () => {
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(15, 10)).toBe(50);
  });
});
