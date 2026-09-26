import { Link } from '@tanstack/react-router';
import { can } from '@linck/domain';
import { WORKSPACES } from './nav-manifest.js';
import { useApp } from './store.js';

/**
 * The two building blocks of a role's command board: a row of cards counting
 * what needs this person now, and a row of plain links to the databases they
 * work in.
 *
 * GATED EXACTLY LIKE THE NAV RAIL. A destination is drawn only if the nav
 * manifest lists its route and both of the rail's gates pass: the tenant has
 * the workspace's module switched on, and this person holds the item's
 * permission at the current scope. The board therefore cannot become a side
 * door into a module the tenant never bought — and a destination missing from
 * the manifest is a bug that hides the card rather than one that shows a
 * Forbidden screen.
 */

export interface BoardDestination {
  label: string;
  /** Must be a route listed in the nav manifest; the gates are read from there. */
  to: string;
}

export interface UrgentAction extends BoardDestination {
  count: number;
  /** One line saying exactly which rows are in the count. */
  definition: string;
  priority: 'highest' | 'high' | 'medium';
  /**
   * The colour the count earns while it is non-zero. Separate from priority
   * because the briefs differ: the sales desk wants every card red or amber,
   * the fleet desk wants a medium card neutral.
   */
  accent: 'critical' | 'attention' | 'neutral';
  /** The saved view on the destination that shows exactly these rows. */
  view?: string;
}

/** Priority is not a status, so it is a word and a glyph rather than a stamp. */
const PRIORITY = {
  highest: { glyph: '▲', word: 'Highest' },
  high: { glyph: '◐', word: 'High' },
  medium: { glyph: '◇', word: 'Medium' },
} as const;

const ACCENT_COLOR = {
  critical: 'var(--status-critical)',
  attention: 'var(--status-attention)',
  neutral: 'var(--text-secondary)',
} as const;

/** The two gates the rail applies, looked up from the manifest by route. */
export function useCanOpen(): (to: string) => boolean {
  const { persona, siteScope, enabledModules } = useApp();
  return (to: string) => {
    for (const ws of WORKSPACES) {
      const item = ws.items.find((i) => i.route === to);
      if (!item) continue;
      const moduleOn = ws.module === null || enabledModules.includes(ws.module);
      return moduleOn && can(persona.grants, item.permission, { siteId: siteScope });
    }
    return false;
  };
}

/**
 * URGENT ACTIONS.
 *
 * Built like the product's other count cards: the number in ink at full
 * weight, and the colour spent on the line beneath it — the way the fleet
 * board's "Broken down" tile does it — and only while the count is non-zero.
 * A zero is good news and must not shout in the same red as four unbilled
 * loads.
 *
 * Each card lands on its list, not on the top of the destination page: the
 * link carries `#list`, which every destination puts on its filtered table.
 */
export function UrgentActionsRow({ caption, actions }: { caption: string; actions: UrgentAction[] }) {
  const canOpen = useCanOpen();
  const shown = actions.filter((a) => canOpen(a.to));
  if (shown.length === 0) return null;

  return (
    <section className="px-6 pt-5" aria-label={caption}>
      <p className="pb-2 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {caption}
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 172px), 1fr))' }}>
        {shown.map((a) => {
          const live = a.count > 0;
          const tone = live ? ACCENT_COLOR[a.accent] : 'var(--text-tertiary)';
          const p = PRIORITY[a.priority];
          return (
            <Link
              key={a.label}
              to={a.to}
              search={a.view ? { view: a.view } : {}}
              hash="list"
              className="group flex flex-col gap-1.5 px-4 py-3.5 text-left"
              style={{
                borderRadius: 'var(--r-2)',
                background: 'var(--surface)',
                boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
              }}
            >
              <span className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-[0.04em]">
                <span style={{ color: tone }}>
                  <span aria-hidden="true">{p.glyph}</span> {p.word}
                </span>
                <span className="normal-case tracking-normal opacity-0 transition-opacity group-hover:opacity-100" style={{ color: 'var(--brand)' }}>
                  Open list →
                </span>
              </span>
              <span className="flex items-baseline gap-2">
                <span
                  className="num tabular-nums leading-none"
                  style={{ fontSize: '2rem', letterSpacing: '-0.02em', color: 'var(--text-primary)' }}
                >
                  {a.count}
                </span>
                <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {a.label}
                </span>
              </span>
              <span className="text-[12px]" style={{ color: live ? tone : 'var(--text-secondary)' }}>
                {live ? a.definition : `None right now — ${a.definition.charAt(0).toLowerCase()}${a.definition.slice(1)}`}
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
 * Pure links to a module's full database view — not filters. Set in exactly
 * the filter chip's shape, type and spacing, as the brief asks, with a
 * trailing arrow as the one difference: a chip filters the page, these leave
 * it.
 */
export function DestinationRow({ caption, destinations }: { caption: string; destinations: BoardDestination[] }) {
  const canOpen = useCanOpen();
  const shown = destinations.filter((d) => canOpen(d.to));
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
            className="inline-flex h-9 items-center gap-1.5 px-3 text-[12px] [@media(hover:hover)]:h-7 [@media(hover:hover)]:px-2.5"
            style={{
              borderRadius: 'var(--r-1)',
              color: 'var(--text-secondary)',
              boxShadow: 'inset 0 0 0 1px var(--border-default)',
            }}
          >
            {d.label}
            <span aria-hidden="true" className="opacity-70">
              →
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
