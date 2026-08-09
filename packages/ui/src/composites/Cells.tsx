import { formatAccounting, formatINR, formatQty, isNegative, type MoneyInput } from '@linck/domain';
import { cn } from '../lib/cn.js';
import { Dash } from './DataTable.js';

/**
 * Money cell.
 *
 * The `₹` is hoisted into the column header so no cell repeats it. Negatives
 * render in accounting parentheses in the critical colour — a minus sign one
 * pixel wide, in a column of forty numbers, gets missed.
 */
export function MoneyCell({
  value,
  accounting = true,
  decimals = 2,
  className,
}: {
  value: MoneyInput | null | undefined;
  accounting?: boolean;
  decimals?: 0 | 2;
  className?: string;
}) {
  if (value === null || value === undefined || value === '') return <Dash />;
  const negative = isNegative(value);
  return (
    <span
      className={cn('num tabular-nums', className)}
      style={negative ? { color: 'var(--status-critical)' } : undefined}
      title={formatINR(value)}
    >
      {accounting ? formatAccounting(value, { decimals }) : formatINR(value, { decimals })}
    </span>
  );
}

/**
 * Quantity cell.
 *
 * CFT, tonne and unit are NOT interchangeable, so the UOM is always visible —
 * either hoisted into the header (single-UOM columns) or as a tertiary suffix
 * (mixed-UOM grids like the live stock board).
 */
export function QuantityCell({
  value,
  decimals = 2,
  uom,
  className,
}: {
  value: number | null | undefined;
  decimals?: number;
  uom?: string;
  className?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <Dash />;
  return (
    <span className={cn('num tabular-nums', className)}>
      {formatQty(value, decimals)}
      {uom ? (
        <span className="ml-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {uom}
        </span>
      ) : null}
    </span>
  );
}

/** Registration numbers, GSTINs, IRNs, UTRs — mono with a slashed zero. */
export function IdCell({ children, className }: { children: React.ReactNode; className?: string }) {
  if (children === null || children === undefined || children === '') return <Dash />;
  return <span className={cn('font-id', className)}>{children}</span>;
}

/** A secondary line under a primary value, for a name under a code. */
export function Stacked({ primary, secondary }: { primary: React.ReactNode; secondary?: React.ReactNode }) {
  return (
    <span className="flex flex-col leading-tight">
      <span>{primary}</span>
      {secondary ? (
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {secondary}
        </span>
      ) : null}
    </span>
  );
}
