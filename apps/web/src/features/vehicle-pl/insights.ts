import { decimal, saleFigures, sumPl, type Dec, type PlTotals, type TripPl } from '@linck/domain';
import type { PlOutstandingRow, PlVehicleRow } from '@linck/mock';
import type { PlBook, ReportUnit } from './plStore.js';

/**
 * What the P&L summary reads off the reports (LIN-22 follow-up): the period
 * before this one to compare with, profit per customer, where each ₹100 of
 * sales went, and the few things worth a look. Pure, so it is tested without
 * a screen; codes with values, so the screen words them in either language.
 */

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** A date moved back by whole months; a month's last day stays the last day, and the 31st of a short month is its end. */
export function monthsBack(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const end = lastDay(ty, tm);
  const wasEnd = d === lastDay(y, m - 1);
  return iso(ty, tm, wasEnd ? end : Math.min(d, end));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export type CompareKey = 'lastMonth' | 'monthBefore' | 'threeBefore' | 'lastYear' | 'daysBefore';

export interface PreviousRange {
  from: string;
  to: string;
  /** Which words name it: "vs last month", "vs same days last year". */
  key: CompareKey;
  days: number;
}

/**
 * The period to set this one against, like for like: this month so far
 * against the same days of last month, a whole month against the month
 * before, the financial year so far against the same days a year back, and a
 * typed range against as many days just before it. All dates: nothing.
 */
export function previousRange(period: string, from: string, to: string): PreviousRange | null {
  if (!from || !to || from > to) return null;
  const days = daysBetween(from, to) + 1;
  const months = (n: number, key: CompareKey): PreviousRange => ({
    from: monthsBack(from, n),
    to: monthsBack(to, n),
    key,
    days,
  });
  if (period === 'thisMonth') return months(1, 'lastMonth');
  if (period === 'lastMonth') return months(1, 'monthBefore');
  if (period === 'last3') return months(3, 'threeBefore');
  if (period === 'fy') return months(12, 'lastYear');
  return {
    from: addDays(from, -days),
    to: addDays(from, -1),
    key: 'daysBefore',
    days,
  };
}

export interface Change {
  /** Signed rupees, as decimal strings, for the money; signed points for a percentage. */
  delta: string;
  /** Percent change of the figure, when the base is not zero. */
  pct: number | null;
  direction: 'up' | 'down' | 'same';
}

export function change(now: string, before: string): Change {
  const d = decimal.sub(decimal.dec(now), decimal.dec(before));
  const base = decimal.toNumber(decimal.dec(before));
  const delta = decimal.toFixed(d, 2);
  const n = decimal.toNumber(d);
  return {
    delta,
    pct: base === 0 ? null : Math.round((n / Math.abs(base)) * 1000) / 10,
    direction: n > 0 ? 'up' : n < 0 ? 'down' : 'same',
  };
}

export interface CostShare {
  key: 'purchase' | 'diesel' | 'batta' | 'road' | 'profit';
  amount: string;
  /** Rupees out of each ₹100 of sales, to one place. */
  per100: number | null;
}

/** Each ₹100 of sales, without GST: what the material cost, the diesel, the batta, the road, and what was left. */
export function costShares(t: PlTotals): CostShare[] {
  const sales = decimal.toNumber(decimal.dec(t.sales));
  const per100 = (amount: string) => (sales === 0 ? null : Math.round((decimal.toNumber(decimal.dec(amount)) / sales) * 1000) / 10);
  const rows: [CostShare['key'], string][] = [
    ['purchase', t.materialCost],
    ['diesel', t.diesel],
    ['batta', t.batta],
    ['road', t.enRoute],
    ['profit', t.net],
  ];
  return rows.map(([key, amount]) => ({ key, amount, per100: per100(amount) }));
}

export interface PerUnit {
  profitPerTrip: string | null;
  profitPerKm: string | null;
  salesPerKm: string | null;
  dieselPerKm: string | null;
}

export function perUnit(t: PlTotals): PerUnit {
  const per = (amount: string, n: number) => (n > 0 ? decimal.toFixed(decimal.divTo(decimal.dec(amount), decimal.dec(n), 2), 2) : null);
  return {
    profitPerTrip: per(t.net, t.trips),
    profitPerKm: per(t.net, t.distanceKm),
    salesPerKm: per(t.sales, t.distanceKm),
    dieselPerKm: per(t.diesel, t.distanceKm),
  };
}

export interface CustomerPlRow extends PlTotals {
  partyId: string;
  name: string;
}

/**
 * Profit per customer. A trip sold to one customer is theirs whole; a trip
 * sold to two is split between them by what each was sold, to the paisa
 * (decimal.allocate), so the rows add up to the trip-wise total for every
 * trip that had a sale. Trips with no sale yet belong to no customer and are
 * left out, as is a sheet's unsettled payment.
 */
export function customerReport(book: PlBook, units: ReportUnit[], onlyCustomerId?: string | null): CustomerPlRow[] {
  const parts = new Map<string, { units: TripPl[]; trips: Set<string> }>();
  for (const { unit, trip } of units) {
    if (!trip) continue;
    const sales = book.domain.get(unit.sheetId)?.trips.find((t) => t.id === trip.id)?.sales ?? [];
    const byCustomer = new Map<string, Dec>();
    for (const s of sales) {
      if (!s.customerId) continue;
      byCustomer.set(s.customerId, decimal.add(byCustomer.get(s.customerId) ?? decimal.dec(0), decimal.dec(saleFigures(s).taxable)));
    }
    if (byCustomer.size === 0) continue;
    const ids = [...byCustomer.keys()];
    const weights = ids.map((id) => byCustomer.get(id)!);
    const even = weights.every((w) => decimal.isZero(w));
    const share = (amount: string) => decimal.allocate(decimal.dec(amount), even ? ids.map(() => decimal.dec(1)) : weights, 2);
    const keys = ['sales', 'materialCost', 'gross', 'diesel', 'batta', 'enRoute', 'totalEnRoute', 'net', 'outputGst', 'inputGst', 'gstToPay'] as const;
    const split = Object.fromEntries(keys.map((k) => [k, share(unit.pl[k])])) as Record<(typeof keys)[number], Dec[]>;
    ids.forEach((id, i) => {
      const row = parts.get(id) ?? { units: [], trips: new Set<string>() };
      const pick = (k: (typeof keys)[number]) => decimal.toFixed(split[k][i]!, 2);
      row.units.push({
        ...unit.pl,
        // Km and litres go with the whole trip: a split load still drove the whole road.
        sales: pick('sales'),
        materialCost: pick('materialCost'),
        gross: pick('gross'),
        diesel: pick('diesel'),
        batta: pick('batta'),
        enRoute: pick('enRoute'),
        totalEnRoute: pick('totalEnRoute'),
        net: pick('net'),
        outputGst: pick('outputGst'),
        inputGst: pick('inputGst'),
        gstToPay: pick('gstToPay'),
        // What is billed, received and due per customer is the dues report's work.
        customerBilled: '0.00',
        received: '0.00',
        customerDue: '0.00',
        vendorBilled: '0.00',
        paid: '0.00',
        vendorDue: '0.00',
        profitPct: null,
      });
      row.trips.add(trip.id);
      parts.set(id, row);
    });
  }
  return [...parts]
    .filter(([id]) => !onlyCustomerId || id === onlyCustomerId)
    .map(([partyId, r]) => ({
      partyId,
      name: book.parties.get(partyId)?.name ?? '',
      ...sumPl(r.units, r.trips.size),
    }))
    .sort((a, b) => decimal.cmp(decimal.dec(b.net), decimal.dec(a.net)) || a.name.localeCompare(b.name));
}

export type Attention =
  | { kind: 'lossTrips'; count: number; amount: string }
  | { kind: 'lossVehicle'; vehicleId: string; name: string; amount: string }
  | {
      kind: 'lowMileage';
      vehicleId: string;
      name: string;
      kmpl: number;
      fleetKmpl: number;
    }
  | { kind: 'lossCustomer'; partyId: string; name: string; amount: string }
  | {
      kind: 'thinCustomer';
      partyId: string;
      name: string;
      pct: number;
      fleetPct: number;
    }
  | {
      kind: 'bigDue';
      partyId: string;
      name: string;
      due: string;
      since: string;
    }
  | { kind: 'marginDown'; now: number; before: number };

const neg = (m: string) => decimal.isNegative(decimal.dec(m));

/**
 * The few lines worth a look, the costliest first: trips and vehicles that
 * lost money, a vehicle drinking diesel well below the fleet (a tenth under),
 * a customer the trips lose money on or earn half the usual margin from, the
 * biggest sum a customer still owes, and a margin that fell two points or
 * more since the last period. At most six, so it stays a glance.
 */
export function attention(input: {
  total: PlTotals;
  previous: PlTotals | null;
  lossTrips: { count: number; amount: string };
  vehicles: PlVehicleRow[];
  customers: CustomerPlRow[];
  dues: PlOutstandingRow[];
}): Attention[] {
  const out: Attention[] = [];
  const { total, previous, lossTrips, vehicles, customers, dues } = input;
  if (lossTrips.count > 0) out.push({ kind: 'lossTrips', ...lossTrips });
  if (previous && total.profitPct !== null && previous.profitPct !== null && previous.profitPct - total.profitPct >= 2) {
    out.push({
      kind: 'marginDown',
      now: total.profitPct,
      before: previous.profitPct,
    });
  }
  for (const v of vehicles
    .filter((v) => neg(v.net))
    .sort((a, b) => decimal.cmp(decimal.dec(a.net), decimal.dec(b.net)))
    .slice(0, 2)) {
    out.push({
      kind: 'lossVehicle',
      vehicleId: v.vehicleId,
      name: v.registrationNumber,
      amount: v.net,
    });
  }
  const fleetKmpl = total.mileageKmpl;
  if (fleetKmpl !== null && vehicles.length > 1) {
    const low = vehicles
      .filter((v) => v.mileageKmpl !== null && v.mileageKmpl < fleetKmpl * 0.9)
      .sort((a, b) => (a.mileageKmpl ?? 0) - (b.mileageKmpl ?? 0))
      .slice(0, 1);
    for (const v of low)
      out.push({
        kind: 'lowMileage',
        vehicleId: v.vehicleId,
        name: v.registrationNumber,
        kmpl: v.mileageKmpl!,
        fleetKmpl,
      });
  }
  for (const c of customers
    .filter((c) => neg(c.net))
    .slice(-2)
    .reverse()) {
    out.push({
      kind: 'lossCustomer',
      partyId: c.partyId,
      name: c.name,
      amount: c.net,
    });
  }
  const fleetPct = total.profitPct;
  if (fleetPct !== null && fleetPct > 0 && customers.length > 1) {
    const thin = customers
      .filter((c) => !neg(c.net) && c.profitPct !== null && c.profitPct < fleetPct / 2 && c.trips >= 2)
      .sort((a, b) => (a.profitPct ?? 0) - (b.profitPct ?? 0))
      .slice(0, 1);
    for (const c of thin)
      out.push({
        kind: 'thinCustomer',
        partyId: c.partyId,
        name: c.name,
        pct: c.profitPct!,
        fleetPct,
      });
  }
  const owing = dues.filter((d) => !neg(d.due) && !decimal.isZero(decimal.dec(d.due)))[0];
  if (owing)
    out.push({
      kind: 'bigDue',
      partyId: owing.partyId,
      name: owing.name,
      due: owing.due,
      since: owing.firstDate,
    });
  return out.slice(0, 6);
}

/** The trips that lost money, counted, and what they lost together (a negative sum). */
export function lossTrips(rows: { kind: string; pl: { net: string } }[]): {
  count: number;
  amount: string;
} {
  const lost = rows.filter((r) => r.kind === 'trip' && neg(r.pl.net));
  return {
    count: lost.length,
    amount: decimal.toFixed(decimal.sum(lost.map((r) => decimal.dec(r.pl.net))), 2),
  };
}
