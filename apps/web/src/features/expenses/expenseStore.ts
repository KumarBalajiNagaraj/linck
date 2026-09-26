import { create } from 'zustand';
import { EXPENSE_BILLS, type ExpenseBill } from '@linck/mock';

/**
 * The expense bills, as one client-side store.
 *
 * Every expense screen reads from here rather than from the mock array
 * directly, so a bill uploaded by the store manager, validated by the fleet
 * manager and approved by the director is the SAME row moving through all
 * three screens in one session. At cutover this becomes a TanStack Query cache
 * over `/expenses`, and these actions become its mutations.
 */

interface ExpenseState {
  bills: ExpenseBill[];
  add: (bill: ExpenseBill) => void;
  update: (id: string, patch: Partial<ExpenseBill>) => void;
  remove: (id: string) => void;
}

export const useExpenses = create<ExpenseState>((set) => ({
  bills: [...EXPENSE_BILLS],
  add: (bill) => set((s) => ({ bills: [bill, ...s.bills] })),
  update: (id, patch) => set((s) => ({ bills: s.bills.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),
  remove: (id) => set((s) => ({ bills: s.bills.filter((b) => b.id !== id) })),
}));

let seq = 0;
/** A client-side id for a bill not yet saved. The API assigns the real one. */
export function newBillId(): string {
  seq += 1;
  return `exp-new-${Date.now().toString(36)}-${seq}`;
}
