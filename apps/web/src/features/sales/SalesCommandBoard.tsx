import { salesAttention } from '@linck/mock';
import { AsOfStamp, PageHeader } from '@linck/ui';
import { DestinationRow, UrgentActionsRow, type BoardDestination, type UrgentAction } from '../../shell/CommandBoard.js';
import { useApp } from '../../shell/store.js';

/**
 * The Sales Coordinator's command board.
 *
 * Two rows and nothing else. The coordinator used to land on the fleet board —
 * uptime, breakdowns, diesel scatter — which is another desk's work. What this
 * desk owes is orders signed off, lorries out of the gate, invoices raised and
 * money chased, so those are counted first, and the five databases the desk
 * works in sit underneath as one-click links.
 *
 * Unbilled dispatch leads the row: material that left the yard with no
 * invoice behind it is the one leak here that turns straight into lost cash.
 */
export function SalesCommandBoard() {
  const { siteScope } = useApp();
  const counts = salesAttention(siteScope);

  const urgent: UrgentAction[] = [
    {
      label: 'Unraised invoices',
      count: counts.unbilledDispatch,
      definition: 'Dispatched and signed for, with no invoice raised against the load',
      priority: 'highest',
      to: '/sales/dispatch',
      view: 'unbilled',
      permission: 'sales.dispatch.read',
    },
    {
      label: 'Orders pending approval',
      count: counts.ordersPendingApproval,
      definition: 'Customer purchase orders awaiting sign-off before anything is loaded',
      priority: 'high',
      to: '/sales/orders',
      view: 'pending_approval',
      permission: 'sales.order.read',
    },
    {
      label: 'Dispatches unconfirmed or delayed',
      count: counts.dispatchUnconfirmed,
      definition: 'Loaded but not confirmed out of the gate, or planned and past its slot',
      priority: 'high',
      to: '/sales/dispatch',
      view: 'unconfirmed',
      permission: 'sales.dispatch.read',
    },
    {
      label: 'Invoices overdue',
      count: counts.invoicesOverdue,
      definition: 'Past the due date with a balance still owed',
      priority: 'high',
      to: '/sales/invoices',
      view: 'overdue',
      permission: 'sales.invoice.read',
    },
    {
      label: 'Stock below safety level',
      count: counts.stockBelowSafety,
      definition: 'Product piles that have fallen under their reorder level',
      priority: 'medium',
      to: '/production/stock',
      view: 'below',
      permission: 'production.stock.read',
    },
  ];

  const destinations: BoardDestination[] = [
    { label: 'Material Stock', to: '/production/stock', permission: 'production.stock.read' },
    { label: 'Customer', to: '/sales/customers', permission: 'sales.customer.read' },
    { label: 'Purchase Order', to: '/sales/orders', permission: 'sales.order.read' },
    { label: 'Material Dispatch', to: '/sales/dispatch', permission: 'sales.dispatch.read' },
    { label: 'Invoices', to: '/sales/invoices', permission: 'sales.invoice.read' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Command board"
        meta={<AsOfStamp asOf="14:42" source="v_sales_attention" freshness="live" />}
      />
      <UrgentActionsRow caption="Needs you now" actions={urgent} />
      <DestinationRow caption="Go to" destinations={destinations} />
      <div className="h-10" />
    </>
  );
}
