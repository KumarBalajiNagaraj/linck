import { QueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/auth.js';

/**
 * Live mode's server state: one TanStack Query cache for the whole app.
 *
 * Every screen that reads the same data reads the same cache entry, so a bill
 * moved on one screen has moved on all of them. Reads are re-asked when a tab
 * comes back into view and after every write, so what one person does reaches
 * the next person's screen without a reload.
 *
 * The cache is emptied the moment the session ends. Signing out reloads the
 * page anyway (auth/auth.ts); a session that lapses does not, and the next
 * person to sign in at that desk must never see the last one's bills, even
 * for the moment it takes their own to arrive.
 */

/** A refusal that asking again may fix: no answer, or a fault on the server. A 403 or a 409 will say the same thing twice. */
function transient(err: unknown): boolean {
  const code = (err as { problem?: { code?: unknown } } | null)?.problem?.code;
  return code === undefined || code === 'offline' || code === 'server';
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (failures, err) => failures < 2 && transient(err),
    },
    mutations: { retry: false },
  },
});

useAuth.subscribe((state) => {
  if (state.status !== 'signed-in') queryClient.clear();
});
