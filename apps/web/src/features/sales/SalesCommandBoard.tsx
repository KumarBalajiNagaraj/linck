import { salesAttention } from '@linck/mock';
import { AsOfStamp, PageHeader } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { DestinationRow, UrgentActionsRow, type BoardDestination, type UrgentAction } from '../../shell/CommandBoard.js';
import { useApp } from '../../shell/store.js';
import { boardWords, salesWords } from './words.js';

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
  const t = useWords(boardWords);
  const s = useWords(salesWords);
  const counts = salesAttention(siteScope);

  // Every non-zero card spends colour — red for the one the brief calls
  // Highest, amber for the rest.
  const urgent: UrgentAction[] = [
    {
      // Out of the gate for a credit customer, with no invoice raised against the load.
      label: t.toInvoice.label,
      count: counts.unbilledDispatch,
      definition: t.toInvoice.definition,
      priority: 'highest',
      accent: 'critical',
      to: '/sales/dispatch',
      view: 'unbilled',
    },
    {
      // Customer purchase orders awaiting sign-off before anything is loaded.
      label: t.toApprove.label,
      count: counts.ordersPendingApproval,
      definition: t.toApprove.definition,
      priority: 'high',
      accent: 'attention',
      to: '/sales/orders',
      view: 'pending_approval',
    },
    {
      // Loaded but not confirmed out of the gate, or planned and past its slot.
      label: t.notOut.label,
      count: counts.dispatchUnconfirmed,
      definition: t.notOut.definition,
      priority: 'high',
      accent: 'attention',
      to: '/sales/dispatch',
      view: 'unconfirmed',
    },
    {
      // Past the due date with a balance still owed.
      label: t.overdue.label,
      count: counts.invoicesOverdue,
      definition: t.overdue.definition,
      priority: 'high',
      accent: 'attention',
      to: '/sales/invoices',
      view: 'overdue',
    },
    {
      // Product piles that have fallen under their safety level.
      label: t.lowStock.label,
      count: counts.stockBelowSafety,
      definition: t.lowStock.definition,
      priority: 'medium',
      accent: 'attention',
      to: '/production/stock',
      view: 'below',
    },
  ];

  // The same names the menu uses, so a link and the page it opens agree.
  const destinations: BoardDestination[] = [
    { label: t.stock, to: '/production/stock' },
    { label: t.customers, to: '/sales/customers' },
    { label: t.orders, to: '/sales/orders' },
    { label: t.loads, to: '/sales/dispatch' },
    { label: t.invoices, to: '/sales/invoices' },
  ];

  return (
    <>
      <PageHeader
        eyebrow={s.eyebrow}
        title={t.title}
        // Counted from v_sales_attention.
        meta={<AsOfStamp asOf="14:42" source={s.src.salesDesk} freshness="live" />}
      />
      <UrgentActionsRow caption={t.needsYou} actions={urgent} />
      <DestinationRow caption={t.goTo} destinations={destinations} />
      <div className="h-10" />
    </>
  );
}
