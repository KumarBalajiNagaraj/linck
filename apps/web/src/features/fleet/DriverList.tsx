import { useMemo } from 'react';
import { daysUntil, formatDate } from '@linck/domain';
import { ATTENDANCE_FAMILY, DRIVERS, isDriverAbsent, NOW, VEHICLES, type Driver } from '@linck/mock';
import { AsOfStamp, Chip, DataTable, EmptyState, IdCell, PageHeader, Section, Stacked, StatusStamp, type Column } from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { driverWords, fleetWords } from './words.js';

/**
 * The driver database: who is on the roster, what they are driving, and
 * whether they turned up today.
 *
 * Views, as the chips count them:
 *   absent      — marked absent or on leave today;
 *   available   — present and not on a trip;
 *   unassigned  — no vehicle against their name;
 *   licence     — licence runs out within 30 days, or already has.
 */

const VIEWS = ['all', 'absent', 'available', 'unassigned', 'licence'] as const;

/** Days to expiry, against the dataset's clock rather than the wall clock. */
const licenceDaysLeft = (d: Driver) => daysUntil(d.licenceExpiry, NOW);

type DriverText = (typeof driverWords)['en'];
type FleetText = (typeof fleetWords)['en'];

export function DriverList() {
  const t = useWords(driverWords);
  const f = useWords(fleetWords);
  const status = useWords(statusWords);
  const { siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');

  const all = useMemo(() => (siteScope ? DRIVERS.filter((d) => d.siteId === siteScope) : DRIVERS), [siteScope]);
  const pick = (v: (typeof VIEWS)[number]) =>
    v === 'absent'
      ? all.filter(isDriverAbsent)
      : v === 'available'
        ? all.filter((d) => d.attendance === 'present')
        : v === 'unassigned'
          ? all.filter((d) => d.vehicleId === null)
          : v === 'licence'
            ? all.filter((d) => licenceDaysLeft(d) <= 30)
            : all;

  const columns = useMemo(() => columnsFor(t, f, status.attendance), [t, f, status]);

  return (
    <>
      <PageHeader eyebrow={f.eyebrow} title={t.title} meta={<AsOfStamp asOf="14:42" source={f.from.drivers} freshness="live" />} />
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        {VIEWS.map((v) => (
          <Chip key={v} active={view === v} onClick={() => setView(v)} count={pick(v).length}>
            {t.views[v]}
          </Chip>
        ))}
      </div>
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={pick(view)}
          rowKey={(d) => d.id}
          rail={(d) => ({ status: ATTENDANCE_FAMILY[d.attendance] })}
          empty={
            all.length === 0 || view === 'all' ? (
              <EmptyState fact={t.noDrivers} />
            ) : (
              <EmptyState fact={t.noneIn[view]} action={{ label: f.showAll, onClick: () => setView('all') }} />
            )
          }
        />
      </Section>
      <div className="h-10" />
    </>
  );
}

function columnsFor(t: DriverText, f: FleetText, attendance: Record<Driver['attendance'], string>): Column<Driver>[] {
  return [
    {
      key: 'name',
      header: t.col.driver,
      sticky: true,
      width: 200,
      render: (d) => <Stacked primary={d.name} secondary={d.phone} />,
    },
    {
      key: 'attendance',
      header: t.col.today,
      type: 'status',
      width: 130,
      render: (d) => <StatusStamp status={ATTENDANCE_FAMILY[d.attendance]} label={attendance[d.attendance]} />,
    },
    {
      key: 'vehicle',
      header: t.col.vehicle,
      type: 'id',
      width: 150,
      render: (d) => <IdCell>{VEHICLES.find((v) => v.id === d.vehicleId)?.displayReg ?? null}</IdCell>,
    },
    { key: 'licence', header: t.col.licence, type: 'id', width: 190, render: (d) => <IdCell>{d.licenceNumber}</IdCell> },
    {
      key: 'licenceExpiry',
      header: t.col.licenceExpiry,
      width: 260,
      // A word and a glyph, not a coloured date: expiring and expired are
      // states, and a state is never carried by hue alone.
      render: (d) => {
        const left = licenceDaysLeft(d);
        return (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="num tabular-nums">{formatDate(d.licenceExpiry)}</span>
            {left < 0 ? (
              <StatusStamp status="critical" label={f.expired} severity={f.daysAgo(Math.abs(left))} />
            ) : left <= 30 ? (
              <StatusStamp status="attention" label={f.expiring} severity={f.inDays(left)} />
            ) : null}
          </span>
        );
      },
    },
  ];
}
