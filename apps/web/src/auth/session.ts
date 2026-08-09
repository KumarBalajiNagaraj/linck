/**
 * The real session contract — DELIBERATELY NOT WIRED UP YET.
 *
 * Nothing imports this module at runtime. Every screen still renders from
 * `@linck/mock`, and the shell still reads its persona from
 * `auth/personas.ts`. That is on purpose: a half-wired session is worse than
 * no session, because `fetchSession()` failing at boot — API not running, no
 * cookie, tenant not seeded — would take down all eleven screens at once,
 * including the ones that never needed a server.
 *
 * THE CUTOVER, when the API can actually answer:
 *   1. Ship `GET /me/session` returning exactly `SessionPayload` below.
 *   2. In `main.tsx`, await `fetchSession()` before mounting the router, and
 *      on `SessionError` render the sign-in screen instead of the app — never
 *      an empty shell.
 *   3. Feed `sessionToAppState(payload)` into the store, and delete
 *      `PersonaSwitcher` + `TenantShapeSwitcher` from `AppShell` in the same
 *      commit. Both are demo writers of state that becomes server-owned.
 *   4. Only then swap the mock selectors screen by screen. The shell being on
 *      the real session while a screen is still on mock data is fine; the
 *      reverse is not.
 *
 * Keep this file shaped exactly like the endpoint. It is the one place the
 * frontend states what it needs from the backend, and it is easier to argue
 * about a 60-line interface than about eleven screens' worth of fetches.
 */

import type { Grants } from '@linck/domain';
import type { ModuleKey } from '../shell/nav-manifest.js';
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
  /** `block` | `review_queue` | `off` — how hard segregation of duties bites. */
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
  /** Flattened mirror of `user_scope_grants`, keyed by permission. UX only — the API still 403s. */
  grants: Grants;
}

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000';

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
 * not a bearer token in JS. There is nothing for an XSS to steal, and it means
 * no token refresh dance in the client.
 */
export async function fetchSession(signal?: AbortSignal): Promise<SessionPayload> {
  const response = await fetch(`${API_BASE}/me/session`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new SessionError(response.status, `GET /me/session failed with ${response.status}`);
  }

  return (await response.json()) as SessionPayload;
}

/** The slice of the store that becomes server-owned at cutover. */
export interface AppSessionState {
  persona: Persona;
  siteScope: string | null;
  enabledModules: string[];
}

/**
 * Maps the payload onto the store's shape.
 *
 * `persona` survives the cutover as a name only — it stops meaning "which of
 * seven demo people" and starts meaning "the signed-in user and their grants".
 * The shell already reads nothing from it but `name`, `roleLabel`, `siteIds`,
 * `defaultSiteId` and `grants`, so nothing in the rail has to change.
 *
 * `roleLabel` is filled with the organization name rather than a role: a
 * person routinely holds several roles (a plant head is production + stores +
 * fleet), so picking one to print under their name would be a lie. Which
 * tenant you are signed in to is the fact that is always true and, for anyone
 * who works across two of our clients, the one worth showing.
 */
export function sessionToAppState(payload: SessionPayload): AppSessionState {
  return {
    persona: {
      key: payload.user.id,
      name: payload.user.fullName,
      roleLabel: payload.organization.displayName,
      siteIds: payload.sites.map((site) => site.id),
      defaultSiteId: payload.activeSiteScope,
      grants: payload.grants,
    },
    siteScope: payload.activeSiteScope,
    enabledModules: [...payload.modules],
  };
}
