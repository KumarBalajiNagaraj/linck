import { Fragment } from 'react';
import type { Density, Provenance, StatusFamily } from '@linck/tokens';
import { DENSITY_ROW_PX } from '@linck/tokens';
import { cn } from '../lib/cn.js';
import { useIsPhone } from '../lib/useBreakpoint.js';
import { Rail } from './Rail.js';

/**
 * THE DATA TABLE.
 *
 * Signature move #1 lives here — THE FIVE-LINE RULE. No zebra, no vertical
 * rules inside a column group. Every row gets a subtle separator and every
 * fifth row swaps to a faintly stronger one, exactly like a ruled accounting
 * pad. One line of CSS, and it is what lets a fleet manager track one tipper
 * across twelve columns without losing the row. Zebra doubles the number of
 * background values on screen and makes status tints unreadable; this does
 * the same job for a quarter of the visual cost.
 *
 * Signature move #4 also lives here — the Newsreader italic SUPRA-HEADER
 * spanning a column group, turning twelve columns into four objects without
 * adding a single vertical rule.
 *
 * Deliberate absences: no per-row kebab, no per-row avatar, no icon button in
 * a cell. Three affordances across forty rows is 120 pieces of chrome fighting
 * 480 pieces of data.
 */

export type ColumnType = 'id' | 'text' | 'num' | 'money' | 'status' | 'node';

export interface Column<T> {
  key: string;
  header: string;
  /** Newsreader italic supra-header. Consecutive columns sharing a group are spanned. */
  group?: string;
  type?: ColumnType;
  width?: number | string;
  /** Unit hoisted into the header so no cell has to repeat it: `AMOUNT ₹`, `NET MT`. */
  unit?: string;
  render: (row: T) => React.ReactNode;
  /** Pins the column left and marks it the row's identifier. */
  sticky?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rail?: (row: T) => { status?: StatusFamily; provenance?: Provenance; fillRatio?: number } | undefined;
  density?: Density;
  onRowClick?: ((row: T) => void) | undefined;
  selectedKey?: string | undefined;
  /** Dormant/locked/reversed rows carry the hatch. */
  isDormant?: ((row: T) => boolean) | undefined;
  empty?: React.ReactNode;
  className?: string | undefined;
  /**
   * Below `md`, every row is re-rendered as a card instead of a table row.
   *
   * Set false only for a table narrow enough to stay a table on a phone — a
   * three-column summary, say. A twelve-column board is not made usable by
   * horizontal scrolling; the reader loses the identifier the moment they pan
   * right, which is the one column they need to keep.
   */
  mobileCards?: boolean | undefined;
}

const ALIGN: Record<ColumnType, string> = {
  id: 'text-left',
  text: 'text-left',
  num: 'text-right',
  money: 'text-right',
  status: 'text-left',
  node: 'text-left',
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rail,
  density = 'default',
  onRowClick,
  selectedKey,
  isDormant,
  empty,
  className,
  mobileCards = true,
}: DataTableProps<T>) {
  const phone = useIsPhone();
  const rowH = DENSITY_ROW_PX[density];
  const cellPad = density === 'compact' ? '0 8px' : density === 'comfortable' || density === 'touch' ? '0 16px' : '0 12px';

  // Collapse consecutive columns that share a group into one spanning header.
  const groups: { label: string | null; span: number }[] = [];
  for (const col of columns) {
    const last = groups[groups.length - 1];
    const label = col.group ?? null;
    if (last && last.label === label) last.span += 1;
    else groups.push({ label, span: 1 });
  }
  const hasGroups = groups.some((g) => g.label !== null);

  if (rows.length === 0 && empty) {
    return <div className={cn('w-full', className)}>{empty}</div>;
  }

  if (phone && mobileCards) {
    return (
      <div className={cn('w-full', className)}>
        {rows.map((row) => (
          <RowCard
            key={rowKey(row)}
            row={row}
            columns={columns}
            rail={rail?.(row)}
            selected={selectedKey === rowKey(row)}
            dormant={isDormant?.(row) ?? false}
            {...(onRowClick ? { onSelect: () => onRowClick(row) } : {})}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)} style={{ background: 'var(--surface)' }}>
      <table className="w-full border-collapse text-[13px]" style={{ color: 'var(--text-primary)' }}>
        <thead className="sticky top-0 z-10" style={{ background: 'var(--surface)' }}>
          {hasGroups ? (
            <tr>
              {groups.map((g, i) => (
                <th
                  key={`${g.label ?? 'ungrouped'}-${i}`}
                  colSpan={g.span}
                  className="h-6 px-3 text-left font-serif text-[12px] font-normal italic"
                  style={{
                    color: 'var(--text-tertiary)',
                    borderBottom: g.label ? '1px solid var(--border-subtle)' : 'none',
                    borderLeft: i > 0 && g.label ? '1px solid var(--border-strong)' : 'none',
                  }}
                >
                  {g.label ?? ''}
                </th>
              ))}
            </tr>
          ) : null}
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  'h-7 align-middle text-[11px] font-medium uppercase',
                  ALIGN[col.type ?? 'text'],
                  col.sticky && 'sticky left-0 z-20',
                )}
                style={{
                  padding: cellPad,
                  letterSpacing: '0.06em',
                  color: 'var(--text-tertiary)',
                  width: col.width,
                  background: 'var(--surface)',
                  borderBottom: '1px solid var(--border-strong)',
                  ...(col.sticky ? { borderRight: '1px solid var(--border-strong)' } : {}),
                }}
              >
                {col.header}
                {col.unit ? <span className="ml-1 normal-case">{col.unit}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row);
            const railProps = rail?.(row);
            const selected = selectedKey === key;
            const dormant = isDormant?.(row) ?? false;
            // THE FIVE-LINE RULE: a faintly stronger line every fifth row.
            const fifth = (index + 1) % 5 === 0;

            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                // A row that opens the side sheet is a control, so it has to be
                // reachable by keyboard. The implicit `row` role is kept rather
                // than overwritten with `button` — re-labelling a <tr> costs the
                // screen-reader user the column semantics and the row/column
                // position, which is most of what makes a table navigable.
                // Space is intercepted because its default is to scroll the page
                // out from under the row that is about to open.
                {...(onRowClick
                  ? {
                      tabIndex: 0,
                      'aria-selected': selected,
                      onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        if (event.target !== event.currentTarget) return;
                        event.preventDefault();
                        onRowClick(row);
                      },
                    }
                  : {})}
                className={cn('group', onRowClick && 'cursor-pointer')}
                style={{
                  height: rowH,
                  // `backgroundColor`, never the `background` shorthand: the
                  // shorthand resets background-image, so selecting a dormant
                  // row wiped the hatch that says the row is locked — and React
                  // warns about the mixed shorthand on every rerender besides.
                  backgroundColor: selected ? 'var(--surface-selected)' : 'transparent',
                  backgroundImage: dormant ? 'var(--hatch-pattern)' : 'none',
                }}
              >
                {columns.map((col, colIndex) => (
                  <Fragment key={col.key}>
                    <td
                      className={cn(
                        'relative align-middle whitespace-nowrap',
                        ALIGN[col.type ?? 'text'],
                        col.type === 'id' && 'font-id',
                        (col.type === 'num' || col.type === 'money') && 'num tabular-nums',
                        col.sticky && 'sticky left-0 z-[1]',
                        onRowClick && 'group-hover:[background:var(--surface-selected)]',
                      )}
                      style={{
                        padding: cellPad,
                        height: rowH,
                        borderBottom: `1px solid ${fifth ? 'var(--border-default)' : 'var(--border-subtle)'}`,
                        ...(col.sticky
                          ? {
                              background: selected ? 'var(--surface-selected)' : 'var(--surface)',
                              borderRight: '1px solid var(--border-strong)',
                            }
                          : {}),
                      }}
                    >
                      {/* The rail sits at x=0 of the first cell, inside the row box. */}
                      {colIndex === 0 && (railProps || selected) ? (
                        <Rail
                          status={railProps?.status}
                          provenance={railProps?.provenance}
                          fillRatio={railProps?.fillRatio}
                          selected={selected}
                        />
                      ) : null}
                      {col.render(row) ?? <Dash />}
                    </td>
                  </Fragment>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One row, re-shaped for a phone.
 *
 * THE ARGUMENT FOR NOT JUST SCROLLING. A twelve-column board scrolled sideways
 * on a 390px screen loses the identifier the moment the reader pans right —
 * and the identifier is the one column they need to keep, because it is what
 * tells them which tipper they are looking at. So the row is transposed: the
 * identifier and the status stay pinned at the top of a card, and every other
 * column becomes a labelled pair underneath.
 *
 * The design grammar survives the transposition intact:
 *   - the rail keeps its job on the card's left edge, still carrying status,
 *     provenance and proportional fill;
 *   - column labels reuse the 11px uppercase tertiary of the table header, so
 *     a reader who has seen the desktop table recognises the same fields;
 *   - column groups reuse the Newsreader italic supra-header;
 *   - alignment rules hold — identifiers mono, numbers tabular.
 *
 * The five-line rule does not survive, and does not need to: it exists to help
 * the eye track one row across twelve columns, and a card has already solved
 * that by putting the twelve columns in one box.
 */
function RowCard<T>({
  row,
  columns,
  rail,
  selected,
  dormant,
  onSelect,
}: {
  row: T;
  columns: Column<T>[];
  rail?: { status?: StatusFamily; provenance?: Provenance; fillRatio?: number } | undefined;
  selected: boolean;
  dormant: boolean;
  onSelect?: () => void;
}) {
  const identifier = columns.find((c) => c.sticky) ?? columns[0];
  const status = columns.find((c) => c.type === 'status');

  /*
    A field with nothing in it is DROPPED from a card, where in the table it
    would hold its position and show an en dash.

    That is not an inconsistency, it is the difference between the two shapes. A
    table column exists for every row, so a blank cell has to say "this row has
    no value" out loud or it reads as a broken render. A card is one record, and
    an absent field there already means "nothing recorded" — printing
    "BECAUSE —" on all fifty-eight cards adds two lines of nothing to every one
    of them and buries the fields that do have values.

    The law that `0` and unknown must never look alike still holds: a renderer
    returning zero returns a node and keeps its field. Only a renderer returning
    nothing at all is dropped.
  */
  const rest = columns
    .filter((c) => c !== identifier && c !== status)
    .map((c) => ({ col: c, value: c.render(row) }))
    .filter((f) => f.value !== null && f.value !== undefined && f.value !== false && f.value !== '');

  // Consecutive columns sharing a group become one captioned block, exactly as
  // they become one spanning supra-header on the desktop table. A group whose
  // every field dropped takes its caption with it.
  const blocks: { label: string | null; cols: { col: Column<T>; value: React.ReactNode }[] }[] = [];
  for (const field of rest) {
    const last = blocks[blocks.length - 1];
    const label = field.col.group ?? null;
    if (last && last.label === label) last.cols.push(field);
    else blocks.push({ label, cols: [field] });
  }

  return (
    <div
      onClick={onSelect}
      {...(onSelect
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-pressed': selected,
            onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelect();
            },
          }
        : {})}
      className={cn('relative w-full px-4 py-3 text-left', onSelect && 'cursor-pointer')}
      style={{
        minHeight: 64,
        backgroundColor: selected ? 'var(--surface-selected)' : 'var(--surface)',
        backgroundImage: dormant ? 'var(--hatch-pattern)' : 'none',
        borderBottom: '1px solid var(--border-subtle)',
        paddingLeft: 16,
      }}
    >
      {rail || selected ? (
        <Rail
          status={rail?.status}
          provenance={rail?.provenance}
          fillRatio={rail?.fillRatio}
          selected={selected}
        />
      ) : null}

      <div className="flex items-start justify-between gap-3">
        {identifier ? (
          <div className={cn('min-w-0 flex-1 text-[14px]', identifier.type === 'id' && 'font-id')}>
            {identifier.render(row) ?? <Dash />}
          </div>
        ) : null}
        {status ? <div className="shrink-0">{status.render(row) ?? null}</div> : null}
      </div>

      {blocks.map((block, i) => (
        <div key={block.label ?? `block-${i}`} className="mt-2.5">
          {block.label ? (
            <p
              className="font-serif mb-1 text-[12px] italic"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {block.label}
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {block.cols.map(({ col, value }) => (
              <div key={col.key} className="min-w-0">
                <dt
                  className="text-[11px] font-medium uppercase"
                  style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}
                >
                  {col.header}
                  {col.unit ? <span className="ml-1 normal-case">{col.unit}</span> : null}
                </dt>
                <dd
                  className={cn(
                    'text-[13px]',
                    col.type === 'id' && 'font-id',
                    (col.type === 'num' || col.type === 'money') && 'num tabular-nums',
                  )}
                  style={{ color: 'var(--text-primary)' }}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * An empty cell renders an en dash, never blank.
 * Blank reads as a broken render at a dusty counter — and `0` and "unknown"
 * are different facts that must never look the same.
 */
export function Dash() {
  return (
    <span aria-label="No value" style={{ color: 'var(--text-tertiary)' }}>
      –
    </span>
  );
}
