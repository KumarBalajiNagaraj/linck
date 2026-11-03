import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlInvoiceReceipts } from '@linck/mock';
import {
  cancelInvoice,
  deleteDraft,
  fetchInvoices,
  fetchTripsToInvoice,
  invoiceProblem,
  invoiceProblemOf,
  InvoiceRefused,
  issueInvoice,
  matchMoney,
  patchDraft,
  postDraft,
  unmatchMoney,
  withReceipts,
} from './invoiceApi.js';
import { invoiceDetail, useInvoices, type InvoiceProblem } from './invoiceStore.js';
import { invoiceProblemText } from './invoiceText.js';
import { invoiceWords } from './invoiceWords.js';
import { readRefusal } from './plApi.js';
import { usePl } from './plStore.js';

/*
 * Live, the trip invoice screens read /vehicle-pl/invoices
 * (apps/api/app/api/party_invoices.py) where the demo reads invoiceStore.ts.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, problem: Record<string, unknown>) => json(status, { detail: { problem } });
const read = async (res: Response) => invoiceProblem(await readRefusal(res));

/** One of the demo's issued invoices, as the store answers it: shaped as InvoiceOut (apiShapes.test.ts). */
function anIssued() {
  const s = useInvoices.getState();
  const pl = usePl.getState();
  const world = { sheets: pl.sheets, parties: pl.parties, materials: pl.materials, invoices: s.invoices, receipts: s.receipts, series: s.series };
  const rec = s.invoices.find((x) => x.status === 'issued' && s.receipts.some((r) => r.invoiceId === x.id))!;
  return invoiceDetail(world, rec);
}

describe('an invoice after its money moved', () => {
  it('takes the money as the API answers it, and nothing else', () => {
    const inv = anIssued();
    const money: PlInvoiceReceipts = { invoiceId: inv.id, total: inv.total, received: '0.00', due: inv.total, moneyStatus: 'due', receipts: [], unmatched: [] };
    const after = withReceipts(inv, money);
    expect(after).toEqual({ ...inv, received: '0.00', due: inv.total, moneyStatus: 'due', receipts: [], unmatched: [] });
    // Another invoice's money is never put on this one.
    expect(withReceipts(inv, { ...money, invoiceId: 'someone-else' })).toBe(inv);
  });
});

describe('an invoice request on its way', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (res: () => Response) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => res());
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const sent = (fetch: ReturnType<typeof answering>, i: number) => ({ url: fetch.mock.calls[i]![0], method: fetch.mock.calls[i]![1]?.method ?? 'GET', body: fetch.mock.calls[i]![1]?.body ? JSON.parse(String(fetch.mock.calls[i]![1]!.body)) : null });

  it('asks for the list and the trips with the filter in the query', async () => {
    const fetch = answering(() => json(200, { rows: [], total: { invoices: 0, total: '0.00', received: '0.00', due: '0.00' } }));
    await fetchInvoices({ status: 'issued', money: 'due', customerId: 'c1', from: '2026-04-01', to: null, q: ' KBM ' });
    expect(sent(fetch, 0)).toEqual({ url: 'http://localhost:8000/vehicle-pl/invoices?status=issued&money=due&customerId=c1&from=2026-04-01&q=KBM', method: 'GET', body: null });
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { rows: [{ tripId: 't1' }] })));
    expect(await fetchTripsToInvoice({ siteId: 's1', q: 'TS/26-27/0001' })).toEqual([{ tripId: 't1' }]);
  });

  it('makes, changes, issues, cancels and deletes as the API takes each', async () => {
    const inv = anIssued();
    const fetch = answering(() => json(200, inv));
    await postDraft({ customerId: 'c1', tripIds: ['t1', 't2'] });
    await patchDraft('i1', { notes: 'PO 4471/26' });
    await issueInvoice('i1');
    await cancelInvoice('i1', 'Wrong rate on the DC');
    expect(sent(fetch, 0)).toEqual({ url: 'http://localhost:8000/vehicle-pl/invoices', method: 'POST', body: { customerId: 'c1', tripIds: ['t1', 't2'] } });
    expect(sent(fetch, 1)).toEqual({ url: 'http://localhost:8000/vehicle-pl/invoices/i1', method: 'PATCH', body: { notes: 'PO 4471/26' } });
    expect(sent(fetch, 2)).toEqual({ url: 'http://localhost:8000/vehicle-pl/invoices/i1/issue', method: 'POST', body: null });
    expect(sent(fetch, 3)).toEqual({ url: 'http://localhost:8000/vehicle-pl/invoices/i1/cancel', method: 'POST', body: { reason: 'Wrong rate on the DC' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await deleteDraft('i1')).toBeNull();
  });

  it('matches money, all or one payment, and lets a match go', async () => {
    const money: PlInvoiceReceipts = { invoiceId: 'i1', total: '100.00', received: '100.00', due: '0.00', moneyStatus: 'paid', receipts: [], unmatched: [] };
    const fetch = answering(() => json(200, money));
    expect(await matchMoney('i1', {})).toEqual(money);
    await matchMoney('i1', { paymentId: 'p1' });
    await unmatchMoney('i1', 'r1');
    expect(sent(fetch, 0)).toEqual({ url: 'http://localhost:8000/vehicle-pl/invoices/i1/receipts', method: 'POST', body: {} });
    expect(sent(fetch, 1).body).toEqual({ paymentId: 'p1' });
    expect(sent(fetch, 2)).toEqual({ url: 'http://localhost:8000/vehicle-pl/invoices/i1/receipts/r1', method: 'DELETE', body: null });
  });

  it('carries a refusal as its problem', async () => {
    answering(() => refusal(403, { code: 'needs-permission', permission: 'sales.invoice.cancel' }));
    const err = await cancelInvoice('i1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceRefused);
    expect(invoiceProblemOf(err)).toEqual({ code: 'needs-permission', permission: 'sales.invoice.cancel' });
    expect(invoiceProblemOf(new Error('boom'))).toEqual({ code: 'server', status: 0 });
  });
});

describe('a refusal from /vehicle-pl/invoices, in the screens’ vocabulary', () => {
  it('reads every refusal the invoice service gives', async () => {
    const cases: [number, Record<string, unknown>, InvoiceProblem][] = [
      [403, { code: 'needs-permission', permission: 'sales.invoice.write' }, { code: 'needs-permission', permission: 'sales.invoice.write' }],
      [422, { code: 'invalid', field: 'tripIds[0]', reason: 'no such trip' }, { code: 'invalid', field: 'tripIds[0]', reason: 'no such trip' }],
      [409, { code: 'trips-other-site' }, { code: 'trips-other-site' }],
      [409, { code: 'trip-not-for-customer', tripNumber: 'TRP/26-27/0002' }, { code: 'trip-not-for-customer', tripNumber: 'TRP/26-27/0002' }],
      [409, { code: 'sale-on-invoice', tripNumber: 'TRP/1', invoiceId: 'i', invoiceNumber: null, status: 'draft' }, { code: 'sale-on-invoice', tripNumber: 'TRP/1', invoiceId: 'i', invoiceNumber: null, status: 'draft' }],
      // Two drafts raced for one line: told without the trip.
      [409, { code: 'sale-on-invoice' }, { code: 'invoice-changed' }],
      [409, { code: 'sale-not-gst', tripNumber: 'TRP/1' }, { code: 'sale-not-gst', tripNumber: 'TRP/1' }],
      [409, { code: 'sale-billed-outside', tripNumber: 'TRP/1', invoiceNumber: 'OUT/9' }, { code: 'sale-billed-outside', tripNumber: 'TRP/1', invoiceNumber: 'OUT/9' }],
      [409, { code: 'sale-no-hsn', tripNumber: 'TRP/1' }, { code: 'sale-no-hsn', tripNumber: 'TRP/1' }],
      [409, { code: 'site-no-gstin', siteId: 's1', siteName: 'Vangal crusher plant' }, { code: 'site-no-gstin', siteId: 's1', siteName: 'Vangal crusher plant' }],
      [409, { code: 'seller-gstin-wrong', gstin: '99AAAAA0000A1Z5' }, { code: 'seller-gstin-wrong', gstin: '99AAAAA0000A1Z5' }],
      [409, { code: 'buyer-gstins-differ', gstins: ['33A', '33B'] }, { code: 'buyer-gstins-differ', gstins: ['33A', '33B'] }],
      [409, { code: 'places-differ', states: ['29', '33'] }, { code: 'places-differ', states: ['29', '33'] }],
      [409, { code: 'not-a-draft', status: 'issued', invoiceNumber: 'KBM/26-27/0001' }, { code: 'not-a-draft', status: 'issued', invoiceNumber: 'KBM/26-27/0001' }],
      [409, { code: 'not-issued', status: 'draft' }, { code: 'not-issued', status: 'draft' }],
      [409, { code: 'already-cancelled', invoiceNumber: 'KBM/26-27/0001' }, { code: 'already-cancelled', invoiceNumber: 'KBM/26-27/0001' }],
      [409, { code: 'invoice-changed' }, { code: 'invoice-changed' }],
      [409, { code: 'series-full', gstin: '33G', financialYear: '26-27' }, { code: 'series-full', gstin: '33G', financialYear: '26-27' }],
      [409, { code: 'payment-matched' }, { code: 'payment-matched' }],
      [409, { code: 'invoice-paid' }, { code: 'invoice-paid' }],
      [409, { code: 'too-much', free: '500.00', due: '200.00' }, { code: 'too-much', free: '500.00', due: '200.00' }],
      [404, { code: 'invoice-gone' }, { code: 'invoice-gone' }],
      [404, { code: 'receipt-gone' }, { code: 'receipt-gone' }],
    ];
    for (const [status, problem, want] of cases) expect(await read(refusal(status, problem)), String(problem.code)).toEqual(want);
  });

  it('reads a lapsed session, no answer, a shape check, a fault, and what this app cannot word', async () => {
    expect(await read(json(401, { detail: 'not signed in' }))).toEqual({ code: 'signed-out' });
    expect(invoiceProblem({ status: 0, problem: null, shape: null })).toEqual({ code: 'offline' });
    expect(await read(json(422, { detail: [{ type: 'string_too_short', loc: ['body', 'reason'], msg: 'String should have at least 1 character', input: '' }] }))).toEqual({
      code: 'invalid',
      field: 'reason',
      reason: 'required',
    });
    expect(await read(new Response('Not Found', { status: 404 }))).toEqual({ code: 'invoice-gone' });
    expect(await read(new Response('<html>Bad gateway</html>', { status: 502 }))).toEqual({ code: 'server', status: 502 });
    expect(await read(refusal(409, { code: 'something-new' }))).toEqual({ code: 'server', status: 409 });
    expect(await read(refusal(409, { code: 'not-a-draft', status: 'lost' }))).toEqual({ code: 'server', status: 409 });
    expect(await read(refusal(409, { code: 'places-differ', states: 'no' }))).toEqual({ code: 'server', status: 409 });
    expect(await read(refusal(409, { code: 'too-much', free: '1.00' }))).toEqual({ code: 'server', status: 409 });
  });
});

describe('a refused invoice, in words', () => {
  const TAMIL = /[஀-௿]/;
  const every: InvoiceProblem[] = [
    { code: 'needs-permission', permission: 'sales.invoice.write' },
    { code: 'needs-permission', permission: 'sales.invoice.cancel' },
    { code: 'needs-permission', permission: 'finance.receipt.verify' },
    { code: 'needs-permission', permission: 'sales.invoice.read' },
    { code: 'invalid', field: 'reason', reason: 'required' },
    { code: 'invalid', field: 'placeOfSupply', reason: 'not a state' },
    { code: 'invalid', field: 'amount', reason: 'more than zero' },
    { code: 'invalid', field: 'tripIds[0]', reason: 'no such trip' },
    { code: 'trips-other-site' },
    { code: 'trip-not-for-customer', tripNumber: 'TRP/1' },
    { code: 'sale-on-invoice', tripNumber: 'TRP/1', invoiceId: 'i', invoiceNumber: 'KBM/26-27/0001', status: 'issued' },
    { code: 'sale-not-gst', tripNumber: 'TRP/1' },
    { code: 'sale-billed-outside', tripNumber: 'TRP/1', invoiceNumber: 'OUT/9' },
    { code: 'sale-no-hsn', tripNumber: 'TRP/1' },
    { code: 'site-no-gstin', siteId: 's', siteName: 'Vangal crusher plant' },
    { code: 'buyer-gstins-differ', gstins: ['33A', '33B'] },
    { code: 'places-differ', states: ['29', '33'] },
    { code: 'not-a-draft', status: 'issued', invoiceNumber: 'KBM/26-27/0001' },
    { code: 'not-issued', status: 'draft' },
    { code: 'already-cancelled', invoiceNumber: 'KBM/26-27/0001' },
    { code: 'series-full', gstin: '33G', financialYear: '26-27' },
    { code: 'payment-matched' },
    { code: 'invoice-paid' },
    { code: 'too-much', free: '500.00', due: '200.00' },
    { code: 'invoice-gone' },
    { code: 'receipt-gone' },
    { code: 'seller-gstin-wrong', gstin: '99AAAAA0000A1Z5' },
    { code: 'invoice-changed' },
    { code: 'signed-out' },
    { code: 'offline' },
    { code: 'server', status: 500 },
  ];

  it('words every refusal in English and in Tamil', () => {
    for (const p of every) {
      const en = invoiceProblemText(p, invoiceWords.en);
      const ta = invoiceProblemText(p, invoiceWords.ta);
      expect(en, p.code).toMatch(/\w/);
      expect(ta, p.code).toMatch(TAMIL);
      expect(`${en} ${ta}`).not.toContain('undefined');
    }
  });

  it('says who may cancel, in both languages: the refusal a fleet manager meets', () => {
    const cancel: InvoiceProblem = { code: 'needs-permission', permission: 'sales.invoice.cancel' };
    expect(invoiceProblemText(cancel, invoiceWords.en)).toBe('Only accounts can cancel an invoice.');
    expect(invoiceProblemText(cancel, invoiceWords.ta)).toBe('கணக்குப் பிரிவு மட்டுமே இன்வாய்ஸை ரத்து செய்யலாம்.');
  });

  it('words the live-only ones', () => {
    expect(invoiceProblemText({ code: 'seller-gstin-wrong', gstin: '99X' }, invoiceWords.en)).toBe("The site's GSTIN 99X is wrong. Fix it first.");
    expect(invoiceProblemText({ code: 'invoice-changed' }, invoiceWords.ta)).toBe('இதற்கிடையில் ட்ரிப்கள் மாறின. மீண்டும் திறக்கவும்.');
    expect(invoiceProblemText({ code: 'server', status: 502 }, invoiceWords.en)).toBe('Linck had a problem (error 502). Try again.');
  });
});
