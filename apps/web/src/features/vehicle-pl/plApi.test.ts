import { afterEach, describe, expect, it, vi } from 'vitest';
import { decimal } from '@linck/domain';
import type { PlAttachment, PlDieselBillOption, PlParty, PlSheetDetail } from '@linck/mock';
import { useExpenses } from '../expenses/expenseStore.js';
import {
  calcOf,
  closeTrip,
  detailFromApi,
  fetchSheets,
  fieldOf,
  invoicedOf,
  linkedBillsOf,
  mastersFromApi,
  plProblem,
  plProblemOf,
  PlRefused,
  postSheet,
  putSheet,
  query,
  readRefusal,
  recordOf,
  uploadAttachment,
  type Refusal,
} from './plApi.js';
import { buildBook, sheetDetail, usePl, type PlProblem } from './plStore.js';
import { problemText } from './plText.js';
import { fromRecord, toInput } from './sheetDraft.js';
import { sheetWords } from './words.js';

/*
 * Live, the Vehicle P&L screens read /vehicle-pl (apps/api/app/api/vehicle_pl.py)
 * where the demo reads plStore.ts. These hold the reading to the API: what
 * comes in is what the page draws, what a save sends back is what the form
 * held, and every refusal is worded.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, problem: Record<string, unknown>) => json(status, { detail: { problem } });
const read = async (res: Response) => plProblem(await readRefusal(res));

const BOOK = (() => {
  const pl = usePl.getState();
  return buildBook(pl.sheets, pl.parties, pl.materials, useExpenses.getState().bills);
})();

/** Money as a figure, not as it was written: "2950" and "2950.00" are one rate. */
function figures(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(figures);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ['rate', 'amount', 'batta', 'transport'].includes(k) && typeof x === 'string' ? decimal.toFixed(decimal.dec(x), 2) : figures(x)]),
    );
  }
  return v;
}

describe('a trip sheet from the API, as the page reads it', () => {
  it('goes back through the form as the very sheet that was saved: every trip and line by id, every figure as typed', () => {
    expect(BOOK.sheets.length).toBeGreaterThan(10);
    for (const rec of BOOK.sheets) {
      // sheetDetail is the demo's answer, shaped as SheetOut (apiShapes.test.ts holds the two together).
      const answered = recordOf(sheetDetail(BOOK, rec));
      expect(figures(toInput(fromRecord(answered))), rec.sheetNumber).toEqual(figures(toInput(fromRecord(rec))));
    }
  });

  it("draws a saved sheet with the server's own figures, keyed as the page's rules key them", () => {
    for (const rec of BOOK.sheets) expect(calcOf(sheetDetail(BOOK, rec)), rec.sheetNumber).toEqual(BOOK.calcs.get(rec.id));
  });

  it('keeps who closed a trip, from the customer dues the API calls closed', () => {
    const closed = BOOK.sheets.find((s) => s.trips.some((t) => t.closures.length > 0))!;
    const trip = closed.trips.find((t) => t.closures.length > 0)!;
    const back = recordOf(sheetDetail(BOOK, closed)).trips.find((t) => t.id === trip.id)!;
    expect(back.closures.map((c) => ({ partyId: c.partyId, closedBy: c.closedBy }))).toEqual(trip.closures.map((c) => ({ partyId: c.partyId, closedBy: c.closedBy })));
  });

  it('leaves a transport charge of nothing empty, so the form does not show 0.00', () => {
    const rec = BOOK.sheets.find((s) => s.trips.some((t) => t.sales.some((x) => !x.transport)))!;
    const sale = rec.trips.flatMap((t) => t.sales).find((x) => !x.transport)!;
    const detail = sheetDetail(BOOK, rec);
    expect(detail.trips.flatMap((t) => t.sales).find((x) => x.id === sale.id)!.transport).toBe('0.00');
    expect(recordOf(detail).trips.flatMap((t) => t.sales).find((x) => x.id === sale.id)!.transport).toBeNull();
  });

  it('opens every photo through the API base, never as a bare path', () => {
    const photo = (id: string): PlAttachment => ({ id, fileName: `${id}.jpg`, mimeType: 'image/jpeg', sizeKb: 120, url: `/vehicle-pl/attachments/${id}` });
    const rec = BOOK.sheets.find((s) => s.trips.some((t) => t.purchases.length && t.sales.length && t.diesel.length + t.enRoute.length > 0))!;
    const d = sheetDetail(BOOK, rec);
    const withPhotos: PlSheetDetail = {
      ...d,
      diesel: d.diesel.map((x) => ({ ...x, attachment: photo('sd') })),
      enRoute: d.enRoute.map((x) => ({ ...x, attachment: photo('se') })),
      trips: d.trips.map((t) => ({
        ...t,
        diesel: t.diesel.map((x) => ({ ...x, attachment: photo('td') })),
        enRoute: t.enRoute.map((x) => ({ ...x, attachment: photo('te') })),
        purchases: t.purchases.map((p) => ({ ...p, attachments: [photo('p1'), photo('p2')] })),
        sales: t.sales.map((s) => ({ ...s, poAttachment: photo('po'), dcAttachment: null })),
      })),
    };
    const urls = (x: PlSheetDetail) =>
      [
        ...x.diesel.map((l) => l.attachment),
        ...x.enRoute.map((l) => l.attachment),
        ...x.trips.flatMap((t) => [...t.diesel.map((l) => l.attachment), ...t.enRoute.map((l) => l.attachment), ...t.purchases.flatMap((p) => p.attachments), ...t.sales.flatMap((s) => [s.poAttachment, s.dcAttachment])]),
      ]
        .filter((a): a is PlAttachment => a !== null)
        .map((a) => a.url);
    const seen = urls(detailFromApi(withPhotos, '/api'));
    expect(seen.length).toBeGreaterThan(4);
    for (const url of seen) expect(url).toMatch(/^\/api\/vehicle-pl\/attachments\/\w+$/);
    // Nothing else is touched.
    expect(detailFromApi(d, '/api')).toEqual(d);
  });

  it('knows which sale lines a live invoice bills, from the API saying so on the line', () => {
    const rec = BOOK.sheets.find((s) => s.trips.some((t) => t.sales.length > 1))!;
    const d = sheetDetail(BOOK, rec);
    const trip = d.trips.find((t) => t.sales.length > 1)!;
    const on = { id: 'inv-1', number: 'KBM/26-27/0007', status: 'issued' as const };
    const marked: PlSheetDetail = { ...d, trips: d.trips.map((t) => (t.id === trip.id ? { ...t, sales: t.sales.map((s, i) => (i === 0 ? { ...s, invoice: on } : { ...s, invoice: null })) } : t)) };
    expect([...invoicedOf(marked)]).toEqual([[trip.sales[0]!.id, on]]);
  });

  it("offers the vehicle's diesel bills, and knows those already on the sheet even when not offered", () => {
    const rec = BOOK.sheets.find((s) => [...s.diesel, ...s.trips.flatMap((t) => t.diesel)].some((x) => x.source === 'expense_bill'))!;
    const d = sheetDetail(BOOK, rec);
    const line = [...d.diesel, ...d.trips.flatMap((t) => t.diesel)].find((x) => x.source === 'expense_bill')!;
    const offered: PlDieselBillOption = { id: 'bill-x', billNumber: 'HP/9921', billDate: '2026-08-01', vendor: 'HP bunk', vehicleId: null, litres: 80, amount: '7560.00', status: 'approved', linkedSheet: null };
    const bills = linkedBillsOf(d, [offered]);
    expect(bills.get('bill-x')).toEqual({ id: 'bill-x', billNumber: 'HP/9921', litres: 80, amount: '7560.00', status: 'approved' });
    expect(bills.get(line.expenseBillId!)).toEqual({ id: line.expenseBillId, billNumber: line.billNumber, litres: line.litres, amount: line.amount, status: line.billStatus });
    expect(linkedBillsOf(null, []).size).toBe(0);
  });

  it('lists a party that is both a vendor and a customer once', () => {
    const both: PlParty = { id: 'p1', name: 'Pallur Blue Metals', gstin: null, phone: '', contactName: '', roles: ['vendor', 'customer'], locations: [{ id: 'l1', name: 'Pallur quarry' }] };
    const vendor: PlParty = { ...both, id: 'p2', name: 'HP bunk', roles: ['vendor'], locations: [] };
    const m = mastersFromApi({ customers: [both], vendors: [both, vendor], materials: [], gstRates: [] });
    expect(m.parties.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(m.parties[0]!.locations).toHaveLength(1);
    expect(m.customers).toEqual([both]);
  });
});

describe('what a list or report is asked for', () => {
  it('leaves blanks out, and cuts a search to the API limit', () => {
    expect(query({ from: '2026-04-01', to: '', vehicleId: null, customerId: undefined, q: '  TN 38  ' })).toBe('?from=2026-04-01&q=TN+38');
    expect(query({ q: 'x'.repeat(140) })).toBe(`?q=${'x'.repeat(100)}`);
    expect(query({})).toBe('');
  });
});

describe('a request on its way', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (res: () => Response) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => res());
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('saves a new sheet with POST and a changed one with PUT, as JSON, and reads the sheet back', async () => {
    const d = sheetDetail(BOOK, BOOK.sheets[0]!);
    const fetch = answering(() => json(201, d));
    const body = toInput(fromRecord(BOOK.sheets[0]!));
    expect((await postSheet(body)).id).toBe(d.id);
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:8000/vehicle-pl/sheets');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual(JSON.parse(JSON.stringify(body)));
    await putSheet('a b', body);
    expect(fetch.mock.calls[1]![0]).toBe('http://localhost:8000/vehicle-pl/sheets/a%20b');
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'PUT' });
  });

  it('closes a trip with POST and takes it back with DELETE, naming the customer', async () => {
    const d = sheetDetail(BOOK, BOOK.sheets[0]!);
    const fetch = answering(() => json(200, d));
    await closeTrip('s1', 't1', 'c1', true);
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:8000/vehicle-pl/sheets/s1/trips/t1/close');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ partyId: 'c1' });
    await closeTrip('s1', 't1', 'c1', false);
    expect(fetch.mock.calls[1]![0]).toBe('http://localhost:8000/vehicle-pl/sheets/s1/trips/t1/close?partyId=c1');
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' });
  });

  it('asks for the sheets with the filter in the query', async () => {
    const fetch = answering(() => json(200, { rows: [], total: {} }));
    await fetchSheets({ from: '2026-08-01', to: '2026-08-31', vehicleId: 'TN38AL1050', customerId: null, q: '' });
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:8000/vehicle-pl/sheets?from=2026-08-01&to=2026-08-31&vehicleId=TN38AL1050');
  });

  it('sends a photo as a form and gives it the address the API serves it at, through the API base', async () => {
    const fetch = answering(() => json(201, { id: 'f-1', fileName: 'dc.jpg', mimeType: 'image/jpeg', sizeKb: 210 }));
    const file = new File([new Uint8Array([1, 2, 3])], 'dc.jpg', { type: 'image/jpeg' });
    expect(await uploadAttachment(file, '/api')).toEqual({ id: 'f-1', fileName: 'dc.jpg', mimeType: 'image/jpeg', sizeKb: 210, url: '/api/vehicle-pl/attachments/f-1' });
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:8000/vehicle-pl/attachments');
    expect(fetch.mock.calls[0]![1]!.body).toBeInstanceOf(FormData);
  });

  it('carries a refusal as its problem, no answer as offline, and lets an aborted read through as itself', async () => {
    answering(() => refusal(409, { code: 'not-paid-in-full', due: '1200.00' }));
    await expect(closeTrip('s', 't', 'c', true)).rejects.toEqual(new PlRefused({ code: 'not-paid-in-full', due: '1200.00' }));
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const offline = await closeTrip('s', 't', 'c', true).catch((e: unknown) => e);
    expect(plProblemOf(offline)).toEqual({ code: 'offline' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError'))));
    await expect(fetchSheets({})).rejects.toMatchObject({ name: 'AbortError' });
    // shell/queryClient.ts reads `.problem.code` to decide whether asking again could help.
    expect((offline as { problem: { code: string } }).problem.code).toBe('offline');
    expect(plProblemOf(new TypeError('boom'))).toEqual({ code: 'server', status: 0 });
  });
});

describe("a refusal from /vehicle-pl, in the page's vocabulary", () => {
  it('reads every refusal the sheet service gives, with what the page words it from', async () => {
    const cases: [number, Record<string, unknown>, PlProblem][] = [
      [403, { code: 'needs-permission', permission: 'fleet.trip_pl.write' }, { code: 'needs-permission', permission: 'fleet.trip_pl.write' }],
      [422, { code: 'invalid', field: 'trips[0].date', reason: "outside the sheet's dates" }, { code: 'invalid', field: 'trips[0].date', reason: "outside the sheet's dates" }],
      [409, { code: 'reference-used', field: 'trips[0].payments[1]', reference: 'UTR123' }, { code: 'reference-used', field: 'trips[0].payments[1]', reference: 'UTR123' }],
      [409, { code: 'diesel-other-vehicle', field: 'diesel[0]', billNumber: 'HP/1', vehicleId: 'TN01AB1234' }, { code: 'diesel-other-vehicle', field: 'diesel[0]', billNumber: 'HP/1', vehicleId: 'TN01AB1234' }],
      [409, { code: 'diesel-bill-void', field: 'diesel[0]', billNumber: 'HP/1', status: 'rejected' }, { code: 'diesel-bill-void', field: 'diesel[0]', billNumber: 'HP/1', status: 'rejected' }],
      [409, { code: 'diesel-linked-elsewhere', field: 'trips[1].diesel[0]', sheetId: 's9', sheetNumber: 'TS/26-27/0009' }, { code: 'diesel-linked-elsewhere', field: 'trips[1].diesel[0]', sheetId: 's9', sheetNumber: 'TS/26-27/0009' }],
      [409, { code: 'diesel-linked-twice', field: 'diesel[1]', problems: [] }, { code: 'diesel-linked-twice', field: 'diesel[1]' }],
      [409, { code: 'diesel-same-bill', field: 'diesel[1]', billNumber: 'IOC 77' }, { code: 'diesel-same-bill', field: 'diesel[1]', billNumber: 'IOC 77' }],
      [409, { code: 'diesel-bill-exists', field: 'diesel[0]', billNumber: 'IOC 77', billId: 'b1' }, { code: 'diesel-bill-exists', field: 'diesel[0]', billNumber: 'IOC 77', billId: 'b1' }],
      [409, { code: 'diesel-bill-on-sheet', field: 'diesel[0]', billNumber: 'IOC 77', sheetNumber: 'TS/26-27/0003' }, { code: 'diesel-bill-on-sheet', field: 'diesel[0]', billNumber: 'IOC 77', sheetNumber: 'TS/26-27/0003' }],
      [409, { code: 'not-paid-in-full', due: '1200.00' }, { code: 'not-paid-in-full', due: '1200.00' }],
      [409, { code: 'name-used', name: 'M-Sand' }, { code: 'name-used', name: 'M-Sand' }],
      // The API names the material code it found as `materialCode`.
      [409, { code: 'code-used', materialCode: 'MSAND' }, { code: 'code-used', name: 'MSAND' }],
      [409, { code: 'gstin-set', gstin: '33AAKFP4417M1Z5' }, { code: 'gstin-set', gstin: '33AAKFP4417M1Z5' }],
      [409, { code: 'gstin-used', gstin: '33AAKFP4417M1Z5' }, { code: 'gstin-used', gstin: '33AAKFP4417M1Z5' }],
      [409, { code: 'sale-invoiced', tripNumber: 'TRP/26-27/0012', invoiceId: 'i1', invoiceNumber: 'KBM/26-27/0004', status: 'issued', field: 'trips[0].sales[0]' }, { code: 'sale-invoiced', tripNumber: 'TRP/26-27/0012', invoiceId: 'i1', invoiceNumber: 'KBM/26-27/0004', status: 'issued', field: 'trips[0].sales[0]' }],
      [409, { code: 'sale-invoiced', tripNumber: 'TRP/26-27/0012', invoiceId: 'i1', invoiceNumber: null, status: 'draft' }, { code: 'sale-invoiced', tripNumber: 'TRP/26-27/0012', invoiceId: 'i1', invoiceNumber: null, status: 'draft' }],
      [404, { code: 'sheet-gone' }, { code: 'gone' }],
      [404, { code: 'file-gone' }, { code: 'gone' }],
      [404, { code: 'file-missing' }, { code: 'gone' }],
      [404, { code: 'not-found' }, { code: 'gone' }],
      [413, { code: 'too-big' }, { code: 'too-big' }],
      [415, { code: 'wrong-file' }, { code: 'wrong-file' }],
      [422, { code: 'empty' }, { code: 'empty-file' }],
    ];
    for (const [status, problem, want] of cases) expect(await read(refusal(status, problem)), String(problem.code)).toEqual(want);
  });

  it("reads FastAPI's own check of a request as the field the page shows it on, and why", async () => {
    const shape = (detail: unknown[]) => json(422, { detail });
    expect(await read(shape([{ type: 'value_error', loc: ['body', 'trips', 0, 'purchases', 1, 'quantity'], msg: 'Value error, must be more than zero', input: 0 }]))).toEqual({
      code: 'invalid',
      field: 'trips[0].purchases[1].quantity',
      reason: 'must be more than zero',
    });
    expect(await read(shape([{ type: 'string_pattern_mismatch', loc: ['body', 'trips', 0, 'sales', 0, 'rate'], msg: "String should match pattern '^\\d{1,16}(\\.\\d{1,2})?$'", input: '' }]))).toEqual({
      code: 'invalid',
      field: 'trips[0].sales[0].rate',
      reason: 'required',
    });
    expect(await read(shape([{ type: 'missing', loc: ['body', 'startDate'], msg: 'Field required', input: {} }]))).toEqual({ code: 'invalid', field: 'startDate', reason: 'required' });
    expect(await read(shape([{ type: 'uuid_parsing', loc: ['body', 'trips', 2, 'sales', 0, 'customerId'], msg: 'Input should be a valid UUID', input: 'x' }]))).toEqual({
      code: 'invalid',
      field: 'trips[2].sales[0].customerId',
      reason: '',
    });
  });

  it('names a field the way the page does, whatever pydantic adds to its path', () => {
    expect(fieldOf(['body', 'diesel', 0, 'litres', 'float'])).toBe('diesel[0].litres');
    expect(fieldOf(['body', 'trips', 1, 'startKm', 'function-after[_to_km(), union[float,int]]'])).toBe('trips[1].startKm');
    expect(fieldOf(['query', 'vehicleId'])).toBe('vehicleId');
    expect(fieldOf('nonsense')).toBe('');
  });

  it('reads a lapsed session, no answer, a fault, and what this app cannot word', async () => {
    expect(await read(json(401, { detail: 'not signed in' }))).toEqual({ code: 'signed-out' });
    expect(plProblem({ status: 0, problem: null, shape: null } satisfies Refusal)).toEqual({ code: 'offline' });
    expect(await read(new Response('<html>Bad gateway</html>', { status: 502 }))).toEqual({ code: 'server', status: 502 });
    expect(await read(new Response('Not Found', { status: 404 }))).toEqual({ code: 'gone' });
    expect(await read(refusal(409, { code: 'something-new' }))).toEqual({ code: 'server', status: 409 });
    // A known code with values this app cannot word is not passed on half-read.
    expect(await read(refusal(403, { code: 'needs-permission' }))).toEqual({ code: 'server', status: 403 });
    expect(await read(refusal(409, { code: 'not-paid-in-full' }))).toEqual({ code: 'server', status: 409 });
    expect(await read(refusal(409, { code: 'sale-invoiced', tripNumber: 'TRP/1' }))).toEqual({ code: 'server', status: 409 });
  });
});

describe('a refused trip sheet, in words', () => {
  const TAMIL = /[஀-௿]/;
  const every: PlProblem[] = [
    { code: 'needs-permission', permission: 'fleet.trip_pl.write' },
    { code: 'invalid', field: 'x', reason: 'must be more than zero' },
    { code: 'reference-used', field: 'x', reference: 'UTR1' },
    { code: 'diesel-other-vehicle', field: 'x', billNumber: 'HP/1', vehicleId: 'v' },
    { code: 'diesel-bill-void', field: 'x', billNumber: 'HP/1', status: 'rejected' },
    { code: 'diesel-linked-elsewhere', field: 'x', sheetId: 's', sheetNumber: 'TS/26-27/0009' },
    { code: 'diesel-linked-twice', field: 'x' },
    { code: 'diesel-same-bill', field: 'x', billNumber: 'HP/1' },
    { code: 'diesel-bill-exists', field: 'x', billNumber: 'HP/1', billId: 'b' },
    { code: 'diesel-bill-on-sheet', field: 'x', billNumber: 'HP/1', sheetNumber: 'TS/26-27/0003' },
    { code: 'not-paid-in-full', due: '1200.00' },
    { code: 'name-used', name: 'M-Sand' },
    { code: 'code-used', name: 'MSAND' },
    { code: 'gstin-set', gstin: 'G' },
    { code: 'sale-invoiced', tripNumber: 'TRP/26-27/0012', invoiceId: 'i', invoiceNumber: 'KBM/26-27/0004', status: 'issued' },
    { code: 'gstin-used', gstin: '33AAKFP4417M1Z5' },
    { code: 'gone' },
    { code: 'too-big' },
    { code: 'wrong-file' },
    { code: 'empty-file' },
    { code: 'signed-out' },
    { code: 'offline' },
    { code: 'server', status: 500 },
  ];

  it('words every refusal in English and in Tamil', () => {
    for (const p of every) {
      const en = problemText(p, sheetWords.en);
      const ta = problemText(p, sheetWords.ta);
      expect(en, p.code).toMatch(/\w/);
      expect(ta, p.code).toMatch(TAMIL);
      expect(en).not.toContain('undefined');
      expect(ta).not.toContain('undefined');
    }
  });

  it('says what is wrong with the live-only ones in plain words', () => {
    expect(problemText({ code: 'gstin-used', gstin: '33AAKFP4417M1Z5' }, sheetWords.en)).toBe('GSTIN 33AAKFP4417M1Z5 is already on another party.');
    expect(problemText({ code: 'gstin-used', gstin: '33AAKFP4417M1Z5' }, sheetWords.ta)).toBe('ஜிஎஸ்டி எண் 33AAKFP4417M1Z5 ஏற்கனவே வேறொருவருக்கு உள்ளது.');
    expect(problemText({ code: 'server', status: 503 }, sheetWords.en)).toBe('Linck had a problem (error 503). Try again.');
    expect(problemText({ code: 'server', status: 0 }, sheetWords.ta)).toBe('Linck-இல் பிழை. மீண்டும் முயலுங்கள்.');
    expect(problemText({ code: 'too-big' }, sheetWords.en)).toBe('File is over 10 MB. Take the photo again.');
    expect(problemText({ code: 'offline' }, sheetWords.ta)).toBe('Linck பதில் தரவில்லை. இணையத்தைச் சரிபார்த்து, மீண்டும் முயலுங்கள்.');
  });

  it("words the API's checks of a value by the fix, as the demo's", () => {
    const why = (reason: string, w = sheetWords.en) => problemText({ code: 'invalid', field: 'f', reason }, w);
    expect(why('required')).toBe('Fill this in');
    expect(why('not a valid GSTIN')).toBe('Not a GSTIN');
    expect(why('not a valid GSTIN', sheetWords.ta)).toBe('சரியான ஜிஎஸ்டி எண் இல்லை');
    expect(why('at most 2 decimal places')).toBe('Too many digits after the point');
    expect(why('at most three decimal places', sheetWords.ta)).toBe('புள்ளிக்குப் பின் இலக்கங்கள் அதிகம்');
    expect(why('no such upload of yours')).toBe('Check this');
  });
});
