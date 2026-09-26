/**
 * The navigation manifest.
 *
 * SIX workspaces, not seven personas. Personas overlap on data — Maintenance
 * lives inside Fleet and Stores, Executive reads across all of them, Accounts
 * is Finance plus Compliance — so building one destination per persona would
 * duplicate the same screens seven times and produce the mega-menu this
 * design exists to avoid.
 *
 * Nav is `manifest.filter(item => can(grants, item.permission, {siteId}))`.
 * No component anywhere contains `if (role === 'accounts')`. Adding a screen
 * or moving a person between teams is a config change, not a code change.
 *
 * TWO INDEPENDENT GATES, both of which must pass:
 *   module     — did this TENANT buy the vertical? (`core.organization_modules`)
 *   permission — may THIS PERSON use it? (`core.role_assignments` → grants)
 * They are not interchangeable. A fleet-only client has no Production module
 * at all, so no permission grant can ever surface it; a crusher client that
 * also runs tippers has the Fleet module on, but the weighbridge operator
 * still has no business on the command board.
 *
 * KNOWN GAP: `compliance` is a module with no workspace of its own yet — the
 * document register currently rides inside Fleet, so a crusher-only tenant
 * loses it along with the Fleet rail. That resolves when the e-Way Bill
 * console (P0) lands and Compliance becomes its own workspace; until then do
 * not paper over it by gating the item separately, because a rail labelled
 * "Fleet" holding one compliance screen reads worse than the gap.
 */

/** Mirrors the `module_known` check constraint on `core.organization_modules`. */
export type ModuleKey = 'fleet' | 'production' | 'sales' | 'stores' | 'finance' | 'compliance' | 'ai';

export const MODULES: readonly ModuleKey[] = [
  'fleet',
  'production',
  'sales',
  'stores',
  'finance',
  'compliance',
  'ai',
] as const;

export interface NavItem {
  key: string;
  label: string;
  route: string;
  permission: string;
  /** Shown against the item so the rail communicates work-to-do without opening anything. */
  badge?: 'expiring_docs' | 'unverified_receipts' | 'extraction_queue' | 'open_indents' | 'breakdowns';
}

export interface Workspace {
  key: string;
  label: string;
  /** A single glyph. Labels appear on hover in a popover; no per-module colour theme. */
  glyph: string;
  /**
   * The tenant module that switches this workspace on. `null` means always
   * present — Overview reads whatever the tenant does have, so it survives
   * every shape of client.
   */
  module: ModuleKey | null;
  items: NavItem[];
}

export const WORKSPACES: Workspace[] = [
  {
    key: 'overview',
    label: 'Overview',
    glyph: '◱',
    module: null,
    items: [
      { key: 'exec', label: 'Executive dashboard', route: '/overview', permission: 'executive.dashboard.read' },
    ],
  },
  {
    key: 'fleet',
    label: 'Fleet',
    glyph: '▤',
    module: 'fleet',
    items: [
      { key: 'board', label: 'Command board', route: '/fleet/board', permission: 'fleet.board.read', badge: 'breakdowns' },
      { key: 'fuel', label: 'Diesel & DEF entry', route: '/fleet/fuel/new', permission: 'fleet.fuel.create' },
      { key: 'docs', label: 'Documents & expiry', route: '/compliance/documents', permission: 'compliance.document.read', badge: 'expiring_docs' },
      // Inter-state movement is material here, so the e-way bill console is a
      // first-class destination and not a tab hidden inside dispatch.
      { key: 'ewb', label: 'e-Way bills', route: '/compliance/ewb', permission: 'compliance.ewb.read' },
    ],
  },
  {
    key: 'production',
    label: 'Production',
    glyph: '◧',
    module: 'production',
    items: [
      { key: 'stock', label: 'Live stock', route: '/production/stock', permission: 'production.stock.read' },
      { key: 'run', label: 'Shift production entry', route: '/production/runs/new', permission: 'production.run.create' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    glyph: '◨',
    module: 'sales',
    items: [
      { key: 'sales-board', label: 'Command board', route: '/sales/board', permission: 'sales.board.read' },
      { key: 'customers', label: 'Customers', route: '/sales/customers', permission: 'sales.customer.read' },
      { key: 'orders', label: 'Purchase orders', route: '/sales/orders', permission: 'sales.order.read' },
      { key: 'dispatch', label: 'Dispatch board', route: '/sales/dispatch', permission: 'sales.dispatch.read' },
      { key: 'invoices', label: 'Invoices', route: '/sales/invoices', permission: 'sales.invoice.read' },
    ],
  },
  {
    key: 'stores',
    label: 'Stores',
    glyph: '▥',
    module: 'stores',
    items: [
      { key: 'indents', label: 'Indent queue', route: '/stores/indents', permission: 'stores.indent.read', badge: 'open_indents' },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    glyph: '▧',
    module: 'finance',
    items: [
      {
        key: 'verify',
        label: 'Payment verification',
        route: '/finance/receipts/verification',
        permission: 'finance.receipt.read',
        badge: 'unverified_receipts',
      },
    ],
  },
  {
    key: 'ai',
    label: 'Review queue',
    glyph: '◑',
    module: 'ai',
    items: [
      { key: 'review', label: 'Extraction review', route: '/ai/review', permission: 'ai.extraction.review', badge: 'extraction_queue' },
    ],
  },
];
