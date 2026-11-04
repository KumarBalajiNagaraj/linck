import { describe, expect, it } from 'vitest';
import { sumPl, totalPl } from '@linck/domain';
import { attention, change, costShares, customerReport, lossTrips, monthsBack, perUnit, previousRange } from './insights.js';
import { buildBook, READ_KEYS, reportUnits, tripReport, usePl, vehicleReport } from './plStore.js';
import { useExpenses } from '../expenses/expenseStore.js';
import { personaByKey } from '../../auth/personas.js';


describe('monthsBack', () => {
  it('keeps a month end a month end', () => {
    expect(monthsBack('2026-07-31', 1)).toBe('2026-06-30');
    expect(monthsBack('2026-06-30', 1)).toBe('2026-05-31');
    expect(monthsBack('2026-03-31', 1)).toBe('2026-02-28');
  });
  it('clamps a day the shorter month lacks', () => {
    expect(monthsBack('2026-03-30', 1)).toBe('2026-02-28');
  });
  it('crosses the year', () => {
    expect(monthsBack('2026-01-15', 1)).toBe('2025-12-15');
    expect(monthsBack('2026-08-08', 12)).toBe('2025-08-08');
  });
});

describe('previousRange', () => {
  it('has nothing to compare all dates with', () => {
    expect(previousRange('all', '', '')).toBeNull();
  });
  it('sets this month so far against the same days last month', () => {
    expect(previousRange('thisMonth', '2026-08-01', '2026-08-08')).toMatchObject({ from: '2026-07-01', to: '2026-07-08', key: 'lastMonth' });
  });
  it('sets a whole month against the whole month before', () => {
    expect(previousRange('lastMonth', '2026-07-01', '2026-07-31')).toMatchObject({ from: '2026-06-01', to: '2026-06-30', key: 'monthBefore' });
  });
  it('sets the financial year so far against the same days a year back', () => {
    expect(previousRange('fy', '2026-04-01', '2026-08-08')).toMatchObject({ from: '2025-04-01', to: '2025-08-08', key: 'lastYear' });
  });
  it('sets typed dates against as many days just before', () => {
    expect(previousRange('custom', '2026-08-01', '2026-08-10')).toEqual({ from: '2026-07-22', to: '2026-07-31', key: 'daysBefore', days: 10 });
  });
});

describe('change', () => {
  it('says how much and which way', () => {
    expect(change('110.00', '100.00')).toEqual({ delta: '10.00', pct: 10, direction: 'up' });
    expect(change('-50.00', '100.00')).toEqual({ delta: '-150.00', pct: -150, direction: 'down' });
    expect(change('5.00', '0.00')).toMatchObject({ pct: null, direction: 'up' });
  });
});

describe('the summary on the demo book', () => {
  const s = usePl.getState();
  const book = buildBook(s.sheets, s.parties, s.materials, useExpenses.getState().bills);
  const grants = personaByKey('executive').grants;
  const units = reportUnits(book, grants, READ_KEYS, {});
  const trips = tripReport(book, units);

  it('splits each ₹100 of sales so the five lines come to 100', () => {
    const shares = costShares(trips.total);
    const sum = shares.reduce((n, x) => n + (x.per100 ?? 0), 0);
    expect(Math.abs(sum - 100)).toBeLessThan(0.3);
    expect(shares.map((x) => x.key)).toEqual(['purchase', 'diesel', 'batta', 'road', 'profit']);
  });

  it('gives profit per trip and km', () => {
    const u = perUnit(trips.total);
    expect(u.profitPerTrip).not.toBeNull();
    expect(Number(u.profitPerTrip)).toBeCloseTo(Number(trips.total.net) / trips.total.trips, 1);
  });

  it('shares every sold trip among its customers to the paisa', () => {
    const rows = customerReport(book, units);
    const sold = units.filter((u) => u.trip && u.trip.sales.some((x) => x.customerId));
    const expected = totalPl(sold.map((u) => u.unit));
    const got = sumPl(rows);
    expect(got.net).toBe(expected.net);
    expect(got.sales).toBe(expected.sales);
    // Best first.
    expect(rows.map((r) => Number(r.net))).toEqual([...rows.map((r) => Number(r.net))].sort((a, b) => b - a));
  });

  it('narrows to one customer', () => {
    const first = customerReport(book, units)[0]!;
    expect(customerReport(book, units, first.partyId).map((r) => r.partyId)).toEqual([first.partyId]);
  });

  it('counts the trips that lost money', () => {
    const lost = lossTrips(trips.rows);
    expect(lost.count).toBe(trips.rows.filter((r) => r.kind === 'trip' && r.pl.net.startsWith('-')).length);
    if (lost.count) expect(lost.amount.startsWith('-')).toBe(true);
  });

  it('lists at most six things worth a look, losses first', () => {
    const items = attention({
      total: trips.total,
      previous: { ...trips.total, profitPct: (trips.total.profitPct ?? 0) + 5 },
      lossTrips: { count: 3, amount: '-900.00' },
      vehicles: vehicleReport(units).rows,
      customers: customerReport(book, units),
      dues: [],
    });
    expect(items.length).toBeLessThanOrEqual(6);
    expect(items[0]).toEqual({ kind: 'lossTrips', count: 3, amount: '-900.00' });
    expect(items.some((i) => i.kind === 'marginDown')).toBe(true);
  });
});
