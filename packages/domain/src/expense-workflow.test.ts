import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableActions,
  exceptionsIn,
  planBatch,
  signersOf,
  WorkflowError,
  type Actor,
  type WorkflowBill,
  type WorkflowProblem,
} from './expense-workflow.js';

/** The problem a move was refused for, or null when it went through. */
const problemOf = (move: () => unknown): WorkflowProblem | null => {
  try {
    move();
    return null;
  } catch (e) {
    if (e instanceof WorkflowError) return e.problem;
    throw e;
  }
};

const KRP = 'site-krp';
const person = (id: string, keys: string[], sites: string[] = [KRP]): Actor => ({
  id,
  name: id,
  can: (permission, siteId) => keys.includes(permission) && sites.includes(siteId),
});

const fleet = person('fleet', ['fleet.expense.upload', 'fleet.expense.validate']);
const director = person('director', ['finance.expense.approve']);
const accounts = person('accounts', ['finance.expense.pass', 'finance.expense.pay']);
const driver = person('driver:drv-001', []);

const bill = (over: Partial<WorkflowBill> = {}): WorkflowBill => ({
  id: 'b1',
  status: 'submitted',
  desk: 'fleet',
  siteId: KRP,
  amount: '41277.60',
  litres: 432,
  submittedById: 'driver:drv-001',
  submittedBy: 'Murugan S',
  history: [],
  payment: null,
  ...over,
});

const T = '2026-08-08T09:00:00.000Z';
const PAY = { utr: 'hdfcn52026080812345', paidOn: '2026-08-08', mode: 'NEFT' as const };

describe('the chain', () => {
  it('goes validate → approve → pass → pay, each step logged', () => {
    let b = bill();
    b = applyAction(b, 'validate', fleet, T);
    b = applyAction(b, 'approve', director, T);
    b = applyAction(b, 'pass', accounts, T);
    b = applyAction(b, 'pay', accounts, T, { payment: PAY });
    expect(b.status).toBe('paid');
    expect(b.payment).toEqual({ ...PAY, utr: 'HDFCN52026080812345' });
    expect(b.history!.map((e) => `${e.action}:${e.from}→${e.to}:${e.by}`)).toEqual([
      'validate:submitted→validated:fleet',
      'approve:validated→approved:director',
      'pass:approved→passed:accounts',
      'pay:passed→paid:accounts',
    ]);
    expect(b.history!.some((e) => e.exception)).toBe(false);
  });

  it('lets each step be taken only by whoever holds its key, at the bill\'s site', () => {
    expect(problemOf(() => applyAction(bill(), 'validate', director, T))).toEqual({ code: 'needs-permission', permission: 'fleet.expense.validate' });
    expect(problemOf(() => applyAction(bill({ status: 'validated' }), 'approve', fleet, T))).toEqual({
      code: 'needs-permission',
      permission: 'finance.expense.approve',
    });
    const elsewhere = person('fleet-tvl', ['fleet.expense.validate'], ['site-tvl']);
    expect(() => applyAction(bill(), 'validate', elsewhere, T)).toThrow(WorkflowError);
    expect(problemOf(() => applyAction(bill(), 'approve', director, T))).toEqual({ code: 'wrong-step', status: 'submitted', action: 'approve' });
  });

  it('routes a stores bill to the stores key', () => {
    const storesBill = bill({ desk: 'stores' });
    expect(problemOf(() => applyAction(storesBill, 'validate', fleet, T))).toEqual({ code: 'needs-permission', permission: 'stores.expense.validate' });
    const wsp = person('fleet', ['stores.expense.validate']);
    expect(applyAction(storesBill, 'validate', wsp, T).status).toBe('validated');
  });
});

describe('four eyes', () => {
  it('lets the uploader validate their own bill only with a note, marked as an exception', () => {
    const own = bill({ submittedById: 'fleet', submittedBy: 'fleet' });
    const option = availableActions(own, fleet).find((o) => o.action === 'validate')!;
    expect(option).toMatchObject({ allowed: true, exception: true, needsNote: true });
    expect(problemOf(() => applyAction(own, 'validate', fleet, T))).toEqual({ code: 'second-signature' });
    const done = applyAction(own, 'validate', fleet, T, { note: 'Driver on leave; checked the slip myself' });
    expect(done.history![0]).toMatchObject({ exception: true, note: 'Driver on leave; checked the slip myself' });
    expect(exceptionsIn([done])).toHaveLength(1);
  });

  it('does not count accounts passing then paying as a second signature', () => {
    let b = applyAction(bill(), 'validate', fleet, T);
    b = applyAction(b, 'approve', director, T);
    b = applyAction(b, 'pass', accounts, T);
    expect(availableActions(b, accounts).find((o) => o.action === 'pay')!.exception).toBe(false);
  });

  it('forgets an undone signature: sent back, the bill can be signed by the same person again cleanly', () => {
    let b = applyAction(bill(), 'validate', fleet, T);
    b = applyAction(b, 'send_back', director, T, { note: 'Bill number is the bunk\'s phone number' });
    expect(b.status).toBe('submitted');
    expect(signersOf(b).map((s) => s.id)).toEqual(['driver:drv-001']);
    expect(availableActions(b, fleet).find((o) => o.action === 'validate')!.exception).toBe(false);
  });
});

describe('reject, delete, restore', () => {
  it('needs a reason to reject, delete or send back', () => {
    expect(problemOf(() => applyAction(bill(), 'reject', fleet, T))).toEqual({ code: 'needs-reason', action: 'reject' });
    expect(problemOf(() => applyAction(bill(), 'delete', fleet, T, { note: ' ' }))).toEqual({ code: 'needs-reason', action: 'delete' });
    expect(applyAction(bill(), 'reject', fleet, T, { note: 'Slip is for a car' }).status).toBe('rejected');
  });

  it('deletes only before anyone has signed, and keeps the bill on record', () => {
    const deleted = applyAction(bill(), 'delete', fleet, T, { note: 'Posted twice' });
    expect(deleted.status).toBe('deleted');
    const validated = applyAction(bill(), 'validate', fleet, T);
    expect(availableActions(validated, fleet).some((o) => o.action === 'delete')).toBe(false);
    expect(applyAction(deleted, 'restore', fleet, T).status).toBe('submitted');
  });

  it('lets the step\'s owner reject at a later step too', () => {
    const b = applyAction(applyAction(bill(), 'validate', fleet, T), 'approve', director, T);
    expect(() => applyAction(b, 'reject', director, T, { note: 'x' })).toThrow(WorkflowError);
    expect(applyAction(b, 'reject', accounts, T, { note: 'Duplicate of BK/48213' }).status).toBe('rejected');
  });
});

describe('payment', () => {
  const passed = () => applyAction(applyAction(applyAction(bill(), 'validate', fleet, T), 'approve', director, T), 'pass', accounts, T);

  it('needs a UTR the bank would show, and never one already used', () => {
    expect(problemOf(() => applyAction(passed(), 'pay', accounts, T))).toEqual({ code: 'needs-payment' });
    expect(problemOf(() => applyAction(passed(), 'pay', accounts, T, { payment: { ...PAY, utr: '12' } }))).toEqual({ code: 'bad-utr' });
    expect(problemOf(() => applyAction(passed(), 'pay', accounts, T, { payment: PAY, usedUtrs: new Set(['HDFCN52026080812345']) }))).toEqual({
      code: 'utr-used',
      utr: 'HDFCN52026080812345',
    });
    expect(problemOf(() => applyAction(passed(), 'pay', accounts, T, { payment: { ...PAY, paidOn: '2026-08-09' } }))).toEqual({ code: 'future-payment-date' });
    expect(applyAction(passed(), 'pay', accounts, T, { payment: { utr: '', paidOn: '2026-08-08', mode: 'Cash' } }).status).toBe('paid');
  });
});

describe('batches', () => {
  it('approves all the clean ones in one go and says why the rest were left out', () => {
    const bothSites = person('fleet', ['fleet.expense.validate'], [KRP, 'site-tvl']);
    const validated = (id: string, amount: string, over: Partial<WorkflowBill> = {}) =>
      applyAction(bill({ id, amount, ...over }), 'validate', bothSites, T);
    const bills = [
      validated('a', '100.10'),
      validated('b', '200.20'),
      bill({ id: 'c' }), // not validated yet
      validated('d', '50.00', { siteId: 'site-tvl' }),
    ];
    const plan = planBatch(bills, 'approve', director);
    expect(plan.eligible.map((b) => b.id)).toEqual(['a', 'b']);
    expect(plan.totalPaise).toBe(30030);
    expect(plan.skipped.map((s) => [s.bill.id, s.problem])).toEqual([
      ['c', { code: 'wrong-step', status: 'submitted', action: 'approve' }],
      ['d', { code: 'needs-permission', permission: 'finance.expense.approve' }],
    ]);
  });

  it('never slips a second signature into a batch', () => {
    const own = bill({ id: 'own', submittedById: 'fleet' });
    expect(planBatch([own], 'validate', fleet).skipped[0]!.problem).toEqual({ code: 'batch-second-signature' });
  });

  it('keeps someone with no key from anything', () => {
    expect(availableActions(bill(), driver).every((o) => !o.allowed)).toBe(true);
  });
});
