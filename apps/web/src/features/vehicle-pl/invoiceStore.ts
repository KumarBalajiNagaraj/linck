import { useMemo } from 'react';
import { create } from 'zustand';
import {
  amountInWords,
  can,
  decimal,
  GST_STATES,
  invoiceDue,
  invoiceFigures,
  invoiceKind,
  invoiceNumber,
  isInvoiceNumber,
  matchReceipts,
  moneyStatus,
  placeOfSupply,
  saleFigures,
  stateOfGstin,
  supplyType,
  type Grants,
  type InvoiceLineInput,
} from '@linck/domain';
import {
  NOW,
  sellerOfSite,
  siteName,
  type PlInvoiceDetail,
  type PlInvoiceLine,
  type PlInvoiceList,
  type PlInvoicePatch,
  type PlInvoiceReceipt,
  type PlInvoiceReceipts,
  type PlInvoiceRow,
  type PlInvoiceStatus,
  type PlInvoiceTripRow,
  type PlInvoiceUnmatched,
  type PlMaterial,
  type PlParty,
  type PlPosBasis,
  type PlSaleInvoice,
  type PlSaleRecord,
  type PlSeller,
  type PlSheetInput,
  type PlSheetRecord,
  type PlTaxRow,
  type PlTripRecord,
} from '@linck/mock';
import { fy, guardSheets, todayIso, usePl, type PlProblem, type Who } from './plStore.js';

/**
 * Party invoices (LIN-27) as one client-side store: the demo source of what
 * /vehicle-pl/invoices returns, shaped field for field like the API's JSON
 * (packages/mock/src/types.ts). At cutover these functions become fetches of
 * those routes and nothing on the screens changes.
 *
 * An invoice bills one customer for the sale lines of one trip or several,
 * all from one site's sheets, whose GST registration is the seller. A draft
 * has no number; issuing takes the next of the seller's series for the
 * financial year and freezes every line and figure; cancelling keeps it on
 * record with its number and frees its trips; only a draft is deleted.
 * Every figure is packages/domain/src/party-invoice.ts's, and every refusal
 * is the API's (apps/api/app/services/party_invoices.py), with its code.
 *
 * The trip sheets stay in plStore.ts; this store registers the guard their
 * save and delete answer to (`guardSheets`): a sale line on a live invoice
 * stays as billed, a payment changed or removed loses its matches, and a
 * cancelled invoice keeps its copy of a line deleted from its trip.
 */

export const INVOICE_READ = 'sales.invoice.read';
export const INVOICE_WRITE = 'sales.invoice.write';
export const INVOICE_CANCEL = 'sales.invoice.cancel';
/** Matching money received to an invoice is accounts' confirmation of money received. */
export const RECEIVE = 'finance.receipt.verify';

/** The list, in Fleet beside the trip sheets, and in Accounts. An invoice opens under the list it came from. */
export const INVOICES_PATH: string = '/fleet/pl/invoices';
export const FINANCE_INVOICES_PATH: string = '/finance/invoices';
export const invoicesBase = (pathname: string): string => (pathname.startsWith(`${FINANCE_INVOICES_PATH}`) ? FINANCE_INVOICES_PATH : INVOICES_PATH);
export const invoicePath = (id: string, base: string = INVOICES_PATH): string => `${base}/${id}`;

export type InvoiceProblem =
  | { code: 'needs-permission'; permission: string }
  | { code: 'invalid'; field: string; reason: string }
  | { code: 'trips-other-site' }
  | { code: 'trip-not-for-customer'; tripNumber: string }
  | { code: 'sale-on-invoice'; tripNumber: string; invoiceId: string; invoiceNumber: string | null; status: string }
  | { code: 'sale-not-gst'; tripNumber: string }
  | { code: 'sale-billed-outside'; tripNumber: string; invoiceNumber: string }
  | { code: 'sale-no-hsn'; tripNumber: string }
  | { code: 'site-no-gstin'; siteId: string; siteName: string }
  | { code: 'buyer-gstins-differ'; gstins: string[] }
  | { code: 'places-differ'; states: string[] }
  | { code: 'not-a-draft'; status: string; invoiceNumber: string | null }
  | { code: 'not-issued'; status: string }
  | { code: 'already-cancelled'; invoiceNumber: string | null }
  | { code: 'series-full'; gstin: string; financialYear: string }
  | { code: 'payment-matched' }
  | { code: 'invoice-paid' }
  | { code: 'too-much'; free: string; due: string }
  | { code: 'invoice-gone' }
  | { code: 'receipt-gone' }
  /*
   * Live only (invoiceApi.ts): the API's own refusals this store never makes,
   * and what can go wrong on the way to it.
   */
  /** The site's GST registration has a GSTIN that names no state. */
  | { code: 'seller-gstin-wrong'; gstin: string }
  /** What the draft bills changed under it meanwhile. */
  | { code: 'invoice-changed' }
  /** The session ended and could not be renewed. The sign-in screen follows. */
  | { code: 'signed-out' }
  /** The API did not answer at all. */
  | { code: 'offline' }
  /** The API answered with a fault, or with something this app cannot read. */
  | { code: 'server'; status: number };

export type InvoiceResult = { ok: true; id: string } | { ok: false; problem: InvoiceProblem };

/** A line as stored: what the invoice printed. */
export type InvoiceLineRecord = Omit<PlInvoiceLine, 'tripId' | 'sheetId' | 'cgstPct' | 'sgstPct' | 'igstPct'>;

/** An invoice as the API stores it: its seller, buyer and lines copied in as billed. */
export interface InvoiceRecord {
  id: string;
  siteId: string;
  registrationId: string;
  customerId: string;
  status: PlInvoiceStatus;
  financialYear: string | null;
  serial: number | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  seller: PlSeller;
  buyerName: string;
  buyerGstin: string | null;
  buyerAddress: string;
  shipToName: string;
  shipToAddress: string;
  placeOfSupply: string;
  posBasis: PlPosBasis;
  supplyType: 'intra' | 'inter';
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  total: string;
  notes: string;
  createdBy: string;
  createdAt: string;
  issuedBy: string | null;
  issuedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: InvoiceLineRecord[];
}

/** A trip payment matched to an issued invoice. */
export interface ReceiptRecord {
  id: string;
  invoiceId: string;
  paymentId: string;
  amount: string;
  matchedBy: string;
  matchedAt: string;
}

/** Everything the rules read: the trip sheets and masters (plStore), and the invoices. */
export interface World {
  sheets: readonly PlSheetRecord[];
  parties: readonly PlParty[];
  materials: readonly PlMaterial[];
  invoices: readonly InvoiceRecord[];
  receipts: readonly ReceiptRecord[];
  /** `${registration}:${financialYear}` → the last serial taken. */
  series: Readonly<Record<string, number>>;
}

type Done = { ok: true; world: World; id: string } | { ok: false; problem: InvoiceProblem };

const LIVE = new Set<PlInvoiceStatus>(['draft', 'issued']);
const money = (v: string | number | null | undefined) => decimal.toFixed(decimal.dec(v ?? 0), 2);
const positive = (v: string) => decimal.cmp(decimal.dec(v), decimal.dec(0)) > 0;
const add = (a: string, b: string) => money(decimal.toFixed(decimal.add(decimal.dec(a), decimal.dec(b)), 2));
const sumOf = (xs: readonly string[]) => money(decimal.toFixed(decimal.sum(xs.map((x) => decimal.dec(x))), 2));
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

let seq = 0;
/** Ids in the order things are made, so the demo's own invoices have the same ones on every load. */
const newId = (prefix: string) => `${prefix}-${String((seq += 1)).padStart(5, '0')}`;

/* ------------------------------------------------------------ the lookups */

interface Billed {
  sale: PlSaleRecord;
  trip: PlTripRecord;
  sheet: PlSheetRecord;
}

function tripsById(sheets: readonly PlSheetRecord[]): Map<string, { trip: PlTripRecord; sheet: PlSheetRecord }> {
  const out = new Map<string, { trip: PlTripRecord; sheet: PlSheetRecord }>();
  for (const sheet of sheets) for (const trip of sheet.trips) out.set(trip.id, { trip, sheet });
  return out;
}

function salesById(sheets: readonly PlSheetRecord[]): Map<string, Billed> {
  const out = new Map<string, Billed>();
  for (const sheet of sheets) for (const trip of sheet.trips) for (const sale of trip.sales) out.set(sale.id, { sale, trip, sheet });
  return out;
}

const listed = (a: Billed, b: Billed) =>
  byKey(a.trip.date, b.trip.date) || byKey(a.trip.tripNumber, b.trip.tripNumber) || a.trip.sales.indexOf(a.sale) - b.trip.sales.indexOf(b.sale);

/** For each sale line on a draft or issued invoice, that invoice. */
export function liveInvoices(invoices: readonly InvoiceRecord[]): Map<string, PlSaleInvoice> {
  const out = new Map<string, PlSaleInvoice>();
  for (const inv of invoices) {
    if (!LIVE.has(inv.status)) continue;
    for (const line of inv.lines) if (line.tripSaleId) out.set(line.tripSaleId, { id: inv.id, number: inv.invoiceNumber, status: inv.status });
  }
  return out;
}

const ref = (r: PlSaleInvoice) => ({ invoiceId: r.id, invoiceNumber: r.number, status: r.status });

/** Why a sale line cannot go on a new invoice, if it cannot. */
function billable(b: Billed, live: Map<string, PlSaleInvoice>): InvoiceProblem | null {
  const tripNumber = b.trip.tripNumber;
  const on = live.get(b.sale.id);
  if (on) return { code: 'sale-on-invoice', tripNumber, ...ref(on) };
  if (!b.sale.gstBilled) return { code: 'sale-not-gst', tripNumber };
  if ((b.sale.invoiceNumber ?? '').trim()) return { code: 'sale-billed-outside', tripNumber, invoiceNumber: b.sale.invoiceNumber ?? '' };
  if (!b.sale.hsnCode) return { code: 'sale-no-hsn', tripNumber };
  return null;
}

/* ------------------------------------------------------ what it says */

export interface Kept {
  placeOfSupply: string;
  posBasis: PlPosBasis;
  buyerAddress: string;
  shipToAddress: string;
}

const keptOf = (r: InvoiceRecord): Kept => ({ placeOfSupply: r.placeOfSupply, posBasis: r.posBasis, buyerAddress: r.buyerAddress, shipToAddress: r.shipToAddress });

type Header = Pick<
  InvoiceRecord,
  'registrationId' | 'seller' | 'buyerName' | 'buyerGstin' | 'buyerAddress' | 'shipToName' | 'shipToAddress' | 'placeOfSupply' | 'posBasis' | 'supplyType'
>;

function header(siteId: string, customer: PlParty, billed: readonly Billed[], kept: Kept | null): { header: Header } | { problem: InvoiceProblem } {
  const registration = sellerOfSite(siteId);
  if (!registration) return { problem: { code: 'site-no-gstin', siteId, siteName: siteName(siteId) } };
  const sellerState = registration.gstin.slice(0, 2);
  const gstins = [...new Set([...billed.map((b) => b.sale.partyGstin), customer.gstin].filter((g): g is string => Boolean(g)))].sort();
  if (gstins.length > 1) return { problem: { code: 'buyer-gstins-differ', gstins } };
  const buyerGstin = gstins[0] ?? null;
  const locations = new Map(customer.locations.map((l) => [l.name.trim().toLowerCase(), l]));
  const names = [...new Set(billed.map((b) => (b.sale.location ?? '').trim()))].sort();
  const delivered = billed.map((b) => locations.get((b.sale.location ?? '').trim().toLowerCase()));
  let place: string;
  let basis: PlPosBasis;
  if (kept && kept.posBasis === 'chosen') {
    place = kept.placeOfSupply;
    basis = 'chosen';
  } else {
    const pos = placeOfSupply({ deliveryStates: delivered.map((l) => l?.stateCode ?? null), buyerGstin, sellerState });
    if ('problem' in pos) return { problem: { code: 'places-differ', states: pos.states } };
    place = pos.stateCode;
    basis = pos.basis;
  }
  const onePlace = names.length === 1 && names[0] !== '';
  const location = onePlace ? locations.get(names[0]!.toLowerCase()) : undefined;
  return {
    header: {
      registrationId: registration.id,
      seller: { legalName: registration.legalName, tradeName: registration.tradeName, gstin: registration.gstin, stateCode: sellerState, address: registration.address },
      buyerName: customer.name,
      buyerGstin,
      buyerAddress: kept?.buyerAddress || customer.address || '',
      shipToName: onePlace ? names[0]! : '',
      shipToAddress: kept?.shipToAddress || location?.address || '',
      placeOfSupply: place,
      posBasis: basis,
      supplyType: supplyType(sellerState, place),
    },
  };
}

function figuresOf(billed: readonly Billed[], supply: 'intra' | 'inter', materials: readonly PlMaterial[], keepIds?: Map<string, InvoiceLineRecord>) {
  const inputs: InvoiceLineInput[] = billed.map((b) => ({
    id: b.sale.id,
    quantity: b.sale.quantity,
    rate: b.sale.rate,
    transport: b.sale.transport ?? null,
    gstRatePct: b.sale.gstRatePct,
    hsnCode: b.sale.hsnCode,
  }));
  const f = invoiceFigures(inputs, supply);
  const lines: InvoiceLineRecord[] = billed.map((b, i) => {
    const x = f.lines[b.sale.id]!;
    const kept = keepIds?.get(b.sale.id);
    return {
      id: kept?.id ?? newId('il'),
      position: kept?.position ?? i,
      tripSaleId: b.sale.id,
      sheetNumber: b.sheet.sheetNumber,
      tripNumber: b.trip.tripNumber,
      tripDate: b.trip.date,
      registrationNumber: b.sheet.registrationNumber,
      challanNumber: b.sale.challanNumber ?? '',
      location: b.sale.location ?? '',
      description: materials.find((m) => m.id === b.sale.materialId)?.name ?? '',
      hsnCode: b.sale.hsnCode ?? '',
      unit: b.sale.unit,
      quantity: b.sale.quantity,
      rate: money(b.sale.rate),
      amount: x.amount,
      transport: x.transport,
      taxable: x.taxable,
      gstRatePct: x.gstRatePct,
      cgst: x.cgst,
      sgst: x.sgst,
      igst: x.igst,
      total: x.total,
    };
  });
  return { lines, totals: { taxable: f.taxable, cgst: f.cgst, sgst: f.sgst, igst: f.igst, roundOff: f.roundOff, total: f.total } };
}

/* ------------------------------------------------------------ the actions */

function find(world: World, id: string): InvoiceRecord | null {
  return world.invoices.find((x) => x.id === id) ?? null;
}

const put = (world: World, rec: InvoiceRecord): World => ({ ...world, invoices: world.invoices.map((x) => (x.id === rec.id ? rec : x)) });

/** A draft for one customer from the sale lines to them on these trips, not yet on a live invoice. */
export function makeDraft(world: World, customerId: string, tripIds: readonly string[], who: Who, at: string): Done {
  const ids = [...new Set(tripIds)];
  if (ids.length === 0) return { ok: false, problem: { code: 'invalid', field: 'tripIds', reason: 'required' } };
  const trips = tripsById(world.sheets);
  for (const [i, id] of tripIds.entries()) {
    if (!trips.has(id)) return { ok: false, problem: { code: 'invalid', field: `tripIds[${i}]`, reason: 'no such trip' } };
  }
  const sites = new Set(ids.map((id) => trips.get(id)!.sheet.siteId));
  if (![...sites].every((siteId) => can(who.grants, INVOICE_WRITE, { siteId }))) return { ok: false, problem: { code: 'needs-permission', permission: INVOICE_WRITE } };
  if (sites.size > 1) return { ok: false, problem: { code: 'trips-other-site' } };
  const siteId = [...sites][0]!;
  const customer = world.parties.find((p) => p.id === customerId);
  if (!customer || !customer.roles.includes('customer')) return { ok: false, problem: { code: 'invalid', field: 'customerId', reason: 'not a customer' } };
  const all: Billed[] = ids
    .flatMap((id) => {
      const { trip, sheet } = trips.get(id)!;
      return trip.sales.filter((s) => s.customerId === customerId).map((sale) => ({ sale, trip, sheet }));
    })
    .sort(listed);
  const live = liveInvoices(world.invoices);
  for (const id of ids) {
    const onTrip = all.filter((b) => b.trip.id === id);
    if (onTrip.length === 0) return { ok: false, problem: { code: 'trip-not-for-customer', tripNumber: trips.get(id)!.trip.tripNumber } };
    // All of a trip's lines on a live invoice: nothing left on it to bill.
    if (onTrip.every((b) => live.has(b.sale.id))) return { ok: false, problem: billable(onTrip[0]!, live)! };
  }
  const billed = all.filter((b) => !live.has(b.sale.id));
  for (const b of billed) {
    const problem = billable(b, live);
    if (problem) return { ok: false, problem };
  }
  const h = header(siteId, customer, billed, null);
  if ('problem' in h) return { ok: false, problem: h.problem };
  const { lines, totals } = figuresOf(billed, h.header.supplyType, world.materials);
  const rec: InvoiceRecord = {
    id: newId('inv'),
    siteId,
    customerId,
    status: 'draft',
    financialYear: null,
    serial: null,
    invoiceNumber: null,
    invoiceDate: null,
    ...h.header,
    ...totals,
    notes: '',
    createdBy: who.name,
    createdAt: at,
    issuedBy: null,
    issuedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    lines,
  };
  return { ok: true, world: { ...world, invoices: [...world.invoices, rec] }, id: rec.id };
}

/** A draft, worked out again as of now (lines keep their places); what it was told by hand stays. */
function refigure(world: World, rec: InvoiceRecord, kept: Kept): { rec: InvoiceRecord } | { problem: InvoiceProblem } {
  const sales = salesById(world.sheets);
  const billed = rec.lines.map((l) => (l.tripSaleId ? sales.get(l.tripSaleId) : undefined)).filter((b): b is Billed => Boolean(b));
  const customer = world.parties.find((p) => p.id === rec.customerId);
  if (!customer || billed.length !== rec.lines.length) return { problem: { code: 'invoice-gone' } };
  const h = header(rec.siteId, customer, billed, kept);
  if ('problem' in h) return { problem: h.problem };
  const { lines, totals } = figuresOf(billed, h.header.supplyType, world.materials, new Map(rec.lines.map((l) => [l.tripSaleId ?? '', l])));
  return { rec: { ...rec, ...h.header, ...totals, lines: [...lines].sort((a, b) => a.position - b.position) } };
}

function draftToChange(world: World, id: string, who: Who): { rec: InvoiceRecord } | { problem: InvoiceProblem } {
  const rec = find(world, id);
  if (!rec) return { problem: { code: 'invoice-gone' } };
  if (!can(who.grants, INVOICE_WRITE, { siteId: rec.siteId })) return { problem: { code: 'needs-permission', permission: INVOICE_WRITE } };
  if (rec.status !== 'draft') return { problem: { code: 'not-a-draft', status: rec.status, invoiceNumber: rec.invoiceNumber } };
  return { rec };
}

export function patchDraft(world: World, id: string, patch: PlInvoicePatch, who: Who): Done {
  const got = draftToChange(world, id, who);
  if ('problem' in got) return { ok: false, problem: got.problem };
  if (patch.placeOfSupply !== undefined && !(patch.placeOfSupply in GST_STATES)) {
    return { ok: false, problem: { code: 'invalid', field: 'placeOfSupply', reason: 'not a state' } };
  }
  const was = keptOf(got.rec);
  const kept: Kept = {
    placeOfSupply: patch.placeOfSupply ?? was.placeOfSupply,
    posBasis: patch.placeOfSupply !== undefined ? 'chosen' : was.posBasis,
    buyerAddress: patch.buyerAddress !== undefined ? patch.buyerAddress.trim() : was.buyerAddress,
    shipToAddress: patch.shipToAddress !== undefined ? patch.shipToAddress.trim() : was.shipToAddress,
  };
  const again = refigure(world, got.rec, kept);
  if ('problem' in again) return { ok: false, problem: again.problem };
  const rec = { ...again.rec, notes: patch.notes !== undefined ? patch.notes.trim() : got.rec.notes };
  return { ok: true, world: put(world, rec), id };
}

export function deleteDraft(world: World, id: string, who: Who): Done {
  const got = draftToChange(world, id, who);
  if ('problem' in got) return { ok: false, problem: got.problem };
  return { ok: true, world: { ...world, invoices: world.invoices.filter((x) => x.id !== id) }, id };
}

/** Take the next number of the seller's series for `day`'s financial year; then match money paid on its trips. */
export function issueDraft(world: World, id: string, who: Who, day: string, at: string): Done {
  const got = draftToChange(world, id, who);
  if ('problem' in got) return { ok: false, problem: got.problem };
  const again = refigure(world, got.rec, keptOf(got.rec));
  if ('problem' in again) return { ok: false, problem: again.problem };
  const year = fy(day);
  const key = `${again.rec.registrationId}:${year}`;
  const serial = (world.series[key] ?? 0) + 1;
  const prefix = sellerOfSite(again.rec.siteId)?.prefix ?? 'INV';
  const number = invoiceNumber(prefix, year, serial);
  if (!isInvoiceNumber(number)) return { ok: false, problem: { code: 'series-full', gstin: again.rec.seller.gstin, financialYear: year } };
  const rec: InvoiceRecord = { ...again.rec, status: 'issued', financialYear: year, serial, invoiceNumber: number, invoiceDate: day, issuedBy: who.name, issuedAt: at };
  const issued = { ...put(world, rec), series: { ...world.series, [key]: serial } };
  return { ok: true, world: matchAll(issued, rec, who, at), id };
}

export function cancelInvoice(world: World, id: string, reason: string, who: Who, at: string): Done {
  const rec = find(world, id);
  if (!rec) return { ok: false, problem: { code: 'invoice-gone' } };
  if (!can(who.grants, INVOICE_CANCEL, { siteId: rec.siteId })) return { ok: false, problem: { code: 'needs-permission', permission: INVOICE_CANCEL } };
  if (!reason.trim() || reason.trim().length > 200) return { ok: false, problem: { code: 'invalid', field: 'reason', reason: 'required' } };
  if (rec.status === 'draft') return { ok: false, problem: { code: 'not-issued', status: 'draft' } };
  if (rec.status === 'cancelled') return { ok: false, problem: { code: 'already-cancelled', invoiceNumber: rec.invoiceNumber } };
  const cancelled: InvoiceRecord = { ...rec, status: 'cancelled', cancelledBy: who.name, cancelledAt: at, cancelReason: reason.trim() };
  // The money matched to it goes back, to be matched to whatever replaces it.
  return { ok: true, world: { ...put(world, cancelled), receipts: world.receipts.filter((r) => r.invoiceId !== id) }, id };
}

/* --------------------------------------------------------- money received */

interface Candidate {
  paymentId: string;
  onTrip: boolean;
  paidOn: string;
  amount: string;
  free: string;
  mode: PlInvoiceUnmatched['mode'];
  reference: string | null;
  sheet: PlSheetRecord;
  trip: PlTripRecord | null;
}

function takenOf(receipts: readonly ReceiptRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of receipts) out.set(r.paymentId, add(out.get(r.paymentId) ?? '0', r.amount));
  return out;
}

/** The customer's payments on the invoice's trips (and on their sheets), and what of each no invoice has taken. */
function candidates(world: World, rec: InvoiceRecord): Candidate[] {
  const sales = salesById(world.sheets);
  const trips = new Map<string, Billed>();
  for (const line of rec.lines) {
    const b = line.tripSaleId ? sales.get(line.tripSaleId) : undefined;
    if (b) trips.set(b.trip.id, b);
  }
  const sheets = new Map([...trips.values()].map((b) => [b.sheet.id, b.sheet]));
  const taken = takenOf(world.receipts);
  const out: Candidate[] = [];
  const consider = (m: PlSheetRecord['payments'][number], sheet: PlSheetRecord, trip: PlTripRecord | null) => {
    if (m.direction !== 'in' || m.partyId !== rec.customerId) return;
    const left = money(decimal.toFixed(decimal.sub(decimal.dec(m.amount), decimal.dec(taken.get(m.id) ?? '0')), 2));
    out.push({ paymentId: m.id, onTrip: trip !== null, paidOn: m.paidOn, amount: money(m.amount), free: left, mode: m.mode, reference: m.reference ?? null, sheet, trip });
  };
  for (const sheet of sheets.values()) for (const m of sheet.payments) consider(m, sheet, null);
  for (const b of trips.values()) for (const m of b.trip.payments) consider(m, b.sheet, b.trip);
  return out.sort((a, b) => Number(b.onTrip) - Number(a.onTrip) || byKey(a.paidOn, b.paidOn) || byKey(a.paymentId, b.paymentId));
}

const receivedOf = (world: World, id: string) => sumOf(world.receipts.filter((r) => r.invoiceId === id).map((r) => r.amount));

function addMatches(world: World, rec: InvoiceRecord, matches: { paymentId: string; amount: string }[], who: Who, at: string): World {
  let receipts = [...world.receipts];
  for (const m of matches) {
    const held = receipts.find((r) => r.invoiceId === rec.id && r.paymentId === m.paymentId);
    receipts = held
      ? receipts.map((r) => (r === held ? { ...r, amount: add(r.amount, m.amount) } : r))
      : [...receipts, { id: newId('rcpt'), invoiceId: rec.id, paymentId: m.paymentId, amount: m.amount, matchedBy: who.name, matchedAt: at }];
  }
  return { ...world, receipts };
}

function matchAll(world: World, rec: InvoiceRecord, who: Who, at: string): World {
  const due = invoiceDue(rec.total, receivedOf(world, rec.id));
  const matches = matchReceipts(
    due,
    candidates(world, rec).map((c) => ({ paymentId: c.paymentId, onTrip: c.onTrip, paidOn: c.paidOn, free: c.free })),
  );
  return addMatches(world, rec, matches, who, at);
}

function issuedToReceive(world: World, id: string, who: Who): { rec: InvoiceRecord } | { problem: InvoiceProblem } {
  const rec = find(world, id);
  if (!rec) return { problem: { code: 'invoice-gone' } };
  if (!can(who.grants, RECEIVE, { siteId: rec.siteId })) return { problem: { code: 'needs-permission', permission: RECEIVE } };
  if (rec.status !== 'issued') return { problem: { code: 'not-issued', status: rec.status } };
  return { rec };
}

/** Every payment by the rule, or one, up to `amount`. */
export function matchMoney(world: World, id: string, body: { paymentId?: string | null; amount?: string | null }, who: Who, at: string): Done {
  const got = issuedToReceive(world, id, who);
  if ('problem' in got) return { ok: false, problem: got.problem };
  if (!body.paymentId) return { ok: true, world: matchAll(world, got.rec, who, at), id };
  const c = candidates(world, got.rec).find((x) => x.paymentId === body.paymentId);
  if (!c) return { ok: false, problem: { code: 'invalid', field: 'paymentId', reason: 'not a payment from this customer on these trips' } };
  const due = invoiceDue(got.rec.total, receivedOf(world, id));
  if (!positive(c.free)) return { ok: false, problem: { code: 'payment-matched' } };
  if (!positive(due)) return { ok: false, problem: { code: 'invoice-paid' } };
  // As the API: a typed amount of zero is refused in words, before "too much" is looked at.
  if (body.amount && !positive(money(body.amount))) return { ok: false, problem: { code: 'invalid', field: 'amount', reason: 'more than zero' } };
  const less = decimal.cmp(decimal.dec(c.free), decimal.dec(due)) < 0 ? c.free : due;
  const take = body.amount ? money(body.amount) : less;
  if (!positive(take) || decimal.cmp(decimal.dec(take), decimal.dec(less)) > 0) return { ok: false, problem: { code: 'too-much', free: c.free, due } };
  return { ok: true, world: addMatches(world, got.rec, [{ paymentId: c.paymentId, amount: take }], who, at), id };
}

export function unmatchMoney(world: World, id: string, receiptId: string, who: Who): Done {
  const got = issuedToReceive(world, id, who);
  if ('problem' in got) return { ok: false, problem: got.problem };
  if (!world.receipts.some((r) => r.id === receiptId && r.invoiceId === id)) return { ok: false, problem: { code: 'receipt-gone' } };
  return { ok: true, world: { ...world, receipts: world.receipts.filter((r) => r.id !== receiptId) }, id };
}

/* ------------------------------------------------------- the trip sheet */

/** The sale line's fields an invoice bills by or prints, as stored, for comparing a save with. */
function billedFields(s: { customerId: string; location?: string | null; materialId: string; hsnCode?: string | null; unit?: string | null; quantity: number; rate: string; transport?: string | null; gstBilled: boolean; gstRatePct?: number | null; challanNumber?: string; invoiceNumber?: string }, materials: readonly PlMaterial[]): string {
  const m = materials.find((x) => x.id === s.materialId);
  return JSON.stringify([
    s.customerId,
    (s.location ?? '').trim(),
    s.materialId,
    s.hsnCode || m?.hsnCode || null,
    s.unit || m?.unit || 'unit',
    decimal.toPlain(decimal.dec(s.quantity)),
    money(s.rate),
    money(s.transport),
    s.gstBilled,
    s.gstBilled ? decimal.toPlain(decimal.dec(s.gstRatePct ?? m?.gstRatePct ?? 0)) : '0',
    (s.challanNumber ?? '').trim(),
    (s.invoiceNumber ?? '').trim(),
  ]);
}

/** A save that would change or remove a sale line a live invoice bills, refused as the API refuses it. */
export function checkSheet(world: World, input: PlSheetInput, existing: PlSheetRecord | null): PlProblem | null {
  if (!existing) return null;
  const live = liveInvoices(world.invoices);
  const kept = new Map<string, { where: string; tripId: string | null | undefined; line: PlSheetInput['trips'][number]['sales'][number] }>();
  input.trips.forEach((t, ti) => t.sales.forEach((s, i) => s.id && kept.set(s.id, { where: `trips[${ti}].sales[${i}]`, tripId: t.id, line: s })));
  const trips = [...existing.trips].sort((a, b) => byKey(a.tripNumber, b.tripNumber));
  for (const trip of trips) {
    for (const sale of trip.sales) {
      const on = live.get(sale.id);
      if (!on) continue;
      const problem = { code: 'sale-invoiced' as const, tripNumber: trip.tripNumber, ...ref(on) };
      if (input.siteId !== existing.siteId) return { ...problem, field: 'siteId' };
      const now = kept.get(sale.id);
      if (!now) return problem;
      if (now.tripId !== trip.id || billedFields(now.line, world.materials) !== billedFields(sale, world.materials)) return { ...problem, field: now.where };
    }
  }
  return null;
}

/** After a save: what payments changed or removed had matched goes; cancelled invoices let go of removed lines. */
function afterSave(world: World, before: PlSheetRecord | null, after: PlSheetRecord | null): World {
  if (!before) return world;
  const now = new Map<string, { tripId: string | null; m: PlSheetRecord['payments'][number] }>();
  if (after) {
    for (const m of after.payments) now.set(m.id, { tripId: null, m });
    for (const t of after.trips) for (const m of t.payments) now.set(m.id, { tripId: t.id, m });
  }
  const changed = new Set<string>();
  const old = [...before.payments.map((m) => ({ tripId: null as string | null, m })), ...before.trips.flatMap((t) => t.payments.map((m) => ({ tripId: t.id as string | null, m })))];
  for (const o of old) {
    const n = now.get(o.m.id);
    if (!n || n.tripId !== o.tripId || n.m.partyId !== o.m.partyId || n.m.direction !== o.m.direction || money(n.m.amount) !== money(o.m.amount)) changed.add(o.m.id);
  }
  const remaining = new Set(after ? after.trips.flatMap((t) => t.sales.map((s) => s.id)) : []);
  const gone = new Set(before.trips.flatMap((t) => t.sales.map((s) => s.id)).filter((id) => !remaining.has(id)));
  return {
    ...world,
    receipts: world.receipts.filter((r) => !changed.has(r.paymentId)),
    invoices: world.invoices.map((inv) =>
      inv.status === 'cancelled' && inv.lines.some((l) => l.tripSaleId && gone.has(l.tripSaleId))
        ? { ...inv, lines: inv.lines.map((l) => (l.tripSaleId && gone.has(l.tripSaleId) ? { ...l, tripSaleId: null } : l)) }
        : inv,
    ),
  };
}

/* ------------------------------------------------------------- the wire */

function rowOf(rec: InvoiceRecord, received: string): PlInvoiceRow {
  const issued = rec.status === 'issued';
  return {
    id: rec.id,
    status: rec.status,
    invoiceNumber: rec.invoiceNumber,
    invoiceDate: rec.invoiceDate,
    financialYear: rec.financialYear,
    siteId: rec.siteId,
    customerId: rec.customerId,
    buyerName: rec.buyerName,
    buyerGstin: rec.buyerGstin,
    kind: invoiceKind(rec.buyerGstin),
    sellerGstin: rec.seller.gstin,
    placeOfSupply: rec.placeOfSupply,
    supplyType: rec.supplyType,
    tripNumbers: [...new Set(rec.lines.map((l) => l.tripNumber))],
    lineCount: rec.lines.length,
    taxable: rec.taxable,
    tax: sumOf([rec.cgst, rec.sgst, rec.igst]),
    total: rec.total,
    received: issued ? received : '0.00',
    due: issued ? invoiceDue(rec.total, received) : '0.00',
    moneyStatus: issued ? moneyStatus(rec.total, received) : null,
    createdBy: rec.createdBy,
    createdAt: rec.createdAt,
    issuedAt: rec.issuedAt,
    cancelledAt: rec.cancelledAt,
  };
}

export function receiptsOf(world: World, rec: InvoiceRecord): PlInvoiceReceipts {
  const mine = world.receipts.filter((r) => r.invoiceId === rec.id);
  const received = sumOf(mine.map((r) => r.amount));
  const row = rowOf(rec, received);
  const payments = new Map<string, { m: PlSheetRecord['payments'][number]; sheet: PlSheetRecord; trip: PlTripRecord | null }>();
  for (const sheet of world.sheets) {
    for (const m of sheet.payments) payments.set(m.id, { m, sheet, trip: null });
    for (const t of sheet.trips) for (const m of t.payments) payments.set(m.id, { m, sheet, trip: t });
  }
  const receipts: PlInvoiceReceipt[] = mine
    .map((r) => ({ r, p: payments.get(r.paymentId) }))
    .filter((x): x is { r: ReceiptRecord; p: NonNullable<typeof x.p> } => Boolean(x.p))
    .sort((a, b) => byKey(a.r.matchedAt, b.r.matchedAt) || Number(a.p.trip === null) - Number(b.p.trip === null) || byKey(a.p.m.paidOn, b.p.m.paidOn) || byKey(a.r.paymentId, b.r.paymentId))
    .map(({ r, p }) => ({
      id: r.id,
      paymentId: r.paymentId,
      paidOn: p.m.paidOn,
      mode: p.m.mode,
      reference: p.m.reference ?? null,
      sheetId: p.sheet.id,
      sheetNumber: p.sheet.sheetNumber,
      tripNumber: p.trip?.tripNumber ?? null,
      paymentAmount: money(p.m.amount),
      amount: r.amount,
      matchedBy: r.matchedBy,
      matchedAt: r.matchedAt,
    }));
  const unmatched: PlInvoiceUnmatched[] =
    rec.status === 'issued'
      ? candidates(world, rec)
          .filter((c) => positive(c.free))
          .map((c) => ({
            paymentId: c.paymentId,
            paidOn: c.paidOn,
            mode: c.mode,
            reference: c.reference,
            sheetId: c.sheet.id,
            sheetNumber: c.sheet.sheetNumber,
            tripNumber: c.trip?.tripNumber ?? null,
            onTrip: c.onTrip,
            paymentAmount: c.amount,
            free: c.free,
          }))
      : [];
  return { invoiceId: rec.id, total: rec.total, received: row.received, due: row.due, moneyStatus: row.moneyStatus, receipts, unmatched };
}

function taxRows(rec: InvoiceRecord): PlTaxRow[] {
  const rows = new Map<string, PlTaxRow>();
  for (const l of rec.lines) {
    const key = `${l.hsnCode}|${money(l.gstRatePct)}`;
    const r = rows.get(key) ?? { hsnCode: l.hsnCode || null, gstRatePct: l.gstRatePct, taxable: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', tax: '0.00' };
    rows.set(key, {
      ...r,
      taxable: add(r.taxable, l.taxable),
      cgst: add(r.cgst, l.cgst),
      sgst: add(r.sgst, l.sgst),
      igst: add(r.igst, l.igst),
      tax: sumOf([r.tax, l.cgst, l.sgst, l.igst]),
    });
  }
  return [...rows.values()].sort((a, b) => byKey(a.hsnCode ?? '', b.hsnCode ?? '') || a.gstRatePct - b.gstRatePct);
}

export function invoiceDetail(world: World, rec: InvoiceRecord): PlInvoiceDetail {
  const money_ = receiptsOf(world, rec);
  const sales = salesById(world.sheets);
  const half = (pct: number) => decimal.toNumber(decimal.mul(decimal.dec(pct), decimal.dec('0.5')));
  return {
    ...rowOf(rec, money_.received === '0.00' && rec.status !== 'issued' ? '0.00' : money_.received),
    seller: rec.seller,
    buyer: { partyId: rec.customerId, name: rec.buyerName, gstin: rec.buyerGstin, stateCode: stateOfGstin(rec.buyerGstin), address: rec.buyerAddress },
    shipTo: rec.shipToName || rec.shipToAddress ? { name: rec.shipToName, address: rec.shipToAddress } : null,
    posBasis: rec.posBasis,
    lines: [...rec.lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => {
        const b = l.tripSaleId ? sales.get(l.tripSaleId) : undefined;
        const intra = rec.supplyType === 'intra';
        return { ...l, tripId: b?.trip.id ?? null, sheetId: b?.sheet.id ?? null, cgstPct: intra ? half(l.gstRatePct) : 0, sgstPct: intra ? half(l.gstRatePct) : 0, igstPct: intra ? 0 : l.gstRatePct };
      }),
    byHsn: taxRows(rec),
    cgst: rec.cgst,
    sgst: rec.sgst,
    igst: rec.igst,
    beforeRounding: money(decimal.toFixed(decimal.sub(decimal.dec(rec.total), decimal.dec(rec.roundOff)), 2)),
    roundOff: rec.roundOff,
    words: amountInWords(rec.total),
    notes: rec.notes,
    issuedBy: rec.issuedBy,
    cancelledBy: rec.cancelledBy,
    cancelReason: rec.cancelReason,
    irn: null,
    irnAckNumber: null,
    irnAckDate: null,
    receipts: money_.receipts,
    unmatched: money_.unmatched,
  };
}

export interface InvoiceFilter {
  status?: PlInvoiceStatus | null;
  money?: 'due' | 'paid' | null;
  customerId?: string | null;
  siteId?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
}

const needleIn = (words: readonly (string | null | undefined)[], q: string | null | undefined) => {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle) return true;
  const plate = needle.replace(/\s+/g, '');
  return words.some((w) => {
    const x = (w ?? '').toLowerCase();
    return x.includes(needle) || x.replace(/\s+/g, '').includes(plate);
  });
};

/** The invoices at the sites this person reads, that match: drafts first, then the latest issued. */
export function listInvoices(world: World, grants: Grants, f: InvoiceFilter): PlInvoiceList {
  const day = (r: InvoiceRecord) => r.invoiceDate ?? r.createdAt.slice(0, 10);
  const rows = world.invoices
    .filter((r) => can(grants, INVOICE_READ, { siteId: r.siteId }))
    .filter((r) => !f.status || r.status === f.status)
    .filter((r) => !f.customerId || r.customerId === f.customerId)
    .filter((r) => !f.siteId || r.siteId === f.siteId)
    .filter((r) => (!f.from || day(r) >= f.from) && (!f.to || day(r) <= f.to))
    .filter((r) => needleIn([r.invoiceNumber, r.buyerName, r.buyerGstin, ...r.lines.flatMap((l) => [l.tripNumber, l.sheetNumber, l.challanNumber, l.description, l.registrationNumber])], f.q))
    .map((r) => rowOf(r, receivedOf(world, r.id)))
    .filter((r) => !f.money || (r.status === 'issued' && (f.money === 'paid' ? r.moneyStatus === 'paid' : r.moneyStatus !== 'paid')))
    .sort(
      (a, b) =>
        Number(b.status === 'draft') - Number(a.status === 'draft') ||
        byKey(b.invoiceDate ?? '9999', a.invoiceDate ?? '9999') ||
        byKey(b.invoiceNumber ?? '', a.invoiceNumber ?? '') ||
        byKey(b.createdAt, a.createdAt),
    );
  const issued = rows.filter((r) => r.status === 'issued');
  return {
    rows,
    total: { invoices: rows.length, total: sumOf(issued.map((r) => r.total)), received: sumOf(issued.map((r) => r.received)), due: sumOf(issued.map((r) => r.due)) },
  };
}

export interface TripFilter {
  customerId?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  sheetId?: string | null;
}

/** Each trip's sale lines to each customer that no live invoice bills yet, the latest first. */
export function tripsToInvoice(world: World, grants: Grants, f: TripFilter): PlInvoiceTripRow[] {
  const live = liveInvoices(world.invoices);
  const parties = new Map(world.parties.map((p) => [p.id, p]));
  const out: PlInvoiceTripRow[] = [];
  for (const sheet of world.sheets) {
    if (!can(grants, INVOICE_READ, { siteId: sheet.siteId })) continue;
    if (f.sheetId && sheet.id !== f.sheetId) continue;
    for (const trip of sheet.trips) {
      if ((f.from && trip.date < f.from) || (f.to && trip.date > f.to)) continue;
      const byCustomer = new Map<string, PlSaleRecord[]>();
      for (const s of trip.sales) if (!live.has(s.id)) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
      for (const [customerId, sales] of byCustomer) {
        if (f.customerId && customerId !== f.customerId) continue;
        const party = parties.get(customerId);
        const materials = [...new Set(sales.map((s) => world.materials.find((m) => m.id === s.materialId)?.name ?? ''))].filter(Boolean);
        if (!needleIn([trip.tripNumber, sheet.sheetNumber, sheet.registrationNumber, party?.name, ...sales.flatMap((s) => [s.challanNumber, s.location])], f.q)) continue;
        const figures = sales.map((s) => saleFigures({ id: s.id, customerId: s.customerId, quantity: s.quantity, rate: s.rate, transport: s.transport ?? null, gstBilled: s.gstBilled, gstRatePct: s.gstRatePct }));
        const blocked = sales.some((s) => !s.gstBilled) ? 'not-gst' : sales.some((s) => (s.invoiceNumber ?? '').trim()) ? 'billed-outside' : sales.some((s) => !s.hsnCode) ? 'no-hsn' : null;
        out.push({
          tripId: trip.id,
          tripNumber: trip.tripNumber,
          tripDate: trip.date,
          sheetId: sheet.id,
          sheetNumber: sheet.sheetNumber,
          siteId: sheet.siteId,
          registrationNumber: sheet.registrationNumber,
          customerId,
          customerName: party?.name ?? '',
          customerGstin: sales.find((s) => s.partyGstin)?.partyGstin ?? party?.gstin ?? null,
          materials,
          lineCount: sales.length,
          taxable: sumOf(figures.map((x) => x.taxable)),
          total: sumOf(figures.map((x) => x.total)),
          blocked,
          outsideInvoiceNumber: sales.find((s) => (s.invoiceNumber ?? '').trim())?.invoiceNumber ?? '',
        });
      }
    }
  }
  return out.sort((a, b) => byKey(b.tripDate, a.tripDate) || byKey(b.tripNumber, a.tripNumber) || byKey(a.customerName, b.customerName));
}

/* --------------------------------------------------------------- the store */

interface InvoiceState {
  invoices: InvoiceRecord[];
  receipts: ReceiptRecord[];
  series: Record<string, number>;
  make(customerId: string, tripIds: readonly string[], who: Who): InvoiceResult;
  patch(id: string, patch: PlInvoicePatch, who: Who): InvoiceResult;
  issue(id: string, who: Who): InvoiceResult;
  cancel(id: string, reason: string, who: Who): InvoiceResult;
  remove(id: string, who: Who): InvoiceResult;
  match(id: string, body: { paymentId?: string | null; amount?: string | null }, who: Who): InvoiceResult;
  unmatch(id: string, receiptId: string, who: Who): InvoiceResult;
}

function worldOf(state: Pick<InvoiceState, 'invoices' | 'receipts' | 'series'>): World {
  const pl = usePl.getState();
  return { sheets: pl.sheets, parties: pl.parties, materials: pl.materials, invoices: state.invoices, receipts: state.receipts, series: state.series };
}

/** Now on the demo's clock: the day the demo stands on (NOW), moving as the page stays open, so an invoice issued today is issued on its own date. */
const OPENED = Date.now();
const nowIso = () => new Date(NOW.getTime() + (Date.now() - OPENED)).toISOString();

/* The demo's invoices: made from the trip sheets by the same rules, as accounts would have made them. */

const SEED_WHO: Who = {
  name: 'Lakshmi N',
  grants: Object.fromEntries([INVOICE_READ, INVOICE_WRITE, INVOICE_CANCEL, RECEIVE].map((k) => [k, { orgWide: true, siteIds: [] }])),
};
const DAY = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
/** Monday-based week of a day: the trips a builder is billed for together. */
const weekOf = (day: string) => Math.floor((Date.parse(`${day}T00:00:00Z`) / DAY + 3) / 7);

function seed(): Pick<InvoiceState, 'invoices' | 'receipts' | 'series'> {
  const pl = usePl.getState();
  let world: World = { sheets: pl.sheets, parties: pl.parties, materials: pl.materials, invoices: [], receipts: [], series: {} };
  const today = todayIso();
  const billedBy = addDays(today, -18);
  // Older trips are billed weekly, per site and customer; the last weeks wait to be invoiced.
  const groups = new Map<string, { customerId: string; tripIds: Set<string>; last: string }>();
  for (const sheet of world.sheets) {
    for (const trip of sheet.trips) {
      if (trip.date > billedBy) continue;
      for (const s of trip.sales) {
        if (!s.gstBilled || (s.invoiceNumber ?? '').trim() || !s.hsnCode) continue;
        const key = `${sheet.siteId}|${s.customerId}|${weekOf(trip.date)}`;
        const g = groups.get(key) ?? { customerId: s.customerId, tripIds: new Set<string>(), last: trip.date };
        g.tripIds.add(trip.id);
        if (trip.date > g.last) g.last = trip.date;
        groups.set(key, g);
      }
    }
  }
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => byKey(a.last, b.last) || byKey(ka, kb));
  // One went out at the wrong rate: cancelled the next day and billed again, in its turn, so
  // each series' numbers still run in date order.
  let wrong: { id: string; tripIds: string[]; customerId: string; day: string } | null = null;
  const rebill = (w: { id: string; tripIds: string[]; customerId: string; day: string }) => {
    const cancelled = cancelInvoice(world, w.id, 'Wrong rate on the DC', SEED_WHO, at(w.day, '09:40'));
    if (!cancelled.ok) return;
    world = cancelled.world;
    const again = makeDraft(world, w.customerId, w.tripIds, SEED_WHO, at(w.day, '09:45'));
    if (!again.ok) return;
    const reissued = issueDraft(again.world, again.id, SEED_WHO, w.day, at(w.day, '09:50'));
    if (reissued.ok) world = reissued.world;
  };
  let made = 0;
  for (const [, g] of ordered) {
    const day = addDays(g.last, 2) > today ? today : addDays(g.last, 2);
    if (wrong && wrong.day <= day) {
      rebill(wrong);
      wrong = null;
    }
    const tripIds = [...g.tripIds];
    const draft = makeDraft(world, g.customerId, tripIds, SEED_WHO, at(day, '10:15'));
    if (!draft.ok) continue;
    const issued = issueDraft(draft.world, draft.id, SEED_WHO, day, at(day, '10:20'));
    if (!issued.ok) continue;
    world = issued.world;
    made += 1;
    if (made === 3) wrong = { id: draft.id, tripIds, customerId: g.customerId, day: addDays(day, 1) };
  }
  if (wrong) rebill(wrong);
  // And one draft waiting to be issued: the latest load of the first builder.
  const latest = tripsToInvoice(world, SEED_WHO.grants, {}).find((r) => r.customerId === 'cus-01' && !r.blocked);
  if (latest) {
    const draft = makeDraft(world, latest.customerId, [latest.tripId], { ...SEED_WHO, name: 'Anbu Selvan M' }, at(today, '09:05'));
    if (draft.ok) world = draft.world;
  }
  return { invoices: [...world.invoices], receipts: [...world.receipts], series: { ...world.series } };
}

export const useInvoices = create<InvoiceState>((set, get) => {
  const apply = (done: Done): InvoiceResult => {
    if (!done.ok) return done;
    set({ invoices: [...done.world.invoices], receipts: [...done.world.receipts], series: { ...done.world.series } });
    return { ok: true, id: done.id };
  };
  return {
    ...seed(),
    make: (customerId, tripIds, who) => apply(makeDraft(worldOf(get()), customerId, tripIds, who, nowIso())),
    patch: (id, patch, who) => apply(patchDraft(worldOf(get()), id, patch, who)),
    issue: (id, who) => apply(issueDraft(worldOf(get()), id, who, todayIso(), nowIso())),
    cancel: (id, reason, who) => apply(cancelInvoice(worldOf(get()), id, reason, who, nowIso())),
    remove: (id, who) => apply(deleteDraft(worldOf(get()), id, who)),
    match: (id, body, who) => apply(matchMoney(worldOf(get()), id, body, who, nowIso())),
    unmatch: (id, receiptId, who) => apply(unmatchMoney(worldOf(get()), id, receiptId, who)),
  };
});

// The trip sheets' save and delete answer to the invoices made from them.
guardSheets({
  check: (input, existing) => checkSheet(worldOf(useInvoices.getState()), input, existing),
  saved: (before, after) => {
    const next = afterSave(worldOf(useInvoices.getState()), before, after);
    useInvoices.setState({ invoices: [...next.invoices], receipts: [...next.receipts] });
  },
  removing: (sheet) => {
    const problem = checkSheet(worldOf(useInvoices.getState()), { ...sheetInputOf(sheet), trips: [] }, sheet);
    if (problem) return problem;
    const next = afterSave(worldOf(useInvoices.getState()), sheet, null);
    useInvoices.setState({ invoices: [...next.invoices], receipts: [...next.receipts] });
    return null;
  },
});

function sheetInputOf(sheet: PlSheetRecord): PlSheetInput {
  return { siteId: sheet.siteId, vehicleId: sheet.vehicleId, registrationNumber: sheet.registrationNumber, startDate: sheet.startDate, trips: [] };
}

/** The rules' world as it stands, for the screens. */
export function useInvoiceWorld(): World {
  const sheets = usePl((s) => s.sheets);
  const parties = usePl((s) => s.parties);
  const materials = usePl((s) => s.materials);
  const invoices = useInvoices((s) => s.invoices);
  const receipts = useInvoices((s) => s.receipts);
  const series = useInvoices((s) => s.series);
  return useMemo(() => ({ sheets, parties, materials, invoices, receipts, series }), [sheets, parties, materials, invoices, receipts, series]);
}
