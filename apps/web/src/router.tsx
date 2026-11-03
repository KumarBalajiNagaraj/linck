import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { resolveHome } from '@linck/domain';
import { LIVE } from './auth/api.js';
import { AppShell } from './shell/AppShell.js';
import { WORKSPACES } from './shell/nav-manifest.js';
import { SampleBanner } from './shell/SampleBanner.js';
import { useApp } from './shell/store.js';
import { ExecutiveDashboard } from './features/overview/ExecutiveDashboard.js';
import { FleetCommandBoard } from './features/fleet/FleetCommandBoard.js';
import { VehicleStatus } from './features/fleet/VehicleStatus.js';
import { DriverList } from './features/fleet/DriverList.js';
import { BreakdownRegister } from './features/fleet/BreakdownRegister.js';
import { ExpenseApprovals } from './features/overview/ExpenseApprovals.js';
import { SalesTrends } from './features/overview/SalesTrends.js';
import { SalesAhead } from './features/overview/SalesAhead.js';
import { IndustryNews } from './features/overview/IndustryNews.js';
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
import { InvoiceList } from './features/vehicle-pl/InvoiceList.js';
import { InvoicePage } from './features/vehicle-pl/InvoicePage.js';
import { PlReports } from './features/vehicle-pl/PlReports.js';
import { SheetList } from './features/vehicle-pl/SheetList.js';
import { SheetPage } from './features/vehicle-pl/SheetPage.js';

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
 * made to choose on every login. Someone no home rule fits — a member admin
 * and nothing else — lands on the first page of their own menu, the same menu
 * the rail shows them, never on a page that turns them away.
 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    const { persona, signedIn, siteScope, enabledModules } = useApp.getState();
    const menu = WORKSPACES.filter((ws) => ws.module === null || enabledModules.includes(ws.module)).flatMap((ws) => ws.items);
    throw redirect({ to: resolveHome(persona.grants, signedIn?.defaultRoute, menu, siteScope) });
  },
  component: () => null,
});

/**
 * Where the driver lands (`resolveHome`). The driver's own home is not built
 * yet, so until it is: adding diesel, the one driver screen there is. Typed `string` like
 * `resolveHome()`'s answer, because the screens' routes come from `route()`.
 */
const DRIVER_HOME: string = '/fleet/fuel/new';
const fieldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/field',
  beforeLoad: () => {
    throw redirect({ to: DRIVER_HOME });
  },
});

/** Signed in, the sign-in page has nothing to show: home. (Signed out, auth/LiveApp.tsx shows it instead of the router.) */
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
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
      if (!allowed) return <Forbidden permission={permission} role={persona.roleLabel} />;
      // Live, a screen still on sample data says so at its top (shell/connected.ts).
      return LIVE ? (
        <>
          <SampleBanner route={path} />
          {component()}
        </>
      ) : (
        component()
      );
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
  fieldRoute,
  signInRoute,
  route('/overview', () => <ExecutiveDashboard />, 'executive.dashboard.read'),
  route('/overview/sales', () => <SalesTrends />, 'executive.dashboard.read'),
  route('/overview/sales/ahead', () => <SalesAhead />, 'executive.dashboard.read'),
  route('/overview/expenses', () => <ExpenseApprovals />, 'finance.expense.approve'),
  route('/overview/industry', () => <IndustryNews />, 'executive.dashboard.read'),
  route('/fleet/board', () => <FleetCommandBoard />, 'fleet.board.read'),
  route('/fleet/vehicles', () => <VehicleStatus />, 'fleet.vehicle.read'),
  route('/fleet/drivers', () => <DriverList />, 'fleet.driver.read'),
  route('/fleet/breakdowns', () => <BreakdownRegister />, 'fleet.breakdown.read'),
  route('/fleet/expenses', () => <ExpenseRegister desk="fleet" />, 'fleet.expense.read'),
  route('/fleet/whatsapp', () => <WhatsAppDieselImport />, 'fleet.expense.upload'),
  route('/fleet/diesel-summary', () => <DieselSummary />, 'fleet.expense.read'),
  route('/fleet/pl', () => <SheetList />, 'fleet.trip_pl.read'),
  route('/fleet/pl/new', () => <SheetPage />, 'fleet.trip_pl.write'),
  route('/fleet/pl/sheets/$sheetId', () => <SheetPage />, 'fleet.trip_pl.read'),
  route('/overview/pl', () => <PlReports />, 'finance.pl_report.read'),
  route('/finance/pl', () => <PlReports />, 'finance.pl_report.read'),
  // LIN-27: GST invoices made from those trips, beside the trip sheets and in Accounts.
  route('/fleet/pl/invoices', () => <InvoiceList />, 'sales.invoice.read'),
  route('/fleet/pl/invoices/$invoiceId', () => <InvoicePage />, 'sales.invoice.read'),
  route('/finance/invoices', () => <InvoiceList />, 'sales.invoice.read'),
  route('/finance/invoices/$invoiceId', () => <InvoicePage />, 'sales.invoice.read'),
  route('/stores/expenses', () => <ExpenseRegister desk="stores" />, 'stores.expense.read'),
  route('/finance/expenses', () => <ExpenseRegister desk={null} />, 'finance.expense.read'),
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
