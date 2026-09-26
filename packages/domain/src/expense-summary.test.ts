import { describe, expect, it } from 'vitest';
import { ageBucket, ageing, enteredStatusAt, stageOf, summarizeExpenses, totalOf, type SummaryBill } from './expense-summary.js';
import type { BillEvent } from './expense-workflow.js';

const NOW = new Date('2026-08-08T09:00:00.000Z');
const bill = (status: SummaryBill['status'], amount: string, over: Partial<SummaryBill & { kind: string }> = {}) => ({
  status,
  amount,
  litres: null,
  submittedAt: '2026-08-07T09:00:00.000Z',
  kind: 'diesel',
  ...over,
});

describe('stages', () => {
  it('puts each live status in exactly one stage, and rejected or deleted in none', () => {
    expect(['submitted', 'validated', 'approved', 'passed', 'paid', 'rejected', 'deleted'].map((s) => stageOf(s as SummaryBill['status']))).toEqual([
      'desk',
      'director',
      'accounts',
      'accounts',
      'paid',
      null,
      null,
    ]);
  });
});

describe('summarizeExpenses', () => {
  it('sums each stage in paise so the stages add to the total exactly', () => {
    const bills = [
      bill('submitted', '0.10', { litres: 1.1 }),
      bill('validated', '0.20', { litres: 2.2 }),
      bill('passed', '100.05', { kind: 'tyre' }),
      bill('paid', '0.35', { kind: 'tyre' }),
      bill('rejected', '999.00'),
      bill('deleted', '5000.00'),
    ];
    const lines = summarizeExpenses(bills, (b) => b.kind);
    expect(lines.map((l) => l.key)).toEqual(['tyre', 'diesel']);
    const diesel = lines[1]!;
    expect(diesel).toMatchObject({ bills: 3, litres: 3.3, totalPaise: 30, rejected: { count: 1, paise: 99900 } });
    expect(diesel.stages.desk).toEqual({ count: 1, paise: 10 });
    expect(diesel.stages.director).toEqual({ count: 1, paise: 20 });
    const all = totalOf(bills);
    expect(all.totalPaise).toBe(10070);
    expect(Object.values(all.stages).reduce((s, x) => s + x.paise, 0)).toBe(all.totalPaise);
  });

  it('leaves out bills with no key, and gives an empty total for no bills', () => {
    expect(summarizeExpenses([bill('paid', '1.00')], () => null)).toEqual([]);
    expect(totalOf([]).totalPaise).toBe(0);
  });
});

describe('ageing', () => {
  const moved = (to: SummaryBill['status'], at: string): BillEvent => ({ action: 'validate', from: 'submitted', to, byId: 'f', by: 'f', at, note: null, exception: false });

  it('ages a bill from when it reached its status, not when it was raised', () => {
    const b = bill('validated', '1.00', { submittedAt: '2026-07-01T00:00:00.000Z', history: [moved('validated', '2026-08-08T01:00:00.000Z')] });
    expect(enteredStatusAt(b)).toBe('2026-08-08T01:00:00.000Z');
    expect(ageBucket(enteredStatusAt(b), NOW)).toBe('Under a day');
  });

  it('falls back to when the bill was raised, and buckets rupees by age', () => {
    const bills = [
      bill('validated', '10.00', { submittedAt: '2026-08-07T08:00:00.000Z' }),
      bill('validated', '20.00', { submittedAt: '2026-08-03T09:00:00.000Z' }),
      bill('validated', '30.00', { submittedAt: '2026-07-20T09:00:00.000Z' }),
      bill('submitted', '99.00', { submittedAt: '2026-07-20T09:00:00.000Z' }),
    ];
    expect(ageing(bills, 'validated', NOW).map((b) => [b.label, b.count, b.paise])).toEqual([
      ['Under a day', 0, 0],
      ['1–3 days', 1, 1000],
      ['3–7 days', 1, 2000],
      ['Over a week', 1, 3000],
    ]);
  });
});
