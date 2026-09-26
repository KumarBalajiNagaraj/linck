import type { Grants } from '@linck/domain';

/**
 * Mock sessions, one per persona.
 *
 * These stand in for `GET /me/session`, whose real payload is
 * `{user, organization, sites, activeSiteScope, grants}` — where `grants` is
 * the flattened mirror of the backend's `user_scope_grants`.
 *
 * Keeping them here, shaped exactly like the eventual response, means the
 * persona switcher in the shell is not a demo toy: it exercises the real
 * permission-filtered navigation, the real landing-route resolver and the real
 * `<Can>` gating. If a screen renders for the wrong persona, it shows up here
 * first.
 */

export interface Persona {
  key: string;
  name: string;
  roleLabel: string;
  /** Sites this person can act on. An empty list with orgWide grants means all. */
  siteIds: string[];
  defaultSiteId: string | null;
  grants: Grants;
}

const org = (permissions: string[]): Grants =>
  Object.fromEntries(permissions.map((p) => [p, { orgWide: true, siteIds: [] }]));

const scoped = (permissions: string[], siteIds: string[]): Grants =>
  Object.fromEntries(permissions.map((p) => [p, { orgWide: false, siteIds }]));

const KRP = 'site-krp';
const TVL = 'site-tvl';
const WSP = 'site-wsp';

export const PERSONAS: Persona[] = [
  {
    key: 'executive',
    name: 'Balaji N',
    roleLabel: 'Managing Director',
    siteIds: [KRP, TVL, WSP],
    defaultSiteId: null, // executives get "All sites"; site-scoped roles do not
    grants: org([
      'executive.dashboard.read',
      'fleet.board.read',
      'fleet.vehicle.read',
      'fleet.driver.read',
      'fleet.breakdown.read',
      'fleet.expense.read',
      'production.stock.read',
      'production.run.read',
      'sales.dispatch.read',
      'sales.trip.read',
      'sales.invoice.read',
      'sales.board.read',
      'sales.customer.read',
      'sales.order.read',
      'sales.order.approve',
      'finance.receipt.read',
      'finance.receipt.verify',
      'compliance.document.read',
      'compliance.ewb.read',
      'stores.indent.read',
      'ai.extraction.review',
      'admin.member.manage',
    ]),
  },
  {
    key: 'accounts',
    name: 'Lakshmi N',
    roleLabel: 'Accounts',
    siteIds: [KRP, TVL, WSP],
    defaultSiteId: null,
    grants: {
      ...org([
        'sales.invoice.read',
        'finance.receipt.read',
        'finance.receipt.verify',
        'compliance.document.read',
        'compliance.document.write',
        'compliance.ewb.read',
        'ai.extraction.review',
      ]),
      ...scoped(['fleet.vehicle.read', 'sales.trip.read'], [KRP, TVL]),
    },
  },
  {
    key: 'fleet',
    name: 'Anbu Selvan M',
    roleLabel: 'Fleet Manager',
    siteIds: [KRP, TVL, WSP],
    defaultSiteId: KRP,
    grants: scoped(
      [
        'fleet.board.read',
        'fleet.vehicle.read',
        'fleet.driver.read',
        'fleet.breakdown.read',
        'fleet.expense.read',
        'fleet.expense.validate',
        'fleet.fuel.create',
        'fleet.fuel.read',
        'compliance.document.read',
        'stores.indent.create',
        'stores.indent.read',
        'sales.dispatch.read',
        'sales.trip.read',
        'ai.extraction.review',
      ],
      [KRP, TVL, WSP],
    ),
  },
  {
    key: 'production',
    name: 'Kaliyaperumal R',
    roleLabel: 'Production / Crusher',
    siteIds: [KRP],
    defaultSiteId: KRP,
    grants: scoped(
      ['production.run.create', 'production.run.read', 'production.stock.read', 'stores.indent.create', 'stores.indent.read'],
      [KRP],
    ),
  },
  {
    key: 'sales',
    name: 'Vetrivel S',
    roleLabel: 'Sales Coordinator',
    siteIds: [KRP, TVL],
    defaultSiteId: KRP,
    grants: scoped(
      [
        'sales.board.read',
        'sales.customer.read',
        'sales.order.read',
        'sales.order.approve',
        'sales.dispatch.read',
        'sales.dispatch.write',
        'sales.trip.read',
        'sales.invoice.read',
        'production.stock.read',
        // The vehicle list, to see which lorries are free — not the fleet
        // manager's command board, which is another desk's work.
        'fleet.vehicle.read',
        'compliance.ewb.read',
      ],
      [KRP, TVL],
    ),
  },
  {
    key: 'stores',
    name: 'Ganesh K',
    roleLabel: 'Stores',
    siteIds: [KRP, WSP],
    defaultSiteId: WSP,
    grants: scoped(
      ['stores.indent.read', 'stores.indent.approve', 'stores.indent.create', 'production.stock.read', 'ai.extraction.review'],
      [KRP, WSP],
    ),
  },
  {
    key: 'driver',
    name: 'Murugan S',
    roleLabel: 'Driver',
    siteIds: [KRP],
    defaultSiteId: KRP,
    grants: scoped(['field.trip.read', 'fleet.fuel.create'], [KRP]),
  },
];

export function personaByKey(key: string): Persona {
  return PERSONAS.find((p) => p.key === key) ?? PERSONAS[0]!;
}
