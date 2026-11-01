import { useMemo } from 'react';
import { create } from 'zustand';
import {
  billKey,
  businessDate,
  calculateSheet,
  can,
  decimal,
  findDoubleCounts,
  outstanding,
  plByMonth,
  plByVehicle,
  plUnits,
  sumPl,
  totalPl,
  type Grants,
  type PartyDue,
  type PlDieselLine as DomainDiesel,
  type PlSheet,
  type PlTotals,
  type PlUnit,
  type SheetCalc,
} from '@linck/domain';
import {
  FUEL_ENTRIES,
  NOW,
  PL_CUSTOMERS,
  PL_GST_RATES,
  PL_MATERIALS,
  PL_SHEET_RECORDS,
  PL_VENDORS,
  PURCHASE_ORDERS,
  type ExpenseBill,
  type PlAttachment,
  type PlDieselBillOption,
  type PlDieselInput,
  type PlDieselOut,
  type PlDieselRecord,
  type PlEnRouteInput,
  type PlEnRouteOut,
  type PlEnRouteRecord,
  type PlGstRate,
  type PlMasters,
  type PlMaterial,
  type PlMonthRow,
  type PlOutstandingRow,
  type PlOutstandingTotal,
  type PlParty,
  type PlPartyDue,
  type PlPartyRole,
  type PlPaymentInput,
  type PlPaymentOut,
  type PlPaymentRecord,
  type PlPurchaseRecord,
  type PlReport,
  type PlSaleRecord,
  type PlSheetDetail,
  type PlSheetInput,
  type PlSheetRecord,
  type PlSheetRow,
  type PlTripOut,
  type PlTripRecord,
  type PlTripReportRow,
  type PlVehicleRow,
} from '@linck/mock';
import { useExpenses } from '../expenses/expenseStore.js';

/**
 * The vehicle P&L as one client-side store (LIN-22) — the demo source of what
 * /vehicle-pl returns, shaped field for field like the API's JSON
 * (packages/mock/src/types.ts). At cutover (LIN-21) these functions become
 * fetches of those routes and nothing on the screens changes.
 *
 * Sheets are kept as the API stores them: what was typed and picked. Every
 * figure — a line's cost, GST and total, each trip's share of its sheet's
 * costs, each P&L, status and money due — is worked out from them by
 * packages/domain/src/vehicle-pl.ts on every read, with the expense bills read
 * live from the expense store, so a bill corrected or rejected there shows
 * here at once. A save is refused for the same reasons, with the same problem
 * codes, as the API refuses it.
 */

export const READ = 'fleet.trip_pl.read';
export const WRITE = 'fleet.trip_pl.write';
export const REPORT = 'finance.pl_report.read';
/** Closing a trip a customer paid in full is accounts' confirmation of money received. */
export const CLOSE = 'finance.receipt.verify';
export const READ_KEYS = [READ, REPORT] as const;

/** The screens' paths, as strings: the router's routes are declared with string paths. */
export const LIST_PATH: string = '/fleet/pl';
export const NEW_PATH: string = '/fleet/pl/new';
export const sheetPath = (id: string): string => `/fleet/pl/sheets/${id}`;

const VOID_BILL = new Set(['rejected', 'deleted']);
const money = (v: string | number | null | undefined) => decimal.toFixed(decimal.dec(v ?? 0), 2);
const positive = (v: string | number | null | undefined) => decimal.cmp(decimal.dec(v ?? 0), decimal.dec(0)) > 0;
export const todayIso = () => businessDate(NOW);

export type PlProblem =
  | { code: 'invalid'; field: string; reason: string }
  | { code: 'needs-permission'; permission: string }
  | { code: 'reference-used'; field: string; reference: string }
  | { code: 'diesel-other-vehicle'; field: string; billNumber: string; vehicleId: string }
  | { code: 'diesel-bill-void'; field: string; billNumber: string; status: string }
  | { code: 'diesel-linked-elsewhere'; field: string; sheetId: string; sheetNumber: string }
  | { code: 'diesel-linked-twice'; field: string }
  | { code: 'diesel-same-bill'; field: string; billNumber: string }
  | { code: 'diesel-bill-exists'; field: string; billNumber: string; billId: string }
  | { code: 'diesel-bill-on-sheet'; field: string; billNumber: string; sheetNumber: string }
  | { code: 'not-paid-in-full'; due: string }
  | { code: 'name-used' | 'code-used'; name: string }
  | { code: 'gstin-set'; gstin: string };

export type SaveResult = { ok: true; id: string } | { ok: false; problem: PlProblem };

export interface Who {
  name: string;
  grants: Grants;
}

/* --------------------------------------------------------------- the store */

interface PlState {
  sheets: PlSheetRecord[];
  parties: PlParty[];
  materials: PlMaterial[];
  gstRates: PlGstRate[];
  /** Every upload by id: those on a line, and those not yet put on one. */
  files: Record<string, PlAttachment>;
  sheetSerial: number;
  tripSerial: number;
  save(input: PlSheetInput, id: string | null, who: Who, bills: readonly ExpenseBill[]): SaveResult;
  remove(id: string, who: Who): boolean;
  close(sheetId: string, tripId: string, partyId: string, who: Who, bills: readonly ExpenseBill[], close: boolean): SaveResult;
  addParty(input: { role: PlPartyRole; name: string; gstin?: string | null; phone?: string; locations?: string[] }): PlParty;
  patchParty(id: string, patch: { gstin?: string | null; phone?: string }): { ok: true; party: PlParty } | { ok: false; problem: PlProblem };
  addLocation(partyId: string, name: string): PlParty | null;
  addMaterial(input: { name: string; code?: string | null; hsnCode?: string | null; gstRatePct: number; unit: string }): { ok: true; material: PlMaterial } | { ok: false; problem: PlProblem };
  addGstRate(ratePct: number): PlGstRate;
  setGstRate(id: string, active: boolean): void;
  upload(file: File): PlAttachment;
}

const mergeParties = (vendors: PlParty[], customers: PlParty[]): PlParty[] => {
  const out = new Map<string, PlParty>();
  for (const p of [...vendors, ...customers]) {
    const had = out.get(p.id);
    out.set(p.id, had ? { ...had, roles: [...new Set([...had.roles, ...p.roles])], locations: [...had.locations, ...p.locations] } : p);
  }
  return [...out.values()];
};

let localSeq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(localSeq += 1).toString(36)}`;
const maxSerial = (numbers: string[]) => numbers.reduce((m, n) => Math.max(m, Number(n.split('/').pop()) || 0), 0);

export const usePl = create<PlState>((set, get) => ({
  sheets: PL_SHEET_RECORDS,
  parties: mergeParties(PL_VENDORS, PL_CUSTOMERS),
  materials: PL_MATERIALS,
  gstRates: PL_GST_RATES,
  files: {},
  sheetSerial: maxSerial(PL_SHEET_RECORDS.map((s) => s.sheetNumber)),
  tripSerial: maxSerial(PL_SHEET_RECORDS.flatMap((s) => s.trips.map((t) => t.tripNumber))),

  save(input, id, who, bills) {
    const state = get();
    const existing = id ? (state.sheets.find((s) => s.id === id) ?? null) : null;
    const problem = check(state, input, existing, who, bills);
    if (problem) return { ok: false, problem };
    const at = new Date().toISOString();
    let { sheetSerial, tripSerial } = state;
    const sheetId = existing?.id ?? newId('ts');
    if (!existing) sheetSerial += 1;
    const record = toRecord(state, input, existing, sheetId, (date) => {
      tripSerial += 1;
      return `TRP/${fy(date)}/${String(tripSerial).padStart(4, '0')}`;
    });
    const saved: PlSheetRecord = {
      ...record,
      sheetNumber: existing?.sheetNumber ?? `TS/${fy(input.startDate)}/${String(sheetSerial).padStart(4, '0')}`,
      createdBy: existing?.createdBy ?? who.name,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    set({
      sheets: existing ? state.sheets.map((s) => (s.id === existing.id ? saved : s)) : [...state.sheets, saved],
      sheetSerial,
      tripSerial,
    });
    return { ok: true, id: sheetId };
  },

  remove(id, who) {
    const sheet = get().sheets.find((s) => s.id === id);
    if (!sheet || !can(who.grants, WRITE, { siteId: sheet.siteId })) return false;
    set({ sheets: get().sheets.filter((s) => s.id !== id) });
    return true;
  },

  close(sheetId, tripId, partyId, who, bills, close) {
    const state = get();
    const sheet = state.sheets.find((s) => s.id === sheetId);
    if (!sheet) return { ok: false, problem: { code: 'invalid', field: 'sheetId', reason: 'no such sheet' } };
    if (!can(who.grants, CLOSE, { siteId: sheet.siteId })) return { ok: false, problem: { code: 'needs-permission', permission: CLOSE } };
    const trip = sheet.trips.find((t) => t.id === tripId);
    if (!trip) return { ok: false, problem: { code: 'invalid', field: 'tripId', reason: 'not a trip of this sheet' } };
    let closures = trip.closures.filter((c) => c.partyId !== partyId);
    if (close) {
      const calc = calculateSheet(toDomain(sheet, billMap(bills))).trips[tripId]!;
      const due = calc.dues.find((d) => d.role === 'customer' && d.partyId === partyId);
      if (!due || !positive(due.billed)) return { ok: false, problem: { code: 'invalid', field: 'partyId', reason: 'not a customer billed on this trip' } };
      if (positive(due.due)) return { ok: false, problem: { code: 'not-paid-in-full', due: due.due } };
      closures = [...closures, { partyId, billed: due.billed, closedBy: who.name, closedAt: new Date().toISOString() }];
    }
    const next: PlSheetRecord = { ...sheet, trips: sheet.trips.map((t) => (t.id === tripId ? { ...t, closures } : t)) };
    set({ sheets: state.sheets.map((s) => (s.id === sheetId ? next : s)) });
    return { ok: true, id: sheetId };
  },

  addParty({ role, name, gstin = null, phone = '', locations = [] }) {
    const parties = get().parties;
    const found = gstin ? parties.find((p) => p.gstin === gstin) : undefined;
    const locs = (p: PlParty) => {
      const have = new Set(p.locations.map((l) => l.name.toLowerCase()));
      return [...p.locations, ...locations.filter((l) => !have.has(l.toLowerCase())).map((l) => ({ id: newId('loc'), name: l }))];
    };
    if (found) {
      const party = { ...found, roles: [...new Set([...found.roles, role])], locations: locs(found) };
      set({ parties: parties.map((p) => (p.id === found.id ? party : p)) });
      return party;
    }
    const party: PlParty = { id: newId(role === 'vendor' ? 'ven' : 'cus'), name: name.trim(), gstin, phone, contactName: '', roles: [role], locations: [] };
    const withLocs = { ...party, locations: locs(party) };
    set({ parties: [...parties, withLocs] });
    return withLocs;
  },

  patchParty(id, patch) {
    const party = get().parties.find((p) => p.id === id);
    if (!party) return { ok: false, problem: { code: 'invalid', field: 'partyId', reason: 'no such party' } };
    if (patch.gstin && party.gstin && patch.gstin !== party.gstin) return { ok: false, problem: { code: 'gstin-set', gstin: party.gstin } };
    const next = { ...party, gstin: patch.gstin ?? party.gstin, phone: patch.phone ?? party.phone };
    set({ parties: get().parties.map((p) => (p.id === id ? next : p)) });
    return { ok: true, party: next };
  },

  addLocation(partyId, name) {
    const party = get().parties.find((p) => p.id === partyId);
    if (!party) return null;
    if (party.locations.some((l) => l.name.toLowerCase() === name.trim().toLowerCase())) return party;
    const next = { ...party, locations: [...party.locations, { id: newId('loc'), name: name.trim() }] };
    set({ parties: get().parties.map((p) => (p.id === partyId ? next : p)) });
    return next;
  },

  addMaterial({ name, code = null, hsnCode = null, gstRatePct, unit }) {
    const materials = get().materials;
    if (materials.some((m) => m.name.toLowerCase() === name.trim().toLowerCase())) return { ok: false, problem: { code: 'name-used', name } };
    if (code && materials.some((m) => m.code === code)) return { ok: false, problem: { code: 'code-used', name: code } };
    const material: PlMaterial = { id: newId('mat'), code, name: name.trim(), hsnCode, gstRatePct, unit: unit.trim(), active: true };
    set({ materials: [...materials, material] });
    return { ok: true, material };
  },

  addGstRate(ratePct) {
    const found = get().gstRates.find((r) => r.ratePct === ratePct);
    const rate = found ? { ...found, active: true } : { id: newId('gst'), ratePct, active: true };
    set({ gstRates: [...get().gstRates.filter((r) => r.id !== rate.id), rate].sort((a, b) => a.ratePct - b.ratePct) });
    return rate;
  },

  setGstRate(id, active) {
    set({ gstRates: get().gstRates.map((r) => (r.id === id ? { ...r, active } : r)) });
  },

  upload(file) {
    const id = newId('file');
    const attachment: PlAttachment = {
      id,
      fileName: file.name || 'photo',
      mimeType: file.type || 'image/jpeg',
      sizeKb: Math.max(1, Math.round(file.size / 1024)),
      url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '',
    };
    set({ files: { ...get().files, [id]: attachment } });
    return attachment;
  },
}));

function fy(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const startYear = m >= 4 ? y : y - 1;
  return `${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/* ----------------------------------------------------------- checking */

const billMap = (bills: readonly ExpenseBill[]) => new Map(bills.map((b) => [b.id, b]));

/** The API's refusals, in its order and with its codes (apps/api/app/services/vehicle_pl.py). */
function check(state: PlState, input: PlSheetInput, existing: PlSheetRecord | null, who: Who, bills: readonly ExpenseBill[]): PlProblem | null {
  const invalid = (field: string, reason: string): PlProblem => ({ code: 'invalid', field, reason });
  if (!can(who.grants, WRITE, { siteId: input.siteId }) || (existing && !can(who.grants, WRITE, { siteId: existing.siteId }))) {
    return { code: 'needs-permission', permission: WRITE };
  }
  const today = todayIso();
  if (!input.vehicleId) return invalid('vehicleId', 'required');
  if (!input.startDate) return invalid('startDate', 'required');
  if (input.startDate > today) return invalid('startDate', 'after today');
  if (input.endDate && input.endDate > today) return invalid('endDate', 'after today');
  if (input.endDate && input.endDate < input.startDate) return invalid('endDate', 'before the start date');
  const kmOrder = (start: number | null | undefined, end: number | null | undefined) => start != null && end != null && end < start;
  if (kmOrder(input.startKm, input.endKm)) return invalid('endKm', 'less than the start km');
  const lastDay = input.endDate || today;
  for (const [i, t] of input.trips.entries()) {
    if (t.id && !existing?.trips.some((x) => x.id === t.id)) return invalid(`trips[${i}].id`, 'not a trip of this sheet');
    if (!t.date || t.date < input.startDate || t.date > lastDay) return invalid(`trips[${i}].date`, "outside the sheet's dates");
    if (kmOrder(t.startKm, t.endKm)) return invalid(`trips[${i}].endKm`, 'less than the start km');
  }
  const parties = new Map(state.parties.map((p) => [p.id, p]));
  const materials = new Map(state.materials.map((m) => [m.id, m]));
  const rates = new Map(state.gstRates.map((r) => [r.ratePct, r.active]));
  const oldTrips = existing?.trips ?? [];
  const oldLine = <T extends { id: string }>(pick: (t: PlTripRecord) => T[], id: string | null | undefined) =>
    id ? oldTrips.flatMap(pick).find((l) => l.id === id) : undefined;
  const role = (id: string, r: PlPartyRole) => parties.get(id)?.roles.includes(r) ?? false;
  const material = (where: string, id: string, prior: { materialId: string } | undefined): PlProblem | null => {
    const m = materials.get(id);
    if (!m) return invalid(`${where}.materialId`, 'no such material');
    if (!m.active && prior?.materialId !== id) return invalid(`${where}.materialId`, 'no longer in use');
    return null;
  };
  const gst = (where: string, line: { gstBilled: boolean; gstRatePct?: number | null; materialId: string }, prior: { gstBilled: boolean; gstRatePct: number } | undefined): PlProblem | null => {
    if (!line.gstBilled) return null;
    const rate = line.gstRatePct ?? materials.get(line.materialId)?.gstRatePct ?? 0;
    if (!rates.has(rate)) return invalid(`${where}.gstRatePct`, 'not one of your GST rates');
    if (!rates.get(rate) && !(prior?.gstBilled && prior.gstRatePct === rate)) return invalid(`${where}.gstRatePct`, 'that GST rate is switched off');
    return null;
  };
  for (const [ti, t] of input.trips.entries()) {
    for (const [i, p] of t.purchases.entries()) {
      const where = `trips[${ti}].purchases[${i}]`;
      if (!role(p.vendorId, 'vendor')) return invalid(`${where}.vendorId`, 'not a vendor');
      const prior = oldLine((x) => x.purchases, p.id);
      const problem = material(where, p.materialId, prior);
      if (problem) return problem;
      if (p.gstBilled && !(p.vendorGstin || parties.get(p.vendorId)?.gstin)) return invalid(`${where}.vendorGstin`, 'required on a GST bill');
      if (!positive(p.quantity)) return invalid(`${where}.quantity`, 'must be more than zero');
      if (!positive(p.rate)) return invalid(`${where}.rate`, 'must be more than zero');
      const g = gst(where, p, prior);
      if (g) return g;
    }
    for (const [i, s] of t.sales.entries()) {
      const where = `trips[${ti}].sales[${i}]`;
      if (!role(s.customerId, 'customer')) return invalid(`${where}.customerId`, 'not a customer');
      const prior = oldLine((x) => x.sales, s.id);
      const problem = material(where, s.materialId, prior);
      if (problem) return problem;
      if (!positive(s.quantity)) return invalid(`${where}.quantity`, 'must be more than zero');
      if (!positive(s.rate)) return invalid(`${where}.rate`, 'must be more than zero');
      const g = gst(where, s, prior);
      if (g) return g;
    }
  }
  const references = new Set<string>();
  const payments: [string, number | null, PlPaymentInput][] = [
    ...(input.payments ?? []).map((m, i): [string, number | null, PlPaymentInput] => [`payments[${i}]`, null, m]),
    ...input.trips.flatMap((t, ti) => (t.payments ?? []).map((m, i): [string, number | null, PlPaymentInput] => [`trips[${ti}].payments[${i}]`, ti, m])),
  ];
  for (const [where, ti, m] of payments) {
    const r: PlPartyRole = m.direction === 'in' ? 'customer' : 'vendor';
    if (!role(m.partyId, r)) return invalid(`${where}.partyId`, `not a ${r}`);
    if (ti !== null) {
      const trip = input.trips[ti]!;
      const onTrip = r === 'customer' ? trip.sales.map((s) => s.customerId) : trip.purchases.map((p) => p.vendorId);
      if (!onTrip.includes(m.partyId)) return invalid(`${where}.partyId`, `not a ${r} of this trip`);
    }
    if (!positive(m.amount)) return invalid(`${where}.amount`, 'must be more than zero');
    if (m.paidOn > today) return invalid(`${where}.paidOn`, 'after today');
    if (m.reference) {
      if (references.has(m.reference)) return { code: 'reference-used', field: where, reference: m.reference };
      references.add(m.reference);
    }
  }
  const enRoute: [string, PlEnRouteInput][] = [
    ...(input.enRoute ?? []).map((e, i): [string, PlEnRouteInput] => [`enRoute[${i}]`, e]),
    ...input.trips.flatMap((t, ti) => (t.enRoute ?? []).map((e, i): [string, PlEnRouteInput] => [`trips[${ti}].enRoute[${i}]`, e])),
  ];
  for (const [where, e] of enRoute) {
    if ((e.kind === 'maintenance') !== Boolean(e.maintenanceKind)) return invalid(`${where}.maintenanceKind`, 'required for maintenance, and only there');
    if (e.maintenanceKind === 'misc' && !e.description?.trim()) return invalid(`${where}.description`, 'say what the maintenance was');
    if (!positive(e.amount)) return invalid(`${where}.amount`, 'must be more than zero');
  }
  return checkDiesel(state, input, existing, bills);
}

function dieselLines(input: PlSheetInput): [string, number | null, PlDieselInput][] {
  return [
    ...(input.diesel ?? []).map((d, i): [string, number | null, PlDieselInput] => [`diesel[${i}]`, null, d]),
    ...input.trips.flatMap((t, ti) => (t.diesel ?? []).map((d, i): [string, number | null, PlDieselInput] => [`trips[${ti}].diesel[${i}]`, ti, d])),
  ];
}

function checkDiesel(state: PlState, input: PlSheetInput, existing: PlSheetRecord | null, bills: readonly ExpenseBill[]): PlProblem | null {
  const invalid = (field: string, reason: string): PlProblem => ({ code: 'invalid', field, reason });
  const byId = billMap(bills);
  const mine = new Set(existing ? allDiesel(existing).map((d) => d.expenseBillId).filter(Boolean) : []);
  const lines = dieselLines(input);
  for (const [where, , d] of lines) {
    if (d.source === 'typed') {
      if (!positive(d.litres)) return invalid(`${where}.litres`, 'must be more than zero');
      if (!positive(d.rate)) return invalid(`${where}.rate`, 'must be more than zero');
      continue;
    }
    if (d.source === 'expense_bill') {
      const bill = d.expenseBillId ? byId.get(d.expenseBillId) : undefined;
      if (!bill || bill.desk !== 'fleet' || bill.kind !== 'diesel') return invalid(`${where}.expenseBillId`, 'no such bill');
      if (bill.vehicleId !== null && bill.vehicleId !== input.vehicleId) return { code: 'diesel-other-vehicle', field: where, billNumber: bill.billNumber, vehicleId: bill.vehicleId };
      if (VOID_BILL.has(bill.status) && !mine.has(bill.id)) return { code: 'diesel-bill-void', field: where, billNumber: bill.billNumber, status: bill.status };
      continue;
    }
    if (!d.fuelEntryId) return invalid(`${where}.fuelEntryId`, 'required');
    if (!positive(d.litres)) return invalid(`${where}.litres`, 'must be more than zero');
    if (!positive(d.amount)) return invalid(`${where}.amount`, 'must be more than zero');
  }
  for (const other of state.sheets) {
    if (other.id === existing?.id) continue;
    for (const od of allDiesel(other)) {
      const hit = lines.find(([, , d]) => (d.expenseBillId && d.expenseBillId === od.expenseBillId) || (d.fuelEntryId && d.fuelEntryId === od.fuelEntryId));
      if (hit) return { code: 'diesel-linked-elsewhere', field: hit[0], sheetId: other.id, sheetNumber: other.sheetNumber };
    }
  }
  // findDoubleCounts over the sheet as it would be stored, as the API runs it.
  const domain: PlSheet = {
    id: existing?.id ?? 'new',
    vehicleId: input.vehicleId,
    startDate: input.startDate,
    diesel: lines.filter(([, ti]) => ti === null).map(([where, , d]) => wireDiesel(where, d, byId)),
    trips: input.trips.map((t, ti) => ({
      id: `trip-${ti}`,
      tripNumber: String(ti).padStart(4, '0'),
      date: t.date,
      purchases: [],
      sales: [],
      diesel: lines.filter(([, x]) => x === ti).map(([where, , d]) => wireDiesel(where, d, byId)),
    })),
  };
  const typedKeys = new Set(lines.filter(([, , d]) => d.source === 'typed').map(([, , d]) => billKey(d.billNumber)).filter(Boolean));
  const known = bills
    .filter((b) => b.desk === 'fleet' && b.kind === 'diesel' && !VOID_BILL.has(b.status) && typedKeys.has(billKey(b.billNumber)))
    .map((b) => ({ id: b.id, billNumber: b.billNumber, vehicleId: b.vehicleId }));
  const others = state.sheets
    .filter((s) => s.id !== existing?.id && s.vehicleId === input.vehicleId)
    .map((s) => ({
      sheetId: s.id,
      sheetNumber: s.sheetNumber,
      vehicleId: s.vehicleId,
      billNumbers: allDiesel(s)
        .filter((d) => d.source === 'typed' && typedKeys.has(billKey(d.billNumber)))
        .map((d) => d.billNumber ?? ''),
    }))
    .filter((o) => o.billNumbers.length > 0);
  const [first] = findDoubleCounts(domain, { bills: known, otherSheets: others });
  if (!first) return null;
  const { lineId, ...rest } = first;
  return { ...rest, field: lineId } as PlProblem;
}

function wireDiesel(id: string, d: PlDieselInput, bills: Map<string, ExpenseBill>): DomainDiesel {
  if (d.source === 'expense_bill') {
    const bill = d.expenseBillId ? bills.get(d.expenseBillId) : undefined;
    return { id, source: 'expense_bill', litres: bill?.litres ?? null, amount: bill?.amount ?? null, expenseBillId: d.expenseBillId ?? null, billNumber: bill?.billNumber ?? null };
  }
  return { id, source: d.source, litres: d.litres ?? null, rate: d.rate ?? null, amount: d.amount ?? null, fuelEntryId: d.fuelEntryId ?? null, billNumber: d.billNumber || null };
}

function allDiesel(s: PlSheetRecord): PlDieselRecord[] {
  return [...s.diesel, ...s.trips.flatMap((t) => t.diesel)];
}

/* ------------------------------------------------------------- storing */

function toRecord(
  state: PlState,
  input: PlSheetInput,
  existing: PlSheetRecord | null,
  sheetId: string,
  tripNumber: (date: string) => string,
): Omit<PlSheetRecord, 'sheetNumber' | 'createdBy' | 'createdAt' | 'updatedAt'> {
  const parties = new Map(state.parties.map((p) => [p.id, p]));
  const materials = new Map(state.materials.map((m) => [m.id, m]));
  const known = new Map<string, PlAttachment>(Object.entries(state.files));
  if (existing) {
    for (const d of allDiesel(existing)) if (d.attachment) known.set(d.attachment.id, d.attachment);
    for (const e of [...existing.enRoute, ...existing.trips.flatMap((t) => t.enRoute)]) if (e.attachment) known.set(e.attachment.id, e.attachment);
    for (const t of existing.trips) {
      for (const p of t.purchases) for (const a of p.attachments) known.set(a.id, a);
      for (const s of t.sales) for (const a of [s.poAttachment, s.dcAttachment]) if (a) known.set(a.id, a);
    }
  }
  const file = (id: string | null | undefined) => (id ? (known.get(id) ?? null) : null);
  const lineId = (id: string | null | undefined, prefix: string) => id ?? newId(`${sheetId}-${prefix}`);
  const diesel = (d: PlDieselInput): PlDieselRecord => {
    const { attachmentId, id, ...rest } = d;
    return { ...rest, id: lineId(id, 'd'), attachment: file(attachmentId) };
  };
  const enRoute = (e: PlEnRouteInput): PlEnRouteRecord => {
    const { attachmentId, id, ...rest } = e;
    return { ...rest, id: lineId(id, 'e'), attachment: file(attachmentId) };
  };
  const payment = (m: PlPaymentInput): PlPaymentRecord => ({ ...m, id: lineId(m.id, 'm') });
  return {
    id: sheetId,
    siteId: input.siteId,
    vehicleId: input.vehicleId,
    registrationNumber: input.registrationNumber,
    vehicleModel: input.vehicleModel ?? '',
    driverId: input.driverId ?? null,
    driverName: input.driverName ?? '',
    driverPhone: input.driverPhone ?? '',
    startDate: input.startDate,
    endDate: input.endDate || null,
    startKm: input.startKm ?? null,
    endKm: input.endKm ?? null,
    batta: input.batta || null,
    notes: input.notes ?? '',
    diesel: (input.diesel ?? []).map(diesel),
    enRoute: (input.enRoute ?? []).map(enRoute),
    payments: (input.payments ?? []).map(payment),
    trips: input.trips.map((t): PlTripRecord => {
      const prior = t.id ? existing?.trips.find((x) => x.id === t.id) : undefined;
      return {
        id: prior?.id ?? newId(`${sheetId}-t`),
        tripNumber: prior?.tripNumber ?? tripNumber(t.date),
        date: t.date,
        startKm: t.startKm ?? null,
        endKm: t.endKm ?? null,
        batta: t.batta || null,
        notes: t.notes ?? '',
        diesel: (t.diesel ?? []).map(diesel),
        enRoute: (t.enRoute ?? []).map(enRoute),
        payments: (t.payments ?? []).map(payment),
        closures: prior?.closures ?? [],
        purchases: t.purchases.map((p): PlPurchaseRecord => {
          const m = materials.get(p.materialId);
          const { attachmentIds = [], id, ...rest } = p;
          return {
            ...rest,
            id: lineId(id, 'p'),
            hsnCode: p.hsnCode || m?.hsnCode || null,
            unit: p.unit || m?.unit || 'unit',
            gstRatePct: p.gstBilled ? (p.gstRatePct ?? m?.gstRatePct ?? 0) : 0,
            vendorGstin: p.vendorGstin || parties.get(p.vendorId)?.gstin || null,
            attachments: attachmentIds.map((a) => known.get(a)).filter((a): a is PlAttachment => Boolean(a)),
          };
        }),
        sales: t.sales.map((s): PlSaleRecord => {
          const m = materials.get(s.materialId);
          const { poAttachmentId, dcAttachmentId, id, ...rest } = s;
          return {
            ...rest,
            id: lineId(id, 's'),
            hsnCode: s.hsnCode || m?.hsnCode || null,
            unit: s.unit || m?.unit || 'unit',
            gstRatePct: s.gstBilled ? (s.gstRatePct ?? m?.gstRatePct ?? 0) : 0,
            partyGstin: s.partyGstin || parties.get(s.customerId)?.gstin || null,
            poAttachment: file(poAttachmentId),
            dcAttachment: file(dcAttachmentId),
          };
        }),
      };
    }),
  };
}

/* -------------------------------------------------------------- the rules */

/** A stored sheet as the rules see it, with linked bills read from Expenses. */
export function toDomain(s: PlSheetRecord, bills: Map<string, ExpenseBill>): PlSheet {
  const diesel = (d: PlDieselRecord): DomainDiesel => {
    if (d.source !== 'expense_bill') return wireDiesel(d.id, d, bills);
    const bill = d.expenseBillId ? bills.get(d.expenseBillId) : undefined;
    return { ...wireDiesel(d.id, d, bills), void: !bill || VOID_BILL.has(bill.status) };
  };
  const costs = (x: { diesel: PlDieselRecord[]; enRoute: PlEnRouteRecord[]; payments: PlPaymentRecord[] }) => ({
    diesel: x.diesel.map(diesel),
    enRoute: x.enRoute.map((e) => ({ id: e.id, kind: e.kind, amount: e.amount })),
    payments: x.payments.map((m) => ({ id: m.id, direction: m.direction, partyId: m.partyId, amount: m.amount })),
  });
  return {
    id: s.id,
    sheetNumber: s.sheetNumber,
    vehicleId: s.vehicleId,
    startDate: s.startDate,
    endDate: s.endDate,
    startKm: s.startKm,
    endKm: s.endKm,
    batta: s.batta,
    ...costs(s),
    trips: s.trips.map((t) => ({
      id: t.id,
      tripNumber: t.tripNumber,
      date: t.date,
      startKm: t.startKm,
      endKm: t.endKm,
      batta: t.batta,
      ...costs(t),
      purchases: t.purchases.map((p) => ({ id: p.id, vendorId: p.vendorId, quantity: p.quantity, rate: p.rate, gstBilled: p.gstBilled, gstRatePct: p.gstRatePct })),
      sales: t.sales.map((x) => ({ id: x.id, customerId: x.customerId, quantity: x.quantity, rate: x.rate, transport: x.transport ?? null, gstBilled: x.gstBilled, gstRatePct: x.gstRatePct })),
      closures: t.closures.map((c) => ({ partyId: c.partyId, billed: c.billed })),
    })),
  };
}

/** The form as it stands, for the P&L box: what is typed so far, nothing stored. Trip ids are `draft-<index>`. */
export function draftDomain(input: PlSheetInput, existing: PlSheetRecord | null, materials: readonly PlMaterial[], bills: Map<string, ExpenseBill>): PlSheet {
  const rate = (line: { gstBilled: boolean; gstRatePct?: number | null; materialId: string }) =>
    line.gstBilled ? (line.gstRatePct ?? materials.find((m) => m.id === line.materialId)?.gstRatePct ?? 0) : 0;
  const lines = dieselLines(input);
  const costs = (ti: number | null, x: { enRoute?: PlEnRouteInput[]; payments?: PlPaymentInput[] }) => ({
    diesel: lines
      .filter(([, t]) => t === ti)
      .map(([where, , d]) => {
        const line = wireDiesel(where, d, bills);
        const bill = d.expenseBillId ? bills.get(d.expenseBillId) : undefined;
        return d.source === 'expense_bill' ? { ...line, void: !bill || VOID_BILL.has(bill.status) } : line;
      }),
    enRoute: (x.enRoute ?? []).map((e, i) => ({ id: `e${ti}-${i}`, kind: e.kind, amount: e.amount })),
    payments: (x.payments ?? []).map((m, i) => ({ id: `m${ti}-${i}`, direction: m.direction, partyId: m.partyId || null, amount: m.amount })),
  });
  return {
    id: existing?.id ?? 'draft',
    vehicleId: input.vehicleId,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    startKm: input.startKm ?? null,
    endKm: input.endKm ?? null,
    batta: input.batta ?? null,
    ...costs(null, input),
    trips: input.trips.map((t, ti) => {
      const prior = t.id ? existing?.trips.find((x) => x.id === t.id) : undefined;
      return {
        id: `draft-${ti}`,
        tripNumber: prior?.tripNumber ?? `~${String(ti).padStart(4, '0')}`,
        date: t.date,
        startKm: t.startKm ?? null,
        endKm: t.endKm ?? null,
        batta: t.batta ?? null,
        ...costs(ti, t),
        purchases: t.purchases.map((p, i) => ({ id: `p${ti}-${i}`, vendorId: p.vendorId || null, quantity: p.quantity, rate: p.rate, gstBilled: p.gstBilled, gstRatePct: rate(p) })),
        sales: t.sales.map((s, i) => ({ id: `s${ti}-${i}`, customerId: s.customerId || null, quantity: s.quantity, rate: s.rate, transport: s.transport ?? null, gstBilled: s.gstBilled, gstRatePct: rate(s) })),
        closures: (prior?.closures ?? []).map((c) => ({ partyId: c.partyId, billed: c.billed })),
      };
    }),
  };
}

/* --------------------------------------------------------------- the book */

export interface PlBook {
  sheets: PlSheetRecord[];
  byId: Map<string, PlSheetRecord>;
  domain: Map<string, PlSheet>;
  calcs: Map<string, SheetCalc>;
  parties: Map<string, PlParty>;
  materials: Map<string, PlMaterial>;
  bills: Map<string, ExpenseBill>;
}

export function buildBook(sheets: PlSheetRecord[], parties: PlParty[], materials: PlMaterial[], bills: readonly ExpenseBill[]): PlBook {
  const billsById = billMap(bills);
  const domain = new Map(sheets.map((s) => [s.id, toDomain(s, billsById)]));
  return {
    sheets,
    byId: new Map(sheets.map((s) => [s.id, s])),
    domain,
    calcs: new Map([...domain].map(([id, d]) => [id, calculateSheet(d)])),
    parties: new Map(parties.map((p) => [p.id, p])),
    materials: new Map(materials.map((m) => [m.id, m])),
    bills: billsById,
  };
}

export function usePlBook(): PlBook {
  const sheets = usePl((s) => s.sheets);
  const parties = usePl((s) => s.parties);
  const materials = usePl((s) => s.materials);
  const bills = useExpenses((s) => s.bills);
  return useMemo(() => buildBook(sheets, parties, materials, bills), [sheets, parties, materials, bills]);
}

/* ---------------------------------------------------------- the wire out */

const nameOf = (book: PlBook, id: string | null | undefined) => (id ? (book.parties.get(id)?.name ?? '') : '');
const materialOf = (book: PlBook, id: string) => book.materials.get(id)?.name ?? '';
const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];

function dieselOut(book: PlBook, d: PlDieselRecord, calc: SheetCalc['diesel']): PlDieselOut {
  const f = calc[d.id]!;
  const bill = d.expenseBillId ? book.bills.get(d.expenseBillId) : undefined;
  return {
    id: d.id,
    source: d.source,
    litres: f.litres,
    rate: f.rate,
    amount: f.amount,
    counted: f.counted,
    vendorId: d.vendorId ?? null,
    vendor: bill ? bill.vendor : nameOf(book, d.vendorId) || d.vendor || '',
    billNumber: bill ? bill.billNumber : (d.billNumber ?? ''),
    billDate: bill ? businessDate(bill.billDate) : null,
    billStatus: bill ? bill.status : null,
    filledAt: d.filledAt ?? null,
    expenseBillId: d.expenseBillId ?? null,
    fuelEntryId: d.fuelEntryId ?? null,
    attachment: d.attachment,
  };
}

function enRouteOut(e: PlEnRouteRecord): PlEnRouteOut {
  return {
    id: e.id,
    kind: e.kind,
    maintenanceKind: e.maintenanceKind ?? null,
    description: e.description ?? '',
    date: e.date ?? null,
    location: e.location ?? '',
    reference: e.reference ?? '',
    amount: money(e.amount),
    attachment: e.attachment,
  };
}

function paymentOut(book: PlBook, m: PlPaymentRecord): PlPaymentOut {
  return { id: m.id, direction: m.direction, partyId: m.partyId, partyName: nameOf(book, m.partyId), paidOn: m.paidOn, mode: m.mode, reference: m.reference ?? null, amount: money(m.amount), note: m.note ?? '' };
}

function duesOut(book: PlBook, dues: readonly PartyDue[], closures: PlTripRecord['closures'] = []): PlPartyDue[] {
  return dues.map((d) => {
    const c = d.status === 'closed' ? closures.find((x) => x.partyId === d.partyId) : undefined;
    return { ...d, partyName: nameOf(book, d.partyId), closedBy: c?.closedBy ?? null, closedAt: c?.closedAt ?? null };
  });
}

function tripOut(book: PlBook, t: PlTripRecord, calc: SheetCalc['trips'][string]): PlTripOut {
  return {
    id: t.id,
    tripNumber: t.tripNumber,
    date: t.date,
    startKm: t.startKm,
    endKm: t.endKm,
    batta: t.batta ? money(t.batta) : null,
    notes: t.notes,
    diesel: t.diesel.map((d) => dieselOut(book, d, calc.diesel)),
    enRoute: t.enRoute.map(enRouteOut),
    purchases: t.purchases.map((p) => ({
      id: p.id,
      vendorId: p.vendorId,
      vendorName: nameOf(book, p.vendorId),
      location: p.location ?? '',
      vendorGstin: p.vendorGstin,
      materialId: p.materialId,
      materialName: materialOf(book, p.materialId),
      hsnCode: p.hsnCode,
      unit: p.unit,
      quantity: p.quantity,
      rate: money(p.rate),
      gstBilled: p.gstBilled,
      gstRatePct: p.gstRatePct,
      ...calc.purchases[p.id]!,
      invoiceNumber: p.invoiceNumber ?? '',
      invoiceDate: p.invoiceDate ?? null,
      attachments: p.attachments,
    })),
    sales: t.sales.map((s) => ({
      id: s.id,
      customerId: s.customerId,
      customerName: nameOf(book, s.customerId),
      location: s.location ?? '',
      partyGstin: s.partyGstin,
      purchaseOrderId: s.purchaseOrderId ?? null,
      poRef: s.poRef ?? '',
      materialId: s.materialId,
      materialName: materialOf(book, s.materialId),
      hsnCode: s.hsnCode,
      unit: s.unit,
      quantity: s.quantity,
      rate: money(s.rate),
      gstBilled: s.gstBilled,
      gstRatePct: s.gstRatePct,
      ...calc.sales[s.id]!,
      challanNumber: s.challanNumber ?? '',
      invoiceNumber: s.invoiceNumber ?? '',
      poAttachment: s.poAttachment,
      dcAttachment: s.dcAttachment,
    })),
    payments: t.payments.map((m) => paymentOut(book, m)),
    pl: calc.pl,
    own: calc.own,
    share: calc.share,
    dues: duesOut(book, calc.dues, t.closures),
    customers: unique(t.sales.map((s) => nameOf(book, s.customerId))),
    vendors: unique(t.purchases.map((p) => nameOf(book, p.vendorId))),
    materials: unique([...t.purchases, ...t.sales].map((x) => materialOf(book, x.materialId))),
  };
}

const byTrip = (a: PlTripRecord, b: PlTripRecord) => (a.date === b.date ? a.tripNumber.localeCompare(b.tripNumber) : a.date < b.date ? -1 : 1);

export function sheetRow(book: PlBook, s: PlSheetRecord): PlSheetRow {
  const calc = book.calcs.get(s.id)!;
  const sales = s.trips.flatMap((t) => t.sales);
  const purchases = s.trips.flatMap((t) => t.purchases);
  return {
    id: s.id,
    sheetNumber: s.sheetNumber,
    siteId: s.siteId,
    vehicleId: s.vehicleId,
    registrationNumber: s.registrationNumber,
    vehicleModel: s.vehicleModel,
    driverId: s.driverId,
    driverName: s.driverName,
    driverPhone: s.driverPhone,
    startDate: s.startDate,
    endDate: s.endDate,
    startKm: s.startKm,
    endKm: s.endKm,
    tripNumbers: [...s.trips].sort(byTrip).map((t) => t.tripNumber),
    customers: unique(sales.map((x) => nameOf(book, x.customerId))),
    vendors: unique(purchases.map((x) => nameOf(book, x.vendorId))),
    materials: unique([...purchases, ...sales].map((x) => materialOf(book, x.materialId))),
    basis: calc.basis,
    pl: calc.pl,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function sheetDetail(book: PlBook, s: PlSheetRecord): PlSheetDetail {
  const calc = book.calcs.get(s.id)!;
  return {
    ...sheetRow(book, s),
    batta: s.batta ? money(s.batta) : null,
    notes: s.notes,
    diesel: s.diesel.map((d) => dieselOut(book, d, calc.diesel)),
    enRoute: s.enRoute.map(enRouteOut),
    payments: s.payments.map((m) => paymentOut(book, m)),
    own: calc.own,
    dues: duesOut(book, calc.dues),
    unsettled: duesOut(book, calc.unsettled),
    trips: [...s.trips].sort(byTrip).map((t) => tripOut(book, t, calc.trips[t.id]!)),
  };
}

/* ------------------------------------------------------------- reading */

export interface SheetFilter {
  from?: string | null;
  to?: string | null;
  vehicleId?: string | null;
  customerId?: string | null;
  q?: string | null;
}

export function readable(grants: Grants, keys: readonly string[], siteId: string): boolean {
  return keys.some((k) => can(grants, k, { siteId }));
}

function sheetWords(book: PlBook, s: PlSheetRecord, trips: PlTripRecord[] = s.trips): string[] {
  const sales = trips.flatMap((t) => t.sales);
  const purchases = trips.flatMap((t) => t.purchases);
  return [
    s.sheetNumber,
    s.registrationNumber,
    s.registrationNumber.replace(/\s+/g, ''),
    s.vehicleModel,
    s.driverName,
    ...trips.map((t) => t.tripNumber),
    ...sales.map((x) => nameOf(book, x.customerId)),
    ...purchases.map((x) => nameOf(book, x.vendorId)),
    ...[...sales, ...purchases].map((x) => materialOf(book, x.materialId)),
    ...[...sales, ...purchases].map((x) => `${x.location ?? ''} ${x.invoiceNumber ?? ''}`),
    ...sales.map((x) => `${x.poRef ?? ''} ${x.challanNumber ?? ''}`),
  ];
}

const hasNeedle = (words: string[], q: string | null | undefined) => {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle) return true;
  const plate = needle.replace(/\s+/g, '');
  return words.some((w) => w.toLowerCase().includes(needle) || w.toLowerCase().includes(plate));
};

/** Sheets this person may read that match, the latest first; a sheet is in a period when it starts in it or has a trip in it. */
export function listSheets(book: PlBook, grants: Grants, keys: readonly string[], f: SheetFilter): PlSheetRow[] {
  const inPeriod = (day: string) => (!f.from || day >= f.from) && (!f.to || day <= f.to);
  return book.sheets
    .filter((s) => readable(grants, keys, s.siteId))
    .filter((s) => !f.vehicleId || s.vehicleId === f.vehicleId)
    .filter((s) => !f.customerId || s.trips.some((t) => t.sales.some((x) => x.customerId === f.customerId)))
    .filter((s) => (!f.from && !f.to) || inPeriod(s.startDate) || s.trips.some((t) => inPeriod(t.date)))
    .filter((s) => hasNeedle(sheetWords(book, s), f.q))
    .sort((a, b) => (a.startDate === b.startDate ? b.sheetNumber.localeCompare(a.sheetNumber) : a.startDate < b.startDate ? 1 : -1))
    .map((s) => sheetRow(book, s));
}

export interface ReportUnit {
  unit: PlUnit;
  sheet: PlSheetRecord;
  trip: PlTripRecord | null;
}

/** The trips (and trip-less sheets, and unsettled sheet payments) the reports add up, as the API filters them. */
export function reportUnits(book: PlBook, grants: Grants, keys: readonly string[], f: SheetFilter): ReportUnit[] {
  const sheets = book.sheets.filter((s) => readable(grants, keys, s.siteId) && (!f.vehicleId || s.vehicleId === f.vehicleId));
  return plUnits(
    sheets.map((s) => book.domain.get(s.id)!),
    book.calcs,
  )
    .map((unit) => {
      const sheet = book.byId.get(unit.sheetId)!;
      return { unit, sheet, trip: unit.tripId ? (sheet.trips.find((t) => t.id === unit.tripId) ?? null) : null };
    })
    .filter(({ unit }) => (!f.from || unit.date >= f.from) && (!f.to || unit.date <= f.to))
    .filter(({ trip }) => !f.customerId || (trip?.sales.some((x) => x.customerId === f.customerId) ?? false))
    .filter(({ sheet, trip }) => hasNeedle(sheetWords(book, sheet, trip ? [trip] : []), f.q));
}

export function tripReport(book: PlBook, units: ReportUnit[]): PlReport<PlTripReportRow> {
  const rows = units.map(
    ({ unit, sheet, trip }): PlTripReportRow => ({
      kind: trip ? 'trip' : sheet.trips.length === 0 ? 'sheet' : 'payment',
      sheetId: sheet.id,
      sheetNumber: sheet.sheetNumber,
      tripId: trip?.id ?? null,
      tripNumber: trip?.tripNumber ?? null,
      date: unit.date,
      vehicleId: sheet.vehicleId,
      registrationNumber: sheet.registrationNumber,
      driverName: sheet.driverName,
      customers: unique((trip?.sales ?? []).map((x) => nameOf(book, x.customerId))),
      vendors: unique((trip?.purchases ?? []).map((x) => nameOf(book, x.vendorId))),
      materials: unique([...(trip?.purchases ?? []), ...(trip?.sales ?? [])].map((x) => materialOf(book, x.materialId))),
      pl: unit.pl,
    }),
  );
  rows.sort((a, b) => (a.date === b.date ? (b.tripNumber ?? '').localeCompare(a.tripNumber ?? '') : a.date < b.date ? 1 : -1));
  return { rows, total: totalPl(units.map((u) => u.unit)) };
}

function latestVehicle(units: ReportUnit[]): Map<string, PlSheetRecord> {
  const latest = new Map<string, PlSheetRecord>();
  for (const { sheet } of units) {
    const had = latest.get(sheet.vehicleId);
    if (!had || sheet.startDate > had.startDate) latest.set(sheet.vehicleId, sheet);
  }
  return latest;
}

export function vehicleReport(units: ReportUnit[]): PlReport<PlVehicleRow> {
  const latest = latestVehicle(units);
  return {
    rows: plByVehicle(units.map((u) => u.unit)).map((r) => ({
      ...r,
      registrationNumber: latest.get(r.vehicleId)?.registrationNumber ?? r.vehicleId,
      vehicleModel: latest.get(r.vehicleId)?.vehicleModel ?? '',
    })),
    total: totalPl(units.map((u) => u.unit)),
  };
}

export function monthReport(units: ReportUnit[]): PlReport<PlMonthRow> {
  return { rows: plByMonth(units.map((u) => u.unit)), total: totalPl(units.map((u) => u.unit)) };
}

export function outstandingReport(book: PlBook, units: ReportUnit[], role: PlPartyRole, q: string | null | undefined): PlReport<PlOutstandingRow, PlOutstandingTotal> {
  const needle = (q ?? '').trim().toLowerCase();
  const rows = outstanding(
    units.map((u) => u.unit),
    role,
  )
    .map((r): PlOutstandingRow => {
      const p = book.parties.get(r.partyId);
      return { ...r, name: p?.name ?? '', gstin: p?.gstin ?? null, phone: p?.phone ?? '' };
    })
    .filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.gstin ?? '').toLowerCase().includes(needle))
    .sort((a, b) => decimal.cmp(decimal.dec(b.due), decimal.dec(a.due)) || a.name.localeCompare(b.name) || a.partyId.localeCompare(b.partyId));
  const add = (k: 'billed' | 'settled' | 'due') => money(decimal.toFixed(decimal.sum(rows.map((r) => decimal.dec(r[k]))), 2));
  return { rows, total: { parties: rows.length, billed: add('billed'), settled: add('settled'), due: add('due') } };
}

export function sheetsTotal(rows: PlSheetRow[]): PlTotals {
  return sumPl(
    rows.map((r) => r.pl),
    rows.reduce((n, r) => n + r.tripNumbers.length, 0),
  );
}

export function mastersOf(state: Pick<PlState, 'parties' | 'materials' | 'gstRates'>): PlMasters {
  const byName = (a: PlParty, b: PlParty) => a.name.localeCompare(b.name);
  return {
    customers: state.parties.filter((p) => p.roles.includes('customer')).sort(byName),
    vendors: state.parties.filter((p) => p.roles.includes('vendor')).sort(byName),
    materials: [...state.materials].sort((a, b) => a.name.localeCompare(b.name)),
    gstRates: [...state.gstRates].sort((a, b) => a.ratePct - b.ratePct),
  };
}

export function dieselBillsFor(book: PlBook, bills: readonly ExpenseBill[], vehicleId: string): PlDieselBillOption[] {
  const linked = new Map<string, { sheetId: string; sheetNumber: string }>();
  for (const s of book.sheets) for (const d of allDiesel(s)) if (d.expenseBillId) linked.set(d.expenseBillId, { sheetId: s.id, sheetNumber: s.sheetNumber });
  return bills
    .filter((b) => b.desk === 'fleet' && b.kind === 'diesel' && !VOID_BILL.has(b.status) && (b.vehicleId === vehicleId || b.vehicleId === null))
    .sort((a, b) => b.billDate.localeCompare(a.billDate))
    .slice(0, 100)
    .map((b) => ({
      id: b.id,
      billNumber: b.billNumber,
      billDate: businessDate(b.billDate),
      vendor: b.vendor,
      vehicleId: b.vehicleId,
      litres: b.litres,
      amount: b.amount,
      status: b.status,
      linkedSheet: linked.get(b.id) ?? null,
    }));
}

export function fuelEntriesFor(book: PlBook, vehicleId: string) {
  const linked = new Map<string, string>();
  for (const s of book.sheets) for (const d of allDiesel(s)) if (d.fuelEntryId) linked.set(d.fuelEntryId, s.sheetNumber);
  return FUEL_ENTRIES.filter((e) => e.vehicleId === vehicleId)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({ entry: e, linkedSheet: linked.get(e.id) ?? null }));
}

export function ordersFor(customerId: string) {
  return PURCHASE_ORDERS.filter((o) => o.customerId === customerId && o.status !== 'rejected');
}

export { billKey };
export type { PlUnit };
