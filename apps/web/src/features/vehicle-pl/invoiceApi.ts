import type { PlInvoiceDetail, PlInvoiceList, PlInvoicePatch, PlInvoiceReceipts, PlInvoiceStatus, PlInvoiceTripRow } from '@linck/mock';
import type { InvoiceProblem } from './invoiceStore.js';
import { query, readJson, request, sendJson, textOf, type Refusal } from './plApi.js';

/**
 * THE TRIP INVOICES ON THE API, for live mode (VITE_API_URL set).
 *
 *   GET    /vehicle-pl/invoices                     invoices, searched and filtered, with their total
 *   GET    /vehicle-pl/invoices/trips               trips' sale lines no live invoice bills yet
 *   POST   /vehicle-pl/invoices                     a draft, for one customer, from trip ids
 *   GET    /vehicle-pl/invoices/{id}                one invoice: all it prints, its money
 *   PATCH  /vehicle-pl/invoices/{id}                a draft's addresses, place of supply, note
 *   DELETE /vehicle-pl/invoices/{id}                a draft that was never issued
 *   POST   /vehicle-pl/invoices/{id}/issue          it takes the next number
 *   POST   /vehicle-pl/invoices/{id}/cancel         kept on record, cancelled, with a reason
 *   POST   /vehicle-pl/invoices/{id}/receipts       money paid on its trips matched to it: all, or one
 *   DELETE /vehicle-pl/invoices/{id}/receipts/{rid} one match let go
 *
 * (apps/api/app/api/party_invoices.py, schemas/party_invoices.py.) The demo
 * store (invoiceStore.ts) is shaped field for field like these answers, and
 * apiShapes.test.ts holds the two together, so the screens read one shape in
 * both modes and nothing is mapped on the way in but the money after a match,
 * which the API answers apart from the invoice (`withReceipts`).
 *
 * Every refusal comes back as an InvoiceProblem, the demo store's vocabulary,
 * so the screens word a live refusal as they word the demo's. No React here.
 */

const server = (status: number): InvoiceProblem => ({ code: 'server', status });

const STATUSES: readonly string[] = ['draft', 'issued', 'cancelled'];

/** The API's refusal (services/party_invoices.py) as the InvoiceProblem it means; a known code it cannot word is a fault. */
function knownInvoice(p: Record<string, unknown>, status: number): InvoiceProblem {
  const s = (key: string) => textOf(p, key);
  const tripNumber = s('tripNumber');
  const list = (key: string) => (Array.isArray(p[key]) && (p[key] as unknown[]).every((x) => typeof x === 'string') ? (p[key] as string[]) : null);
  switch (p.code) {
    case 'needs-permission': {
      const permission = s('permission');
      return permission ? { code: 'needs-permission', permission } : server(status);
    }
    case 'invalid':
      return { code: 'invalid', field: s('field') ?? '', reason: s('reason') ?? '' };
    case 'trips-other-site':
      return { code: 'trips-other-site' };
    case 'trip-not-for-customer':
      return tripNumber !== null ? { code: 'trip-not-for-customer', tripNumber } : server(status);
    case 'sale-on-invoice': {
      // Told without the trip only when two drafts raced for one line: the trips changed meanwhile.
      const invoiceId = s('invoiceId');
      const at = s('status');
      if (tripNumber === null || invoiceId === null || at === null) return { code: 'invoice-changed' };
      return { code: 'sale-on-invoice', tripNumber, invoiceId, invoiceNumber: s('invoiceNumber'), status: at };
    }
    case 'sale-not-gst':
      return tripNumber !== null ? { code: 'sale-not-gst', tripNumber } : server(status);
    case 'sale-billed-outside': {
      const number = s('invoiceNumber');
      return tripNumber !== null && number !== null ? { code: 'sale-billed-outside', tripNumber, invoiceNumber: number } : server(status);
    }
    case 'sale-no-hsn':
      return tripNumber !== null ? { code: 'sale-no-hsn', tripNumber } : server(status);
    case 'site-no-gstin':
      return { code: 'site-no-gstin', siteId: s('siteId') ?? '', siteName: s('siteName') ?? '' };
    case 'seller-gstin-wrong':
      return { code: 'seller-gstin-wrong', gstin: s('gstin') ?? '' };
    case 'buyer-gstins-differ': {
      const gstins = list('gstins');
      return gstins ? { code: 'buyer-gstins-differ', gstins } : server(status);
    }
    case 'places-differ': {
      const states = list('states');
      return states ? { code: 'places-differ', states } : server(status);
    }
    case 'not-a-draft': {
      const at = s('status');
      return at !== null && STATUSES.includes(at) ? { code: 'not-a-draft', status: at, invoiceNumber: s('invoiceNumber') } : server(status);
    }
    case 'not-issued': {
      const at = s('status');
      return at !== null && STATUSES.includes(at) ? { code: 'not-issued', status: at } : server(status);
    }
    case 'already-cancelled':
      return { code: 'already-cancelled', invoiceNumber: s('invoiceNumber') };
    case 'invoice-changed':
      return { code: 'invoice-changed' };
    case 'series-full':
      return { code: 'series-full', gstin: s('gstin') ?? '', financialYear: s('financialYear') ?? '' };
    case 'payment-matched':
      return { code: 'payment-matched' };
    case 'invoice-paid':
      return { code: 'invoice-paid' };
    case 'too-much': {
      const free = s('free');
      const due = s('due');
      return free !== null && due !== null ? { code: 'too-much', free, due } : server(status);
    }
    case 'invoice-gone':
    case 'not-found':
      return { code: 'invoice-gone' };
    case 'receipt-gone':
      return { code: 'receipt-gone' };
    default:
      return server(status);
  }
}

/** Why the API said no to an invoice request, in the screens' own vocabulary. */
export function invoiceProblem(r: Refusal): InvoiceProblem {
  if (r.status === 0) return { code: 'offline' };
  if (r.status === 401) return { code: 'signed-out' };
  if (r.problem) return knownInvoice(r.problem, r.status);
  const first = r.shape?.[0];
  if (first) return { code: 'invalid', field: first.field, reason: first.reason };
  if (r.status === 404) return { code: 'invoice-gone' };
  return server(r.status);
}

/** An invoice request the API refused, carried as the problem it means. */
export class InvoiceRefused extends Error {
  constructor(readonly problem: InvoiceProblem) {
    super(problem.code);
    this.name = 'InvoiceRefused';
  }
}

export function invoiceProblemOf(err: unknown): InvoiceProblem {
  return err instanceof InvoiceRefused ? err.problem : server(0);
}

const inv = <T>(path: string, init: RequestInit, read: (body: unknown) => T) =>
  request(`/vehicle-pl/invoices${path}`, init, read, (r) => new InvoiceRefused(invoiceProblem(r)));

const id = encodeURIComponent;

/* --------------------------------------------------------------- requests */

/** What the list is cut to: invoiceStore's InvoiceFilter, as the API's query takes it. */
export interface InvoiceQuery {
  status?: PlInvoiceStatus | null;
  money?: 'due' | 'paid' | null;
  customerId?: string | null;
  siteId?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
}

export function fetchInvoices(f: InvoiceQuery, signal?: AbortSignal): Promise<PlInvoiceList> {
  const path = query({ status: f.status, money: f.money, customerId: f.customerId, siteId: f.siteId, from: f.from, to: f.to, q: f.q });
  return inv(path, readJson(signal), (b) => b as PlInvoiceList);
}

/** What the trips to invoice are cut to. The API has no sheet filter: a sheet's are asked for by its number, site and dates. */
export interface TripQuery {
  customerId?: string | null;
  siteId?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
}

/** InvoiceTripsOut. */
export interface TripsAnswer {
  rows: PlInvoiceTripRow[];
}

export function fetchTripsToInvoice(f: TripQuery, signal?: AbortSignal): Promise<PlInvoiceTripRow[]> {
  const path = `/trips${query({ customerId: f.customerId, siteId: f.siteId, from: f.from, to: f.to, q: f.q })}`;
  return inv(path, readJson(signal), (b) => (b as TripsAnswer).rows);
}

export function fetchInvoice(invoiceId: string, signal?: AbortSignal): Promise<PlInvoiceDetail> {
  return inv(`/${id(invoiceId)}`, readJson(signal), (b) => b as PlInvoiceDetail);
}

/** InvoiceIn: one customer, and the trips whose sale lines to them it bills. */
export interface DraftBody {
  customerId: string;
  tripIds: string[];
}

export function postDraft(body: DraftBody): Promise<PlInvoiceDetail> {
  return inv('', sendJson('POST', body), (b) => b as PlInvoiceDetail);
}

/** InvoicePatch is the page's PlInvoicePatch, field for field. */
export function patchDraft(invoiceId: string, body: PlInvoicePatch): Promise<PlInvoiceDetail> {
  return inv(`/${id(invoiceId)}`, sendJson('PATCH', body), (b) => b as PlInvoiceDetail);
}

export function deleteDraft(invoiceId: string): Promise<null> {
  return inv(`/${id(invoiceId)}`, { method: 'DELETE' }, () => null);
}

export function issueInvoice(invoiceId: string): Promise<PlInvoiceDetail> {
  return inv(`/${id(invoiceId)}/issue`, { method: 'POST', headers: { Accept: 'application/json' } }, (b) => b as PlInvoiceDetail);
}

/** CancelIn. */
export interface CancelBody {
  reason: string;
}

export function cancelInvoice(invoiceId: string, reason: string): Promise<PlInvoiceDetail> {
  const body: CancelBody = { reason };
  return inv(`/${id(invoiceId)}/cancel`, sendJson('POST', body), (b) => b as PlInvoiceDetail);
}

/** MatchIn: every payment on its trips by the rule, or one, up to `amount`. */
export interface MatchBody {
  paymentId?: string | null;
  amount?: string | null;
}

export function matchMoney(invoiceId: string, body: MatchBody): Promise<PlInvoiceReceipts> {
  return inv(`/${id(invoiceId)}/receipts`, sendJson('POST', body), (b) => b as PlInvoiceReceipts);
}

export function unmatchMoney(invoiceId: string, receiptId: string): Promise<PlInvoiceReceipts> {
  return inv(`/${id(invoiceId)}/receipts/${id(receiptId)}`, { method: 'DELETE' }, (b) => b as PlInvoiceReceipts);
}

/* ------------------------------------------------------------ the mapping */

/** The invoice after its money moved: ReceiptsOut is the money part of InvoiceOut, field for field. */
export function withReceipts(invoice: PlInvoiceDetail, money: PlInvoiceReceipts): PlInvoiceDetail {
  if (money.invoiceId !== invoice.id) return invoice;
  return {
    ...invoice,
    total: money.total,
    received: money.received,
    due: money.due,
    moneyStatus: money.moneyStatus,
    receipts: money.receipts,
    unmatched: money.unmatched,
  };
}
