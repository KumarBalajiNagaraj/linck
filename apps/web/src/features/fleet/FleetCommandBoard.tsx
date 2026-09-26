import { fleetAttention } from '@linck/mock';
import { AsOfStamp, PageHeader } from '@linck/ui';
import { DestinationRow, UrgentActionsRow, type BoardDestination, type UrgentAction } from '../../shell/CommandBoard.js';
import { useApp } from '../../shell/store.js';

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

  const destinations: BoardDestination[] = [
    { label: 'Vehicles', to: '/fleet/vehicles' },
    { label: 'Driver List', to: '/fleet/drivers' },
    { label: 'Delivery Order & Dispatch', to: '/sales/dispatch' },
    { label: 'Breakdown Register', to: '/fleet/breakdowns' },
    { label: 'Expenses Approval', to: '/fleet/expenses' },
    { label: 'Maintenance Stores', to: '/stores/indents', view: 'all' },
    { label: 'Vehicle Documents', to: '/compliance/documents' },
  ];

  // In the brief's order. Priority and colour say what is urgent; the order
  // stays the one the fleet manager wrote down.
  const urgent: UrgentAction[] = [
    {
      label: 'Vehicles — Breakdown',
      count: counts.breakdown,
      definition: 'Broken down and off the road right now',
      priority: 'highest',
      accent: 'critical',
      to: '/fleet/vehicles',
      view: 'breakdown',
    },
    {
      label: 'Vehicles — Idle',
      count: counts.idle,
      definition: 'Roadworthy but not assigned a load',
      priority: 'medium',
      // The brief asks for a neutral accent here: idle is worth a look, not an alarm.
      accent: 'neutral',
      to: '/fleet/vehicles',
      view: 'idle',
    },
    {
      label: 'Vehicles — Due for service',
      count: counts.serviceOverdue,
      definition: 'Run past their service interval in km',
      priority: 'high',
      accent: 'attention',
      to: '/fleet/vehicles',
      view: 'service_overdue',
    },
    {
      label: 'Vehicles — Documents expired',
      count: counts.docsExpired,
      definition: 'Insurance, permit, fitness, road tax or PUC past its expiry date',
      priority: 'highest',
      accent: 'critical',
      to: '/fleet/vehicles',
      view: 'docs_expired',
    },
    {
      label: 'Drivers Absent',
      count: counts.driversAbsent,
      definition: 'Marked absent or on leave today',
      priority: 'high',
      accent: 'attention',
      to: '/fleet/drivers',
      view: 'absent',
    },
    {
      label: 'Expenses awaiting approval',
      count: counts.expensesAwaiting,
      definition: 'Diesel, repair and other bills waiting on your sign-off',
      priority: 'high',
      accent: 'attention',
      to: '/fleet/expenses',
      view: 'submitted',
    },
    {
      label: 'Open store requests',
      count: counts.openStoreRequests,
      definition: 'Spares, oil and tyres requisitioned for the fleet and not yet issued or rejected',
      priority: 'high',
      accent: 'attention',
      to: '/stores/indents',
      view: 'fleet',
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
