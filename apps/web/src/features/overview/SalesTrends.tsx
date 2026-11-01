import { useMemo, useState } from 'react';
import {
  changePct,
  formatQty,
  monthOf,
  planPeriod,
  ratePerUnit,
  salesByCustomer,
  salesByMaterial,
  salesOverTime,
  TREND_PERIODS,
  type CustomerTrend,
  type MaterialTrend,
  type PeriodPlan,
  type SalesAmount,
  type TrendPeriod,
  type TrendPoint,
} from '@linck/domain';
import { CUSTOMERS_LIST, NOW, PRODUCTS, SALES_HISTORY, SALES_HISTORY_FROM, SALES_HISTORY_TO } from '@linck/mock';
import {
  AsOfStamp,
  ChartCaption,
  Chip,
  DataTable,
  EmptyState,
  KpiTile,
  PageHeader,
  Section,
  Sparkline,
  StatusStamp,
  TileRow,
  type Column,
} from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { shortName } from '../sales/shortName.js';
import { useSalesFormat, type SalesFormat } from './salesFormat.js';
import { trendWords, type TrendText } from './salesTrendWords.js';
import { YearKey, YearOnYearChart } from './YearOnYearChart.js';

/**
 * SALES TRENDS (LIN-7) — the director's sales by time, by customer and by
 * material, each against the same days a year earlier.
 *
 * Three views and one choice of period. Tapping a customer narrows the other
 * two views to that customer; tapping a material narrows them to that
 * material; the chips at the top undo either. Nothing else is clever.
 *
 * Every figure comes from `SALES_HISTORY` through the pure functions in
 * `@linck/domain/sales-trends` — the screen only words and draws them. In the
 * real system the rows are the daily sales roll-up, `v_sales_daily`.
 *
 * Comparisons are like for like: the history starts in February 2025, so the
 * 12-month view compares only the months that have a year-earlier record, and
 * says how many. Comparing twelve months with six would print a fall that
 * never happened.
 *
 * Colour is spent on two things only: a customer who stopped buying, and one
 * whose sales fell sharply. A rise is good news, not an alert.
 */

const customerName = (id: string) => CUSTOMERS_LIST.find((c) => c.id === id)?.name ?? id;
/** Material names (M-Sand, 20mm Aggregate) are the trade's own and are not translated. */
const productName = (code: string) => PRODUCTS.find((p) => p.code === code)?.label ?? code;
const rupees = (value: string) => Number.parseFloat(value);
const rounded = (pct: number | null) => (pct === null ? null : Math.round(pct));

/** A fall this large on last year spends the attention colour on the change itself. */
const SHARP_FALL_PCT = 40;

type Measure = 'value' | 'units';

export function SalesTrends() {
  const { siteScope, density } = useApp();
  const t = useWords(trendWords);
  const f = useSalesFormat();
  const [period, setPeriodParam] = useViewParam<TrendPeriod>(TREND_PERIODS, '3m');
  const [measure, setMeasure] = useState<Measure>('value');
  const [customer, setCustomer] = useState<string | null>(null);
  const [material, setMaterial] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const plan = useMemo(() => planPeriod(period, SALES_HISTORY_TO, SALES_HISTORY_FROM), [period]);
  const overTime = useMemo(
    () => salesOverTime(SALES_HISTORY, plan, { siteId: siteScope, customerId: customer, productCode: material }),
    [plan, siteScope, customer, material],
  );
  // Each list is narrowed by the OTHER pick, never by its own: the customer
  // list still shows every customer when one is picked, with that one marked.
  const customers = useMemo(
    () => salesByCustomer(SALES_HISTORY, plan, SALES_HISTORY_TO, { siteId: siteScope, productCode: material }),
    [plan, siteScope, material],
  );
  const materials = useMemo(
    () => salesByMaterial(SALES_HISTORY, plan, { siteId: siteScope, customerId: customer }),
    [plan, siteScope, customer],
  );

  const setPeriod = (next: TrendPeriod) => {
    setActive(null);
    setPeriodParam(next);
  };

  const compared = overTime.compared;
  // Part of the period has no year-earlier record: say how much was compared.
  const part = compared && compared.buckets < compared.of ? { count: compared.buckets, grain: plan.grain } : null;
  const tileChange = (pct: number | null) => (compared === null || pct === null ? t.noRecord : t.change(Math.round(pct), part));
  const rateNow = ratePerUnit(overTime.total);
  const rateChange =
    compared === null
      ? null
      : (() => {
          const now = ratePerUnit(compared.now);
          const before = ratePerUnit(compared.lastYear);
          return now === null || before === null ? null : changePct(rupees(now), rupees(before));
        })();

  const chartData = overTime.points.map((p) => ({
    label: pointLabel(p, plan, f),
    now: measure === 'value' ? rupees(p.now.value) : p.now.units,
    lastYear: p.lastYear === null ? null : measure === 'value' ? rupees(p.lastYear.value) : p.lastYear.units,
  }));
  const shown = active !== null && active < overTime.points.length ? active : overTime.points.length - 1;
  const shownPoint = overTime.points[shown];
  const amountText = (a: SalesAmount) => (measure === 'value' ? f.money(a.value) : t.unitsN(formatQty(a.units, 0)));
  const chartLine =
    compared === null
      ? t.overTime.nothingToCompare
      : measure === 'value'
        ? compared.valuePct === null
          ? t.overTime.nothingToCompare
          : t.overTime.sales(Math.round(compared.valuePct), part)
        : compared.unitsPct === null
          ? t.overTime.nothingToCompare
          : t.overTime.unitsLine(Math.round(compared.unitsPct), part);

  const stoppedN = customers.filter((c) => c.flag === 'stopped').length;
  const fellN = customers.filter((c) => c.flag === 'fell').length;
  const topCustomer = customers[0];
  const topMaterial = materials[0];
  const nothing = overTime.total.units === 0 && customers.length === 0;

  const customerColumns = useMemo(() => customerTable(t, f), [t, f]);
  const materialColumns = useMemo(() => materialTable(t, f), [t, f]);

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        meta={
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {t.span(
                plan.grain === 'month' ? f.monthYear(monthOf(plan.span.from)) : f.dayMonthYear(plan.span.from),
                plan.grain === 'month' ? f.monthYear(monthOf(plan.span.to)) : f.dayMonthYear(plan.span.to),
              )}
            </span>
            <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              {plan.grain === 'month' ? t.againstMonths : t.againstDays}
            </span>
            {/* From the daily sales roll-up, v_sales_daily. */}
            <AsOfStamp asOf={f.time(NOW)} source={t.source} freshness="materialised" />
          </span>
        }
        actions={TREND_PERIODS.map((p) => (
          <Chip key={p} active={period === p} onClick={() => setPeriod(p)}>
            {t.periods[p]}
          </Chip>
        ))}
      />

      {customer || material ? (
        <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
          <span className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
            {t.only}
          </span>
          {customer ? (
            <Chip active onClick={() => setCustomer(null)}>
              {t.clear(shortName(customerName(customer)))}
            </Chip>
          ) : null}
          {material ? (
            <Chip active onClick={() => setMaterial(null)}>
              {t.clear(productName(material))}
            </Chip>
          ) : null}
          <button
            type="button"
            className="h-10 px-2 text-[13px] font-medium [@media(hover:hover)]:h-8"
            style={{ color: 'var(--brand)' }}
            onClick={() => {
              setCustomer(null);
              setMaterial(null);
            }}
          >
            {t.showAll}
          </button>
        </div>
      ) : null}

      {nothing ? (
        // A site with no crusher sells nothing: the workshop, the quarry.
        <EmptyState fact={t.empty} because={t.emptyWhy} />
      ) : (
        <>
          {/* One tile a row on a phone, three abreast from `sm`, as on the dashboard. */}
          <TileRow className="mt-4 grid-cols-1 sm:grid-cols-3 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
            <KpiTile
              eyebrow={t.tiles.sales}
              hero
              value={f.money(overTime.total.value)}
              title={f.moneyExact(overTime.total.value)}
              delta={{ text: tileChange(compared?.valuePct ?? null), tone: fallTone(compared?.valuePct ?? null) }}
              asOf={f.time(NOW)}
              source={t.source}
              freshness="materialised"
            />
            <KpiTile
              eyebrow={t.tiles.units}
              value={formatQty(overTime.total.units, 0)}
              delta={{ text: tileChange(compared?.unitsPct ?? null), tone: fallTone(compared?.unitsPct ?? null) }}
              asOf={f.time(NOW)}
              source={t.source}
              freshness="materialised"
            />
            {/* Rupees per unit across everything sold: price and mix together. */}
            <KpiTile
              eyebrow={t.tiles.rate}
              value={rateNow === null ? '–' : f.moneyExact(rateNow)}
              delta={{ text: tileChange(rateChange) }}
              asOf={f.time(NOW)}
              source={t.source}
              freshness="materialised"
            />
          </TileRow>

          <Section
            caption={plan.grain === 'day' ? t.overTime.byDay : plan.grain === 'week' ? t.overTime.byWeek : t.overTime.byMonth}
            title={t.overTime.title}
            actions={
              <>
                <Chip active={measure === 'value'} onClick={() => setMeasure('value')}>
                  {t.overTime.amount}
                </Chip>
                <Chip active={measure === 'units'} onClick={() => setMeasure('units')}>
                  {t.overTime.units}
                </Chip>
              </>
            }
          >
            <div className="px-6">
              <YearKey thisYear={t.overTime.thisYear} lastYear={t.overTime.lastYear} />
              <YearOnYearChart
                data={chartData}
                summary={chartLine}
                format={(v) => (measure === 'value' ? f.money(v) : formatQty(v, 0))}
                active={shown}
                onActive={setActive}
              />
              {shownPoint ? (
                <p className="num mt-1 text-[13px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {t.overTime.point(pointWhen(shownPoint, plan, t, f), amountText(shownPoint.now))}
                  {shownPoint.lastYear !== null ? ` · ${t.overTime.pointLastYear(amountText(shownPoint.lastYear))}` : ''}
                </p>
              ) : null}
              <p className="mt-2 text-[15px]" style={{ color: 'var(--text-primary)' }}>
                {chartLine}
              </p>
              {overTime.points.some((p) => p.lastYear === null) ? (
                <ChartCaption>{t.overTime.noRecordBefore(f.monthYear(monthOf(SALES_HISTORY_FROM)))}</ChartCaption>
              ) : null}
              {/* Half a shift and most lorries standing: Sundays run at about a third. */}
              {plan.grain === 'day' ? <ChartCaption>{t.overTime.sundays}</ChartCaption> : null}
            </div>
          </Section>

          <Section caption={t.customers.caption} title={t.customers.title}>
            <DataTable
              density={density}
              columns={customerColumns}
              rows={customers}
              rowKey={(c) => c.customerId}
              selectedKey={customer ?? undefined}
              onRowClick={(c) => setCustomer((prev) => (prev === c.customerId ? null : c.customerId))}
              rail={(c) =>
                c.flag === 'stopped' ? { status: 'critical' } : c.flag === 'fell' ? { status: 'attention' } : undefined
              }
              empty={<EmptyState fact={t.empty} />}
            />
            <div className="px-6 pt-2">
              {stoppedN > 0 || fellN > 0 ? (
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {[stoppedN > 0 ? t.customers.stoppedN(stoppedN) : null, fellN > 0 ? t.customers.fellN(fellN) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
              {topCustomer && topCustomer.sharePct > 0 ? (
                <ChartCaption>{t.customers.top(customerName(topCustomer.customerId), Math.round(topCustomer.sharePct))}</ChartCaption>
              ) : null}
            </div>
          </Section>

          <Section caption={t.materials.caption} title={t.materials.title}>
            <DataTable
              density={density}
              columns={materialColumns}
              rows={materials}
              rowKey={(m) => m.productCode}
              selectedKey={material ?? undefined}
              onRowClick={(m) => setMaterial((prev) => (prev === m.productCode ? null : m.productCode))}
              empty={<EmptyState fact={t.empty} />}
            />
            <div className="px-6 pt-2">
              {topMaterial && topMaterial.unitsSharePct > 0 ? (
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {t.materials.top(productName(topMaterial.productCode), Math.round(topMaterial.unitsSharePct))}
                </p>
              ) : null}
              {/* Units, not tonnes — the trade settles in units of 100 cft. */}
              <ChartCaption>{t.materials.unitNote}</ChartCaption>
            </div>
          </Section>
        </>
      )}

      <div className="h-10" />
    </>
  );
}

/** Only a sharp fall spends colour; a rise and a small dip are just facts. */
function fallTone(pct: number | null): 'attention' | 'neutral' {
  return pct !== null && pct <= -SHARP_FALL_PCT ? 'attention' : 'neutral';
}

/** The axis label: `08 Aug` for a day or the last day of a week, `Aug` for a month. */
function pointLabel(p: TrendPoint, plan: PeriodPlan, f: SalesFormat): string {
  return plan.grain === 'month' ? f.month(p.key) : f.dayMonth(p.key);
}

/** The readout under the chart names the point in full. */
function pointWhen(p: TrendPoint, plan: PeriodPlan, t: TrendText, f: SalesFormat): string {
  if (plan.grain === 'month') return f.monthYear(p.key);
  if (plan.grain === 'week') return t.overTime.weekTo(f.dayMonth(p.key));
  return f.dayMonthYear(p.key);
}

/**
 * A figure with its change on last year beside it. One line, so a row stays
 * one row high; the change is smaller and grey unless it is a sharp fall.
 */
function WithChange({ main, title, pct, isNew, newLabel }: { main: string; title?: string; pct: number | null; isNew: boolean; newLabel: string }) {
  const r = rounded(pct);
  const sharp = r !== null && r <= -SHARP_FALL_PCT;
  return (
    <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
      <span className="num tabular-nums" {...(title ? { title } : {})}>
        {main}
      </span>
      <span className="num text-[12px] tabular-nums" style={{ color: sharp ? 'var(--status-attention)' : 'var(--text-tertiary)' }}>
        {isNew ? newLabel : r === null ? '–' : r === 0 ? '0%' : `${r > 0 ? '↑' : '↓'} ${Math.abs(r)}%`}
      </span>
    </span>
  );
}

/** A share of the whole, as a figure and a bar the same length. */
function Share({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="block h-1.5 w-14 overflow-hidden" style={{ background: 'var(--surface-sunken)' }}>
        <span className="block h-full" style={{ width: `${Math.min(100, pct)}%`, background: 'var(--chart-2)' }} />
      </span>
      <span className="num tabular-nums">{Math.round(pct)}%</span>
    </span>
  );
}

function customerTable(t: TrendText, f: SalesFormat): Column<CustomerTrend>[] {
  return [
    {
      key: 'customer',
      header: t.customers.customer,
      sticky: true,
      width: 280,
      render: (c) => (
        <span className="block whitespace-normal">
          {customerName(c.customerId)}
          {c.flag === 'stopped' && c.standing?.lastBoughtOn ? (
            <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {t.customers.lastBought(f.dayMonth(c.standing.lastBoughtOn))}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'sales',
      header: t.customers.sales,
      unit: '₹',
      type: 'money',
      width: 150,
      render: (c) => (
        <WithChange main={f.money(c.now.value)} title={f.moneyExact(c.now.value)} pct={c.valuePct} isNew={c.isNew} newLabel={t.customers.isNew} />
      ),
    },
    { key: 'share', header: t.customers.share, type: 'num', width: 130, render: (c) => <Share pct={c.sharePct} /> },
    {
      key: 'trend',
      header: t.customers.trend,
      type: 'node',
      width: 110,
      render: (c) => <Sparkline data={c.spark} width={80} height={22} tone={c.flag ? 'attention' : 'chart'} />,
    },
    {
      key: 'status',
      header: t.customers.status,
      type: 'status',
      width: 190,
      render: (c) =>
        c.flag === 'stopped' ? (
          <StatusStamp
            status="critical"
            label={t.customers.stopped}
            {...(c.standing?.daysSince !== null && c.standing?.daysSince !== undefined
              ? { severity: t.customers.days(c.standing.daysSince) }
              : {})}
          />
        ) : c.flag === 'fell' ? (
          <StatusStamp status="attention" label={t.customers.fell} />
        ) : null,
    },
  ];
}

function materialTable(t: TrendText, f: SalesFormat): Column<MaterialTrend>[] {
  return [
    { key: 'material', header: t.materials.material, sticky: true, width: 220, render: (m) => productName(m.productCode) },
    {
      key: 'units',
      header: t.materials.units,
      type: 'num',
      width: 140,
      render: (m) => <WithChange main={formatQty(m.now.units, 0)} pct={m.unitsPct} isNew={m.isNew} newLabel={t.materials.isNew} />,
    },
    {
      key: 'sales',
      header: t.materials.sales,
      unit: '₹',
      type: 'money',
      width: 150,
      render: (m) => (
        <WithChange main={f.money(m.now.value)} title={f.moneyExact(m.now.value)} pct={m.valuePct} isNew={m.isNew} newLabel={t.materials.isNew} />
      ),
    },
    // Materials have no status of their own, so the share takes the status
    // slot: on a phone it rides at the top right of the card beside the name,
    // instead of a row to itself that made nine cards a long scroll.
    { key: 'share', header: t.materials.share, type: 'status', width: 140, render: (m) => <Share pct={m.unitsSharePct} /> },
  ];
}
