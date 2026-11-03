import { useQuery, type QueryClient } from '@tanstack/react-query';
import { formatTime } from '@linck/domain';
import { problemOf, withRecords, type RecordProblem } from './recordApi.js';

/**
 * A list of records as a screen reads it, in either mode: the demo's sample
 * rows, or live one TanStack Query cache entry (shell/queryClient.ts) per
 * list and per person, so the cache never hands one person's list to the
 * next. Every screen that reads the same list reads the same entry: an order
 * approved on its screen is approved on the sales board's count too.
 *
 * After a write the entry takes the record as the API returned it, then the
 * whole list is read again (`keepRecords`); after a refusal it is read again
 * too (`rereadRecords`), because the record may have moved on under this
 * person and the screen should show where. The features' own source pickers
 * (sales/orders.ts, sales/customers.ts, fleet/breakdowns.ts) say which list
 * and which request; expenses/bills.ts does the same for the bills.
 */

export interface Records<T> {
  rows: T[];
  /** When they were read, for the as-of stamp. */
  asOf: string;
  /** Always 'ready' in the demo. */
  state: 'loading' | 'ready' | 'failed';
  /** Why they could not be read, when `state` is 'failed'. */
  problem: RecordProblem | null;
  retry: () => void;
}

/** The demo's screens are stamped with its seeded afternoon, as they always were. */
const DEMO_AS_OF = '14:42';

const noop = () => undefined;
const EMPTY: unknown[] = [];

/** Sample rows, as the demo has always shown them: read, and never failing. */
export function demoRecords<T>(rows: T[]): Records<T> {
  return { rows, asOf: DEMO_AS_OF, state: 'ready', problem: null, retry: noop };
}

/** One list's cache key, per person. */
const recordsKey = (list: string, who: string) => [list, who] as const;

/**
 * A live list. `enabled` is whether this person holds the list's read key
 * anywhere: without it the list is not asked for, and is empty, not failed.
 */
export function useLiveRecords<T>(list: string, who: string, enabled: boolean, read: (signal: AbortSignal) => Promise<T[]>): Records<T> {
  const query = useQuery({ queryKey: recordsKey(list, who), queryFn: ({ signal }) => read(signal), enabled });
  // A list once read stays on screen through a failed re-read; only no list at all is a failure.
  const failed = query.isError && query.data === undefined;
  return {
    rows: query.data ?? (EMPTY as T[]),
    asOf: query.dataUpdatedAt > 0 ? formatTime(new Date(query.dataUpdatedAt)) : '–',
    state: !enabled || query.data !== undefined ? 'ready' : failed ? 'failed' : 'loading',
    problem: failed ? problemOf(query.error) : null,
    retry: () => void query.refetch(),
  };
}

/** The cache after a write: the records as the API now has them, then a fresh read of the list. */
export function keepRecords<T extends { id: string }>(client: QueryClient, list: string, who: string, changed: T[]): void {
  client.setQueryData<T[]>(recordsKey(list, who), (old) => (old ? withRecords(old, changed) : old));
  rereadRecords(client, list);
}

/** Read a list again, for everyone who has it: after a refusal, or when another list's write changed what it shows. */
export function rereadRecords(client: QueryClient, list: string): void {
  void client.invalidateQueries({ queryKey: [list] });
}
