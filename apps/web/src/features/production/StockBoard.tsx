import { useMemo, useState, type ReactNode } from 'react';
import { can, daysUntil, formatDate, formatQty, PRODUCT_DENSITIES } from '@linck/domain';
import { LAST_14, NOW, PRODUCTS, SITES, STOCK, todayTrade } from '@linck/mock';
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
  Note,
  PageHeader,
  ProportionBar,
  Provisional,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  Sparkline,
  Stacked,
  StatusStamp,
  SuggestionStrip,
  TileRow,
  TrendChart,
  useMinWidth,
  WaterfallChart,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

const STOCK_VIEWS = ['all', 'below', 'variance', 'stale'] as const;

/**
 * THE LIVE STOCK POSITION BOARD.
 *
 * The sales coordinator opens this before promising a load and has about two
 * seconds. So the primary figure is what the trade actually sells — UNITS of
 * 100 CFT — and the tonne equivalent sits beside it as the derived number it
 * is, with the conversion factor ON THE ROW.
 *
 * That factor is not decoration. Two teams once disagreed about how many CFT
 * are in a tonne of M-sand by 15%, on every single load. It is never hidden
 * behind a tooltip again.
 *
 * A promise made here is asserted, not true: promised units are hatched until
 * a tipper is actually loaded against them, and they come off the sellable
 * figure immediately so two coordinators cannot sell the same pile twice.
 *
 * Three charts, each answering a question the table can only imply:
 *   - the bar chart is the pile AGAINST its safety level, so the gap between
 *     the bar and the tick is the shortfall, readable without arithmetic;
 *   - the waterfall is where today's units went for one product;
 *   - the proportion bar is what the yard is actually made of right now, which
 *     is the question a sales head asks before pushing a grade.
 */

/** Past this many days a physical count stops being evidence and becomes a memory. */
const COUNT_TRUST_DAYS = 14;
/** Book-vs-count drift the yard cannot explain away as loader rounding. */
const VARIANCE_TOLERANCE_UNITS = 5;

interface StockRow {
  key: string;
  siteId: string;
  siteName: string;
  productCode: string;
  productLabel: string;
  /** Unique across sites — the bar chart and its click-back map key on this. */
  chartLabel: string;
  /** Book units before anything promised today. */
  bookUnits: number;
  promisedUnits: number;
  /** What sales may actually commit right now. */
  availableUnits: number;
  tonnesAtHand: number | null;
  /** tonnes per unit, from master.uom_conversions. Null = no density configured. */
  factor: number | null;
  safetyUnits: number;
  producedUnits: number;
  dispatchedUnits: number;
  /** Days of cover at today's dispatch rate. Null = nothing dispatched, so unknowable. */
  coverDays: number | null;
  varianceUnits: number;
  lastCountedOn: string;
  countAgeDays: number;
  family: 'ready' | 'attention' | 'critical';
  statusLabel: string;
}

export function StockBoard() {
  const { persona, siteScope, density } = useApp();
  /**
   * Four filter chips do not fit beside the title on a phone — the header is a
   * single flex row and the chips are the widest thing on the screen. Below
   * `md` they leave the header entirely and become their own scroll strip
   * under it, which is a DOM move rather than a style one, so it needs the
   * breakpoint in JavaScript.
   */
  const headerFitsChips = useMinWidth('md');
  const [filter, setFilter] = useViewParam(STOCK_VIEWS, 'all');
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  /** Which product the board-level waterfall is pointed at. Set by clicking a bar. */
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [promised, setPromised] = useState<Record<string, number>>({});
  const [draftUnits, setDraftUnits] = useState(4);
  const [dismissed, setDismissed] = useState(false);
  const [confirm, setConfirm] = useState<'promise' | 'release' | null>(null);

  const trade = todayTrade(siteScope);
  const showSite = siteScope === null;

  const rows = useMemo<StockRow[]>(() => {
    const scoped = siteScope ? STOCK.filter((s) => s.siteId === siteScope) : STOCK;
    return scoped.map((s) => {
      const key = `${s.siteId}-${s.productCode}`;
      const factor = PRODUCT_DENSITIES[s.productCode]?.tonnesPerUnit ?? null;
      const promisedUnits = promised[key] ?? 0;
      const availableUnits = Math.round((s.units - promisedUnits) * 10) / 10;
      const family = availableUnits <= 0 ? 'critical' : availableUnits < s.safetyUnits ? 'attention' : 'ready';
      const siteName = SITES.find((x) => x.id === s.siteId)?.name ?? s.siteId;
      const productLabel = PRODUCTS.find((p) => p.code === s.productCode)?.label ?? s.productCode;
      return {
        key,
        siteId: s.siteId,
        siteName,
        productCode: s.productCode,
        productLabel,
        // Two plants hold the same grades, so the chart label carries the yard
        // as well — otherwise two different piles share one bar.
        chartLabel: siteScope ? productLabel : `${productLabel} · ${siteName.split(' ')[0] ?? siteName}`,
        bookUnits: s.units,
        promisedUnits,
        availableUnits,
        tonnesAtHand: factor === null ? null : Math.round(availableUnits * factor * 10) / 10,
        factor,
        safetyUnits: s.safetyUnits,
        producedUnits: s.producedTodayUnits,
        dispatchedUnits: s.dispatchedTodayUnits,
        // Cover at TODAY's rate so far — it is 14:42, not close of day.
        coverDays: s.dispatchedTodayUnits > 0 ? Math.round((availableUnits / s.dispatchedTodayUnits) * 10) / 10 : null,
        varianceUnits: s.countVarianceUnits,
        lastCountedOn: s.lastCountedOn,
        countAgeDays: Math.abs(daysUntil(s.lastCountedOn, NOW)),
        family,
        statusLabel: family === 'critical' ? 'Nothing to sell' : family === 'attention' ? 'Below safety' : 'Sellable',
      };
    });
  }, [siteScope, promised]);

  // Counted off `rows`, not off the raw selector, so a promise made on this
  // screen moves the chip count in the same tick it moves the row.
  const lowCount = rows.filter((r) => r.availableUnits < r.safetyUnits).length;
  const varianceCount = rows.filter((r) => Math.abs(r.varianceUnits) > VARIANCE_TOLERANCE_UNITS).length;
  const staleCount = rows.filter((r) => r.countAgeDays > COUNT_TRUST_DAYS).length;
  const varianceTotal = rows.reduce((sum, r) => sum + r.varianceUnits, 0);
  const promisedTotal = rows.reduce((sum, r) => sum + r.promisedUnits, 0);

  const visible = useMemo(() => {
    switch (filter) {
      case 'below':
        return rows.filter((r) => r.availableUnits < r.safetyUnits);
      case 'variance':
        return rows.filter((r) => Math.abs(r.varianceUnits) > VARIANCE_TOLERANCE_UNITS);
      case 'stale':
        return rows.filter((r) => r.countAgeDays > COUNT_TRUST_DAYS);
      default:
        return rows;
    }
  }, [rows, filter]);

  // Worst shortfall at the top. A stock board sorted alphabetically makes the
  // reader search for the emergency; sorted by headroom it is the first line.
  const barRows = useMemo(
    () => [...visible].sort((a, b) => a.availableUnits - a.safetyUnits - (b.availableUnits - b.safetyUnits)),
    [visible],
  );
  const byChartLabel = useMemo(() => new Map(barRows.map((r) => [r.chartLabel, r.key])), [barRows]);

  const selected = rows.find((r) => r.key === selectedKey);
  const focused = visible.find((r) => r.key === focusKey) ?? barRows[0];
  const mayPromise = selected ? can(persona.grants, 'sales.dispatch.write', { siteId: selected.siteId }) : false;
  // Below safety AND nothing came off the crusher against it today.
  const starving = rows.find((r) => r.availableUnits < r.safetyUnits && r.producedUnits === 0);

  // What the ground is made of, in sellable units, biggest grade first. Piles
  // beyond the fifth are pooled rather than each taking a ramp step nobody can
  // tell apart.
  const mix = useMemo(() => {
    const byProduct = new Map<string, number>();
    for (const r of rows) byProduct.set(r.productLabel, (byProduct.get(r.productLabel) ?? 0) + Math.max(0, r.availableUnits));
    const ordered = [...byProduct.entries()].sort((a, b) => b[1] - a[1]);
    const head = ordered.slice(0, 5).map(([label, value]) => ({ label, value }));
    const tail = ordered.slice(5).reduce((s, [, value]) => s + value, 0);
    return tail > 0 ? [...head, { label: 'Other grades', value: tail }] : head;
  }, [rows]);
  const mixTotal = mix.reduce((s, seg) => s + seg.value, 0);

  // Produced less dispatched, group-wide, over a fortnight. Positive days grew
  // the yard; negative days sold out of the pile.
  const netSeries = LAST_14.map((d) => ({
    label: d.label,
    value: Math.round((d.producedUnits - d.dispatchedUnits) * 10) / 10,
  }));
  const shrinkDays = netSeries.filter((p) => p.value < 0).length;

  const columns = useMemo<Column<StockRow>[]>(() => buildColumns(showSite), [showSite]);

  // A promise is held in screen state only — it is not a dispatch, and nothing
  // here writes to the ledger. Releasing puts the units straight back.
  function commitPromise(row: StockRow) {
    setPromised((prev) => ({ ...prev, [row.key]: (prev[row.key] ?? 0) + draftUnits }));
  }
  function releasePromise(row: StockRow) {
    setPromised((prev) => {
      const next = { ...prev };
      delete next[row.key];
      return next;
    });
  }
  /**
   * A promise that leaves the pile above its safety level is routine and goes
   * through unchallenged. One that eats into the safety buffer, or empties the
   * pile outright, gets a modal with the arithmetic in it — because the person
   * it hurts is the driver sent to an empty yard three hours from now.
   */
  function requestPromise(row: StockRow) {
    if (row.availableUnits - draftUnits < row.safetyUnits) setConfirm('promise');
    else commitPromise(row);
  }

  const filterChips = (
    <>
      <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
        All products
      </Chip>
      <Chip active={filter === 'below'} onClick={() => setFilter('below')} count={lowCount}>
        Below safety
      </Chip>
      <Chip active={filter === 'variance'} onClick={() => setFilter('variance')} count={varianceCount}>
        Count unexplained
      </Chip>
      <Chip active={filter === 'stale'} onClick={() => setFilter('stale')} count={staleCount}>
        Counted over a fortnight ago
      </Chip>
    </>
  );

  return (
    <>
      <PageHeader
        eyebrow="Production"
        title="Live stock position"
        meta={<AsOfStamp asOf="14:42" source="v_stock_position_now" freshness="live" />}
        actions={headerFitsChips ? filterChips : undefined}
      />

      {headerFitsChips ? null : (
        <div
          className="flex items-center gap-2 overflow-x-auto px-6 py-2 [&>*]:shrink-0 [&>*]:whitespace-nowrap"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          {filterChips}
        </div>
      )}

      {/* The reconciliation strip. Produced minus dispatched is the number that
          says whether material left the yard without paper — it is never
          buried at the bottom of a report.

          One tile per row on a phone: two columns of a 2rem figure plus a full
          sentence of delta prose left the delta wrapping to four lines and the
          dispatch sparkline sitting on top of its own eyebrow. */}
      <TileRow className="grid-cols-1 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:grid-cols-2 sm:[&>*]:border-b-0 sm:[&>*]:border-r xl:grid-cols-4">
        <KpiTile
          eyebrow="Produced today"
          value={`${formatQty(trade.producedUnits, 1)} units`}
          delta={{ text: 'Booked against crusher runs, all shifts' }}
          asOf="14:42"
          source="v_production_daily"
          freshness="materialised"
        />
        <div className="relative">
          <KpiTile
            eyebrow="Dispatched today"
            value={`${formatQty(trade.dispatchedUnits, 1)} units`}
            delta={{ text: `${trade.activeTrips} trips still running` }}
            asOf="14:42"
            source="v_dispatch_daily"
            freshness="materialised"
          />
          {/* Fourteen days of dispatch behind today's figure, so "160 units" is
              read as high or low rather than as a bare number. */}
          <div className="absolute right-4 top-6 sm:right-7 sm:top-7">
            <Sparkline data={LAST_14.map((d) => d.dispatchedUnits)} width={72} height={20} />
          </div>
        </div>
        <KpiTile
          eyebrow="Produced less dispatched"
          hero
          value={`${trade.gapUnits > 0 ? '+' : ''}${formatQty(trade.gapUnits, 1)} units`}
          delta={{
            text:
              trade.gapUnits >= 0
                ? 'Stockpile grew by this much — it must be findable on the ground'
                : 'More left the yard than was made. Reconcile against opening stock today',
            tone: trade.gapUnits < 0 ? 'critical' : Math.abs(trade.gapUnits) > 40 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_produced_dispatched_invoiced"
        />
        <KpiTile
          eyebrow="Unexplained since last count"
          value={`${formatQty(varianceTotal, 1)} units`}
          delta={{
            text: `${varianceCount} products drifted past ±${VARIANCE_TOLERANCE_UNITS} units`,
            tone: varianceCount > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_stock_count_variance"
          freshness="stale"
        />
      </TileRow>

      {starving && !dismissed && filter === 'all' ? (
        <div className="px-6 pt-4">
          <SuggestionStrip onApply={() => setFilter('below')} onDismiss={() => setDismissed(true)} applyLabel="Show them">
            {starving.productLabel} at {starving.siteName} is {formatQty(starving.safetyUnits - starving.availableUnits, 1)} units
            under its safety level and no crusher output was booked against it today. Sales can still see it as sellable.
          </SuggestionStrip>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-6 xl:grid-cols-2">
        <Section caption="Bar is the pile, tick is the safety level" title="Every grade against its floor">
          {barRows.length === 0 ? (
            <Note>Nothing matches this view, so there is no pile to draw.</Note>
          ) : (
            <>
              {/* The label gutter is 150–208px of grade-and-plant names, which
                  is more than half a phone. Shrinking it would truncate the
                  names, so the chart keeps its real measure and scrolls inside
                  its own box instead of dragging the page sideways. */}
              <div className="overflow-x-auto">
                <div className={showSite ? 'min-w-[480px]' : 'min-w-[400px]'}>
                  <BarChart
                    summary={
                      lowCount === 0
                        ? `All ${barRows.length} piles sit above their safety level.`
                        : `${lowCount} of ${rows.length} piles sit under their safety level; ${
                            barRows[0]?.chartLabel ?? ''
                          } is short by ${formatQty(Math.abs((barRows[0]?.availableUnits ?? 0) - (barRows[0]?.safetyUnits ?? 0)), 1)} units.`
                    }
                    data={barRows.map((r) => ({
                      label: r.chartLabel,
                      value: Math.max(0, r.availableUnits),
                      marker: r.safetyUnits,
                      tone:
                        r.family === 'critical'
                          ? 'var(--status-critical)'
                          : r.family === 'attention'
                            ? 'var(--status-attention)'
                            : 'var(--chart-2)',
                    }))}
                    format={(v) => formatQty(v, 0)}
                    labelWidth={showSite ? 208 : 150}
                    onSelect={(d) => setFocusKey(byChartLabel.get(d.label))}
                  />
                </div>
              </div>
              <ChartCaption>
                A bar that stops short of its dashed tick is a pile the yard cannot refill in a day — the shortfall is
                legible without the colour, which is the point. Sorted by headroom, so the emergency is the top line.
                Click a bar to point the movement chart at that grade.
              </ChartCaption>
            </>
          )}
        </Section>

        <Section
          caption="Today, one grade at a time"
          title={focused ? `Where ${focused.productLabel} went` : 'Where the units went'}
          actions={<AsOfStamp asOf="14:42" source="v_stock_movement_today" freshness="live" />}
        >
          {focused ? (
            <>
              {/* Six steps under 400px puts "Dispatched" on top of "Book
                  close". The waterfall keeps its step width and scrolls in its
                  own box rather than being read as one smeared axis. */}
              <div className="overflow-x-auto">
                <div className="min-w-[440px]">
                  <WaterfallChart
                    summary={`${focused.productLabel} opened at ${formatQty(
                      focused.bookUnits - focused.producedUnits + focused.dispatchedUnits,
                      1,
                    )} units, made ${formatQty(focused.producedUnits, 1)}, sent out ${formatQty(
                      focused.dispatchedUnits,
                      1,
                    )}, and has ${formatQty(focused.availableUnits, 1)} sellable.`}
                    height={220}
                    format={(v) => formatQty(v, 0)}
                    steps={waterfallSteps(focused)}
                  />
                </div>
              </div>
              <ChartCaption>
                Opening is back-computed from where the pile stands now, so it moves the moment the weighbridge does.
                {focused.promisedUnits > 0
                  ? ' The promised step is not a movement — nothing has left the yard against it yet.'
                  : ''}
              </ChartCaption>
            </>
          ) : (
            <Note>No grade selected.</Note>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-2 xl:grid-cols-2">
        <Section caption="Sellable units on the ground" title="What the yard is made of">
          <ProportionBar
            summary={
              mix.length === 0
                ? 'Nothing on the ground.'
                : `${mix[0]?.label} is the largest pile at ${Math.round(((mix[0]?.value ?? 0) / (mixTotal || 1)) * 100)}% of sellable units.`
            }
            segments={mix}
          />
          {/* On a phone a six-segment bar has room for the percentages and not
              for the grade names, so the names that no longer fit in the bar
              are listed under it in the same order and the same ramp step.
              Nothing is dropped — it is the same six figures, reflowed. */}
          <ul className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 md:hidden">
            {mix.map((seg, i) => (
              <li key={seg.label} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0"
                  style={{ background: `var(--chart-${Math.min(5, i + 1)})` }}
                />
                <span className="min-w-0 truncate">{seg.label}</span>
                <span className="num ml-auto tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {Math.round((seg.value / (mixTotal || 1)) * 100)}%
                </span>
              </li>
            ))}
          </ul>
          <ChartCaption>
            Mix on the ground, not mix sold — a grade that dominates this bar and not the sales mix is capital standing
            in a heap. Promised units are already out of it.
          </ChartCaption>
        </Section>

        <Section caption="Fourteen days, group-wide" title="Did the stockpile grow or get eaten">
          <TrendChart
            data={netSeries}
            summary={`Produced less dispatched over fourteen days; the yard shrank on ${shrinkDays} of them.`}
            seriesLabel="Net units"
            benchmark={{ value: 0, label: 'flat' }}
            flagBelow={0}
            height={170}
            format={(v) => `${v > 0 ? '+' : ''}${formatQty(v, 0)}`}
          />
          <ChartCaption>
            Ringed points are days the yard sold out of the pile rather than out of the crusher. A run of them is how a
            stockout arrives without anyone ever seeing a bad day.
          </ChartCaption>
        </Section>
      </div>

      <Section
        caption="Units first, tonnes derived"
        title="What can be sold right now"
        actions={<AsOfStamp asOf="14:42" source="v_stock_position_now" freshness="live" />}
      >
        <DataTable
          density={density}
          columns={columns}
          rows={visible}
          rowKey={(r) => r.key}
          selectedKey={selectedKey}
          onRowClick={(r) => setSelectedKey(r.key === selectedKey ? undefined : r.key)}
          rail={(r) => ({
            status: r.family,
            // The rail IS the safety gauge: full at safety level, empty at zero.
            fillRatio: Math.max(0, Math.min(1, r.availableUnits / r.safetyUnits)),
          })}
          empty={
            <EmptyState
              fact="No product matches this view."
              because="Every pile at this plant is above its safety level and counted recently."
              action={{ label: 'Show all products', onClick: () => setFilter('all') }}
            />
          }
        />

        {/* Footnote, not a tooltip. The factor is the number two teams once
            disagreed on by 15% on every load billed. */}
        <p className="font-serif mx-6 mt-3 max-w-[80ch] text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
          Units are the trade quantity — one unit is 100 CFT, and it is what the customer orders, argues about and pays
          against. The MT column is computed from the per-product trade density in the t/unit column, never weighed; a
          revision to that density restates nothing already invoiced. The rail at the left edge of each row is the safety
          gauge — full at the safety level, empty at nothing left. Days of cover use today&rsquo;s dispatch so far,
          measured at 14:42, so a slow morning flatters them. Open a row for the full position and to commit units.
          {promisedTotal > 0
            ? ` ${formatQty(promisedTotal, 1)} units are promised on this screen and are already off every sellable figure above.`
            : ''}
        </p>
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== undefined}
        onClose={() => setSelectedKey(undefined)}
        width="form"
        title={selected ? `${selected.productLabel} · ${selected.siteName}` : ''}
        identifier={selected?.productCode}
        status={
          selected
            ? {
                family: selected.family,
                label: selected.statusLabel,
                severity:
                  selected.availableUnits < selected.safetyUnits
                    ? formatQty(selected.availableUnits - selected.safetyUnits, 0)
                    : undefined,
                // A position resting on a month-old count is asserted, not verified.
                provisional: selected.countAgeDays > COUNT_TRUST_DAYS,
              }
            : undefined
        }
        revision={selected ? `COUNTED ${formatDate(selected.lastCountedOn)}` : undefined}
        footer={
          selected ? (
            <PromiseBar
              row={selected}
              draftUnits={draftUnits}
              mayPromise={mayPromise}
              roleLabel={persona.roleLabel}
              onLess={() => setDraftUnits(Math.max(1, draftUnits - 1))}
              onMore={() => setDraftUnits(draftUnits + 1)}
              onPromise={() => requestPromise(selected)}
              onRelease={() => setConfirm('release')}
            />
          ) : undefined
        }
      >
        {selected ? <StockDetail row={selected} /> : null}
      </SideSheet>

      {/* The two commitments that hurt someone downstream, each with its own
          arithmetic stated before the click, not after. */}
      <ConfirmModal
        open={confirm === 'promise' && selected !== undefined}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (selected) commitPromise(selected);
        }}
        title="Promise into the safety buffer"
        confirmLabel={`Promise ${draftUnits} units`}
        destructive={selected !== undefined && selected.availableUnits - draftUnits <= 0}
        consequence={
          selected ? (
            <>
              {formatQty(selected.availableUnits, 1)} units of {selected.productLabel} are sellable at{' '}
              {selected.siteName}. Promising {draftUnits} leaves{' '}
              {formatQty(selected.availableUnits - draftUnits, 1)} against a safety level of{' '}
              {formatQty(selected.safetyUnits, 0)}
              {selected.availableUnits - draftUnits <= 0
                ? ' — nothing at all, and the next tipper routed here will find an empty pile.'
                : ` — ${formatQty(selected.safetyUnits - (selected.availableUnits - draftUnits), 1)} units into the buffer that exists to absorb a crusher breakdown.`}
              {selected.countAgeDays > COUNT_TRUST_DAYS
                ? ` The pile was last physically counted ${selected.countAgeDays} days ago, so this is book stock rather than a measured heap.`
                : ''}
            </>
          ) : null
        }
      />

      <ConfirmModal
        open={confirm === 'release' && selected !== undefined}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (selected) releasePromise(selected);
        }}
        title="Release the promised units"
        confirmLabel="Release"
        destructive
        consequence={
          selected ? (
            <>
              {formatQty(selected.promisedUnits, 1)} units of {selected.productLabel} go back on the sellable figure and
              any coordinator may commit them within seconds. If a customer was told this material is held, someone has
              to be told it is not.
            </>
          ) : null
        }
      />
    </>
  );
}

/**
 * Opening, plus what the crusher made, minus what left the gate, equals the
 * book close. Promised units are appended as a separate step below that close
 * — they are a commitment, not a movement, and collapsing the two is how a
 * yard ends up counting the same pile twice.
 */
function waterfallSteps(row: StockRow) {
  const opening = Math.round((row.bookUnits - row.producedUnits + row.dispatchedUnits) * 10) / 10;
  const base = [
    { label: 'Opening', delta: opening, total: true },
    { label: 'Produced', delta: row.producedUnits },
    { label: 'Dispatched', delta: -row.dispatchedUnits },
    { label: 'Book close', delta: 0, total: true },
  ];
  return row.promisedUnits > 0
    ? [...base, { label: 'Promised', delta: -row.promisedUnits }, { label: 'Sellable', delta: 0, total: true }]
    : base;
}

/**
 * The sheet footer. The stepper, the commit and the release live here rather
 * than in the body, because they are the only things on this surface that
 * change the world and they should not scroll away from the numbers they act
 * on.
 */
function PromiseBar({
  row,
  draftUnits,
  mayPromise,
  roleLabel,
  onLess,
  onMore,
  onPromise,
  onRelease,
}: {
  row: StockRow;
  draftUnits: number;
  mayPromise: boolean;
  roleLabel: string;
  onLess: () => void;
  onMore: () => void;
  onPromise: () => void;
  onRelease: () => void;
}) {
  if (!mayPromise) {
    return (
      <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {roleLabel} may read this board but not commit stock against it.
      </span>
    );
  }

  const overdrawn = draftUnits > row.availableUnits;

  /**
   * The sheet footer is one 56px row and, on a phone, 335px wide. Stepper plus
   * commit plus release plus a warning does not fit that line, so: the stepper
   * and the release keep their intrinsic width, the commit takes what is left,
   * the two quantity suffixes drop below `sm` (the figures they repeat are both
   * on the row above), and the overdrawn warning rides directly above the bar
   * rather than being squeezed into it.
   */
  return (
    <div className="relative flex w-full min-w-0 items-center gap-2">
      <Button className="shrink-0" onClick={onLess} aria-label="One unit fewer">
        −
      </Button>
      <span className="num w-8 shrink-0 text-center text-[15px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {draftUnits}
      </span>
      <Button className="shrink-0" onClick={onMore} aria-label="One unit more">
        +
      </Button>
      <Button
        className="min-w-0 flex-1 whitespace-nowrap [@media(hover:hover)]:flex-none"
        variant="primary"
        disabled={overdrawn}
        onClick={onPromise}
      >
        Promise {draftUnits}
        <span className="hidden sm:inline">&nbsp;units</span>
      </Button>
      {row.promisedUnits > 0 ? (
        <Button className="shrink-0 whitespace-nowrap" variant="destructive" onClick={onRelease}>
          Release<span className="hidden sm:inline">&nbsp;{formatQty(row.promisedUnits, 1)}</span>
        </Button>
      ) : null}
      {overdrawn ? (
        <span
          className="font-serif absolute inset-x-0 bottom-full -mx-5 px-5 pb-1 text-[12px] italic sm:static sm:mx-0 sm:px-0 sm:pb-0"
          style={{ color: 'var(--status-attention)', background: 'var(--surface-raised)' }}
        >
          More than is on the ground.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The position, in full.
 *
 * Everything the row showed, plus the three things it could not fit: the
 * conversion worked through as arithmetic rather than asserted as a factor,
 * today's movement as a shape, and how old the evidence under all of it is.
 */
function StockDetail({ row }: { row: StockRow }) {
  const opening = Math.round((row.bookUnits - row.producedUnits + row.dispatchedUnits) * 10) / 10;
  const flaggedVariance = Math.abs(row.varianceUnits) > VARIANCE_TOLERANCE_UNITS;

  return (
    <>
      <SheetSection caption="Position">
        <DetailGrid>
          <Detail label="Sellable now">
            <QuantityCell value={row.availableUnits} decimals={1} uom="units" />
          </Detail>
          <Detail label="Book stock, before promises">
            <QuantityCell value={row.bookUnits} decimals={1} uom="units" />
          </Detail>
          <Detail label="Promised, not yet loaded">
            {row.promisedUnits === 0 ? (
              <QuantityCell value={0} decimals={1} uom="units" />
            ) : (
              <Provisional>
                <QuantityCell value={row.promisedUnits} decimals={1} uom="units" />
              </Provisional>
            )}
          </Detail>
          <Detail label="Tonne equivalent">
            <QuantityCell value={row.tonnesAtHand} decimals={1} uom="MT" />
          </Detail>
          <Detail label="Safety level">
            <QuantityCell value={row.safetyUnits} decimals={0} uom="units" />
          </Detail>
          <Detail label="Days of cover">
            {row.coverDays === null ? 'Nothing dispatched today' : `${formatQty(row.coverDays, 1)} days`}
          </Detail>
        </DetailGrid>
        {row.coverDays === null ? (
          <Note>
            Cover is unknowable rather than infinite — no load has gone out against this grade today, so there is no rate
            to divide by. That is not the same as having plenty.
          </Note>
        ) : null}
      </SheetSection>

      {/* The conversion, worked. This is the sentence that ends the argument. */}
      <SheetSection caption="How the tonnage was got">
        <DetailGrid>
          <Detail label="Trade unit">1 unit = 100 CFT</Detail>
          <Detail label="Density on file">
            {row.factor === null ? '–' : `${formatQty(row.factor, 2)} t/unit`}
          </Detail>
          <Detail label="Arithmetic" wide>
            <span className="num tabular-nums">
              {formatQty(row.availableUnits, 1)} units × {row.factor === null ? '–' : formatQty(row.factor, 2)} t/unit ={' '}
              {row.tonnesAtHand === null ? '–' : formatQty(row.tonnesAtHand, 1)} MT
            </span>
          </Detail>
        </DetailGrid>
        <Note>
          {row.factor === null
            ? 'No trade density is configured for this grade, so no tonne figure exists for it. An assumed one is how a fifteen per cent argument starts.'
            : 'Never weighed — computed from the density held in master data. Revising that density restates nothing already invoiced.'}
        </Note>
      </SheetSection>

      <SheetSection caption="Movement today">
        {/* The sheet is the full width of the phone, which is still narrower
            than six labelled steps. Same treatment as the board chart. */}
        <div className="overflow-x-auto">
          <div className="min-w-[420px]">
            <WaterfallChart
              summary={`Opened at ${formatQty(opening, 1)} units, made ${formatQty(
                row.producedUnits,
                1,
              )}, sent out ${formatQty(row.dispatchedUnits, 1)}, ${formatQty(row.availableUnits, 1)} sellable.`}
              height={190}
              format={(v) => formatQty(v, 0)}
              steps={waterfallSteps(row)}
            />
          </div>
        </div>
      </SheetSection>

      <SheetSection caption="Control">
        <DetailGrid>
          <Detail label="Last physical count">
            <span className="num tabular-nums">{formatDate(row.lastCountedOn)}</span>
          </Detail>
          <Detail label="Age of that count">{row.countAgeDays} days</Detail>
          <Detail label="Count variance" wide>
            <span className="num tabular-nums" style={flaggedVariance ? { color: 'var(--status-attention)' } : undefined}>
              {formatQty(row.varianceUnits, 1)} units
            </span>
            {flaggedVariance ? (
              <span style={{ color: 'var(--status-attention)' }}>
                {' '}
                unexplained since last count on {formatDate(row.lastCountedOn)}
              </span>
            ) : null}
          </Detail>
        </DetailGrid>
        {flaggedVariance ? (
          <Note>
            {formatQty(Math.abs(row.varianceUnits), 1)} units {row.varianceUnits < 0 ? 'short' : 'over'} against the last
            physical count, past the ±{VARIANCE_TOLERANCE_UNITS} unit tolerance the yard can put down to loader rounding.
            Nobody has accounted for it.
          </Note>
        ) : (
          <Note>Book stock and the last physical count agree within the ±{VARIANCE_TOLERANCE_UNITS} unit tolerance.</Note>
        )}
        {row.countAgeDays > COUNT_TRUST_DAYS ? (
          <p className="font-serif mt-2 text-[13px] italic" style={{ color: 'var(--status-attention)' }}>
            Counted {row.countAgeDays} days ago. Past a fortnight a count stops being evidence and becomes a memory —
            treat this as book stock, not a measured pile, and walk the yard before committing a large order.
          </p>
        ) : null}
      </SheetSection>

      <SheetSection caption="Commitment">
        <Note>
          A promise made here holds the units off the sellable figure immediately, so two coordinators cannot sell the
          same pile twice. It is not a dispatch and nothing is written to the ledger — the units stay hatched until a
          tipper is actually loaded against them.
        </Note>
      </SheetSection>
    </>
  );
}

/** Colour is spent per cell, never per column, so the tint lives at the call site. */
function tinted(color: string | undefined, node: ReactNode): ReactNode {
  return <span style={color ? { color } : undefined}>{node}</span>;
}

function buildColumns(showSite: boolean): Column<StockRow>[] {
  const plant: Column<StockRow>[] = showSite
    ? [{ key: 'site', header: 'Plant', width: 168, group: 'Material', render: (r) => r.siteName }]
    : [];

  return [
    {
      key: 'product', header: 'Product', sticky: true, width: 188, group: 'Material',
      render: (r) => <Stacked primary={r.productLabel} secondary={<IdCell>{r.productCode}</IdCell>} />,
    },
    ...plant,
    // Units first. Every column to the right of this one is derived from it.
    {
      key: 'available', header: 'Sellable', unit: 'units', type: 'num', width: 124, group: 'Position',
      render: (r) => <QuantityCell value={r.availableUnits} decimals={1} />,
    },
    {
      key: 'tonnes', header: 'Equivalent', unit: 'MT', type: 'num', width: 118, group: 'Position',
      render: (r) => tinted('var(--text-secondary)', <QuantityCell value={r.tonnesAtHand} decimals={1} />),
    },
    // The factor rides on every row so the units-versus-tonnes argument cannot restart.
    {
      key: 'factor', header: 'Factor', unit: 't/unit', type: 'num', width: 100, group: 'Position',
      render: (r) => tinted('var(--text-tertiary)', <QuantityCell value={r.factor} decimals={2} />),
    },
    {
      key: 'produced', header: 'Produced', unit: 'units', type: 'num', width: 112, group: 'Movement today',
      render: (r) => <QuantityCell value={r.producedUnits} decimals={1} />,
    },
    {
      key: 'dispatched', header: 'Dispatched', unit: 'units', type: 'num', width: 118, group: 'Movement today',
      render: (r) => <QuantityCell value={r.dispatchedUnits} decimals={1} />,
    },
    {
      key: 'promised', header: 'Promised', unit: 'units', type: 'num', width: 128, group: 'Commitment',
      // Promised is asserted, not true — nothing has moved until a load is raised.
      render: (r) =>
        r.promisedUnits === 0
          ? tinted('var(--text-tertiary)', <QuantityCell value={0} decimals={1} />)
          : <Provisional><QuantityCell value={r.promisedUnits} decimals={1} /></Provisional>,
    },
    {
      key: 'cover', header: 'Cover', unit: 'days', type: 'num', width: 98, group: 'Commitment',
      // Null, not zero: nothing dispatched today makes the rate unknowable, and
      // an en dash says that where a 0 would lie about it.
      render: (r) =>
        r.coverDays === null ? null : tinted(r.coverDays < 1 ? 'var(--status-attention)' : undefined, <QuantityCell value={r.coverDays} decimals={1} />),
    },
    {
      key: 'variance', header: 'Count variance', unit: 'units', type: 'num', width: 212, group: 'Control',
      // The shrinkage signal. Past ±5 units it stops being loader rounding and
      // says so in words, on the row, without a hover.
      render: (r) => {
        const flagged = Math.abs(r.varianceUnits) > VARIANCE_TOLERANCE_UNITS;
        return (
          <Stacked
            primary={tinted(flagged ? 'var(--status-attention)' : undefined, <QuantityCell value={r.varianceUnits} decimals={1} />)}
            secondary={
              flagged
                ? tinted('var(--status-attention)', `unexplained since last count on ${formatDate(r.lastCountedOn)}`)
                : null
            }
          />
        );
      },
    },
    {
      key: 'counted', header: 'Last counted', width: 152, group: 'Control',
      render: (r) => (
        <span className="flex items-baseline gap-2">
          <span className="num tabular-nums">{formatDate(r.lastCountedOn)}</span>
          {tinted(
            r.countAgeDays > COUNT_TRUST_DAYS ? 'var(--status-attention)' : 'var(--text-tertiary)',
            <span className="num text-[12px] tabular-nums">{r.countAgeDays}d ago</span>,
          )}
        </span>
      ),
    },
    {
      key: 'status', header: 'Standing', type: 'status', width: 178, group: 'Standing',
      render: (r) => (
        <StatusStamp
          status={r.family}
          label={r.statusLabel}
          // The integer that carries the severity: units short of safety.
          severity={r.availableUnits < r.safetyUnits ? formatQty(r.availableUnits - r.safetyUnits, 0) : undefined}
          fillRatio={Math.max(0, Math.min(1, r.availableUnits / r.safetyUnits))}
          // A position resting on a month-old count is asserted, not verified.
          provisional={r.countAgeDays > COUNT_TRUST_DAYS}
        />
      ),
    },
  ];
}
