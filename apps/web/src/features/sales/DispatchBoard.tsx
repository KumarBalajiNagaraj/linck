import { useMemo, useState } from 'react';
import {
  can,
  DEFAULT_VARIANCE_TOLERANCE_PCT,
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
  TRIP_STATUS_LABEL,
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
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

/**
 * The delivery order and dispatch board.
 *
 * The sales coordinator takes orders on the phone from 6:30am, allots lorries
 * and then watches loads move. So the board is organised as LANES, not as a
 * trip list — and the four things this trade actually argues about are given
 * columns of their own rather than being buried in a drawer:
 *
 *   1. QUANTITY BASIS. `soldUnits` is the primary number — often settled by eye
 *      and by argument at the loader. The weighbridge is a CONTROL, not the
 *      source of truth, so the basis rides beside every quantity in mono.
 *   2. VARIANCE IS A TREND, not a block. Moisture alone moves apparent density
 *      8–15% between a dry March morning and a wet October afternoon. Which is
 *      why it is drawn as a scatter of the whole day rather than as a per-load
 *      stop sign.
 *   3. A RETURNED LOAD earns ₹0 and costs the full diesel, batta and toll. That
 *      is the number the business needs to see, so it is a tile.
 *   4. RATE OVERRIDDEN AT THE GATE is normal, not an exception — but nobody has
 *      ever counted it. Here it is counted.
 *
 * Clicking a row opens the TRIP COST SHEET: the one place the load's revenue
 * and its cash costs are put beside each other, because contribution per load
 * is the number a tipper business is actually run on and nobody on this desk
 * has ever been shown it.
 */

type Lane = 'all' | Trip['status'] | 'own_use' | 'variance' | 'override' | 'unconfirmed' | 'unbilled';

const LANE_VIEWS: readonly Lane[] = [
  'all', 'planned', 'loaded', 'in_transit', 'delivered', 'completed', 'returned', 'cancelled',
  'own_use', 'variance', 'override', 'unconfirmed', 'unbilled',
];

const BASIS_SHORT: Record<Trip['qtyBasis'], string> = {
  loader_buckets: 'buckets',
  plant_weighbridge: 'plant wb',
  customer_weighbridge: 'cust wb',
  agreed_units: 'agreed',
};

/** The same fact in words, for the cost sheet — how much argument it will take. */
const BASIS_LONG: Record<Trip['qtyBasis'], string> = {
  loader_buckets: 'Counted in loader buckets at the pit',
  plant_weighbridge: 'Weighed on our own weighbridge',
  customer_weighbridge: "Weighed on the customer's weighbridge",
  agreed_units: 'Agreed by number, never weighed',
};

const LANES: { key: Trip['status']; label: string; caption: string }[] = [
  { key: 'planned', label: 'Planned', caption: 'Order taken, lorry allotted' },
  { key: 'loaded', label: 'Loaded', caption: 'Under the chute or at the gate' },
  { key: 'in_transit', label: 'In transit', caption: 'On the road, not yet signed for' },
  { key: 'delivered', label: 'Delivered', caption: 'Signed for, paper pending' },
  { key: 'completed', label: 'Completed', caption: 'Closed against an invoice' },
];

/**
 * Lane tones for the proportion bar.
 *
 * The five working lanes take the monochrome ramp and DARKEN as the load moves
 * down the board, so the bar reads as progress the same way the row rail does.
 * Colour is spent on the two outcomes that are not progress at all: a load that
 * came back, and a load that was called off.
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
/** Cash out of the door. Tyre and depreciation are month-end absorptions. */
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
const productOf = (t: Trip) => PRODUCTS.find((p) => p.code === t.productCode)?.label ?? t.productCode;
const siteOf = (t: Trip) => SITES.find((s) => s.id === vehicleOf(t)?.siteId)?.name ?? null;

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

  const mayWrite = can(persona.grants, 'sales.dispatch.write', { siteId: siteScope });

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
      .map((s) => ({ label: TRIP_STATUS_LABEL[s], value: today.filter((t) => t.status === s).length, tone: LANE_TONE[s] }))
      .filter((s) => s.value > 0);
  }, [today]);

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
        eyebrow="Sales"
        title="Delivery order & dispatch"
        meta={
          <span className="flex flex-wrap items-center gap-4">
            <AsOfStamp asOf="14:42" source="v_dispatch_today" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {today.length} loads booked today · rate overridden on {overridden.length} of them
            </span>
          </span>
        }
        actions={
          <>
            <Chip active>Today</Chip>
            <Chip>Yesterday</Chip>
          </>
        }
      />

      {/* Every delta on this row is a sentence, not a percentage — two of them
          side by side at 375px wrap to four lines each and the tile stops
          reading as a number with a note under it. One per row below `sm`; the
          hairline that separated them moves from the right edge to the bottom. */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <KpiTile
          eyebrow="Out of the gate today"
          hero
          value={`${formatQty(outUnits, 1)} units`}
          delta={{ text: 'Sold quantity, not weighed quantity — that is what this trade settles on' }}
          asOf="14:42"
          source="v_dispatch_today"
        />
        <KpiTile
          eyebrow="Revenue booked"
          value={formatINRCompact(revenue)}
          delta={{ text: `${formatINRCompact(margin)} contribution after diesel, batta and toll` }}
          asOf="14:42"
          source="v_trip_margin"
        />
        {/* Zero revenue, full cost. The tile exists so the number is unavoidable. */}
        <KpiTile
          eyebrow="Loads returned"
          value={`${returned.length}`}
          delta={{
            text: `${formatINRCompact(returnedCost)} of diesel, batta and toll spent for ₹0 earned`,
            tone: returned.length > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source="v_trip_returns"
        />
        {/* Normal, not exceptional — and until now, never counted anywhere. */}
        <KpiTile
          eyebrow="Rate overridden at the gate"
          value={`${overridden.length} loads`}
          delta={{
            text: `${formatQty(overriddenUnits, 1)} units settled below the rate card`,
            tone: overridden.length > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_rate_override_daily"
          freshness="materialised"
        />
      </TileRow>

      {/* The stamp is a section action on a desk and a line of its own on a
          phone: at 375px it competes with the title for the same row and both
          end up wrapped to three lines. */}
      <Section
        caption="Where every load is right now"
        title="Lanes"
        actions={isPhone ? null : <AsOfStamp asOf="14:42" source="v_dispatch_today" />}
      >
        {isPhone ? (
          <div className="px-6 pb-2">
            <AsOfStamp asOf="14:42" source="v_dispatch_today" />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3 px-6">
          {LANES.map((l) => {
            const list = today.filter((t) => t.status === l.key);
            return (
              <LaneCard
                key={l.key}
                status={l.key}
                label={l.label}
                caption={l.caption}
                count={list.length}
                units={list.reduce((s, t) => s + t.soldUnits, 0)}
                onClick={() => setLane(l.key)}
              />
            );
          })}
          <LaneCard
            status="returned"
            label="Returned"
            caption="Came back loaded — nothing to bill"
            count={returned.length}
            units={returned.reduce((s, t) => s + t.soldUnits, 0)}
            onClick={() => setLane('returned')}
          />
          {cancelledLoads.length > 0 ? (
            <LaneCard
              status="cancelled"
              label="Cancelled"
              caption="Called off after the cost was already spent"
              count={cancelledLoads.length}
              units={cancelledLoads.reduce((s, t) => s + t.soldUnits, 0)}
              onClick={() => setLane('cancelled')}
            />
          ) : null}
        </div>

        <div className="mt-5 px-6">
          <ProportionBar
            height={26}
            summary={`${today.length} loads today: ${laneSegments
              .map((s) => `${s.value} ${s.label.toLowerCase()}`)
              .join(', ')}.`}
            segments={laneSegments}
          />
          <ChartCaption>
            The ramp darkens as a load moves down the board, so a day that is stuck reads as a pale bar by four
            o&rsquo;clock. Only the two outcomes that earn nothing — returned and cancelled — spend a colour.
          </ChartCaption>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-x-4 xl:grid-cols-2">
        <Section caption="After diesel, batta and toll — today only" title="Contribution by customer">
          <div className="px-6">
            {byCustomer.length === 0 ? (
              <EmptyState
                fact="No billable loads today."
                because="Every load on the board so far is own use or still planned."
              />
            ) : (
              <>
                {/* The customer name IS the label here and SVG text does not
                    wrap: squeezed to 327px the 186px name gutter leaves ~75px
                    of bar and the names run off their own left edge. So the
                    chart keeps its drawing width and scrolls inside its own
                    box. Inert above 460px — no scrollbar on a desk. */}
                <div className="-mx-6 overflow-x-auto px-6">
                  <div className="min-w-[460px]">
                    <BarChart
                      summary={
                        lossMakers.length > 0
                          ? `${lossMakers.length} of ${byCustomer.length} customers are below zero today, worst is ${
                              lossMakers[0]?.name ?? ''
                            } at ${formatINRCompact(lossMakers[0]?.contribution ?? 0)}.`
                          : `Every customer contributed today; ${bestCustomer?.name ?? ''} led at ${formatINRCompact(
                              bestCustomer?.contribution ?? 0,
                            )}.`
                      }
                      labelWidth={186}
                      format={(v) => formatINRCompact(v)}
                      data={byCustomer.map((c) => ({
                        label: c.name,
                        value: Math.round(c.contribution),
                        sublabel: `${c.loads} loads`,
                        tone: c.contribution < 0 ? 'var(--status-attention)' : 'var(--chart-2)',
                        ...(lossMakers.length > 0 ? { marker: 0 } : {}),
                      }))}
                      onSelect={(d) => {
                        const hit = byCustomer.find((c) => c.name === d.label);
                        setCustomerFocus((prev) => (hit && prev !== hit.id ? hit.id : null));
                      }}
                    />
                  </div>
                </div>
                <ChartCaption>
                  Worst lane first, and the dashed tick is zero. A long haul settled at a gate rate can cost more in
                  diesel and batta than the load earns — click a bar to pull that customer&rsquo;s loads into the
                  table below. Own-use loads are left out; they were never meant to earn.
                </ChartCaption>
              </>
            )}
          </div>
        </Section>

        <Section caption="Weighbridge against what was sold" title="Variance is a trend">
          <div className="px-6">
            {variancePoints.length === 0 ? (
              <EmptyState fact="Nothing has been weighed today." because="These loads all settled on agreed units or bucket count." />
            ) : (
              <>
                {/* The scatter drops any trip number that will not fit beside
                    its dot, so a 327px plot silently keeps the promise the
                    caption makes — "flagged loads carry their trip number" —
                    for about two of them. It gets a drawing floor instead. */}
                <div className="-mx-6 overflow-x-auto px-6">
                  <div className="min-w-[420px]">
                    <ScatterPlot
                      points={variancePoints}
                      summary={`${variancePoints.filter((p) => p.flagged).length} of ${
                        variancePoints.length
                      } weighed loads sit beyond ±${DEFAULT_VARIANCE_TOLERANCE_PCT}% of the quantity sold.`}
                      xLabel="units sold"
                      yLabel="variance %"
                      height={236}
                      format={(v) => `${formatQty(v, 0)}%`}
                    />
                  </div>
                </div>
                <ChartCaption>
                  A cloud sitting evenly either side of zero is a healthy loader. A cloud that drifts one way all day
                  is a calibration or a bucket-count habit, and that is a conversation with one operator rather than
                  twenty invoices held up. Flagged loads carry their trip number.
                </ChartCaption>
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
        className="mt-7 flex items-center gap-2 overflow-x-auto px-6 pb-3 [&>*]:shrink-0 [&>*]:whitespace-nowrap md:flex-wrap md:overflow-visible"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Chip active={lane === 'all'} onClick={() => setLane('all')} count={today.length}>
          All loads
        </Chip>
        {LANES.map((l) => (
          <Chip
            key={l.key}
            active={lane === l.key}
            onClick={() => setLane(l.key)}
            count={today.filter((t) => t.status === l.key).length}
          >
            {l.label}
          </Chip>
        ))}
        <Chip active={lane === 'returned'} onClick={() => setLane('returned')} count={returned.length}>
          Returned
        </Chip>
        {cancelledLoads.length > 0 ? (
          <Chip active={lane === 'cancelled'} onClick={() => setLane('cancelled')} count={cancelledLoads.length}>
            Cancelled
          </Chip>
        ) : null}
        <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-strong)' }} />
        <Chip active={lane === 'unconfirmed'} onClick={() => setLane('unconfirmed')} count={unconfirmed.length}>
          Unconfirmed or delayed
        </Chip>
        <Chip active={lane === 'unbilled'} onClick={() => setLane('unbilled')} count={unbilled.length}>
          Not yet invoiced
        </Chip>
        <Chip active={lane === 'override'} onClick={() => setLane('override')} count={overridden.length}>
          Rate overridden
        </Chip>
        <Chip active={lane === 'variance'} onClick={() => setLane('variance')} count={exceptions.length}>
          Beyond ±{DEFAULT_VARIANCE_TOLERANCE_PCT}%
        </Chip>
        <Chip
          active={lane === 'own_use'}
          onClick={() => setLane('own_use')}
          count={today.filter((t) => t.purpose !== 'sale').length}
        >
          Own use
        </Chip>
        {focusedName ? (
          <>
            <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-strong)' }} />
            <Chip active onClick={() => setCustomerFocus(null)}>
              {focusedName} only — clear
            </Chip>
          </>
        ) : null}
      </div>

      {suggestionOpen && unreviewed.length > 0 ? (
        <div className="px-6 pt-4">
          <SuggestionStrip
            onApply={() => setLane('variance')}
            onDismiss={() => setSuggestionOpen(false)}
            applyLabel="Review them"
          >
            {unreviewed.length} loads weighed more than ±{DEFAULT_VARIANCE_TOLERANCE_PCT}% away from the quantity sold.
            These are exceptions to look at, not blocked invoices — moisture alone moves apparent density 8–15% between a
            dry March morning and a wet October afternoon. The signal worth having is the trend by driver, lane and loader
            operator.
          </SuggestionStrip>
        </div>
      ) : null}

      {/* That caption is a long sentence and the hint beside it is another one.
          Sharing a row at 375px leaves each of them a column about eleven
          characters wide, so on a phone the hint drops below the heading and
          gets the full measure. Nothing is lost, it just stops being an
          action. */}
      <Section
        caption="E-way bill is not a dispatch stage — most intra-TN loads sit under the ₹1,00,000 consignment threshold"
        title="Every load booked today"
        actions={
          isPhone ? null : (
            <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              Open a load for its cost sheet
            </span>
          )
        }
      >
        {isPhone ? (
          <p className="font-serif px-6 pb-2 text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
            Open a load for its cost sheet
          </p>
        ) : null}
        <DataTable
          density={density}
          columns={tripColumns(accepted)}
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
              fact="No loads in this lane."
              because="Either the coordinator has not allotted them yet, or they have already moved on."
              action={{
                label: 'Show every load today',
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
                label: TRIP_STATUS_LABEL[sel.status],
                ...(sel.rateOverridden && !accepted.has(`${sel.id}:rate`) ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={sel ? `${vehicleOf(sel)?.displayReg ?? 'NO LORRY'} · ${formatTime(sel.date)}` : undefined}
        footer={
          sel ? (
            !mayWrite ? (
              <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                Read-only for {persona.roleLabel} — the sales desk moves loads and accepts readings
              </span>
            ) : (
              <>
                {next ? (
                  <Button variant="primary" onClick={() => setMoved((m) => ({ ...m, [sel.id]: next }))}>
                    Move to {TRIP_STATUS_LABEL[next].toLowerCase()}
                  </Button>
                ) : null}
                {/* Four buttons in a 56px footer at 375px is not a row, it is
                    four two-line labels spilling over the rule. So on a phone
                    the two ACCEPTANCES move up into the sheet, beside the
                    reading and the rate they are about, and the footer keeps
                    the two actions that move the load. Nothing is dropped. */}
                {!isPhone && owesReading ? (
                  <Button onClick={() => confirm(`${sel.id}:wb`)}>Accept the reading</Button>
                ) : null}
                {!isPhone && owesRate ? (
                  <Button onClick={() => confirm(`${sel.id}:rate`)}>Accept the gate rate</Button>
                ) : null}
                {sel.status !== 'completed' && sel.status !== 'cancelled' ? (
                  <span className="ml-auto">
                    <Button variant="destructive" onClick={() => setCancelOpen(true)}>
                      Cancel load
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
            {isPhone && mayWrite && (owesReading || owesRate) ? (
              <SheetSection caption="Waiting on this desk">
                <div className="flex flex-wrap gap-2 pt-1">
                  {owesReading ? <Button onClick={() => confirm(`${sel.id}:wb`)}>Accept the reading</Button> : null}
                  {owesRate ? <Button onClick={() => confirm(`${sel.id}:rate`)}>Accept the gate rate</Button> : null}
                </div>
              </SheetSection>
            ) : null}
            <TripCostSheet trip={sel} accepted={accepted} />
          </>
        ) : null}
      </SideSheet>

      {/* Cancelling is the one action here that cannot be taken back, and the
          cost it strands is already spent — so the modal names the rupees
          rather than asking whether the operator is sure. */}
      <ConfirmModal
        open={cancelOpen && sel !== undefined}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => {
          if (sel) setMoved((m) => ({ ...m, [sel.id]: 'cancelled' }));
        }}
        title="Cancel this load"
        confirmLabel="Cancel the load"
        destructive
        consequence={
          sel ? (
            <>
              {sel.tripNumber} has already burned {formatINRCompact(cashCost(sel))} of diesel, batta and toll
              {sel.status === 'in_transit' || sel.status === 'delivered' ? ' and the lorry is already out' : ''}. Cancelling
              keeps that cost on the day and bills nobody for it, and the {formatQty(sel.soldUnits, 1)} units go back to
              stock. It cannot be undone from this board.
            </>
          ) : null
        }
      />
    </>
  );
}

function LaneCard({
  status,
  label,
  caption,
  count,
  units,
  onClick,
}: {
  status: Trip['status'];
  label: string;
  caption: string;
  count: number;
  units: number;
  onClick: () => void;
}) {
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
      <p className="num mt-1 text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {formatQty(units, 1)} units
      </p>
      <p className="mt-1 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {caption}
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
  // for the fields whose value is a SENTENCE: at 375px each column is about
  // 155px, and "Counted in loader buckets at the pit" becomes a three-line
  // stack next to a one-line neighbour. Those fields take the full measure on a
  // phone instead.
  const phone = useIsPhone();
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
  const perUnitCost = trip.soldUnits > 0 ? (material + cash) / trip.soldUnits : null;

  const segments = [
    { label: 'Material', value: material, tone: 'var(--chart-1)' },
    { label: 'Diesel', value: diesel, tone: 'var(--chart-2)' },
    { label: 'Batta', value: batta, tone: 'var(--chart-3)' },
    { label: 'Toll', value: toll, tone: 'var(--chart-4)' },
    ...(contribution > 0 ? [{ label: 'Contribution', value: contribution, tone: 'var(--status-ready)' }] : []),
  ].filter((s) => s.value > 0);

  return (
    <>
      <SheetSection caption="The load">
        <DetailGrid>
          <Detail label="Delivered to" wide={phone}>
            {trip.customerSite}
          </Detail>
          <Detail label="Loaded at">{siteOf(trip) ?? 'Site not recorded'}</Detail>
          <Detail label="Product">{productOf(trip)}</Detail>
          <Detail label="Lorry and driver" wide={phone}>
            <IdCell>{vehicleOf(trip)?.displayReg ?? 'Not allotted'}</IdCell>
            {driver ? ` · ${driver.name}` : ' · driver not allotted'}
          </Detail>
          <Detail label="Sold">
            <QuantityCell value={trip.soldUnits} decimals={1} uom="units" />
          </Detail>
          <Detail label="Quantity basis" wide={phone}>
            {BASIS_LONG[trip.qtyBasis]}
          </Detail>
          <Detail label="Weighed">
            {trip.weighedTonnes === null ? (
              'Never crossed a weighbridge'
            ) : (
              <Provisional confirmed={wbAccepted}>
                <QuantityCell value={trip.weighedTonnes} decimals={1} uom="MT" />
              </Provisional>
            )}
          </Detail>
          <Detail label="Variance against sold">
            {trip.variancePct === null ? (
              'Nothing to compare'
            ) : (
              <span style={{ color: exceptional ? 'var(--status-attention)' : undefined }}>
                {trip.variancePct > 0 ? '+' : ''}
                {formatQty(trip.variancePct, 1)}%
              </span>
            )}
          </Detail>
          <Detail label="Lead distance">
            <QuantityCell value={trip.distanceKm} decimals={1} uom="km" />
          </Detail>
          <Detail label="Booked">{formatTime(trip.date)}</Detail>
        </DetailGrid>
        {exceptional ? (
          <Note>
            This one is beyond ±{DEFAULT_VARIANCE_TOLERANCE_PCT}% — worth adding to the trend against this driver and
            this loader operator, not worth holding the invoice for. {BASIS_LONG[trip.qtyBasis].toLowerCase()} is what
            the customer agreed to pay on.
          </Note>
        ) : null}
      </SheetSection>

      <SheetSection caption="What it earned and what it cost">
        <DetailGrid>
          <Detail label="Rate per unit">
            {trip.rateOverridden ? (
              <Provisional confirmed={rateAccepted} overridden>
                <MoneyCell value={trip.ratePerUnit} accounting={false} decimals={0} />
              </Provisional>
            ) : (
              <MoneyCell value={trip.ratePerUnit} accounting={false} decimals={0} />
            )}
          </Detail>
          <Detail label="Revenue">
            <MoneyCell value={revenue} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Material at cost">
            <MoneyCell value={material} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Diesel">
            <MoneyCell value={diesel} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Driver batta">
            <MoneyCell value={batta} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Toll">
            <MoneyCell value={toll} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Cash out of the door">
            <MoneyCell value={cash} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Contribution">
            <MoneyCell value={contribution} decimals={0} />
          </Detail>
          <Detail label="Cost per unit carried" wide>
            {perUnitCost === null ? (
              'No quantity recorded'
            ) : (
              <>
                <MoneyCell value={perUnitCost} accounting={false} decimals={0} /> per unit, material and cash together,
                over {formatQty(trip.distanceKm, 1)} km
              </>
            )}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Where the money went">
        <ProportionBar
          height={26}
          summary={
            revenue > 0
              ? `Of ${formatINRCompact(revenue)} earned, material took ${Math.round(
                  (material / Math.max(revenue, 1)) * 100,
                )}% and the road took ${Math.round((cash / Math.max(revenue, 1)) * 100)}%, leaving ${formatINRCompact(
                  contribution,
                )}.`
              : `Nothing earned against ${formatINRCompact(cash)} of diesel, batta and toll.`
          }
          segments={segments}
        />
        <ChartCaption>
          Tyres, maintenance and the EMI are absorbed at month end and are not in this bar — so a load that looks thin
          here is already thinner than it looks.
        </ChartCaption>

        {trip.status === 'returned' ? (
          <div className="mt-3">
            <Note>
              This load came back. Revenue is ₹0 — not pending, not unbilled — and the {formatINRCompact(cash)} of
              diesel, batta and toll is spent and gone. The material never left stock, so there is nothing to write off
              there; the loss is the running.
            </Note>
          </div>
        ) : null}

        {trip.status === 'cancelled' ? (
          <div className="mt-3">
            <Note>
              Called off from this board. The {formatINRCompact(cash)} already spent stays on today, the units go back
              to stock, and no invoice will ever carry this trip.
            </Note>
          </div>
        ) : null}

        {trip.purpose !== 'sale' ? (
          <div className="mt-3">
            <Note>
              This is an own-use load — material moved to our own works. It earns nothing by design. It is NOT dispatch
              somebody forgot to invoice, and it must never be counted as such; what it does cost the business is the{' '}
              {formatINRCompact(cash)} of running shown above.
            </Note>
          </div>
        ) : null}

        {trip.rateOverridden ? (
          <div className="mt-3">
            <Note>
              The rate was overridden at the gate to{' '}
              <span className="num tabular-nums" style={{ color: 'var(--text-primary)' }}>
                ₹{formatQty(num(trip.ratePerUnit), 0)}
              </span>{' '}
              a unit. That is ordinary in this trade and it is not an error — but until someone on this desk accepts it,
              the revenue on this load is asserted rather than agreed, which is why it is hatched.
              {rateAccepted ? ' Accepted.' : ''}
            </Note>
          </div>
        ) : null}
      </SheetSection>

      <SheetSection caption="Paper">
        <DetailGrid>
          <Detail label="E-way bill" wide={phone}>
            {!trip.ewbRequired ? (
              'Not required — under the ₹1,00,000 consignment threshold'
            ) : trip.ewbNumber ? (
              <IdCell>{trip.ewbNumber}</IdCell>
            ) : (
              <StatusStamp status="pending" label="EWB to raise" provisional />
            )}
          </Detail>
          <Detail label="Invoice" wide={phone}>
            {trip.invoiceId ? <IdCell>{trip.invoiceId}</IdCell> : 'Not yet on an invoice'}
          </Detail>
        </DetailGrid>
      </SheetSection>
    </>
  );
}

function tripColumns(accepted: ReadonlySet<string>): Column<Trip>[] {
  return [
    {
      key: 'trip',
      header: 'Trip',
      type: 'id',
      sticky: true,
      width: 200,
      group: 'Trip',
      render: (t) => (
        <Stacked
          primary={<IdCell>{t.tripNumber}</IdCell>}
          secondary={`${formatTime(t.date)} · ${vehicleOf(t)?.displayReg ?? 'lorry not allotted'}`}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      type: 'status',
      width: 156,
      group: 'Trip',
      // A gate override is asserted revenue until someone accepts it. Dashed.
      render: (t) => (
        <StatusStamp
          status={TRIP_STATUS_FAMILY[t.status]}
          label={TRIP_STATUS_LABEL[t.status]}
          provisional={t.rateOverridden && !accepted.has(`${t.id}:rate`)}
        />
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      width: 220,
      group: 'Load',
      render: (t) => (
        <Stacked
          primary={customerOf(t)?.name ?? t.customerId}
          secondary={t.purpose === 'sale' ? t.customerSite : `${t.customerSite} · own use, not a sale`}
        />
      ),
    },
    {
      key: 'site',
      header: 'Loaded at',
      width: 160,
      group: 'Load',
      render: (t) => siteOf(t),
    },
    {
      key: 'product',
      header: 'Product',
      width: 140,
      group: 'Load',
      render: (t) => productOf(t),
    },
    {
      key: 'sold',
      header: 'Sold',
      unit: 'units',
      type: 'num',
      width: 150,
      group: 'Load',
      // The basis never hides. What was SOLD is the primary number in this
      // trade, and how it was arrived at changes how much argument it will take.
      render: (t) => (
        <span className="inline-flex items-baseline justify-end gap-2">
          <span className="font-id text-[10px] uppercase" style={{ color: 'var(--text-tertiary)' }}>
            {BASIS_SHORT[t.qtyBasis]}
          </span>
          <QuantityCell value={t.soldUnits} decimals={1} />
        </span>
      ),
    },
    {
      key: 'weighed',
      header: 'Weighed',
      unit: 'MT',
      type: 'num',
      width: 132,
      group: 'Control',
      render: (t) =>
        t.weighedTonnes === null ? null : (
          <Provisional confirmed={accepted.has(`${t.id}:wb`)}>
            <QuantityCell value={t.weighedTonnes} decimals={1} />
          </Provisional>
        ),
    },
    {
      key: 'variance',
      header: 'Variance',
      unit: '%',
      type: 'num',
      width: 116,
      group: 'Control',
      render: (t) =>
        t.variancePct === null ? null : (
          <span
            style={{
              // Spent only past tolerance, and even then it means "look", not "stop".
              color: isVarianceExceptional(t.variancePct) ? 'var(--status-attention)' : undefined,
            }}
          >
            {t.variancePct > 0 ? '+' : ''}
            {formatQty(t.variancePct, 1)}
          </span>
        ),
    },
    {
      key: 'rate',
      header: 'Rate',
      unit: '₹',
      type: 'money',
      width: 130,
      group: 'Money',
      render: (t) =>
        t.rateOverridden ? (
          <Provisional confirmed={accepted.has(`${t.id}:rate`)} overridden>
            <MoneyCell value={t.ratePerUnit} decimals={0} />
          </Provisional>
        ) : (
          <MoneyCell value={t.ratePerUnit} decimals={0} />
        ),
    },
    {
      key: 'revenue',
      header: 'Revenue',
      unit: '₹',
      type: 'money',
      width: 140,
      group: 'Money',
      render: (t) => <MoneyCell value={revenueOf(t)} decimals={0} />,
    },
    {
      key: 'margin',
      header: 'Contribution',
      unit: '₹',
      type: 'money',
      width: 150,
      group: 'Money',
      render: (t) => <MoneyCell value={marginOf(t)} decimals={0} />,
    },
    {
      key: 'ewb',
      header: 'E-way bill',
      width: 190,
      group: 'Compliance',
      render: (t) => {
        // The calm default. A permanent alarm on loads that never needed a bill
        // teaches everyone to ignore the column that matters on the ones that do.
        if (!t.ewbRequired) {
          return <span style={{ color: 'var(--text-tertiary)' }}>Not required</span>;
        }
        return t.ewbNumber ? (
          <IdCell>{t.ewbNumber}</IdCell>
        ) : (
          <StatusStamp status="pending" label="EWB to raise" provisional />
        );
      },
    },
  ];
}
