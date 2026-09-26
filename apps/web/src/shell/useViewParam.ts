import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';

/**
 * A screen's saved view, seeded from `?view=` in the URL.
 *
 * This is what lets a command-board card land on a list already filtered to
 * the rows it counted — `/sales/invoices?view=overdue` opens the ledger on the
 * overdue chip rather than on the whole book. An unknown or missing value
 * falls back quietly: a stale bookmark should open the screen, not break it.
 *
 * The chip stays local state after that, so clicking around the screen does
 * not push a history entry per click. A new `?view=` (the same screen reached
 * from a different card) re-seeds it.
 */
export function useViewParam<T extends string>(allowed: readonly T[], fallback: T): [T, (next: T) => void] {
  const raw = useRouterState({
    select: (s) => (s.location.search as Record<string, unknown>)['view'],
  });
  const fromUrl = typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
  const [view, setView] = useState<T>(fromUrl ?? fallback);

  useEffect(() => {
    if (fromUrl !== null) setView(fromUrl);
  }, [fromUrl]);

  return [view, setView];
}
