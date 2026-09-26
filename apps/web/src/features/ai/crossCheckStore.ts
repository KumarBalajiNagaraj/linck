import type { CrossCheckResult } from '@linck/domain';
import { create } from 'zustand';

/**
 * Cross-checks a person has confirmed and recorded.
 *
 * In memory, like every mock-backed store: it survives moving between
 * screens, not a reload. At cutover each record is posted to the API against
 * its load — the DC number, vehicle and date identify it — and read back
 * from there.
 */
export interface RecordedCheck {
  id: string;
  /** What the papers said when it was recorded; the same papers are recorded once. */
  signature: string;
  recordedAt: string;
  recordedBy: string;
  /** The load, as the papers identify it. */
  dcNumber: string | null;
  vehicle: string | null;
  date: string | null;
  papers: { name: string; text: string }[];
  result: CrossCheckResult;
}

interface CrossCheckState {
  records: RecordedCheck[];
  record: (check: Omit<RecordedCheck, 'id'>) => void;
}

export const useCrossChecks = create<CrossCheckState>((set) => ({
  records: [],
  record: (check) => set((s) => ({ records: [{ ...check, id: `xc-${s.records.length + 1}` }, ...s.records] })),
}));
