import { expensesForSite, fleetAttention } from '@linck/mock';
import { AsOfStamp, PageHeader } from '@linck/ui';
import { DestinationRow, UrgentActionsRow, type BoardDestination, type UrgentAction } from '../../shell/CommandBoard.js';
import { useApp } from '../../shell/store.js';
import { useExpenses } from '../expenses/expenseStore.js';

/**
 * The Fleet Manager's command board.
 *
 * Links to the seven databases the fleet desk works in, then a row of counts
 * of what needs the fleet manager now. The uptime tiles, the status bar and
 * the diesel scatter that used to fill this page have moved, unchanged, to
 * Vehicle status — they answer "how is the fleet doing", which is a question
 * for the afternoon, not the first thing to see at 06:30.
 *
 * On-trip and ready vehicles are deliberately not counted here: they are the
 * healthy state, and a card for them would put good news in the row meant for
 * work.
 */
export function FleetCommandBoard() {
  const { siteScope } = useApp();
  const counts = fleetAttention(siteScope);
  // Bills move in-session (uploaded, validated), so this one count reads the
  // live expense store rather than the seeded dataset.
  const bills = useExpenses((s) => s.bills);
  const expensesAwaiting = expensesForSite(siteScope, 'fleet', bills).filter((e) => e.status === 'submitted').length;

  const destinations: BoardDestination[] = [
    { label: 'Vehicles', to: '/fleet/vehicles', permission: 'fleet.board.read' },
    { label: 'Driver List', to: '/fleet/drivers', permission: 'fleet.driver.read' },
    { label: 'Delivery Order & Dispatch', to: '/sales/dispatch', permission: 'sales.dispatch.read' },
    { label: 'Breakdown Register', to: '/fleet/breakdowns', permission: 'fleet.breakdown.read' },
    { label: 'Expenses Approval', to: '/fleet/expenses', permission: 'fleet.expense.read' },
    { label: 'Maintenance Stores', to: '/stores/indents', permission: 'stores.indent.read' },
    { label: 'Vehicle Documents', to: '/compliance/documents', permission: 'compliance.document.read' },
  ];

  const urgent: UrgentAction[] = [
    {
      label: 'Vehicles — Breakdown',
      count: counts.breakdown,
      definition: 'Broken down and off the road right now',
      priority: 'highest',
      to: '/fleet/vehicles',
      view: 'breakdown',
      permission: 'fleet.board.read',
    },
    {
      label: 'Vehicles — Documents expired',
      count: counts.docsExpired,
      definition: 'Insurance, permit, fitness, road tax or PUC past its expiry date',
      priority: 'highest',
      to: '/fleet/vehicles',
      view: 'docs_expired',
      permission: 'fleet.board.read',
    },
    {
      label: 'Vehicles — Due for service',
      count: counts.serviceOverdue,
      definition: 'Run past their service interval in km',
      priority: 'high',
      to: '/fleet/vehicles',
      view: 'service_overdue',
      permission: 'fleet.board.read',
    },
    {
      label: 'Drivers absent',
      count: counts.driversAbsent,
      definition: 'Marked absent or on leave today',
      priority: 'high',
      to: '/fleet/drivers',
      view: 'absent',
      permission: 'fleet.driver.read',
    },
    {
      label: 'Expenses awaiting approval',
      count: expensesAwaiting,
      definition: 'Diesel, repair and other bills waiting on your sign-off',
      priority: 'high',
      to: '/fleet/expenses',
      view: 'submitted',
      permission: 'fleet.expense.read',
    },
    {
      label: 'Open store requests',
      count: counts.openStoreRequests,
      definition: 'Indents raised and not yet issued or rejected',
      priority: 'high',
      to: '/stores/indents',
      view: 'open',
      permission: 'stores.indent.read',
    },
    {
      label: 'Vehicles — Idle',
      count: counts.idle,
      definition: 'Roadworthy but not assigned a load',
      priority: 'medium',
      to: '/fleet/vehicles',
      view: 'idle',
      permission: 'fleet.board.read',
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Command board"
        meta={<AsOfStamp asOf="14:42" source="v_fleet_attention" freshness="live" />}
      />
      <DestinationRow caption="Go to" destinations={destinations} />
      <UrgentActionsRow caption="Needs you now" actions={urgent} />
      <div className="h-10" />
    </>
  );
}
