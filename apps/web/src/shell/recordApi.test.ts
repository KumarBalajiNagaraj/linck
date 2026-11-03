import { describe, expect, it } from 'vitest';
import { problemOf, readProblem, RecordRefused, withRecords } from './recordApi.js';

/*
 * How customers, orders and breakdowns hear the API say no
 * (apps/api/app/api/problems.py and the three routers).
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, problem: Record<string, unknown>) => json(status, { detail: { problem } });

describe('a refusal from the customer, order or breakdown routers', () => {
  it('reads who may do it', async () => {
    expect(await readProblem(refusal(403, { code: 'needs-permission', permission: 'sales.order.approve' }))).toEqual({
      code: 'needs-permission',
      permission: 'sales.order.approve',
    });
  });

  it('reads an order or a breakdown that has moved on, with where it is now', async () => {
    expect(await readProblem(refusal(409, { code: 'wrong-step', status: 'approved', action: 'reject' }))).toEqual({
      code: 'wrong-step',
      status: 'approved',
      action: 'reject',
    });
    expect(await readProblem(refusal(409, { code: 'wrong-step', status: 'resolved', action: 'update' }))).toEqual({
      code: 'wrong-step',
      status: 'resolved',
      action: 'update',
    });
  });

  it('reads the refusals that carry what was typed', async () => {
    expect(await readProblem(refusal(409, { code: 'gstin-used', gstin: '33AACCA1234K1Z5' }))).toEqual({ code: 'gstin-used', gstin: '33AACCA1234K1Z5' });
    expect(await readProblem(refusal(409, { code: 'vehicle-already-down', vehicle: 'TN38AL1050' }))).toEqual({
      code: 'vehicle-already-down',
      vehicle: 'TN38AL1050',
    });
    expect(await readProblem(refusal(409, { code: 'needs-reason', action: 'reject' }))).toEqual({ code: 'needs-reason', action: 'reject' });
  });

  it('reads a value the API would not store, by its field', async () => {
    expect(await readProblem(refusal(422, { code: 'invalid', field: 'gstin', reason: 'not a valid GSTIN' }))).toEqual({
      code: 'invalid',
      field: 'gstin',
      reason: 'not a valid GSTIN',
    });
    // FastAPI's own check of the request: the field is the last name in `loc`.
    const shape = json(422, { detail: [{ type: 'value_error', loc: ['body', 'orderedUnits'], msg: 'Value error, must be more than zero' }] });
    expect(await readProblem(shape)).toEqual({ code: 'invalid', field: 'orderedUnits', reason: '' });
  });

  it('reads a record that is not there, however it is said', async () => {
    expect(await readProblem(refusal(404, { code: 'not-found' }))).toEqual({ code: 'gone' });
    expect(await readProblem(new Response('Not Found', { status: 404 }))).toEqual({ code: 'gone' });
  });

  it('reads a lapsed session as signed out, and anything else as a fault with its number', async () => {
    expect(await readProblem(json(401, { detail: 'not signed in' }))).toEqual({ code: 'signed-out' });
    expect(await readProblem(new Response('<html>Bad gateway</html>', { status: 502 }))).toEqual({ code: 'server', status: 502 });
    expect(await readProblem(refusal(409, { code: 'something-new' }))).toEqual({ code: 'server', status: 409 });
    // A known code with values this app cannot word is not passed on half-read.
    expect(await readProblem(refusal(409, { code: 'wrong-step', status: 'lost' }))).toEqual({ code: 'server', status: 409 });
    expect(await readProblem(refusal(403, { code: 'needs-permission' }))).toEqual({ code: 'server', status: 403 });
  });

  it('carries a refusal as its problem, and anything else thrown as a fault', () => {
    expect(problemOf(new RecordRefused({ code: 'offline' }))).toEqual({ code: 'offline' });
    expect(problemOf(new TypeError('boom'))).toEqual({ code: 'server', status: 0 });
    // shell/queryClient.ts reads `.problem.code` to decide whether asking again could help.
    expect((new RecordRefused({ code: 'gone' }) as unknown as { problem: { code: string } }).problem.code).toBe('gone');
  });
});

describe('the cache after a write', () => {
  it('replaces a changed record in place and puts a new one first', () => {
    const a = { id: 'a', v: 1 };
    const b = { id: 'b', v: 1 };
    expect(withRecords([a, b], [{ id: 'b', v: 2 }, { id: 'c', v: 1 }])).toEqual([
      { id: 'c', v: 1 },
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
  });
});
