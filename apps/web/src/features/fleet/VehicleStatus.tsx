import { useMemo, useState } from 'react';
import { formatDate, formatQty } from '@linck/domain';
import {
  DOCUMENTS,
  DRIVERS,
  driversForSite,
  LAST_14,
  mileageFor,
  isIdleRoadworthy,
  isServiceOverdue,
  SITES,
  vehiclesForSite,
  vehiclesWithExpiredDocs,
  VEHICLE_STATUS_FAMILY,
  type ComplianceDocument,
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
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { fleetWords, vehicleWords } from './words.js';

/**
 * Vehicle status — the fleet's full vehicle database.
 *
 * This was the fleet command board until LIN-18 gave the fleet manager a
 * landing page of urgent counts and links. Everything below still lives here,
 * one click away, and the landing page's cards open straight into the chips
 * on this screen via `?view=`.
 *
 * The team's stated goal is 100% productive, so the board is organised around
 * the productivity leak rather than around a vehicle list: IDLE — ready but
 * unassigned — is an ATTENTION state here, not a neutral grey, because a
 * tipper that can work and isn't is the thing this team is actually paid to
 * eliminate.
 *
 * "Uptime" is said on screen as "Ready or on trip": the share of the fleet on a
 * trip or ready for one. Only those two earn; service is planned and
 * forgivable, idle is neither.
 *
 * The tiles are paper with a state-coloured rule, a stamp and a time-in-status
 * counter — NOT sixty flood-filled colour blocks. That is what lets one
 * breakdown among sixty be the loudest thing on a 27-inch screen.
 *
 * Three charts, each answering one question the table cannot:
 *   - the proportion bar answers "what shape is the fleet in right now";
 *   - the fourteen-day trend answers "is that shape normal" (the band is a
 *     normal working day; the low days are Sundays, when the plant runs half
 *     a shift — a low weekday is the one to go and ask about);
 *   - the scatter answers "which three tippers are burning diesel they did not
 *     move any material with", which is the pilferage question and the reason
 *     58 rows of km/l are worth plotting at all. The dashed diagonal is "met
 *     its benchmark"; the ringed, named dots well under it are each a tank
 *     that emptied without moving material.
 *
 * "Benchmark" km/l is said as "normal" on screen.
 */

/** The board's clock. Every time-in-status figure is measured from here. */
const BOARD_NOW = '2026-08-08T09:12:00Z';

/**
 * Below this share of its own benchmark, a km/l reading stops being weather
 * and starts being a question for the driver. 18% is the threshold the fuel
 * desk already works to, and the table, the scatter and the chip all use it.
 */
const PILFERAGE_RATIO = 0.82;

/**
 * Rough units of dispatch one idle tipper would have moved today, at today's
 * average. Only used to put a size on the idle count.
 */
const UNITS_PER_IDLE_TIPPER = 6.4;

/**
 * The reason recorded when a breakdown is reported from this board. Stored as
 * this marker and worded at render, so it reads in the viewer's language.
 */
const REPORTED_HERE = 'Reported from vehicle status — awaiting workshop triage';

/** A vehicle carries its next document by name; the name maps back to the type. */
const DOC_TYPE_BY_LABEL = new Map<string, ComplianceDocument['type']>(DOCUMENTS.map((d) => [d.label, d.type]));

/** A status change made on this board, not yet written back to the yard. */
interface StatusOverride {
  status: VehicleStatus;
  statusSince: string;
  statusReason: string;
}

const VIEWS = ['all', 'breakdown', 'idle', 'service', 'service_overdue', 'docs', 'docs_expired', 'diesel'] as const;

type VehicleText = (typeof vehicleWords)['en'];
type FleetText = (typeof fleetWords)['en'];
type StatusText = (typeof statusWords)['en'];

export function VehicleStatus() {
  const t = useWords(vehicleWords);
  const f = useWords(fleetWords);
  const status = useWords(statusWords);
  const { siteScope, density } = useApp();
  const [filter, setFilter] = useViewParam(VIEWS, 'all');
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
  // Next document inside 30 days, or already past it.
  const docsExpiring = useMemo(() => all.filter((v) => (v.nextDocExpiryDays ?? 999) <= 30), [all]);
  const docsExpired = useMemo(() => {
    const expired = vehiclesWithExpiredDocs();
    return all.filter((v) => expired.has(v.id));
  }, [all]);
  const serviceOverdue = useMemo(() => all.filter(isServiceOverdue), [all]);
  const idleRoadworthy = useMemo(() => all.filter(isIdleRoadworthy), [all]);

  const rows = useMemo(() => {
    switch (filter) {
      case 'breakdown':
        return all.filter((v) => v.status === 'breakdown');
      // Roadworthy and without a load — the command board's Idle card. A
      // tipper idle only because a blocking document lapsed is listed under
      // documents expired instead.
      case 'idle':
        return idleRoadworthy;
      // "In the workshop" is exactly the count on its chip. Overdue vehicles
      // still on the road have their own chip, "Service due", which is what
      // the command board's card of that name opens.
      case 'service':
        return all.filter((v) => v.status === 'under_service');
      case 'service_overdue':
        return serviceOverdue;
      case 'docs':
        return docsExpiring;
      case 'docs_expired':
        return docsExpired;
      case 'diesel':
        return dieselOutliers;
      default:
        return all;
    }
  }, [all, filter, docsExpiring, docsExpired, serviceOverdue, idleRoadworthy, dieselOutliers]);

  // Ranked, never auto-applied, and dismissal is recorded.
  const idleWithDrivers = idleRoadworthy.filter((v) => v.driverId !== null).length;

  // Day labels as 08-08 — digits read the same in both languages.
  const uptimeSeries = LAST_14.map((d) => ({
    label: dayMonth(d.date),
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

  const columns = useMemo(() => columnsFor(t, f, status), [t, f, status]);

  const selected = selectedId === null ? null : (all.find((v) => v.id === selectedId) ?? null);
  const canReportBreakdown = selected !== null && selected.status !== 'breakdown' && selected.status !== 'off_road';
  const wasProductive = selected !== null && (selected.status === 'on_trip' || selected.status === 'ready');
  const uptimeIfDown =
    wasProductive && counts.total > 0
      ? Math.round(((counts.onTrip + counts.ready - 1) / counts.total) * 1000) / 10
      : counts.uptimePct;

  // The segments ARE the status families, so the bar reads the same words as
  // every stamp in the table below it.
  const segments = [
    { key: 'on_trip', value: counts.onTrip, tone: 'var(--status-active)' },
    { key: 'ready', value: counts.ready, tone: 'var(--status-ready)' },
    { key: 'idle', value: counts.idle, tone: 'var(--status-attention)' },
    { key: 'under_service', value: counts.underService, tone: 'var(--status-planned)' },
    { key: 'breakdown', value: counts.breakdown, tone: 'var(--status-critical)' },
    { key: 'off_road', value: counts.offRoad, tone: 'var(--status-dormant)' },
  ] as const;

  const chips: { view: (typeof VIEWS)[number]; label: string; count: number }[] = [
    { view: 'all', label: f.all, count: counts.total },
    { view: 'breakdown', label: status.vehicle.breakdown, count: counts.breakdown },
    { view: 'idle', label: status.vehicle.idle, count: idleRoadworthy.length },
    { view: 'service', label: status.vehicle.under_service, count: counts.underService },
    { view: 'service_overdue', label: t.views.serviceDue, count: serviceOverdue.length },
    { view: 'docs', label: t.views.docsSoon, count: docsExpiring.length },
    { view: 'docs_expired', label: t.views.docsExpired, count: docsExpired.length },
    { view: 'diesel', label: t.lowMileage, count: dieselOutliers.length },
  ];

  return (
    <>
      <PageHeader
        eyebrow={f.eyebrow}
        title={t.title}
        meta={
          // Two independent stamps, not one line: at 375px the driver tally
          // cannot share a row with the time without pushing the header past
          // the viewport.
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source={f.from.vehicles} freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {t.drivers(drivers.available, drivers.onTrip, drivers.absent)}
            </span>
          </span>
        }
      />

      {/* ONE TILE PER ROW ON A PHONE.
          Hairlines follow the stacking: a bottom rule between stacked tiles,
          the vertical rule only once they sit side by side. */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <div className="relative">
          <KpiTile
            eyebrow={t.working}
            hero
            value={`${formatQty(counts.uptimePct, 1)}%`}
            delta={{
              text: t.workingSplit(counts.onTrip, counts.ready, counts.total),
              tone: counts.breakdown > 0 ? 'critical' : 'neutral',
            }}
            asOf="14:42"
            source={f.from.vehicles}
            freshness="live"
          />
          {/* The sparkline sits level with the figure, not the caption: the
              caption is longer in Tamil and runs under a sparkline parked at
              the top. Beside the figure there is room at every width, because
              the tiles stack one per row before they get narrow. */}
          <div className="absolute right-7 top-[60px]">
            <Sparkline data={uptimeSeries.map((p) => p.value)} width={72} height={20} />
          </div>
        </div>
        <KpiTile
          eyebrow={status.vehicle.idle}
          value={String(idleRoadworthy.length)}
          delta={{
            text:
              idleRoadworthy.length > 0
                ? t.idleLoss(formatQty(idleRoadworthy.length * UNITS_PER_IDLE_TIPPER, 1))
                : t.idleNone,
            tone: idleRoadworthy.length > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source={f.from.vehicles}
        />
        <KpiTile
          eyebrow={status.vehicle.breakdown}
          value={String(counts.breakdown)}
          delta={{
            text: counts.breakdown > 0 ? t.breakdownNow : t.breakdownNone,
            tone: counts.breakdown > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source={f.from.vehicles}
        />
        <KpiTile
          eyebrow={t.lowMileage}
          value={String(dieselOutliers.length)}
          delta={{
            text: t.lowMileageRule,
            tone: dieselOutliers.length > 0 ? 'attention' : 'neutral',
          }}
          asOf="06:00"
          source={f.from.fullTank}
          freshness="materialised"
        />
      </TileRow>

      {/* Eight filters that wrap to several rows on a phone rather than scroll
          sideways in a strip: a filter you cannot see is a filter nobody uses. */}
      <div
        id="list"
        className="flex flex-wrap items-center gap-2 px-6 py-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        {chips.map((c) => (
          <Chip key={c.view} active={filter === c.view} onClick={() => setFilter(c.view)} count={c.count}>
            {c.label}
          </Chip>
        ))}
      </div>

      <Section title={t.now}>
        <div className="px-6">
          <ProportionBar
            summary={t.nowSummary(
              counts.total,
              segments.map((s) => `${status.vehicle[s.key]} ${s.value}`).join(', '),
            )}
            height={30}
            segments={segments.map((s) => ({ label: status.vehicle[s.key], value: s.value, tone: s.tone }))}
          />
        </div>
      </Section>

      {/* WHERE THE GUTTER LIVES CHANGES WITH THE COLUMN COUNT.
          Two charts side by side want ONE outer gutter and a gap between them,
          so the page pads and the charts do not. Below xl the padding moves
          onto the chart, which puts every caption on the page's one left
          margin. */}
      <div className="grid grid-cols-1 gap-x-8 pt-2 xl:grid-cols-2 xl:px-6">
        <Section caption={t.days14} title={t.working}>
          <div className="px-6 xl:px-0">
            <TrendChart
              data={uptimeSeries}
              summary={t.trendSummary(formatQty(counts.uptimePct, 1))}
              band={{ from: 70, to: 85 }}
              flagBelow={55}
              height={190}
              format={(v) => `${formatQty(v, 0)}%`}
            />
            <ChartCaption>{t.trendNote}</ChartCaption>
          </div>
        </Section>

        <Section caption={t.lastFull} title={t.mileageTitle}>
          <div className="px-6 xl:px-0">
            <ScatterPlot
              points={scatterPoints}
              summary={t.scatterSummary(
                dieselOutliers.length,
                scatterPoints.length,
                dieselOutliers.map((v) => v.displayReg).join(', '),
              )}
              xLabel={t.scatterX}
              yLabel={t.scatterY}
              parityLine
              height={210}
              format={(v) => formatQty(v, 1)}
            />
            <ChartCaption>{t.scatterNote}</ChartCaption>
          </div>
        </Section>
      </div>

      {idleWithDrivers > 0 && filter === 'all' ? (
        <div className="px-6 pt-4">
          <SuggestionStrip onApply={() => setFilter('idle')} onDismiss={() => undefined} applyLabel={t.showThem}>
            {t.idleWithDriver(idleWithDrivers)}
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
          empty={<EmptyState fact={t.noneHere} action={{ label: f.showAll, onClick: () => setFilter('all') }} />}
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        title={selected?.displayReg ?? ''}
        identifier={selected ? `${selected.model} · ${t.sizeOf(selected.classTonnes)}` : undefined}
        // How long it has been in this status is in the sheet's Status
        // section, so the stamp up here carries the word alone — on a phone a
        // longer stamp squeezes the vehicle number onto several lines.
        {...(selected
          ? {
              status: {
                family: VEHICLE_STATUS_FAMILY[selected.status],
                label: status.vehicle[selected.status],
              },
            }
          : {})}
        // The km reading is in the sheet's Service section, so the header does
        // not repeat it.
        footer={
          selected ? (
            canReportBreakdown ? (
              // Reporting takes it off the board at once and recounts uptime;
              // the confirm dialog spells that out with the real numbers.
              <Button variant="destructive" onClick={() => setConfirming(true)}>
                {t.reportBreakdown}
              </Button>
            ) : (
              // Already off the road — the workshop owns this one now.
              <span className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                {t.alreadyDown}
              </span>
            )
          ) : null
        }
      >
        {selected ? <VehicleDetail vehicle={selected} /> : null}
      </SideSheet>

      {/* An irreversible-feeling call: reporting a breakdown pulls a tipper off
          every dispatch list in the yard, so the consequence is spelled out with
          the real numbers rather than asking "are you sure?". Today's trips
          stop where they are. */}
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
              statusReason: REPORTED_HERE,
            },
          }));
        }}
        title={t.confirmTitle}
        destructive
        confirmLabel={t.reportBreakdown}
        consequence={
          selected ? (
            <>
              {t
                .confirmLines(
                  selected.displayReg,
                  selected.driverId ? (DRIVERS.find((d) => d.id === selected.driverId)?.name ?? null) : null,
                  formatQty(counts.uptimePct, 1),
                  formatQty(uptimeIfDown, 1),
                )
                .map((line) => (
                  <p key={line}>{line}</p>
                ))}
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
  const v = useWords(vehicleWords);
  const f = useWords(fleetWords);
  const t = v.sheet;
  const driver = DRIVERS.find((d) => d.id === vehicle.driverId) ?? null;
  const site = SITES.find((s) => s.id === vehicle.siteId);

  const mileage = mileageFor(vehicle.id).map((m) => ({
    label: dayMonth(m.date),
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
  const reason = reasonText(vehicle.statusReason, v);

  return (
    <>
      <SheetSection caption={t.vehicle}>
        <DetailGrid>
          <Detail label={t.number}>
            <IdCell>{vehicle.displayReg}</IdCell>
          </Detail>
          <Detail label={t.model}>{vehicle.model}</Detail>
          <Detail label={t.size}>{v.sizeOf(vehicle.classTonnes)}</Detail>
          <Detail label={t.site}>{site?.name ?? '–'}</Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.status}>
        {/* The stamp itself is in the sheet's header. On a trip with nothing
            recorded, there is nothing that needs an answer, so no reason row. */}
        <DetailGrid>
          <Detail label={t.howLong}>{timeSince(vehicle.statusSince, f)}</Detail>
          {reason || vehicle.status !== 'on_trip' ? <Detail label={t.reason}>{reason ?? t.noReason}</Detail> : null}
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.driver}>
        {driver ? (
          <DetailGrid>
            <Detail label={t.name}>{driver.name}</Detail>
            <Detail label={t.phone}>{driver.phone}</Detail>
            <Detail label={t.licence}>
              <IdCell>{driver.licenceNumber}</IdCell>
            </Detail>
            <Detail label={t.licenceExpiry}>{formatDate(driver.licenceExpiry)}</Detail>
          </DetailGrid>
        ) : (
          // A tipper without a name against it cannot be allotted a load,
          // however roadworthy it is.
          <Note>{t.noDriver}</Note>
        )}
      </SheetSection>

      {/* Zero trips is a fact, not a missing reading — the 0 says so itself. */}
      <SheetSection caption={t.today}>
        <DetailGrid>
          <Detail label={t.trips}>
            <QuantityCell value={vehicle.tripsToday} decimals={0} />
          </Detail>
          <Detail label={t.moved}>
            <QuantityCell value={vehicle.tonnesToday} decimals={1} uom={f.tonnes} />
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.mileage}>
        {mileage.length < 2 ? (
          // Only full-tank fills give a usable reading; part fills tell you
          // nothing about consumption and are deliberately not plotted.
          <Note>{t.notEnoughFills}</Note>
        ) : (
          <>
            <TrendChart
              data={mileage}
              summary={t.mileageSummary(
                formatQty(vehicle.lastKmpl ?? 0, 2),
                formatQty(vehicle.benchmarkKmpl, 2),
                drifted ? formatQty(shortfallPct ?? 0, 1) : null,
              )}
              seriesLabel={f.kmpl}
              benchmark={{
                value: vehicle.benchmarkKmpl,
                label: t.normalAt(formatQty(vehicle.benchmarkKmpl, 2)),
              }}
              flagBelow={floor}
              height={180}
              format={(n) => formatQty(n, 1)}
            />
            {/* A drift that slid over a fortnight rather than overnight is the
                shape of a slow leak or a nightly siphon, not a bad tank. */}
            <ChartCaption>{drifted ? t.dropping : t.steady}</ChartCaption>
          </>
        )}
      </SheetSection>

      <SheetSection caption={t.service}>
        <DetailGrid>
          <Detail label={t.kmReading}>
            <QuantityCell value={vehicle.odometerKm} decimals={0} uom={f.km} />
          </Detail>
          <Detail label={t.nextService}>
            {serviceDue === null ? (
              '–'
            ) : (
              <span
                style={{
                  color: serviceDue < 0 ? 'var(--status-critical)' : undefined,
                }}
              >
                <QuantityCell value={serviceDue} decimals={0} uom={f.km} />
              </span>
            )}
          </Detail>
        </DetailGrid>
        {/* Every kilometre past the interval is warranty the workshop will not
            honour on the next gearbox. */}
        {serviceDue !== null && serviceDue < 0 ? <Note>{t.serviceLate(formatQty(Math.abs(serviceDue), 0))}</Note> : null}
      </SheetSection>

      <SheetSection caption={t.nextDoc}>
        {!nextDoc ? (
          <Note>{t.noDocs}</Note>
        ) : (
          <>
            <DetailGrid>
              <Detail label={t.document}>{f.docType[nextDoc.type]}</Detail>
              <Detail label={t.docNumber}>
                <IdCell>{nextDoc.number}</IdCell>
              </Detail>
              <Detail label={t.expires}>{formatDate(nextDoc.expiresOn)}</Detail>
              <Detail label={t.issuer}>{nextDoc.issuer}</Detail>
            </DetailGrid>
            <div className="mt-2 flex items-center gap-2">
              <StatusStamp
                status={nextDoc.daysLeft < 0 ? 'critical' : nextDoc.daysLeft <= 30 ? 'attention' : 'ready'}
                label={nextDoc.daysLeft < 0 ? f.expired : nextDoc.daysLeft <= 30 ? f.expiring : f.valid}
                severity={nextDoc.daysLeft < 0 ? f.daysAgo(Math.abs(nextDoc.daysLeft)) : f.inDays(nextDoc.daysLeft)}
              />
            </div>
            {/* A blocking document stops the vehicle at the gate: a load allotted
                to it is a detention risk and the fine lands on the consignor.
                A non-blocking one is the first thing asked for at a check post.
                Renewals of a blocking type take a fortnight at the RTO. */}
            <div className="mt-2">
              <Note>
                {nextDoc.daysLeft < 0
                  ? nextDoc.blocksOperation
                    ? t.docExpiredStops
                    : t.docExpiredRuns
                  : nextDoc.blocksOperation
                    ? t.docStops
                    : t.docRuns}
              </Note>
            </div>
          </>
        )}
      </SheetSection>
    </>
  );
}

/** How long in this status: `45 min`, `11 hrs`, `3 days`. */
function timeSince(iso: string, f: FleetText): string {
  const h = (Date.parse(BOARD_NOW) - Date.parse(iso)) / 3_600_000;
  if (h < 1) return f.min(Math.round(h * 60));
  if (h < 48) return f.hours(Math.round(h));
  return f.days(Math.round(h / 24));
}

/** `2026-08-08` → `08-08`. */
function dayMonth(isoDate: string): string {
  return `${isoDate.slice(8, 10)}-${isoDate.slice(5, 7)}`;
}

/** What was written down, except the reason this board writes, which is worded. */
function reasonText(reason: string | undefined, t: VehicleText): string | null {
  if (!reason) return null;
  return reason === REPORTED_HERE ? t.reportedHere : reason;
}

function columnsFor(t: VehicleText, f: FleetText, status: StatusText): Column<Vehicle>[] {
  return [
    {
      key: 'reg',
      header: t.col.vehicle,
      type: 'id',
      sticky: true,
      width: 220,
      render: (v) => <Stacked primary={<IdCell>{v.displayReg}</IdCell>} secondary={`${v.model} · ${t.sizeOf(v.classTonnes)}`} />,
    },
    {
      key: 'status',
      header: t.col.status,
      type: 'status',
      width: 170,
      render: (v) => (
        <StatusStamp
          status={VEHICLE_STATUS_FAMILY[v.status]}
          label={status.vehicle[v.status]}
          severity={timeSince(v.statusSince, f)}
        />
      ),
    },
    {
      key: 'reason',
      header: t.col.reason,
      // Recorded text, so it sets in the data face. The italic margin voice is
      // reserved for the product talking about the data, never for the data.
      render: (v) => {
        const reason = reasonText(v.statusReason, t);
        return reason ? (
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {reason}
          </span>
        ) : null;
      },
    },
    {
      key: 'driver',
      header: t.col.driver,
      render: (v) => DRIVERS.find((d) => d.id === v.driverId)?.name ?? null,
    },
    {
      key: 'trips',
      header: t.col.trips,
      type: 'num',
      width: 78,
      group: t.col.today,
      render: (v) => <QuantityCell value={v.tripsToday} decimals={0} />,
    },
    {
      key: 'tonnes',
      header: t.col.moved,
      unit: f.tonnes,
      type: 'num',
      width: 120,
      group: t.col.today,
      render: (v) => <QuantityCell value={v.tonnesToday} decimals={1} />,
    },
    {
      key: 'kmpl',
      header: t.col.last,
      unit: f.kmpl,
      type: 'num',
      width: 110,
      group: t.col.mileage,
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
      header: t.col.normal,
      unit: f.kmpl,
      type: 'num',
      width: 110,
      group: t.col.mileage,
      render: (v) => (
        <span style={{ color: 'var(--text-tertiary)' }}>
          <QuantityCell value={v.benchmarkKmpl} decimals={2} />
        </span>
      ),
    },
    {
      key: 'trend',
      header: t.col.days28,
      width: 84,
      group: t.col.mileage,
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
      header: t.col.serviceIn,
      unit: f.km,
      type: 'num',
      width: 128,
      group: t.col.upkeep,
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
      header: t.col.nextDoc,
      width: 230,
      group: t.col.upkeep,
      render: (v) => {
        if (v.nextDocExpiryDays === null) return null;
        const expired = v.nextDocExpiryDays < 0;
        const soon = v.nextDocExpiryDays <= 30;
        const type = v.nextDocType === null ? undefined : DOC_TYPE_BY_LABEL.get(v.nextDocType);
        return (
          <span className="flex flex-wrap items-center gap-x-2">
            <span
              style={{
                color: expired ? 'var(--status-critical)' : soon ? 'var(--status-attention)' : 'var(--text-secondary)',
              }}
            >
              {type ? f.docType[type] : v.nextDocType}
            </span>
            <span
              className="num tabular-nums text-[12px]"
              style={{
                color: expired ? 'var(--status-critical)' : 'var(--text-tertiary)',
              }}
            >
              {expired ? f.daysAgo(Math.abs(v.nextDocExpiryDays)) : f.inDays(v.nextDocExpiryDays)}
            </span>
          </span>
        );
      },
    },
  ];
}
