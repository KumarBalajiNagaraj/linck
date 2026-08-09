import { useEffect, useState } from 'react';

/**
 * Viewport queries, matching the Tailwind scale so a component and its
 * stylesheet can never disagree about where a breakpoint sits.
 *
 * These exist because some responsive decisions cannot be made in CSS. A dense
 * table does not become usable on a phone by shrinking — it has to become a
 * different DOM shape, one card per row. That is a render decision, so it needs
 * a media query JavaScript can read.
 *
 * Everything that CAN be done in CSS still should be. This is for structural
 * changes only.
 */

export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

function query(bp: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[bp]}px)`;
}

function read(q: string): boolean {
  return typeof window !== 'undefined' && window.matchMedia(q).matches;
}

/** True at or above the given breakpoint. */
export function useMinWidth(bp: Breakpoint): boolean {
  const q = query(bp);
  const [matches, setMatches] = useState(() => read(q));

  useEffect(() => {
    const mql = window.matchMedia(q);
    const sync = () => setMatches(mql.matches);

    sync();
    mql.addEventListener('change', sync);

    // `resize` as well as the media query, deliberately.
    //
    // `matchMedia` change is the right primary signal and fires reliably in a
    // normal browser tab. It does NOT fire dependably in every embedded
    // context — a webview or a devtools-driven viewport override can resize the
    // layout viewport, re-evaluate the CSS media queries, and never dispatch
    // the JS event. When that happens the CSS half of the layout switches to
    // desktop and the JS half stays on phone, so the rail reappears while every
    // table is still a stack of cards. That mismatch is worse than either mode.
    //
    // Re-reading on resize costs one matchMedia lookup per frame at most, and
    // setState with an unchanged boolean is a no-op in React.
    window.addEventListener('resize', sync);

    return () => {
      mql.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, [q]);

  return matches;
}

/**
 * The one distinction most components care about: is this a phone.
 *
 * Below `md` a table becomes cards, a side sheet becomes a full-height panel,
 * the workspace rail becomes a bottom tab bar, and row density jumps to the
 * 48px touch mode that already exists in the tokens.
 */
export function useIsPhone(): boolean {
  return !useMinWidth('md');
}

/**
 * True where the primary input cannot hover.
 *
 * Distinct from screen size on purpose: a weighbridge terminal is a wide screen
 * with a touch panel, and a hover-only affordance is just as invisible there as
 * it is on a phone.
 */
export function useIsTouch(): boolean {
  const q = '(hover: none)';
  const [touch, setTouch] = useState(() => read(q));

  useEffect(() => {
    const mql = window.matchMedia(q);
    const sync = () => setTouch(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);

  return touch;
}
