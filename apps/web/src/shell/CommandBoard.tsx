import { Link } from '@tanstack/react-router';
import { can } from '@linck/domain';
import { StatusStamp } from '@linck/ui';
import { useApp } from './store.js';

/**
 * The two building blocks of a role's command board: a row of cards counting
 * what needs this person now, and a row of plain links to the databases they
 * work in.
 *
 * Both are permission-filtered with the same rule as the nav rail. A card or a
 * button that opens onto a Forbidden screen is worse than no card at all, so
 * anything this persona cannot open simply is not drawn.
 */

export interface BoardDestination {
  label: string;
  to: string;
  /** The grant needed to open `to`. Mirrors the route's own gate in router.tsx. */
  permission: string;
}

export interface UrgentAction extends BoardDestination {
  /** What is being counted, as the card's headline noun: "Unraised invoices". */
  count: number;
  /** One line saying exactly which rows are in the count. */
  definition: string;
  /**
   * Highest and high spend colour; medium stays neutral. The word travels with
   * the stamp, so the priority still reads with every hue stripped.
   */
  priority: 'highest' | 'high' | 'medium';
  /** The saved view on the destination that shows exactly these rows. */
  view?: string;
}

const PRIORITY_STAMP = {
  highest: { status: 'critical', label: 'Highest' },
  high: { status: 'attention', label: 'High' },
  medium: { status: 'pending', label: 'Medium' },
} as const;

function useCanOpen() {
  const { persona, siteScope } = useApp();
  return (permission: string) => can(persona.grants, permission, { siteId: siteScope });
}

/**
 * URGENT ACTIONS.
 *
 * A card is a count, the noun it counts and the rule it counts by — nothing
 * else. The count is coloured only while it is non-zero: a zero is good news
 * and must not shout in the same red as four unbilled loads.
 */
export function UrgentActionsRow({ caption, actions }: { caption: string; actions: UrgentAction[] }) {
  const canOpen = useCanOpen();
  const shown = actions.filter((a) => canOpen(a.permission));
  if (shown.length === 0) return null;

  return (
    <section className="px-6 pt-5" aria-label={caption}>
      <p className="pb-2 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {caption}
      </p>
      <div className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))' }}>
        {shown.map((a) => {
          const stamp = PRIORITY_STAMP[a.priority];
          const live = a.count > 0;
          const tone =
            !live || a.priority === 'medium'
              ? 'var(--text-primary)'
              : a.priority === 'highest'
                ? 'var(--status-critical)'
                : 'var(--status-attention)';
          return (
            <Link
              key={a.label}
              to={a.to}
              search={a.view ? { view: a.view } : {}}
              className="group flex flex-col gap-1.5 px-4 py-3.5 text-left"
              style={{
                borderRadius: 'var(--r-1)',
                background: 'var(--surface)',
                boxShadow: `inset 0 0 0 1px ${live && a.priority !== 'medium' ? tone : 'var(--border-default)'}`,
              }}
            >
              <span className="flex items-center justify-between gap-2">
                <StatusStamp
                  status={live ? stamp.status : 'ready'}
                  label={live ? stamp.label : 'Clear'}
                />
                <span className="text-[12px] opacity-0 transition-opacity group-hover:opacity-100" style={{ color: 'var(--brand)' }}>
                  Open list →
                </span>
              </span>
              <span className="flex items-baseline gap-2">
                <span
                  className="num tabular-nums leading-none"
                  style={{ fontSize: '2rem', letterSpacing: '-0.02em', color: tone }}
                >
                  {a.count}
                </span>
                <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {a.label}
                </span>
              </span>
              <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {a.definition}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * NAVIGATION BUTTONS.
 *
 * Pure links to a module's full database view — not filters. They borrow the
 * chip's shape and type so the page does not introduce a third kind of button,
 * but carry an arrow because they leave the page and a chip never does.
 */
export function DestinationRow({ caption, destinations }: { caption: string; destinations: BoardDestination[] }) {
  const canOpen = useCanOpen();
  const shown = destinations.filter((d) => canOpen(d.permission));
  if (shown.length === 0) return null;

  return (
    <nav className="px-6 pt-5" aria-label={caption}>
      <p className="pb-2 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {caption}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {shown.map((d) => (
          <Link
            key={d.label}
            to={d.to}
            className="inline-flex h-9 items-center gap-1.5 px-3 text-[12px] [@media(hover:hover)]:h-8"
            style={{
              borderRadius: 'var(--r-1)',
              color: 'var(--text-primary)',
              boxShadow: 'inset 0 0 0 1px var(--border-default)',
            }}
          >
            {d.label}
            <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>
              →
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
