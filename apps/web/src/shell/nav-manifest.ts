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
  /** Short, plain words (docs/WRITING.md), in English and in Tamil. */
  label: string;
  ta: string;
  route: string;
  permission: string;
  /** Shown against the item so the rail communicates work-to-do without opening anything. */
  badge?: 'expiring_docs' | 'unverified_receipts' | 'extraction_queue' | 'open_indents' | 'breakdowns' | 'pending_expenses' | 'awaiting_director';
}

export interface Workspace {
  key: string;
  label: string;
  ta: string;
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
    ta: 'மேலோட்டம்',
    glyph: '◱',
    module: null,
    items: [
      { key: 'exec', label: 'Dashboard', ta: 'டாஷ்போர்டு', route: '/overview', permission: 'executive.dashboard.read' },
      { key: 'expense-approvals', label: 'Approve bills', ta: 'பில் அனுமதி', route: '/overview/expenses', permission: 'finance.expense.approve', badge: 'awaiting_director' },
      { key: 'industry-news', label: 'Industry news', ta: 'தொழில் செய்திகள்', route: '/overview/industry', permission: 'executive.dashboard.read' },
    ],
  },
  {
    key: 'fleet',
    label: 'Fleet',
    ta: 'வண்டிகள்',
    glyph: '▤',
    module: 'fleet',
    items: [
      { key: 'board', label: 'Home', ta: 'முகப்பு', route: '/fleet/board', permission: 'fleet.board.read' },
      { key: 'vehicles', label: 'Vehicles', ta: 'வண்டிகள்', route: '/fleet/vehicles', permission: 'fleet.vehicle.read', badge: 'breakdowns' },
      { key: 'drivers', label: 'Drivers', ta: 'டிரைவர்கள்', route: '/fleet/drivers', permission: 'fleet.driver.read' },
      { key: 'breakdowns', label: 'Breakdowns', ta: 'பழுதுகள்', route: '/fleet/breakdowns', permission: 'fleet.breakdown.read' },
      { key: 'expenses', label: 'Expenses', ta: 'செலவுகள்', route: '/fleet/expenses', permission: 'fleet.expense.read', badge: 'pending_expenses' },
      { key: 'fuel', label: 'Add diesel', ta: 'டீசல் சேர்', route: '/fleet/fuel/new', permission: 'fleet.fuel.create' },
      { key: 'whatsapp', label: 'WhatsApp bills', ta: 'வாட்ஸ்அப் பில்கள்', route: '/fleet/whatsapp', permission: 'fleet.expense.upload' },
      { key: 'diesel-summary', label: 'Diesel report', ta: 'டீசல் அறிக்கை', route: '/fleet/diesel-summary', permission: 'fleet.expense.read' },
      { key: 'docs', label: 'Documents', ta: 'ஆவணங்கள்', route: '/compliance/documents', permission: 'compliance.document.read', badge: 'expiring_docs' },
      // Inter-state movement is material here, so the e-way bill console is a
      // first-class destination and not a tab hidden inside dispatch.
      { key: 'ewb', label: 'e-Way bills', ta: 'இ-வே பில்கள்', route: '/compliance/ewb', permission: 'compliance.ewb.read' },
    ],
  },
  {
    key: 'production',
    label: 'Production',
    ta: 'உற்பத்தி',
    glyph: '◧',
    module: 'production',
    items: [
      { key: 'stock', label: 'Stock', ta: 'இருப்பு', route: '/production/stock', permission: 'production.stock.read' },
      { key: 'run', label: 'Add shift', ta: 'ஷிப்ட் சேர்', route: '/production/runs/new', permission: 'production.run.create' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    ta: 'விற்பனை',
    glyph: '◨',
    module: 'sales',
    items: [
      { key: 'sales-board', label: 'Home', ta: 'முகப்பு', route: '/sales/board', permission: 'sales.board.read' },
      { key: 'customers', label: 'Customers', ta: 'வாடிக்கையாளர்கள்', route: '/sales/customers', permission: 'sales.customer.read' },
      { key: 'orders', label: 'Orders', ta: 'ஆர்டர்கள்', route: '/sales/orders', permission: 'sales.order.read' },
      { key: 'dispatch', label: 'Loads', ta: 'லோடுகள்', route: '/sales/dispatch', permission: 'sales.dispatch.read' },
      { key: 'invoices', label: 'Invoices', ta: 'இன்வாய்ஸ்கள்', route: '/sales/invoices', permission: 'sales.invoice.read' },
    ],
  },
  {
    key: 'stores',
    label: 'Stores',
    ta: 'ஸ்டோர்ஸ்',
    glyph: '▥',
    module: 'stores',
    items: [
      { key: 'indents', label: 'Material requests', ta: 'பொருள் கோரிக்கைகள்', route: '/stores/indents', permission: 'stores.indent.read', badge: 'open_indents' },
      { key: 'store-expenses', label: 'Expenses', ta: 'செலவுகள்', route: '/stores/expenses', permission: 'stores.expense.read' },
    ],
  },
  {
    key: 'finance',
    label: 'Accounts',
    ta: 'கணக்கு',
    glyph: '▧',
    module: 'finance',
    items: [
      {
        key: 'verify',
        label: 'Check payments',
        ta: 'பணம் சரிபார்',
        route: '/finance/receipts/verification',
        permission: 'finance.receipt.read',
        badge: 'unverified_receipts',
      },
      { key: 'expense-bills', label: 'Expense bills', ta: 'செலவு பில்கள்', route: '/finance/expenses', permission: 'finance.expense.read' },
    ],
  },
  {
    key: 'ai',
    label: 'Review',
    ta: 'சரிபார்ப்பு',
    glyph: '◑',
    module: 'ai',
    items: [
      { key: 'review', label: 'Check readings', ta: 'படித்ததை சரிபார்', route: '/ai/review', permission: 'ai.extraction.review', badge: 'extraction_queue' },
      { key: 'crosscheck', label: 'Check delivery papers', ta: 'டெலிவரி சலான் சரிபார்', route: '/ai/crosscheck', permission: 'ai.extraction.review' },
    ],
  },
];

/** A nav item or workspace named in the person's language. */
export function navLabel(entry: { label: string; ta: string }, lang: 'en' | 'ta'): string {
  return lang === 'ta' ? entry.ta : entry.label;
}
