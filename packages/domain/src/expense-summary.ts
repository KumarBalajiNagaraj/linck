/**
 * THE DIRECTOR'S SUMMARY OF EXPENSES (LIN-15).
 *
 * Every live bill falls in exactly one stage of the approval chain:
 *
 *   with the desk     submitted — raised, not yet checked by fleet or stores
 *   awaiting you      validated — checked, waiting on the director
 *   with accounts     approved or passed — approved, not yet paid
 *   paid              paid
 *
 * Rejected bills are counted apart and in no stage's rupees; deleted bills are
 * not counted at all. Money is summed in whole paise, so the stage totals
 * always add up to the grand total to the paisa.
 *
 * Pure: the caller supplies the bills and the clock.
 */
import type { BillEvent, BillStatus } from './expense-workflow.js';

export type ExpenseStage = 'desk' | 'director' | 'accounts' | 'paid';

export const STAGES: readonly ExpenseStage[] = ['desk', 'director', 'accounts', 'paid'];

export const STAGE_LABEL: Record<ExpenseStage, string> = {
  desk: 'With the desk',
  director: 'Awaiting director',
  accounts: 'With accounts',
  paid: 'Paid',
};

export function stageOf(status: BillStatus): ExpenseStage | null {
  switch (status) {
    case 'submitted':
      return 'desk';
    case 'validated':
      return 'director';
    case 'approved':
    case 'passed':
      return 'accounts';
    case 'paid':
      return 'paid';
    default:
      return null;
  }
}

/** What the summary needs of a bill. */
export interface SummaryBill {
  status: BillStatus;
  amount: string;
  litres: number | null;
  submittedAt: string;
  history?: BillEvent[];
}

export interface StageTotals {
  count: number;
  /** Whole paise. */
  paise: number;
}

export interface ExpenseLine {
  key: string;
  bills: number;
  litres: number;
  stages: Record<ExpenseStage, StageTotals>;
  /** Everything not rejected, in whole paise. */
  totalPaise: number;
  rejected: StageTotals;
}

const toPaise = (amount: string) => Math.round(Number.parseFloat(amount) * 100);
const emptyStages = (): Record<ExpenseStage, StageTotals> => ({
  desk: { count: 0, paise: 0 },
  director: { count: 0, paise: 0 },
  accounts: { count: 0, paise: 0 },
  paid: { count: 0, paise: 0 },
});

/**
 * One line per key (type, site, vehicle...), largest first. A bill whose key
 * is null is left out of the lines — the caller decides what "none" means.
 */
export function summarizeExpenses<B extends SummaryBill>(bills: readonly B[], keyOf: (bill: B) => string | null): ExpenseLine[] {
  const lines = new Map<string, ExpenseLine & { centiLitres: number }>();
  for (const b of bills) {
    if (b.status === 'deleted') continue;
    const key = keyOf(b);
    if (key === null) continue;
    const line = lines.get(key) ?? { key, bills: 0, litres: 0, centiLitres: 0, stages: emptyStages(), totalPaise: 0, rejected: { count: 0, paise: 0 } };
    const paise = toPaise(b.amount);
    line.bills += 1;
    const stage = stageOf(b.status);
    if (stage === null) {
      line.rejected.count += 1;
      line.rejected.paise += paise;
    } else {
      line.stages[stage].count += 1;
      line.stages[stage].paise += paise;
      line.totalPaise += paise;
      line.centiLitres += Math.round((b.litres ?? 0) * 100);
    }
    lines.set(key, line);
  }
  return [...lines.values()]
    .map(({ centiLitres, ...l }) => ({ ...l, litres: centiLitres / 100 }))
    .sort((a, b) => b.totalPaise - a.totalPaise || a.key.localeCompare(b.key));
}

/** Every bill under one key: the page's headline row. */
export function totalOf<B extends SummaryBill>(bills: readonly B[]): ExpenseLine {
  return summarizeExpenses(bills, () => 'all')[0] ?? { key: 'all', bills: 0, litres: 0, stages: emptyStages(), totalPaise: 0, rejected: { count: 0, paise: 0 } };
}

/**
 * When the bill reached its current status: the last move into it, or when it
 * was raised if nothing has moved it since (or it was signed before Linck kept
 * a history).
 */
export function enteredStatusAt(bill: SummaryBill): string {
  const events = bill.history ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.to === bill.status) return events[i]!.at;
  }
  return bill.submittedAt;
}

export const AGE_BUCKETS = ['Under a day', '1–3 days', '3–7 days', 'Over a week'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

const DAY = 24 * 60 * 60 * 1000;

export function ageBucket(since: string, now: Date): AgeBucket {
  const days = (now.getTime() - Date.parse(since)) / DAY;
  return days < 1 ? 'Under a day' : days < 3 ? '1–3 days' : days < 7 ? '3–7 days' : 'Over a week';
}

/** How long the bills in one status have waited there, in rupees per bucket. */
export function ageing<B extends SummaryBill>(bills: readonly B[], status: BillStatus, now: Date): { label: AgeBucket; count: number; paise: number }[] {
  const buckets = AGE_BUCKETS.map((label) => ({ label, count: 0, paise: 0 }));
  for (const b of bills) {
    if (b.status !== status) continue;
    const bucket = buckets.find((x) => x.label === ageBucket(enteredStatusAt(b), now))!;
    bucket.count += 1;
    bucket.paise += toPaise(b.amount);
  }
  return buckets;
}
