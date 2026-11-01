import { describe, expect, it } from 'vitest';
import { allocate, dec, divTo, parseDec, percentOf, roundTo, sub, toFixed } from './decimal.js';
import fixtures from './vehicle-pl.fixtures.json';
import {
  billKey,
  calculateSheet,
  calculateSheets,
  distance,
  findDoubleCounts,
  outstanding,
  plByMonth,
  plByVehicle,
  plUnits,
  settleSheetPayments,
  spreadSheetCosts,
  totalPl,
  type DieselProblem,
  type KnownDieselBill,
  type OtherSheetDiesel,
  type PlSheet,
  type SheetCalc,
  type Spread,
} from './vehicle-pl.js';

/*
 * The golden figures live in vehicle-pl.fixtures.json, worked by hand from the
 * owner's workbook, and apps/api/tests/test_vehicle_pl_domain.py runs the
 * Python rules over the same file. A rule changed on one side only fails one
 * of the two suites.
 */

const SHEETS = fixtures.sheets as unknown as PlSheet[];
const sheetById = (id: string) => SHEETS.find((s) => s.id === id)!;
const money = (s: string) => toFixed(dec(s), 2);

describe('vehicle P&L golden fixtures', () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      expect(calculateSheet(sheetById(c.sheet))).toEqual(c.expect as unknown as SheetCalc);
    });
  }

  for (const c of fixtures.spread) {
    it(`shares a sheet's own costs ${c.name}`, () => {
      expect(spreadSheetCosts(sheetById(c.sheet))).toEqual(c.expect as unknown as Spread | null);
    });
  }

  it('adds trips up into the trip-wise total, vehicle-wise, monthly and outstanding reports', () => {
    const sheets = fixtures.reports.sheets.map(sheetById);
    const units = plUnits(sheets, calculateSheets(sheets));
    const expected = fixtures.reports.expect;
    expect(totalPl(units)).toEqual(expected.total);
    expect(plByVehicle(units)).toEqual(expected.byVehicle);
    expect(plByMonth(units)).toEqual(expected.byMonth);
    expect(outstanding(units, 'customer')).toEqual(expected.customers);
    expect(outstanding(units, 'vendor')).toEqual(expected.vendors);
  });

  for (const c of fixtures.doubleCounts) {
    it(`double counting: ${c.name}`, () => {
      const context = c.context as unknown as { bills: KnownDieselBill[]; otherSheets: OtherSheetDiesel[] };
      expect(findDoubleCounts(c.sheet as unknown as PlSheet, context)).toEqual(c.expect as unknown as DieselProblem[]);
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
  const s1 = sheetById('s1');
  const t1 = s1.trips[0]!;

  it('takes profit as AV − AB − BH, not the workbook\'s "Total Selling Price − Total Purchase cost − Total Enroute Expenses"', () => {
    // The workbook's Total Selling Price is AX, which includes GST. GST is
    // never profit (LIN-22), so the rule uses AV. If the owner overrules
    // this, `profit` in vehicle-pl.ts is the one line to change, and this
    // test the one to turn round.
    const calc = calculateSheet(s1).trips.t1!;
    const sale = calc.sales['t1-s1']!;
    const purchase = calc.purchases['t1-p1']!;
    expect(sale.taxable).toBe('18600.00'); // AV
    expect(sale.total).toBe('19530.00'); // AX
    expect(purchase.amount).toBe('10800.00'); // AB
    expect(calc.pl.totalEnRoute).toBe('3800.00'); // BH
    expect(calc.pl.net).toBe('4000.00'); // AV − AB − BH
    const literal = toFixed(sub(sub(dec(sale.total), dec(purchase.amount)), dec(calc.pl.totalEnRoute)), 2);
    expect(literal).toBe('4930.00'); // AX − AB − BH: the GST, ₹930, would be counted as profit
    expect(calc.pl.gstToPay).toBe('390.00'); // AW − AF, on its own line
  });

  it('never counts GST as profit: any GST rate leaves the profit where it was', () => {
    const base = calculateSheet(s1).pl;
    const taxedHigher = calculateSheet({
      ...s1,
      trips: [
        {
          ...t1,
          sales: t1.sales.map((s) => ({ ...s, gstRatePct: 28 })),
          purchases: t1.purchases.map((p) => ({ ...p, gstRatePct: 28 })),
        },
      ],
    }).pl;
    expect(taxedHigher.net).toBe(base.net);
    expect(taxedHigher.sales).toBe(base.sales);
    expect(taxedHigher.materialCost).toBe(base.materialCost);
    expect(taxedHigher.outputGst).not.toBe(base.outputGst);
  });

  it('a non-GST bill carries no GST, whatever rate was picked', () => {
    const calc = calculateSheet(sheetById('s2')).trips.t2b!;
    expect(calc.purchases['t2b-p1']).toEqual({ amount: '9000.00', gstAmount: '0.00', total: '9000.00' });
  });

  it('puts transport inside the taxable selling price, taxed at the sale\'s own rate (AV = AO × AQ + AR)', () => {
    const sale = calculateSheet(s1).trips.t1!.sales['t1-s1']!;
    expect(sale).toEqual({ amount: '17100.00', transport: '1500.00', taxable: '18600.00', gstAmount: '930.00', total: '19530.00' });
  });

  it('counts a payment as money moved, not profit', () => {
    const unpaid = calculateSheet({ ...s1, trips: [{ ...t1, payments: [] }] });
    expect(unpaid.pl.net).toBe(calculateSheet(s1).pl.net);
    expect(unpaid.pl.customerDue).toBe('19530.00');
    expect(unpaid.trips.t1!.dues.map((d) => d.status)).toEqual(['pending', 'pending']);
  });

  it('works the figures again when an input changes', () => {
    const cheaper = calculateSheet({ ...s1, diesel: [{ ...s1.diesel![0]!, rate: '90.00' }] });
    expect(cheaper.diesel['s1-d1']!.amount).toBe('2700.00');
    expect(cheaper.pl.net).toBe('4165.00');
  });

  it('shares a sheet\'s costs so its trips add up to it exactly', () => {
    for (const id of ['s2', 's3', 's6']) {
      const sheet = sheetById(id);
      const calc = calculateSheet(sheet);
      const trips = Object.values(calc.trips);
      for (const key of ['diesel', 'batta', 'enRoute', 'net', 'sales'] as const) {
        const total = trips.reduce((s, t) => s + dec(t.pl[key]).units * 10n ** BigInt(2 - dec(t.pl[key]).scale), 0n);
        expect(total, `${id} ${key}`).toBe(dec(calc.pl[key]).units);
      }
    }
  });

  it('settles a sheet payment oldest trip first, never more than is due, and keeps what is left on the sheet', () => {
    const settled = settleSheetPayments(
      [{ id: 'm', direction: 'in', partyId: 'c', amount: '1000' }],
      [
        { tripId: 'a', dues: [{ partyId: 'c', role: 'customer', billed: '600', settled: '100' }] },
        { tripId: 'b', dues: [{ partyId: 'c', role: 'customer', billed: '300', settled: '0' }] },
        { tripId: 'c', dues: [{ partyId: 'c', role: 'vendor', billed: '300', settled: '0' }] },
      ],
    );
    expect(settled).toEqual({ taken: { a: { 'customer:c': '500.00' }, b: { 'customer:c': '300.00' }, c: {} }, left: { 'customer:c': '200.00' } });
  });

  it('keeps a trip closed only while it is paid in full as it was billed when accounts closed it', () => {
    const s2 = sheetById('s2');
    expect(calculateSheet(s2).trips.t2a!.dues[0]!.status).toBe('closed');
    const rebilled = calculateSheet({
      ...s2,
      trips: s2.trips.map((t) => (t.id === 't2a' ? { ...t, sales: t.sales.map((s) => ({ ...s, quantity: '4.9' })) } : t)),
    });
    expect(rebilled.trips.t2a!.dues[0]).toMatchObject({ billed: '15435.00', status: 'paid' });
  });

  it('a line not filled in yet counts nothing, so the box follows the form as it is typed', () => {
    const draft = calculateSheet({
      ...s1,
      trips: [
        {
          ...t1,
          sales: [{ id: 's', customerId: null, quantity: null, rate: '', gstBilled: true, gstRatePct: null }],
          purchases: [{ id: 'p', vendorId: null, quantity: '7', rate: 'abc', gstBilled: true, gstRatePct: 5 }],
        },
      ],
    });
    expect(draft.pl.sales).toBe('0.00');
    expect(draft.pl.materialCost).toBe('0.00');
    expect(draft.pl.profitPct).toBeNull();
    expect(draft.trips.t1!.dues).toEqual([
      { partyId: 'cus-01', role: 'customer', billed: '0.00', settled: '15000.00', due: '-15000.00', status: 'paid' },
      { partyId: 'ven-qry', role: 'vendor', billed: '0.00', settled: '11340.00', due: '-11340.00', status: 'completed' },
    ]);
  });

  it('has no distance until both readings are in, and none when the end is below the start', () => {
    expect(distance(100, null)).toBeNull();
    expect(distance('218486', '218400')).toBeNull();
    expect(toFixed(distance('100.5', 200)!, 1)).toBe('99.5');
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
    expect(money('7')).toBe('7.00');
  });
});
