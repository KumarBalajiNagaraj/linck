import { useMutation, useQueryClient } from '@tanstack/react-query';
import { can } from '@linck/domain';
import { BREAKDOWNS, VEHICLES } from '@linck/mock';
import { LIVE } from '../../auth/api.js';
import { demoRecords, keepRecords, rereadRecords, useLiveRecords, type Records } from '../../shell/liveRecords.js';
import { problemOf, type RecordProblem } from '../../shell/recordApi.js';
import { useApp } from '../../shell/store.js';
import type { Move } from '../expenses/bills.js';
import {
  fetchBreakdowns,
  patchBreakdown,
  postBreakdown,
  resolveBreakdown,
  type Breakdown,
  type BreakdownBody,
  type BreakdownPatchBody,
  type ResolveBody,
} from './breakdownApi.js';

/**
 * WHERE THE BREAKDOWNS COME FROM — picked once, here, by the mode, as
 * expenses/bills.ts picks the bills.
 *
 *   DEMO: the sample register, @linck/mock, read-only as it has always been.
 *     Each breakdown's site is its sample vehicle's, which is how the demo
 *     has always scoped the register (breakdownsForSite).
 *   LIVE: `GET /breakdowns` through one cache (shell/liveRecords.ts), keyed
 *     by person, and every report, change and fix a request. The register,
 *     the fleet board's "Broken down" and the Vehicles menu badge all read
 *     the same entry, so a vehicle marked fixed leaves all three at once.
 *
 * The demo has no way to add, change or fix a breakdown, so those moves are
 * null there and the register offers none.
 */

export const BREAKDOWN_LIST = 'breakdowns';

/** The sample register, each breakdown booked to its vehicle's site. */
const DEMO: Breakdown[] = BREAKDOWNS.map((b) => ({ ...b, siteId: VEHICLES.find((v) => v.id === b.vehicleId)?.siteId ?? '' }));

function useLiveBreakdowns(): Records<Breakdown> {
  const persona = useApp((s) => s.persona);
  return useLiveRecords(BREAKDOWN_LIST, persona.key, can(persona.grants, 'fleet.breakdown.read'), fetchBreakdowns);
}

/** Every breakdown this person may read, at every site; screens cut it to the scope with `breakdownsAt`. */
export const useBreakdowns: () => Records<Breakdown> = LIVE ? useLiveBreakdowns : () => demoRecords(DEMO);

/** Breakdowns booked to one site, or every site. */
export function breakdownsAt(breakdowns: readonly Breakdown[], siteId: string | null): Breakdown[] {
  return siteId ? breakdowns.filter((b) => b.siteId === siteId) : [...breakdowns];
}

/** One write on the register, then the cache as the API now has it. A refusal reads the register again. */
function useWrite<A>(send: (args: A) => Promise<Breakdown>): Move<A, RecordProblem | null> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({ mutationFn: send });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        keepRecords(client, BREAKDOWN_LIST, who, [await mutation.mutateAsync(args)]);
        return null;
      } catch (err) {
        rereadRecords(client, BREAKDOWN_LIST);
        return problemOf(err);
      }
    },
  };
}

export interface ChangeArgs {
  breakdown: Breakdown;
  patch: BreakdownPatchBody;
}

export interface ResolveArgs {
  breakdown: Breakdown;
  body: ResolveBody;
}

const useLiveReport = () => useWrite((body: BreakdownBody) => postBreakdown(body));
const useLiveChange = () => useWrite(({ breakdown, patch }: ChangeArgs) => patchBreakdown(breakdown.id, patch));
const useLiveResolve = () => useWrite(({ breakdown, body }: ResolveArgs) => resolveBreakdown(breakdown.id, body));

/** A vehicle down: what broke, where, since when. Null in the demo. */
export const useReportBreakdown: () => Move<BreakdownBody, RecordProblem | null> | null = LIVE ? useLiveReport : () => null;
/** What was told corrected, sent to the workshop, or the repair cost. Null in the demo. */
export const useChangeBreakdown: () => Move<ChangeArgs, RecordProblem | null> | null = LIVE ? useLiveChange : () => null;
/** Back on the road. Null in the demo. */
export const useResolveBreakdown: () => Move<ResolveArgs, RecordProblem | null> | null = LIVE ? useLiveResolve : () => null;
