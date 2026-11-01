import { expensesForSite, fleetAttention } from '@linck/mock';
import { AsOfStamp, PageHeader } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { DestinationRow, UrgentActionsRow, type BoardDestination, type UrgentAction } from '../../shell/CommandBoard.js';
import { useApp } from '../../shell/store.js';
import { useBills } from '../expenses/bills.js';
import { boardWords, fleetWords } from './words.js';

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
 *
 * The labels are the nav rail's own words, so a card and the menu item it
 * opens say the same thing.
 */
export function FleetCommandBoard() {
  const t = useWords(boardWords);
  const f = useWords(fleetWords);
  const { siteScope } = useApp();
  const counts = fleetAttention(siteScope);
  // Bills move in-session (uploaded, validated), so this one count reads the
  // bills the expense screens read — the demo's store, or live the API —
  // rather than the seeded dataset.
  const { bills } = useBills();
  const expensesAwaiting = expensesForSite(siteScope, 'fleet', bills).filter((e) => e.status === 'submitted').length;

  const destinations: BoardDestination[] = [
    { label: t.go.vehicles, to: '/fleet/vehicles' },
    { label: t.go.drivers, to: '/fleet/drivers' },
    { label: t.go.loads, to: '/sales/dispatch' },
    { label: t.go.breakdowns, to: '/fleet/breakdowns' },
    { label: t.go.expenses, to: '/fleet/expenses' },
    { label: t.go.requests, to: '/stores/indents', view: 'all' },
    { label: t.go.documents, to: '/compliance/documents' },
  ];

  // In the brief's order. Priority and colour say what is urgent; the order
  // stays the one the fleet manager wrote down.
  const urgent: UrgentAction[] = [
    {
      label: t.cards.breakdown[0],
      count: counts.breakdown,
      definition: t.cards.breakdown[1],
      priority: 'highest',
      accent: 'critical',
      to: '/fleet/vehicles',
      view: 'breakdown',
    },
    {
      // Idle AND roadworthy: a tipper idle only because its permit lapsed is
      // counted under documents expired instead.
      label: t.cards.idle[0],
      count: counts.idle,
      definition: t.cards.idle[1],
      priority: 'medium',
      // The brief asks for a neutral accent here: idle is worth a look, not an alarm.
      accent: 'neutral',
      to: '/fleet/vehicles',
      view: 'idle',
    },
    {
      // Run past their service interval in km, and still on the road.
      label: t.cards.service[0],
      count: counts.serviceOverdue,
      definition: t.cards.service[1],
      priority: 'high',
      accent: 'attention',
      to: '/fleet/vehicles',
      view: 'service_overdue',
    },
    {
      // Insurance, permit, fitness, road tax or PUC past its expiry date.
      label: t.cards.docs[0],
      count: counts.docsExpired,
      definition: t.cards.docs[1],
      priority: 'highest',
      accent: 'critical',
      to: '/fleet/vehicles',
      view: 'docs_expired',
    },
    {
      label: t.cards.drivers[0],
      count: counts.driversAbsent,
      definition: t.cards.drivers[1],
      priority: 'high',
      accent: 'attention',
      to: '/fleet/drivers',
      view: 'absent',
    },
    {
      // Bills waiting on the fleet manager's check before they go to the director.
      label: t.cards.bills[0],
      count: expensesAwaiting,
      definition: t.cards.bills[1],
      priority: 'high',
      accent: 'attention',
      to: '/fleet/expenses',
      view: 'submitted',
    },
    {
      // Requisitioned for the fleet and not yet issued or rejected.
      label: t.cards.requests[0],
      count: counts.openStoreRequests,
      definition: t.cards.requests[1],
      priority: 'high',
      accent: 'attention',
      to: '/stores/indents',
      view: 'fleet',
    },
  ];

  return (
    <>
      {/* The counts come from v_fleet_attention; the hover names it in plain words. */}
      <PageHeader
        eyebrow={f.eyebrow}
        title={t.title}
        meta={<AsOfStamp asOf="14:42" source={f.from.board} freshness="live" />}
      />
      <DestinationRow caption={t.open} destinations={destinations} />
      <UrgentActionsRow caption={t.waiting} actions={urgent} />
      <div className="h-10" />
    </>
  );
}
