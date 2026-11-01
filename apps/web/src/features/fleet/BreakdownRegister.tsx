import { useMemo } from 'react';
import { formatDate, formatQty } from '@linck/domain';
import { BREAKDOWN_STATUS_FAMILY, breakdownsForSite, DRIVERS, VEHICLES, type BreakdownRecord } from '@linck/mock';
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
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { breakdownWords, fleetWords } from './words.js';

/**
 * The breakdown register: every breakdown, open or closed, newest first.
 *
 * Vehicle status says that a tipper is down; this says what failed, where,
 * for how long and at what cost — the history that shows up the one vehicle
 * that breaks down every month.
 *
 * The cause and the place are shown as they were written down.
 */

const VIEWS = ['all', 'live', 'resolved'] as const;

type BreakdownText = (typeof breakdownWords)['en'];
type FleetText = (typeof fleetWords)['en'];

export function BreakdownRegister() {
  const t = useWords(breakdownWords);
  const f = useWords(fleetWords);
  const status = useWords(statusWords);
  const { siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');

  const all = useMemo(
    () => [...breakdownsForSite(siteScope)].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt)),
    [siteScope],
  );
  const live = all.filter((b) => b.status !== 'resolved');
  const resolved = all.filter((b) => b.status === 'resolved');
  const rows = view === 'live' ? live : view === 'resolved' ? resolved : all;
  // Vehicle-hours lost across every breakdown on record.
  const hoursLost = all.reduce((s, b) => s + b.downtimeHours, 0);
  const counts = { all: all.length, live: live.length, resolved: resolved.length };

  const columns = useMemo(() => columnsFor(t, f, status.breakdown), [t, f, status]);

  return (
    <>
      <PageHeader
        eyebrow={f.eyebrow}
        title={t.title}
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source={f.from.breakdowns} freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {t.tally(all.length, formatQty(hoursLost, 0))}
            </span>
          </span>
        }
      />
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        {VIEWS.map((v) => (
          <Chip key={v} active={view === v} onClick={() => setView(v)} count={counts[v]}>
            {t.views[v]}
          </Chip>
        ))}
      </div>
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(b) => b.id}
          rail={(b) => ({ status: BREAKDOWN_STATUS_FAMILY[b.status] })}
          empty={
            all.length === 0 ? (
              <EmptyState fact={t.noBreakdowns} />
            ) : (
              <EmptyState
                fact={view === 'live' ? t.noneLive : t.noneFixed}
                action={{ label: f.showAll, onClick: () => setView('all') }}
              />
            )
          }
        />
      </Section>
      <div className="h-10" />
    </>
  );
}

/** `11 hrs`, `3 days` — the figure that goes beside a critical stamp. */
function downFor(hours: number, f: FleetText): string {
  return hours < 48 ? f.hours(Math.round(hours)) : f.days(Math.round(hours / 24));
}

function columnsFor(t: BreakdownText, f: FleetText, label: Record<BreakdownRecord['status'], string>): Column<BreakdownRecord>[] {
  return [
    {
      key: 'number',
      header: t.col.number,
      type: 'id',
      sticky: true,
      width: 150,
      render: (b) => <Stacked primary={<IdCell>{b.number}</IdCell>} secondary={formatDate(b.reportedAt)} />,
    },
    {
      key: 'status',
      header: t.col.status,
      type: 'status',
      width: 170,
      // Critical always carries its figure: how long the vehicle has been down.
      render: (b) => (
        <StatusStamp
          status={BREAKDOWN_STATUS_FAMILY[b.status]}
          label={label[b.status]}
          {...(b.status === 'resolved' ? {} : { severity: downFor(b.downtimeHours, f) })}
        />
      ),
    },
    {
      key: 'vehicle',
      header: t.col.vehicle,
      type: 'id',
      width: 150,
      render: (b) => <IdCell>{VEHICLES.find((v) => v.id === b.vehicleId)?.displayReg ?? b.vehicleId}</IdCell>,
    },
    { key: 'cause', header: t.col.cause, render: (b) => b.cause },
    { key: 'location', header: t.col.where, render: (b) => b.location },
    {
      key: 'driver',
      header: t.col.driver,
      render: (b) => DRIVERS.find((d) => d.id === b.driverId)?.name ?? null,
    },
    {
      key: 'downtime',
      header: t.col.offRoad,
      unit: t.col.hours,
      type: 'num',
      width: 110,
      render: (b) => <QuantityCell value={b.downtimeHours} decimals={1} />,
    },
    {
      key: 'cost',
      header: t.col.repair,
      unit: '₹',
      type: 'money',
      width: 130,
      render: (b) => <MoneyCell value={b.repairCost} decimals={0} />,
    },
  ];
}
