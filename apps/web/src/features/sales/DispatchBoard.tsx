import { useMemo, useState } from 'react';
import {
  can,
  DEFAULT_VARIANCE_TOLERANCE_PCT,
  formatINR,
  formatINRCompact,
  formatQty,
  formatTime,
  isVarianceExceptional,
} from '@linck/domain';
import {
  CUSTOMERS_LIST,
  DRIVERS,
  PRODUCTS,
  SITES,
  TRIPS,
  TRIP_STATUS_FAMILY,
  VEHICLES,
  isDispatchUnconfirmed,
  isUnbilledDispatch,
  type Trip,
} from '@linck/mock';
import {
  AsOfStamp,
  BarChart,
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
  MoneyCell,
  Note,
  PageHeader,
  ProportionBar,
  Provisional,
  QuantityCell,
  ScatterPlot,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  SuggestionStrip,
  TileRow,
  useIsPhone,
  type Column,
} from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { shortName } from './shortName.js';
import { loadWords, salesWords, type LoadText, type SalesText } from './words.js';

/**
 * The delivery order and dispatch board ("Loads" on screen).
 *
 * The sales coordinator takes orders on the phone from 6:30am, allots lorries
 * and then watches loads move. So the board is organised as LANES, not as a
 * trip list — and the four things this trade actually argues about are given
 * columns of their own rather than being buried in a drawer:
 *
 *   1. QUANTITY BASIS. `soldUnits` is the primary number — often settled by eye
 *      and by argument at the loader. The weighbridge is a CONTROL, not the
 *      source of truth, so how the quantity was counted rides beside every
 *      quantity ("Counted by").
 *   2. VARIANCE IS A TREND, not a block. Moisture alone moves apparent density
 *      8–15% between a dry March morning and a wet October afternoon. Which is
 *      why it is drawn as a scatter of the whole day rather than as a per-load
 *      stop sign, and why a load past tolerance never holds its invoice — the
 *      signal worth having is the trend by driver, lane and loader operator.
 *   3. A RETURNED LOAD earns ₹0 and costs the full diesel, batta and toll. That
 *      is the number the business needs to see, so it is a tile.
 *   4. RATE OVERRIDDEN AT THE GATE is normal, not an exception — but nobody has
 *      ever counted it. Here it is counted. Until someone on the desk accepts
 *      it, the revenue on that load is asserted rather than agreed, which is
 *      why it is hatched.
 *
 * Clicking a row opens the TRIP COST SHEET: the one place the load's revenue
 * and its cash costs are put beside each other, because contribution per load
 * ("Profit" on screen) is the number a tipper business is actually run on and
 * nobody on this desk has ever been shown it.
 *
 * The e-way bill is not a dispatch stage: most intra-TN loads sit under the
 * ₹1,00,000 consignment threshold, so "Not needed" is the calm normal.
 */

type Lane = 'all' | Trip['status'] | 'own_use' | 'variance' | 'override' | 'unconfirmed' | 'unbilled';

const LANE_VIEWS: readonly Lane[] = [
  'all', 'planned', 'loaded', 'in_transit', 'delivered', 'completed', 'returned', 'cancelled',
  'own_use', 'variance', 'override', 'unconfirmed', 'unbilled',
];

/** The five working lanes, in the order a load moves through them. */
const LANES: Trip['status'][] = ['planned', 'loaded', 'in_transit', 'delivered', 'completed'];

/**
 * Lane tones for the proportion bar.
 *
 * The five working lanes take the monochrome ramp and DARKEN as the load moves
 * down the board, so the bar reads as progress the same way the row rail does
 * — a day that is stuck reads as a pale bar by four o'clock. Colour is spent
 * on the two outcomes that are not progress at all: a load that came back,
 * and a load that was called off.
 */
const LANE_TONE: Record<Trip['status'], string> = {
  planned: 'var(--chart-5)',
  loaded: 'var(--chart-4)',
  in_transit: 'var(--chart-3)',
  delivered: 'var(--chart-2)',
  completed: 'var(--chart-1)',
  returned: 'var(--status-critical)',
  cancelled: 'var(--status-dormant)',
};

/** What the coordinator moves the load to next. Nothing skips a lane. */
const NEXT_LANE: Partial<Record<Trip['status'], Trip['status']>> = {
  planned: 'loaded',
  loaded: 'in_transit',
  in_transit: 'delivered',
  delivered: 'completed',
};

/** The rail fills as the load moves down the lanes. */
const LANE_FILL: Record<Trip['status'], number> = {
  planned: 0.2,
  loaded: 0.4,
  in_transit: 0.6,
  delivered: 0.8,
  completed: 1,
  returned: 1,
  cancelled: 0,
};

const num = (v: string) => Number.parseFloat(v);
/** Cash out of the door ("Trip cost"). Tyre and depreciation are month-end absorptions. */
const cashCost = (t: Trip) => num(t.costDiesel) + num(t.costBatta) + num(t.costToll);
/**
 * own_use reduces stock and is NOT a sale — it must never read as unbilled
 * dispatch. A CANCELLED load is the same shape of fact from the other side: the
 * diesel and batta are already gone, and nothing will ever be billed for them.
 */
const isEarning = (t: Trip) => t.purpose === 'sale' && t.status !== 'cancelled';
const revenueOf = (t: Trip) => (isEarning(t) ? num(t.revenue) : 0);
const marginOf = (t: Trip) => (isEarning(t) ? num(t.margin) : -cashCost(t));
const vehicleOf = (t: Trip) => VEHICLES.find((v) => v.id === t.vehicleId);
const customerOf = (t: Trip) => CUSTOMERS_LIST.find((c) => c.id === t.customerId);
/** Material names (M-Sand, 20mm Aggregate) are the product's own names and are not translated. */
const productOf = (t: Trip) => PRODUCTS.find((p) => p.code === t.productCode)?.label ?? t.productCode;
const siteOf = (t: Trip) => SITES.find((s) => s.id === vehicleOf(t)?.siteId)?.name ?? null;

type StatusText = (typeof statusWords)['en'];

export function DispatchBoard() {
  const { persona, siteScope, density } = useApp();
  const isPhone = useIsPhone();
  const [lane, setLane] = useViewParam(LANE_VIEWS, 'all');
  const [customerFocus, setCustomerFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /** Keys are `${tripId}:wb` and `${tripId}:rate` — one set, two confirmations. */
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [moved, setMoved] = useState<Record<string, Trip['status']>>({});
  const [suggestionOpen, setSuggestionOpen] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const t = useWords(loadWords);
  const s = useWords(salesWords);
  const status = useWords(statusWords);
  const columns = useMemo(() => tripColumns(accepted, t, s, status), [accepted, t, s, status]);

  const mayWrite = can(persona.grants, 'sales.dispatch.write', { siteId: siteScope });
  const tol = DEFAULT_VARIANCE_TOLERANCE_PCT;

  const today = useMemo<Trip[]>(
    () =>
      TRIPS.filter((t) => (siteScope ? vehicleOf(t)?.siteId === siteScope : true)).map((t) => ({
        ...t,
        status: moved[t.id] ?? t.status,
      })),
    [siteScope, moved],
  );

  const returned = today.filter((t) => t.status === 'returned');
  const cancelledLoads = today.filter((t) => t.status === 'cancelled');
  const overridden = today.filter((t) => t.rateOverridden);
  // The same predicates the sales command board counts with, so a card's
  // number is the number of rows it opens onto.
  const unconfirmed = today.filter((t) => isDispatchUnconfirmed(t));
  const unbilled = today.filter(isUnbilledDispatch);
  const exceptions = today.filter((t) => t.variancePct !== null && isVarianceExceptional(t.variancePct));
  const unreviewed = exceptions.filter((t) => !accepted.has(`${t.id}:wb`));
  const outUnits = today
    .filter((t) => t.purpose === 'sale' && t.status !== 'planned' && t.status !== 'returned' && t.status !== 'cancelled')
    .reduce((s, t) => s + t.soldUnits, 0);
  const revenue = today.reduce((s, t) => s + revenueOf(t), 0);
  const margin = today.reduce((s, t) => s + marginOf(t), 0);
  const returnedCost = returned.reduce((s, t) => s + cashCost(t), 0);
  const overriddenUnits = overridden.reduce((s, t) => s + t.soldUnits, 0);

  /** Loads by lane — the shape of the day in one bar. */
  const laneSegments = useMemo(() => {
    const order: Trip['status'][] = ['planned', 'loaded', 'in_transit', 'delivered', 'completed', 'returned', 'cancelled'];
    return order
      .map((st) => ({ label: status.trip[st], value: today.filter((t) => t.status === st).length, tone: LANE_TONE[st] }))
      .filter((seg) => seg.value > 0);
  }, [today, status]);

  /**
   * Contribution per customer, for today only.
   *
   * own-use loads are left out on purpose: they were never meant to earn, and
   * putting their diesel against a customer name invents a loss-making customer
   * out of an internal movement.
   */
  const byCustomer = useMemo(() => {
    const map = new Map<string, { id: string; name: string; contribution: number; loads: number }>();
    for (const t of today) {
      if (t.purpose !== 'sale') continue;
      const entry = map.get(t.customerId) ?? {
        id: t.customerId,
        name: customerOf(t)?.name ?? t.customerId,
        contribution: 0,
        loads: 0,
      };
      entry.contribution += marginOf(t);
      entry.loads += 1;
      map.set(t.customerId, entry);
    }
    return [...map.values()].sort((a, b) => a.contribution - b.contribution);
  }, [today]);

  const lossMakers = byCustomer.filter((c) => c.contribution < 0);
  const bestCustomer = byCustomer[byCustomer.length - 1];
  const customerBars = byCustomer.map((c) => ({
    label: shortName(c.name),
    value: Math.round(c.contribution),
    sublabel: t.loadsN(c.loads),
    tone: c.contribution < 0 ? 'var(--status-attention)' : 'var(--chart-2)',
    ...(lossMakers.length > 0 ? { marker: 0 } : {}),
  }));

  const variancePoints = useMemo(
    () =>
      today
        .filter((t) => t.variancePct !== null && t.status !== 'cancelled')
        .map((t) => ({
          x: t.soldUnits,
          y: t.variancePct as number,
          label: t.tripNumber.slice(-4),
          ...(isVarianceExceptional(t.variancePct as number) ? { flagged: true } : {}),
        })),
    [today],
  );

  const rows = useMemo(() => {
    const laneRows =
      lane === 'all'
        ? today
        : lane === 'own_use'
          ? today.filter((t) => t.purpose !== 'sale')
          : lane === 'override'
            ? today.filter((t) => t.rateOverridden)
            : lane === 'variance'
              ? today.filter((t) => t.variancePct !== null && isVarianceExceptional(t.variancePct))
              : lane === 'unconfirmed'
                ? today.filter((t) => isDispatchUnconfirmed(t))
                : lane === 'unbilled'
                  ? today.filter(isUnbilledDispatch)
                  : today.filter((t) => t.status === lane);
    return customerFocus ? laneRows.filter((t) => t.customerId === customerFocus) : laneRows;
  }, [today, lane, customerFocus]);

  const sel = selected ? today.find((t) => t.id === selected) : undefined;
  const next = sel ? NEXT_LANE[sel.status] : undefined;
  const confirm = (key: string) => setAccepted((prev) => new Set(prev).add(key));
  /** The two acceptances this desk owes on the open load, if any. */
  const owesReading = sel !== undefined && sel.weighedTonnes !== null && !accepted.has(`${sel.id}:wb`);
  const owesRate = sel !== undefined && sel.rateOverridden && !accepted.has(`${sel.id}:rate`);
  const focusedName = customerFocus ? CUSTOMERS_LIST.find((c) => c.id === customerFocus)?.name : undefined;

  return (
    <>
      <PageHeader
        eyebrow={s.eyebrow}
        title={t.title}
        meta={
          <span className="flex flex-wrap items-center gap-4">
            {/* From v_dispatch_today. */}
            <AsOfStamp asOf="14:42" source={s.src.loads} freshness="live" />
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {t.loadsToday(today.length)}
            </span>
          </span>
        }
        actions={
          <>
            <Chip active>{t.today}</Chip>
            <Chip>{t.yesterday}</Chip>
          </>
        }
      />

      {/* Every delta on this row is a short line, not a percentage — two of
          them side by side at 375px wrap and the tile stops reading as a
          number with a note under it. One per row below `sm`; the hairline
          that separated them moves from the right edge to the bottom. */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        {/* Sold quantity, not weighed quantity — that is what this trade
            settles on. The unit rides in the label so the hero figure is a
            bare number: "135.6 யூனிட்" at hero size wrapped in a quarter-width tile. */}
        <KpiTile
          eyebrow={t.sentOut}
          hero
          value={formatQty(outUnits, 1)}
          delta={{ text: t.soldNotWeight }}
          asOf="14:42"
          source={s.src.loads}
        />
        {/* Contribution after material, diesel, batta and toll (v_trip_margin). */}
        <KpiTile
          eyebrow={t.salesToday}
          value={formatINRCompact(revenue)}
          delta={{ text: margin < 0 ? t.loss(formatINRCompact(-margin)) : t.profit(formatINRCompact(margin)) }}
          asOf="14:42"
          source={s.src.loads}
        />
        {/* Zero revenue, full cost. The tile exists so the number is unavoidable (v_trip_returns). */}
        <KpiTile
          eyebrow={t.returnedLoads}
          value={`${returned.length}`}
          delta={{
            text: t.spentNothingEarned(formatINRCompact(returnedCost)),
            tone: returned.length > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source={s.src.loads}
        />
        {/* Normal, not exceptional — and until now, never counted anywhere.
            Units settled below the rate card (v_rate_override_daily). */}
        <KpiTile
          eyebrow={t.rateChangedAtGate}
          value={t.loadsN(overridden.length)}
          delta={{
            text: t.belowRate(formatQty(overriddenUnits, 1)),
            tone: overridden.length > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source={s.src.loads}
          freshness="materialised"
        />
      </TileRow>

      {/* One "Updated" stamp for the board, in the header — the lanes come
          from the same source and no longer repeat it. */}
      <Section title={t.whereNow}>
        <div className="flex flex-wrap gap-3 px-6">
          {LANES.map((key) => {
            const list = today.filter((t) => t.status === key);
            return (
              <LaneCard
                key={key}
                status={key}
                label={status.trip[key]}
                count={list.length}
                units={list.reduce((s, t) => s + t.soldUnits, 0)}
                onClick={() => setLane(key)}
              />
            );
          })}
          <LaneCard
            status="returned"
            label={status.trip.returned}
            count={returned.length}
            units={returned.reduce((s, t) => s + t.soldUnits, 0)}
            onClick={() => setLane('returned')}
          />
          {cancelledLoads.length > 0 ? (
            <LaneCard
              status="cancelled"
              label={status.trip.cancelled}
              count={cancelledLoads.length}
              units={cancelledLoads.reduce((s, t) => s + t.soldUnits, 0)}
              onClick={() => setLane('cancelled')}
            />
          ) : null}
        </div>

        <div className="mt-5 px-6">
          <ProportionBar
            height={26}
            summary={t.barSummary(today.length, laneSegments.map((seg) => `${seg.label} ${seg.value}`).join(', '))}
            segments={laneSegments}
          />
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-x-4 xl:grid-cols-2">
        <Section caption={t.todayAfterCosts} title={t.profitByCustomer}>
          <div className="px-6">
            {byCustomer.length === 0 ? (
              // Every load on the board so far is own use or still planned.
              <EmptyState fact={t.noSaleLoads} />
            ) : (
              <>
                {/* The customer name IS the label here and SVG text does not
                    wrap: squeezed to 327px the 186px name gutter leaves ~75px
                    of bar. So the chart keeps its drawing width and scrolls
                    inside its own box. Inert above 460px — no scrollbar on a
                    desk. Names are trimmed to fit the gutter (shortName). */}
                <div className="-mx-6 overflow-x-auto px-6">
                  <div className="min-w-[460px]">
                    <BarChart
                      summary={
                        lossMakers.length > 0
                          ? t.lossSummary(
                              lossMakers.length,
                              byCustomer.length,
                              lossMakers[0]?.name ?? '',
                              formatINRCompact(lossMakers[0]?.contribution ?? 0),
                            )
                          : t.profitSummary(bestCustomer?.name ?? '', formatINRCompact(bestCustomer?.contribution ?? 0))
                      }
                      labelWidth={186}
                      format={(v) => formatINRCompact(v)}
                      data={customerBars}
                      onSelect={(d) => {
                        // Matched by position, not by label — two names can share
                        // their first characters and must not share a filter.
                        const idx = customerBars.findIndex((b) => b === d);
                        const hit = idx >= 0 ? byCustomer[idx] : undefined;
                        setCustomerFocus((prev) => (hit && prev !== hit.id ? hit.id : null));
                      }}
                    />
                  </div>
                </div>
                {/* Worst first, and the dashed tick is zero. A long haul settled
                    at a gate rate can cost more in diesel and batta than the
                    load earns. Own-use loads are left out; they were never
                    meant to earn. */}
                <ChartCaption>{t.tapForLoads}</ChartCaption>
              </>
            )}
          </div>
        </Section>

        <Section caption={t.weighbridgeVsSold} title={t.weightDiff}>
          <div className="px-6">
            {variancePoints.length === 0 ? (
              // These loads all settled on agreed units or bucket count.
              <EmptyState fact={t.nothingWeighed} />
            ) : (
              <>
                {/* The scatter drops any trip number that will not fit beside
                    its dot, so a 327px plot silently loses the trip numbers on
                    the flagged loads. It gets a drawing floor instead. */}
                <div className="-mx-6 overflow-x-auto px-6">
                  <div className="min-w-[420px]">
                    <ScatterPlot
                      points={variancePoints}
                      summary={t.scatterSummary(variancePoints.filter((p) => p.flagged).length, variancePoints.length, tol)}
                      xLabel={t.unitsSold}
                      yLabel={t.diffPct}
                      height={236}
                      format={(v) => `${formatQty(v, 0)}%`}
                    />
                  </div>
                </div>
                {/* A cloud sitting evenly either side of zero is a healthy
                    loader. A cloud that drifts one way all day is a calibration
                    or a bucket-count habit, and that is a conversation with one
                    operator rather than twenty invoices held up. */}
                <ChartCaption>{t.loaderHint}</ChartCaption>
              </>
            )}
          </div>
        </Section>
      </div>

      {/* Eleven lane filters wrap to five rows at 375px and push the table a
          whole screen down. Below `md` they become one horizontally scrolling
          row — the shell's own section strip behaves the same way, so the
          gesture is already learned. On a desk there is room to wrap. */}
      <div
        id="list"
        className="mt-7 flex items-center gap-2 overflow-x-auto px-6 pb-3 [&>*]:shrink-0 [&>*]:whitespace-nowrap md:flex-wrap md:overflow-visible"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Chip active={lane === 'all'} onClick={() => setLane('all')} count={today.length}>
          {s.all}
        </Chip>
        {LANES.map((key) => (
          <Chip key={key} active={lane === key} onClick={() => setLane(key)} count={today.filter((t) => t.status === key).length}>
            {status.trip[key]}
          </Chip>
        ))}
        <Chip active={lane === 'returned'} onClick={() => setLane('returned')} count={returned.length}>
          {status.trip.returned}
        </Chip>
        {cancelledLoads.length > 0 ? (
          <Chip active={lane === 'cancelled'} onClick={() => setLane('cancelled')} count={cancelledLoads.length}>
            {status.trip.cancelled}
          </Chip>
        ) : null}
        <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-strong)' }} />
        {/* Loaded but not confirmed out, or planned and past its slot. */}
        <Chip active={lane === 'unconfirmed'} onClick={() => setLane('unconfirmed')} count={unconfirmed.length}>
          {t.notOut}
        </Chip>
        {/* Gone out for a credit customer with no invoice raised. */}
        <Chip active={lane === 'unbilled'} onClick={() => setLane('unbilled')} count={unbilled.length}>
          {t.toInvoice}
        </Chip>
        <Chip active={lane === 'override'} onClick={() => setLane('override')} count={overridden.length}>
          {t.rateChanged}
        </Chip>
        {/* Weighed more than ±tolerance away from the quantity sold. */}
        <Chip active={lane === 'variance'} onClick={() => setLane('variance')} count={exceptions.length}>
          {t.weightOff}
        </Chip>
        <Chip active={lane === 'own_use'} onClick={() => setLane('own_use')} count={today.filter((t) => t.purpose !== 'sale').length}>
          {t.ownUse}
        </Chip>
        {focusedName ? (
          <>
            <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-strong)' }} />
            <Chip active onClick={() => setCustomerFocus(null)}>
              {focusedName} ×
            </Chip>
          </>
        ) : null}
      </div>

      {/* Exceptions to look at, not blocked invoices. */}
      {suggestionOpen && unreviewed.length > 0 ? (
        <div className="px-6 pt-4">
          <SuggestionStrip onApply={() => setLane('variance')} onDismiss={() => setSuggestionOpen(false)} applyLabel={t.showThem}>
            {t.weightOffN(unreviewed.length, tol)}
          </SuggestionStrip>
        </div>
      ) : null}

      {/* On a phone the hint drops below the heading and gets the full
          measure, rather than sharing a row with it. */}
      <Section
        title={t.loadsTodayTitle}
        actions={
          isPhone ? null : (
            <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {t.openForCost}
            </span>
          )
        }
      >
        {isPhone ? (
          <p className="font-serif px-6 pb-2 text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
            {t.openForCost}
          </p>
        ) : null}
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          selectedKey={selected}
          onRowClick={(t) => setSelected(t.id === selected ? undefined : t.id)}
          // Own-use loads move stock and bill nobody. The hatch keeps them from
          // ever being mistaken for dispatch that someone forgot to invoice.
          // A cancelled load is hatched for the same reason.
          isDormant={(t) => t.purpose !== 'sale' || t.status === 'cancelled'}
          rail={(t) => ({ status: TRIP_STATUS_FAMILY[t.status], fillRatio: LANE_FILL[t.status] })}
          empty={
            <EmptyState
              fact={t.noLoadsHere}
              action={{
                label: t.showAllLoads,
                onClick: () => {
                  setLane('all');
                  setCustomerFocus(null);
                },
              }}
            />
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={sel !== undefined}
        onClose={() => setSelected(undefined)}
        width="form"
        title={sel ? (customerOf(sel)?.name ?? sel.customerId) : ''}
        identifier={sel?.tripNumber}
        {...(sel
          ? {
              status: {
                family: TRIP_STATUS_FAMILY[sel.status],
                label: status.trip[sel.status],
                ...(sel.rateOverridden && !accepted.has(`${sel.id}:rate`) ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={sel ? `${vehicleOf(sel)?.displayReg ?? t.noVehicle} · ${formatTime(sel.date)}` : undefined}
        footer={
          sel ? (
            !mayWrite ? (
              // Only the sales desk moves loads and accepts readings.
              <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {t.viewOnly}
              </span>
            ) : (
              <>
                {next ? (
                  <Button variant="primary" onClick={() => setMoved((m) => ({ ...m, [sel.id]: next }))}>
                    {t.markAs(status.trip[next])}
                  </Button>
                ) : null}
                {/* The footer keeps the two actions that move the load. The two
                    ACCEPTANCES sit at the top of the sheet instead — four
                    buttons in one 56px footer became four two-line labels
                    spilling over the rule, on a phone and in Tamil alike. */}
                {sel.status !== 'completed' && sel.status !== 'cancelled' ? (
                  <span className="ml-auto shrink-0">
                    {/* Never split: on a narrow phone the longer label beside
                        it takes the second line instead. */}
                    <Button variant="destructive" className="whitespace-nowrap" onClick={() => setCancelOpen(true)}>
                      {t.cancelLoad}
                    </Button>
                  </span>
                ) : null}
              </>
            )
          ) : null
        }
      >
        {sel ? (
          <>
            {/* What this desk owes on the load, each button naming the value it
                accepts: the weighbridge reading, and the rate set at the gate. */}
            {mayWrite && (owesReading || owesRate) ? (
              <SheetSection caption={t.waitingForYou}>
                <div className="flex flex-wrap gap-2 pt-1">
                  {owesReading && sel.weighedTonnes !== null ? (
                    <Button onClick={() => confirm(`${sel.id}:wb`)}>
                      {t.weightOk(`${formatQty(sel.weighedTonnes, 1)} ${s.tonnes}`)}
                    </Button>
                  ) : null}
                  {owesRate ? (
                    <Button onClick={() => confirm(`${sel.id}:rate`)}>
                      {t.rateOk(formatINR(sel.ratePerUnit, { decimals: 0 }))}
                    </Button>
                  ) : null}
                </div>
              </SheetSection>
            ) : null}
            <TripCostSheet trip={sel} accepted={accepted} />
          </>
        ) : null}
      </SideSheet>

      {/* Cancelling is the one action here that cannot be taken back, and the
          cost it strands is already spent — so the modal names the rupees
          rather than asking whether the operator is sure. The cost stays on
          the day, nobody is billed for it, and the units go back to stock. */}
      <ConfirmModal
        open={cancelOpen && sel !== undefined}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => {
          if (sel) setMoved((m) => ({ ...m, [sel.id]: 'cancelled' }));
        }}
        title={t.cancelTitle}
        confirmLabel={t.cancelYes}
        destructive
        consequence={
          sel
            ? t.cancelWhat(
                sel.tripNumber,
                formatINRCompact(cashCost(sel)),
                formatQty(sel.soldUnits, 1),
                sel.status === 'in_transit' || sel.status === 'delivered',
              )
            : null
        }
      />
    </>
  );
}

function LaneCard({
  status,
  label,
  count,
  units,
  onClick,
}: {
  status: Trip['status'];
  label: string;
  count: number;
  units: number;
  onClick: () => void;
}) {
  const s = useWords(salesWords);
  return (
    <button
      type="button"
      onClick={onClick}
      // Two lanes to a row on a phone rather than one full-width slab each: a
      // 190px floor against a 327px content width leaves one card per line and
      // six lanes then run past the fold before the day's shape is visible.
      // `basis` rather than `min-w` so the card can go narrower than its floor.
      className="min-w-0 shrink grow basis-[calc(50%-0.375rem)] px-4 py-3 text-left sm:basis-[190px]"
      style={{ background: 'var(--surface)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)', borderRadius: 'var(--r-2)' }}
    >
      <StatusStamp status={TRIP_STATUS_FAMILY[status]} label={label} />
      <p className="num mt-2 text-[28px] leading-none tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {count}
      </p>
      <p className="num mt-1 text-[13px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {s.unitsN(formatQty(units, 1))}
      </p>
    </button>
  );
}

/**
 * THE TRIP COST SHEET.
 *
 * One load, with revenue and cash cost on the same page. The table can show a
 * contribution figure; only this can show WHERE it went — and for the two cases
 * that look like failures of billing but are not (a returned load, an own-use
 * load) it says so in words rather than leaving a ₹0 to be argued about.
 */
function TripCostSheet({ trip, accepted }: { trip: Trip; accepted: ReadonlySet<string> }) {
  // The detail grid is two columns wide everywhere, which is right for the
  // money block — eight short figures read as a column of numbers. It is wrong
  // for the fields whose value is a phrase: at 375px each column is about
  // 155px. Those fields take the full measure on a phone instead.
  const phone = useIsPhone();
  const t = useWords(loadWords);
  const s = useWords(salesWords);
  const status = useWords(statusWords);
  const revenue = revenueOf(trip);
  const contribution = marginOf(trip);
  const material = num(trip.materialCost);
  const diesel = num(trip.costDiesel);
  const batta = num(trip.costBatta);
  const toll = num(trip.costToll);
  const cash = cashCost(trip);
  const driver = DRIVERS.find((d) => d.id === trip.driverId);
  const wbAccepted = accepted.has(`${trip.id}:wb`);
  const rateAccepted = accepted.has(`${trip.id}:rate`);
  const exceptional = trip.variancePct !== null && isVarianceExceptional(trip.variancePct);
  // Material and cash cost together, per unit carried.
  const perUnitCost = trip.soldUnits > 0 ? (material + cash) / trip.soldUnits : null;

  const segments = [
    { label: s.material, value: material, tone: 'var(--chart-1)' },
    { label: t.diesel, value: diesel, tone: 'var(--chart-2)' },
    { label: t.batta, value: batta, tone: 'var(--chart-3)' },
    { label: t.toll, value: toll, tone: 'var(--chart-4)' },
    ...(contribution > 0 ? [{ label: t.profitCol, value: contribution, tone: 'var(--status-ready)' }] : []),
  ].filter((seg) => seg.value > 0);

  return (
    <>
      <SheetSection caption={t.load}>
        <DetailGrid>
          <Detail label={t.deliverTo} wide={phone}>
            {trip.customerSite}
          </Detail>
          <Detail label={t.loadedAt}>{siteOf(trip) ?? t.notNoted}</Detail>
          <Detail label={s.material}>{productOf(trip)}</Detail>
          <Detail label={t.vehicleDriver} wide={phone}>
            <IdCell>{vehicleOf(trip)?.displayReg ?? t.noVehicle}</IdCell>
            {` · ${driver ? driver.name : t.noDriver}`}
          </Detail>
          <Detail label={s.sold}>
            <QuantityCell value={trip.soldUnits} decimals={1} uom={s.units} />
          </Detail>
          {/* How the quantity was counted decides how much argument it will take. */}
          <Detail label={s.countedBy} wide={phone}>
            {s.basis[trip.qtyBasis]}
          </Detail>
          <Detail label={t.weight}>
            {trip.weighedTonnes === null ? (
              t.notWeighed
            ) : (
              <Provisional confirmed={wbAccepted}>
                <QuantityCell value={trip.weighedTonnes} decimals={1} uom={s.tonnes} />
              </Provisional>
            )}
          </Detail>
          <Detail label={t.difference}>
            {trip.variancePct === null ? (
              '–'
            ) : (
              <span style={{ color: exceptional ? 'var(--status-attention)' : undefined }}>
                {trip.variancePct > 0 ? '+' : ''}
                {formatQty(trip.variancePct, 1)}%
              </span>
            )}
          </Detail>
          <Detail label={t.distance}>
            <QuantityCell value={trip.distanceKm} decimals={1} uom={s.km} />
          </Detail>
          <Detail label={t.bookedAt}>{formatTime(trip.date)}</Detail>
        </DetailGrid>
        {/* Past tolerance: add it to the trend against this driver and this
            loader operator — never a reason to hold the invoice. What the
            customer agreed to pay on is the "Counted by" quantity. */}
        {exceptional ? <Note>{t.weightOffNote(DEFAULT_VARIANCE_TOLERANCE_PCT)}</Note> : null}
      </SheetSection>

      <SheetSection caption={t.earnedSpent}>
        <DetailGrid>
          <Detail label={t.ratePerUnit}>
            {trip.rateOverridden ? (
              <Provisional confirmed={rateAccepted} overridden>
                <MoneyCell value={trip.ratePerUnit} accounting={false} decimals={0} />
              </Provisional>
            ) : (
              <MoneyCell value={trip.ratePerUnit} accounting={false} decimals={0} />
            )}
          </Detail>
          <Detail label={t.sale}>
            <MoneyCell value={revenue} accounting={false} decimals={0} />
          </Detail>
          <Detail label={t.materialCost}>
            <MoneyCell value={material} accounting={false} decimals={0} />
          </Detail>
          <Detail label={t.diesel}>
            <MoneyCell value={diesel} accounting={false} decimals={0} />
          </Detail>
          <Detail label={t.driverBatta}>
            <MoneyCell value={batta} accounting={false} decimals={0} />
          </Detail>
          <Detail label={t.toll}>
            <MoneyCell value={toll} accounting={false} decimals={0} />
          </Detail>
          {/* Cash out of the door: diesel, batta and toll. */}
          <Detail label={t.tripCost}>
            <MoneyCell value={cash} accounting={false} decimals={0} />
          </Detail>
          <Detail label={t.profitCol}>
            <MoneyCell value={contribution} decimals={0} />
          </Detail>
          <Detail label={t.costPerUnit} wide>
            {perUnitCost === null ? t.noQuantity : <MoneyCell value={perUnitCost} accounting={false} decimals={0} />}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.whereMoneyWent}>
        <ProportionBar
          height={26}
          summary={
            revenue > 0
              ? t.moneySummary(
                  formatINRCompact(revenue),
                  Math.round((material / Math.max(revenue, 1)) * 100),
                  Math.round((cash / Math.max(revenue, 1)) * 100),
                  formatINRCompact(contribution),
                )
              : t.nothingEarned(formatINRCompact(cash))
          }
          segments={segments}
        />
        {/* Tyres, maintenance and the EMI are absorbed at month end and are not
            in this bar — so a load that looks thin here is thinner still. */}
        <ChartCaption>{t.notIncluded}</ChartCaption>

        {/* Revenue is ₹0 — not pending, not unbilled — and the running cost is
            spent. The material never left stock; the loss is the running. */}
        {trip.status === 'returned' ? (
          <div className="mt-3">
            <Note>{t.returnedNote(formatINRCompact(cash))}</Note>
          </div>
        ) : null}

        {/* Called off from this board: the cost stays on today, the units go
            back to stock, and no invoice will ever carry this trip. */}
        {trip.status === 'cancelled' ? (
          <div className="mt-3">
            <Note>{t.cancelledNote(formatINRCompact(cash))}</Note>
          </div>
        ) : null}

        {/* Material moved to our own works. It earns nothing by design and must
            never be counted as dispatch somebody forgot to invoice. */}
        {trip.purpose !== 'sale' ? (
          <div className="mt-3">
            <Note>{t.ownUseNote}</Note>
          </div>
        ) : null}

        {/* A gate override is ordinary in this trade and not an error — but
            until someone on this desk accepts it, the revenue is asserted
            rather than agreed, which is why it is hatched. */}
        {trip.rateOverridden ? (
          <div className="mt-3">
            <Note>{t.rateChangedNote(formatINR(trip.ratePerUnit, { decimals: 0 }), rateAccepted)}</Note>
          </div>
        ) : null}
      </SheetSection>

      <SheetSection caption={t.papers}>
        <DetailGrid>
          <Detail label={t.ewb} wide={phone}>
            {/* Under the ₹1,00,000 consignment threshold no e-way bill is needed. */}
            {!trip.ewbRequired ? (
              status.ewb.not_required
            ) : trip.ewbNumber ? (
              <IdCell>{trip.ewbNumber}</IdCell>
            ) : (
              <StatusStamp status="pending" label={status.ewb.to_generate} provisional />
            )}
          </Detail>
          <Detail label={t.invoice} wide={phone}>
            {trip.invoiceId ? <IdCell>{trip.invoiceId}</IdCell> : t.noInvoiceYet}
          </Detail>
        </DetailGrid>
      </SheetSection>
    </>
  );
}

function tripColumns(accepted: ReadonlySet<string>, t: LoadText, s: SalesText, status: StatusText): Column<Trip>[] {
  return [
    {
      key: 'trip',
      header: s.trip,
      type: 'id',
      sticky: true,
      width: 200,
      group: t.groups.trip,
      render: (trip) => (
        <Stacked
          primary={<IdCell>{trip.tripNumber}</IdCell>}
          secondary={`${formatTime(trip.date)} · ${vehicleOf(trip)?.displayReg ?? t.noVehicle}`}
        />
      ),
    },
    {
      key: 'status',
      header: s.status,
      type: 'status',
      width: 156,
      group: t.groups.trip,
      // A gate override is asserted revenue until someone accepts it. Dashed.
      render: (trip) => (
        <StatusStamp
          status={TRIP_STATUS_FAMILY[trip.status]}
          label={status.trip[trip.status]}
          provisional={trip.rateOverridden && !accepted.has(`${trip.id}:rate`)}
        />
      ),
    },
    {
      key: 'customer',
      header: s.customer,
      width: 220,
      group: t.groups.load,
      render: (trip) => (
        <Stacked
          primary={customerOf(trip)?.name ?? trip.customerId}
          // Own use moves stock to our own works; it is not a sale.
          secondary={trip.purpose === 'sale' ? trip.customerSite : `${trip.customerSite} · ${t.ownUse}`}
        />
      ),
    },
    {
      key: 'site',
      header: t.loadedAt,
      width: 160,
      group: t.groups.load,
      render: (trip) => siteOf(trip),
    },
    {
      key: 'product',
      header: s.material,
      width: 140,
      group: t.groups.load,
      render: (trip) => productOf(trip),
    },
    {
      key: 'sold',
      header: s.sold,
      unit: s.units,
      type: 'num',
      width: 110,
      group: t.groups.load,
      // What was SOLD is the primary number in this trade.
      render: (trip) => <QuantityCell value={trip.soldUnits} decimals={1} />,
    },
    {
      key: 'basis',
      header: s.countedBy,
      width: 170,
      group: t.groups.load,
      // The basis never hides: how the quantity was arrived at changes how
      // much argument it will take. It used to ride inside the Sold cell as a
      // mono code ("cust wb"); in words it needs its own column.
      render: (trip) => s.basis[trip.qtyBasis],
    },
    {
      key: 'weighed',
      header: t.weight,
      unit: s.tonnes,
      type: 'num',
      width: 132,
      group: t.groups.weight,
      render: (trip) =>
        trip.weighedTonnes === null ? null : (
          <Provisional confirmed={accepted.has(`${trip.id}:wb`)}>
            <QuantityCell value={trip.weighedTonnes} decimals={1} />
          </Provisional>
        ),
    },
    {
      key: 'variance',
      header: t.difference,
      unit: '%',
      type: 'num',
      width: 130,
      group: t.groups.weight,
      render: (trip) =>
        trip.variancePct === null ? null : (
          <span
            style={{
              // Spent only past tolerance, and even then it means "look", not "stop".
              color: isVarianceExceptional(trip.variancePct) ? 'var(--status-attention)' : undefined,
            }}
          >
            {trip.variancePct > 0 ? '+' : ''}
            {formatQty(trip.variancePct, 1)}
          </span>
        ),
    },
    {
      key: 'rate',
      header: s.rate,
      unit: '₹',
      type: 'money',
      width: 130,
      group: t.groups.money,
      render: (trip) =>
        trip.rateOverridden ? (
          <Provisional confirmed={accepted.has(`${trip.id}:rate`)} overridden>
            <MoneyCell value={trip.ratePerUnit} decimals={0} />
          </Provisional>
        ) : (
          <MoneyCell value={trip.ratePerUnit} decimals={0} />
        ),
    },
    {
      key: 'revenue',
      header: t.sale,
      unit: '₹',
      type: 'money',
      width: 140,
      group: t.groups.money,
      render: (trip) => <MoneyCell value={revenueOf(trip)} decimals={0} />,
    },
    {
      key: 'margin',
      header: t.profitCol,
      unit: '₹',
      type: 'money',
      width: 150,
      group: t.groups.money,
      render: (trip) => <MoneyCell value={marginOf(trip)} decimals={0} />,
    },
    {
      key: 'ewb',
      header: t.ewb,
      width: 190,
      render: (trip) => {
        // The calm default. A permanent alarm on loads that never needed a bill
        // teaches everyone to ignore the column that matters on the ones that do.
        if (!trip.ewbRequired) {
          return <span style={{ color: 'var(--text-tertiary)' }}>{status.ewb.not_required}</span>;
        }
        return trip.ewbNumber ? (
          <IdCell>{trip.ewbNumber}</IdCell>
        ) : (
          <StatusStamp status="pending" label={status.ewb.to_generate} provisional />
        );
      },
    },
  ];
}
