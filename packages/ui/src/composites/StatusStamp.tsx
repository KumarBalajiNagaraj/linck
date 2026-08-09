import type { StatusFamily } from '@linck/tokens';
import { STATUS } from '@linck/tokens';
import { cn } from '../lib/cn.js';

/**
 * A STAMP, not a lozenge.
 *
 * 20px tall, 3px radius, tinted background, 1px border in the state colour,
 * a 2px left rail, and a glyph leading the label. Never emoji.
 *
 * Rules that make it work:
 *   - A dashed border overrides everything and means PROVISIONAL.
 *   - Severity is always an integer beside the word, never a shade:
 *     "OVERDUE +14d", not a darker red.
 *   - Where a quantity exists the rail fills proportionally — a 62%-paid
 *     invoice shows a 62%-filled rail.
 *   - Only status carries a 2px left rail. Nothing interactive ever does.
 *     That is how a read-only mark is told apart from a pressable chip, and
 *     it is learned in about ten minutes.
 *
 * Strip every hue and each state remains distinguishable by glyph, word and
 * rail pattern.
 */

export interface StatusStampProps {
  status: StatusFamily;
  /** Short, uppercase, operator's words: READY, ON TRIP, PART-PAID, BREAKDOWN. */
  label: string;
  /** The integer that carries severity: days overdue, loads remaining, count. */
  severity?: string | number | undefined;
  /** 0–1 proportional rail fill. */
  fillRatio?: number | undefined;
  /** Dashed border = asserted but not yet true. Overrides everything. */
  provisional?: boolean | undefined;
  /** Inside a matrix cell the stamp drops its tint and keeps glyph + colour only. */
  bare?: boolean | undefined;
  className?: string | undefined;
}

export function StatusStamp({
  status,
  label,
  severity,
  fillRatio,
  provisional,
  bare,
  className,
}: StatusStampProps) {
  const spec = STATUS[status];
  const color = `var(${spec.colorVar})`;
  const tint = spec.tintVar ? `var(${spec.tintVar})` : 'transparent';

  if (bare) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', className)} style={{ color }}>
        <span aria-hidden="true">{spec.glyph}</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  const railWidth = spec.railPattern === 'solid-heavy' ? 5 : 2;

  return (
    <span
      className={cn(
        'relative inline-flex h-5 items-center gap-1 overflow-hidden pl-[10px] pr-1.5 text-[11px] font-medium leading-none whitespace-nowrap',
        className,
      )}
      style={{
        color,
        background: spec.fill === 'none' ? 'transparent' : spec.fill === 'unbleached' ? 'var(--surface-sunken)' : tint,
        border: `1px ${provisional ? 'dashed' : 'solid'} color-mix(in srgb, ${color} 45%, transparent)`,
        borderRadius: 'var(--r-1)',
      }}
      title={spec.meaning}
    >
      {/* The proportional rail. A 62%-paid invoice shows a 62% rail. */}
      <span aria-hidden="true" className="absolute left-0 top-0 bottom-0" style={{ width: railWidth }}>
        <span
          className="absolute inset-0"
          style={{ background: color, opacity: fillRatio === undefined ? 1 : 0.22 }}
        />
        {fillRatio !== undefined ? (
          <span
            className="absolute inset-x-0 bottom-0"
            style={{ height: `${Math.max(0, Math.min(1, fillRatio)) * 100}%`, background: color }}
          />
        ) : null}
      </span>
      <span aria-hidden="true" className="text-[9px]">
        {spec.glyph}
      </span>
      <span className="uppercase tracking-[0.04em]">{label}</span>
      {severity !== undefined && severity !== null && severity !== '' ? (
        <span className="num tabular-nums">{severity}</span>
      ) : null}
    </span>
  );
}
