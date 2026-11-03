import { describe, expect, it } from 'vitest';
import { isInvoiceNumber, type Grants } from '@linck/domain';
import type { PlInvoiceTripRow, PlSheetInput, PlSheetRecord } from '@linck/mock';
import {
  cancelInvoice,
  checkSheet,
  deleteDraft,
  INVOICE_CANCEL,
  INVOICE_READ,
  INVOICE_WRITE,
  invoiceDetail,
  issueDraft,
  liveInvoices,
  makeDraft,
  matchMoney,
  patchDraft,
  receiptsOf,
  RECEIVE,
  tripsToInvoice,
  unmatchMoney,
  useInvoices,
  type InvoiceProblem,
  type World,
} from './invoiceStore.js';
import { invoiceProblemText } from './invoiceText.js';
import { invoiceWords } from './invoiceWords.js';
import { usePl } from './plStore.js';

/*
 * The demo store answers as /vehicle-pl/invoices does (the API's own tests
 * hold the database to the same rules): one customer's trips at one site make
 * a draft; issuing takes the next number of the seller's series, with no gaps
 * and no repeats; cancelling keeps the number and frees the trips; only a
 * draft is deleted; a sale line is on one live invoice at most, and stays as
 * billed on its trip sheet while it is.
 */

const all = { orgWide: true, siteIds: [] as string[] };
const GRANTS: Grants = Object.fromEntries([INVOICE_READ, INVOICE_WRITE, INVOICE_CANCEL, RECEIVE].map((k) => [k, all]));
const WHO = { name: 'Lakshmi N', grants: GRANTS };
const AT = '2026-08-08T09:30:00.000Z';
const DAY = '2026-08-08';

function blank(): World {
  const pl = usePl.getState();
  return { sheets: pl.sheets, parties: pl.parties, materials: pl.materials, invoices: [], receipts: [], series: {} };
}

/** Ready rows of one customer at one site, as many as there are, at least `n`. */
function pick(world: World, n: number, where: (r: PlInvoiceTripRow) => boolean = () => true): PlInvoiceTripRow[] {
  const rows = tripsToInvoice(world, GRANTS, {}).filter((r) => r.blocked === null && where(r));
  const groups = new Map<string, PlInvoiceTripRow[]>();
  for (const r of rows) groups.set(`${r.siteId}|${r.customerId}`, [...(groups.get(`${r.siteId}|${r.customerId}`) ?? []), r]);
  const group = [...groups.values()].find((g) => new Set(g.map((r) => r.tripId)).size >= n);
  if (!group) throw new Error(`no ${n} trips of one customer`);
  return group.slice(0, n);
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify((r as unknown as { problem: InvoiceProblem }).problem)}`);
  return r as Extract<T, { ok: true }>;
}

function refused(r: { ok: boolean }): InvoiceProblem {
  expect(r.ok).toBe(false);
  return (r as { ok: false; problem: InvoiceProblem }).problem;
}

describe("the demo's own invoices", () => {
  const { invoices } = useInvoices.getState();

  it('number each series from 1, in date order, with no gaps and no repeats', () => {
    const bySeries = new Map<string, { serial: number; date: string }[]>();
    for (const inv of invoices) {
      if (inv.status === 'draft') continue;
      const key = `${inv.registrationId}:${inv.financialYear}`;
      bySeries.set(key, [...(bySeries.get(key) ?? []), { serial: inv.serial!, date: inv.invoiceDate! }]);
      expect(isInvoiceNumber(inv.invoiceNumber!), inv.invoiceNumber!).toBe(true);
    }
    expect(bySeries.size).toBe(2);
    for (const [key, rows] of bySeries) {
      const sorted = [...rows].sort((a, b) => a.serial - b.serial);
      expect(sorted.map((r) => r.serial), key).toEqual(sorted.map((_, i) => i + 1));
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.date >= sorted[i - 1]!.date, key).toBe(true);
    }
  });

  it('bill each sale line on one live invoice at most, and keep the cancelled one on record', () => {
    const seen = new Set<string>();
    for (const inv of invoices.filter((x) => x.status !== 'cancelled')) {
      for (const line of inv.lines) {
        expect(seen.has(line.tripSaleId!), line.tripSaleId!).toBe(false);
        seen.add(line.tripSaleId!);
      }
    }
    const cancelled = invoices.filter((x) => x.status === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.invoiceNumber).toMatch(/^[A-Z]{3}\/26-27\/0001$/);
    expect(invoices.filter((x) => x.status === 'draft')).toHaveLength(1);
  });

  it('have ids in the order they were made, not the clock’s, so a link to one holds on every load', () => {
    expect(invoices.every((x) => /^inv-\d{5}$/.test(x.id))).toBe(true);
    const order = invoices.map((x) => Number(x.id.slice(4)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('a draft', () => {
  it('bills one customer’s trips at one site, with no number until issued', () => {
    const world = blank();
    const trips = pick(world, 2);
    const made = ok(makeDraft(world, trips[0]!.customerId, trips.map((t) => t.tripId), WHO, AT));
    const draft = made.world.invoices.find((x) => x.id === made.id)!;
    expect(draft.status).toBe('draft');
    expect(draft.invoiceNumber).toBeNull();
    expect(new Set(draft.lines.map((l) => l.tripNumber))).toEqual(new Set(trips.map((t) => t.tripNumber)));
    expect(draft.seller.gstin.slice(0, 2)).toBe('33');
  });

  it('refuses trips at two sites, trips with no sale to the customer, and lines already on a live invoice', () => {
    const world = blank();
    const a = pick(world, 1, (r) => r.siteId === 'site-krp')[0]!;
    const b = tripsToInvoice(world, GRANTS, {}).find((r) => r.blocked === null && r.siteId === 'site-tvl' && r.customerId === a.customerId);
    if (b) expect(refused(makeDraft(world, a.customerId, [a.tripId, b.tripId], WHO, AT)).code).toBe('trips-other-site');
    const other = tripsToInvoice(world, GRANTS, {}).find((r) => r.siteId === a.siteId && !world.sheets.flatMap((s) => s.trips).find((t) => t.id === r.tripId)!.sales.some((s) => s.customerId === a.customerId));
    expect(other).toBeDefined();
    expect(refused(makeDraft(world, a.customerId, [other!.tripId], WHO, AT))).toMatchObject({ code: 'trip-not-for-customer', tripNumber: other!.tripNumber });
    const first = ok(makeDraft(world, a.customerId, [a.tripId], WHO, AT));
    expect(refused(makeDraft(first.world, a.customerId, [a.tripId], WHO, AT))).toMatchObject({ code: 'sale-on-invoice', invoiceId: first.id, status: 'draft' });
  });

  it('refuses a sale billed without GST or outside Linck', () => {
    const world = blank();
    for (const [blocked, code] of [
      ['not-gst', 'sale-not-gst'],
      ['billed-outside', 'sale-billed-outside'],
    ] as const) {
      const row = tripsToInvoice(world, GRANTS, {}).find((r) => r.blocked === blocked);
      expect(row, blocked).toBeDefined();
      expect(refused(makeDraft(world, row!.customerId, [row!.tripId], WHO, AT)).code).toBe(code);
    }
  });

  it('is made only where the person may write invoices', () => {
    const world = blank();
    const tvl = pick(world, 1, (r) => r.siteId === 'site-tvl')[0]!;
    const krpOnly = { name: 'Anbu Selvan M', grants: { [INVOICE_WRITE]: { orgWide: false, siteIds: ['site-krp'] } } };
    expect(refused(makeDraft(world, tvl.customerId, [tvl.tripId], krpOnly, AT))).toEqual({ code: 'needs-permission', permission: INVOICE_WRITE });
  });

  it('takes CGST + SGST within Tamil Nadu, IGST to Puducherry, and IGST when told another state', () => {
    const world = blank();
    const ready = tripsToInvoice(world, GRANTS, {}).filter((r) => r.blocked === null);
    // Alliance Infra takes its loads at its Puducherry site (state 34); Radiance Realty at Navalur (33).
    const pondy = ready.find((r) => r.customerId === 'cus-05');
    const local = ready.find((r) => r.customerId === 'cus-03');
    expect(pondy && local).toBeTruthy();
    const inter = ok(makeDraft(world, 'cus-05', [pondy!.tripId], WHO, AT));
    const interDraft = inter.world.invoices.find((x) => x.id === inter.id)!;
    expect(interDraft).toMatchObject({ placeOfSupply: '34', posBasis: 'delivery_location', supplyType: 'inter', cgst: '0.00', sgst: '0.00' });
    expect(Number(interDraft.igst)).toBeGreaterThan(0);
    const intra = ok(makeDraft(world, 'cus-03', [local!.tripId], WHO, AT));
    const intraDraft = intra.world.invoices.find((x) => x.id === intra.id)!;
    expect(intraDraft).toMatchObject({ placeOfSupply: '33', supplyType: 'intra', igst: '0.00' });
    expect(intraDraft.cgst).toBe(intraDraft.sgst);
    const told = ok(patchDraft(intra.world, intra.id, { placeOfSupply: '29' }, WHO));
    expect(told.world.invoices.find((x) => x.id === intra.id)).toMatchObject({ placeOfSupply: '29', posBasis: 'chosen', supplyType: 'inter', cgst: '0.00' });
  });
});

describe('issue, cancel and delete', () => {
  it('issues the next number of the seller’s series; each GSTIN counts on its own', () => {
    let world = blank();
    const krp = pick(world, 2, (r) => r.siteId === 'site-krp');
    const tvl = pick(world, 1, (r) => r.siteId === 'site-tvl');
    const numbers: string[] = [];
    for (const trips of [krp.slice(0, 1), tvl, krp.slice(1, 2)]) {
      const made = ok(makeDraft(world, trips[0]!.customerId, trips.map((t) => t.tripId), WHO, AT));
      const issued = ok(issueDraft(made.world, made.id, WHO, DAY, AT));
      world = issued.world;
      numbers.push(world.invoices.find((x) => x.id === made.id)!.invoiceNumber!);
    }
    expect(numbers).toEqual(['KBM/26-27/0001', 'TAL/26-27/0001', 'KBM/26-27/0002']);
  });

  it('deletes only a draft, cancels only an issued invoice, and a cancel frees its trips for a new number', () => {
    const world = blank();
    const trips = pick(world, 2);
    const made = ok(makeDraft(world, trips[0]!.customerId, trips.map((t) => t.tripId), WHO, AT));
    expect(refused(cancelInvoice(made.world, made.id, 'Wrong rate', WHO, AT))).toEqual({ code: 'not-issued', status: 'draft' });
    const issued = ok(issueDraft(made.world, made.id, WHO, DAY, AT));
    expect(refused(deleteDraft(issued.world, made.id, WHO))).toMatchObject({ code: 'not-a-draft', status: 'issued' });
    expect(refused(cancelInvoice(issued.world, made.id, ' ', WHO, AT))).toMatchObject({ code: 'invalid', field: 'reason' });
    const fleet = { name: 'Anbu Selvan M', grants: { [INVOICE_WRITE]: all, [INVOICE_READ]: all } };
    expect(refused(cancelInvoice(issued.world, made.id, 'Wrong rate', fleet, AT))).toEqual({ code: 'needs-permission', permission: INVOICE_CANCEL });
    const cancelled = ok(cancelInvoice(issued.world, made.id, 'Wrong rate', WHO, AT));
    const record = cancelled.world.invoices.find((x) => x.id === made.id)!;
    expect(record).toMatchObject({ status: 'cancelled', invoiceNumber: issued.world.invoices.find((x) => x.id === made.id)!.invoiceNumber, cancelReason: 'Wrong rate' });
    expect(refused(cancelInvoice(cancelled.world, made.id, 'Again', WHO, AT)).code).toBe('already-cancelled');
    const again = ok(makeDraft(cancelled.world, trips[0]!.customerId, trips.map((t) => t.tripId), WHO, AT));
    const reissued = ok(issueDraft(again.world, again.id, WHO, DAY, AT));
    expect(reissued.world.invoices.find((x) => x.id === again.id)!.serial).toBe(record.serial! + 1);
    const draft = ok(makeDraft(world, trips[0]!.customerId, trips.map((t) => t.tripId), WHO, AT));
    const gone = ok(deleteDraft(draft.world, draft.id, WHO));
    expect(gone.world.invoices.some((x) => x.id === draft.id)).toBe(false);
  });
});

describe('the trip sheet, while an invoice bills its lines', () => {
  const inputOf = (s: PlSheetRecord): PlSheetInput => ({
    siteId: s.siteId,
    vehicleId: s.vehicleId,
    registrationNumber: s.registrationNumber,
    startDate: s.startDate,
    trips: s.trips.map((t) => ({
      id: t.id,
      date: t.date,
      purchases: [],
      sales: t.sales.map(({ poAttachment, dcAttachment, ...x }) => ({ ...x, poAttachmentId: poAttachment?.id ?? null, dcAttachmentId: dcAttachment?.id ?? null })),
      payments: [],
    })),
  });

  it('keeps a billed line as billed, lets the rest of the sheet change, and lets go once cancelled', () => {
    const world = blank();
    const trip = pick(world, 1)[0]!;
    const sheet = world.sheets.find((s) => s.id === trip.sheetId)!;
    const made = ok(makeDraft(world, trip.customerId, [trip.tripId], WHO, AT));
    const issued = ok(issueDraft(made.world, made.id, WHO, DAY, AT));
    const input = inputOf(sheet);
    expect(checkSheet(issued.world, input, sheet)).toBeNull();
    const tripIndex = input.trips.findIndex((t) => t.id === trip.tripId);
    const saleIndex = input.trips[tripIndex]!.sales.findIndex((x) => x.customerId === trip.customerId);
    const changed = structuredClone(input);
    changed.trips[tripIndex]!.sales[saleIndex]!.rate = '1.00';
    expect(checkSheet(issued.world, changed, sheet)).toMatchObject({ code: 'sale-invoiced', field: `trips[${tripIndex}].sales[${saleIndex}]`, tripNumber: trip.tripNumber, status: 'issued' });
    const removed = { ...input, trips: input.trips.filter((t) => t.id !== trip.tripId) };
    expect(checkSheet(issued.world, removed, sheet)).toMatchObject({ code: 'sale-invoiced', tripNumber: trip.tripNumber });
    expect([...liveInvoices(issued.world.invoices).values()].map((x) => x.id)).toEqual([made.id]);
    const cancelled = ok(cancelInvoice(issued.world, made.id, 'Wrong rate', WHO, AT));
    expect(checkSheet(cancelled.world, changed, sheet)).toBeNull();
  });
});

describe('money received', () => {
  it('counts the payments on its trips up to the total, undoes one, and lets all go on cancel', () => {
    const { invoices, receipts, series } = useInvoices.getState();
    const pl = usePl.getState();
    const world: World = { sheets: pl.sheets, parties: pl.parties, materials: pl.materials, invoices, receipts, series };
    const part = invoices.find((x) => x.status === 'issued' && receiptsOf(world, x).receipts.length >= 1)!;
    const money = receiptsOf(world, part);
    expect(Number(money.received) + Number(money.due)).toBeCloseTo(Number(part.total), 2);
    const undone = ok(unmatchMoney(world, part.id, money.receipts[0]!.id, WHO));
    const after = receiptsOf(undone.world, part);
    expect(after.receipts).toHaveLength(money.receipts.length - 1);
    expect(after.unmatched.some((u) => u.paymentId === money.receipts[0]!.paymentId)).toBe(true);
    const zero = matchMoney(undone.world, part.id, { paymentId: money.receipts[0]!.paymentId, amount: '0.00' }, WHO, AT);
    expect(zero).toMatchObject({ ok: false, problem: { code: 'invalid', field: 'amount', reason: 'more than zero' } });
    if (!zero.ok) {
      expect(invoiceProblemText(zero.problem, invoiceWords.en)).toBe('Type an amount above ₹0.');
      expect(invoiceProblemText(zero.problem, invoiceWords.ta)).toBe('₹0-க்கு மேல் ஒரு தொகையை எழுதவும்.');
    }
    const back = ok(matchMoney(undone.world, part.id, { paymentId: money.receipts[0]!.paymentId }, WHO, AT));
    expect(receiptsOf(back.world, part).received).toBe(money.received);
    const cancelled = ok(cancelInvoice(world, part.id, 'Wrong rate', WHO, AT));
    expect(cancelled.world.receipts.some((r) => r.invoiceId === part.id)).toBe(false);
    expect(invoiceDetail(cancelled.world, cancelled.world.invoices.find((x) => x.id === part.id)!)).toMatchObject({ received: '0.00', due: '0.00', moneyStatus: null });
  });
});

describe('a refusal, in the screen’s own words', () => {
  const EVERY: InvoiceProblem[] = [
    { code: 'needs-permission', permission: INVOICE_WRITE },
    { code: 'needs-permission', permission: INVOICE_CANCEL },
    { code: 'needs-permission', permission: RECEIVE },
    { code: 'needs-permission', permission: INVOICE_READ },
    { code: 'invalid', field: 'reason', reason: 'required' },
    { code: 'invalid', field: 'placeOfSupply', reason: 'not a state' },
    { code: 'invalid', field: 'tripIds', reason: 'required' },
    { code: 'trips-other-site' },
    { code: 'trip-not-for-customer', tripNumber: 'TRP/26-27/0001' },
    { code: 'sale-on-invoice', tripNumber: 'TRP/26-27/0001', invoiceId: 'x', invoiceNumber: 'KBM/26-27/0001', status: 'issued' },
    { code: 'sale-on-invoice', tripNumber: 'TRP/26-27/0001', invoiceId: 'x', invoiceNumber: null, status: 'draft' },
    { code: 'sale-not-gst', tripNumber: 'TRP/26-27/0001' },
    { code: 'sale-billed-outside', tripNumber: 'TRP/26-27/0001', invoiceNumber: 'PB/2201' },
    { code: 'sale-no-hsn', tripNumber: 'TRP/26-27/0001' },
    { code: 'site-no-gstin', siteId: 'site-x', siteName: 'Quarry' },
    { code: 'buyer-gstins-differ', gstins: ['33AAACC4660K1ZS', '33AACCR3942K1ZC'] },
    { code: 'places-differ', states: ['33', '34'] },
    { code: 'not-a-draft', status: 'issued', invoiceNumber: 'KBM/26-27/0001' },
    { code: 'not-issued', status: 'draft' },
    { code: 'already-cancelled', invoiceNumber: 'KBM/26-27/0001' },
    { code: 'series-full', gstin: '33AABCK4521P1ZH', financialYear: '26-27' },
    { code: 'payment-matched' },
    { code: 'invoice-paid' },
    { code: 'too-much', free: '500.00', due: '200.00' },
    { code: 'invoice-gone' },
    { code: 'receipt-gone' },
  ];

  it('words every problem in English and Tamil, never as a code', () => {
    for (const p of EVERY) {
      const [en, ta] = [invoiceProblemText(p, invoiceWords.en), invoiceProblemText(p, invoiceWords.ta)];
      expect(en, p.code).toMatch(/\S/);
      expect(ta, p.code).toMatch(/[஀-௿]/);
      for (const text of [en, ta]) expect(text, p.code).not.toMatch(/undefined|null|\[object|sales\.invoice|finance\.receipt|-[a-z]+-|placeOfSupply/);
    }
    expect(invoiceProblemText({ code: 'too-much', free: '500.00', due: '200.00' }, invoiceWords.en)).toBe('At most ₹200.00.');
    expect(invoiceProblemText({ code: 'places-differ', states: ['33', '34'] }, invoiceWords.ta)).toContain('தமிழ்நாடு, புதுச்சேரி');
  });
});
