import { describe, expect, it } from 'vitest';
import type { ExpenseBill } from '@linck/mock';
import { billFromApi, captureBody, correctionBody, newBillBody, readProblem, throughApi, withBills, type ApiBill } from './expenseApi.js';

/** A bill exactly as `GET /expenses` sends it (apps/api/tests/test_expenses_api.py has the same keys). */
function apiBill(over: Partial<ApiBill> = {}): ApiBill {
  return {
    id: '7f3c1a52-0b8e-4c39-9f0e-2d6a7c1b9e44',
    desk: 'fleet',
    billNumber: 'BK/48213',
    kind: 'diesel',
    billDate: '2026-10-29T18:30:00Z',
    vehicleId: 'TN38AL1050',
    driverId: null,
    vendor: 'Sakthi Fuels, Karapakkam',
    description: '',
    litres: 432,
    amount: '41277.60',
    status: 'validated',
    submittedBy: 'Ravi K',
    submittedAt: '2026-10-30T04:12:09Z',
    siteId: '5b1d6c0e-91a4-4f3e-8a77-0c2b3e4d5f60',
    provenance: 'confirmed',
    attachment: { fileName: 'slip.jpg', mimeType: 'image/jpeg', sizeKb: 812, url: '/expenses/7f3c1a52-0b8e-4c39-9f0e-2d6a7c1b9e44/attachment' },
    capture: {
      engine: 'tesseract.js (eng)',
      capturedAt: '2026-10-30T04:11:40Z',
      warnings: [{ code: 'no-bill-number' }],
      fields: [{ key: 'amount', label: 'Amount', captured: '41,277.60', confidence: 3, value: '41277.60', overridden: false, overriddenBy: null }],
    },
    submittedById: 'user:0c9f2d1e-5a4b-4c3d-8e7f-6a5b4c3d2e1f',
    history: [
      {
        action: 'validate',
        from: 'submitted',
        to: 'validated',
        byId: 'user:1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
        by: 'Meena S',
        at: '2026-10-30T06:00:00Z',
        note: null,
        exception: false,
      },
    ],
    payment: null,
    ...over,
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, problem: Record<string, unknown>) => json(status, { detail: { problem } });

describe('a bill from the API, as the screens read it', () => {
  it('keeps every field the API sends, as it sends it', () => {
    const row = apiBill();
    const bill = billFromApi(row, '/api');
    const { attachment, ...rest } = bill;
    const { attachment: sent, ...restSent } = row;
    expect(rest).toEqual(restSent);
    expect(attachment).toEqual({ ...sent, url: '/api/expenses/7f3c1a52-0b8e-4c39-9f0e-2d6a7c1b9e44/attachment' });
  });

  it('opens the scan through the API, never at a bare /expenses path on this site', () => {
    const url = (base: string) => billFromApi(apiBill(), base).attachment!.url;
    expect(url('/api')).toBe('/api/expenses/7f3c1a52-0b8e-4c39-9f0e-2d6a7c1b9e44/attachment');
    expect(url('http://localhost:8011')).toBe('http://localhost:8011/expenses/7f3c1a52-0b8e-4c39-9f0e-2d6a7c1b9e44/attachment');
    expect(url('https://linck.example/api/')).toBe('https://linck.example/api/expenses/7f3c1a52-0b8e-4c39-9f0e-2d6a7c1b9e44/attachment');
    expect(url('/api')).not.toMatch(/^\/expenses/);
  });

  it('joins the base and a path with exactly one slash, and leaves a full address alone', () => {
    expect(throughApi('/api', '/expenses/1/attachment')).toBe('/api/expenses/1/attachment');
    expect(throughApi('/api/', 'expenses/1/attachment')).toBe('/api/expenses/1/attachment');
    expect(throughApi('/api', 'https://files.example/x')).toBe('https://files.example/x');
  });

  it('leaves `source` absent on a bill that did not come on WhatsApp, and carries it when it did', () => {
    expect('source' in billFromApi(apiBill(), '/api')).toBe(false);
    const source = {
      channel: 'whatsapp' as const,
      claimKey: '2026-10-30T04:10|diesel 432 l|1',
      via: '',
      sender: '+919876543210',
      postedAt: '2026-10-30T04:10:00Z',
      message: 'diesel 432 l',
      attachments: ['wa-1.jpg'],
    };
    expect(billFromApi(apiBill({ source }), '/api').source).toEqual(source);
  });

  it('keeps a bill with no scan, no capture and no payment as such', () => {
    const bill = billFromApi(apiBill({ attachment: null, capture: null, payment: null }), '/api');
    expect([bill.attachment, bill.capture, bill.payment]).toEqual([null, null, null]);
  });

  it('carries the payment as recorded', () => {
    const payment = { utr: 'HDFC00ABCDEF1234', paidOn: '2026-10-31', mode: 'NEFT' as const };
    expect(billFromApi(apiBill({ status: 'paid', payment }), '/api').payment).toEqual(payment);
  });
});

describe('the cache after a move', () => {
  const a = billFromApi(apiBill({ id: 'a', status: 'submitted' }), '/api');
  const b = billFromApi(apiBill({ id: 'b' }), '/api');

  it('replaces a moved bill in place and puts a new one first', () => {
    const moved = { ...a, status: 'validated' as const };
    const fresh = billFromApi(apiBill({ id: 'c' }), '/api');
    expect(withBills([a, b], [moved, fresh]).map((x) => [x.id, x.status])).toEqual([
      ['c', 'validated'],
      ['a', 'validated'],
      ['b', 'validated'],
    ]);
  });
});

describe('the API refusing, as a problem the screen words', () => {
  it('reads the workflow refusals with their values', async () => {
    expect(await readProblem(refusal(409, { code: 'wrong-step', status: 'approved', action: 'approve' }))).toEqual({
      code: 'wrong-step',
      status: 'approved',
      action: 'approve',
    });
    expect(await readProblem(refusal(403, { code: 'needs-permission', permission: 'finance.expense.approve' }))).toEqual({
      code: 'needs-permission',
      permission: 'finance.expense.approve',
    });
    expect(await readProblem(refusal(409, { code: 'utr-used', utr: 'HDFC00ABCDEF1234' }))).toEqual({ code: 'utr-used', utr: 'HDFC00ABCDEF1234' });
    expect(await readProblem(refusal(409, { code: 'needs-reason', action: 'reject' }))).toEqual({ code: 'needs-reason', action: 'reject' });
    for (const code of ['second-signature', 'bad-utr', 'future-payment-date', 'needs-payment', 'only-desk-deletes', 'batch-second-signature']) {
      expect(await readProblem(refusal(409, { code }))).toEqual({ code });
    }
  });

  it('takes a correction refused once the bill is signed as "not now"', async () => {
    // PATCH says `action: "correct"`, which is no workflow move; the words need only the status.
    const p = await readProblem(refusal(409, { code: 'wrong-step', status: 'validated', action: 'correct' }));
    expect(p).toMatchObject({ code: 'wrong-step', status: 'validated' });
  });

  it('reads a value the API would not store, by its field', async () => {
    expect(await readProblem(refusal(422, { code: 'invalid', field: 'billDate', reason: 'after today' }))).toEqual({
      code: 'invalid',
      field: 'billDate',
      reason: 'after today',
    });
    // FastAPI's own check of the request: the field is the last name in `loc`.
    const shape = json(422, { detail: [{ type: 'string_pattern_mismatch', loc: ['body', 'amount'], msg: 'String should match pattern' }] });
    expect(await readProblem(shape)).toEqual({ code: 'invalid', field: 'amount', reason: '' });
    const nested = json(422, { detail: [{ type: 'missing', loc: ['body', 'claims', 0, 'bill', 'vehicleId'], msg: 'Field required' }] });
    expect(await readProblem(nested)).toMatchObject({ code: 'invalid', field: 'vehicleId' });
  });

  it('reads a refused scan', async () => {
    expect(await readProblem(json(413, { detail: { problem: { code: 'too-big' } } }))).toEqual({ code: 'too-big' });
    expect(await readProblem(json(415, { detail: { problem: { code: 'wrong-file' } } }))).toEqual({ code: 'wrong-file' });
    expect(await readProblem(json(422, { detail: { problem: { code: 'empty' } } }))).toEqual({ code: 'empty-file' });
    // A proxy in front of the API refusing the size itself, with no JSON at all.
    expect(await readProblem(new Response('<html>413</html>', { status: 413 }))).toEqual({ code: 'too-big' });
  });

  it('reads a bill that is not there, however it is said', async () => {
    expect(await readProblem(refusal(404, { code: 'bill-gone' }))).toEqual({ code: 'bill-gone' });
    expect(await readProblem(refusal(404, { code: 'not-found' }))).toEqual({ code: 'bill-gone' });
    expect(await readProblem(new Response('Not Found', { status: 404 }))).toEqual({ code: 'bill-gone' });
  });

  it('reads a lapsed session as signed out, and anything else as a fault with its number', async () => {
    expect(await readProblem(json(401, { detail: 'not signed in' }))).toEqual({ code: 'signed-out' });
    expect(await readProblem(new Response('<html>Bad gateway</html>', { status: 502 }))).toEqual({ code: 'server', status: 502 });
    expect(await readProblem(refusal(409, { code: 'something-new' }))).toEqual({ code: 'server', status: 409 });
    // A known code with values this app cannot word is not passed on half-read.
    expect(await readProblem(refusal(409, { code: 'needs-reason', action: 'shout' }))).toEqual({ code: 'server', status: 409 });
    expect(await readProblem(refusal(409, { code: 'wrong-step', status: 'lost' }))).toEqual({ code: 'server', status: 409 });
  });
});

describe('what is sent', () => {
  const uploaded: ExpenseBill = {
    ...billFromApi(apiBill(), '/api'),
    id: 'exp-new-1',
    status: 'submitted',
    // IST midnight of 30-10-2026, as the upload sheet carries a bill date.
    billDate: '2026-10-29T18:30:00.000Z',
    capture: {
      engine: 'tesseract.js (eng)',
      capturedAt: '2026-10-30T04:11:40.000Z',
      warnings: [{ code: 'unreadable', field: 'vehicle', text: 'x'.repeat(260) }],
      fields: [
        { key: 'amount', label: 'Amount', captured: '41,277.60', confidence: 3, value: '41277.60', overridden: false, overriddenBy: null },
        { key: 'vendor', label: 'Vendor', captured: 'S'.repeat(240), confidence: 1, value: 'Sakthi Fuels', overridden: true, overriddenBy: 'Ravi K' },
        { key: 'billNumber', label: 'Bill number', captured: null, confidence: null, value: 'BK/48213', overridden: false, overriddenBy: null },
      ],
    },
  };

  it('sends a new bill with its calendar date and its scan, and says nothing of who raised it', () => {
    const body = newBillBody(uploaded, 'scan-1');
    expect(body).toMatchObject({ desk: 'fleet', billDate: '2026-10-30', attachmentId: 'scan-1', vehicleId: 'TN38AL1050', amount: '41277.60' });
    for (const key of ['id', 'status', 'provenance', 'submittedBy', 'submittedById', 'submittedAt', 'history', 'payment']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('sends what capture read without the corrections, which the API works out itself', () => {
    const body = captureBody(uploaded.capture!);
    expect(body.fields[1]).toEqual({ key: 'vendor', label: 'Vendor', captured: 'S'.repeat(200), confidence: 1, value: 'Sakthi Fuels' });
    expect(body.fields[2]).toEqual({ key: 'billNumber', label: 'Bill number', captured: null, confidence: null, value: 'BK/48213' });
    // One long line off a blurred photo cannot stop the bill being saved.
    expect(body.warnings[0]).toEqual({ code: 'unreadable', field: 'vehicle', text: 'x'.repeat(200) });
  });

  it('sends a correction of only the fields given, with the calendar date', () => {
    expect(correctionBody({ amount: '41300.00', billDate: '2026-10-29T18:30:00.000Z', litres: null })).toEqual({
      amount: '41300.00',
      billDate: '2026-10-30',
      litres: null,
    });
    expect(correctionBody({ capture: null, provenance: 'confirmed' })).toEqual({});
  });
});
