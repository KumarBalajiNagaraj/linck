import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { can, formatINRCompact } from '@linck/domain';
import type { StatusFamily } from '@linck/tokens';
import {
  CUSTOMERS_LIST,
  INDENTS,
  INVOICES,
  INVOICE_STATUS_FAMILY,
  INVOICE_STATUS_LABEL,
  NOW,
  SITES,
  TRIPS,
  TRIP_STATUS_FAMILY,
  TRIP_STATUS_LABEL,
  VEHICLES,
  VEHICLE_STATUS_FAMILY,
  VEHICLE_STATUS_LABEL,
  vehiclesForSite,
} from '@linck/mock';
import { cn, EmptyState, StatusStamp } from '@linck/ui';
import type { Persona } from '../auth/personas.js';
import { WORKSPACES, type ModuleKey } from './nav-manifest.js';
import { useApp } from './store.js';

/**
 * THE ANTI-MEGA-MENU.
 *
 * The visible navigation is allowed to stay two levels deep — six workspace
 * glyphs and a short section column — only because everything else in the
 * product is two keystrokes away. This is the "everything else". Remove it and
 * the rail immediately starts growing the sub-menus the shell design refuses.
 *
 * THREE KINDS IN ONE RANKED LIST, not three tabs. An operator who types
 * "1050" does not know whether they are looking for a vehicle, a trip or the
 * screen that lists them, and making them choose a tab first is making them
 * answer a question they opened the palette to ask. Kind becomes a caption
 * over a group once the results exist, and the groups themselves are ordered
 * by their best match — so a registration search puts records above screens
 * without any special-casing.
 *
 * THE TWO GATES ARE THE SAME TWO GATES THE RAIL USES. Module (did the tenant
 * buy the vertical) then permission (may this person open it). A destination
 * that would land on the Forbidden screen must never be offered here: a search
 * result that fails on Enter is worse than no result, because the operator now
 * believes the record does not exist. That is why records are gated on the
 * permission of the SCREEN they open, not on the permission to read the row —
 * Accounts can read a vehicle but cannot open the command board, so vehicles
 * are not offered to Accounts.
 *
 * REGISTRATIONS ARE NORMALISED. The same tipper is "TN 38 AL 1050" on the
 * board, "TN38AL1050" on the RC and "tn38 al1050" in whatever the yard clerk
 * types. All three are one string here, and every token in the query must be
 * found somewhere in the row — so "casa builder" finds Casagrand Builder and
 * "tn 38 1050" finds the vehicle.
 */

/* ------------------------------------------------------------- the entries */

type EntryKind = 'navigate' | 'record' | 'action';

interface Field {
  /** Already normalised. */
  value: string;
  weight: number;
}

interface Entry {
  id: string;
  kind: EntryKind;
  /** Mono tag in the left gutter: SCREEN, VEHICLE, INVOICE, ACTION. */
  tag: string;
  title: string;
  /** Identifiers are mono and slashed-zero; names and labels are not. */
  mono: boolean;
  subtitle: string | null;
  status: { family: StatusFamily; label: string; severity?: string | number | undefined } | null;
  route: string;
  fields: Field[];
}

/** Strips everything a human might or might not type: spaces, slashes, dashes. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function field(text: string, weight: number): Field {
  return { value: norm(text), weight };
}

/**
 * Weights, and why they are these weights.
 *
 * An identifier outranks a name because someone typing "1188" has a slip in
 * their hand. The tag word is deliberately cheap — typing "invoice" should
 * offer the invoice SCREEN first and the individual invoices under it, which
 * is what a 18-weight tag against a 50-weight title produces.
 */
const W_IDENTIFIER = 60;
const W_TITLE = 50;
const W_NAME = 30;
const W_CONTEXT = 25;
const W_TAG = 18;

/** Screens edge ahead of records at equal text score. Records are the long tail. */
const KIND_BONUS: Record<EntryKind, number> = { navigate: 10, action: 8, record: 0 };

function score(entry: Entry, tokens: string[]): number | null {
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const f of entry.fields) {
      const at = f.value.indexOf(token);
      if (at < 0) continue;
      const s = f.weight + (at === 0 ? 20 : 0) + (f.value === token ? 30 : 0);
      if (s > best) best = s;
    }
    // Every token must land somewhere. Two words that each half-match is not a
    // match; it is the fuzzy-search behaviour that makes people stop trusting
    // the first row.
    if (best === 0) return null;
    total += best;
  }
  return total / tokens.length + KIND_BONUS[entry.kind];
}

/* ------------------------------------------------------------ entry sources */

function useEntries(persona: Persona, siteScope: string | null, enabledModules: string[]): Entry[] {
  return useMemo(() => {
    const moduleOn = (m: ModuleKey) => enabledModules.includes(m);
    const allow = (permissions: string[]) => permissions.every((p) => can(persona.grants, p, { siteId: siteScope }));
    const siteCode = (id: string) => SITES.find((s) => s.id === id)?.code ?? '–';
    const entries: Entry[] = [];

    /* NAVIGATION — the manifest, through both gates, exactly as the rail reads it. */
    for (const ws of WORKSPACES) {
      if (ws.module !== null && !moduleOn(ws.module)) continue;
      for (const item of ws.items) {
        if (!allow([item.permission])) continue;
        entries.push({
          id: `nav:${item.key}`,
          kind: 'navigate',
          tag: 'screen',
          title: item.label,
          mono: false,
          subtitle: ws.label,
          status: null,
          route: item.route,
          fields: [field(item.label, W_TITLE), field(ws.label, W_CONTEXT), field('screen', W_TAG)],
        });
      }
    }

    /* VEHICLES — the single most-searched record in the product. */
    if (moduleOn('fleet') && allow(['fleet.board.read'])) {
      for (const v of vehiclesForSite(siteScope)) {
        entries.push({
          id: `veh:${v.id}`,
          kind: 'record',
          tag: 'vehicle',
          title: v.displayReg,
          mono: true,
          subtitle: `${v.model} · ${siteCode(v.siteId)}`,
          status: {
            family: VEHICLE_STATUS_FAMILY[v.status],
            label: VEHICLE_STATUS_LABEL[v.status],
            // Severity is an integer beside the word, never a darker shade —
            // and for a stopped vehicle the integer people ask for is hours.
            ...(v.status === 'breakdown' || v.status === 'under_service'
              ? { severity: `${Math.max(1, Math.round((NOW.getTime() - new Date(v.statusSince).getTime()) / 3_600_000))}h` }
              : {}),
          },
          route: '/fleet/board',
          fields: [field(v.registrationNumber, W_IDENTIFIER), field(v.model, W_CONTEXT), field('vehicle tipper', W_TAG)],
        });
      }
    }

    /* INVOICES and the customers they belong to. */
    if (moduleOn('sales') && allow(['sales.invoice.read'])) {
      for (const inv of INVOICES) {
        entries.push({
          id: `inv:${inv.id}`,
          kind: 'record',
          tag: 'invoice',
          title: inv.number,
          mono: true,
          subtitle: `${inv.customerName} · ${formatINRCompact(inv.total)}`,
          status: {
            family: INVOICE_STATUS_FAMILY[inv.status],
            label: INVOICE_STATUS_LABEL[inv.status],
            ...(inv.daysOverdue > 0 ? { severity: `+${inv.daysOverdue}d` } : {}),
          },
          route: '/sales/invoices',
          fields: [field(inv.number, W_IDENTIFIER), field(inv.customerName, W_NAME), field('invoice bill', W_TAG)],
        });
      }

      for (const c of CUSTOMERS_LIST) {
        const open = INVOICES.filter((i) => i.customerId === c.id && i.status !== 'closed' && i.status !== 'draft');
        entries.push({
          id: `cus:${c.id}`,
          kind: 'record',
          tag: 'customer',
          title: c.name,
          mono: false,
          // The count is the reason anyone looks a customer up, so it is on the
          // row rather than one click further in.
          subtitle: open.length > 0 ? `${c.site} · ${open.length} open ${open.length === 1 ? 'invoice' : 'invoices'}` : c.site,
          status: null,
          route: '/sales/invoices',
          fields: [field(c.name, W_TITLE), field(c.site, W_CONTEXT), field('customer party', W_TAG)],
        });
      }
    }

    /* TRIPS — scoped through the vehicle, since a trip carries no site of its own. */
    if (moduleOn('sales') && allow(['sales.dispatch.read'])) {
      const siteOf = new Map(VEHICLES.map((v) => [v.id, v.siteId] as const));
      const customerOf = new Map(CUSTOMERS_LIST.map((c) => [c.id, c.name] as const));
      for (const t of TRIPS) {
        if (siteScope !== null && siteOf.get(t.vehicleId) !== siteScope) continue;
        const customerName = customerOf.get(t.customerId) ?? '–';
        entries.push({
          id: `trp:${t.id}`,
          kind: 'record',
          tag: 'trip',
          title: t.tripNumber,
          mono: true,
          subtitle: `${customerName} · ${t.productCode}`,
          status: {
            family: TRIP_STATUS_FAMILY[t.status],
            label: TRIP_STATUS_LABEL[t.status],
          },
          route: '/sales/dispatch',
          fields: [field(t.tripNumber, W_IDENTIFIER), field(customerName, W_NAME), field('trip load', W_TAG)],
        });
      }
    }

    /* INDENTS. */
    if (moduleOn('stores') && allow(['stores.indent.read'])) {
      for (const ind of INDENTS) {
        if (siteScope !== null && ind.siteId !== siteScope) continue;
        entries.push({
          id: `ind:${ind.id}`,
          kind: 'record',
          tag: 'indent',
          title: ind.number,
          mono: true,
          subtitle: `${ind.itemName} · ${ind.quantity} ${ind.uom}`,
          status: {
            family: ind.urgency === 'breakdown' && ind.status === 'submitted' ? 'critical' : INDENT_STAGE_FAMILY[ind.status],
            label: INDENT_STAGE_LABEL[ind.status],
          },
          route: '/stores/indents',
          fields: [field(ind.number, W_IDENTIFIER), field(ind.itemName, W_NAME), field(ind.itemCode, W_NAME), field('indent part', W_TAG)],
        });
      }
    }

    /* ACTIONS.
       Each is gated on the capability AND on the read permission of the screen
       it lands on, because holding `stores.indent.create` without
       `stores.indent.read` would otherwise offer a route straight to
       Forbidden. "Raise an indent" lands on the queue, which is where the
       raise form lives today. */
    for (const a of ACTIONS) {
      if (!moduleOn(a.module) || !allow(a.permissions)) continue;
      entries.push({
        id: a.id,
        kind: 'action',
        tag: 'action',
        title: a.title,
        mono: false,
        subtitle: a.subtitle,
        status: null,
        route: a.route,
        fields: [field(a.title, W_TITLE), field(a.keywords, W_CONTEXT), field('action new', W_TAG)],
      });
    }

    return entries;
  }, [persona, siteScope, enabledModules]);
}

const INDENT_STAGE_FAMILY: Record<'submitted' | 'approved' | 'issued' | 'rejected', StatusFamily> = {
  submitted: 'pending',
  approved: 'active',
  issued: 'ready',
  rejected: 'dormant',
};

const INDENT_STAGE_LABEL: Record<'submitted' | 'approved' | 'issued' | 'rejected', string> = {
  submitted: 'Awaiting approval',
  approved: 'Approved',
  issued: 'Issued',
  rejected: 'Rejected',
};

const ACTIONS: ReadonlyArray<{
  id: string;
  title: string;
  subtitle: string;
  route: string;
  module: ModuleKey;
  permissions: string[];
  keywords: string;
}> = [
  {
    id: 'act:fuel',
    title: 'New diesel entry',
    subtitle: 'Fleet · litres, rate and the odometer that makes mileage real',
    route: '/fleet/fuel/new',
    module: 'fleet',
    permissions: ['fleet.fuel.create'],
    keywords: 'diesel fuel def bunk fill litres kmpl',
  },
  {
    id: 'act:indent',
    title: 'Raise an indent',
    subtitle: 'Stores · request a part against an asset',
    route: '/stores/indents',
    module: 'stores',
    permissions: ['stores.indent.read', 'stores.indent.create'],
    keywords: 'indent spare part request purchase stores',
  },
  {
    id: 'act:run',
    title: 'Record a shift',
    subtitle: 'Production · boulder in, product out, downtime accounted',
    route: '/production/runs/new',
    module: 'production',
    permissions: ['production.run.create'],
    keywords: 'shift production run crusher output downtime',
  },
];

/* ------------------------------------------------------------------ groups */

interface Group {
  key: string;
  caption: string;
  entries: Entry[];
  /** Matches held back by the per-group cap. Stated, never silently dropped. */
  more: number;
}

const MAX_PER_GROUP = 6;

const GROUP_CAPTION: Record<EntryKind, string> = {
  navigate: 'Screens you can open',
  record: 'Records that match',
  action: 'Things you can start',
};

const KIND_ORDER: EntryKind[] = ['navigate', 'record', 'action'];

/* --------------------------------------------------------------- the panel */

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { persona, siteScope, enabledModules } = useApp();
  const navigate = useNavigate();
  const entries = useEntries(persona, siteScope, enabledModules);

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  /** Genuinely recent, not a hardcoded "suggested" list. Written on every open. */
  const [recent, setRecent] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tokens = useMemo(() => query.split(/\s+/).map(norm).filter((t) => t.length > 0), [query]);

  const groups = useMemo<Group[]>(() => {
    // EMPTY QUERY. A palette that shows nothing until you type teaches people
    // it is a search box; showing where they have been and where they usually
    // start teaches them it is the navigation.
    if (tokens.length === 0) {
      const byId = new Map(entries.map((e) => [e.id, e] as const));
      const recentEntries = recent.map((id) => byId.get(id)).filter((e): e is Entry => e !== undefined);
      const recentIds = new Set(recentEntries.map((e) => e.id));
      // Screens first, then everything this persona is allowed to START. The
      // actions are the half of the palette nobody discovers by typing,
      // because you have to already know they are called "Record a shift".
      const screens = entries.filter((e) => e.kind === 'navigate' && !recentIds.has(e.id)).slice(0, 4);
      const doable = entries.filter((e) => e.kind === 'action' && !recentIds.has(e.id));
      const out: Group[] = [];
      if (recentEntries.length > 0) {
        out.push({ key: 'recent', caption: 'Where you were last', entries: recentEntries, more: 0 });
      }
      if (screens.length > 0) {
        out.push({ key: 'likely', caption: 'Where this role usually starts', entries: screens, more: 0 });
      }
      if (doable.length > 0) {
        out.push({ key: 'doable', caption: 'Things you can start', entries: doable, more: 0 });
      }
      return out;
    }

    const scored = entries
      .map((entry) => ({ entry, s: score(entry, tokens) }))
      .filter((r): r is { entry: Entry; s: number } => r.s !== null);

    const out: Group[] = [];
    for (const kind of KIND_ORDER) {
      const items = scored.filter((r) => r.entry.kind === kind).sort((a, b) => b.s - a.s);
      if (items.length === 0) continue;
      out.push({
        key: kind,
        caption: GROUP_CAPTION[kind],
        entries: items.slice(0, MAX_PER_GROUP).map((r) => r.entry),
        more: Math.max(0, items.length - MAX_PER_GROUP),
      });
    }
    // One ranked list wearing captions: the group holding the strongest single
    // match leads, so typing a registration puts records above screens.
    const bestOf = (g: Group) => {
      const first = g.entries[0];
      return first ? (score(first, tokens) ?? 0) : 0;
    };
    return out.sort((a, b) => bestOf(b) - bestOf(a));
  }, [entries, tokens, recent]);

  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);

  useEffect(() => {
    setIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    inputRef.current?.focus();
  }, [open]);

  // Keep the highlighted row on screen without animating the list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, open, groups]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length));
        return;
      }
      if (e.key === 'Enter') {
        const entry = flat[index];
        if (entry) {
          e.preventDefault();
          activate(entry);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // `activate` is intentionally out of the dependency list — it is hoisted,
    // it closes over nothing that changes between renders, and re-binding the
    // window listener on every keystroke is how a palette drops a keypress.
  }, [open, flat, index, onOpenChange]);

  function activate(entry: Entry) {
    setRecent((prev) => [entry.id, ...prev.filter((id) => id !== entry.id)].slice(0, 4));
    onOpenChange(false);
    void navigate({ to: entry.route });
  }

  if (!open) return null;

  let cursor = -1;

  return (
    <>
      <div aria-hidden="true" onClick={() => onOpenChange(false)} className="fixed inset-0 z-[70]" style={{ background: 'var(--surface-overlay)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search or jump to"
        className="fixed left-1/2 top-[12vh] z-[71] flex max-h-[70vh] flex-col overflow-hidden"
        style={{
          width: 'min(620px, calc(100vw - 32px))',
          transform: 'translateX(-50%)',
          background: 'var(--surface-raised)',
          borderRadius: 'var(--r-3)',
          boxShadow: 'var(--e1)',
          border: '1px solid var(--border-default)',
          animation: 'linck-fade var(--dur-layer) var(--ease)',
        }}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 px-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <span aria-hidden="true" className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="linck-palette-results"
            aria-autocomplete="list"
            placeholder="Registration, invoice number, customer, or a screen"
            className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-[color:var(--text-tertiary)]"
            style={{ color: 'var(--text-primary)' }}
          />
          <span className="font-id text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            esc
          </span>
        </div>

        <div ref={listRef} id="linck-palette-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <EmptyState
              fact="Nothing here matches that."
              because="Registrations match with or without spaces, and invoices and trips match on their number. Screens you cannot open are never listed."
              action={{ label: 'Clear the query', onClick: () => setQuery('') }}
            />
          ) : (
            groups.map((group) => (
              <div key={group.key}>
                <p className="px-4 pb-1 pt-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  {group.caption}
                </p>
                {group.entries.map((entry) => {
                  cursor += 1;
                  const selected = cursor === index;
                  const at = cursor;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-selected={selected}
                      onMouseMove={() => setIndex(at)}
                      onClick={() => activate(entry)}
                      className="flex h-9 w-full items-center gap-3 px-4 text-left text-[13px]"
                      style={{ background: selected ? 'var(--surface-selected)' : 'transparent' }}
                    >
                      <span className="font-id w-[54px] shrink-0 text-[10px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
                        {entry.tag}
                      </span>
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className={cn('truncate', entry.mono && 'font-id')} style={{ color: 'var(--text-primary)' }}>
                          {entry.title}
                        </span>
                        {entry.subtitle ? (
                          <span className="truncate text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                            {entry.subtitle}
                          </span>
                        ) : null}
                      </span>
                      {entry.status ? (
                        <span className="shrink-0">
                          <StatusStamp status={entry.status.family} label={entry.status.label} severity={entry.status.severity} />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {group.more > 0 ? (
                  <p className="px-4 pb-1 pt-0.5 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                    {group.more} more match — keep typing to narrow it.
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div
          className="flex h-8 shrink-0 items-center gap-4 px-4 text-[11px]"
          style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
        >
          <span>
            <span className="font-id">↑↓</span> move
          </span>
          <span>
            <span className="font-id">↵</span> open
          </span>
          <span className="ml-auto num tabular-nums">{flat.length === 0 ? 'no matches' : `${flat.length} shown`}</span>
        </div>
      </div>
    </>
  );
}
