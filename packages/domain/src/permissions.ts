/**
 * Scoped RBAC.
 *
 * Every team has its own admins who assign members to a site, plant or
 * location — so a permission is never a flat boolean. It is a permission key
 * plus a scope: org-wide, or a specific set of sites.
 *
 * `can()` is a pure function with no imports. It is unit-tested here and
 * reused verbatim by the React Native driver app. The backend enforces the
 * same rules in RLS and in the service layer; this copy is UX only, and every
 * request must still be assumed to be capable of returning 403.
 */

export interface Grant {
  /** True when the grant applies across the whole organization. */
  orgWide: boolean;
  /** Site ids this permission is granted for. Ignored when orgWide. */
  siteIds: string[];
}

/** Flattened mirror of the backend's `user_scope_grants`, keyed by permission. */
export type Grants = Record<string, Grant>;

export interface ScopeQuery {
  /** The site being acted on. Omit for org-level screens. */
  siteId?: string | null;
}

export function can(grants: Grants, permission: string, scope: ScopeQuery = {}): boolean {
  const grant = grants[permission];
  if (!grant) return false;
  if (grant.orgWide) return true;
  if (scope.siteId === undefined || scope.siteId === null) {
    // No site named: holding the permission at ANY site is enough to see the
    // screen. The list it renders is still filtered server-side by scope.
    return grant.siteIds.length > 0;
  }
  return grant.siteIds.includes(scope.siteId);
}

export function canAny(grants: Grants, permissions: string[], scope: ScopeQuery = {}): boolean {
  return permissions.some((p) => can(grants, p, scope));
}

/** Sites this user can act on for a given permission. Feeds the scope switcher. */
export function sitesFor(grants: Grants, permission: string, allSiteIds: string[]): string[] {
  const grant = grants[permission];
  if (!grant) return [];
  return grant.orgWide ? allSiteIds : grant.siteIds;
}

/**
 * The seven personas, as seeded roles. A person can hold several — a plant
 * head is routinely production + stores + fleet — which is exactly why the
 * shell is organised by workspace rather than by persona.
 */
export const ROLES = [
  'org_owner',
  'executive',
  'accounts',
  'fleet',
  'maintenance',
  'stores',
  'production',
  'sales',
  'driver',
  'team_admin',
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  org_owner: 'Owner',
  executive: 'Executive',
  accounts: 'Accounts',
  fleet: 'Fleet',
  maintenance: 'Maintenance',
  stores: 'Stores',
  production: 'Production',
  sales: 'Sales',
  driver: 'Driver',
  team_admin: 'Team admin',
};

/**
 * Where `/` sends someone, evaluated in order against their grants.
 * A team admin who is also a plant head lands on the highest-priority match
 * and switches workspace in one click, rather than being made to choose on
 * every single login.
 */
export const PERSONA_HOME_RULES: ReadonlyArray<{ permission: string; route: string }> = [
  { permission: 'executive.dashboard.read', route: '/overview' },
  { permission: 'fleet.board.read', route: '/fleet/board' },
  { permission: 'sales.dispatch.read', route: '/sales/dispatch' },
  { permission: 'production.run.create', route: '/production/runs/new' },
  { permission: 'finance.receipt.verify', route: '/finance/receipts/verification' },
  { permission: 'stores.indent.approve', route: '/stores/indents' },
  { permission: 'field.trip.read', route: '/field' },
];

export function resolveHome(grants: Grants, pinned?: string | null): string {
  if (pinned) return pinned;
  for (const rule of PERSONA_HOME_RULES) {
    if (can(grants, rule.permission)) return rule.route;
  }
  return '/overview';
}
