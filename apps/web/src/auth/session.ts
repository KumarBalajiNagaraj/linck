/**
 * The real session contract: what `GET /me/session` answers, field for field.
 *
 * It is wired up only in LIVE mode, when `VITE_API_URL` is set (auth/api.ts).
 * In the demo nothing here runs: the shell reads its persona from
 * `auth/personas.ts` and every screen renders from `@linck/mock`.
 *
 * THE CUTOVER, and how far it has got:
 *   1. Ship `GET /me/session` returning exactly `SessionPayload` below. Done;
 *      apps/api/tests/test_sign_in.py fails if either side drifts.
 *   2. Await it before mounting the router, and on a 401 show the sign-in
 *      screen instead of the app — never an empty shell. Done: auth/LiveApp.tsx.
 *   3. Feed `sessionToAppState(payload)` into the store, and take
 *      `PersonaSwitcher` + `TenantShapeSwitcher` out of the shell. Done for
 *      live mode; the demo keeps both, since it has no server to own them.
 *   4. Only then swap the mock selectors screen by screen. Under way: the
 *      expense chain reads and writes `/expenses` (features/expenses/bills.ts);
 *      customers, orders and breakdowns read and write `/customers`,
 *      `/purchase-orders` and `/breakdowns` (features/sales/customers.ts,
 *      orders.ts, features/fleet/breakdowns.ts); the vehicle P&L's trip
 *      sheets and reports, and the trip invoices made from them, read and
 *      write `/vehicle-pl` and `/vehicle-pl/invoices`
 *      (features/vehicle-pl/sheets.ts, invoices.ts). That is every screen
 *      whose API is built; every other screen says "Sample data" at its top
 *      (shell/connected.ts lists the ones that are on the API). The shell
 *      being on the real session while a screen is still on mock data is
 *      fine, as long as the screen says so; the reverse is not.
 *
 * Keep this file shaped exactly like the endpoint. It is the one place the
 * frontend states what it needs from the backend, and it is easier to argue
 * about a 60-line interface than about eleven screens' worth of fetches.
 */

import type { Grants } from '@linck/domain';
import type { ModuleKey } from '../shell/nav-manifest.js';
import { apiRequest } from './api.js';
import type { Persona } from './personas.js';

/** `core.users` — the person, pre-registered by an admin. Sign-in never creates one. */
export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  employeeCode: string | null;
  avatarUrl: string | null;
  /** Pinned landing route. Overrides `resolveHome()` when set. */
  defaultRoute: string | null;
}

/** `core.organizations` — the tenant, which is a CUSTOMER of Linck, not a legal entity. */
export interface SessionOrganization {
  id: string;
  displayName: string;
  slug: string;
  baseCurrency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  /** `review_queue` (the default: a second signature is allowed, with a reason, and goes to review) or `hard_block` (refused). The API reads it (app/api/access.py); the web does not yet. */
  segregationEnforcement: string;
}

/** `core.gst_registrations` — one per GSTIN, i.e. one per state the entity trades in. */
export interface SessionGstRegistration {
  id: string;
  gstin: string;
  stateCode: string;
  eInvoicingApplicable: boolean;
}

/**
 * `core.legal_entities` — 1..N per organization.
 *
 * The frontend needs the full list, not just the active one, because an
 * inter-entity trip (material from entity A on a vehicle owned by entity B) is
 * a GTA supply under SAC 9965 with its own invoice and reverse-charge
 * treatment. Screens that show that branch have to be able to name both sides.
 * A single-entity client returns one row and never sees the branch.
 */
export interface SessionLegalEntity {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
  entityType: string;
  pan: string | null;
  isGoodsTransportAgency: boolean;
  gstRegistrations: SessionGstRegistration[];
}

/** `core.sites` — ours only. Customer ship-to addresses are not sites. */
export interface SessionSite {
  id: string;
  legalEntityId: string;
  code: string;
  name: string;
  siteType: string;
  stateCode: string;
}

/** `core.roles`, one per role the user holds at any scope. Printed under their name, never gated on. */
export interface SessionRole {
  /** `executive`, `fleet_manager`, …: what the shell words in the reader's language. */
  key: string;
  /** As the admin named it, for a role the shell has no words for. */
  label: string;
}

export interface SessionPayload {
  user: SessionUser;
  organization: SessionOrganization;
  /** Enabled rows of `core.organization_modules`. Gates the workspace rail. */
  modules: ModuleKey[];
  legalEntities: SessionLegalEntity[];
  /** Only the sites this user is scoped to — the server does not send the rest. */
  sites: SessionSite[];
  /** `null` means org-wide: the user may look across every site above. */
  activeSiteScope: string | null;
  /** Every role they hold. A plant head holds three; all of them are true. */
  roles: SessionRole[];
  /** Flattened mirror of `user_scope_grants`, keyed by permission. UX only — the API still 403s. */
  grants: Grants;
}

/** Thrown for every non-2xx. `status === 401` is "sign in", not "something broke". */
export class SessionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
  }
}

/**
 * `credentials: 'include'` because the session is a same-site HttpOnly cookie,
 * not a bearer token in JS. There is nothing for an XSS to steal. An expired
 * session is renewed once on the way (auth/api.ts); a 401 after that is real.
 */
export async function fetchSession(signal?: AbortSignal): Promise<SessionPayload> {
  const response = await apiRequest(
    '/me/session',
    { method: 'GET', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) },
    false,
  );

  if (!response.ok) {
    throw new SessionError(response.status, `GET /me/session failed with ${response.status}`);
  }

  return (await response.json()) as SessionPayload;
}

/** Who is signed in, as the shell shows them. Null in the demo. */
export interface SignedIn {
  email: string;
  organizationName: string;
  roles: SessionRole[];
  /** The scope switcher's choices: the sites this person is scoped to. */
  sites: Pick<SessionSite, 'id' | 'code' | 'name'>[];
  /** The landing route they pinned, if any; `resolveHome()` takes it first. */
  defaultRoute: string | null;
}

/** The slice of the store that becomes server-owned at cutover. */
export interface AppSessionState {
  persona: Persona;
  siteScope: string | null;
  enabledModules: string[];
  signedIn: SignedIn;
}

/**
 * Maps the payload onto the store's shape.
 *
 * `persona` survives the cutover as a name only — it stops meaning "which of
 * seven demo people" and starts meaning "the signed-in user and their grants".
 * The shell already reads nothing from it but `name`, `roleLabel`, `siteIds`,
 * `defaultSiteId` and `grants`, so nothing in the rail has to change.
 *
 * `roleLabel` is every role they hold, as the admin named them: a person
 * routinely holds several (a plant head is production + stores + fleet), so
 * picking one to print under their name would be a lie, and listing all of
 * them is not. The top bar words them in the reader's language from
 * `signedIn.roles`; `roleLabel` is what an admin reads on a refusal.
 */
export function sessionToAppState(payload: SessionPayload): AppSessionState {
  return {
    persona: {
      key: payload.user.id,
      name: payload.user.fullName,
      roleLabel: payload.roles.map((role) => role.label).join(', ') || payload.organization.displayName,
      siteIds: payload.sites.map((site) => site.id),
      defaultSiteId: payload.activeSiteScope,
      grants: payload.grants,
    },
    siteScope: payload.activeSiteScope,
    enabledModules: [...payload.modules],
    signedIn: {
      email: payload.user.email,
      organizationName: payload.organization.displayName,
      roles: payload.roles,
      sites: payload.sites.map(({ id, code, name }) => ({ id, code, name })),
      defaultRoute: safeRoute(payload.user.defaultRoute),
    },
  };
}

/** A pinned route is data an admin typed: only a path inside this app is taken. */
function safeRoute(route: string | null): string | null {
  return route && route.startsWith('/') && !route.startsWith('//') ? route : null;
}
