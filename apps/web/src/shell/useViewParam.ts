import { useCallback } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';

/**
 * A screen's saved view, held in the URL as `?view=`.
 *
 * The URL is the only copy. That is the rule in `store.ts` — if screen state
 * can be in the URL it must be, so a view is shareable and survives a reload
 * — and it is what lets a command-board card open a list already filtered to
 * the rows it counted: `/sales/invoices?view=overdue` IS the overdue view.
 *
 * - An unknown or missing value reads as the fallback, so a stale bookmark or
 *   a plain nav-rail link opens the screen on its default view rather than
 *   on whatever filter was last clicked.
 * - Choosing a view replaces the history entry instead of pushing one, so
 *   Back leaves the screen instead of stepping back through every chip.
 * - The fallback is written as no parameter at all, keeping plain URLs plain.
 */
export function useViewParam<T extends string>(allowed: readonly T[], fallback: T): [T, (next: T) => void] {
  const navigate = useNavigate();
  const raw = useRouterState({
    select: (s) => (s.location.search as Record<string, unknown>)['view'],
  });
  const view = typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;

  const setView = useCallback(
    (next: T) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, view: next === fallback ? undefined : next }),
        replace: true,
        resetScroll: false,
      });
    },
    [navigate, fallback],
  );

  return [view, setView];
}
