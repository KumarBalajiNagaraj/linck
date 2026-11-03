import { useMemo } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { can } from '@linck/domain';
import type { PlInvoiceDetail, PlInvoiceList, PlInvoicePatch, PlInvoiceTripRow, PlSheetRecord } from '@linck/mock';
import { LIVE } from '../../auth/api.js';
import { useApp } from '../../shell/store.js';
import type { Move } from '../expenses/bills.js';
import * as api from './invoiceApi.js';
import {
  INVOICE_READ,
  invoiceDetail,
  listInvoices,
  tripsToInvoice,
  useInvoices,
  useInvoiceWorld,
  type InvoiceFilter,
  type InvoiceProblem,
  type InvoiceResult,
  type TripFilter,
} from './invoiceStore.js';
import { plKey, ready, rereadPl, useLiveRead, useSettled, type Read } from './sheets.js';

/**
 * WHERE THE TRIP INVOICES COME FROM — picked once, here, by the mode, as
 * sheets.ts picks the trip sheets.
 *
 *   DEMO: invoiceStore.ts, the invoices made in the browser from the demo's
 *     trip sheets by the same rules the API applies, exactly as before.
 *   LIVE: /vehicle-pl/invoices (invoiceApi.ts), through the same cache as the
 *     trip sheets, under the same key: making, changing, issuing, cancelling
 *     or deleting an invoice, or matching money to it, changes what its trip
 *     sheets show, so after every write the invoice is kept as the API
 *     returned it and everything under Vehicle P&L is read again.
 *
 * A move answers with why it did not go through, or null.
 */

type InvoiceRead<T> = Read<T, InvoiceProblem>;

const useWho = () => useApp((s) => s.persona.key);
const useGrants = () => useApp((s) => s.persona.grants);
const mayRead = (grants: Parameters<typeof can>[0]) => can(grants, INVOICE_READ);

const NO_LIST: PlInvoiceList = { rows: [], total: { invoices: 0, total: '0.00', received: '0.00', due: '0.00' } };
const NO_TRIPS: PlInvoiceTripRow[] = [];

/* ----------------------------------------------------------------- lists */

function useDemoInvoiceList(f: InvoiceFilter): InvoiceRead<PlInvoiceList> {
  const world = useInvoiceWorld();
  const grants = useGrants();
  return ready(useMemo(() => listInvoices(world, grants, f), [world, grants, f.status, f.money, f.customerId, f.from, f.to, f.q]));
}

function useLiveInvoiceList(f: InvoiceFilter): InvoiceRead<PlInvoiceList> {
  const who = useWho();
  const grants = useGrants();
  const q = useSettled(f.q ?? '');
  const ask: api.InvoiceQuery = { status: f.status ?? null, money: f.money ?? null, customerId: f.customerId ?? null, from: f.from ?? null, to: f.to ?? null, q };
  return useLiveRead(plKey(who, 'invoices', ask), (signal) => api.fetchInvoices(ask, signal), mayRead(grants), NO_LIST, true, api.invoiceProblemOf);
}

/** The invoices at the sites this person reads that match: drafts first, then the latest issued. */
export const useInvoiceList: (f: InvoiceFilter) => InvoiceRead<PlInvoiceList> = LIVE ? useLiveInvoiceList : useDemoInvoiceList;

function useDemoTripsToInvoice(f: TripFilter): InvoiceRead<PlInvoiceTripRow[]> {
  const world = useInvoiceWorld();
  const grants = useGrants();
  return ready(useMemo(() => tripsToInvoice(world, grants, f), [world, grants, f.customerId, f.from, f.to, f.q, f.sheetId]));
}

function useLiveTripsToInvoice(f: TripFilter): InvoiceRead<PlInvoiceTripRow[]> {
  const who = useWho();
  const grants = useGrants();
  const q = useSettled(f.q ?? '');
  const ask: api.TripQuery = { customerId: f.customerId ?? null, from: f.from ?? null, to: f.to ?? null, q };
  return useLiveRead(plKey(who, 'invoice-trips', ask), (signal) => api.fetchTripsToInvoice(ask, signal), mayRead(grants), NO_TRIPS, true, api.invoiceProblemOf);
}

/** Each trip's sale lines to each customer that no live invoice bills yet, the latest first. */
export const useTripsToInvoice: (f: TripFilter) => InvoiceRead<PlInvoiceTripRow[]> = LIVE ? useLiveTripsToInvoice : useDemoTripsToInvoice;

/**
 * One sheet's trips to invoice. The API has no sheet filter, so live it is
 * asked for the sheet's own number, at its site, in its dates, and the
 * answer cut to its trips.
 */
function useLiveSheetTrips(record: PlSheetRecord): InvoiceRead<PlInvoiceTripRow[]> {
  const who = useWho();
  const grants = useGrants();
  const ask: api.TripQuery = { siteId: record.siteId, from: record.startDate, to: record.endDate, q: record.sheetNumber };
  const read = useLiveRead(plKey(who, 'invoice-trips', ask), (signal) => api.fetchTripsToInvoice(ask, signal), mayRead(grants), NO_TRIPS, false, api.invoiceProblemOf);
  const rows = useMemo(() => read.data.filter((r) => r.sheetId === record.id), [read.data, record.id]);
  return { ...read, data: rows };
}

function useDemoSheetTrips(record: PlSheetRecord): InvoiceRead<PlInvoiceTripRow[]> {
  return useDemoTripsToInvoice({ sheetId: record.id });
}

export const useSheetTripsToInvoice: (record: PlSheetRecord) => InvoiceRead<PlInvoiceTripRow[]> = LIVE ? useLiveSheetTrips : useDemoSheetTrips;

function useDemoInvoiceCustomers(_all: PlInvoiceList): { id: string; label: string }[] {
  const parties = useInvoiceWorld().parties;
  return useMemo(
    () =>
      parties
        .filter((p) => p.roles.includes('customer'))
        .map((p) => ({ id: p.id, label: p.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [parties],
  );
}

/** Live, the party master is read only by who keeps or reports on trip sheets: the customers are those with an invoice or a trip to invoice. */
function useLiveInvoiceCustomers(all: PlInvoiceList): { id: string; label: string }[] {
  const trips = useLiveTripsToInvoice({}).data;
  return useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of all.rows) seen.set(r.customerId, r.buyerName);
    for (const r of trips) if (!seen.has(r.customerId)) seen.set(r.customerId, r.customerName);
    return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [all.rows, trips]);
}

/** The customers to filter the invoices by: the demo's customer master. Live, see above. */
export const useInvoiceCustomers: (all: PlInvoiceList) => { id: string; label: string }[] = LIVE ? useLiveInvoiceCustomers : useDemoInvoiceCustomers;

/* ----------------------------------------------------------- one invoice */

function useDemoInvoice(id: string | undefined): InvoiceRead<PlInvoiceDetail | null> {
  const world = useInvoiceWorld();
  const record = world.invoices.find((x) => x.id === id) ?? null;
  return ready(useMemo(() => (record ? invoiceDetail(world, record) : null), [world, record]));
}

function useLiveInvoice(id: string | undefined): InvoiceRead<PlInvoiceDetail | null> {
  const who = useWho();
  const grants = useGrants();
  return useLiveRead<PlInvoiceDetail | null, InvoiceProblem>(
    plKey(who, 'invoice', id ?? ''),
    (signal) => api.fetchInvoice(id!, signal),
    Boolean(id) && mayRead(grants),
    null,
    false,
    api.invoiceProblemOf,
  );
}

/** One invoice, all it prints and its money; null when it is not there. */
export const useInvoice: (id: string | undefined) => InvoiceRead<PlInvoiceDetail | null> = LIVE ? useLiveInvoice : useDemoInvoice;

/* ---------------------------------------------------------------- moves */

const useWhoNamed = () => {
  const persona = useApp((s) => s.persona);
  return { name: persona.name, grants: persona.grants };
};

/** The demo store's answer, as a move answers. */
const said = (r: InvoiceResult): InvoiceProblem | null => (r.ok ? null : r.problem);

/** The invoice as the API now has it, then everything under Vehicle P&L read again. */
function keep(client: QueryClient, who: string, invoice: PlInvoiceDetail | null): void {
  if (invoice) client.setQueryData(plKey(who, 'invoice', invoice.id), invoice);
  rereadPl(client);
}

/** One write on one invoice, live. A refusal reads everything again too: the invoice may have moved on. */
function useLiveWrite<A>(send: (args: A) => Promise<PlInvoiceDetail | null>): Move<A, InvoiceProblem | null> {
  const client = useQueryClient();
  const who = useWho();
  const mutation = useMutation({ mutationFn: send });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        keep(client, who, await mutation.mutateAsync(args));
        return null;
      } catch (err) {
        rereadPl(client);
        return api.invoiceProblemOf(err);
      }
    },
  };
}

export type MakeResult = { ok: true; id: string } | { ok: false; problem: InvoiceProblem };

export interface MakeArgs {
  customerId: string;
  tripIds: string[];
}

function useDemoMake(): Move<MakeArgs, MakeResult> {
  const make = useInvoices((s) => s.make);
  const who = useWhoNamed();
  return { busy: false, run: async ({ customerId, tripIds }) => make(customerId, tripIds, who) };
}

function useLiveMake(): Move<MakeArgs, MakeResult> {
  const client = useQueryClient();
  const who = useWho();
  const mutation = useMutation({ mutationFn: (a: MakeArgs) => api.postDraft(a) });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        const made = await mutation.mutateAsync(args);
        keep(client, who, made);
        return { ok: true, id: made.id };
      } catch (err) {
        rereadPl(client);
        return { ok: false, problem: api.invoiceProblemOf(err) };
      }
    },
  };
}

/** A draft for one customer from the sale lines to them on these trips. */
export const useMakeInvoice: () => Move<MakeArgs, MakeResult> = LIVE ? useLiveMake : useDemoMake;

export interface InvoiceMoves {
  patch: Move<{ id: string; patch: PlInvoicePatch }, InvoiceProblem | null>;
  issue: Move<string, InvoiceProblem | null>;
  cancel: Move<{ id: string; reason: string }, InvoiceProblem | null>;
  remove: Move<string, InvoiceProblem | null>;
  /** Every payment on its trips by the rule (`paymentId` null), or one. */
  match: Move<{ id: string; paymentId: string | null }, InvoiceProblem | null>;
  unmatch: Move<{ id: string; receiptId: string }, InvoiceProblem | null>;
}

function useDemoInvoiceMoves(): InvoiceMoves {
  const store = useInvoices();
  const who = useWhoNamed();
  const move = <A>(run: (a: A) => InvoiceResult): Move<A, InvoiceProblem | null> => ({ busy: false, run: async (a) => said(run(a)) });
  return {
    patch: move(({ id, patch }) => store.patch(id, patch, who)),
    issue: move((id) => store.issue(id, who)),
    cancel: move(({ id, reason }) => store.cancel(id, reason, who)),
    remove: move((id) => store.remove(id, who)),
    match: move(({ id, paymentId }) => store.match(id, paymentId ? { paymentId } : {}, who)),
    unmatch: move(({ id, receiptId }) => store.unmatch(id, receiptId, who)),
  };
}

function useLiveInvoiceMoves(): InvoiceMoves {
  const client = useQueryClient();
  const who = useWho();
  // The money moved, not the invoice: ReceiptsOut goes onto the invoice as it is cached.
  const withMoney = async (id: string, money: Promise<Parameters<typeof api.withReceipts>[1]>) => {
    const m = await money;
    const had = client.getQueryData<PlInvoiceDetail>(plKey(who, 'invoice', id));
    return had ? api.withReceipts(had, m) : null;
  };
  const removed = async (id: string) => {
    await api.deleteDraft(id);
    client.removeQueries({ queryKey: plKey(who, 'invoice', id) });
    return null;
  };
  return {
    patch: useLiveWrite(({ id, patch }: { id: string; patch: PlInvoicePatch }) => api.patchDraft(id, patch)),
    issue: useLiveWrite((id: string) => api.issueInvoice(id)),
    cancel: useLiveWrite(({ id, reason }: { id: string; reason: string }) => api.cancelInvoice(id, reason)),
    remove: useLiveWrite((id: string) => removed(id)),
    match: useLiveWrite(({ id, paymentId }: { id: string; paymentId: string | null }) => withMoney(id, api.matchMoney(id, paymentId ? { paymentId } : {}))),
    unmatch: useLiveWrite(({ id, receiptId }: { id: string; receiptId: string }) => withMoney(id, api.unmatchMoney(id, receiptId))),
  };
}

/** What may still be done with an invoice. */
export const useInvoiceMoves: () => InvoiceMoves = LIVE ? useLiveInvoiceMoves : useDemoInvoiceMoves;
