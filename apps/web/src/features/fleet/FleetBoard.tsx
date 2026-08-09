import { useMemo, useState } from 'react';
import { formatQty } from '@linck/domain';
import {
  DOCUMENTS,
  DRIVERS,
  driversForSite,
  LAST_14,
  mileageFor,
  SITES,
  vehiclesForSite,
  VEHICLE_STATUS_FAMILY,
  VEHICLE_STATUS_LABEL,
  type Vehicle,
  type VehicleStatus,
} from '@linck/mock';
import {
  AsOfStamp,
  Button,
  ChartCaption,
  Chip,
  ConfirmModal,
  DataTable,
  Detail,
  DetailGrid,
  EmptyState,
  IdCell,
  KpiTile,
  Note,
  PageHeader,
  ProportionBar,
  QuantityCell,
  ScatterPlot,
  Section,
  SheetSection,
  SideSheet,
  Sparkline,
  Stacked,
  StatusStamp,
  SuggestionStrip,
  TileRow,
  TrendChart,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';

/**
 * The Fleet Command Board.
 *
 * The team's stated goal is 100% productive, so the board is organised around
 * the productivity leak rather than around a vehicle list: IDLE — ready but
 * unassigned — is an ATTENTION state here, not a neutral grey, because a
 * tipper that can work and isn't is the thing this team is actually paid to
 * eliminate.
 *
 * The tiles are paper with a state-coloured rule, a stamp and a time-in-status
 * counter — NOT sixty flood-filled colour blocks. That is what lets one
 * breakdown among sixty be the loudest thing on a 27-inch screen.
 *
 * Three charts, each answering one question the table cannot:
 *   - the proportion bar answers "what shape is the fleet in right now";
 *   - the fourteen-day trend answers "is that shape normal";
 *   - the scatter answers "which three tippers are burning diesel they did not
 *     move any material with", which is the pilferage question and the reason
 *     58 rows of km/l are worth plotting at all.
 */

/** The board's clock. Every time-in-status figure is measured from here. */
const BOARD_NOW = '2026-08-08T09:12:00Z';

/**
 * Below this share of its own benchmark, a km/l reading stops being weather
 * and starts being a question for the driver. 18% is the threshold the fuel
 * desk already works to, and the table, the scatter and the chip all use it.
 */
const PILFERAGE_RATIO = 0.82;

/** A status change made on this board, not yet written back to the yard. */
interface StatusOverride {
  status: VehicleStatus;
  statusSince: string;
  statusReason: string;
}

export function FleetBoard() {
  const { siteScope, density } = useApp();
  const [filter, setFilter] = useState<'all' | 'breakdown' | 'idle' | 'service' | 'docs' | 'diesel'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, StatusOverride>>({});

  const drivers = driversForSite(siteScope);

  // Site scope first, then anything reported on this board over the top. The
  // override list is what makes a breakdown reported in the sheet recount the
  // tiles, the chips and the proportion bar in the same paint.
  const all = useMemo(
    () =>
      vehiclesForSite(siteScope).map((v) => {
        const patch = overrides[v.id];
        return patch ? { ...v, ...patch } : v;
      }),
    [siteScope, overrides],
  );

  /**
   * Mirrors `fleetCounts` deliberately rather than calling it: the selector
   * reads the dataset, and this board has to count what is on screen, including
   * a breakdown reported thirty seconds ago. Uptime keeps the selector's rule —
   * under-service is EXCLUDED from downtime, because a planned service is not a
   * failure and counting it as one teaches the team to skip services to protect
   * the number.
   */
  const counts = useMemo(() => {
    const by = (s: VehicleStatus) => all.filter((v) => v.status === s).length;
    const productive = by('on_trip') + by('ready');
    return {
      total: all.length,
      onTrip: by('on_trip'),
      ready: by('ready'),
      idle: by('idle'),
      underService: by('under_service'),
      breakdown: by('breakdown'),
      offRoad: by('off_road'),
      uptimePct: all.length > 0 ? Math.round((productive / all.length) * 1000) / 10 : 0,
    };
  }, [all]);

  const dieselOutliers = useMemo(
    () => all.filter((v) => v.lastKmpl !== null && v.lastKmpl < v.benchmarkKmpl * PILFERAGE_RATIO),
    [all],
  );
  const docsExpiring = useMemo(() => all.filter((v) => (v.nextDocExpiryDays ?? 999) <= 30), [all]);

  const rows = useMemo(() => {
    switch (filter) {
      case 'breakdown':
        return all.filter((v) => v.status === 'breakdown');
      case 'idle':
        return all.filter((v) => v.status === 'idle');
      case 'service':
        return all.filter((v) => v.status === 'under_service' || (v.serviceDueInKm ?? 1) < 0);
      case 'docs':
        return docsExpiring;
      case 'diesel':
        return dieselOutliers;
      default:
        return all;
    }
  }, [all, filter, docsExpiring, dieselOutliers]);

  // Ranked, never auto-applied, and dismissal is recorded.
  const idleWithDrivers = all.filter((v) => v.status === 'idle' && v.driverId !== null).length;

  const uptimeSeries = LAST_14.map((d) => ({
    label: d.label,
    value: d.uptimePct,
  }));

  const scatterPoints = useMemo(
    () =>
      all
        .filter((v) => v.lastKmpl !== null)
        .map((v) => ({
          x: v.benchmarkKmpl,
          y: v.lastKmpl as number,
          label: v.displayReg,
          flagged: (v.lastKmpl as number) < v.benchmarkKmpl * PILFERAGE_RATIO,
        })),
    [all],
  );

  const selected = selectedId === null ? null : (all.find((v) => v.id === selectedId) ?? null);
  const canReportBreakdown = selected !== null && selected.status !== 'breakdown' && selected.status !== 'off_road';
  const wasProductive = selected !== null && (selected.status === 'on_trip' || selected.status === 'ready');
  const uptimeIfDown =
    wasProductive && counts.total > 0
      ? Math.round(((counts.onTrip + counts.ready - 1) / counts.total) * 1000) / 10
      : counts.uptimePct;

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Command board"
        meta={
          // Two independent stamps, not one line: at 375px the source name and
          // the driver tally cannot share a row without one of them pushing the
          // header past the viewport.
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source="v_vehicle_status_now" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {drivers.available} drivers available · {drivers.onTrip} on trip · {drivers.absent} absent or on leave
            </span>
          </span>
        }
      />

      {/* ONE TILE PER ROW ON A PHONE.
          Three of these four deltas are a sentence, not a number — "roughly
          51.2 units of dispatch not happening" runs to four lines in the 131px
          of text a half-width column leaves at 375px, and four lines of 12px
          prose under a 40px figure reads as a paragraph rather than a reading.
          Hairlines follow the stacking: a bottom rule between stacked tiles,
          the vertical rule only once they sit side by side. */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <div className="relative">
          <KpiTile
            eyebrow="Fleet uptime"
            hero
            value={`${formatQty(counts.uptimePct, 1)}%`}
            delta={{
              text: `${counts.onTrip} on trip · ${counts.ready} ready of ${counts.total}`,
              tone: counts.breakdown > 0 ? 'critical' : 'neutral',
            }}
            asOf="14:42"
            source="v_fleet_uptime"
            freshness="live"
          />
          {/* The sparkline is parked in the tile's top-right gutter, which is
              only a gutter while the tile is wide. In a 187px half-width column
              it landed on top of the word "uptime". It is not hidden and it is
              not moved — the tile stacking above gives it back its gutter, and
              72px of trend needs 130px of clear tile to the right of a 72px
              eyebrow, which every stacked width provides. */}
          <div className="absolute right-7 top-7">
            <Sparkline data={uptimeSeries.map((p) => p.value)} width={72} height={20} />
          </div>
        </div>
        <KpiTile
          eyebrow="Ready but unassigned"
          value={String(counts.idle)}
          delta={{
            text:
              counts.idle > 0
                ? `roughly ${formatQty(counts.idle * 6.4, 1)} units of dispatch not happening`
                : 'every roadworthy tipper has a load',
            tone: counts.idle > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_vehicle_status_now"
        />
        <KpiTile
          eyebrow="Broken down"
          value={String(counts.breakdown)}
          delta={{
            text: counts.breakdown > 0 ? 'earning nothing, still on the payroll' : 'nothing on the hard shoulder',
            tone: counts.breakdown > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source="v_vehicle_status_now"
        />
        <KpiTile
          eyebrow="Diesel readings off benchmark"
          value={String(dieselOutliers.length)}
          delta={{
            text: `more than 18% under their own km/l · ${docsExpiring.length} documents inside 30 days`,
            tone: dieselOutliers.length > 0 ? 'attention' : 'neutral',
          }}
          asOf="06:00"
          source="v_fuel_tank_to_tank"
          freshness="materialised"
        />
      </TileRow>

      {/* Six filters that wrap to four rows on a phone rather than scroll
          sideways in a strip. It costs 220px, which is real, but a filter you
          cannot see is a filter nobody uses — and the shell already spends one
          horizontal scroller on the section chips directly above this, so a
          second one immediately under it reads as the same control. */}
      <div
        className="flex flex-wrap items-center gap-2 px-6 py-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        {/* The honest answer to twelve columns is usually that three people
            each need four of them — hence saved views, not more columns. */}
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.total}>
          Whole fleet
        </Chip>
        <Chip active={filter === 'breakdown'} onClick={() => setFilter('breakdown')} count={counts.breakdown}>
          Breakdowns
        </Chip>
        <Chip active={filter === 'idle'} onClick={() => setFilter('idle')} count={counts.idle}>
          Ready but unassigned
        </Chip>
        <Chip active={filter === 'service'} onClick={() => setFilter('service')} count={counts.underService}>
          Due for service
        </Chip>
        <Chip active={filter === 'docs'} onClick={() => setFilter('docs')} count={docsExpiring.length}>
          Documents expiring
        </Chip>
        <Chip active={filter === 'diesel'} onClick={() => setFilter('diesel')} count={dieselOutliers.length}>
          Diesel off benchmark
        </Chip>

        {/* Right-aligned against the chips on a desk; its own line on a phone,
            where `ml-auto` inside a wrapped row otherwise flings it to the far
            right of whichever chip row happened to have 40px spare. */}
        <span
          className="flex w-full items-center gap-3 pt-1 text-[12px] sm:ml-auto sm:w-auto sm:pt-0"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <span>
            Uptime{' '}
            <span className="num font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>
              {formatQty(counts.uptimePct, 1)}%
            </span>
          </span>
        </span>
      </div>

      <Section caption="Right now" title="What the fleet is doing">
        <div className="px-6">
          {/* The one chart on this page allowed a full palette: these segments
              ARE the status families, so borrowing the monochrome ramp would
              make the bar disagree with every stamp in the table below it. */}
          <ProportionBar
            summary={`Of ${counts.total} tippers, ${counts.onTrip} are on trip and ${counts.ready} ready — ${formatQty(
              counts.uptimePct,
              1,
            )}% uptime. ${counts.idle} idle, ${counts.underService} in service, ${counts.breakdown} broken down, ${
              counts.offRoad
            } off road.`}
            height={30}
            segments={[
              {
                label: 'On trip',
                value: counts.onTrip,
                tone: 'var(--status-active)',
              },
              {
                label: 'Ready',
                value: counts.ready,
                tone: 'var(--status-ready)',
              },
              {
                label: 'Idle',
                value: counts.idle,
                tone: 'var(--status-attention)',
              },
              {
                label: 'Service',
                value: counts.underService,
                tone: 'var(--status-planned)',
              },
              {
                label: 'Breakdown',
                value: counts.breakdown,
                tone: 'var(--status-critical)',
              },
              {
                label: 'Off road',
                value: counts.offRoad,
                tone: 'var(--status-dormant)',
              },
            ]}
          />
          <ChartCaption>
            Only the first two segments earn money. Service is planned and forgivable; idle is neither, which is why it
            sits in the attention hue beside it rather than in a neutral grey.
          </ChartCaption>
        </div>
      </Section>

      {/* WHERE THE GUTTER LIVES CHANGES WITH THE COLUMN COUNT.
          Two charts side by side want ONE outer gutter and a gap between them,
          so the page pads and the charts do not. Stacked, that same outer pad
          nests inside `Section`'s own px-6 and sets these two headings 24px
          further in than the proportion bar's heading directly above them —
          and 24px further in than the chart they title. Below xl the padding
          moves onto the chart, which puts every caption on the page's one left
          margin and hands the heading back the 24px it was wrapping over. */}
      <div className="grid grid-cols-1 gap-x-8 pt-2 xl:grid-cols-2 xl:px-6">
        <Section caption="Fourteen days" title="Uptime against the band">
          <div className="px-6 xl:px-0">
            <TrendChart
              data={uptimeSeries}
              summary={`Uptime over fourteen days, today at ${formatQty(counts.uptimePct, 1)}%. The two floor days are Sundays.`}
              seriesLabel="Uptime"
              band={{ from: 70, to: 85 }}
              flagBelow={55}
              height={190}
              format={(v) => `${formatQty(v, 0)}%`}
            />
            <ChartCaption>
              The tinted band is where this fleet is expected to sit on a working day. Flagged days that fall below it
              are Sundays, when the plant runs a half shift — a flagged weekday is the one to go and ask about.
            </ChartCaption>
          </div>
        </Section>

        <Section caption="Last full-tank reading" title="Diesel against each vehicle's own benchmark">
          <div className="px-6 xl:px-0">
            <ScatterPlot
              points={scatterPoints}
              summary={
                dieselOutliers.length === 0
                  ? 'Every tipper is within 18% of its own benchmark km/l.'
                  : `${dieselOutliers.length} of ${scatterPoints.length} tippers are running more than 18% below their own benchmark: ${dieselOutliers
                      .map((v) => v.displayReg)
                      .join(', ')}.`
              }
              xLabel="benchmark km/l"
              yLabel="last km/l"
              parityLine
              height={210}
              format={(v) => formatQty(v, 1)}
            />
            <ChartCaption>
              The dashed diagonal is &ldquo;met its benchmark&rdquo;. A 58-row table hides the three that drifted; here
              they are the only ringed and named dots well under the line, and each one is a tank that emptied without
              moving material.
            </ChartCaption>
          </div>
        </Section>
      </div>

      {idleWithDrivers > 0 && filter === 'all' ? (
        <div className="px-6 pt-4">
          <SuggestionStrip onApply={() => setFilter('idle')} onDismiss={() => undefined} applyLabel="Show them">
            {idleWithDrivers} tippers are ready with a driver assigned and no load allotted. At today&rsquo;s average
            that is roughly {formatQty(idleWithDrivers * 6.4, 1)} units of dispatch not happening.
          </SuggestionStrip>
        </div>
      ) : null}

      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(v) => v.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(v) => setSelectedId(v.id)}
          isDormant={(v) => v.status === 'off_road'}
          rail={(v) => ({ status: VEHICLE_STATUS_FAMILY[v.status] })}
          empty={
            <EmptyState
              fact="No vehicles match this view."
              because="Every tipper at this site is either running or accounted for elsewhere."
              action={{
                label: 'Show the whole fleet',
                onClick: () => setFilter('all'),
              }}
            />
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        title={selected?.displayReg ?? ''}
        identifier={selected ? `${selected.model} · ${selected.classTonnes}T` : undefined}
        {...(selected
          ? {
              status: {
                family: VEHICLE_STATUS_FAMILY[selected.status],
                label: VEHICLE_STATUS_LABEL[selected.status],
                severity: hoursSince(selected.statusSince),
              },
            }
          : {})}
        revision={selected ? `ODO ${selected.odometerKm.toLocaleString('en-IN')} KM` : undefined}
        footer={
          selected ? (
            canReportBreakdown ? (
              <>
                <Button variant="destructive" onClick={() => setConfirming(true)}>
                  Report breakdown
                </Button>
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  Takes it off the board immediately and recounts uptime.
                </span>
              </>
            ) : (
              <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                Already off the road — the workshop owns this one now.
              </span>
            )
          ) : null
        }
      >
        {selected ? <VehicleDetail vehicle={selected} /> : null}
      </SideSheet>

      {/* An irreversible-feeling call: reporting a breakdown pulls a tipper off
          every dispatch list in the yard, so the consequence is spelled out with
          the real numbers rather than asking "are you sure?". */}
      <ConfirmModal
        open={confirming && selected !== null}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          if (!selected) return;
          setOverrides((prev) => ({
            ...prev,
            [selected.id]: {
              status: 'breakdown',
              statusSince: BOARD_NOW,
              statusReason: 'Reported from the command board — awaiting workshop triage',
            },
          }));
        }}
        title="Report this tipper broken down"
        destructive
        confirmLabel="Report breakdown"
        consequence={
          selected ? (
            <>
              {selected.displayReg} comes off the dispatch board now. Today&rsquo;s {selected.tripsToday}{' '}
              {selected.tripsToday === 1 ? 'trip' : 'trips'} and {formatQty(selected.tonnesToday, 1)} MT stop where they
              are
              {selected.driverId
                ? `, and ${DRIVERS.find((d) => d.id === selected.driverId)?.name ?? 'the driver'} needs reallocating`
                : ''}
              . Fleet uptime falls from {formatQty(counts.uptimePct, 1)}% to {formatQty(uptimeIfDown, 1)}%.
            </>
          ) : null
        }
      />
    </>
  );
}

/**
 * VEHICLE 360.
 *
 * Everything a fleet manager asks in the thirty seconds after clicking a row,
 * in the order they ask it: what is it doing and since when, who is driving,
 * what has it earned today, is it drinking diesel, and what will stop it at the
 * gate next.
 */
function VehicleDetail({ vehicle }: { vehicle: Vehicle }) {
  const driver = DRIVERS.find((d) => d.id === vehicle.driverId) ?? null;
  const site = SITES.find((s) => s.id === vehicle.siteId);

  const mileage = mileageFor(vehicle.id).map((m) => ({
    label: m.label,
    value: m.kmpl,
  }));
  const floor = Math.round(vehicle.benchmarkKmpl * PILFERAGE_RATIO * 100) / 100;
  const drifted = vehicle.lastKmpl !== null && vehicle.lastKmpl < floor;
  const shortfallPct =
    vehicle.lastKmpl === null ? null : Math.round((1 - vehicle.lastKmpl / vehicle.benchmarkKmpl) * 1000) / 10;

  // The soonest-expiring paper, not the alphabetically first. A vehicle is
  // stopped by whichever certificate dies next, and only some of them stop it.
  const nextDoc = DOCUMENTS.filter((d) => d.vehicleId === vehicle.id).sort((a, b) => a.daysLeft - b.daysLeft)[0];

  const serviceDue = vehicle.serviceDueInKm;

  return (
    <>
      <SheetSection caption="Identity">
        <DetailGrid>
          <Detail label="Registration">
            <IdCell>{vehicle.displayReg}</IdCell>
          </Detail>
          <Detail label="Model">{vehicle.model}</Detail>
          <Detail label="Rated class">{formatQty(vehicle.classTonnes, 0)} T</Detail>
          <Detail label="Home site">{site?.name ?? '–'}</Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Standing">
        <DetailGrid>
          <Detail label="Status">
            <StatusStamp
              status={VEHICLE_STATUS_FAMILY[vehicle.status]}
              label={VEHICLE_STATUS_LABEL[vehicle.status]}
              severity={hoursSince(vehicle.statusSince)}
            />
          </Detail>
          <Detail label="In this status for">{hoursSince(vehicle.statusSince)}</Detail>
        </DetailGrid>
        <Note>
          {vehicle.statusReason
            ? `${vehicle.statusReason}.`
            : vehicle.status === 'on_trip'
              ? 'Out on a load. Nothing is being reported against it that needs an answer.'
              : 'No reason has been recorded against this status.'}
        </Note>
      </SheetSection>

      <SheetSection caption="Crew">
        {driver ? (
          <DetailGrid>
            <Detail label="Driver">{driver.name}</Detail>
            <Detail label="Phone">{driver.phone}</Detail>
            <Detail label="Licence">
              <IdCell>{driver.licenceNumber}</IdCell>
            </Detail>
            <Detail label="Licence expires">{driver.licenceExpiry.slice(0, 10)}</Detail>
          </DetailGrid>
        ) : (
          <Note>
            No driver is assigned. A tipper without a name against it cannot be allotted a load, however roadworthy it
            is.
          </Note>
        )}
      </SheetSection>

      <SheetSection caption="Today">
        <DetailGrid>
          <Detail label="Trips">
            <QuantityCell value={vehicle.tripsToday} decimals={0} />
          </Detail>
          <Detail label="Moved">
            <QuantityCell value={vehicle.tonnesToday} decimals={1} uom="MT" />
          </Detail>
        </DetailGrid>
        {vehicle.tripsToday === 0 ? (
          <Note>Nothing has moved on this vehicle today. Zero trips is a fact, not a missing reading.</Note>
        ) : null}
      </SheetSection>

      <SheetSection caption="Diesel, tank to tank">
        {mileage.length < 2 ? (
          <Note>
            Fewer than two full-tank fills on record, so no km/l can be derived. Part fills tell you nothing about
            consumption and are deliberately not plotted here.
          </Note>
        ) : (
          <>
            <TrendChart
              data={mileage}
              summary={`Last reading ${formatQty(vehicle.lastKmpl ?? 0, 2)} km/l against a benchmark of ${formatQty(
                vehicle.benchmarkKmpl,
                2,
              )}${drifted ? `, a shortfall of ${formatQty(shortfallPct ?? 0, 1)}%` : ' — within tolerance'}.`}
              seriesLabel="km/l"
              benchmark={{
                value: vehicle.benchmarkKmpl,
                label: `${formatQty(vehicle.benchmarkKmpl, 2)} benchmark`,
              }}
              flagBelow={floor}
              height={180}
              format={(v) => formatQty(v, 1)}
            />
            <ChartCaption>
              Only full-tank fills give a usable reading, so the points are sparse by construction — six to nine a
              month, never thirty.{' '}
              {drifted
                ? 'This one slid over a fortnight rather than overnight, which is the shape of a slow leak or a nightly siphon, not a bad tank.'
                : 'The line sits on its benchmark; nothing to ask the driver about.'}
            </ChartCaption>
          </>
        )}
      </SheetSection>

      <SheetSection caption="Upkeep">
        <DetailGrid>
          <Detail label="Odometer">
            <QuantityCell value={vehicle.odometerKm} decimals={0} uom="km" />
          </Detail>
          <Detail label="Service due in">
            {serviceDue === null ? (
              '–'
            ) : (
              <span
                style={{
                  color: serviceDue < 0 ? 'var(--status-critical)' : undefined,
                }}
              >
                <QuantityCell value={serviceDue} decimals={0} uom="km" />
              </span>
            )}
          </Detail>
        </DetailGrid>
        {serviceDue !== null && serviceDue < 0 ? (
          <Note>
            Overrun by {formatQty(Math.abs(serviceDue), 0)} km. Every kilometre past the interval is warranty the
            workshop will not honour on the next gearbox.
          </Note>
        ) : null}
      </SheetSection>

      <SheetSection caption="Next document to expire">
        {!nextDoc ? (
          <Note>No statutory documents are on file for this vehicle, which is itself the finding.</Note>
        ) : (
          <>
            <DetailGrid>
              <Detail label="Document">{nextDoc.label}</Detail>
              <Detail label="Number">
                <IdCell>{nextDoc.number}</IdCell>
              </Detail>
              <Detail label="Expires">{nextDoc.expiresOn.slice(0, 10)}</Detail>
              <Detail label="Issued by">{nextDoc.issuer}</Detail>
            </DetailGrid>
            <div className="mt-2 flex items-center gap-2">
              <StatusStamp
                status={nextDoc.daysLeft < 0 ? 'critical' : nextDoc.daysLeft <= 30 ? 'attention' : 'ready'}
                label={nextDoc.daysLeft < 0 ? 'Expired' : nextDoc.daysLeft <= 30 ? 'Expiring' : 'In force'}
                severity={nextDoc.daysLeft < 0 ? `${Math.abs(nextDoc.daysLeft)}d ago` : `${nextDoc.daysLeft}d`}
              />
            </div>
            <div className="mt-2">
              <Note>
                {nextDoc.daysLeft < 0
                  ? nextDoc.blocksOperation
                    ? `Expired ${Math.abs(nextDoc.daysLeft)} days ago and it stops the vehicle at the gate. Any load allotted to it today is a detention risk and the fine lands on the consignor, not the driver.`
                    : `Expired ${Math.abs(nextDoc.daysLeft)} days ago. It does not stop the vehicle at the gate, but it will be the first thing asked for at a check post.`
                  : nextDoc.blocksOperation
                    ? `${nextDoc.daysLeft} days left, and when it goes the vehicle cannot legally leave the yard. Renewals of this type take a fortnight at the RTO.`
                    : `${nextDoc.daysLeft} days left. Renew it with the next batch rather than on its own.`}
              </Note>
            </div>
          </>
        )}
      </SheetSection>
    </>
  );
}

function hoursSince(iso: string): string {
  const h = (Date.parse(BOARD_NOW) - Date.parse(iso)) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

const columns: Column<Vehicle>[] = [
  {
    key: 'reg',
    header: 'Vehicle',
    type: 'id',
    sticky: true,
    width: 200,
    group: 'Identity',
    render: (v) => <Stacked primary={<IdCell>{v.displayReg}</IdCell>} secondary={`${v.model} · ${v.classTonnes}T`} />,
  },
  {
    key: 'status',
    header: 'Status',
    type: 'status',
    width: 148,
    group: 'Identity',
    render: (v) => (
      <StatusStamp
        status={VEHICLE_STATUS_FAMILY[v.status]}
        label={VEHICLE_STATUS_LABEL[v.status]}
        severity={hoursSince(v.statusSince)}
      />
    ),
  },
  {
    key: 'reason',
    header: 'Because',
    group: 'Identity',
    // Recorded text, so it sets in the data face. The italic margin voice is
    // reserved for the product talking about the data, never for the data.
    render: (v) =>
      v.statusReason ? (
        <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {v.statusReason}
        </span>
      ) : null,
  },
  {
    key: 'driver',
    header: 'Driver',
    group: 'Crew',
    render: (v) => DRIVERS.find((d) => d.id === v.driverId)?.name ?? null,
  },
  {
    key: 'trips',
    header: 'Trips',
    type: 'num',
    width: 78,
    group: 'Today',
    render: (v) => <QuantityCell value={v.tripsToday} decimals={0} />,
  },
  {
    key: 'tonnes',
    header: 'Moved',
    unit: 'MT',
    type: 'num',
    width: 96,
    group: 'Today',
    render: (v) => <QuantityCell value={v.tonnesToday} decimals={1} />,
  },
  {
    key: 'kmpl',
    header: 'Last',
    unit: 'km/l',
    type: 'num',
    width: 96,
    group: 'Diesel',
    render: (v) =>
      v.lastKmpl === null ? null : (
        <span
          style={{
            // Colour is spent only when the reading crosses its threshold —
            // an 18% drop against benchmark is the pilferage signal.
            color: v.lastKmpl < v.benchmarkKmpl * PILFERAGE_RATIO ? 'var(--status-attention)' : undefined,
          }}
        >
          <QuantityCell value={v.lastKmpl} decimals={2} />
        </span>
      ),
  },
  {
    key: 'benchmark',
    header: 'Benchmark',
    unit: 'km/l',
    type: 'num',
    width: 104,
    group: 'Diesel',
    render: (v) => (
      <span style={{ color: 'var(--text-tertiary)' }}>
        <QuantityCell value={v.benchmarkKmpl} decimals={2} />
      </span>
    ),
  },
  {
    key: 'trend',
    header: 'Trend',
    width: 84,
    group: 'Diesel',
    // The sparkline answers "is this a bad week or a slide" without costing a
    // click, and the benchmark hairline behind it is what makes it readable.
    render: (v) => {
      const series = mileageFor(v.id).map((m) => m.kmpl);
      if (series.length < 2) return null;
      return (
        <Sparkline
          data={series}
          benchmark={v.benchmarkKmpl}
          width={72}
          height={18}
          tone={v.lastKmpl !== null && v.lastKmpl < v.benchmarkKmpl * PILFERAGE_RATIO ? 'attention' : 'chart'}
        />
      );
    },
  },
  {
    key: 'service',
    header: 'Service due in',
    unit: 'km',
    type: 'num',
    width: 128,
    group: 'Upkeep',
    render: (v) =>
      v.serviceDueInKm === null ? null : (
        <span
          style={{
            color: v.serviceDueInKm < 0 ? 'var(--status-critical)' : undefined,
          }}
        >
          <QuantityCell value={v.serviceDueInKm} decimals={0} />
        </span>
      ),
  },
  {
    key: 'docs',
    header: 'Next document',
    width: 190,
    group: 'Upkeep',
    render: (v) => {
      if (v.nextDocExpiryDays === null) return null;
      const expired = v.nextDocExpiryDays < 0;
      const soon = v.nextDocExpiryDays <= 30;
      return (
        <span className="flex items-center gap-2">
          <span
            style={{
              color: expired ? 'var(--status-critical)' : soon ? 'var(--status-attention)' : 'var(--text-secondary)',
            }}
          >
            {v.nextDocType}
          </span>
          <span
            className="num tabular-nums text-[12px]"
            style={{
              color: expired ? 'var(--status-critical)' : 'var(--text-tertiary)',
            }}
          >
            {expired ? `${Math.abs(v.nextDocExpiryDays)}d ago` : `${v.nextDocExpiryDays}d`}
          </span>
        </span>
      );
    },
  },
];
