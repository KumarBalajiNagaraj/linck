import { useMemo, useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { can } from '@linck/domain';
import { DENSITIES, type Density } from '@linck/tokens';
import { ALERTS, documentExposure, expensesForSite, fleetCounts, INDENTS, EXTRACTION_JOBS, pendingVerification, SITES } from '@linck/mock';
import { Button, StatusStamp, useIsPhone } from '@linck/ui';
import { PERSONAS } from '../auth/personas.js';
import { CommandPalette } from './CommandPalette.js';
import { MODULES, WORKSPACES, type ModuleKey } from './nav-manifest.js';
import { useApp } from './store.js';
import { useExpenses } from '../features/expenses/expenseStore.js';

export function AppShell({ children }: { children: React.ReactNode }) {
  const { persona, siteScope, enabledModules, density, theme, setPersona, setSiteScope, setEnabledModules, setDensity, toggleTheme } =
    useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  // The palette is mounted at all times, closed, because ⌘K has to work from
  // any screen — the listener lives inside it and cannot be conditional.
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Two gates, and both must pass.
  //
  // The module gate asks whether this TENANT bought the vertical: a transport
  // client has no crusher, so Production is not a screen they lack access to,
  // it is a screen that does not exist for them. The permission gate then asks
  // whether THIS PERSON may use what the tenant has. Collapsing the two would
  // mean granting a permission could conjure a workspace for a tenant that
  // never bought it.
  //
  // A workspace surviving both leaves most staff with two or three icons and
  // the MD with all of them. That is what stops the mega-menu.
  const visible = useMemo(
    () =>
      WORKSPACES.filter((ws) => ws.module === null || enabledModules.includes(ws.module))
        .map((ws) => ({
          ...ws,
          items: ws.items.filter((item) => can(persona.grants, item.permission, { siteId: siteScope })),
        }))
        .filter((ws) => ws.items.length > 0),
    [persona, siteScope, enabledModules],
  );

  const active = visible.find((ws) => ws.items.some((i) => pathname.startsWith(i.route.split('/').slice(0, 3).join('/')))) ?? visible[0];

  const badges = useBadges(siteScope);
  const criticalAlerts = ALERTS.filter((a) => a.status === 'critical').length;

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--surface-base)' }}>
      {/* ── Topbar: exactly four things beyond the mark ───────────────── */}
      {/* `gap-2` on a phone, not `gap-4`. Six controls with 16px between them
          spend 80px of a 375px screen on nothing at all, which is part of what
          pushed the session glyph clean off the right edge. */}
      <header
        className="flex h-[52px] shrink-0 items-center gap-2 px-3 md:gap-4"
        style={{ background: 'var(--surface-base)', borderBottom: '1px solid var(--border-strong)' }}
      >
        {/* The wordmark goes below `sm`, the mark stays. Those 50px buy the
            site-scope chip enough room to print the whole plant code, and of
            the two the plant code is the one that stops an issue being booked
            against the wrong crusher. */}
        <Link to="/" className="flex shrink-0 items-center gap-2 pl-1 pr-2">
          <Mark />
          <span className="hidden font-serif text-[18px] tracking-tight sm:inline" style={{ color: 'var(--text-primary)' }}>
            Linck
          </span>
        </Link>

        {/* The site context chip is always visible, never buried: a stores clerk
            issuing a part against the wrong plant is the expensive mistake. */}
        <ScopeSwitcher
          siteScope={siteScope}
          onChange={setSiteScope}
          allowedSiteIds={persona.siteIds}
          canSeeAllSites={persona.defaultSiteId === null}
        />

        <div className="flex-1" />

        {/*
          The reason the rail is allowed to be two levels deep. Every screen,
          every vehicle and every invoice is reachable from here, so nothing
          has to earn a permanent slot in the navigation to be findable.
        */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          className="hidden h-8 shrink-0 items-center gap-2 px-3 text-[13px] lg:flex"
          style={{
            color: 'var(--text-tertiary)',
            borderRadius: 'var(--r-1)',
            boxShadow: 'inset 0 0 0 1px var(--border-default)',
            minWidth: 200,
          }}
        >
          <span>Search or jump to</span>
          <span className="font-id ml-auto text-[11px]">⌘K</span>
        </button>

        {/* Same palette, one glyph wide. There is no keyboard to press ⌘K on.
            It holds until `lg`, not `md`: the 200px search field and the
            persona switcher together outrun a 768px tablet bar, and the thing
            that was giving way to make room for them was the site scope. */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          aria-label="Search or jump to"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-[15px] lg:hidden"
          style={{ color: 'var(--text-secondary)', borderRadius: 'var(--r-1)' }}
        >
          <span aria-hidden="true">⌕</span>
        </button>

        <button
          type="button"
          onClick={() => setAlertsOpen((v) => !v)}
          className="relative flex h-11 shrink-0 items-center gap-1 px-1.5 text-[13px] md:h-8 md:gap-1.5 md:px-2"
          style={{ color: 'var(--text-secondary)', borderRadius: 'var(--r-1)' }}
          title="Alerts"
        >
          <span aria-hidden="true">◔</span>
          {/*
            A tabular integer, never a bare red dot — "how many" is the point.
            And the critical count is written out separately rather than being
            carried by the colour of the total: "12" in red says something is
            wrong without saying how much, which is the exact failure LAW 2
            exists to prevent. The glyph carries the severity too, so this
            still reads in greyscale.
          */}
          <span className="num tabular-nums text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            {ALERTS.length}
          </span>
          {criticalAlerts > 0 ? (
            <span
              className="num tabular-nums text-[12px] font-medium"
              style={{ color: 'var(--status-critical)' }}
              title={`${criticalAlerts} need acting on now`}
            >
              <span aria-hidden="true" className="mr-0.5 text-[9px]">
                ▲
              </span>
              {criticalAlerts}
            </span>
          ) : null}
        </button>

        <DensityToggle density={density} onChange={setDensity} />

        {/* Below `md` this lives in the session sheet beside density, for the
            same reason density does: it is a preference, and preferences lose
            to the site scope chip when there are only 375px to spend. */}
        <button
          type="button"
          onClick={toggleTheme}
          className="hidden shrink-0 text-[13px] md:block md:h-8 md:w-auto md:px-2"
          style={{ color: 'var(--text-secondary)', borderRadius: 'var(--r-1)' }}
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
        >
          {theme === 'light' ? '◐' : '◑'}
        </button>

        {/* Two <select>s and a two-line name do not fit beside a scope chip on
            a 390px screen. On a phone they move into a sheet behind one glyph. */}
        <div className="hidden items-center gap-4 md:flex">
          <TenantShapeSwitcher enabledModules={enabledModules} onChange={setEnabledModules} />
          <PersonaSwitcher currentKey={persona.key} onChange={setPersona} name={persona.name} role={persona.roleLabel} />
        </div>

        <button
          type="button"
          onClick={() => setWhoOpen(true)}
          aria-haspopup="dialog"
          aria-label="Signed in as"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-[15px] md:hidden"
          style={{ color: 'var(--text-secondary)', borderRadius: 'var(--r-1)' }}
        >
          <span aria-hidden="true">☰</span>
        </button>
      </header>

      {whoOpen ? (
        <>
          <div aria-hidden="true" onClick={() => setWhoOpen(false)} className="fixed inset-0 z-40 md:hidden" style={{ background: 'var(--surface-overlay)' }} />
          <div
            role="dialog"
            aria-label="Session"
            className="fixed inset-x-0 bottom-0 z-50 px-5 pb-5 pt-4 md:hidden"
            style={{
              background: 'var(--surface-raised)',
              borderTopLeftRadius: 'var(--r-2)',
              borderTopRightRadius: 'var(--r-2)',
              borderTop: '1px solid var(--border-strong)',
              boxShadow: 'var(--e2)',
              paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
              animation: 'linck-rise var(--dur-layer) var(--ease)',
            }}
          >
            <p className="font-serif text-[18px]" style={{ color: 'var(--text-primary)' }}>
              {persona.name}
            </p>
            <p className="mb-4 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
              {persona.roleLabel}
            </p>

            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  Signed in as
                </span>
                <select
                  value={persona.key}
                  onChange={(e) => setPersona(e.target.value)}
                  className="h-11 px-2 text-[14px]"
                  style={{
                    background: 'var(--surface)',
                    color: 'var(--text-primary)',
                    borderRadius: 'var(--r-1)',
                    boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                  }}
                >
                  {PERSONAS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.roleLabel}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  Row density
                </span>
                <select
                  value={density}
                  onChange={(e) => setDensity(e.target.value as Density)}
                  className="h-11 px-2 text-[14px]"
                  style={{
                    background: 'var(--surface)',
                    color: 'var(--text-primary)',
                    borderRadius: 'var(--r-1)',
                    boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                  }}
                >
                  {DENSITIES.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>

              {/* The topbar theme toggle collapses into this sheet below `md`. */}
              <button
                type="button"
                onClick={toggleTheme}
                className="flex h-11 items-center justify-between px-2 text-[14px]"
                style={{
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  borderRadius: 'var(--r-1)',
                  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                }}
              >
                <span>Appearance</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  <span aria-hidden="true" className="mr-1.5">
                    {theme === 'light' ? '◐' : '◑'}
                  </span>
                  {theme === 'light' ? 'Light' : 'Dark'}
                </span>
              </button>
            </div>

            <Button className="mt-5 w-full" onClick={() => setWhoOpen(false)}>
              Close
            </Button>
          </div>
        </>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* ── Workspace rail ─────────────────────────────────────────────── */}
        {/* Hidden on a phone, where it reappears as a bottom tab bar — a
            52px column costs 13% of a 390px screen to show six glyphs, and
            the bottom edge is where a thumb already is. */}
        <nav
          className="hidden w-[52px] shrink-0 flex-col items-center gap-1 py-2 md:flex"
          style={{ background: 'var(--surface-base)', borderRight: '1px solid var(--border-strong)' }}
        >
          {visible.map((ws) => {
            const isActive = active?.key === ws.key;
            const first = ws.items[0];
            if (!first) return null;
            return (
              <Link
                key={ws.key}
                to={first.route}
                className="group relative flex h-10 w-10 items-center justify-center text-[17px]"
                style={{
                  borderRadius: 'var(--r-1)',
                  background: isActive ? 'var(--surface-selected)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-tertiary)',
                }}
                title={ws.label}
              >
                {isActive ? (
                  <span aria-hidden="true" className="absolute left-0 top-1 bottom-1 w-[2px]" style={{ background: 'var(--brand)' }} />
                ) : null}
                <span aria-hidden="true">{ws.glyph}</span>
                <span className="sr-only">{ws.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* ── Section column ─────────────────────────────────────────────── */}
        {active ? (
          <aside
            className="hidden w-[232px] shrink-0 flex-col py-3 lg:flex"
            style={{ background: 'var(--surface-base)', borderRight: '1px solid var(--border-strong)' }}
          >
            <p className="px-4 pb-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {active.label}
            </p>
            {active.items.map((item) => {
              const isActive = pathname === item.route;
              const badge = item.badge ? badges[item.badge] : undefined;
              return (
                <Link
                  key={item.key}
                  to={item.route}
                  className="relative flex h-[30px] items-center gap-2 px-4 text-[13px]"
                  style={{
                    background: isActive ? 'var(--surface-selected)' : 'transparent',
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  {isActive ? (
                    <span aria-hidden="true" className="absolute right-0 top-0 bottom-0 w-[2px]" style={{ background: 'var(--brand)' }} />
                  ) : null}
                  <span className="truncate">{item.label}</span>
                  {badge && badge.count > 0 ? (
                    <span
                      className="num ml-auto tabular-nums text-[11px]"
                      style={{ color: badge.tone === 'critical' ? 'var(--status-critical)' : 'var(--text-tertiary)' }}
                    >
                      {badge.count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </aside>
        ) : null}

        {/* ── Content ────────────────────────────────────────────────────── */}
        <main className="min-w-0 flex-1 overflow-y-auto" style={{ background: 'var(--surface)' }}>
          {/* Sections become a horizontally scrolling strip on a phone, so
              moving between screens inside a workspace is still one tap
              rather than a trip through a menu. */}
          {active && active.items.length > 1 ? (
            <div
              className="sticky top-0 z-20 flex gap-1 overflow-x-auto px-3 py-2 lg:hidden"
              style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border-subtle)' }}
            >
              {active.items.map((item) => {
                const isActive = pathname === item.route;
                const badge = item.badge ? badges[item.badge] : undefined;
                return (
                  <Link
                    key={item.key}
                    to={item.route}
                    className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-[13px]"
                    style={{
                      borderRadius: 'var(--r-1)',
                      background: isActive ? 'var(--brand-tint)' : 'transparent',
                      color: isActive ? 'var(--brand)' : 'var(--text-secondary)',
                      boxShadow: `inset 0 0 0 1px ${isActive ? 'var(--brand)' : 'var(--border-default)'}`,
                    }}
                  >
                    {item.label}
                    {badge && badge.count > 0 ? (
                      <span
                        className="num tabular-nums text-[11px]"
                        style={{ color: badge.tone === 'critical' ? 'var(--status-critical)' : 'var(--text-tertiary)' }}
                      >
                        {badge.count}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ) : null}

          {children}

          {/* Clears the fixed tab bar, plus the home indicator on an iPhone. */}
          <div className="md:hidden" style={{ height: `calc(60px + env(safe-area-inset-bottom))` }} />
        </main>

        {alertsOpen ? <AlertDrawer onClose={() => setAlertsOpen(false)} /> : null}
      </div>

      <BottomTabs workspaces={visible} activeKey={active?.key} badges={badges} />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/**
 * The workspace rail, on a phone.
 *
 * Five slots, because a sixth on a 390px screen makes every label unreadable —
 * anything past the fifth goes behind "More". The badge is a count, not a dot,
 * for the same reason it is a count everywhere else: "how many" is the point.
 */
function BottomTabs({
  workspaces,
  activeKey,
  badges,
}: {
  workspaces: { key: string; label: string; glyph: string; items: { route: string; badge?: string | undefined }[] }[];
  activeKey: string | undefined;
  badges: Record<string, { count: number; tone: 'critical' | 'neutral' }>;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = workspaces.length > 5 ? workspaces.slice(0, 4) : workspaces.slice(0, 5);
  const overflow = workspaces.length > 5 ? workspaces.slice(4) : [];

  const countFor = (ws: (typeof workspaces)[number]) =>
    ws.items.reduce((n, item) => n + (item.badge ? (badges[item.badge]?.count ?? 0) : 0), 0);

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex md:hidden"
        style={{
          background: 'var(--surface-base)',
          borderTop: '1px solid var(--border-strong)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {primary.map((ws) => {
          const isActive = activeKey === ws.key;
          const first = ws.items[0];
          if (!first) return null;
          const count = countFor(ws);
          return (
            <Link
              key={ws.key}
              to={first.route}
              className="relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2"
              style={{ minHeight: 56, color: isActive ? 'var(--brand)' : 'var(--text-tertiary)' }}
            >
              {isActive ? (
                <span aria-hidden="true" className="absolute inset-x-3 top-0 h-[2px]" style={{ background: 'var(--brand)' }} />
              ) : null}
              {/* The count hangs off the GLYPH, not off a percentage of the
                  tab. Anchored at `right-[18%]` of the link it drifted further
                  out the fewer workspaces a persona had — on a two-tab bar it
                  floated in open space 60px from the icon it was counting. */}
              <span className="relative text-[16px] leading-none">
                <span aria-hidden="true">{ws.glyph}</span>
                {count > 0 ? (
                  <span
                    className="num absolute -right-3 -top-1 tabular-nums text-[10px] font-medium"
                    style={{ color: 'var(--status-critical)' }}
                  >
                    {count}
                  </span>
                ) : null}
              </span>
              <span className="text-[10px] leading-none">{ws.label}</span>
            </Link>
          );
        })}
        {overflow.length > 0 ? (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2"
            style={{ minHeight: 56, color: 'var(--text-tertiary)' }}
          >
            <span aria-hidden="true" className="text-[16px] leading-none">
              ⋯
            </span>
            <span className="text-[10px] leading-none">More</span>
          </button>
        ) : null}
      </nav>

      {moreOpen ? (
        <>
          <div aria-hidden="true" onClick={() => setMoreOpen(false)} className="fixed inset-0 z-40 md:hidden" style={{ background: 'var(--surface-overlay)' }} />
          <div
            role="dialog"
            aria-label="More workspaces"
            className="fixed inset-x-0 bottom-0 z-50 md:hidden"
            style={{
              background: 'var(--surface-raised)',
              borderTopLeftRadius: 'var(--r-2)',
              borderTopRightRadius: 'var(--r-2)',
              borderTop: '1px solid var(--border-strong)',
              boxShadow: 'var(--e2)',
              paddingBottom: 'env(safe-area-inset-bottom)',
              animation: 'linck-rise var(--dur-layer) var(--ease)',
            }}
          >
            {overflow.map((ws) => {
              const first = ws.items[0];
              if (!first) return null;
              return (
                <Link
                  key={ws.key}
                  to={first.route}
                  onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 px-5 text-[15px]"
                  style={{ minHeight: 52, borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                >
                  <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>
                    {ws.glyph}
                  </span>
                  {ws.label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              className="w-full px-5 text-[15px]"
              style={{ minHeight: 52, color: 'var(--text-tertiary)' }}
            >
              Close
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

function useBadges(siteScope: string | null): Record<string, { count: number; tone: 'critical' | 'neutral' }> {
  const bills = useExpenses((s) => s.bills);
  return useMemo(() => {
    const docs = documentExposure(siteScope);
    const fleet = fleetCounts(siteScope);
    return {
      expiring_docs: { count: docs.expired + docs.expiringSoon, tone: docs.expired > 0 ? 'critical' : 'neutral' },
      unverified_receipts: { count: pendingVerification().length, tone: 'neutral' },
      extraction_queue: { count: EXTRACTION_JOBS.length, tone: 'neutral' },
      open_indents: { count: INDENTS.filter((i) => i.status === 'submitted').length, tone: 'neutral' },
      breakdowns: { count: fleet.breakdown, tone: fleet.breakdown > 0 ? 'critical' : 'neutral' },
      pending_expenses: { count: expensesForSite(siteScope, 'fleet', bills).filter((e) => e.status === 'submitted').length, tone: 'neutral' },
    };
  }, [siteScope, bills]);
}

function ScopeSwitcher({
  siteScope,
  onChange,
  allowedSiteIds,
  canSeeAllSites,
}: {
  siteScope: string | null;
  onChange: (id: string | null) => void;
  allowedSiteIds: string[];
  canSeeAllSites: boolean;
}) {
  const sites = SITES.filter((s) => allowedSiteIds.includes(s.id));
  const current = siteScope ? sites.find((s) => s.id === siteScope) : null;
  const phone = useIsPhone();
  // `SITE · ` is 7 characters of prefix on a bar that has ~145px to spend. The
  // visually-hidden label already names this control, so on a phone the prefix
  // is dropped and the whole plant code is shown instead of a truncated one —
  // "KRP-CRUS…" and "KRP-WORK…" are the two a workshop clerk must not confuse.
  const prefix = phone ? '' : 'SITE · ';

  // A user with a single site sees a static breadcrumb, not a dropdown.
  if (sites.length === 1 && !canSeeAllSites) {
    return (
      <span className="font-id shrink-0 whitespace-nowrap text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {prefix}
        {sites[0]!.code}
      </span>
    );
  }

  // `min-w-max` from `md` up: the chip may be capped and truncated on a phone,
  // where there is genuinely no room, but above that it must never be the flex
  // item that gives — a topbar that shortens "KRP-CRUSHER-01" to "AL…" has
  // thrown away the one field this control exists to show.
  return (
    <label className="flex min-w-0 items-center gap-2 md:min-w-max">
      <span className="sr-only">Site scope</span>
      {/* Capped on a phone. Left to size itself the native select took 190px of
          a 375px topbar — half the bar for one chip — and shoved the alerts,
          theme and session controls past the right edge, where the shell's
          `overflow-hidden` silently cut them off rather than scrolling to them. */}
      <select
        value={siteScope ?? '__all'}
        onChange={(e) => onChange(e.target.value === '__all' ? null : e.target.value)}
        className="font-id h-8 min-w-0 max-w-[152px] truncate px-2 text-[12px] md:max-w-none"
        style={{
          background: 'var(--surface)',
          color: 'var(--text-secondary)',
          borderRadius: 'var(--r-1)',
          boxShadow: 'inset 0 0 0 1px var(--border-strong)',
        }}
      >
        {canSeeAllSites ? <option value="__all">ALL SITES</option> : null}
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {prefix}
            {s.code}
          </option>
        ))}
      </select>
      {current ? (
        <span className="hidden text-[12px] xl:inline" style={{ color: 'var(--text-tertiary)' }}>
          {current.name}
        </span>
      ) : null}
    </label>
  );
}

function DensityToggle({ density, onChange }: { density: Density; onChange: (d: Density) => void }) {
  return (
    <label className="hidden items-center xl:flex">
      <span className="sr-only">Row density</span>
      <select
        value={density}
        onChange={(e) => onChange(e.target.value as Density)}
        className="h-8 px-2 text-[12px]"
        style={{ background: 'transparent', color: 'var(--text-secondary)', borderRadius: 'var(--r-1)' }}
        title="Row density — persisted per user per table in the real product"
      >
        {DENSITIES.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The three tenant shapes Linck actually sells into. Nothing about a shape is
 * a code path — each is just a row set in `core.organization_modules`.
 */
const TENANT_SHAPES: ReadonlyArray<{ key: string; label: string; modules: ModuleKey[] }> = [
  { key: 'both', label: 'Crusher + fleet', modules: [...MODULES] },
  { key: 'crusher', label: 'Crusher only', modules: MODULES.filter((m) => m !== 'fleet') },
  { key: 'fleet', label: 'Fleet only', modules: MODULES.filter((m) => m !== 'production' && m !== 'stores') },
];

function shapeKeyFor(enabledModules: string[]): string {
  const current = [...enabledModules].sort().join(',');
  return TENANT_SHAPES.find((s) => [...s.modules].sort().join(',') === current)?.key ?? 'both';
}

/**
 * Demo-only control, and the only thing in the app that writes
 * `enabledModules`. In production the module set arrives on the session and
 * the tenant cannot change its own shape from the topbar.
 *
 * It earns its place next to the persona switcher because the two together
 * are the whole gating model: shape says what the client bought, persona says
 * who is looking. Switching to "Fleet only" and watching Production leave the
 * rail is the fastest proof that no screen assumes a crusher exists.
 */
function TenantShapeSwitcher({ enabledModules, onChange }: { enabledModules: string[]; onChange: (modules: string[]) => void }) {
  return (
    <label className="hidden items-center xl:flex">
      <span className="sr-only">Tenant shape</span>
      <select
        value={shapeKeyFor(enabledModules)}
        onChange={(e) => onChange([...(TENANT_SHAPES.find((s) => s.key === e.target.value)?.modules ?? MODULES)])}
        className="h-8 px-2 text-[12px]"
        style={{
          background: 'var(--surface)',
          color: 'var(--text-secondary)',
          borderRadius: 'var(--r-1)',
          boxShadow: 'inset 0 0 0 1px var(--border-strong)',
        }}
        title="Demo: switch which verticals this tenant has bought"
      >
        {TENANT_SHAPES.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Demo-only control. In production the session comes from Google sign-in and
 * this does not exist — but switching persona here exercises the real
 * permission-filtered nav, so it is the fastest way to check that a screen is
 * reachable by exactly the people it should be.
 */
function PersonaSwitcher({
  currentKey,
  onChange,
  name,
  role,
}: {
  currentKey: string;
  onChange: (key: string) => void;
  name: string;
  role: string;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Signed in as</span>
      <span className="hidden flex-col items-end leading-tight sm:flex">
        <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
          {name}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {role}
        </span>
      </span>
      <select
        value={currentKey}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 px-2 text-[12px]"
        style={{
          background: 'var(--surface)',
          color: 'var(--text-secondary)',
          borderRadius: 'var(--r-1)',
          boxShadow: 'inset 0 0 0 1px var(--border-strong)',
        }}
        title="Demo: switch persona to see permission-filtered navigation"
      >
        {PERSONAS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.roleLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function AlertDrawer({ onClose }: { onClose: () => void }) {
  return (
    <aside
      className="absolute right-0 top-[52px] bottom-0 z-30 w-full max-w-[380px] overflow-y-auto"
      style={{ background: 'var(--surface-raised)', borderLeft: '1px solid var(--border-strong)', boxShadow: 'var(--e3)' }}
    >
      <header
        className="sticky top-0 flex h-12 items-center justify-between px-4"
        style={{ background: 'var(--surface-raised)', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <h2 className="font-serif text-[18px]">Alerts</h2>
        <button type="button" onClick={onClose} className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
          Close
        </button>
      </header>
      <ul>
        {ALERTS.map((alert) => (
          <li key={alert.id} className="px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                {alert.title}
              </p>
              <StatusStamp status={alert.status} label={alert.kind} />
            </div>
            <p className="mt-1 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {alert.detail}
            </p>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1.5" y="1.5" width="17" height="17" rx="2" fill="none" stroke="var(--brand)" strokeWidth="1.5" />
      <path d="M6 14 V6 M6 14 H14" stroke="var(--brand)" strokeWidth="1.75" fill="none" />
    </svg>
  );
}
