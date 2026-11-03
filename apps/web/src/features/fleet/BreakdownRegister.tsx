import { useMemo, useState } from 'react';
import { can, formatDate, formatQty } from '@linck/domain';
import { BREAKDOWN_STATUS_FAMILY, type BreakdownRecord } from '@linck/mock';
import {
  AsOfStamp,
  Button,
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
import type { Records } from '../../shell/liveRecords.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { driverLabel, vehicleLabel } from '../expenses/bills.js';
import type { Breakdown } from './breakdownApi.js';
import { breakdownsAt, useBreakdowns, useChangeBreakdown, useReportBreakdown } from './breakdowns.js';
import { BreakdownDetailSheet, downFor, ReportBreakdownSheet, useBreakdownProblem } from './BreakdownSheet.js';
import { breakdownWords, fleetWords } from './words.js';

/**
 * The breakdown register: every breakdown, open or closed, newest first.
 *
 * Vehicle status says that a tipper is down; this says what failed, where,
 * for how long and at what cost — the history that shows up the one vehicle
 * that breaks down every month.
 *
 * The cause and the place are shown as they were written down.
 *
 * LIVE (VITE_API_URL set) the register is the API's (breakdowns.ts): the
 * fleet manager adds a breakdown here, corrects it, sends it to the
 * workshop and marks it fixed, and a row opens the breakdown to do so. The
 * vehicle is the registration it was booked against, never a sample one.
 */

const VIEWS = ['all', 'live', 'resolved'] as const;

type BreakdownText = (typeof breakdownWords)['en'];
type FleetText = (typeof fleetWords)['en'];

export function BreakdownRegister() {
  const t = useWords(breakdownWords);
  const f = useWords(fleetWords);
  const status = useWords(statusWords);
  const { persona, siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');
  const list = useBreakdowns();
  const report = useReportBreakdown();
  const change = useChangeBreakdown();
  /** The sheet: a breakdown's id, 'new', or closed. Live only; the demo's register is read-only. */
  const [sheet, setSheet] = useState<string | null>(null);

  const all = useMemo(
    () => [...breakdownsAt(list.rows, siteScope)].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt)),
    [list.rows, siteScope],
  );
  const live = all.filter((b) => b.status !== 'resolved');
  const resolved = all.filter((b) => b.status === 'resolved');
  const rows = view === 'live' ? live : view === 'resolved' ? resolved : all;
  // Vehicle-hours lost across every breakdown on record.
  const hoursLost = all.reduce((s, b) => s + b.downtimeHours, 0);
  const counts = { all: all.length, live: live.length, resolved: resolved.length };
  const mayAdd = report !== null && can(persona.grants, 'fleet.vehicle.write', { siteId: siteScope });
  // Found in the whole list, so a sheet stays open on a breakdown the scope has just lost.
  const open = sheet && sheet !== 'new' ? (list.rows.find((b) => b.id === sheet) ?? null) : null;

  const columns = useMemo(() => columnsFor(t, f, status.breakdown), [t, f, status]);

  return (
    <>
      <PageHeader
        eyebrow={f.eyebrow}
        title={t.title}
        actions={
          mayAdd ? (
            <Button variant="primary" onClick={() => setSheet('new')}>
              {t.add}
            </Button>
          ) : undefined
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf={list.asOf} source={f.from.breakdowns} freshness="live" />
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
          // Live, a row opens the breakdown, to read in full, correct and mark fixed.
          {...(change ? { onRowClick: (b: Breakdown) => setSheet(b.id), selectedKey: open?.id } : {})}
          empty={
            list.state !== 'ready' ? (
              <BreakdownsNotHere list={list} />
            ) : all.length === 0 ? (
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
      {sheet === 'new' ? (
        <ReportBreakdownSheet onClose={() => setSheet(null)} />
      ) : open ? (
        <BreakdownDetailSheet key={open.id} breakdown={open} onClose={() => setSheet(null)} />
      ) : null}
    </>
  );
}

/** Live only: the register is on its way, or could not be read. */
function BreakdownsNotHere({ list }: { list: Records<Breakdown> }) {
  const t = useWords(breakdownWords);
  const say = useBreakdownProblem();
  if (list.state === 'loading') return <EmptyState fact={t.loading} />;
  return <EmptyState fact={t.failed} {...(list.problem ? { because: say(list.problem) } : {})} action={{ label: t.retry, onClick: list.retry }} />;
}

function columnsFor(t: BreakdownText, f: FleetText, label: Record<BreakdownRecord['status'], string>): Column<Breakdown>[] {
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
      // The demo's sample vehicle; live, the registration it was booked against.
      render: (b) => <IdCell>{vehicleLabel(b.vehicleId) ?? b.vehicleId}</IdCell>,
    },
    { key: 'cause', header: t.col.cause, render: (b) => b.cause },
    { key: 'location', header: t.col.where, render: (b) => b.location },
    {
      key: 'driver',
      header: t.col.driver,
      render: (b) => driverLabel(b.driverId),
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
