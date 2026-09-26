import { useMemo } from 'react';
import { daysUntil, formatDate } from '@linck/domain';
import { ATTENDANCE_FAMILY, ATTENDANCE_LABEL, DRIVERS, isDriverAbsent, NOW, VEHICLES, type Driver } from '@linck/mock';
import { AsOfStamp, Chip, DataTable, EmptyState, IdCell, PageHeader, Section, Stacked, StatusStamp, type Column } from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

/**
 * The driver database: who is on the roster, what they are driving, and
 * whether they turned up today.
 */

const VIEWS = ['all', 'absent', 'available', 'unassigned', 'licence'] as const;



/** IST days to expiry, against the dataset's clock rather than the wall clock. */
const licenceDaysLeft = (d: Driver) => daysUntil(d.licenceExpiry, NOW);

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
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
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
            all.length === 0 ? (
              <EmptyState fact="No drivers at this site." because="Nobody on the roster is based here." />
            ) : (
              <EmptyState
                fact="No drivers match this view."
                because={
                  view === 'absent'
                    ? 'Everyone rostered here turned up today.'
                    : view === 'licence'
                      ? 'No licence here runs out within 30 days.'
                      : view === 'unassigned'
                        ? 'Every driver here has a vehicle.'
                        : 'Nobody here is free right now.'
                }
                action={{ label: 'Show all drivers', onClick: () => setView('all') }}
              />
            )
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
    width: 230,
    group: 'Licence',
    // A word and a glyph, not a coloured date: expiring and expired are
    // states, and a state is never carried by hue alone.
    render: (d) => {
      const left = licenceDaysLeft(d);
      return (
        <span className="flex items-center gap-2">
          <span className="num tabular-nums">{formatDate(d.licenceExpiry)}</span>
          {left < 0 ? (
            <StatusStamp status="critical" label="Expired" severity={`${Math.abs(left)}d ago`} />
          ) : left <= 30 ? (
            <StatusStamp status="attention" label="Expiring" severity={`${left}d`} />
          ) : null}
        </span>
      );
    },
  },
];
