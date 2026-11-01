import { describe, expect, it } from 'vitest';
import { allocate, dec, divTo, parseDec, percentOf, roundTo, toFixed } from './decimal.js';
import fixtures from './vehicle-pl.fixtures.json';
import {
  billKey,
  calculateTrip,
  calculateTrips,
  findDoubleCounts,
  outstanding,
  plByMonth,
  plByVehicle,
  sumPl,
  tripDistance,
  type DieselProblem,
  type KnownDieselBill,
  type OtherTripDiesel,
  type PlTrip,
  type TripCalc,
} from './vehicle-pl.js';

/*
 * The golden figures live in vehicle-pl.fixtures.json, worked by hand, and
 * apps/api/tests/test_vehicle_pl_domain.py runs the Python rules over the same
 * file. A rule changed on one side only fails one of the two suites.
 */

const TRIPS = fixtures.trips as unknown as PlTrip[];
const tripById = (id: string) => TRIPS.find((t) => t.id === id)!;

interface CaseExpect {
  purchases: TripCalc['purchases'];
  sales: TripCalc['sales'];
  diesel: TripCalc['diesel'];
  pl: TripCalc['pl'];
  dues: TripCalc['dues'];
}

describe('vehicle P&L golden fixtures', () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const calcs = calculateTrips(c.trips.map(tripById));
      for (const [tripId, expected] of Object.entries(c.expect as unknown as Record<string, CaseExpect>)) {
        const calc = calcs.get(tripId)!;
        expect(calc.purchases).toEqual(expected.purchases);
        expect(calc.sales).toEqual(expected.sales);
        expect(calc.diesel).toEqual(expected.diesel);
        expect(calc.pl).toEqual(expected.pl);
        expect(calc.dues).toEqual(expected.dues);
      }
    });
  }

  it('adds trips up into the trip-wise total, vehicle-wise, monthly and outstanding reports', () => {
    const trips = fixtures.reports.trips.map(tripById);
    const calcs = calculateTrips(trips);
    const expected = fixtures.reports.expect;
    expect(sumPl([...calcs.values()].map((c) => c.pl))).toEqual(expected.total);
    expect(plByVehicle(trips, calcs)).toEqual(expected.byVehicle);
    expect(plByMonth(trips, calcs)).toEqual(expected.byMonth);
    expect(outstanding(trips, calcs, 'customer')).toEqual(expected.customers);
    expect(outstanding(trips, calcs, 'vendor')).toEqual(expected.vendors);
  });

  for (const c of fixtures.doubleCounts) {
    it(`double counting: ${c.name}`, () => {
      const context = c.context as unknown as { bills: KnownDieselBill[]; otherTrips: OtherTripDiesel[] };
      expect(findDoubleCounts(c.trip as unknown as PlTrip, context)).toEqual(c.expect as unknown as DieselProblem[]);
    });
  }

  it('splits a total so the parts add up exactly', () => {
    for (const c of fixtures.allocate) {
      const parts = allocate(dec(c.total), c.weights.map((w) => dec(w)), c.places);
      expect(parts.map((p) => toFixed(p, c.places))).toEqual(c.expect);
    }
  });

  it('rounds and divides half away from zero, as Python ROUND_HALF_UP does', () => {
    for (const c of fixtures.decimal.roundTo) expect(toFixed(roundTo(dec(c.value), c.places), c.places)).toBe(c.expect);
    for (const c of fixtures.decimal.divTo) expect(toFixed(divTo(dec(c.a), dec(c.b), c.places), c.places)).toBe(c.expect);
    for (const c of fixtures.decimal.percentOf) expect(toFixed(percentOf(dec(c.value), dec(c.pct)), 2)).toBe(c.expect);
  });
});

describe('vehicle P&L rules', () => {
  const t1 = tripById('t1');

  it('never counts GST as profit: any GST rate leaves the profit where it was', () => {
    const base = calculateTrip(t1).pl;
    const taxedHigher = calculateTrip({
      ...t1,
      sales: t1.sales.map((s) => ({ ...s, gstRatePct: 28, transportGstRatePct: 28 })),
      purchases: t1.purchases.map((p) => ({ ...p, gstRatePct: 28 })),
    }).pl;
    expect(taxedHigher.net).toBe(base.net);
    expect(taxedHigher.sales).toBe(base.sales);
    expect(taxedHigher.materialCost).toBe(base.materialCost);
    expect(taxedHigher.outputGst).not.toBe(base.outputGst);
  });

  it('counts transport once, as income, and a payment as money moved, not profit', () => {
    const noTransport = calculateTrip({ ...t1, sales: t1.sales.map((s) => ({ ...s, transport: null })) }).pl;
    expect(dec(calculateTrip(t1).pl.sales).units - dec(noTransport.sales).units).toBe(150000n);
    const unpaid = calculateTrip({ ...t1, payments: [] }).pl;
    expect(unpaid.net).toBe(calculateTrip(t1).pl.net);
    expect(unpaid.customerDue).toBe('32640.00');
  });

  it('works the figures again when an input changes', () => {
    const cheaper = calculateTrip({ ...t1, diesel: [{ ...t1.diesel[0]!, rate: '90.00' }] });
    expect(cheaper.diesel['t1-d1']!.amount).toBe('2565.00');
    expect(cheaper.pl.net).toBe('7285.00');
    expect(cheaper.pl.mileageKmpl).toBe(3.02);
  });

  it('a trip taken alone counts a linked fill in full; taken with its day, only its part', () => {
    const alone = calculateTrip(tripById('t3b'));
    expect(alone.pl.diesel).toBe('3833.20');
    const withItsDay = calculateTrips(['t3a', 't3b', 't3c'].map(tripById)).get('t3b')!;
    expect(withItsDay.pl.diesel).toBe('1574.95');
  });

  it('the parts of a shared fill add up to the bill, never more', () => {
    const calcs = calculateTrips(['t3a', 't3b', 't3c'].map(tripById));
    const total = [...calcs.values()].reduce((s, c) => s + dec(c.pl.diesel).units, 0n);
    expect(total).toBe(dec('2833.21').units + dec('999.99').units);
  });

  it('a line not filled in yet counts nothing, so the box follows the form as it is typed', () => {
    const draft = calculateTrip({
      ...t1,
      sales: [{ id: 's', customerId: null, quantity: null, rate: '', gstBilled: true, gstRatePct: null }],
      purchases: [{ id: 'p', vendorId: null, quantity: '7', rate: 'abc', gstBilled: true, gstRatePct: 5 }],
    });
    expect(draft.pl.sales).toBe('0.00');
    expect(draft.pl.materialCost).toBe('0.00');
    expect(draft.pl.profitPct).toBeNull();
    expect(draft.dues).toEqual([
      { partyId: 'cus-01', role: 'customer', billed: '0.00', settled: '20000.00', due: '-20000.00' },
      { partyId: 'ven-qry', role: 'vendor', billed: '0.00', settled: '10000.00', due: '-10000.00' },
    ]);
  });

  it('has no distance until both readings are in, and none when the end is below the start', () => {
    expect(tripDistance(100, null)).toBeNull();
    expect(tripDistance('218486', '218400')).toBeNull();
    expect(toFixed(tripDistance('100.5', 200)!, 1)).toBe('99.5');
  });

  it('reads a bill number the way people write it', () => {
    expect(billKey(' bk/4471 ')).toBe('BK4471');
    expect(billKey('HP-1102')).toBe(billKey('hp 1102'));
    expect(billKey(null)).toBe('');
  });

  it('reads only what is a number', () => {
    expect(parseDec('12,500')).toBeNull();
    expect(parseDec('1e5')).toBeNull();
    expect(parseDec(Number.NaN)).toBeNull();
    expect(toFixed(parseDec(120.455)!, 3)).toBe('120.455');
    expect(toFixed(parseDec('.5')!, 2)).toBe('0.50');
    expect(toFixed(parseDec(1e-7)!, 7)).toBe('0.0000001');
  });
});
