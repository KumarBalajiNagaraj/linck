import { sumPl, type DieselFigures, type PartyDue, type PlTotals, type SheetCalc } from '@linck/domain';
import type {
  PlAttachment,
  PlDieselBillOption,
  PlDieselOut,
  PlDieselRecord,
  PlEnRouteOut,
  PlEnRouteRecord,
  PlGstRate,
  PlMasters,
  PlMaterial,
  PlMonthRow,
  PlOutstandingRow,
  PlOutstandingTotal,
  PlParty,
  PlPartyDue,
  PlPartyRole,
  PlPaymentOut,
  PlPaymentRecord,
  PlReport,
  PlSaleInvoice,
  PlSheetDetail,
  PlSheetInput,
  PlSheetRecord,
  PlSheetRow,
  PlTripOut,
  PlTripRecord,
  PlTripReportRow,
  PlVehicleRow,
} from '@linck/mock';
import { API_BASE, apiFetch } from '../../auth/api.js';
import { throughApi } from '../expenses/expenseApi.js';
import type { PlProblem } from './plStore.js';

/**
 * THE VEHICLE P&L ON THE API, for live mode (VITE_API_URL set).
 *
 *   GET    /vehicle-pl/sheets                            trip sheets, searched, with their total
 *   POST   /vehicle-pl/sheets                            a new sheet, its trips and lines
 *   GET    /vehicle-pl/sheets/{id}                       one sheet, every line, every figure
 *   PUT    /vehicle-pl/sheets/{id}                       the sheet as the page holds it now
 *   DELETE /vehicle-pl/sheets/{id}
 *   POST   /vehicle-pl/sheets/{id}/trips/{tripId}/close  accounts: a customer paid the trip in full
 *   DELETE /vehicle-pl/sheets/{id}/trips/{tripId}/close  …taken back
 *   GET    /vehicle-pl/masters                           vendors, customers, materials, GST rates
 *   POST   /vehicle-pl/parties, PATCH /parties/{id}, POST /parties/{id}/locations
 *   POST   /vehicle-pl/materials, POST /vehicle-pl/gst-rates
 *   GET    /vehicle-pl/diesel-bills?vehicleId=           the vehicle's diesel bills a sheet may link
 *   POST   /vehicle-pl/attachments                       a photo of a trip's paper ──▶ its id
 *   GET    /vehicle-pl/reports/{trips,vehicles,months,customers,vendors}
 *
 * (apps/api/app/api/vehicle_pl.py, schemas/vehicle_pl.py.) The demo store
 * (plStore.ts) is shaped field for field like these answers — apiShapes.test.ts
 * holds the two together — so the screens read one shape in both modes. Two
 * things change on the way in: a photo's address, which the API gives
 * relative to itself and which must go through the API's base like every
 * other request (never a bare `/vehicle-pl/...` path, which is this app's own
 * origin); and, for the trip sheet's page, the sheet as the form edits it
 * (`recordOf`) and its figures as the page draws them (`calcOf`) — the
 * server's own, worked out by app/domain/vehicle_pl.py.
 *
 * The API applies the rules and decides. Every way a request can fail comes
 * back as a PlProblem, the demo store's own vocabulary, so the page words a
 * live refusal as it words the demo's. No React here: the tests call these.
 */

/* --------------------------------------------------------------- refusals */

/** One value FastAPI's own check of a request turned down: where it is, as the page names fields, and why. */
export interface ShapeError {
  field: string;
  /** The validator's own reason ("must be more than zero"), 'required' for a missing or blank value, else ''. */
  reason: string;
}

/** A refusal as it came back, before a vocabulary is put on it. */
export interface Refusal {
  /** The HTTP status; 0 when the API did not answer at all. */
  status: number;
  /** The API's own problem, `{"detail": {"problem": {"code": ...}}}`, when it gave one. */
  problem: Record<string, unknown> | null;
  /** FastAPI's own check of the request's shape, when that is what refused it. */
  shape: ShapeError[] | null;
}

/** A loc segment that names a type pydantic tried, not a field: `float`, `function-after[…]`. */
const TAG = /^(float|int|str|bool|none|uuid|date|datetime)$|[[\]()]/;

/** ["body", "trips", 0, "purchases", 1, "rate"] → "trips[0].purchases[1].rate", as the page names a field. */
export function fieldOf(loc: unknown): string {
  if (!Array.isArray(loc)) return '';
  const parts = ['body', 'query', 'path'].includes(loc[0] as string) ? loc.slice(1) : loc;
  let path = '';
  for (const part of parts) {
    if (typeof part === 'number') path += `[${part}]`;
    else if (typeof part === 'string' && !TAG.test(part)) path = path ? `${path}.${part}` : part;
  }
  return path;
}

function shapeError(item: unknown): ShapeError {
  const e = (item && typeof item === 'object' ? item : {}) as { loc?: unknown; type?: unknown; msg?: unknown; input?: unknown };
  const msg = typeof e.msg === 'string' ? e.msg : '';
  const blank = e.type === 'missing' || e.input === '' || e.input === null;
  const reason = e.type === 'value_error' && msg.startsWith('Value error, ') ? msg.slice('Value error, '.length) : blank ? 'required' : '';
  return { field: fieldOf(e.loc), reason };
}

/** What a refusal says, from the response. */
export async function readRefusal(res: Response): Promise<Refusal> {
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    // Not JSON: a proxy's error page, say. The status is all there is.
  }
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
  const inner = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as { problem?: unknown }).problem : undefined;
  const problem = inner && typeof inner === 'object' && typeof (inner as { code?: unknown }).code === 'string' ? (inner as Record<string, unknown>) : null;
  const shape = res.status === 422 && Array.isArray(detail) && detail.length > 0 ? detail.map(shapeError) : null;
  return { status: res.status, problem, shape };
}

/** A value of the problem: a string, or null when it is missing or not one. */
export const textOf = (p: Record<string, unknown>, key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);

const server = (status: number): PlProblem => ({ code: 'server', status });

/**
 * The API's refusal (app/api/problems.py, services/vehicle_pl.py), as the
 * PlProblem it means. A known code with values the page cannot word is a
 * fault, never half a sentence; a code this app does not know is a fault too.
 */
function knownPl(p: Record<string, unknown>, status: number): PlProblem {
  const s = (key: string) => textOf(p, key);
  const field = s('field') ?? '';
  const billNumber = s('billNumber');
  switch (p.code) {
    case 'invalid':
      return { code: 'invalid', field, reason: s('reason') ?? '' };
    case 'needs-permission': {
      const permission = s('permission');
      return permission ? { code: 'needs-permission', permission } : server(status);
    }
    case 'reference-used':
      return { code: 'reference-used', field, reference: s('reference') ?? '' };
    case 'diesel-other-vehicle': {
      const vehicleId = s('vehicleId');
      return billNumber !== null && vehicleId !== null ? { code: 'diesel-other-vehicle', field, billNumber, vehicleId } : server(status);
    }
    case 'diesel-bill-void':
      return billNumber !== null ? { code: 'diesel-bill-void', field, billNumber, status: s('status') ?? '' } : server(status);
    case 'diesel-linked-elsewhere': {
      const sheetNumber = s('sheetNumber');
      return sheetNumber !== null ? { code: 'diesel-linked-elsewhere', field, sheetId: s('sheetId') ?? '', sheetNumber } : server(status);
    }
    case 'diesel-linked-twice':
      return { code: 'diesel-linked-twice', field };
    case 'diesel-same-bill':
      return billNumber !== null ? { code: 'diesel-same-bill', field, billNumber } : server(status);
    case 'diesel-bill-exists':
      return billNumber !== null ? { code: 'diesel-bill-exists', field, billNumber, billId: s('billId') ?? '' } : server(status);
    case 'diesel-bill-on-sheet': {
      const sheetNumber = s('sheetNumber');
      return billNumber !== null && sheetNumber !== null ? { code: 'diesel-bill-on-sheet', field, billNumber, sheetNumber } : server(status);
    }
    case 'not-paid-in-full': {
      const due = s('due');
      return due !== null ? { code: 'not-paid-in-full', due } : server(status);
    }
    case 'name-used':
      return { code: 'name-used', name: s('name') ?? '' };
    case 'code-used':
      // The API names the code it found as `materialCode`.
      return { code: 'code-used', name: s('materialCode') ?? s('name') ?? '' };
    case 'gstin-set':
      return { code: 'gstin-set', gstin: s('gstin') ?? '' };
    case 'gstin-used':
      return { code: 'gstin-used', gstin: s('gstin') ?? '' };
    case 'sale-invoiced': {
      const tripNumber = s('tripNumber');
      const invoiceId = s('invoiceId');
      const at = s('status');
      if (tripNumber === null || invoiceId === null || at === null) return server(status);
      const problem: PlProblem = { code: 'sale-invoiced', tripNumber, invoiceId, invoiceNumber: s('invoiceNumber'), status: at };
      return s('field') !== null ? { ...problem, field } : problem;
    }
    case 'sheet-gone':
    case 'file-gone':
    case 'file-missing':
    case 'not-found':
      return { code: 'gone' };
    case 'too-big':
      return { code: 'too-big' };
    case 'wrong-file':
      return { code: 'wrong-file' };
    case 'empty':
      return { code: 'empty-file' };
    default:
      return server(status);
  }
}

/** Why the API said no to a Vehicle P&L request, in the page's own vocabulary. */
export function plProblem(r: Refusal): PlProblem {
  if (r.status === 0) return { code: 'offline' };
  if (r.status === 401) return { code: 'signed-out' };
  if (r.problem) return knownPl(r.problem, r.status);
  const first = r.shape?.[0];
  if (first) return { code: 'invalid', field: first.field, reason: first.reason };
  if (r.status === 404) return { code: 'gone' };
  return server(r.status);
}

/** A Vehicle P&L request the API refused, carried as the problem it means. `problem` is what shell/queryClient.ts reads to decide on a retry. */
export class PlRefused extends Error {
  constructor(readonly problem: PlProblem) {
    super(problem.code);
    this.name = 'PlRefused';
  }
}

/** Anything thrown on the way, as the problem a person is shown. */
export function plProblemOf(err: unknown): PlProblem {
  return err instanceof PlRefused ? err.problem : server(0);
}

/* --------------------------------------------------------------- requests */

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** A JSON request. */
export function sendJson(method: 'POST' | 'PUT' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/** A read, cancelled when the screen goes. */
export function readJson(signal?: AbortSignal): RequestInit {
  return { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) };
}

/**
 * One request, through the API's base and its session renewal (auth/api.ts).
 * A refusal is thrown as `refuse` makes it; a 204 is read as null.
 */
export async function request<T>(path: string, init: RequestInit, read: (body: unknown) => T, refuse: (r: Refusal) => Error): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch (err) {
    // An aborted read (the screen went away) is not "offline": let it through as itself.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw refuse({ status: 0, problem: null, shape: null });
  }
  if (!res.ok) throw refuse(await readRefusal(res));
  if (res.status === 204) return read(null);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw refuse({ status: res.status, problem: null, shape: null });
  }
  return read(body);
}

const pl = <T>(path: string, init: RequestInit, read: (body: unknown) => T) => request(`/vehicle-pl${path}`, init, read, (r) => new PlRefused(plProblem(r)));

/** `?from=…&to=…`, leaving out what is blank. A search is cut to the API's 100 characters. */
export function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const text = (value ?? '').trim();
    if (text) q.set(key, key === 'q' ? text.slice(0, 100) : text);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** What a list or report is cut to: plStore's SheetFilter, as the API's query takes it. */
export interface SheetQuery {
  from?: string | null;
  to?: string | null;
  vehicleId?: string | null;
  customerId?: string | null;
  q?: string | null;
}

const id = encodeURIComponent;

/* ----- sheets */

export function fetchSheets(f: SheetQuery, signal?: AbortSignal): Promise<PlReport<PlSheetRow>> {
  const path = `/sheets${query({ from: f.from, to: f.to, vehicleId: f.vehicleId, customerId: f.customerId, q: f.q })}`;
  return pl(path, readJson(signal), (b) => b as PlReport<PlSheetRow>);
}

export function fetchSheet(sheetId: string, signal?: AbortSignal): Promise<PlSheetDetail> {
  return pl(`/sheets/${id(sheetId)}`, readJson(signal), (b) => detailFromApi(b as PlSheetDetail));
}

/** SheetIn is the page's PlSheetInput, field for field: what was typed and picked, nothing the rules work out. */
export type SheetBody = PlSheetInput;

export function postSheet(body: SheetBody): Promise<PlSheetDetail> {
  return pl('/sheets', sendJson('POST', body), (b) => detailFromApi(b as PlSheetDetail));
}

export function putSheet(sheetId: string, body: SheetBody): Promise<PlSheetDetail> {
  return pl(`/sheets/${id(sheetId)}`, sendJson('PUT', body), (b) => detailFromApi(b as PlSheetDetail));
}

export function deleteSheet(sheetId: string): Promise<null> {
  return pl(`/sheets/${id(sheetId)}`, { method: 'DELETE' }, () => null);
}

/** CloseIn. */
export interface CloseBody {
  partyId: string;
}

/** Accounts confirm the customer paid the trip in full; `close: false` takes it back. */
export function closeTrip(sheetId: string, tripId: string, partyId: string, close: boolean): Promise<PlSheetDetail> {
  const path = `/sheets/${id(sheetId)}/trips/${id(tripId)}/close`;
  const body: CloseBody = { partyId };
  return close
    ? pl(path, sendJson('POST', body), (b) => detailFromApi(b as PlSheetDetail))
    : pl(`${path}${query({ partyId })}`, { method: 'DELETE' }, (b) => detailFromApi(b as PlSheetDetail));
}

/* ----- masters */

/** The masters a line picks from, with every party once, whatever its roles. */
export interface Masters extends PlMasters {
  parties: PlParty[];
}

export function mastersFromApi(m: PlMasters): Masters {
  const parties = new Map<string, PlParty>();
  // A firm that is both a vendor and a customer comes in both lists, whole each time.
  for (const p of [...m.vendors, ...m.customers]) if (!parties.has(p.id)) parties.set(p.id, p);
  return { ...m, parties: [...parties.values()] };
}

export function fetchMasters(signal?: AbortSignal): Promise<Masters> {
  return pl('/masters', readJson(signal), (b) => mastersFromApi(b as PlMasters));
}

/** PartyIn: a vendor or customer added from a line. A new customer is served from the sheet's site. */
export interface PartyBody {
  role: PlPartyRole;
  name: string;
  gstin?: string | null;
  phone?: string;
  contactName?: string;
  siteId?: string | null;
  locations?: string[];
  address?: string;
}

/** PartyPatch: a GSTIN typed on a line, saved into the master; or the billing address an invoice prints. */
export interface PartyPatchBody {
  gstin?: string | null;
  phone?: string | null;
  address?: string | null;
}

/** LocationIn: a purchase or delivery place typed on a line. */
export interface LocationBody {
  name: string;
  address?: string;
  stateCode?: string | null;
}

/** MaterialIn. */
export interface MaterialBody {
  code?: string | null;
  name: string;
  hsnCode?: string | null;
  gstRatePct: number;
  unit: string;
}

/** GstRateBody. */
export interface GstRateBody {
  ratePct: number;
}

export function postParty(body: PartyBody): Promise<PlParty> {
  return pl('/parties', sendJson('POST', body), (b) => b as PlParty);
}

export function patchParty(partyId: string, body: PartyPatchBody): Promise<PlParty> {
  return pl(`/parties/${id(partyId)}`, sendJson('PATCH', body), (b) => b as PlParty);
}

export function postLocation(partyId: string, body: LocationBody): Promise<PlParty> {
  return pl(`/parties/${id(partyId)}/locations`, sendJson('POST', body), (b) => b as PlParty);
}

export function postMaterial(body: MaterialBody): Promise<PlMaterial> {
  return pl('/materials', sendJson('POST', body), (b) => b as PlMaterial);
}

export function postGstRate(body: GstRateBody): Promise<PlGstRate> {
  return pl('/gst-rates', sendJson('POST', body), (b) => b as PlGstRate);
}

/* ----- diesel bills and photos */

export function fetchDieselBills(vehicleId: string, signal?: AbortSignal): Promise<PlDieselBillOption[]> {
  return pl(`/diesel-bills${query({ vehicleId })}`, readJson(signal), (b) => b as PlDieselBillOption[]);
}

/** Where the API serves a trip paper (services/vehicle_pl.py attachment_url), relative to itself. */
export const attachmentPath = (fileId: string): string => `/vehicle-pl/attachments/${id(fileId)}`;

/** AttachmentOut (app/schemas/expenses.py): a stored photo, before it is on a line. */
export interface StoredPhoto {
  id: string;
  fileName: string;
  mimeType: string;
  sizeKb: number;
}

/** A stored photo has no address in the answer yet, so it is made here, as the API will serve it. */
export function uploadAttachment(file: File, base: string = API_BASE): Promise<PlAttachment> {
  const form = new FormData();
  form.append('file', file, file.name || 'photo');
  return pl('/attachments', { method: 'POST', body: form }, (b) => {
    const a = b as StoredPhoto;
    return { id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeKb: a.sizeKb, url: throughApi(base, attachmentPath(a.id)) };
  });
}

/* ----- reports */

export function fetchTripReport(f: SheetQuery, signal?: AbortSignal): Promise<PlReport<PlTripReportRow>> {
  const path = `/reports/trips${query({ from: f.from, to: f.to, vehicleId: f.vehicleId, customerId: f.customerId, q: f.q })}`;
  return pl(path, readJson(signal), (b) => b as PlReport<PlTripReportRow>);
}

export function fetchVehicleReport(f: SheetQuery, signal?: AbortSignal): Promise<PlReport<PlVehicleRow>> {
  return pl(`/reports/vehicles${query({ from: f.from, to: f.to, vehicleId: f.vehicleId, q: f.q })}`, readJson(signal), (b) => b as PlReport<PlVehicleRow>);
}

/** The monthly report takes no search: a month is the sum of every trip in it. */
export function fetchMonthReport(f: SheetQuery, signal?: AbortSignal): Promise<PlReport<PlMonthRow>> {
  return pl(`/reports/months${query({ from: f.from, to: f.to, vehicleId: f.vehicleId })}`, readJson(signal), (b) => b as PlReport<PlMonthRow>);
}

/** What customers owe, or vendors are owed, over the period; searched by name or GSTIN. */
export function fetchOutstanding(role: PlPartyRole, f: SheetQuery, signal?: AbortSignal): Promise<PlReport<PlOutstandingRow, PlOutstandingTotal>> {
  const path = `/reports/${role === 'customer' ? 'customers' : 'vendors'}${query({ from: f.from, to: f.to, q: f.q })}`;
  return pl(path, readJson(signal), (b) => b as PlReport<PlOutstandingRow, PlOutstandingTotal>);
}

/* ------------------------------------------------------------ the mapping */

/** A photo's address through the API's base. */
function attachmentFromApi(a: PlAttachment | null, base: string): PlAttachment | null {
  return a ? { ...a, url: throughApi(base, a.url) } : null;
}

/** SheetOut. It is PlSheetDetail already; every photo's address goes through the API's base. */
export function detailFromApi(d: PlSheetDetail, base: string = API_BASE): PlSheetDetail {
  const file = (a: PlAttachment | null) => attachmentFromApi(a, base);
  const diesel = (x: PlDieselOut): PlDieselOut => ({ ...x, attachment: file(x.attachment) });
  const road = (x: PlEnRouteOut): PlEnRouteOut => ({ ...x, attachment: file(x.attachment) });
  const trip = (t: PlTripOut): PlTripOut => ({
    ...t,
    diesel: t.diesel.map(diesel),
    enRoute: t.enRoute.map(road),
    purchases: t.purchases.map((p) => ({ ...p, attachments: p.attachments.map((a) => file(a)!) })),
    sales: t.sales.map((s) => ({ ...s, poAttachment: file(s.poAttachment), dcAttachment: file(s.dcAttachment) })),
  });
  return { ...d, diesel: d.diesel.map(diesel), enRoute: d.enRoute.map(road), trips: d.trips.map(trip) };
}

/**
 * The sheet as the page's form edits it, from SheetOut: what was typed and
 * picked, with each line's id, as plStore keeps a sheet. A transport charge
 * of nothing comes back as "0.00" and goes back as nothing, so the field is
 * empty; the API stores both as zero, and a billed line stays as billed.
 */
export function recordOf(d: PlSheetDetail): PlSheetRecord {
  const diesel = (x: PlDieselOut): PlDieselRecord => ({
    id: x.id,
    source: x.source,
    litres: x.litres,
    rate: x.rate,
    amount: x.amount,
    vendorId: x.vendorId,
    vendor: x.vendor,
    billNumber: x.billNumber,
    expenseBillId: x.expenseBillId,
    fuelEntryId: x.fuelEntryId,
    filledAt: x.filledAt,
    attachment: x.attachment,
  });
  const road = (x: PlEnRouteOut): PlEnRouteRecord => ({
    id: x.id,
    kind: x.kind,
    maintenanceKind: x.maintenanceKind,
    description: x.description,
    date: x.date,
    location: x.location,
    reference: x.reference,
    amount: x.amount,
    attachment: x.attachment,
  });
  const payment = (m: PlPaymentOut): PlPaymentRecord => ({
    id: m.id,
    direction: m.direction,
    partyId: m.partyId,
    paidOn: m.paidOn,
    mode: m.mode,
    reference: m.reference,
    amount: m.amount,
    note: m.note,
  });
  const trip = (t: PlTripOut): PlTripRecord => ({
    id: t.id,
    tripNumber: t.tripNumber,
    date: t.date,
    startKm: t.startKm,
    endKm: t.endKm,
    batta: t.batta,
    notes: t.notes,
    diesel: t.diesel.map(diesel),
    enRoute: t.enRoute.map(road),
    payments: t.payments.map(payment),
    purchases: t.purchases.map((p) => ({
      id: p.id,
      vendorId: p.vendorId,
      location: p.location,
      materialId: p.materialId,
      hsnCode: p.hsnCode,
      unit: p.unit,
      quantity: p.quantity,
      rate: p.rate,
      gstBilled: p.gstBilled,
      gstRatePct: p.gstRatePct,
      vendorGstin: p.vendorGstin,
      invoiceNumber: p.invoiceNumber,
      invoiceDate: p.invoiceDate,
      attachments: p.attachments,
    })),
    sales: t.sales.map((s) => ({
      id: s.id,
      customerId: s.customerId,
      location: s.location,
      purchaseOrderId: s.purchaseOrderId,
      poRef: s.poRef,
      materialId: s.materialId,
      hsnCode: s.hsnCode,
      unit: s.unit,
      quantity: s.quantity,
      rate: s.rate,
      transport: Number(s.transport) === 0 ? null : s.transport,
      gstBilled: s.gstBilled,
      gstRatePct: s.gstRatePct,
      partyGstin: s.partyGstin,
      challanNumber: s.challanNumber,
      invoiceNumber: s.invoiceNumber,
      poAttachment: s.poAttachment,
      dcAttachment: s.dcAttachment,
    })),
    // Accounts' closures are the customers' dues the API calls closed, as billed then.
    closures: t.dues
      .filter((x) => x.role === 'customer' && x.status === 'closed')
      .map((x) => ({ partyId: x.partyId, billed: x.billed, closedBy: x.closedBy ?? '', closedAt: x.closedAt ?? '' })),
  });
  return {
    id: d.id,
    sheetNumber: d.sheetNumber,
    siteId: d.siteId,
    vehicleId: d.vehicleId,
    registrationNumber: d.registrationNumber,
    vehicleModel: d.vehicleModel,
    driverId: d.driverId,
    driverName: d.driverName,
    driverPhone: d.driverPhone,
    startDate: d.startDate,
    endDate: d.endDate,
    startKm: d.startKm,
    endKm: d.endKm,
    batta: d.batta,
    notes: d.notes,
    diesel: d.diesel.map(diesel),
    enRoute: d.enRoute.map(road),
    payments: d.payments.map(payment),
    trips: d.trips.map(trip),
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const figuresOf = (x: PlDieselOut): DieselFigures => ({ litres: x.litres, rate: x.rate, amount: x.amount, counted: x.counted });
const dueOf = (x: PlPartyDue): PartyDue => ({ partyId: x.partyId, role: x.role, billed: x.billed, settled: x.settled, due: x.due, status: x.status });

/** The sheet's figures as the page draws a saved sheet: the server's own (app/domain/vehicle_pl.py), keyed as calculateSheet keys them. */
export function calcOf(d: PlSheetDetail): SheetCalc {
  return {
    sheetId: d.id,
    pl: d.pl,
    own: d.own,
    basis: d.basis,
    diesel: Object.fromEntries(d.diesel.map((x) => [x.id, figuresOf(x)])),
    dues: d.dues.map(dueOf),
    unsettled: d.unsettled.map(dueOf),
    trips: Object.fromEntries(
      d.trips.map((t) => [
        t.id,
        {
          tripId: t.id,
          pl: t.pl,
          own: t.own,
          share: t.share,
          purchases: Object.fromEntries(t.purchases.map((p) => [p.id, { amount: p.amount, gstAmount: p.gstAmount, total: p.total }])),
          sales: Object.fromEntries(t.sales.map((s) => [s.id, { amount: s.amount, transport: s.transport, taxable: s.taxable, gstAmount: s.gstAmount, total: s.total }])),
          diesel: Object.fromEntries(t.diesel.map((x) => [x.id, figuresOf(x)])),
          dues: t.dues.map(dueOf),
        },
      ]),
    ),
  };
}

/** For each sale line on a draft or issued invoice, that invoice (LIN-27): the API says so on the line. */
export function invoicedOf(d: PlSheetDetail): Map<string, PlSaleInvoice> {
  const out = new Map<string, PlSaleInvoice>();
  for (const t of d.trips) for (const s of t.sales) if (s.invoice) out.set(s.id, s.invoice);
  return out;
}

/** A diesel bill a line links, as the page's P&L box reads it while the sheet is edited. */
export interface LinkedBill {
  id: string;
  billNumber: string;
  litres: number | null;
  amount: string;
  status: string;
}

/** The bills a sheet links or may link: those already on it (SheetOut says what each holds) and those offered. */
export function linkedBillsOf(d: PlSheetDetail | null, offered: readonly PlDieselBillOption[]): Map<string, LinkedBill> {
  const out = new Map<string, LinkedBill>();
  for (const b of offered) out.set(b.id, { id: b.id, billNumber: b.billNumber, litres: b.litres, amount: b.amount, status: b.status });
  for (const x of d ? [...d.diesel, ...d.trips.flatMap((t) => t.diesel)] : []) {
    if (x.source !== 'expense_bill' || !x.expenseBillId || out.has(x.expenseBillId)) continue;
    out.set(x.expenseBillId, { id: x.expenseBillId, billNumber: x.billNumber, litres: x.litres, amount: x.amount, status: x.billStatus ?? 'deleted' });
  }
  return out;
}

/** No sheet read yet, or none to read: every figure zero. */
export const NO_TOTAL: PlTotals = sumPl([], 0);
