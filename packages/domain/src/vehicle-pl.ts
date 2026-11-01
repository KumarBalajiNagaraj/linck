/**
 * VEHICLE P&L (LIN-22): what one trip of a tipper earned.
 *
 * A vehicle buys material from a vendor (a quarry or a crusher), delivers it
 * to a customer, and the trip's profit is what the customer pays for it minus
 * what the material, the diesel, the driver's batta and the costs on the road
 * cost. Every rule is here, once, as a pure function over decimal strings
 * (decimal.ts), so the trip page, the reports and the API agree to the paisa.
 * apps/api/app/domain/vehicle_pl.py is the same rules in Python, and both run
 * over vehicle-pl.fixtures.json, so neither side can drift alone.
 *
 * The formulas, as the owner approved them (the workbook attached to LIN-22
 * could not be read yet; each rule is one small function below, so when it
 * can, a differing rule is a one-function change and a fixture update):
 *
 *   distance        = end km − start km
 *   mileage         = distance ÷ the trip's diesel litres
 *   sales           = Σ (qty × selling rate) + transport charges, without GST
 *   material cost   = Σ purchase value without GST (GST bill: the tax is input credit)
 *                     + Σ full amount (non-GST bill: everything paid is cost)
 *   gross profit    = sales − material cost
 *   net profit      = gross − diesel − batta − en-route − other costs
 *   profit %        = net ÷ sales × 100, none when there are no sales
 *   GST to pay      = GST collected on sales − GST credit on purchases (its own line; never profit)
 *   money due       = bills with GST − payments, per customer and per vendor
 *
 * No double counting: GST is outside sales and outside cost; transport is
 * income once; a payment moves money, not profit; and a diesel fill linked to
 * several trips of one vehicle and day is split among them by km, so the parts
 * add up to the bill exactly. `findDoubleCounts` refuses the same fill twice.
 *
 * Every figure is rounded to the paisa (litres to the millilitre) once, half
 * away from zero. A line not yet filled in counts as zero, so the trip page's
 * P&L box can follow the form as it is typed.
 */
import {
  add,
  allocate,
  cmp,
  dec,
  divTo,
  isZero,
  mul,
  parseDec,
  percentOf,
  roundTo,
  sub,
  sum,
  toFixed,
  toNumber,
  type Dec,
  type Decimalish,
} from './decimal.js';

/** The rules' version, kept on each vehicle day the API writes, like the design's allocation_rule_version. */
export const PL_RULES_VERSION = 'km-v1';

export type DieselSource = 'typed' | 'expense_bill' | 'fuel_entry';
export type CostKind = 'batta' | 'en_route' | 'other';
export type PartyRole = 'customer' | 'vendor';
export type MoneyDirection = 'in' | 'out';

export const COST_KINDS: readonly CostKind[] = ['batta', 'en_route', 'other'];

/* --------------------------------------------------------------- inputs */

/**
 * One diesel line of a trip. Typed: litres and rate as on the bunk's bill,
 * for this trip alone. Linked: an expense bill or a fuel entry already in
 * Linck — `litres` and `amount` are the WHOLE fill, read from it, never typed
 * again, and the trip's part is worked out here.
 */
export interface PlDieselLine {
  id: string;
  source: DieselSource;
  litres: Decimalish | null;
  rate?: Decimalish | null;
  amount?: Decimalish | null;
  expenseBillId?: string | null;
  fuelEntryId?: string | null;
  billNumber?: string | null;
  /** A linked bill that was rejected or deleted: it counts nothing. */
  void?: boolean;
}

export interface PlPurchase {
  id: string;
  vendorId: string | null;
  quantity: Decimalish | null;
  rate: Decimalish | null;
  /** A GST bill: its tax is input credit. A non-GST bill: what was paid is all cost. */
  gstBilled: boolean;
  gstRatePct: Decimalish | null;
}

export interface PlSale {
  id: string;
  customerId: string | null;
  quantity: Decimalish | null;
  rate: Decimalish | null;
  gstBilled: boolean;
  gstRatePct: Decimalish | null;
  /** Transport charged on the bill, a line of its own: sales income, with its own GST rate. */
  transport?: Decimalish | null;
  transportGstRatePct?: Decimalish | null;
}

export interface PlCost {
  id: string;
  kind: CostKind;
  amount: Decimalish | null;
}

export interface PlPayment {
  id: string;
  /** In: money received from a customer. Out: money paid to a vendor. */
  direction: MoneyDirection;
  partyId: string | null;
  amount: Decimalish | null;
}

export interface PlTrip {
  id: string;
  /** Orders the trips that share a fill: the earlier trip takes a leftover paisa. */
  tripNumber?: string | null;
  vehicleId: string;
  /** The trip's calendar date, YYYY-MM-DD. */
  date: string;
  startKm: Decimalish | null;
  endKm: Decimalish | null;
  diesel: readonly PlDieselLine[];
  purchases: readonly PlPurchase[];
  sales: readonly PlSale[];
  costs: readonly PlCost[];
  payments: readonly PlPayment[];
}

/* -------------------------------------------------------------- outputs */

export interface PurchaseFigures {
  /** Quantity × rate: the value without GST. */
  amount: string;
  gstAmount: string;
  /** What the vendor's bill comes to, GST included: what we owe them. */
  total: string;
  /** What the P&L counts. */
  cost: string;
  inputCredit: string;
}

export interface SaleFigures {
  /** Quantity × selling rate, without GST. */
  amount: string;
  gstAmount: string;
  transport: string;
  transportGst: string;
  /** Amount + transport: the sale's income. */
  taxable: string;
  gstTotal: string;
  /** What the customer's bill comes to, GST included: what they owe us. */
  total: string;
}

export interface DieselFigures {
  /** Typed: litres × rate. Linked: the whole fill, as on its bill. */
  amount: string;
  /** This trip's part of the fill. */
  shareLitres: number;
  shareAmount: string;
  /** How many trips the fill is split across (1 for a typed line). */
  sharedBy: number;
}

export interface TripPl {
  distanceKm: number | null;
  dieselLitres: number;
  mileageKmpl: number | null;
  sales: string;
  materialCost: string;
  gross: string;
  diesel: string;
  batta: string;
  enRoute: string;
  other: string;
  net: string;
  profitPct: number | null;
  outputGst: string;
  inputGst: string;
  gstToPay: string;
  customerBilled: string;
  received: string;
  customerDue: string;
  vendorBilled: string;
  paid: string;
  vendorDue: string;
}

/** What one customer or vendor of a trip was billed, paid or was paid, and what is left. */
export interface PartyDue {
  partyId: string;
  role: PartyRole;
  billed: string;
  settled: string;
  due: string;
}

export interface TripCalc {
  tripId: string;
  pl: TripPl;
  purchases: Record<string, PurchaseFigures>;
  sales: Record<string, SaleFigures>;
  diesel: Record<string, DieselFigures>;
  dues: PartyDue[];
}

/* ---------------------------------------------------------------- lines */

const money = (d: Dec) => toFixed(d, 2);
/** Code-unit order, as Python orders str: never the locale's. */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lineValue = (quantity: Decimalish | null, rate: Decimalish | null | undefined): Dec => roundTo(mul(dec(quantity), dec(rate)), 2);

/** Distance = end km − start km. None until both are read, or when the end is below the start. */
export function tripDistance(startKm: Decimalish | null, endKm: Decimalish | null): Dec | null {
  const start = parseDec(startKm);
  const end = parseDec(endKm);
  if (start === null || end === null || cmp(end, start) < 0) return null;
  return sub(end, start);
}

/** Mileage = distance ÷ litres, in km per litre to two places. None without both. */
export function mileage(distance: Dec | null, litres: Dec): Dec | null {
  if (distance === null || cmp(litres, dec(0)) <= 0) return null;
  return divTo(distance, litres, 2);
}

export function purchaseFigures(p: PlPurchase): PurchaseFigures {
  const amount = lineValue(p.quantity, p.rate);
  const gst = p.gstBilled ? percentOf(amount, dec(p.gstRatePct)) : dec(0);
  const total = add(amount, gst);
  return {
    amount: money(amount),
    gstAmount: money(gst),
    total: money(total),
    // GST bill: the tax is claimed back, so the cost is the value without it.
    // Non-GST bill: there is nothing to claim, so everything paid is cost.
    cost: money(p.gstBilled ? amount : total),
    inputCredit: money(p.gstBilled ? gst : dec(0)),
  };
}

export function saleFigures(s: PlSale): SaleFigures {
  const amount = lineValue(s.quantity, s.rate);
  const transport = roundTo(dec(s.transport), 2);
  const gst = s.gstBilled ? percentOf(amount, dec(s.gstRatePct)) : dec(0);
  const transportGst = s.gstBilled ? percentOf(transport, dec(s.transportGstRatePct)) : dec(0);
  const taxable = add(amount, transport);
  const gstTotal = add(gst, transportGst);
  return {
    amount: money(amount),
    gstAmount: money(gst),
    transport: money(transport),
    transportGst: money(transportGst),
    taxable: money(taxable),
    gstTotal: money(gstTotal),
    total: money(add(taxable, gstTotal)),
  };
}

/** A typed diesel line: litres × rate, to the paisa. */
export function typedDieselAmount(litres: Decimalish | null, rate: Decimalish | null | undefined): string {
  return money(lineValue(litres, rate));
}

/** The fill a linked line names, the same on every trip that links it. Null for a typed line. */
export function dieselLinkKey(line: PlDieselLine): string | null {
  if (line.source === 'expense_bill' && line.expenseBillId) return `expense_bill:${line.expenseBillId}`;
  if (line.source === 'fuel_entry' && line.fuelEntryId) return `fuel_entry:${line.fuelEntryId}`;
  return null;
}

/* ------------------------------------------------------- shared diesel */

/** One trip's part of a shared fill. */
export interface DieselShare {
  litres: Dec;
  amount: Dec;
  sharedBy: number;
}

/**
 * Each linked fill split across the trips that link it, by each trip's km
 * (equally when none of them has km yet). Keyed by trip id, then line id.
 * The trips are taken in trip-number order (then id), so a leftover paisa
 * lands on the earlier trip of the day, whoever computes it.
 */
export function dieselShares(trips: readonly PlTrip[]): Map<string, Map<string, DieselShare>> {
  const groups = new Map<string, { trip: PlTrip; line: PlDieselLine }[]>();
  for (const trip of trips) {
    const seen = new Set<string>();
    for (const line of trip.diesel) {
      const key = dieselLinkKey(line);
      // The same fill twice on one trip is refused when saved; if it gets
      // here, only its first line takes a part.
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? [];
      group.push({ trip, line });
      groups.set(key, group);
    }
  }
  const out = new Map<string, Map<string, DieselShare>>();
  for (const group of groups.values()) {
    group.sort((a, b) => byKey(a.trip.tripNumber ?? '', b.trip.tripNumber ?? '') || byKey(a.trip.id, b.trip.id));
    const first = group[0]!.line;
    const voided = group.some((g) => g.line.void === true);
    const totalAmount = voided ? dec(0) : dec(first.amount);
    const totalLitres = voided ? dec(0) : dec(first.litres);
    const weights = group.map((g) => tripDistance(g.trip.startKm, g.trip.endKm) ?? dec(0));
    const amounts = allocate(totalAmount, weights, 2);
    const litres = allocate(totalLitres, weights, 3);
    group.forEach((g, i) => {
      const byLine = out.get(g.trip.id) ?? new Map<string, DieselShare>();
      byLine.set(g.line.id, { litres: litres[i]!, amount: amounts[i]!, sharedBy: group.length });
      out.set(g.trip.id, byLine);
    });
  }
  return out;
}

/* ----------------------------------------------------------------- trips */

function duesOf(trip: PlTrip, purchases: Record<string, PurchaseFigures>, sales: Record<string, SaleFigures>): PartyDue[] {
  const rows = new Map<string, { partyId: string; role: PartyRole; billed: Dec; settled: Dec }>();
  const row = (role: PartyRole, partyId: string) => {
    const key = `${role}:${partyId}`;
    const found = rows.get(key) ?? { partyId, role, billed: dec(0), settled: dec(0) };
    rows.set(key, found);
    return found;
  };
  for (const s of trip.sales) {
    if (!s.customerId) continue;
    const r = row('customer', s.customerId);
    r.billed = add(r.billed, dec(sales[s.id]!.total));
  }
  for (const p of trip.purchases) {
    if (!p.vendorId) continue;
    const r = row('vendor', p.vendorId);
    r.billed = add(r.billed, dec(purchases[p.id]!.total));
  }
  for (const m of trip.payments) {
    if (!m.partyId) continue;
    const r = row(m.direction === 'in' ? 'customer' : 'vendor', m.partyId);
    r.settled = add(r.settled, roundTo(dec(m.amount), 2));
  }
  const all = [...rows.values()];
  // Customers first, then vendors; each in the order they first appear.
  return [...all.filter((r) => r.role === 'customer'), ...all.filter((r) => r.role === 'vendor')].map((r) => ({
    partyId: r.partyId,
    role: r.role,
    billed: money(r.billed),
    settled: money(r.settled),
    due: money(sub(r.billed, r.settled)),
  }));
}

/**
 * One trip's P&L. `shares` is this trip's part of each linked fill, from
 * `dieselShares` over every trip that links one of its fills. Left out, the
 * trip is taken on its own: a linked fill counts in full, which is right only
 * for a fill no other trip shares.
 */
export function calculateTrip(trip: PlTrip, shares: ReadonlyMap<string, DieselShare> = dieselShares([trip]).get(trip.id) ?? new Map()): TripCalc {
  const purchases: Record<string, PurchaseFigures> = {};
  const sales: Record<string, SaleFigures> = {};
  const diesel: Record<string, DieselFigures> = {};
  for (const p of trip.purchases) purchases[p.id] = purchaseFigures(p);
  for (const s of trip.sales) sales[s.id] = saleFigures(s);

  let dieselLitres = dec(0);
  let dieselAmount = dec(0);
  for (const line of trip.diesel) {
    let litres: Dec;
    let amount: Dec;
    let whole: Dec;
    let sharedBy: number;
    if (line.source === 'typed') {
      whole = amount = lineValue(line.litres, line.rate);
      litres = roundTo(dec(line.litres), 3);
      sharedBy = 1;
    } else {
      // A second line linking a fill this trip already links takes no part.
      const share = shares.get(line.id);
      // The fill as on its bill; a rejected or deleted bill still shows it, and counts nothing.
      whole = roundTo(dec(line.amount), 2);
      litres = share?.litres ?? dec(0);
      amount = share?.amount ?? dec(0);
      sharedBy = share?.sharedBy ?? 0;
    }
    diesel[line.id] = { amount: money(whole), shareLitres: toNumber(litres), shareAmount: money(amount), sharedBy };
    dieselLitres = add(dieselLitres, litres);
    dieselAmount = add(dieselAmount, amount);
  }

  const costOf = (kind: CostKind) => sum(trip.costs.filter((c) => c.kind === kind).map((c) => roundTo(dec(c.amount), 2)));
  const batta = costOf('batta');
  const enRoute = costOf('en_route');
  const other = costOf('other');

  const salesTotal = sum(Object.values(sales).map((s) => dec(s.taxable)));
  const materialCost = sum(Object.values(purchases).map((p) => dec(p.cost)));
  const gross = sub(salesTotal, materialCost);
  const net = sub(sub(sub(sub(gross, dieselAmount), batta), enRoute), other);
  const outputGst = sum(Object.values(sales).map((s) => dec(s.gstTotal)));
  const inputGst = sum(Object.values(purchases).map((p) => dec(p.inputCredit)));
  const customerBilled = sum(Object.values(sales).map((s) => dec(s.total)));
  const vendorBilled = sum(Object.values(purchases).map((p) => dec(p.total)));
  const paidOf = (direction: MoneyDirection) => sum(trip.payments.filter((m) => m.direction === direction).map((m) => roundTo(dec(m.amount), 2)));
  const received = paidOf('in');
  const paid = paidOf('out');
  const distance = tripDistance(trip.startKm, trip.endKm);
  const kmpl = mileage(distance, dieselLitres);

  return {
    tripId: trip.id,
    purchases,
    sales,
    diesel,
    dues: duesOf(trip, purchases, sales),
    pl: {
      distanceKm: distance === null ? null : toNumber(distance),
      dieselLitres: toNumber(roundTo(dieselLitres, 3)),
      mileageKmpl: kmpl === null ? null : toNumber(kmpl),
      sales: money(salesTotal),
      materialCost: money(materialCost),
      gross: money(gross),
      diesel: money(dieselAmount),
      batta: money(batta),
      enRoute: money(enRoute),
      other: money(other),
      net: money(net),
      profitPct: profitPct(net, salesTotal),
      outputGst: money(outputGst),
      inputGst: money(inputGst),
      gstToPay: money(sub(outputGst, inputGst)),
      customerBilled: money(customerBilled),
      received: money(received),
      customerDue: money(sub(customerBilled, received)),
      vendorBilled: money(vendorBilled),
      paid: money(paid),
      vendorDue: money(sub(vendorBilled, paid)),
    },
  };
}

/** Profit % = net ÷ sales × 100, to two places. None when nothing was sold: a loss on no sales has no percentage. */
export function profitPct(net: Dec, sales: Dec): number | null {
  if (isZero(sales)) return null;
  return toNumber(divTo(mul(net, dec(100)), sales, 2));
}

/**
 * Every trip's P&L, with each shared fill split across the trips given. Pass
 * every trip that links any fill one of them links (in practice: every trip
 * of the vehicle days involved), or a shared fill is split too few ways.
 */
export function calculateTrips(trips: readonly PlTrip[]): Map<string, TripCalc> {
  const shares = dieselShares(trips);
  return new Map(trips.map((t) => [t.id, calculateTrip(t, shares.get(t.id) ?? new Map())]));
}

/* --------------------------------------------------------------- reports */

export interface PlTotals {
  trips: number;
  distanceKm: number;
  dieselLitres: number;
  /** Km over litres, for the trips that have both. */
  mileageKmpl: number | null;
  sales: string;
  materialCost: string;
  gross: string;
  diesel: string;
  batta: string;
  enRoute: string;
  other: string;
  net: string;
  profitPct: number | null;
  outputGst: string;
  inputGst: string;
  gstToPay: string;
  customerBilled: string;
  received: string;
  customerDue: string;
  vendorBilled: string;
  paid: string;
  vendorDue: string;
}

const MONEY_KEYS = [
  'sales',
  'materialCost',
  'gross',
  'diesel',
  'batta',
  'enRoute',
  'other',
  'net',
  'outputGst',
  'inputGst',
  'gstToPay',
  'customerBilled',
  'received',
  'customerDue',
  'vendorBilled',
  'paid',
  'vendorDue',
] as const;

/** Trips added up: money summed, mileage and profit % worked out again from the sums. */
export function sumPl(pls: readonly TripPl[]): PlTotals {
  const totals = Object.fromEntries(MONEY_KEYS.map((k) => [k, money(sum(pls.map((p) => dec(p[k]))))])) as Record<(typeof MONEY_KEYS)[number], string>;
  const distance = sum(pls.map((p) => dec(p.distanceKm)));
  const litres = sum(pls.map((p) => dec(p.dieselLitres)));
  const measured = pls.filter((p) => p.distanceKm !== null && cmp(dec(p.dieselLitres), dec(0)) > 0);
  const kmpl = mileage(
    measured.length ? sum(measured.map((p) => dec(p.distanceKm))) : null,
    sum(measured.map((p) => dec(p.dieselLitres))),
  );
  return {
    trips: pls.length,
    distanceKm: toNumber(distance),
    dieselLitres: toNumber(roundTo(litres, 3)),
    mileageKmpl: kmpl === null ? null : toNumber(kmpl),
    ...totals,
    profitPct: profitPct(dec(totals.net), dec(totals.sales)),
  };
}

export interface VehiclePlRow extends PlTotals {
  vehicleId: string;
}

export interface MonthPlRow extends PlTotals {
  /** YYYY-MM. */
  month: string;
}

function groupBy<K extends string>(trips: readonly PlTrip[], calcs: ReadonlyMap<string, TripCalc>, keyOf: (t: PlTrip) => K): Map<K, TripPl[]> {
  const groups = new Map<K, TripPl[]>();
  for (const trip of trips) {
    const calc = calcs.get(trip.id);
    if (!calc) continue;
    const key = keyOf(trip);
    groups.set(key, [...(groups.get(key) ?? []), calc.pl]);
  }
  return groups;
}

/** One row per vehicle, the most profitable first. */
export function plByVehicle(trips: readonly PlTrip[], calcs: ReadonlyMap<string, TripCalc>): VehiclePlRow[] {
  return [...groupBy(trips, calcs, (t) => t.vehicleId)]
    .map(([vehicleId, pls]) => ({ vehicleId, ...sumPl(pls) }))
    .sort((a, b) => cmp(dec(b.net), dec(a.net)) || byKey(a.vehicleId, b.vehicleId));
}

/** One row per calendar month of the trip date, oldest first. */
export function plByMonth(trips: readonly PlTrip[], calcs: ReadonlyMap<string, TripCalc>): MonthPlRow[] {
  return [...groupBy(trips, calcs, (t) => t.date.slice(0, 7))]
    .map(([month, pls]) => ({ month, ...sumPl(pls) }))
    .sort((a, b) => byKey(a.month, b.month));
}

export interface OutstandingRow {
  partyId: string;
  role: PartyRole;
  trips: number;
  billed: string;
  settled: string;
  due: string;
  firstDate: string;
  lastDate: string;
}

/** Money due per customer (billed with GST − received) or per vendor (billed with GST − paid), the most due first. */
export function outstanding(trips: readonly PlTrip[], calcs: ReadonlyMap<string, TripCalc>, role: PartyRole): OutstandingRow[] {
  const rows = new Map<string, { trips: Set<string>; billed: Dec; settled: Dec; firstDate: string; lastDate: string }>();
  for (const trip of trips) {
    const calc = calcs.get(trip.id);
    if (!calc) continue;
    for (const d of calc.dues) {
      if (d.role !== role) continue;
      const row = rows.get(d.partyId) ?? { trips: new Set<string>(), billed: dec(0), settled: dec(0), firstDate: trip.date, lastDate: trip.date };
      row.trips.add(trip.id);
      row.billed = add(row.billed, dec(d.billed));
      row.settled = add(row.settled, dec(d.settled));
      if (trip.date < row.firstDate) row.firstDate = trip.date;
      if (trip.date > row.lastDate) row.lastDate = trip.date;
      rows.set(d.partyId, row);
    }
  }
  return [...rows]
    .map(([partyId, r]) => ({
      partyId,
      role,
      trips: r.trips.size,
      billed: money(r.billed),
      settled: money(r.settled),
      due: money(sub(r.billed, r.settled)),
      firstDate: r.firstDate,
      lastDate: r.lastDate,
    }))
    .sort((a, b) => cmp(dec(b.due), dec(a.due)) || byKey(a.partyId, b.partyId));
}

/* -------------------------------------------------------- double counting */

/** A bill number as people write it: "BK/4471", "bk 4471" and "BK-4471" are one bill. */
export function billKey(billNumber: string | null | undefined): string {
  return (billNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A diesel bill already in Linck (an expense bill), which a typed line must not repeat. */
export interface KnownDieselBill {
  id: string;
  billNumber: string;
  vehicleId: string | null;
}

/** Another trip's diesel bills, which a typed line on this trip must not repeat. */
export interface OtherTripDiesel {
  tripId: string;
  tripNumber: string;
  vehicleId: string;
  billNumbers: readonly string[];
}

export type DieselProblem =
  | { code: 'diesel-linked-twice'; lineId: string }
  | { code: 'diesel-same-bill'; lineId: string; billNumber: string }
  | { code: 'diesel-bill-exists'; lineId: string; billNumber: string; billId: string }
  | { code: 'diesel-bill-on-trip'; lineId: string; billNumber: string; tripNumber: string };

/**
 * Every way this trip's diesel would count a fill twice:
 *   - the same bill or fuel entry linked twice;
 *   - two lines with one bill number (a typed line repeating a linked one, or
 *     a fuel entry and the bunk's bill for it);
 *   - a typed line repeating a diesel bill already in Linck — link it instead;
 *   - a typed line repeating a bill on another trip of the vehicle.
 * Lines with no bill number are only checked for the first.
 */
export function findDoubleCounts(
  trip: PlTrip,
  context: { bills?: readonly KnownDieselBill[]; otherTrips?: readonly OtherTripDiesel[] } = {},
): DieselProblem[] {
  const problems: DieselProblem[] = [];
  const links = new Set<string>();
  const numbers = new Set<string>();
  const linkedBills = new Set(trip.diesel.filter((l) => l.source === 'expense_bill').map((l) => l.expenseBillId));
  for (const line of trip.diesel) {
    const link = dieselLinkKey(line);
    if (link !== null) {
      if (links.has(link)) {
        problems.push({ code: 'diesel-linked-twice', lineId: line.id });
        continue;
      }
      links.add(link);
    }
    const key = billKey(line.billNumber);
    if (!key) continue;
    if (numbers.has(key)) {
      problems.push({ code: 'diesel-same-bill', lineId: line.id, billNumber: line.billNumber ?? '' });
      continue;
    }
    numbers.add(key);
    if (line.source !== 'typed') continue;
    const bill = (context.bills ?? []).find(
      (b) => billKey(b.billNumber) === key && (b.vehicleId === null || b.vehicleId === trip.vehicleId) && !linkedBills.has(b.id),
    );
    if (bill) {
      problems.push({ code: 'diesel-bill-exists', lineId: line.id, billNumber: line.billNumber ?? '', billId: bill.id });
      continue;
    }
    const other = (context.otherTrips ?? []).find(
      (o) => o.tripId !== trip.id && o.vehicleId === trip.vehicleId && o.billNumbers.some((n) => billKey(n) === key),
    );
    if (other) problems.push({ code: 'diesel-bill-on-trip', lineId: line.id, billNumber: line.billNumber ?? '', tripNumber: other.tripNumber });
  }
  return problems;
}
