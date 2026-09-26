import { create } from 'zustand';
import {
  applyAction,
  can,
  planBatch,
  WorkflowError,
  type Actor,
  type ActionInput,
  type BatchPlan,
  type BillAction,
} from '@linck/domain';
import { EXPENSE_BILLS, NOW, type ExpenseBill } from '@linck/mock';
import type { Persona } from '../../auth/personas.js';

/**
 * The expense bills, as one client-side store.
 *
 * Every expense screen reads from here rather than from the mock array
 * directly, so a bill uploaded by the store manager, validated by the fleet
 * manager and approved by the director is the SAME row moving through all
 * three screens in one session. At cutover this becomes a TanStack Query cache
 * over `/expenses`, and these actions become its mutations.
 *
 * Moves along the approval chain go only through `act` and `actMany`, which
 * apply the domain's rules: the right key at the bill's site, a reason where
 * one is owed, four eyes, and an append-only history. `update` is kept for
 * correcting what capture read while a bill is still unsigned.
 */

interface ExpenseState {
  bills: ExpenseBill[];
  add: (bill: ExpenseBill) => void;
  update: (id: string, patch: Partial<ExpenseBill>) => void;
  /** One move on one bill. Returns why it could not be taken, or null. */
  act: (id: string, action: BillAction, actor: Actor, input?: ActionInput) => string | null;
  /** The same move on every bill the plan found eligible. */
  actMany: (plan: BatchPlan<ExpenseBill>, actor: Actor, input?: ActionInput) => number;
}

const usedUtrs = (bills: ExpenseBill[]) => new Set(bills.map((b) => b.payment?.utr).filter((u): u is string => !!u));

export const useExpenses = create<ExpenseState>((set, get) => ({
  bills: [...EXPENSE_BILLS],
  add: (bill) => set((s) => ({ bills: [bill, ...s.bills] })),
  update: (id, patch) => set((s) => ({ bills: s.bills.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),
  act: (id, action, actor, input = {}) => {
    const bills = get().bills;
    const bill = bills.find((b) => b.id === id);
    if (!bill) return 'That bill is no longer here.';
    try {
      const next = applyAction(bill, action, actor, NOW.toISOString(), { usedUtrs: usedUtrs(bills), ...input });
      set((s) => ({ bills: s.bills.map((b) => (b.id === id ? next : b)) }));
      return null;
    } catch (err) {
      if (err instanceof WorkflowError) return err.message;
      throw err;
    }
  },
  actMany: (plan, actor, input = {}) => {
    const at = NOW.toISOString();
    // One bank transfer for a batch: its UTR is shared by the bills in it,
    // and must not already be on any other payment.
    const used = usedUtrs(get().bills);
    const ids = new Set(plan.eligible.map((b) => b.id));
    let done = 0;
    set((s) => ({
      bills: s.bills.map((b) => {
        if (!ids.has(b.id)) return b;
        done += 1;
        return applyAction(b, plan.action, actor, at, { usedUtrs: used, ...input });
      }),
    }));
    return done;
  },
}));

/** The person acting, as the workflow sees them. */
export function actorFor(persona: Persona): Actor {
  return {
    id: `user:${persona.key}`,
    name: persona.name,
    can: (permission, siteId) => can(persona.grants, permission, { siteId }),
  };
}

/** Re-plans a batch against the current bills, as the domain decides. */
export { planBatch };

let seq = 0;
/** A client-side id for a bill not yet saved. The API assigns the real one. */
export function newBillId(): string {
  seq += 1;
  return `exp-new-${Date.now().toString(36)}-${seq}`;
}
