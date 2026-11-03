import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { can, sitesFor, type SheetCalc } from '@linck/domain';
import {
  VEHICLES,
  type PlAttachment,
  type PlDieselBillOption,
  type PlMonthRow,
  type PlOutstandingRow,
  type PlOutstandingTotal,
  type PlParty,
  type PlPartyRole,
  type PlReport,
  type PlSaleInvoice,
  type PlSheetDetail,
  type PlSheetInput,
  type PlSheetRecord,
  type PlSheetRow,
  type PlTripReportRow,
  type PlVehicleRow,
  type PurchaseOrder,
} from '@linck/mock';
import { LIVE } from '../../auth/api.js';
import { useApp } from '../../shell/store.js';
import { useSites, type Move } from '../expenses/bills.js';
import { useExpenses } from '../expenses/expenseStore.js';
import { useOrders } from '../sales/orders.js';
import { liveInvoices, useInvoices } from './invoiceStore.js';
import * as api from './plApi.js';
import {
  dieselBillsFor,
  fuelEntriesFor,
  listSheets,
  mastersOf,
  monthReport,
  ordersFor,
  outstandingReport,
  READ_KEYS,
  REPORT,
  reportUnits,
  sheetsTotal,
  tripReport,
  usePl,
  usePlBook,
  vehicleReport,
  WRITE,
  type LinkableBill,
  type PlProblem,
  type SheetFilter,
} from './plStore.js';

/**
 * WHERE THE VEHICLE P&L COMES FROM — picked once, here, by the mode the app
 * was built in (auth/api.ts), as expenses/bills.ts picks the bills.
 *
 *   DEMO (no VITE_API_URL): plStore.ts, the trip sheets and masters kept in
 *     the browser, every figure worked out by packages/domain on each read,
 *     every save checked by the same rules the API applies. The Vercel
 *     preview, exactly as it has always been.
 *   LIVE: /vehicle-pl (plApi.ts) through TanStack Query (shell/queryClient.ts):
 *     one cache entry per list, report or sheet and per person, every save,
 *     delete, closure and master a request. The API applies the rules and
 *     works out every figure; this end draws what it answered, and while a
 *     sheet is being typed, the same rules give the P&L box its running
 *     figures. After a write the cache holds the sheet as the API now has
 *     it, and everything under Vehicle P&L — lists, reports, invoices — is
 *     read again, so every screen shows the same state.
 *
 * Each hook has one shape in both modes. A move answers with why it did not
 * go through, or null. Live, there is no fleet list on the API yet (bills.ts):
 * a sheet's vehicle and driver are typed, and the fuel register, which is not
 * on the API, offers no fuel entries.
 */

/** Everything Vehicle P&L reads live sits under this key: sheets, masters, reports, invoices. */
export const PL = 'vehicle-pl';
/** One entry per person: the cache never hands one person's sheets to the next. */
export const plKey = (who: string, ...parts: unknown[]): QueryKey => [PL, who, ...parts];

/** A list, report or record as a screen reads it, in either mode. */
export interface Read<T, P = PlProblem> {
  data: T;
  /** Always 'ready' in the demo. */
  state: 'loading' | 'ready' | 'failed';
  /** Why it could not be read, when `state` is 'failed'. */
  problem: P | null;
  retry: () => void;
}

const noop = () => undefined;
/** What the demo reads: there at once, never failing. */
export const ready = <T, P = PlProblem>(data: T): Read<T, P> => ({ data, state: 'ready', problem: null, retry: noop });

/** Who asks, for the cache key. */
const useWho = () => useApp((s) => s.persona.key);
const useGrants = () => useApp((s) => s.persona.grants);

/** Holding any read key anywhere, a person has sheets to read; the API cuts them to the sites it reaches. */
const mayRead = (grants: Parameters<typeof can>[0]) => READ_KEYS.some((k) => can(grants, k));

/**
 * A live read. `keep`: while a new filter is read, the list on screen stays
 * (TanStack's placeholder), rather than blinking to "Getting…" on every key.
 */
export function useLiveRead<T, P = PlProblem>(
  key: QueryKey,
  read: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  empty: T,
  keep = false,
  problemOf: (err: unknown) => P = api.plProblemOf as unknown as (err: unknown) => P,
): Read<T, P> {
  const query = useQuery<T, Error, T, QueryKey>({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    enabled,
    ...(keep ? { placeholderData: keepPreviousData } : {}),
  });
  // A list once read stays on screen through a failed re-read; only nothing at all is a failure.
  const failed = query.isError && query.data === undefined;
  return {
    data: query.data ?? empty,
    state: !enabled || query.data !== undefined ? 'ready' : failed ? 'failed' : 'loading',
    problem: failed ? problemOf(query.error) : null,
    retry: () => void query.refetch(),
  };
}

/** A search as it settles: live, a request goes once typing stops, not on every key. */
export function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** After any write: everything under Vehicle P&L is read again, for everyone who has it. */
export function rereadPl(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: [PL] });
}

/* ----------------------------------------------------------- the sheets */

const NO_SHEETS: PlReport<PlSheetRow> = { rows: [], total: api.NO_TOTAL };

function useDemoSheetList(f: SheetFilter): Read<PlReport<PlSheetRow>> {
  const book = usePlBook();
  const grants = useGrants();
  const data = useMemo(() => {
    const rows = listSheets(book, grants, READ_KEYS, f);
    return { rows, total: sheetsTotal(rows) };
  }, [book, grants, f.from, f.to, f.q, f.vehicleId, f.customerId]);
  return ready(data);
}

function useLiveSheetList(f: SheetFilter): Read<PlReport<PlSheetRow>> {
  const who = useWho();
  const grants = useGrants();
  const q = useSettled(f.q ?? '');
  const ask: api.SheetQuery = { from: f.from ?? null, to: f.to ?? null, vehicleId: f.vehicleId ?? null, customerId: f.customerId ?? null, q };
  return useLiveRead(plKey(who, 'sheets', ask), (signal) => api.fetchSheets(ask, signal), mayRead(grants), NO_SHEETS, true);
}

/** The trip sheets this person may read that match, the latest first, with their total. */
export const useSheetList: (f: SheetFilter) => Read<PlReport<PlSheetRow>> = LIVE ? useLiveSheetList : useDemoSheetList;

/** What the filters offer, and whether there is any sheet at all: from every sheet, not the ones on screen. */
export interface SheetOptions {
  vehicles: { id: string; label: string }[];
  customers: { id: string; label: string }[];
  /** No sheet yet, as against none matching. */
  none: boolean;
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

function useDemoSheetOptions(): SheetOptions {
  const book = usePlBook();
  const parties = usePl((s) => s.parties);
  const vehicles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of book.sheets) seen.set(s.vehicleId, s.registrationNumber);
    return [...seen].map(([id, label]) => ({ id, label })).sort(byLabel);
  }, [book.sheets]);
  const customers = useMemo(
    () =>
      parties
        .filter((p) => p.roles.includes('customer'))
        .map((p) => ({ id: p.id, label: p.name }))
        .sort(byLabel),
    [parties],
  );
  return { vehicles, customers, none: book.sheets.length === 0 };
}

function useLiveSheetOptions(): SheetOptions {
  const all = useLiveSheetList({});
  const masters = usePlMasters();
  const vehicles = useMemo(() => {
    const seen = new Map<string, string>();
    // The latest sheet first: a vehicle is named as on its latest.
    for (const s of [...all.data.rows].reverse()) seen.set(s.vehicleId, s.registrationNumber);
    return [...seen].map(([id, label]) => ({ id, label })).sort(byLabel);
  }, [all.data.rows]);
  const customers = useMemo(() => masters.data.customers.map((p) => ({ id: p.id, label: p.name })).sort(byLabel), [masters.data.customers]);
  return { vehicles, customers, none: all.state === 'ready' && all.data.rows.length === 0 };
}

export const useSheetOptions: () => SheetOptions = LIVE ? useLiveSheetOptions : useDemoSheetOptions;

/** Whether this person keeps trip sheets anywhere: the demo asks of its sample fleet; live, of the session's sites. */
export function useMayWriteSheets(): boolean {
  const grants = useGrants();
  const sites = useSites();
  return LIVE ? sitesFor(grants, WRITE, sites.map((s) => s.id)).length > 0 : VEHICLES.some((v) => can(grants, WRITE, { siteId: v.siteId }));
}

/** The sites a new sheet can be kept at, live: those the session reaches where this person keeps sheets. */
export function useWritableSites(): { id: string; name: string }[] {
  const grants = useGrants();
  const sites = useSites();
  return useMemo(() => {
    const ids = new Set(sitesFor(grants, WRITE, sites.map((s) => s.id)));
    return sites.filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
  }, [grants, sites]);
}

/* -------------------------------------------------------------- reports */

type Outstanding = PlReport<PlOutstandingRow, PlOutstandingTotal>;

const NO_REPORT = { rows: [], total: api.NO_TOTAL };
const NO_DUES: Outstanding = { rows: [], total: { parties: 0, billed: '0.00', settled: '0.00', due: '0.00' } };

function useDemoTripReport(f: SheetFilter): Read<PlReport<PlTripReportRow>> {
  const book = usePlBook();
  const grants = useGrants();
  return ready(useMemo(() => tripReport(book, reportUnits(book, grants, READ_KEYS, f)), [book, grants, f.from, f.to, f.q, f.vehicleId, f.customerId]));
}

function useLiveTripReport(f: SheetFilter): Read<PlReport<PlTripReportRow>> {
  const who = useWho();
  const grants = useGrants();
  const q = useSettled(f.q ?? '');
  const ask: api.SheetQuery = { from: f.from ?? null, to: f.to ?? null, vehicleId: f.vehicleId ?? null, customerId: f.customerId ?? null, q };
  return useLiveRead(plKey(who, 'report', 'trips', ask), (signal) => api.fetchTripReport(ask, signal), mayRead(grants), NO_REPORT, true);
}

/** Every trip with its own profit, as the Trips view of the sheet list shows them. */
export const useTripReport: (f: SheetFilter) => Read<PlReport<PlTripReportRow>> = LIVE ? useLiveTripReport : useDemoTripReport;

export interface AllReports {
  trips: PlReport<PlTripReportRow>;
  vehicles: PlReport<PlVehicleRow>;
  months: PlReport<PlMonthRow>;
  customers: Outstanding;
  vendors: Outstanding;
}

export type ReportTab = keyof AllReports;

export interface Reports {
  /** Each report; live, only the trip-wise one (its total heads every tab) and the tab on screen are read. */
  read: { [K in ReportTab]: Read<AllReports[K]> };
  /** Every report, reading the ones not read yet: Excel takes them all. Null, or why one could not be read. */
  withAll: (then: (all: AllReports) => void) => Promise<PlProblem | null>;
}

function useDemoReports(f: SheetFilter): Reports {
  const book = usePlBook();
  const grants = useGrants();
  const units = useMemo(() => reportUnits(book, grants, READ_KEYS, { ...f, q: null }), [book, grants, f.from, f.to, f.vehicleId, f.customerId]);
  const searched = useMemo(() => reportUnits(book, grants, READ_KEYS, f), [book, grants, f.from, f.to, f.q, f.vehicleId, f.customerId]);
  const trips = useMemo(() => tripReport(book, searched), [book, searched]);
  const vehicles = useMemo(() => vehicleReport(searched), [searched]);
  const months = useMemo(() => monthReport(searched), [searched]);
  const customers = useMemo(() => outstandingReport(book, units, 'customer', f.q), [book, units, f.q]);
  const vendors = useMemo(() => outstandingReport(book, units, 'vendor', f.q), [book, units, f.q]);
  const all: AllReports = { trips, vehicles, months, customers, vendors };
  return {
    read: { trips: ready(trips), vehicles: ready(vehicles), months: ready(months), customers: ready(customers), vendors: ready(vendors) },
    withAll: async (then) => {
      then(all);
      return null;
    },
  };
}


function useLiveReports(f: SheetFilter, tab: ReportTab): Reports {
  const who = useWho();
  const grants = useGrants();
  const client = useQueryClient();
  const q = useSettled(f.q ?? '');
  const ask: api.SheetQuery = { from: f.from ?? null, to: f.to ?? null, vehicleId: f.vehicleId ?? null, customerId: f.customerId ?? null, q };
  // The vehicle-wise and monthly reports and the money-due lists are the director's and accounts' (REPORT).
  const report = can(grants, REPORT);
  const how: { [K in ReportTab]: { key: QueryKey; read: (signal?: AbortSignal) => Promise<AllReports[K]>; may: boolean } } = {
    trips: { key: plKey(who, 'report', 'trips', ask), read: (s) => api.fetchTripReport(ask, s), may: mayRead(grants) },
    vehicles: { key: plKey(who, 'report', 'vehicles', ask), read: (s) => api.fetchVehicleReport(ask, s), may: report },
    months: { key: plKey(who, 'report', 'months', ask), read: (s) => api.fetchMonthReport(ask, s), may: report },
    customers: { key: plKey(who, 'report', 'customers', ask), read: (s) => api.fetchOutstanding('customer', ask, s), may: report },
    vendors: { key: plKey(who, 'report', 'vendors', ask), read: (s) => api.fetchOutstanding('vendor', ask, s), may: report },
  };
  const on = (t: ReportTab) => how[t].may && (t === 'trips' || t === tab);
  const read: Reports['read'] = {
    trips: useLiveRead(how.trips.key, (s) => how.trips.read(s), on('trips'), NO_REPORT, true),
    vehicles: useLiveRead(how.vehicles.key, (s) => how.vehicles.read(s), on('vehicles'), NO_REPORT, true),
    months: useLiveRead(how.months.key, (s) => how.months.read(s), on('months'), NO_REPORT, true),
    customers: useLiveRead(how.customers.key, (s) => how.customers.read(s), on('customers'), NO_DUES, true),
    vendors: useLiveRead(how.vendors.key, (s) => how.vendors.read(s), on('vendors'), NO_DUES, true),
  };
  return {
    read,
    withAll: async (then) => {
      const fetch = <K extends ReportTab>(t: K): Promise<AllReports[K]> =>
        how[t].may ? client.fetchQuery({ queryKey: how[t].key, queryFn: ({ signal }) => how[t].read(signal) }) : Promise.resolve((t === 'customers' || t === 'vendors' ? NO_DUES : NO_REPORT) as AllReports[K]);
      try {
        const [trips, vehicles, months, customers, vendors] = await Promise.all([fetch('trips'), fetch('vehicles'), fetch('months'), fetch('customers'), fetch('vendors')]);
        then({ trips, vehicles, months, customers, vendors });
        return null;
      } catch (err) {
        return api.plProblemOf(err);
      }
    },
  };
}

/** The demo works every report out at once, whichever tab is on screen. */
function useDemoReportsAt(f: SheetFilter, _tab: ReportTab): Reports {
  return useDemoReports(f);
}

/** The profit reports for one period and search. */
export const usePlReports: (f: SheetFilter, tab: ReportTab) => Reports = LIVE ? useLiveReports : useDemoReportsAt;

/* -------------------------------------------------------------- masters */

/** The masters a line picks from: every party once, and each role's list sorted by name. */
export type MastersRead = Read<api.Masters>;

const NO_MASTERS: api.Masters = { parties: [], customers: [], vendors: [], materials: [], gstRates: [] };

function useDemoMasters(): MastersRead {
  const parties = usePl((s) => s.parties);
  const materials = usePl((s) => s.materials);
  const gstRates = usePl((s) => s.gstRates);
  return ready(useMemo(() => ({ parties, ...mastersOf({ parties, materials, gstRates }) }), [parties, materials, gstRates]));
}

function useLiveMasters(): MastersRead {
  const who = useWho();
  const grants = useGrants();
  // GET /masters answers whoever reads, keeps or reports on sheets.
  const may = [...READ_KEYS, WRITE].some((k) => can(grants, k));
  return useLiveRead(plKey(who, 'masters'), (signal) => api.fetchMasters(signal), may, NO_MASTERS);
}

export const usePlMasters: () => MastersRead = LIVE ? useLiveMasters : useDemoMasters;

/* ------------------------------------------------------------ one sheet */

/** A saved sheet as its page reads it. */
export interface SheetView {
  /** As the form edits it. */
  record: PlSheetRecord;
  /** Its figures: worked out by the page's rules in the demo, the server's own live. */
  calc: SheetCalc;
  /** For each sale line on a draft or issued invoice, that invoice (LIN-27). */
  invoiced: Map<string, PlSaleInvoice>;
  /** Live: the sheet as the API answered it. */
  detail: PlSheetDetail | null;
}

export function viewOf(d: PlSheetDetail): SheetView {
  return { record: api.recordOf(d), calc: api.calcOf(d), invoiced: api.invoicedOf(d), detail: d };
}

function useDemoSheet(id: string | undefined): Read<SheetView | null> {
  const book = usePlBook();
  const invoices = useInvoices((s) => s.invoices);
  const invoiced = useMemo(() => liveInvoices(invoices), [invoices]);
  const record = id ? (book.byId.get(id) ?? null) : null;
  return ready(useMemo(() => (record ? { record, calc: book.calcs.get(record.id)!, invoiced, detail: null } : null), [record, book.calcs, invoiced]));
}

function useLiveSheet(id: string | undefined): Read<SheetView | null> {
  const who = useWho();
  const grants = useGrants();
  const read = useLiveRead<PlSheetDetail | null>(plKey(who, 'sheet', id ?? ''), (signal) => api.fetchSheet(id!, signal), Boolean(id) && mayRead(grants), null);
  const view = useMemo(() => (read.data ? viewOf(read.data) : null), [read.data]);
  return { ...read, data: view };
}

/** One sheet, by id; null for a new one, or one not there. */
export const useSheet: (id: string | undefined) => Read<SheetView | null> = LIVE ? useLiveSheet : useDemoSheet;

/* ------------------------------------------------ what a line links to */

export interface DieselBills {
  /** The vehicle's diesel bills a line may link, newest first, and the sheet each is on. */
  options: PlDieselBillOption[];
  /** What each bill on the sheet or offered to it holds, for the running P&L. */
  bills: ReadonlyMap<string, LinkableBill>;
}

function useDemoDieselBills(vehicleId: string): DieselBills {
  const book = usePlBook();
  const bills = useExpenses((s) => s.bills);
  return { options: dieselBillsFor(book, bills, vehicleId), bills: book.bills };
}

function useLiveDieselBills(vehicleId: string): DieselBills {
  const who = useWho();
  const grants = useGrants();
  const sheet = useContext(SheetBeingEdited);
  // GET /diesel-bills answers whoever keeps or reads sheets, for their sites' bills.
  const may = Boolean(vehicleId) && (can(grants, WRITE) || can(grants, READ_KEYS[0]));
  const read = useLiveRead(plKey(who, 'diesel-bills', vehicleId), (signal) => api.fetchDieselBills(vehicleId, signal), may, [] as PlDieselBillOption[]);
  const bills = useMemo(() => api.linkedBillsOf(sheet?.detail ?? null, read.data), [sheet, read.data]);
  return { options: read.data, bills };
}

export const useDieselBills: (vehicleId: string) => DieselBills = LIVE ? useLiveDieselBills : useDemoDieselBills;

/** The sheet whose page is open, for what its lines link: live, the bills it already holds. */
export const SheetBeingEdited = createContext<SheetView | null>(null);

type FuelEntries = ReturnType<typeof fuelEntriesFor>;

/** The vehicle's fuel entries a line may link. The fuel register is not on the API: none, live, and the choice is not offered. */
export const FUEL_ENTRIES_OFFERED = !LIVE;

const NO_FUEL: FuelEntries = [];

function useDemoFuelEntries(vehicleId: string): FuelEntries {
  const book = usePlBook();
  return fuelEntriesFor(book, vehicleId);
}

export const useFuelEntries: (vehicleId: string) => FuelEntries = LIVE ? () => NO_FUEL : useDemoFuelEntries;

function useLiveOrdersFor(): (customerId: string) => PurchaseOrder[] {
  const orders = useOrders();
  return (customerId) => orders.rows.filter((o) => o.customerId === customerId && o.status !== 'rejected');
}

/** A customer's orders a sale line may name: the sample orders, or, live, the API's, where this person may read them. */
export const useOrdersFor: () => (customerId: string) => PurchaseOrder[] = LIVE ? useLiveOrdersFor : () => ordersFor;

/* ---------------------------------------------------------------- moves */

const useWhoNamed = () => {
  const persona = useApp((s) => s.persona);
  return { name: persona.name, grants: persona.grants };
};

export type SaveResult = { ok: true; id: string; record: PlSheetRecord } | { ok: false; problem: PlProblem };

export interface SaveArgs {
  input: PlSheetInput;
  /** The sheet being changed; null for a new one. */
  record: PlSheetRecord | null;
}

/** Places typed on lines that the party has not got yet: they go into the masters too (the workbook's "addable"). */
function newPlaces(input: PlSheetInput, parties: readonly PlParty[]): { partyId: string; name: string }[] {
  const out = new Map<string, { partyId: string; name: string }>();
  const lines = input.trips.flatMap((t) => [...t.purchases.map((p) => [p.vendorId, p.location] as const), ...t.sales.map((s) => [s.customerId, s.location] as const)]);
  for (const [partyId, place] of lines) {
    const name = (place ?? '').trim();
    if (!name || !partyId) continue;
    const have = parties.find((p) => p.id === partyId)?.locations.some((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!have) out.set(`${partyId}|${name.toLowerCase()}`, { partyId, name });
  }
  return [...out.values()];
}

function useDemoSave(): Move<SaveArgs, SaveResult> {
  const save = usePl((s) => s.save);
  const addLocation = usePl((s) => s.addLocation);
  const bills = useExpenses((s) => s.bills);
  const who = useWhoNamed();
  return {
    busy: false,
    run: async ({ input, record }) => {
      const result = save(input, record?.id ?? null, who, bills);
      if (!result.ok) return result;
      // Places typed on lines go into the masters as well (the workbook's "addable").
      for (const t of input.trips) {
        for (const p of t.purchases) if (p.location) addLocation(p.vendorId, p.location);
        for (const x of t.sales) if (x.location) addLocation(x.customerId, x.location);
      }
      return { ok: true, id: result.id, record: usePl.getState().sheets.find((x) => x.id === result.id)! };
    },
  };
}

function useLiveSave(): Move<SaveArgs, SaveResult> {
  const client = useQueryClient();
  const who = useWho();
  const mutation = useMutation({ mutationFn: ({ input, record }: SaveArgs) => (record ? api.putSheet(record.id, input) : api.postSheet(input)) });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        const detail = await mutation.mutateAsync(args);
        client.setQueryData(plKey(who, 'sheet', detail.id), detail);
        // The places typed on its lines, into the masters: the sheet is saved whatever they answer.
        const masters = client.getQueryData<api.Masters>(plKey(who, 'masters'));
        await Promise.allSettled(newPlaces(args.input, masters?.parties ?? []).map((p) => api.postLocation(p.partyId, { name: p.name })));
        rereadPl(client);
        return { ok: true, id: detail.id, record: api.recordOf(detail) };
      } catch (err) {
        rereadPl(client);
        return { ok: false, problem: api.plProblemOf(err) };
      }
    },
  };
}

/** A new sheet, or a changed one, as the page holds it. */
export const useSaveSheet: () => Move<SaveArgs, SaveResult> = LIVE ? useLiveSave : useDemoSave;

function useDemoDelete(): Move<PlSheetRecord, PlProblem | null> {
  const remove = usePl((s) => s.remove);
  const who = useWhoNamed();
  return {
    busy: false,
    run: async (record) => {
      const result = remove(record.id, who);
      return result.ok ? null : result.problem;
    },
  };
}

function useLiveDelete(): Move<PlSheetRecord, PlProblem | null> {
  const client = useQueryClient();
  const who = useWho();
  const mutation = useMutation({ mutationFn: (record: PlSheetRecord) => api.deleteSheet(record.id) });
  return {
    busy: mutation.isPending,
    run: async (record) => {
      try {
        await mutation.mutateAsync(record);
        client.removeQueries({ queryKey: plKey(who, 'sheet', record.id) });
        rereadPl(client);
        return null;
      } catch (err) {
        rereadPl(client);
        return api.plProblemOf(err);
      }
    },
  };
}

export const useDeleteSheet: () => Move<PlSheetRecord, PlProblem | null> = LIVE ? useLiveDelete : useDemoDelete;

export interface CloseArgs {
  sheetId: string;
  tripId: string;
  partyId: string;
  /** False takes a closure back. */
  close: boolean;
}

function useDemoClose(): Move<CloseArgs, PlProblem | null> {
  const close = usePl((s) => s.close);
  const bills = useExpenses((s) => s.bills);
  const who = useWhoNamed();
  return {
    busy: false,
    run: async (a) => {
      const r = close(a.sheetId, a.tripId, a.partyId, who, bills, a.close);
      return r.ok ? null : r.problem;
    },
  };
}

function useLiveClose(): Move<CloseArgs, PlProblem | null> {
  const client = useQueryClient();
  const who = useWho();
  const mutation = useMutation({ mutationFn: (a: CloseArgs) => api.closeTrip(a.sheetId, a.tripId, a.partyId, a.close) });
  return {
    busy: mutation.isPending,
    run: async (a) => {
      try {
        const detail = await mutation.mutateAsync(a);
        client.setQueryData(plKey(who, 'sheet', detail.id), detail);
        rereadPl(client);
        return null;
      } catch (err) {
        rereadPl(client);
        return api.plProblemOf(err);
      }
    },
  };
}

/** Accounts confirm a customer paid a trip in full, or take it back. */
export const useCloseTrip: () => Move<CloseArgs, PlProblem | null> = LIVE ? useLiveClose : useDemoClose;

/**
 * Adding to the masters from a line: a party, a material, a GST rate, a
 * GSTIN. The demo's answer at once, as it always has, so the line takes the
 * new pick in the same click; live, once the API has answered — with the new
 * id, or null when it refused, the reason in `problem`.
 */
export interface MasterMoves {
  addParty: (role: PlPartyRole, name: string, siteId: string) => string | null | Promise<string | null>;
  addMaterial: (m: api.MaterialBody) => string | null | Promise<string | null>;
  /** The rate as the line holds it, "5". */
  addRate: (ratePct: number) => string | null | Promise<string | null>;
  saveGstin: (partyId: string, gstin: string) => void;
  /** Why the last one was refused, live. */
  problem: PlProblem | null;
}

function useDemoMasterMoves(): MasterMoves {
  const store = usePl();
  return {
    addParty: (role, name) => store.addParty({ role, name }).id,
    addMaterial: (m) => {
      const r = store.addMaterial({ name: m.name, hsnCode: m.hsnCode ?? null, unit: m.unit, gstRatePct: m.gstRatePct });
      return r.ok ? r.material.id : null;
    },
    addRate: (ratePct) => String(store.addGstRate(ratePct).ratePct),
    saveGstin: (partyId, gstin) => void store.patchParty(partyId, { gstin }),
    problem: null,
  };
}

/** Live: why the last addition to a master was refused, wherever on the page it was asked, for the save bar to say. */
export const useMasterRefusal = create<{ problem: PlProblem | null; set: (p: PlProblem | null) => void }>((set) => ({
  problem: null,
  set: (problem) => set({ problem }),
}));

function useLiveMasterMoves(): MasterMoves {
  const client = useQueryClient();
  const problem = useMasterRefusal((s) => s.problem);
  const setProblem = useMasterRefusal((s) => s.set);
  const send = async <T>(request: Promise<T>, idOf: (made: T) => string): Promise<string | null> => {
    setProblem(null);
    try {
      const made = await request;
      rereadPl(client);
      return idOf(made);
    } catch (err) {
      setProblem(api.plProblemOf(err));
      return null;
    }
  };
  return {
    addParty: (role, name, siteId) => send(api.postParty({ role, name, ...(role === 'customer' ? { siteId } : {}) }), (p) => p.id),
    addMaterial: (m) => send(api.postMaterial(m), (x) => x.id),
    addRate: (ratePct) => send(api.postGstRate({ ratePct }), (r) => String(r.ratePct)),
    saveGstin: (partyId, gstin) => void send(api.patchParty(partyId, { gstin }), (p) => p.id),
    problem,
  };
}

export const useMasterMoves: () => MasterMoves = LIVE ? useLiveMasterMoves : useDemoMasterMoves;

/* --------------------------------------------------------------- photos */

/** Photos stored this session, live, before a saved sheet names them: the API's answer to an upload. */
const useUploaded = create<{ files: Record<string, PlAttachment>; keep: (a: PlAttachment) => void }>((set) => ({
  files: {},
  keep: (a) => set((s) => ({ files: { ...s.files, [a.id]: a } })),
}));

export interface Photos {
  /** Every photo a line may name, by id. */
  known: Map<string, PlAttachment>;
  /** A new photo: the demo keeps it in the browser; live, it is stored by the API first. */
  upload: (file: File) => PlAttachment | Promise<PlAttachment | PlProblem>;
}

function attachmentsOf(sheets: readonly PlSheetRecord[], into: Map<string, PlAttachment>): Map<string, PlAttachment> {
  for (const sh of sheets) {
    for (const d of [...sh.diesel, ...sh.trips.flatMap((t) => t.diesel)]) if (d.attachment) into.set(d.attachment.id, d.attachment);
    for (const e of [...sh.enRoute, ...sh.trips.flatMap((t) => t.enRoute)]) if (e.attachment) into.set(e.attachment.id, e.attachment);
    for (const t of sh.trips) {
      for (const p of t.purchases) for (const a of p.attachments) into.set(a.id, a);
      for (const x of t.sales) for (const a of [x.poAttachment, x.dcAttachment]) if (a) into.set(a.id, a);
    }
  }
  return into;
}

function useDemoPhotos(): Photos {
  const files = usePl((st) => st.files);
  const sheets = usePl((st) => st.sheets);
  const upload = usePl((st) => st.upload);
  const known = useMemo(() => attachmentsOf(sheets, new Map(Object.entries(files))), [files, sheets]);
  return { known, upload };
}

function useLivePhotos(): Photos {
  const sheet = useContext(SheetBeingEdited);
  const files = useUploaded((s) => s.files);
  const keep = useUploaded((s) => s.keep);
  const known = useMemo(() => attachmentsOf(sheet ? [sheet.record] : [], new Map(Object.entries(files))), [sheet, files]);
  return {
    known,
    upload: async (file) => {
      try {
        const a = await api.uploadAttachment(file);
        keep(a);
        return a;
      } catch (err) {
        return api.plProblemOf(err);
      }
    },
  };
}

export const usePhotos: () => Photos = LIVE ? useLivePhotos : useDemoPhotos;
