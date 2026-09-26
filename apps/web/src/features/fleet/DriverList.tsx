import { useMemo } from 'react';
import { DRIVERS, isDriverAbsent, VEHICLES, type Driver } from '@linck/mock';
import { AsOfStamp, Chip, DataTable, EmptyState, IdCell, PageHeader, Section, Stacked, StatusStamp, type Column } from '@linck/ui';
import type { StatusFamily } from '@linck/tokens';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

/**
 * The driver database: who is on the roster, what they are driving, and
 * whether they turned up today.
 */

const VIEWS = ['all', 'absent', 'available', 'unassigned', 'licence'] as const;

const ATTENDANCE_FAMILY: Record<Driver['attendance'], StatusFamily> = {
  present: 'ready',
  on_trip: 'active',
  rest: 'planned',
  absent: 'critical',
  leave: 'attention',
};

const ATTENDANCE_LABEL: Record<Driver['attendance'], string> = {
  present: 'Present',
  on_trip: 'On trip',
  rest: 'Rest day',
  absent: 'Absent',
  leave: 'On leave',
};

/** The mock clock's date — licences are measured against it, not the wall clock. */
const TODAY = Date.parse('2026-08-08T09:12:00Z');
const licenceDaysLeft = (d: Driver) => Math.floor((Date.parse(d.licenceExpiry) - TODAY) / 86_400_000);

export function DriverList() {
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

  return (
    <>
      <PageHeader eyebrow="Fleet" title="Driver list" meta={<AsOfStamp asOf="14:42" source="fleet.drivers" freshness="live" />} />
      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={all.length}>
          All drivers
        </Chip>
        <Chip active={view === 'absent'} onClick={() => setView('absent')} count={pick('absent').length}>
          Absent or on leave
        </Chip>
        <Chip active={view === 'available'} onClick={() => setView('available')} count={pick('available').length}>
          Present, not on trip
        </Chip>
        <Chip active={view === 'unassigned'} onClick={() => setView('unassigned')} count={pick('unassigned').length}>
          No vehicle
        </Chip>
        <Chip active={view === 'licence'} onClick={() => setView('licence')} count={pick('licence').length}>
          Licence expiring or expired
        </Chip>
      </div>
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={pick(view)}
          rowKey={(d) => d.id}
          rail={(d) => ({ status: ATTENDANCE_FAMILY[d.attendance] })}
          empty={
            <EmptyState
              fact="No drivers match this view."
              because="Everyone at this site is accounted for."
              action={{ label: 'Show all drivers', onClick: () => setView('all') }}
            />
          }
        />
      </Section>
      <div className="h-10" />
    </>
  );
}

const columns: Column<Driver>[] = [
  {
    key: 'name',
    header: 'Driver',
    sticky: true,
    width: 200,
    group: 'Driver',
    render: (d) => <Stacked primary={d.name} secondary={d.phone} />,
  },
  {
    key: 'attendance',
    header: 'Today',
    type: 'status',
    width: 130,
    group: 'Driver',
    render: (d) => <StatusStamp status={ATTENDANCE_FAMILY[d.attendance]} label={ATTENDANCE_LABEL[d.attendance]} />,
  },
  {
    key: 'vehicle',
    header: 'Vehicle',
    type: 'id',
    width: 150,
    group: 'Assignment',
    render: (d) => <IdCell>{VEHICLES.find((v) => v.id === d.vehicleId)?.displayReg ?? null}</IdCell>,
  },
  { key: 'licence', header: 'Licence', type: 'id', width: 190, group: 'Licence', render: (d) => <IdCell>{d.licenceNumber}</IdCell> },
  {
    key: 'licenceExpiry',
    header: 'Licence expires',
    width: 150,
    group: 'Licence',
    render: (d) => {
      const left = licenceDaysLeft(d);
      return (
        <span style={{ color: left < 0 ? 'var(--status-critical)' : left <= 30 ? 'var(--status-attention)' : undefined }}>
          {d.licenceExpiry.slice(0, 10)}
          <span className="num ml-2 text-[12px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {left < 0 ? `${Math.abs(left)}d ago` : `${left}d`}
          </span>
        </span>
      );
    },
  },
];
