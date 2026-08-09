import { useCallback, useEffect, useRef } from 'react';
import type { StatusFamily } from '@linck/tokens';
import { cn } from '../lib/cn.js';
import { useIsPhone } from '../lib/useBreakpoint.js';
import { StatusStamp } from './StatusStamp.js';

/**
 * THE SIDE SHEET — the default detail surface across the product.
 *
 * Vehicle 360, invoice detail, job card, trip cost sheet and the rest all open
 * over their list, so the operator never loses scroll position in a 400-row
 * table. That is the whole reason this is a sheet and not a route: losing your
 * place in a table you have scrolled to row 380 of is the difference between a
 * tool and a chore.
 *
 * Geometry, per the design system:
 *   - `--r-2` on the LEADING corners only, so it reads as a sheet slid in from
 *     the edge rather than a card floating over the page.
 *   - Leading edge is a 1px `--border-strong` rule. `--e3` is barely present
 *     and exists only to stop that edge dissolving on a bright monitor.
 *   - No backdrop blur, ever. It costs frames on a weighbridge-cabin PC, and
 *     the scrim is a dimmed page, not a blackout.
 *
 * It earns its shadow under the dismissibility rule: Escape closes it.
 *
 * Stacks at most two deep, the second offset 32px. A third level would be a
 * navigation model pretending to be a panel, so it opens a page instead.
 */

export type SheetWidth = 'detail' | 'form' | 'split';

const WIDTH_PX: Record<SheetWidth, number> = {
  detail: 480,
  form: 640,
  split: 840,
};

export interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  width?: SheetWidth | undefined;
  /** 0 = first sheet, 1 = stacked over another. Offsets and dims the one beneath. */
  depth?: 0 | 1 | undefined;
  /** Newsreader title. */
  title: string;
  /**
   * Mono identifier line beneath the title — registration, invoice no, ticket no.
   *
   * These optionals explicitly admit `undefined` rather than relying on the
   * property being absent. Under `exactOptionalPropertyTypes` those are
   * different types, and every caller here derives the value from a nullable
   * selection (`invoice?.number`), so the alternative is a conditional spread
   * at every single call site to say nothing at all.
   */
  identifier?: string | undefined;
  status?:
    | { family: StatusFamily; label: string; severity?: string | number | undefined; provisional?: boolean | undefined }
    | undefined;
  /** `REV 4 · bkumar · 08 AUG 14:32` — who touched it last, right-aligned. */
  revision?: string | undefined;
  footer?: React.ReactNode | undefined;
  children: React.ReactNode;
}

/**
 * Open sheets, innermost last.
 *
 * Escape must close ONE sheet — the top one. Without a shared stack every
 * mounted sheet listens on `document` and a single keypress collapses the whole
 * pile, so a stacked detail-over-detail view loses both levels at once and the
 * operator lands back at the table wondering what happened.
 *
 * A module-level array rather than context, because these are siblings mounted
 * by unrelated screens and there is no common provider to hang state on.
 */
const sheetStack: symbol[] = [];

export function SideSheet({
  open,
  onClose,
  width = 'detail',
  depth = 0,
  title,
  identifier,
  status,
  revision,
  footer,
  children,
}: SideSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const id = useRef<symbol>(Symbol('side-sheet'));
  const phone = useIsPhone();

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Only the topmost sheet acts. The others are still listening, and must
      // do nothing.
      if (event.key !== 'Escape') return;
      if (sheetStack[sheetStack.length - 1] !== id.current) return;
      event.stopPropagation();
      onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return undefined;

    const self = id.current;
    sheetStack.push(self);
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKeyDown);

    // A sheet that opens without moving focus is invisible to a screen reader
    // and unreachable by keyboard — the operator is still tabbing through the
    // 400-row table behind it.
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panelRef.current)?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = sheetStack.lastIndexOf(self);
      if (at !== -1) sheetStack.splice(at, 1);
      // Returning focus to whatever opened the sheet is what makes the row you
      // came from the row you land back on, rather than the top of a 400-row
      // table.
      restoreFocusTo.current?.focus?.();
    };
  }, [open, onKeyDown]);

  if (!open) return null;

  const offset = depth * 32;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40"
        style={{ background: 'var(--surface-overlay)', animation: 'linck-fade var(--dur-confirm) var(--ease)' }}
      />
      {/*
        On a phone the sheet stops being a sheet.

        480px of panel against a 390px screen leaves a 90px sliver of the list
        behind it — too narrow to read and wide enough to catch a stray thumb.
        So it takes the full width, rises from the bottom rather than the side
        (the direction a thumb expects), keeps a top radius so it still reads as
        a layer over the page, and leaves a strip of scrim at the top as the
        "tap here to get out" target.

        The stacking offset also goes: two sheets 32px apart is a desktop
        affordance, and on a phone the second simply covers the first.
      */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'fixed z-50 flex flex-col outline-none',
          phone ? 'inset-x-0 bottom-0' : 'right-0 top-0 bottom-0',
        )}
        style={{
          ...(phone
            ? {
                top: 40,
                borderTopLeftRadius: 'var(--r-2)',
                borderTopRightRadius: 'var(--r-2)',
                borderTop: '1px solid var(--border-strong)',
                paddingBottom: 'env(safe-area-inset-bottom)',
                animation: 'linck-rise var(--dur-layer) var(--ease)',
              }
            : {
                width: `min(${WIDTH_PX[width]}px, calc(100vw - ${offset + 32}px))`,
                marginRight: offset,
                borderLeft: '1px solid var(--border-strong)',
                borderTopLeftRadius: 'var(--r-2)',
                borderBottomLeftRadius: 'var(--r-2)',
                animation: 'linck-slide-in var(--dur-layer) var(--ease)',
              }),
          background: 'var(--surface-raised)',
          boxShadow: 'var(--e3)',
        }}
      >
        <header
          className="sticky top-0 z-10 flex shrink-0 items-start gap-3 px-5 py-3"
          style={{ background: 'var(--surface-raised)', borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-[18px] leading-tight" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h2>
            {identifier ? (
              <p className="font-id mt-0.5 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                {identifier}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {status ? (
              <StatusStamp
                status={status.family}
                label={status.label}
                {...(status.severity !== undefined ? { severity: status.severity } : {})}
                {...(status.provisional ? { provisional: true } : {})}
              />
            ) : null}
            {revision ? (
              <span className="font-id text-[11px] uppercase" style={{ color: 'var(--text-tertiary)' }}>
                {revision}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-1 shrink-0 px-1 text-[16px] leading-none"
            style={{ color: 'var(--text-tertiary)' }}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer
            className="sticky bottom-0 flex h-14 shrink-0 items-center gap-2 px-5"
            style={{ background: 'var(--surface-raised)', borderTop: '1px solid var(--border-subtle)' }}
          >
            {footer}
          </footer>
        ) : null}
      </aside>
    </>
  );
}

/**
 * A label/value row. Labels in Newsreader italic, values in the data face —
 * the same split the rest of the product uses to separate the caption from the
 * fact it captions.
 */
export function Detail({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-0.5 py-2', wide && 'col-span-2')}>
      <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
        {children}
      </span>
    </div>
  );
}

/**
 * Two-column grid of Detail rows, separated by hairlines rather than boxed.
 *
 * One column on a phone. At 375px the sheet is full width, so two columns
 * leaves about 150px per field — narrower than "Headroom against the limit"
 * and narrower than most money values, so every second field wrapped to three
 * lines. A single column is taller and reads in one pass.
 */
export function DetailGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">{children}</div>;
}

/** A titled block inside a sheet. */
export function SheetSection({
  caption,
  actions,
  children,
}: {
  caption: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 first:mt-0">
      <div
        className="mb-2 flex items-baseline justify-between gap-3 pb-1"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <h3 className="text-[11px] font-medium uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>
          {caption}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * The plain-language line that says why something is the way it is.
 * Newsreader italic, because an explanation should read as a margin note
 * rather than as more UI.
 */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </p>
  );
}
