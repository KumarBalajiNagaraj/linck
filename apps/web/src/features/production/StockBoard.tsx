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
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { stockWords, unitWords } from './words.js';

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
 * behind a tooltip again. The tonne column is computed from the per-product
 * trade density, never weighed, and revising that density restates nothing
 * already invoiced — which is why the footnote under the table says "worked
 * out, not weighed".
 *
 * A promise made here is asserted, not true: promised units are hatched until
 * a tipper is actually loaded against them, and they come off the sellable
 * figure immediately so two coordinators cannot sell the same pile twice.
 *
 * Three charts, each answering a question the table can only imply:
 *   - the bar chart is the pile AGAINST its safety level ("minimum" on
 *     screen), so the gap between the bar and the tick is the shortfall,
 *     readable without arithmetic and without the colour;
 *   - the waterfall is where today's units went for one product;
 *   - the proportion bar is what the yard is actually made of right now, which
 *     is the question a sales head asks before pushing a grade. It is the mix
 *     on the ground, not the mix sold — a grade that dominates this bar and not
 *     the sales mix is capital standing in a heap.
 *
 * LIN-23: every word is in ./words.ts, in English and Tamil, and kept short.
 */

/** Past this many days a physical count stops being evidence and becomes a memory. */
const COUNT_TRUST_DAYS = 14;
/** Book-vs-count drift the yard cannot explain away as loader rounding. */
const VARIANCE_TOLERANCE_UNITS = 5;
/** The permission behind a promise. Kept on hover for the admin, never printed. */
const PROMISE_PERMISSION = 'sales.dispatch.write';

type Words = (typeof stockWords)['en'];
type Units = (typeof unitWords)['en'];

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
}

/** `19-10` — an axis label in the screen's own date shape, with no month names. */
function dayMonth(isoDate: string): string {
  return `${isoDate.slice(8, 10)}-${isoDate.slice(5, 7)}`;
}

export function StockBoard() {
  const { persona, siteScope, density } = useApp();
  const t = useWords(stockWords);
  const u = useWords(unitWords);
  /**
   * Four filter chips do not fit beside the title on a narrow screen — the
   * header is a single flex row and the chips are the widest thing on it, wider
   * still in Tamil. Below `lg` they leave the header entirely and become their
   * own scroll strip under it, which is a DOM move rather than a style one, so
   * it needs the breakpoint in JavaScript.
   */
  const headerFitsChips = useMinWidth('lg');
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
        // Cover at TODAY's rate so far — it is 14:42, not close of day, so a
        // slow morning flatters it.
        coverDays: s.dispatchedTodayUnits > 0 ? Math.round((availableUnits / s.dispatchedTodayUnits) * 10) / 10 : null,
        varianceUnits: s.countVarianceUnits,
        lastCountedOn: s.lastCountedOn,
        countAgeDays: Math.abs(daysUntil(s.lastCountedOn, NOW)),
        family,
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
  const mayPromise = selected ? can(persona.grants, PROMISE_PERMISSION, { siteId: selected.siteId }) : false;
  // Below safety AND nothing came off the crusher against it today — and
  // sales can still see it as sellable.
  const starving = rows.find((r) => r.availableUnits < r.safetyUnits && r.producedUnits === 0);

  // What the ground is made of, in sellable units, biggest grade first. Piles
  // beyond the fifth are pooled rather than each taking a ramp step nobody can
  // tell apart. Promised units are already out of it.
  const mix = useMemo(() => {
    const byProduct = new Map<string, number>();
    for (const r of rows) byProduct.set(r.productLabel, (byProduct.get(r.productLabel) ?? 0) + Math.max(0, r.availableUnits));
    const ordered = [...byProduct.entries()].sort((a, b) => b[1] - a[1]);
    const head = ordered.slice(0, 5).map(([label, value]) => ({ label, value }));
    const tail = ordered.slice(5).reduce((s, [, value]) => s + value, 0);
    return tail > 0 ? [...head, { label: t.mix.other, value: tail }] : head;
  }, [rows, t]);
  const mixTotal = mix.reduce((s, seg) => s + seg.value, 0);

  // Produced less dispatched, group-wide, over a fortnight. Positive days grew
  // the yard; negative days sold out of the pile rather than out of the
  // crusher — and a run of them is how a stockout arrives without anyone ever
  // seeing a bad day.
  const netSeries = LAST_14.map((d) => ({
    label: dayMonth(d.date),
    value: Math.round((d.producedUnits - d.dispatchedUnits) * 10) / 10,
  }));
  const shrinkDays = netSeries.filter((p) => p.value < 0).length;

  const columns = useMemo<Column<StockRow>[]>(() => buildColumns(showSite, t, u), [showSite, t, u]);

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
   * it hurts is the driver sent to an empty yard three hours from now. The
   * buffer exists to absorb a crusher breakdown.
   */
  function requestPromise(row: StockRow) {
    if (row.availableUnits - draftUnits < row.safetyUnits) setConfirm('promise');
    else commitPromise(row);
  }

  const filterChips = (
    <>
      <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
        {t.filters.all}
      </Chip>
      <Chip active={filter === 'below'} onClick={() => setFilter('below')} count={lowCount}>
        {t.filters.low}
      </Chip>
      <Chip active={filter === 'variance'} onClick={() => setFilter('variance')} count={varianceCount}>
        {t.filters.gap}
      </Chip>
      <Chip active={filter === 'stale'} onClick={() => setFilter('stale')} count={staleCount}>
        {t.filters.stale(COUNT_TRUST_DAYS)}
      </Chip>
    </>
  );

  const left = selected ? selected.availableUnits - draftUnits : 0;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
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

          One tile per row on a phone: two columns of a 2rem figure plus a
          delta line left the delta wrapping to four lines and the dispatch
          sparkline sitting on top of its own eyebrow. */}
      <TileRow className="grid-cols-1 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:grid-cols-2 sm:[&>*]:border-b-0 sm:[&>*]:border-r xl:grid-cols-4">
        {/* Booked against crusher runs, all shifts. */}
        <KpiTile
          eyebrow={t.tiles.made}
          value={u.units(formatQty(trade.producedUnits, 1))}
          delta={{ text: t.tiles.madeNote }}
          asOf="14:42"
          source="v_production_daily"
          freshness="materialised"
        />
        <div className="relative">
          <KpiTile
            eyebrow={t.tiles.sent}
            value={u.units(formatQty(trade.dispatchedUnits, 1))}
            delta={{ text: t.tiles.trips(trade.activeTrips) }}
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
        {/* A grown stockpile must be findable on the ground; a shrunk one means
            more left the yard than was made, and is reconciled against opening
            stock today. */}
        <KpiTile
          eyebrow={t.tiles.net}
          hero
          value={u.units(`${trade.gapUnits > 0 ? '+' : ''}${formatQty(trade.gapUnits, 1)}`)}
          delta={{
            text: trade.gapUnits > 0 ? t.tiles.up : trade.gapUnits < 0 ? t.tiles.down : t.tiles.even,
            tone: trade.gapUnits < 0 ? 'critical' : Math.abs(trade.gapUnits) > 40 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_produced_dispatched_invoiced"
        />
        {/* Unexplained since the last physical count. */}
        <KpiTile
          eyebrow={t.tiles.gap}
          value={u.units(formatQty(varianceTotal, 1))}
          delta={{
            text: t.tiles.gapNote(varianceCount, VARIANCE_TOLERANCE_UNITS),
            tone: varianceCount > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_stock_count_variance"
          freshness="stale"
        />
      </TileRow>

      {starving && !dismissed && filter === 'all' ? (
        <div className="px-6 pt-4">
          <SuggestionStrip onApply={() => setFilter('below')} onDismiss={() => setDismissed(true)} applyLabel={t.showLow}>
            {t.starving(starving.productLabel, starving.siteName, formatQty(starving.safetyUnits - starving.availableUnits, 1))}
          </SuggestionStrip>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-6 xl:grid-cols-2">
        <Section caption={t.bars.caption} title={t.bars.title}>
          {barRows.length === 0 ? (
            <Note>{t.bars.none}</Note>
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
                        ? t.bars.allAbove(barRows.length)
                        : t.bars.someBelow(
                            lowCount,
                            rows.length,
                            barRows[0]?.chartLabel ?? '',
                            formatQty(Math.abs((barRows[0]?.availableUnits ?? 0) - (barRows[0]?.safetyUnits ?? 0)), 1),
                          )
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
              <ChartCaption>{t.bars.pick}</ChartCaption>
            </>
          )}
        </Section>

        <Section
          title={focused ? t.flow.title(focused.productLabel) : t.flow.titleNone}
          actions={<AsOfStamp asOf="14:42" source="v_stock_movement_today" freshness="live" />}
        >
          {focused ? (
            <>
              {/* Six steps under 400px puts "Sent" on top of "Closing". The
                  waterfall keeps its step width and scrolls in its own box
                  rather than being read as one smeared axis. Opening is
                  back-computed from where the pile stands now, so it moves the
                  moment the weighbridge does. */}
              <div className="overflow-x-auto">
                <div className="min-w-[440px]">
                  <WaterfallChart
                    summary={t.flow.summary(
                      focused.productLabel,
                      formatQty(focused.bookUnits - focused.producedUnits + focused.dispatchedUnits, 1),
                      formatQty(focused.producedUnits, 1),
                      formatQty(focused.dispatchedUnits, 1),
                      formatQty(focused.availableUnits, 1),
                    )}
                    height={220}
                    format={(v) => formatQty(v, 0)}
                    steps={waterfallSteps(focused, t)}
                  />
                </div>
              </div>
              {/* The promised step is not a movement — nothing has left the
                  yard against it yet. */}
              {focused.promisedUnits > 0 ? <ChartCaption>{t.flow.promisedNote}</ChartCaption> : null}
            </>
          ) : (
            <Note>{t.flow.none}</Note>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-2 xl:grid-cols-2">
        <Section caption={t.mix.caption} title={t.mix.title}>
          <ProportionBar
            summary={
              mix.length === 0
                ? t.mix.empty
                : t.mix.summary(mix[0]?.label ?? '', Math.round(((mix[0]?.value ?? 0) / (mixTotal || 1)) * 100))
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
          <ChartCaption>{t.mix.note}</ChartCaption>
        </Section>

        <Section caption={t.trend.caption} title={t.trend.title}>
          <TrendChart
            data={netSeries}
            summary={t.trend.summary(shrinkDays)}
            seriesLabel={t.trend.series}
            // The zero line is labelled with its number: a word there ran into
            // the line in Tamil, and "0" says "no change" in both languages.
            benchmark={{ value: 0, label: '0' }}
            flagBelow={0}
            height={170}
            format={(v) => `${v > 0 ? '+' : ''}${formatQty(v, 0)}`}
          />
          <ChartCaption>{t.trend.note}</ChartCaption>
        </Section>
      </div>

      <div id="list" />
      <Section
        caption={t.table.caption}
        title={t.table.title}
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
          empty={<EmptyState fact={t.table.empty} action={{ label: t.table.showAll, onClick: () => setFilter('all') }} />}
        />

        {/* Footnote, not a tooltip. The factor is the number two teams once
            disagreed on by 15% on every load billed. */}
        <p className="font-serif mx-6 mt-3 max-w-[80ch] text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
          {t.table.footnote}
          {promisedTotal > 0 ? ` ${t.table.promisedHere(formatQty(promisedTotal, 1))}` : ''}
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
                label: t.status[selected.family],
                severity:
                  selected.availableUnits < selected.safetyUnits
                    ? formatQty(selected.availableUnits - selected.safetyUnits, 0)
                    : undefined,
                // A position resting on a month-old count is asserted, not verified.
                provisional: selected.countAgeDays > COUNT_TRUST_DAYS,
              }
            : undefined
        }
        revision={selected ? t.sheet.counted(formatDate(selected.lastCountedOn)) : undefined}
        footer={
          selected ? (
            <PromiseBar
              row={selected}
              draftUnits={draftUnits}
              mayPromise={mayPromise}
              t={t}
              onLess={() => setDraftUnits(Math.max(1, draftUnits - 1))}
              onMore={() => setDraftUnits(draftUnits + 1)}
              onPromise={() => requestPromise(selected)}
              onRelease={() => setConfirm('release')}
            />
          ) : undefined
        }
      >
        {selected ? <StockDetail row={selected} t={t} u={u} /> : null}
      </SideSheet>

      {/* The two commitments that hurt someone downstream, each with its own
          arithmetic stated before the click, not after. */}
      <ConfirmModal
        open={confirm === 'promise' && selected !== undefined}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (selected) commitPromise(selected);
        }}
        title={t.belowMin.title}
        confirmLabel={t.sheet.promiseUnits(draftUnits)}
        destructive={selected !== undefined && left <= 0}
        consequence={
          selected ? (
            <>
              <p>{t.belowMin.canSell(selected.productLabel, formatQty(selected.availableUnits, 1))}</p>
              {/* Nothing left means the next tipper routed here finds an empty
                  pile. A month-old count means this is book stock rather than a
                  measured heap. */}
              <p className="mt-2">
                {t.belowMin.after(formatQty(left, 1), formatQty(selected.safetyUnits, 0))}{' '}
                {left <= 0 ? t.belowMin.empty : t.belowMin.below(formatQty(selected.safetyUnits - left, 1))}
              </p>
              {selected.countAgeDays > COUNT_TRUST_DAYS ? <p className="mt-2">{t.belowMin.stale(selected.countAgeDays)}</p> : null}
            </>
          ) : null
        }
      />

      {/* Released units can be sold by any coordinator within seconds; if a
          customer was told the material is held, someone has to tell them. */}
      <ConfirmModal
        open={confirm === 'release' && selected !== undefined}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (selected) releasePromise(selected);
        }}
        title={t.release.title}
        confirmLabel={t.release.confirm}
        destructive
        consequence={selected ? t.release.body(formatQty(selected.promisedUnits, 1), selected.productLabel) : null}
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
function waterfallSteps(row: StockRow, t: Words) {
  const opening = Math.round((row.bookUnits - row.producedUnits + row.dispatchedUnits) * 10) / 10;
  const base = [
    { label: t.flow.opening, delta: opening, total: true },
    { label: t.flow.made, delta: row.producedUnits },
    { label: t.flow.sent, delta: -row.dispatchedUnits },
    { label: t.flow.closing, delta: 0, total: true },
  ];
  return row.promisedUnits > 0
    ? [...base, { label: t.flow.promised, delta: -row.promisedUnits }, { label: t.flow.canSell, delta: 0, total: true }]
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
  t,
  onLess,
  onMore,
  onPromise,
  onRelease,
}: {
  row: StockRow;
  draftUnits: number;
  mayPromise: boolean;
  t: Words;
  onLess: () => void;
  onMore: () => void;
  onPromise: () => void;
  onRelease: () => void;
}) {
  if (!mayPromise) {
    return (
      <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }} title={PROMISE_PERMISSION}>
        {t.sheet.viewOnly}
      </span>
    );
  }

  const overdrawn = draftUnits > row.availableUnits;

  /**
   * The sheet footer is one 56px row and, on a phone, 335px wide. Stepper plus
   * commit plus release plus a warning does not fit that line, so: the stepper
   * and the release keep their intrinsic width, the commit takes what is left,
   * the commit and release drop their quantity words below `sm` (the figures
   * they repeat are both on the row above), and the overdrawn warning rides
   * directly above the bar rather than being squeezed into it.
   */
  return (
    <div className="relative flex w-full min-w-0 items-center gap-2">
      {/* 44px square either way; the inner span centres the glyph whatever the
          button's own alignment is on a desk. */}
      <Button className="w-11 shrink-0" onClick={onLess} aria-label={t.sheet.less}>
        <span className="flex-1 text-center">−</span>
      </Button>
      <span className="num w-8 shrink-0 text-center text-[15px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {draftUnits}
      </span>
      <Button className="w-11 shrink-0" onClick={onMore} aria-label={t.sheet.more}>
        <span className="flex-1 text-center">+</span>
      </Button>
      <Button
        className="min-w-0 flex-1 whitespace-nowrap [@media(hover:hover)]:flex-none"
        variant="primary"
        disabled={overdrawn}
        onClick={onPromise}
      >
        <span className="sm:hidden">{t.sheet.promise(draftUnits)}</span>
        <span className="hidden sm:inline">{t.sheet.promiseUnits(draftUnits)}</span>
      </Button>
      {row.promisedUnits > 0 ? (
        <Button className="shrink-0 whitespace-nowrap" variant="destructive" onClick={onRelease}>
          {t.sheet.release}
          <span className="hidden sm:inline">&nbsp;{formatQty(row.promisedUnits, 1)}</span>
        </Button>
      ) : null}
      {overdrawn ? (
        <span
          className="font-serif absolute inset-x-0 bottom-full -mx-5 px-5 pb-1 text-[12px] italic sm:static sm:mx-0 sm:px-0 sm:pb-0"
          style={{ color: 'var(--status-attention)', background: 'var(--surface-raised)' }}
        >
          {t.sheet.tooMuch}
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
function StockDetail({ row, t, u }: { row: StockRow; t: Words; u: Units }) {
  const opening = Math.round((row.bookUnits - row.producedUnits + row.dispatchedUnits) * 10) / 10;
  const flaggedVariance = Math.abs(row.varianceUnits) > VARIANCE_TOLERANCE_UNITS;

  return (
    <>
      <SheetSection caption={t.sheet.stock}>
        <DetailGrid>
          <Detail label={t.sheet.canSellNow}>
            <QuantityCell value={row.availableUnits} decimals={1} uom={u.unit} />
          </Detail>
          {/* Book stock, before anything promised today. */}
          <Detail label={t.sheet.total}>
            <QuantityCell value={row.bookUnits} decimals={1} uom={u.unit} />
          </Detail>
          {/* Promised and not yet loaded — hatched, because it is asserted. */}
          <Detail label={t.sheet.promised}>
            {row.promisedUnits === 0 ? (
              <QuantityCell value={0} decimals={1} uom={u.unit} />
            ) : (
              <Provisional>
                <QuantityCell value={row.promisedUnits} decimals={1} uom={u.unit} />
              </Provisional>
            )}
          </Detail>
          <Detail label={t.sheet.inTonnes}>
            <QuantityCell value={row.tonnesAtHand} decimals={1} uom={u.tonne} />
          </Detail>
          <Detail label={t.sheet.minimum}>
            <QuantityCell value={row.safetyUnits} decimals={0} uom={u.unit} />
          </Detail>
          {/* Days of cover is unknowable rather than infinite when nothing went
              out today — there is no rate to divide by, which is not the same
              as having plenty. */}
          <Detail label={t.sheet.daysLeft}>
            {row.coverDays === null ? t.sheet.nothingSent : u.days(formatQty(row.coverDays, 1))}
          </Detail>
        </DetailGrid>
      </SheetSection>

      {/* The conversion, worked. This is the sentence that ends the argument:
          never weighed, computed from the density held in master data, and an
          assumed density is how a fifteen per cent argument starts. */}
      <SheetSection caption={t.sheet.tonnes}>
        <DetailGrid>
          <Detail label={t.sheet.oneUnit}>{t.sheet.cubicFeet}</Detail>
          <Detail label={t.sheet.perUnit}>{row.factor === null ? '–' : u.tonnes(formatQty(row.factor, 2))}</Detail>
          <Detail label={t.sheet.sum} wide>
            <span className="num tabular-nums">
              {u.units(formatQty(row.availableUnits, 1))} × {row.factor === null ? '–' : formatQty(row.factor, 2)} ={' '}
              {row.tonnesAtHand === null ? '–' : u.tonnes(formatQty(row.tonnesAtHand, 1))}
            </span>
          </Detail>
        </DetailGrid>
        <Note>{row.factor === null ? t.sheet.noFactor : t.sheet.worked}</Note>
      </SheetSection>

      <SheetSection caption={t.sheet.today}>
        {/* The sheet is the full width of the phone, which is still narrower
            than six labelled steps. Same treatment as the board chart. */}
        <div className="overflow-x-auto">
          <div className="min-w-[420px]">
            <WaterfallChart
              summary={t.flow.summary(
                row.productLabel,
                formatQty(opening, 1),
                formatQty(row.producedUnits, 1),
                formatQty(row.dispatchedUnits, 1),
                formatQty(row.availableUnits, 1),
              )}
              height={190}
              format={(v) => formatQty(v, 0)}
              steps={waterfallSteps(row, t)}
            />
          </div>
        </div>
      </SheetSection>

      {/* Control. Past ±5 units a count difference stops being loader rounding
          and nobody has accounted for it; past a fortnight a count stops being
          evidence and becomes a memory, so walk the yard before committing a
          large order. */}
      <SheetSection caption={t.sheet.count}>
        <DetailGrid>
          <Detail label={t.sheet.lastCounted}>
            <span className="num tabular-nums">{formatDate(row.lastCountedOn)}</span> · {u.daysAgo(row.countAgeDays)}
          </Detail>
          <Detail label={t.sheet.gap}>
            <span className="num tabular-nums" style={flaggedVariance ? { color: 'var(--status-attention)' } : undefined}>
              {u.units(formatQty(row.varianceUnits, 1))}
            </span>
          </Detail>
        </DetailGrid>
        <Note>
          {!flaggedVariance
            ? t.sheet.matches
            : row.varianceUnits < 0
              ? t.sheet.short(formatQty(Math.abs(row.varianceUnits), 1))
              : t.sheet.over(formatQty(Math.abs(row.varianceUnits), 1))}
        </Note>
        {row.countAgeDays > COUNT_TRUST_DAYS ? (
          <p className="font-serif mt-2 text-[13px] italic" style={{ color: 'var(--status-attention)' }}>
            {t.sheet.stale(row.countAgeDays)}
          </p>
        ) : null}
      </SheetSection>

      {/* A promise holds the units off the sellable figure immediately, so two
          coordinators cannot sell the same pile twice. It is not a dispatch
          and nothing is written to the ledger. */}
      <SheetSection caption={t.sheet.promiseCaption}>
        <Note>{t.sheet.promiseNote}</Note>
      </SheetSection>
    </>
  );
}

/** Colour is spent per cell, never per column, so the tint lives at the call site. */
function tinted(color: string | undefined, node: ReactNode): ReactNode {
  return <span style={color ? { color } : undefined}>{node}</span>;
}

/**
 * The board's columns. Units first — every column to the right of "can sell"
 * is derived from it — with the status straight after, so a desk that cannot
 * fit twelve columns still shows whether a pile can be sold without a sideways
 * scroll.
 */
function buildColumns(showSite: boolean, t: Words, u: Units): Column<StockRow>[] {
  const site: Column<StockRow>[] = showSite
    ? [{ key: 'site', header: t.columns.site, width: 168, render: (r) => r.siteName }]
    : [];

  return [
    {
      key: 'product', header: t.columns.product, sticky: true, width: 188,
      render: (r) => <Stacked primary={r.productLabel} secondary={<IdCell>{r.productCode}</IdCell>} />,
    },
    ...site,
    {
      key: 'available', header: t.columns.canSell, unit: u.unit, type: 'num', width: 116,
      render: (r) => <QuantityCell value={r.availableUnits} decimals={1} />,
    },
    {
      key: 'status', header: t.columns.status, type: 'status',
      render: (r) => (
        <StatusStamp
          status={r.family}
          label={t.status[r.family]}
          // The integer that carries the severity: units short of safety.
          severity={r.availableUnits < r.safetyUnits ? formatQty(r.availableUnits - r.safetyUnits, 0) : undefined}
          fillRatio={Math.max(0, Math.min(1, r.availableUnits / r.safetyUnits))}
          // A position resting on a month-old count is asserted, not verified.
          provisional={r.countAgeDays > COUNT_TRUST_DAYS}
        />
      ),
    },
    {
      key: 'tonnes', header: t.columns.tonnes, type: 'num', width: 100,
      render: (r) => tinted('var(--text-secondary)', <QuantityCell value={r.tonnesAtHand} decimals={1} />),
    },
    // The factor rides on every row so the units-versus-tonnes argument cannot restart.
    {
      key: 'factor', header: t.columns.perUnit, type: 'num', width: 104,
      render: (r) => tinted('var(--text-tertiary)', <QuantityCell value={r.factor} decimals={2} />),
    },
    {
      key: 'produced', header: t.columns.made, unit: u.unit, type: 'num', width: 112,
      render: (r) => <QuantityCell value={r.producedUnits} decimals={1} />,
    },
    {
      key: 'dispatched', header: t.columns.sent, unit: u.unit, type: 'num', width: 116,
      render: (r) => <QuantityCell value={r.dispatchedUnits} decimals={1} />,
    },
    {
      key: 'promised', header: t.columns.promised, unit: u.unit, type: 'num', width: 112,
      // Promised is asserted, not true — nothing has moved until a load is raised.
      render: (r) =>
        r.promisedUnits === 0
          ? tinted('var(--text-tertiary)', <QuantityCell value={0} decimals={1} />)
          : <Provisional><QuantityCell value={r.promisedUnits} decimals={1} /></Provisional>,
    },
    {
      key: 'cover', header: t.columns.daysLeft, type: 'num', width: 90,
      // Null, not zero: nothing dispatched today makes the rate unknowable, and
      // an en dash says that where a 0 would lie about it.
      render: (r) =>
        r.coverDays === null ? null : tinted(r.coverDays < 1 ? 'var(--status-attention)' : undefined, <QuantityCell value={r.coverDays} decimals={1} />),
    },
    {
      key: 'variance', header: t.columns.gap, unit: u.unit, type: 'num', width: 140,
      // The shrinkage signal. Past ±5 units it stops being loader rounding and
      // says so in words, on the row, without a hover.
      render: (r) => {
        const flagged = Math.abs(r.varianceUnits) > VARIANCE_TOLERANCE_UNITS;
        return (
          <Stacked
            primary={tinted(flagged ? 'var(--status-attention)' : undefined, <QuantityCell value={r.varianceUnits} decimals={1} />)}
            secondary={flagged ? tinted('var(--status-attention)', t.columns.checkIt) : null}
          />
        );
      },
    },
    {
      key: 'counted', header: t.columns.counted, width: 132,
      render: (r) => (
        <Stacked
          primary={<span className="num tabular-nums">{formatDate(r.lastCountedOn)}</span>}
          secondary={tinted(
            r.countAgeDays > COUNT_TRUST_DAYS ? 'var(--status-attention)' : undefined,
            <span className="num tabular-nums">{u.daysAgo(r.countAgeDays)}</span>,
          )}
        />
      ),
    },
  ];
}
