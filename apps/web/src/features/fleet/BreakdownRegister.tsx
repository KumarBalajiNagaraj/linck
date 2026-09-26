import { useMemo } from 'react';
import { formatQty } from '@linck/domain';
import {
  BREAKDOWN_STATUS_FAMILY,
  BREAKDOWN_STATUS_LABEL,
  breakdownsForSite,
  DRIVERS,
  VEHICLES,
  type BreakdownRecord,
} from '@linck/mock';
import {
  AsOfStamp,
  Chip,
  DataTable,
  EmptyState,
  IdCell,
  MoneyCell,
  PageHeader,
  QuantityCell,
  Section,
  Stacked,
  StatusStamp,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

/**
 * The breakdown register: every breakdown, open or closed, newest first.
 *
 * Vehicle status says that a tipper is down; this says what failed, where,
 * for how long and at what cost — the history that shows up the one vehicle
 * that breaks down every month.
 */

const VIEWS = ['all', 'live', 'resolved'] as const;

export function BreakdownRegister() {
  const { siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');

  const all = useMemo(
    () => [...breakdownsForSite(siteScope)].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt)),
    [siteScope],
  );
  const live = all.filter((b) => b.status !== 'resolved');
  const resolved = all.filter((b) => b.status === 'resolved');
  const rows = view === 'live' ? live : view === 'resolved' ? resolved : all;
  const hoursLost = all.reduce((s, b) => s + b.downtimeHours, 0);

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Breakdown register"
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source="fleet.breakdowns" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {formatQty(hoursLost, 0)} vehicle-hours lost across {all.length} breakdowns on record
            </span>
          </span>
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={all.length}>
          All breakdowns
        </Chip>
        <Chip active={view === 'live'} onClick={() => setView('live')} count={live.length}>
          Open or in workshop
        </Chip>
        <Chip active={view === 'resolved'} onClick={() => setView('resolved')} count={resolved.length}>
          Resolved
        </Chip>
      </div>
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(b) => b.id}
          rail={(b) => ({ status: BREAKDOWN_STATUS_FAMILY[b.status] })}
          empty={
            <EmptyState
              fact="No breakdowns match this view."
              because="Nothing is on the hard shoulder at this site."
              action={{ label: 'Show all breakdowns', onClick: () => setView('all') }}
            />
          }
        />
      </Section>
      <div className="h-10" />
    </>
  );
}

const columns: Column<BreakdownRecord>[] = [
  {
    key: 'number',
    header: 'Entry',
    type: 'id',
    sticky: true,
    width: 150,
    group: 'Breakdown',
    render: (b) => <Stacked primary={<IdCell>{b.number}</IdCell>} secondary={b.reportedAt.slice(0, 10)} />,
  },
  {
    key: 'status',
    header: 'Status',
    type: 'status',
    width: 140,
    group: 'Breakdown',
    render: (b) => <StatusStamp status={BREAKDOWN_STATUS_FAMILY[b.status]} label={BREAKDOWN_STATUS_LABEL[b.status]} />,
  },
  {
    key: 'vehicle',
    header: 'Vehicle',
    type: 'id',
    width: 150,
    group: 'Breakdown',
    render: (b) => <IdCell>{VEHICLES.find((v) => v.id === b.vehicleId)?.displayReg ?? b.vehicleId}</IdCell>,
  },
  { key: 'cause', header: 'Cause', group: 'What happened', render: (b) => b.cause },
  { key: 'location', header: 'Where', group: 'What happened', render: (b) => b.location },
  {
    key: 'driver',
    header: 'Driver',
    group: 'What happened',
    render: (b) => DRIVERS.find((d) => d.id === b.driverId)?.name ?? null,
  },
  {
    key: 'downtime',
    header: 'Off road',
    unit: 'h',
    type: 'num',
    width: 100,
    group: 'Cost',
    render: (b) => <QuantityCell value={b.downtimeHours} decimals={1} />,
  },
  {
    key: 'cost',
    header: 'Repair',
    unit: '₹',
    type: 'money',
    width: 120,
    group: 'Cost',
    render: (b) => <MoneyCell value={b.repairCost} decimals={0} />,
  },
];
