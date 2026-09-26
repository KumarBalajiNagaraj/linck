import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { resolveHome } from '@linck/domain';
import { AppShell } from './shell/AppShell.js';
import { useApp } from './shell/store.js';
import { ExecutiveDashboard } from './features/overview/ExecutiveDashboard.js';
import { FleetCommandBoard } from './features/fleet/FleetCommandBoard.js';
import { VehicleStatus } from './features/fleet/VehicleStatus.js';
import { DriverList } from './features/fleet/DriverList.js';
import { BreakdownRegister } from './features/fleet/BreakdownRegister.js';
import { ExpenseRegister } from './features/expenses/ExpenseRegister.js';
import { WhatsAppDieselImport } from './features/expenses/WhatsAppDieselImport.js';
import { DieselSummary } from './features/expenses/DieselSummary.js';
import { FuelEntryScreen } from './features/fleet/FuelEntryScreen.js';
import { DocumentRegister } from './features/compliance/DocumentRegister.js';
import { EwayBillConsole } from './features/compliance/EwayBillConsole.js';
import { StockBoard } from './features/production/StockBoard.js';
import { ProductionRunEntry } from './features/production/ProductionRunEntry.js';
import { DispatchBoard } from './features/sales/DispatchBoard.js';
import { InvoiceLedger } from './features/sales/InvoiceLedger.js';
import { SalesCommandBoard } from './features/sales/SalesCommandBoard.js';
import { CustomerDatabase } from './features/sales/CustomerDatabase.js';
import { PurchaseOrderDatabase } from './features/sales/PurchaseOrderDatabase.js';
import { IndentQueue } from './features/stores/IndentQueue.js';
import { VerificationQueue } from './features/finance/VerificationQueue.js';
import { ExtractionReview } from './features/ai/ExtractionReview.js';
import { DeliveryDocCrossCheck } from './features/ai/DeliveryDocCrossCheck.js';
import { Forbidden } from './features/Forbidden.js';

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

/**
 * `/` resolves a persona home from the grants rather than sending everyone to
 * the same dashboard. A team admin who is also a plant head lands on the
 * highest-priority match and switches workspace in one click, instead of being
 * made to choose on every login.
 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    const { persona } = useApp.getState();
    throw redirect({ to: resolveHome(persona.grants) });
  },
  component: () => null,
});

function route(path: string, component: () => React.JSX.Element, permission: string) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => {
      // Client gating is UX only — the server is the enforcement point and
      // every request must still be assumed capable of returning 403.
      const { persona, siteScope } = useApp();
      const allowed = permission in persona.grants && hasScope(persona.grants[permission], siteScope);
      return allowed ? component() : <Forbidden permission={permission} role={persona.roleLabel} />;
    },
  });
}

function hasScope(grant: { orgWide: boolean; siteIds: string[] } | undefined, siteId: string | null): boolean {
  if (!grant) return false;
  if (grant.orgWide) return true;
  return siteId === null ? grant.siteIds.length > 0 : grant.siteIds.includes(siteId);
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  route('/overview', () => <ExecutiveDashboard />, 'executive.dashboard.read'),
  route('/fleet/board', () => <FleetCommandBoard />, 'fleet.board.read'),
  route('/fleet/vehicles', () => <VehicleStatus />, 'fleet.vehicle.read'),
  route('/fleet/drivers', () => <DriverList />, 'fleet.driver.read'),
  route('/fleet/breakdowns', () => <BreakdownRegister />, 'fleet.breakdown.read'),
  route('/fleet/expenses', () => <ExpenseRegister desk="fleet" />, 'fleet.expense.read'),
  route('/fleet/whatsapp', () => <WhatsAppDieselImport />, 'fleet.expense.upload'),
  route('/fleet/diesel-summary', () => <DieselSummary />, 'fleet.expense.read'),
  route('/stores/expenses', () => <ExpenseRegister desk="stores" />, 'stores.expense.read'),
  route('/fleet/fuel/new', () => <FuelEntryScreen />, 'fleet.fuel.create'),
  route('/compliance/documents', () => <DocumentRegister />, 'compliance.document.read'),
  route('/compliance/ewb', () => <EwayBillConsole />, 'compliance.ewb.read'),
  route('/production/stock', () => <StockBoard />, 'production.stock.read'),
  route('/production/runs/new', () => <ProductionRunEntry />, 'production.run.create'),
  route('/sales/board', () => <SalesCommandBoard />, 'sales.board.read'),
  route('/sales/customers', () => <CustomerDatabase />, 'sales.customer.read'),
  route('/sales/orders', () => <PurchaseOrderDatabase />, 'sales.order.read'),
  route('/sales/dispatch', () => <DispatchBoard />, 'sales.dispatch.read'),
  route('/sales/invoices', () => <InvoiceLedger />, 'sales.invoice.read'),
  route('/stores/indents', () => <IndentQueue />, 'stores.indent.read'),
  route('/finance/receipts/verification', () => <VerificationQueue />, 'finance.receipt.read'),
  route('/ai/review', () => <ExtractionReview />, 'ai.extraction.review'),
  route('/ai/crosscheck', () => <DeliveryDocCrossCheck />, 'ai.extraction.review'),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
