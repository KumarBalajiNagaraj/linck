/**
 * VEHICLE P&L (LIN-22), as the owner's workbook "Vehicle Trip Entry Form" lays it out.
 *
 * A TRIP SHEET is one vehicle and its driver from a start date to an end date
 * (several days at times). Its TRIPS are the loads it carried: each buys
 * material from a vendor and delivers it to a customer. Diesel, km readings,
 * batta, en-route expenses and payments can be written on either level (the
 * sheet's "Parent/Child" fields); purchases and sales belong to a trip.
 * Every rule is here, once, as a pure function over decimal strings
 * (decimal.ts), so the trip page, the reports and the API agree to the paisa.
 * apps/api/app/domain/vehicle_pl.py is the same rules in Python, and both run
 * over vehicle-pl.fixtures.json, so neither side can drift alone.
 *
 * The workbook's columns, and the rule each follows here:
 *
 *   L   distance         = K end km − J start km
 *   O   diesel cost      = M litres × N rate
 *   P   mileage          = L ÷ M
 *   AB  purchase cost    = Y quantity × AA rate
 *   AF  purchase GST     = AB × AE GST% ÷ 100, nothing on a non-GST bill
 *   AG  purchase total   = AB + AF                  (BD, what the vendor is owed)
 *   AV  selling price    = AO quantity × AQ rate + AR transport (transport is inside the taxable price)
 *   AW  sale GST         = AV × AU GST% ÷ 100, nothing on a non-GST bill
 *   AX  sale total       = AV + AW
 *   BB  customer due     = AX − BA received
 *   BF  vendor due       = BD − BE paid
 *   BH  en-route total   = Σ en-route expenses + O diesel + F batta
 *   BI  profit           = AV − AB − BH             (see `profit`: not the sheet's literal wording)
 *       gross            = AV − AB
 *       profit %         = BI ÷ AV × 100, none when nothing was sold
 *       GST to pay       = AW − AF, on its own line: GST is never profit
 *
 * What sits on the sheet is shared out to its trips by `spreadSheetCosts`: by
 * each trip's km when every trip has a km reading, otherwise evenly, so the
 * trips add up to the sheet exactly. A payment written on the sheet settles
 * that party's trips oldest first (`settleSheetPayments`).
 *
 * No double counting: GST is outside the selling price and the cost; transport
 * is income once; a payment moves money, not profit; a diesel bill or fuel
 * entry already in Linck is linked, never typed again, and counts on one
 * sheet only (`findDoubleCounts`).
 *
 * Every figure is rounded to the paisa (litres to the millilitre, km to a
 * tenth) once, half away from zero. A line not yet filled in counts nothing,
 * so the trip page's P&L box can follow the form as it is typed.
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

/** The rules' version, kept on each trip sheet the API writes. */
export const PL_RULES_VERSION = 'sheet-v1';

export type DieselSource = 'typed' | 'expense_bill' | 'fuel_entry';
/** The workbook's en-route list (column G). */
export type EnRouteKind = 'toll' | 'police' | 'maintenance';
/** Minor maintenance, the workbook's sub-list; `misc` carries the type the user typed. */
export type MaintenanceKind = 'tyre_rotation' | 'wheel_alignment' | 'greasing' | 'engine_oil' | 'coolant' | 'misc';
export type PartyRole = 'customer' | 'vendor';
export type MoneyDirection = 'in' | 'out';
/** How a sheet's own costs were shared out to its trips. */
export type SplitBasis = 'km' | 'even';
/** BC. Paid in full stays `paid` until accounts confirm it by hand; then `closed`. */
export type CustomerStatus = 'pending' | 'paid' | 'closed';
/** BG. */
export type VendorStatus = 'pending' | 'partial' | 'completed';

export const DIESEL_SOURCES: readonly DieselSource[] = ['typed', 'expense_bill', 'fuel_entry'];
export const EN_ROUTE_KINDS: readonly EnRouteKind[] = ['toll', 'police', 'maintenance'];
export const MAINTENANCE_KINDS: readonly MaintenanceKind[] = [
  'tyre_rotation',
  'wheel_alignment',
  'greasing',
  'engine_oil',
  'coolant',
  'misc',
];

/* --------------------------------------------------------------- inputs */

/**
 * One diesel line. Typed: M litres and N rate, as on the bunk's bill. Linked:
 * an expense bill or a fuel entry already in Linck — `litres` and `amount`
 * are read from it, never typed again.
 */
export interface PlDieselLine {
  id: string;
  source: DieselSource;
  litres: Decimalish | null;
  rate?: Decimalish | null;
  /** A linked fill's amount, as the bill or fuel entry says. A typed line's is M × N. */
  amount?: Decimalish | null;
  expenseBillId?: string | null;
  fuelEntryId?: string | null;
  billNumber?: string | null;
  /** A linked bill that was rejected or deleted: it counts nothing. */
  void?: boolean;
}

export interface PlEnRoute {
  id: string;
  kind: EnRouteKind;
  amount: Decimalish | null;
}

export interface PlPayment {
  id: string;
  /** In: received from a customer (BA). Out: paid to a vendor (BE). */
  direction: MoneyDirection;
  partyId: string | null;
  amount: Decimalish | null;
}

export interface PlPurchase {
  id: string;
  vendorId: string | null;
  quantity: Decimalish | null;
  rate: Decimalish | null;
  /** AC: a GST bill, whose tax is input credit. A non-GST bill has no GST at all. */
  gstBilled: boolean;
  gstRatePct: Decimalish | null;
}

export interface PlSale {
  id: string;
  customerId: string | null;
  quantity: Decimalish | null;
  rate: Decimalish | null;
  /** AR: transport charged to the customer, inside the taxable selling price. */
  transport?: Decimalish | null;
  gstBilled: boolean;
  gstRatePct: Decimalish | null;
}

/** Accounts confirmed by hand that a customer paid this trip in full, as billed then. */
export interface PlClosure {
  partyId: string;
  billed: Decimalish;
}

/** What either level can carry: the workbook's "Parent/Child" fields. */
export interface PlCosts {
  startKm?: Decimalish | null;
  endKm?: Decimalish | null;
  /** F: the driver's batta. */
  batta?: Decimalish | null;
  diesel?: readonly PlDieselLine[];
  enRoute?: readonly PlEnRoute[];
  payments?: readonly PlPayment[];
}

export interface PlTrip extends PlCosts {
  id: string;
  /** S. Orders trips of one date: the earlier number takes a leftover paisa. */
  tripNumber?: string | null;
  /** T, YYYY-MM-DD. */
  date: string;
  purchases: readonly PlPurchase[];
  sales: readonly PlSale[];
  closures?: readonly PlClosure[];
}

export interface PlSheet extends PlCosts {
  id: string;
  sheetNumber?: string | null;
  vehicleId: string;
  /** H and I, YYYY-MM-DD. */
  startDate: string;
  endDate?: string | null;
  trips: readonly PlTrip[];
}

/* -------------------------------------------------------------- outputs */

export interface PurchaseFigures {
  /** AB = Y × AA: the cost the P&L counts. */
  amount: string;
  /** AF: input credit, zero on a non-GST bill. */
  gstAmount: string;
  /** AG = AB + AF: what the vendor is owed (BD). */
  total: string;
}

export interface SaleFigures {
  /** AO × AQ. */
  amount: string;
  /** AR. */
  transport: string;
  /** AV = AO × AQ + AR: the selling price without GST, the P&L's income. */
  taxable: string;
  /** AW. */
  gstAmount: string;
  /** AX = AV + AW: what the customer is billed. */
  total: string;
}

export interface DieselFigures {
  /** M. */
  litres: number | null;
  /** N; for a linked fill, its amount ÷ litres. */
  rate: string | null;
  /** O. */
  amount: string;
  /** False for a void bill: shown, never counted. */
  counted: boolean;
}

/** What one level wrote down itself. */
export interface LevelCosts {
  distanceKm: number | null;
  dieselLitres: number;
  diesel: string;
  batta: string;
  enRoute: string;
}

/** A trip's part of what was written on its sheet. */
export interface SheetShare {
  distanceKm: number | null;
  dieselLitres: number;
  diesel: string;
  batta: string;
  enRoute: string;
}

export interface Spread {
  basis: SplitBasis;
  shares: Record<string, SheetShare>;
}

export interface TripPl {
  distanceKm: number | null;
  dieselLitres: number;
  mileageKmpl: number | null;
  /** Σ AV. */
  sales: string;
  /** Σ AB. */
  materialCost: string;
  gross: string;
  diesel: string;
  batta: string;
  enRoute: string;
  /** BH = en-route + diesel + batta. */
  totalEnRoute: string;
  /** BI. */
  net: string;
  profitPct: number | null;
  /** Σ AW. */
  outputGst: string;
  /** Σ AF. */
  inputGst: string;
  gstToPay: string;
  /** Σ AX. */
  customerBilled: string;
  /** BA. */
  received: string;
  /** BB. */
  customerDue: string;
  /** Σ AG = BD. */
  vendorBilled: string;
  /** BE. */
  paid: string;
  /** BF. */
  vendorDue: string;
}

export interface PartyDue {
  partyId: string;
  role: PartyRole;
  billed: string;
  settled: string;
  due: string;
  status: CustomerStatus | VendorStatus;
}

export interface TripCalc {
  tripId: string;
  pl: TripPl;
  own: LevelCosts;
  share: SheetShare | null;
  purchases: Record<string, PurchaseFigures>;
  sales: Record<string, SaleFigures>;
  diesel: Record<string, DieselFigures>;
  dues: PartyDue[];
}

export interface SheetCalc {
  sheetId: string;
  /** The sheet's total: its trips added up, or its own costs when it has no trip yet. */
  pl: TripPl;
  own: LevelCosts;
  /** How the sheet's own costs were shared out; null with no trips. */
  basis: SplitBasis | null;
  diesel: Record<string, DieselFigures>;
  /** Per party over the whole sheet. */
  dues: PartyDue[];
  /** Sheet payments no trip's bill took (an advance, or paid extra). */
  unsettled: PartyDue[];
  trips: Record<string, TripCalc>;
}

/* ---------------------------------------------------------------- rules */

const money = (d: Dec) => toFixed(d, 2);
const ZERO = dec(0);
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const positive = (d: Dec) => cmp(d, ZERO) > 0;
const lineValue = (quantity: Decimalish | null | undefined, rate: Decimalish | null | undefined): Dec =>
  roundTo(mul(dec(quantity), dec(rate)), 2);

/** L = K − J. None until both readings are in, or when the end is below the start. */
export function distance(startKm: Decimalish | null | undefined, endKm: Decimalish | null | undefined): Dec | null {
  const start = parseDec(startKm);
  const end = parseDec(endKm);
  if (start === null || end === null || cmp(end, start) < 0) return null;
  return sub(end, start);
}

/** P = L ÷ M, km per litre to two places. None without both. */
export function mileage(km: Dec | null, litres: Dec): Dec | null {
  if (km === null || !positive(litres)) return null;
  return divTo(km, litres, 2);
}

/** AB, AF, AG. A non-GST bill carries no GST, whatever rate was picked. */
export function purchaseFigures(p: PlPurchase): PurchaseFigures {
  const amount = lineValue(p.quantity, p.rate);
  const gst = p.gstBilled ? percentOf(amount, dec(p.gstRatePct)) : ZERO;
  return { amount: money(amount), gstAmount: money(gst), total: money(add(amount, gst)) };
}

/** AV = AO × AQ + AR, AW, AX. Transport is inside the taxable price, at the sale's GST rate. */
export function saleFigures(s: PlSale): SaleFigures {
  const amount = lineValue(s.quantity, s.rate);
  const transport = roundTo(dec(s.transport), 2);
  const taxable = add(amount, transport);
  const gst = s.gstBilled ? percentOf(taxable, dec(s.gstRatePct)) : ZERO;
  return {
    amount: money(amount),
    transport: money(transport),
    taxable: money(taxable),
    gstAmount: money(gst),
    total: money(add(taxable, gst)),
  };
}

/** O = M × N for a typed line; a linked fill's own amount; nothing for a void bill. */
export function dieselFigures(line: PlDieselLine): DieselFigures {
  const litres = parseDec(line.litres);
  if (line.source === 'typed') {
    const amount = lineValue(line.litres, line.rate);
    const rate = parseDec(line.rate);
    return { litres: litres === null ? null : toNumber(litres), rate: rate === null ? null : money(rate), amount: money(amount), counted: true };
  }
  const amount = roundTo(dec(line.amount), 2);
  const rate = litres !== null && positive(litres) && positive(amount) ? divTo(amount, litres, 2) : null;
  return {
    litres: litres === null ? null : toNumber(litres),
    rate: rate === null ? null : money(rate),
    amount: money(line.void ? ZERO : amount),
    counted: !line.void,
  };
}

/**
 * BI, the profit of a trip or a sheet.
 *
 * The workbook says "Total Selling Price − Total Purchase cost − Total Enroute
 * Expenses", and its Total Selling Price (AX) includes GST. LIN-22 says GST is
 * never profit, so the selling price taken here is AV, without GST, less the
 * purchase cost AB, also without GST, less BH. GST is reported apart as GST to
 * pay (AW − AF). Should the owner want the sheet's wording to the letter, this
 * is the one line to change: `sub(sub(sellingWithGst, purchaseCost), totalEnRoute)`.
 * vehicle-pl.test.ts states the choice with figures.
 */
export function profit(sellingPrice: Dec, purchaseCost: Dec, totalEnRoute: Dec): Dec {
  return sub(sub(sellingPrice, purchaseCost), totalEnRoute);
}

/** Profit % = net ÷ selling price × 100, to two places. None when nothing was sold. */
export function profitPct(net: Dec, sales: Dec): number | null {
  if (isZero(sales)) return null;
  return toNumber(divTo(mul(net, dec(100)), sales, 2));
}

/** A linked line's key: the same bill or fuel entry twice is one fill counted twice. */
export function dieselLinkKey(line: PlDieselLine): string | null {
  if (line.source === 'expense_bill' && line.expenseBillId) return `bill:${line.expenseBillId}`;
  if (line.source === 'fuel_entry' && line.fuelEntryId) return `fuel:${line.fuelEntryId}`;
  return null;
}

interface CostsOf {
  km: Dec | null;
  litres: Dec;
  diesel: Dec;
  batta: Dec;
  enRoute: Dec;
  dieselLines: Record<string, DieselFigures>;
}

function costsOf(level: PlCosts): CostsOf {
  const dieselLines: Record<string, DieselFigures> = {};
  let litres = ZERO;
  let diesel = ZERO;
  for (const line of level.diesel ?? []) {
    const f = dieselFigures(line);
    dieselLines[line.id] = f;
    if (!f.counted) continue;
    litres = add(litres, roundTo(dec(line.litres), 3));
    diesel = add(diesel, dec(f.amount));
  }
  return {
    km: distance(level.startKm, level.endKm),
    litres,
    diesel,
    batta: roundTo(dec(level.batta), 2),
    enRoute: sum((level.enRoute ?? []).map((e) => roundTo(dec(e.amount), 2))),
    dieselLines,
  };
}

function levelOut(c: CostsOf): LevelCosts {
  return {
    distanceKm: c.km === null ? null : toNumber(roundTo(c.km, 1)),
    dieselLitres: toNumber(roundTo(c.litres, 3)),
    diesel: money(c.diesel),
    batta: money(c.batta),
    enRoute: money(c.enRoute),
  };
}

/** Trips in the order a leftover paisa and a sheet payment go: by date, then number, then id. */
export function tripOrder(trips: readonly PlTrip[]): PlTrip[] {
  return [...trips].sort(
    (a, b) => byKey(a.date, b.date) || byKey(a.tripNumber ?? '', b.tripNumber ?? '') || byKey(a.id, b.id),
  );
}

/**
 * Share what was written on the sheet itself (its diesel, litres, batta,
 * en-route expenses and km reading) out to its trips: by each trip's own km
 * when every trip has a km reading and they add up to more than nothing,
 * otherwise evenly. Each figure is split on its own with `allocate`, so the
 * trips' parts add up to the sheet's exactly; a leftover paisa goes to the
 * trip with the largest remainder, the earlier trip on a tie. A sheet's km is
 * shared only when the sheet has a reading of its own.
 */
export function spreadSheetCosts(sheet: PlSheet): Spread | null {
  const trips = tripOrder(sheet.trips);
  if (trips.length === 0) return null;
  const own = costsOf(sheet);
  const kms = trips.map((t) => distance(t.startKm, t.endKm));
  const known = kms.every((k) => k !== null) && positive(sum(kms.map((k) => k ?? ZERO)));
  const basis: SplitBasis = known ? 'km' : 'even';
  const weights = known ? kms.map((k) => k as Dec) : trips.map(() => dec(1));
  const split = (total: Dec, places: number) => allocate(total, weights, places);
  const diesel = split(own.diesel, 2);
  const litres = split(own.litres, 3);
  const batta = split(own.batta, 2);
  const enRoute = split(own.enRoute, 2);
  const km = own.km === null ? null : split(own.km, 1);
  const shares: Record<string, SheetShare> = {};
  trips.forEach((t, i) => {
    shares[t.id] = {
      distanceKm: km === null ? null : toNumber(km[i]!),
      dieselLitres: toNumber(litres[i]!),
      diesel: money(diesel[i]!),
      batta: money(batta[i]!),
      enRoute: money(enRoute[i]!),
    };
  });
  return { basis, shares };
}

type DueKey = `${PartyRole}:${string}`;
interface DueAcc {
  partyId: string;
  role: PartyRole;
  billed: Dec;
  settled: Dec;
}

const roleOf = (direction: MoneyDirection): PartyRole => (direction === 'in' ? 'customer' : 'vendor');

function billsOf(trip: PlTrip, purchases: Record<string, PurchaseFigures>, sales: Record<string, SaleFigures>): Map<DueKey, DueAcc> {
  const acc = new Map<DueKey, DueAcc>();
  const touch = (role: PartyRole, partyId: string): DueAcc => {
    const key: DueKey = `${role}:${partyId}`;
    let row = acc.get(key);
    if (!row) {
      row = { partyId, role, billed: ZERO, settled: ZERO };
      acc.set(key, row);
    }
    return row;
  };
  for (const s of trip.sales) {
    if (!s.customerId) continue;
    const row = touch('customer', s.customerId);
    row.billed = add(row.billed, dec(sales[s.id]!.total));
  }
  for (const p of trip.purchases) {
    if (!p.vendorId) continue;
    const row = touch('vendor', p.vendorId);
    row.billed = add(row.billed, dec(purchases[p.id]!.total));
  }
  for (const pay of trip.payments ?? []) {
    if (!pay.partyId) continue;
    const row = touch(roleOf(pay.direction), pay.partyId);
    row.settled = add(row.settled, roundTo(dec(pay.amount), 2));
  }
  return acc;
}

/**
 * Payments written on the sheet settle that party's trips oldest first, each
 * trip up to what is still due on it (AX − BA, or BD − BE); what no trip takes
 * stays on the sheet, unsettled — an advance, or money paid extra. Returns,
 * per trip, what it takes from the sheet's payments, and what is left.
 */
export function settleSheetPayments(
  payments: readonly PlPayment[],
  trips: readonly { tripId: string; dues: readonly { partyId: string; role: PartyRole; billed: Decimalish; settled: Decimalish }[] }[],
): { taken: Record<string, Record<DueKey, string>>; left: Record<DueKey, string> } {
  const pool = new Map<DueKey, Dec>();
  for (const pay of payments) {
    if (!pay.partyId) continue;
    const key: DueKey = `${roleOf(pay.direction)}:${pay.partyId}`;
    pool.set(key, add(pool.get(key) ?? ZERO, roundTo(dec(pay.amount), 2)));
  }
  const taken: Record<string, Record<DueKey, string>> = {};
  for (const trip of trips) {
    taken[trip.tripId] = {};
    for (const d of trip.dues) {
      const key: DueKey = `${d.role}:${d.partyId}`;
      const left = pool.get(key);
      if (!left || !positive(left)) continue;
      const still = sub(dec(d.billed), dec(d.settled));
      if (!positive(still)) continue;
      const take = cmp(left, still) < 0 ? left : still;
      taken[trip.tripId]![key] = money(take);
      pool.set(key, sub(left, take));
    }
  }
  const left: Record<DueKey, string> = {};
  for (const [key, amount] of pool) if (positive(amount)) left[key] = money(amount);
  return { taken, left };
}

function customerStatus(billed: Dec, settled: Dec, closed: boolean): CustomerStatus {
  if (cmp(sub(billed, settled), ZERO) > 0) return 'pending';
  return closed ? 'closed' : 'paid';
}

function vendorStatus(billed: Dec, settled: Dec): VendorStatus {
  if (cmp(sub(billed, settled), ZERO) <= 0) return 'completed';
  return positive(settled) ? 'partial' : 'pending';
}

function dueOut(row: DueAcc, status: CustomerStatus | VendorStatus): PartyDue {
  return {
    partyId: row.partyId,
    role: row.role,
    billed: money(row.billed),
    settled: money(row.settled),
    due: money(sub(row.billed, row.settled)),
    status,
  };
}

const sortDues = (dues: PartyDue[]) =>
  dues.sort((a, b) => (a.role === b.role ? byKey(a.partyId, b.partyId) : a.role === 'customer' ? -1 : 1));

function plOf(parts: {
  km: Dec | null;
  litres: Dec;
  sales: Dec;
  material: Dec;
  diesel: Dec;
  batta: Dec;
  enRoute: Dec;
  outputGst: Dec;
  inputGst: Dec;
  customerBilled: Dec;
  received: Dec;
  vendorBilled: Dec;
  paid: Dec;
}): TripPl {
  const totalEnRoute = add(add(parts.enRoute, parts.diesel), parts.batta);
  const net = profit(parts.sales, parts.material, totalEnRoute);
  const kmpl = mileage(parts.km, parts.litres);
  return {
    distanceKm: parts.km === null ? null : toNumber(roundTo(parts.km, 1)),
    dieselLitres: toNumber(roundTo(parts.litres, 3)),
    mileageKmpl: kmpl === null ? null : toNumber(kmpl),
    sales: money(parts.sales),
    materialCost: money(parts.material),
    gross: money(sub(parts.sales, parts.material)),
    diesel: money(parts.diesel),
    batta: money(parts.batta),
    enRoute: money(parts.enRoute),
    totalEnRoute: money(totalEnRoute),
    net: money(net),
    profitPct: profitPct(net, parts.sales),
    outputGst: money(parts.outputGst),
    inputGst: money(parts.inputGst),
    gstToPay: money(sub(parts.outputGst, parts.inputGst)),
    customerBilled: money(parts.customerBilled),
    received: money(parts.received),
    customerDue: money(sub(parts.customerBilled, parts.received)),
    vendorBilled: money(parts.vendorBilled),
    paid: money(parts.paid),
    vendorDue: money(sub(parts.vendorBilled, parts.paid)),
  };
}

function duesTotals(dues: readonly PartyDue[]) {
  const pick = (role: PartyRole, key: 'billed' | 'settled') => sum(dues.filter((d) => d.role === role).map((d) => dec(d[key])));
  return {
    customerBilled: pick('customer', 'billed'),
    received: pick('customer', 'settled'),
    vendorBilled: pick('vendor', 'billed'),
    paid: pick('vendor', 'settled'),
  };
}

/** One sheet worked out: each trip with its part of the sheet's costs and payments, and the sheet's total. */
export function calculateSheet(sheet: PlSheet): SheetCalc {
  const own = costsOf(sheet);
  const spread = spreadSheetCosts(sheet);
  const ordered = tripOrder(sheet.trips);

  const staged = ordered.map((trip) => {
    const purchases: Record<string, PurchaseFigures> = {};
    for (const p of trip.purchases) purchases[p.id] = purchaseFigures(p);
    const sales: Record<string, SaleFigures> = {};
    for (const s of trip.sales) sales[s.id] = saleFigures(s);
    return { trip, purchases, sales, costs: costsOf(trip), bills: billsOf(trip, purchases, sales) };
  });

  const settled = settleSheetPayments(
    sheet.payments ?? [],
    staged.map((s) => ({
      tripId: s.trip.id,
      dues: [...s.bills.values()].map((d) => ({ partyId: d.partyId, role: d.role, billed: money(d.billed), settled: money(d.settled) })),
    })),
  );

  const trips: Record<string, TripCalc> = {};
  for (const s of staged) {
    const share = spread?.shares[s.trip.id] ?? null;
    const taken = settled.taken[s.trip.id] ?? {};
    const closures = new Map((s.trip.closures ?? []).map((c) => [c.partyId, roundTo(dec(c.billed), 2)]));
    const dues = sortDues(
      [...s.bills.entries()].map(([key, row]) => {
        const withSheet = { ...row, settled: add(row.settled, dec(taken[key])) };
        if (row.role === 'vendor') return dueOut(withSheet, vendorStatus(withSheet.billed, withSheet.settled));
        const closure = closures.get(row.partyId);
        const closed = closure !== undefined && cmp(closure, row.billed) === 0;
        return dueOut(withSheet, customerStatus(withSheet.billed, withSheet.settled, closed));
      }),
    );
    const sold = Object.values(s.sales);
    const bought = Object.values(s.purchases);
    const km = share?.distanceKm != null ? dec(share.distanceKm) : s.costs.km;
    trips[s.trip.id] = {
      tripId: s.trip.id,
      pl: plOf({
        km,
        litres: add(s.costs.litres, dec(share?.dieselLitres)),
        sales: sum(sold.map((f) => dec(f.taxable))),
        material: sum(bought.map((f) => dec(f.amount))),
        diesel: add(s.costs.diesel, dec(share?.diesel)),
        batta: add(s.costs.batta, dec(share?.batta)),
        enRoute: add(s.costs.enRoute, dec(share?.enRoute)),
        outputGst: sum(sold.map((f) => dec(f.gstAmount))),
        inputGst: sum(bought.map((f) => dec(f.gstAmount))),
        ...duesTotals(dues),
      }),
      own: levelOut(s.costs),
      share,
      purchases: s.purchases,
      sales: s.sales,
      diesel: s.costs.dieselLines,
      dues,
    };
  }

  // The sheet: every party's bills and payments over all its trips and the sheet itself.
  const total = new Map<DueKey, DueAcc & { closedAll: boolean }>();
  for (const calc of Object.values(trips)) {
    for (const d of calc.dues) {
      const key: DueKey = `${d.role}:${d.partyId}`;
      const row = total.get(key) ?? { partyId: d.partyId, role: d.role, billed: ZERO, settled: ZERO, closedAll: true };
      row.billed = add(row.billed, dec(d.billed));
      row.settled = add(row.settled, dec(d.settled));
      if (d.role === 'customer' && d.status !== 'closed') row.closedAll = false;
      total.set(key, row);
    }
  }
  const unsettled: PartyDue[] = [];
  for (const [key, amount] of Object.entries(settled.left) as [DueKey, string][]) {
    const [role, ...rest] = key.split(':') as [PartyRole, ...string[]];
    const partyId = rest.join(':');
    const leftover = { partyId, role, billed: ZERO, settled: dec(amount) };
    unsettled.push(dueOut(leftover, role === 'vendor' ? 'completed' : 'paid'));
    const row = total.get(key) ?? { ...leftover, settled: ZERO, closedAll: false };
    row.settled = add(row.settled, dec(amount));
    if (row.role === 'customer' && isZero(row.billed)) row.closedAll = false;
    total.set(key, row);
  }
  const dues = sortDues(
    [...total.values()].map((row) =>
      row.role === 'vendor'
        ? dueOut(row, vendorStatus(row.billed, row.settled))
        : dueOut(row, customerStatus(row.billed, row.settled, row.closedAll)),
    ),
  );
  sortDues(unsettled);

  const calcs = Object.values(trips);
  const tripKm = calcs.map((c) => (c.own.distanceKm === null ? null : dec(c.own.distanceKm)));
  const km = own.km ?? (tripKm.some((k) => k !== null) ? sum(tripKm.map((k) => k ?? ZERO)) : null);
  const litres = add(own.litres, sum(calcs.map((c) => dec(c.own.dieselLitres))));
  const pick = (key: keyof TripPl) => sum(calcs.map((c) => dec(c.pl[key] as string)));
  const pl =
    calcs.length === 0
      ? plOf({
          km,
          litres,
          sales: ZERO,
          material: ZERO,
          diesel: own.diesel,
          batta: own.batta,
          enRoute: own.enRoute,
          outputGst: ZERO,
          inputGst: ZERO,
          ...duesTotals(dues),
        })
      : plOf({
          km,
          litres,
          sales: pick('sales'),
          material: pick('materialCost'),
          diesel: pick('diesel'),
          batta: pick('batta'),
          enRoute: pick('enRoute'),
          outputGst: pick('outputGst'),
          inputGst: pick('inputGst'),
          ...duesTotals(dues),
        });

  return {
    sheetId: sheet.id,
    pl,
    own: levelOut(own),
    basis: spread?.basis ?? null,
    diesel: own.dieselLines,
    dues,
    unsettled,
    trips,
  };
}

export function calculateSheets(sheets: readonly PlSheet[]): Map<string, SheetCalc> {
  return new Map(sheets.map((s) => [s.id, calculateSheet(s)]));
}

/* --------------------------------------------------------------- reports */

export interface PlTotals {
  trips: number;
  distanceKm: number;
  dieselLitres: number;
  /** Km over litres, for what has both. */
  mileageKmpl: number | null;
  sales: string;
  materialCost: string;
  gross: string;
  diesel: string;
  batta: string;
  enRoute: string;
  totalEnRoute: string;
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
  'totalEnRoute',
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

/** P&Ls added up: money summed, mileage and profit % worked out again from the sums. */
export function sumPl(pls: readonly TripPl[], trips: number = pls.length): PlTotals {
  const totals = Object.fromEntries(MONEY_KEYS.map((k) => [k, money(sum(pls.map((p) => dec(p[k]))))])) as Record<
    (typeof MONEY_KEYS)[number],
    string
  >;
  const measured = pls.filter((p) => p.distanceKm !== null && p.dieselLitres > 0);
  const kmpl = mileage(
    measured.length ? sum(measured.map((p) => dec(p.distanceKm))) : null,
    sum(measured.map((p) => dec(p.dieselLitres))),
  );
  return {
    trips,
    distanceKm: toNumber(roundTo(sum(pls.map((p) => dec(p.distanceKm))), 1)),
    dieselLitres: toNumber(roundTo(sum(pls.map((p) => dec(p.dieselLitres))), 3)),
    mileageKmpl: kmpl === null ? null : toNumber(kmpl),
    ...totals,
    profitPct: profitPct(dec(totals.net), dec(totals.sales)),
  };
}

/**
 * What the reports add up: each trip with its part of its sheet's costs, on
 * its own date; a sheet with no trip yet, on its start date, with its costs;
 * and a sheet's unsettled payments, on its start date, with nothing but the
 * money they moved. So every report adds up to the same totals.
 */
export interface PlUnit {
  sheetId: string;
  tripId: string | null;
  vehicleId: string;
  date: string;
  pl: TripPl;
  dues: PartyDue[];
}

/** Money that moved with no trip to take it: no profit or loss, only what was received or paid. */
function unsettledPl(dues: readonly PartyDue[]): TripPl {
  return plOf({
    km: null,
    litres: ZERO,
    sales: ZERO,
    material: ZERO,
    diesel: ZERO,
    batta: ZERO,
    enRoute: ZERO,
    outputGst: ZERO,
    inputGst: ZERO,
    ...duesTotals(dues),
  });
}

export function plUnits(sheets: readonly PlSheet[], calcs: ReadonlyMap<string, SheetCalc>): PlUnit[] {
  const units: PlUnit[] = [];
  for (const sheet of sheets) {
    const calc = calcs.get(sheet.id);
    if (!calc) continue;
    const base = { sheetId: sheet.id, vehicleId: sheet.vehicleId };
    if (sheet.trips.length === 0) {
      units.push({ ...base, tripId: null, date: sheet.startDate, pl: calc.pl, dues: calc.dues });
      continue;
    }
    for (const trip of tripOrder(sheet.trips)) {
      const t = calc.trips[trip.id]!;
      units.push({ ...base, tripId: trip.id, date: trip.date, pl: t.pl, dues: t.dues });
    }
    if (calc.unsettled.length) units.push({ ...base, tripId: null, date: sheet.startDate, pl: unsettledPl(calc.unsettled), dues: calc.unsettled });
  }
  return units;
}

export interface VehiclePlRow extends PlTotals {
  vehicleId: string;
}

export interface MonthPlRow extends PlTotals {
  /** YYYY-MM. */
  month: string;
}

function grouped<K extends string>(units: readonly PlUnit[], keyOf: (u: PlUnit) => K): [K, PlTotals][] {
  const groups = new Map<K, PlUnit[]>();
  for (const u of units) {
    const key = keyOf(u);
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  return [...groups].map(([key, us]) => [key, sumPl(us.map((u) => u.pl), us.filter((u) => u.tripId !== null).length)]);
}

/** Every unit's P&L added up: the trip-wise report's total line. */
export function totalPl(units: readonly PlUnit[]): PlTotals {
  return sumPl(units.map((u) => u.pl), units.filter((u) => u.tripId !== null).length);
}

/** One row per vehicle, the most profitable first. */
export function plByVehicle(units: readonly PlUnit[]): VehiclePlRow[] {
  return grouped(units, (u) => u.vehicleId)
    .map(([vehicleId, t]) => ({ vehicleId, ...t }))
    .sort((a, b) => cmp(dec(b.net), dec(a.net)) || byKey(a.vehicleId, b.vehicleId));
}

/** One row per calendar month of the trip date, oldest first. */
export function plByMonth(units: readonly PlUnit[]): MonthPlRow[] {
  return grouped(units, (u) => u.date.slice(0, 7))
    .map(([month, t]) => ({ month, ...t }))
    .sort((a, b) => byKey(a.month, b.month));
}

export interface OutstandingRow {
  partyId: string;
  role: PartyRole;
  trips: number;
  billed: string;
  settled: string;
  due: string;
  status: CustomerStatus | VendorStatus;
  firstDate: string;
  lastDate: string;
}

/** Money due per customer (AX − BA) or per vendor (BD − BE), over every unit given, the most due first. */
export function outstanding(units: readonly PlUnit[], role: PartyRole): OutstandingRow[] {
  const rows = new Map<string, { trips: Set<string>; billed: Dec; settled: Dec; closedAll: boolean; firstDate: string; lastDate: string }>();
  for (const unit of units) {
    for (const d of unit.dues) {
      if (d.role !== role) continue;
      const row = rows.get(d.partyId) ?? {
        trips: new Set<string>(),
        billed: ZERO,
        settled: ZERO,
        closedAll: true,
        firstDate: unit.date,
        lastDate: unit.date,
      };
      if (unit.tripId) row.trips.add(unit.tripId);
      row.billed = add(row.billed, dec(d.billed));
      row.settled = add(row.settled, dec(d.settled));
      if (d.status !== 'closed') row.closedAll = false;
      if (unit.date < row.firstDate) row.firstDate = unit.date;
      if (unit.date > row.lastDate) row.lastDate = unit.date;
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
      status: role === 'vendor' ? vendorStatus(r.billed, r.settled) : customerStatus(r.billed, r.settled, r.closedAll),
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

/** Another sheet's typed diesel bills, which a typed line on this sheet must not repeat. */
export interface OtherSheetDiesel {
  sheetId: string;
  sheetNumber: string;
  vehicleId: string;
  billNumbers: readonly string[];
}

export type DieselProblem =
  | { code: 'diesel-linked-twice'; lineId: string }
  | { code: 'diesel-same-bill'; lineId: string; billNumber: string }
  | { code: 'diesel-bill-exists'; lineId: string; billNumber: string; billId: string }
  | { code: 'diesel-bill-on-sheet'; lineId: string; billNumber: string; sheetNumber: string };

/** Every diesel line of a sheet, its own first, then each trip's in trip order. */
export function sheetDieselLines(sheet: PlSheet): { tripId: string | null; line: PlDieselLine }[] {
  return [
    ...(sheet.diesel ?? []).map((line) => ({ tripId: null, line })),
    ...tripOrder(sheet.trips).flatMap((t) => (t.diesel ?? []).map((line) => ({ tripId: t.id, line }))),
  ];
}

/**
 * Every way this sheet's diesel would count a fill twice:
 *   - the same bill or fuel entry linked twice, on the sheet or its trips;
 *   - two lines with one bill number (a typed line repeating a linked one, or
 *     a fuel entry and the bunk's bill for it);
 *   - a typed line repeating a diesel bill already in Linck — link it instead;
 *   - a typed line repeating a bill on another sheet of the vehicle.
 * Lines with no bill number are only checked for the first.
 */
export function findDoubleCounts(
  sheet: PlSheet,
  context: { bills?: readonly KnownDieselBill[]; otherSheets?: readonly OtherSheetDiesel[] } = {},
): DieselProblem[] {
  const problems: DieselProblem[] = [];
  const links = new Set<string>();
  const numbers = new Set<string>();
  const lines = sheetDieselLines(sheet).map((l) => l.line);
  const linkedBills = new Set(lines.filter((l) => l.source === 'expense_bill').map((l) => l.expenseBillId));
  for (const line of lines) {
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
      (b) => billKey(b.billNumber) === key && (b.vehicleId === null || b.vehicleId === sheet.vehicleId) && !linkedBills.has(b.id),
    );
    if (bill) {
      problems.push({ code: 'diesel-bill-exists', lineId: line.id, billNumber: line.billNumber ?? '', billId: bill.id });
      continue;
    }
    const other = (context.otherSheets ?? []).find(
      (o) => o.sheetId !== sheet.id && o.vehicleId === sheet.vehicleId && o.billNumbers.some((n) => billKey(n) === key),
    );
    if (other) problems.push({ code: 'diesel-bill-on-sheet', lineId: line.id, billNumber: line.billNumber ?? '', sheetNumber: other.sheetNumber });
  }
  return problems;
}
