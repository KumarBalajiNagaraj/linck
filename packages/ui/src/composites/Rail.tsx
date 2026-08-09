import type { Provenance, RailPattern, StatusFamily } from '@linck/tokens';
import { PROVENANCE_LABEL, STATUS } from '@linck/tokens';
import { cn } from '../lib/cn.js';

/**
 * THE RAIL — signature move #3.
 *
 * A single 3px left-edge primitive at x=0 on every table row, detail field,
 * fleet tile, kanban card, alert item and active nav item, doing four jobs at
 * once with zero extra DOM:
 *
 *   PROVENANCE, colourlessly — blank = a human typed it, dotted = machine
 *     proposed and unconfirmed, solid hairline = machine proposed and human
 *     confirmed, diagonal strike = a human overrode the machine, filled
 *     square = device- or integration-sourced.
 *   LIFECYCLE, by pattern — solid settled, hatched provisional, dotted
 *     waiting on someone else, hollow draft.
 *   QUANTITY, by proportional fill — a 62%-paid invoice shows a 62% rail.
 *   SELECTION, as a 2px brand bar landing in the same 3px so nothing reflows.
 *
 * Scan forty rows and you can see where every number came from without one
 * pixel of colour being spent on it.
 */

export interface RailProps {
  status?: StatusFamily | undefined;
  provenance?: Provenance | undefined;
  /** 0–1. Renders a proportional fill from the bottom: part-paid, part-loaded, stock vs safety level. */
  fillRatio?: number | undefined;
  selected?: boolean | undefined;
  className?: string | undefined;
}

/**
 * Every variant sets the SAME set of properties, and none of them uses the
 * `background` shorthand.
 *
 * A rail changes pattern in place — a row goes from proposed to confirmed and
 * the same element re-renders — so a variant that omitted `backgroundImage`
 * left the previous variant's stripes painted underneath, and mixing the
 * shorthand with the longhand made React warn about it on every pass.
 */
const PATTERN_STYLE: Record<RailPattern, (color: string) => React.CSSProperties> = {
  solid: (c) => ({ backgroundColor: c, backgroundImage: 'none', boxShadow: 'none' }),
  'solid-heavy': (c) => ({ backgroundColor: c, backgroundImage: 'none', boxShadow: 'none' }),
  dotted: (c) => ({
    backgroundColor: 'transparent',
    backgroundImage: `repeating-linear-gradient(to bottom, ${c} 0 3px, transparent 3px 6px)`,
    boxShadow: 'none',
  }),
  hatched: (c) => ({
    backgroundColor: 'transparent',
    backgroundImage: `repeating-linear-gradient(45deg, ${c} 0 2px, transparent 2px 4px)`,
    boxShadow: 'none',
  }),
  hollow: (c) => ({
    backgroundColor: 'transparent',
    backgroundImage: 'none',
    boxShadow: `inset 0 0 0 1px ${c}`,
  }),
};

/**
 * Provenance patterns, used when the rail is carrying provenance ALONE.
 *
 * `human` is deliberately blank: a hand-typed value is the baseline, and
 * marking the common case is how a signal becomes noise. Everything else gets
 * an achromatic mark, so a provenance rail never competes with a status hue.
 */
const PROVENANCE_PATTERN: Record<Provenance, RailPattern | null> = {
  human: null,
  proposed: 'dotted',
  confirmed: 'solid',
  overridden: 'solid',
  device: 'solid-heavy',
};

export function Rail({ status, provenance, fillRatio, selected, className }: RailProps) {
  const spec = status ? STATUS[status] : null;

  // A provenance-only rail must still render. Falling through to
  // `transparent` made the rail's primary job — showing where a number came
  // from — invisible on every table that passed provenance without a status.
  const provenancePattern = provenance ? PROVENANCE_PATTERN[provenance] : null;
  const color = spec ? `var(${spec.colorVar})` : provenancePattern ? 'var(--provisional-rule)' : 'transparent';
  const pattern: RailPattern = spec?.railPattern ?? provenancePattern ?? 'solid';

  // Critical is the only double-width rail in the product. That exclusivity is
  // what makes a breakdown the loudest thing on a 27-inch screen.
  const width = selected ? 2 : pattern === 'solid-heavy' ? 5 : 3;

  const title = [
    spec ? spec.meaning : null,
    provenance ? PROVENANCE_LABEL[provenance] : null,
    fillRatio !== undefined ? `${Math.round(fillRatio * 100)}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const base: React.CSSProperties = selected
    ? { backgroundColor: 'var(--brand)', backgroundImage: 'none', boxShadow: 'none' }
    : (PATTERN_STYLE[pattern](color) as React.CSSProperties);

  return (
    <span
      aria-hidden="true"
      title={title || undefined}
      className={cn('absolute left-0 top-0 bottom-0 shrink-0', className)}
      style={{ width }}
    >
      <span className="absolute inset-0" style={base} />
      {fillRatio !== undefined && !selected ? (
        <span
          className="absolute inset-x-0 bottom-0"
          style={{ height: `${Math.max(0, Math.min(1, fillRatio)) * 100}%`, backgroundColor: color }}
        />
      ) : null}
      {provenance === 'overridden' ? (
        <span
          className="absolute inset-0"
          style={{
            backgroundImage: `repeating-linear-gradient(45deg, var(--text-primary) 0 1px, transparent 1px 3px)`,
            opacity: 0.55,
          }}
        />
      ) : null}
    </span>
  );
}
