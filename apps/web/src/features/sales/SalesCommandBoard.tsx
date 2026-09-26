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
 * invoice behind it is the one leak here that turns straight into lost cash —
 * and under GST the invoice is owed when the goods leave, not when they land.
 */
export function SalesCommandBoard() {
  const { siteScope } = useApp();
  const counts = salesAttention(siteScope);

  // Labels are the brief's own words, and every non-zero card spends colour —
  // red for the one the brief calls Highest, amber for the rest.
  const urgent: UrgentAction[] = [
    {
      label: 'Invoices not yet raised',
      count: counts.unbilledDispatch,
      definition: 'Out of the gate for a credit customer, with no invoice raised against the load',
      priority: 'highest',
      accent: 'critical',
      to: '/sales/dispatch',
      view: 'unbilled',
    },
    {
      label: 'Orders pending approval',
      count: counts.ordersPendingApproval,
      definition: 'Customer purchase orders awaiting sign-off before anything is loaded',
      priority: 'high',
      accent: 'attention',
      to: '/sales/orders',
      view: 'pending_approval',
    },
    {
      label: 'Dispatch pending confirmation / delayed',
      count: counts.dispatchUnconfirmed,
      definition: 'Loaded but not confirmed out of the gate, or planned and past its slot',
      priority: 'high',
      accent: 'attention',
      to: '/sales/dispatch',
      view: 'unconfirmed',
    },
    {
      label: 'Invoices overdue for payment',
      count: counts.invoicesOverdue,
      definition: 'Past the due date with a balance still owed',
      priority: 'high',
      accent: 'attention',
      to: '/sales/invoices',
      view: 'overdue',
    },
    {
      label: 'Stock below threshold',
      count: counts.stockBelowSafety,
      definition: 'Product piles that have fallen under their safety level',
      priority: 'medium',
      accent: 'attention',
      to: '/production/stock',
      view: 'below',
    },
  ];

  const destinations: BoardDestination[] = [
    { label: 'Material Stock', to: '/production/stock' },
    { label: 'Customer', to: '/sales/customers' },
    { label: 'Purchase Order', to: '/sales/orders' },
    { label: 'Material Dispatch', to: '/sales/dispatch' },
    { label: 'Invoices', to: '/sales/invoices' },
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
