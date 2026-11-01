import { useMemo, useState } from 'react';
import { formatDate, formatINR, formatQty } from '@linck/domain';
import {
  DOWNTIME_CAUSES,
  documentExposure,
  fleetCounts,
  INVOICES,
  INVOICE_STATUS_FAMILY,
  LAST_14,
  PRODUCTS,
  PRODUCT_MIX,
  receivables,
  STOCK,
  todayTrade,
  TRIPS,
  type Invoice,
  type StockPosition,
} from '@linck/mock';
import {
  AgeingBar,
  AsOfStamp,
  BarChart,
  ChartCaption,
  Chip,
  DataTable,
  Detail,
  DetailGrid,
  KpiTile,
  MoneyCell,
  Note,
  PageHeader,
  ProportionBar,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  Sparkline,
  Stacked,
  StatusStamp,
  TileRow,
  TrendChart,
  WaterfallChart,
  type Column,
} from '@linck/ui';
import { useLang } from '../../i18n/lang.js';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useDayMonth, useInrCompact } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { dashboardWords, type DowntimeCause } from './dashboardWords.js';

/**
 * The Managing Director's screen.
 *
 * Every tile carries an as-of stamp, because the fastest way to lose an
 * executive is a number they cannot trace. Where a figure is not derived from
 * the ledger — vehicles running, utilisation — the hover names the real
 * source so nobody goes hunting for uptime inside accounting. For whoever has
 * to trace them, the views are: page `v_exec_daily`, money in bank
 * `v_bank_position`, money due `v_ar_ageing`, paid-not-checked
 * `v_receipt_verification`, vehicles running `v_fleet_uptime`.
 *
 * Coloured tile backgrounds are banned here. A green revenue tile beside a red
 * cost tile makes this look like a slot machine and spends the colour budget
 * the real alerts need — which is also why every chart on this page draws from
 * the monochrome ramp and spends colour only where something is wrong.
 *
 * WORDS (LIN-23). Every word is in ./dashboardWords.ts, in English and Tamil,
 * short and plain: "Money due", not "Receivable, outstanding"; "Profit %", not
 * "Contribution margin"; "Made" and "Sent", not "Produced" and "Dispatched".
 * Each chart keeps one line under it at most — the fact that changes what the
 * owner does next. The reasoning that used to be printed is in the comments.
 */

/** The cash tile's figures, fixed here until the bank feed carries them. */
const CASH_POSITION = 8_42_00_000;
const CASH_UP_ON_LAST_WEEK = 12_40_000;

const AS_OF = '14:42';

/** The target line on the profit chart, and the point below which a day is flagged. */
const PROFIT_TARGET_PCT = 32;
const PROFIT_FLAG_BELOW_PCT = 28;

/**
 * The fleet's downtime causes, as the data names them, keyed to the screen's
 * words. A cause the screen has no words for is shown as the data names it.
 */
const CAUSE_KEY: Readonly<Record<string, DowntimeCause>> = {
  'Tyre burst / puncture': 'tyre',
  'No load allotted': 'noLoad',
  'Scheduled service': 'service',
  'Gearbox & clutch': 'gearbox',
  'Driver unavailable': 'noDriver',
  Electrical: 'electrical',
  'Document expired': 'documents',
  Hydraulics: 'hydraulics',
};

/**
 * The one cause that is not a repair — a selling problem wearing a
 * maintenance costume, which is why it is the one bar spending colour.
 */
const NO_LOAD = 'No load allotted';

type DashboardText = typeof dashboardWords.en;

function causeWords(label: string, words: Readonly<Record<DowntimeCause, string>>): string {
  const key = CAUSE_KEY[label];
  return key === undefined ? label : words[key];
}

function productLabel(code: string): string {
  return PRODUCTS.find((p) => p.code === code)?.label ?? code;
}

/** The ramp the stacked bars draw from, so a legend can match a segment's colour. */
const rampTone = (i: number) => `var(--chart-${Math.min(5, i + 1)})`;

/**
 * The floor under the waterfall's drawing width, per language.
 *
 * Its step names are SVG text, centred under each bar, and they do not wrap.
 * English names are under 50px; the Tamil ones run to 110px ("சொந்த
 * உபயோகம்"), and at the English floor they printed into each other on a
 * phone. Below the floor the chart scrolls inside its own box (see WideChart).
 */
const WATERFALL_MIN_WIDTH = { en: 460, ta: 560 } as const;

export function ExecutiveDashboard() {
  const { siteScope, density } = useApp();
  const t = useWords(dashboardWords);
  const status = useWords(statusWords);
  const lang = useLang((s) => s.lang);
  const inr = useInrCompact();
  const dayMonth = useDayMonth();
  const [range, setRange] = useState<'today' | 'fy'>('today');
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [stock, setStock] = useState<StockPosition | null>(null);

  const fleet = fleetCounts(siteScope);
  const trade = todayTrade(siteScope);
  const ar = receivables();
  const docs = documentExposure(siteScope);

  // `26 Jul` / `26 ஜூலை` — the axis speaks the reader's language too.
  const revenueSeries = LAST_14.map((d) => ({ label: dayMonth(d.date), value: d.revenue }));
  const marginPctSeries = LAST_14.map((d) => ({
    label: dayMonth(d.date),
    value: Math.round((d.margin / d.revenue) * 1000) / 10,
  }));
  const uptimeSeries = LAST_14.map((d) => ({ label: dayMonth(d.date), value: d.uptimePct }));

  const openInvoices = useMemo(
    () => INVOICES.filter((i) => i.status !== 'closed' && i.status !== 'draft'),
    [],
  );
  const stockRows = useMemo(
    () => STOCK.filter((s) => (siteScope ? s.siteId === siteScope : s.siteId === 'site-krp')),
    [siteScope],
  );

  // Produced, dispatched and invoiced never tie exactly, and the gap is the
  // point — it is what tells the MD whether material left without paper.
  const invoicedUnits = Math.round(
    TRIPS.filter((trip) => trip.invoiceId !== null).reduce((s, trip) => s + trip.soldUnits, 0) * 10,
  ) / 10;
  const ownUse =
    Math.round(TRIPS.filter((trip) => trip.purpose === 'own_use').reduce((s, trip) => s + trip.soldUnits, 0) * 10) / 10;
  const returned =
    Math.round(TRIPS.filter((trip) => trip.status === 'returned').reduce((s, trip) => s + trip.soldUnits, 0) * 10) / 10;
  const notInvoicedUnits = Math.max(0, trade.dispatchedUnits - invoicedUnits);

  const topCause = DOWNTIME_CAUSES[0];
  const topProduct = PRODUCT_MIX[0];
  const soldUnits = PRODUCT_MIX.reduce((s, p) => s + p.units, 0);

  const dueBuckets = [
    { label: t.due.notLate, value: Math.max(0, ar.outstanding - ar.overdueAmount) },
    ...ar.ageing.map((a) => ({ label: t.due.bucket(a.bucket), value: a.amount })),
  ];
  const soldSegments = PRODUCT_MIX.slice(0, 6).map((p) => ({ label: p.label, value: p.units }));
  const soldShown = soldSegments.reduce((s, p) => s + p.value, 0) || 1;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        meta={<AsOfStamp asOf={AS_OF} source={t.source.daily} freshness="materialised" />}
        actions={
          <>
            <Chip active={range === 'today'} onClick={() => setRange('today')}>
              {t.today}
            </Chip>
            {/* The financial year to date. "Since 1 April" says the same
                thing without the reader having to know what FY means. */}
            <Chip active={range === 'fy'} onClick={() => setRange('fy')}>
              {t.sinceApril}
            </Chip>
          </>
        }
      />

      {/*
        Two tiles abreast on a 375px phone leaves ~130px of measure per tile —
        narrower than the hero figure itself, and far narrower than the as-of
        stamp, which is what forced the page to scroll sideways. Below `sm` the
        tiles stack and the hairline that separated them turns from a right
        edge into a bottom one, so the rhythm survives the reflow.
      */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <KpiTile
          eyebrow={t.tiles.cash}
          hero
          value={inr(CASH_POSITION)}
          delta={{ text: t.tiles.cashUp(inr(CASH_UP_ON_LAST_WEEK)) }}
          title={formatINR(CASH_POSITION)}
          asOfInHeader
        />
        <KpiTile
          eyebrow={t.tiles.due}
          value={inr(ar.outstanding)}
          delta={{
            text: t.tiles.overdue(ar.overdueCount, inr(ar.overdueAmount)),
            tone: ar.overdueCount > 0 ? 'critical' : 'neutral',
          }}
          asOfInHeader
        />
        {/* The owner's hard rule, as a number on the MD's screen: money someone
            says arrived that a second person has not confirmed. It is counted
            as collected nowhere in this system. Named with the invoice status
            it sums, so the tile and the stamps in the list below agree. */}
        <KpiTile
          eyebrow={status.invoice.payment_reported}
          value={inr(ar.reportedUnverified)}
          delta={{ text: t.tiles.toCheck(ar.reportedUnverifiedCount), tone: 'attention' }}
          asOfInHeader
        />
        <div className="relative">
          {/* Uptime: the share of vehicles working or able to work. A planned
              service is not counted as down. The breakup reuses the vehicle
              status words, so "No work" here is "No work" on the board.
              The eyebrow keeps clear of the sparkline parked in the corner
              (sm and up): the Tamil eyebrow is long enough to run under it,
              so it wraps instead. */}
          <KpiTile
            className="sm:[&>span:first-child]:pr-[84px]"
            eyebrow={t.tiles.vehicles}
            value={`${formatQty(fleet.uptimePct, 1)}%`}
            delta={{
              text: t.tiles.vehiclesBreakup(fleet.breakdown, fleet.idle, fleet.underService),
              tone: fleet.breakdown > 0 ? 'critical' : 'neutral',
            }}
            asOfInHeader
          />
          {/*
            Parked in the tile's top-right corner on a wide screen, where there
            is dead space beside the eyebrow. On a narrow one that corner is
            occupied — the sparkline sat straight on top of the eyebrow — so
            below `sm` it drops out of the corner and back into normal flow
            under the stamp. Hiding it was the other option and would have cost
            the fourteen-day shape, which is the only trend on this tile.
          */}
          <div className="static -mt-3 px-7 pb-5 sm:absolute sm:right-7 sm:top-7 sm:mt-0 sm:px-0 sm:pb-0">
            <Sparkline data={uptimeSeries.map((p) => p.value)} width={72} height={20} />
          </div>
        </div>
      </TileRow>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-6 xl:grid-cols-2">
        <Section caption={t.last14} title={t.sales.title}>
          <div className="px-0">
            <TrendChart
              data={revenueSeries}
              summary={t.sales.summary(inr(revenueSeries.reduce((s, p) => s + p.value, 0) / revenueSeries.length))}
              seriesLabel={t.sales.series}
              height={170}
              format={inr}
            />
            {/* Sundays fall to about a quarter: the plant runs a half shift
                and most lorries stand. A weekday dip is the one to ask about. */}
            <ChartCaption>{t.sales.note}</ChartCaption>
          </div>
        </Section>

        <Section caption={t.last14} title={t.profit.title}>
          {/* Contribution margin: after diesel, batta and toll — before tyres,
              maintenance and depreciation, which are absorbed monthly. */}
          <TrendChart
            data={marginPctSeries}
            summary={t.profit.summary(
              formatQty(Math.min(...marginPctSeries.map((p) => p.value)), 1),
              formatQty(Math.max(...marginPctSeries.map((p) => p.value)), 1),
            )}
            seriesLabel={t.profit.series}
            benchmark={{ value: PROFIT_TARGET_PCT, label: t.profit.target(PROFIT_TARGET_PCT) }}
            flagBelow={PROFIT_FLAG_BELOW_PCT}
            height={170}
            format={(v) => `${formatQty(v, 0)}%`}
          />
          <ChartCaption>{t.profit.note}</ChartCaption>
        </Section>
      </div>

      {/*
        Two questions, deliberately drawn as two things.

        The waterfall reconciles STOCK: what the plant made, what left the yard,
        what is still on the ground. Invoicing cannot join that running balance,
        because a load dispatched and not yet billed has already left stock —
        adding it as a step would double-count the same units and produce a
        closing figure that is simply wrong.

        So the billing question gets its own bar underneath. Of what went out,
        how much has paper against it? That gap is the unbilled-dispatch number,
        and it is the one the adversarial review called the most valuable report
        in the business — the number nobody could produce before.
      */}
      <Section title={t.material.title}>
        <div className="px-6">
          <WideChart minWidth={WATERFALL_MIN_WIDTH[lang]}>
            <WaterfallChart
              summary={t.material.summary(
                formatQty(trade.producedUnits, 1),
                formatQty(trade.dispatchedUnits, 1),
                formatQty(trade.gapUnits, 1),
              )}
              height={230}
              format={(v) => formatQty(v, 0)}
              steps={[
                { label: t.material.made, delta: trade.producedUnits, total: true },
                { label: t.material.sent, delta: -trade.dispatchedUnits },
                // Own-use and returned loads are drawn as steps of their own,
                // so they never disappear into shrinkage and get blamed on the
                // plant supervisor.
                { label: t.material.ownUse, delta: -ownUse },
                { label: t.material.returned, delta: returned },
                { label: t.material.inStock, delta: 0, total: true },
              ]}
            />
          </WideChart>
          {/* Units, not tonnes — the trade settles in units of 100 CFT. */}
          <ChartCaption>{t.material.unitNote}</ChartCaption>

          <div className="mt-6">
            <ProportionBar
              summary={t.material.invoicedSummary(
                formatQty(invoicedUnits, 1),
                formatQty(trade.dispatchedUnits, 1),
                formatQty(notInvoicedUnits, 1),
              )}
              segments={[
                { label: t.material.invoiced, value: invoicedUnits, tone: 'var(--chart-1)' },
                { label: t.material.notInvoiced, value: notInvoicedUnits, tone: 'var(--status-attention)' },
              ]}
            />
            {/* Some lag is normal — credit customers are billed fortnightly
                against delivery challans — but this bar is where volume moving
                without paper would show up first. */}
            <ChartCaption>{t.material.creditNote}</ChartCaption>
          </div>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-2 xl:grid-cols-2">
        <Section caption={t.due.caption} title={t.due.title}>
          <AgeingBar
            summary={t.due.summary(inr(ar.outstanding), inr(ar.overdueAmount))}
            buckets={dueBuckets}
            format={inr}
          />
          <NarrowLegend
            items={dueBuckets.map((b, i) => ({ label: b.label, value: inr(b.value), tone: rampTone(i) }))}
          />
          {/* Nothing here is red — an age bucket is a fact about time, and
              spending an alert colour on it would leave nothing for the
              invoices that are actually in trouble. */}
          <ChartCaption>{t.due.darker}</ChartCaption>
        </Section>

        <Section caption={t.downtime.caption} title={t.downtime.title}>
          <WideChart minWidth={460}>
            <BarChart
              summary={topCause ? t.downtime.summary(causeWords(topCause.label, t.downtime.cause), topCause.hours) : ''}
              data={DOWNTIME_CAUSES.slice(0, 6).map((c) => ({
                label: causeWords(c.label, t.downtime.cause),
                value: c.hours,
                tone: c.label === NO_LOAD ? 'var(--status-attention)' : 'var(--chart-2)',
              }))}
              // Hours are named once, in the caption above, not on every bar.
              format={(v) => String(Math.round(v))}
              labelWidth={168}
            />
          </WideChart>
          <ChartCaption>{t.downtime.salesNotRepair(t.downtime.cause.noLoad)}</ChartCaption>
        </Section>
      </div>

      <Section caption={t.sold.caption} title={t.sold.title}>
        <div className="px-6">
          {/* Product names are the trade's own names and stay as they are. */}
          <ProportionBar
            summary={
              topProduct
                ? t.sold.summary(topProduct.label, Math.round((topProduct.units / Math.max(1, soldUnits)) * 100))
                : ''
            }
            segments={soldSegments}
          />
          <NarrowLegend
            items={soldSegments.map((s, i) => ({
              label: s.label,
              value: `${Math.round((s.value / soldShown) * 100)}%`,
              tone: rampTone(i),
            }))}
          />
        </div>
      </Section>

      <Section title={t.risk.title}>
        <div className="flex flex-wrap gap-3 px-6">
          <ExposureCard
            label={t.risk.expired}
            value={docs.expired}
            // Blocking: the expiry stops the vehicle at the gate.
            detail={t.risk.stopVehicle(docs.blocking)}
            tone={docs.expired > 0 ? 'critical' : 'ready'}
          />
          <ExposureCard label={t.risk.expiring} value={docs.expiringSoon} detail={t.risk.expiringWhat} tone="attention" />
          <ExposureCard label={t.risk.offRoad} value={fleet.offRoad} detail={t.risk.offRoadCost} tone="dormant" />
        </div>
      </Section>

      <Section title={t.invoices.title}>
        <DataTable
          density={density}
          columns={invoiceColumns(t)}
          rows={openInvoices.slice(0, 8)}
          rowKey={(i) => i.id}
          selectedKey={invoice?.id}
          onRowClick={setInvoice}
          rail={(i) => ({
            status: INVOICE_STATUS_FAMILY[i.status],
            // A 62%-paid invoice shows a 62%-filled rail. Nothing else needed.
            fillRatio: Number.parseFloat(i.receivedVerified) / Number.parseFloat(i.total),
          })}
        />
      </Section>

      <Section title={t.stock.title}>
        <DataTable
          density={density}
          columns={stockColumns(t)}
          rows={stockRows}
          rowKey={(s) => `${s.siteId}-${s.productCode}`}
          selectedKey={stock ? `${stock.siteId}-${stock.productCode}` : undefined}
          onRowClick={setStock}
          rail={(s) => ({
            status: s.units < s.safetyUnits ? 'attention' : 'ready',
            fillRatio: Math.min(1, s.units / (s.safetyUnits * 2)),
          })}
        />
      </Section>

      <div className="h-10" />

      {/* On a phone the sheet header sets the status on its own row under the
          customer's name, so the name keeps the full width. */}
      <SideSheet
        open={invoice !== null}
        onClose={() => setInvoice(null)}
        title={invoice?.customerName ?? ''}
        identifier={invoice?.number}
        {...(invoice
          ? {
              status: {
                family: INVOICE_STATUS_FAMILY[invoice.status],
                label: status.invoice[invoice.status],
                ...(invoice.daysOverdue > 0 ? { severity: t.late(invoice.daysOverdue) } : {}),
                ...(invoice.status === 'payment_reported' ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={invoice ? t.invoiceSheet.dated(formatDate(invoice.date)) : undefined}
      >
        {invoice ? <InvoiceDetail invoice={invoice} /> : null}
      </SideSheet>

      {/* The product's name is the title; its stock code means nothing to the
          reader, so the sheet does not print it. */}
      <SideSheet
        open={stock !== null}
        onClose={() => setStock(null)}
        title={stock ? productLabel(stock.productCode) : ''}
        {...(stock
          ? {
              status: {
                family: stock.units < stock.safetyUnits ? ('attention' as const) : ('ready' as const),
                label: stock.units < stock.safetyUnits ? t.stock.low : t.stock.enough,
              },
            }
          : {})}
      >
        {stock ? <StockDetail position={stock} /> : null}
      </SideSheet>
    </>
  );
}

/**
 * A chart with a floor under its drawing width.
 *
 * The waterfall and the downtime Pareto both label in SVG, and SVG text does
 * not wrap. Squeezed to a phone the waterfall's five step names run into each
 * other and the Pareto is left ~95px of bar after its 168px label gutter. So
 * they scroll inside their own box instead — the page body never moves, and
 * nothing is dropped to make the fit.
 *
 * Above the floor this is inert: no scrollbar, no change on a desk.
 */
function WideChart({ minWidth, children }: { minWidth: number; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto pb-1">
      {/* A scroll container clips its block-start edge, and the waterfall prints
          its value labels a few pixels above the plot. This keeps their
          ascenders inside. */}
      <div className="pt-1" style={{ minWidth }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The figures a stacked bar stops printing when the page gets narrow.
 *
 * A bar labels a segment only where the label fits, and on a phone most of
 * them do not — "27%" under a block, with no product name. Below `md` the
 * names and figures are listed under the bar instead, in the segments' own
 * colours. The same legend sits under the bars on Check payments.
 */
function NarrowLegend({ items }: { items: { label: string; value: string; tone: string }[] }) {
  return (
    <dl className="mt-2 flex flex-col gap-1.5 md:hidden">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-3 text-[13px]">
          <dt className="flex min-w-0 items-baseline gap-2" style={{ color: 'var(--text-secondary)' }}>
            <span aria-hidden="true" className="block h-2.5 w-2.5 shrink-0 translate-y-[1px]" style={{ background: item.tone }} />
            <span className="truncate">{item.label}</span>
          </dt>
          <dd className="num shrink-0 tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** An invoice's status: the word, the days late, and a dashed edge while the money is only reported. */
function InvoiceStamp({ invoice }: { invoice: Invoice }) {
  const t = useWords(dashboardWords);
  const status = useWords(statusWords);
  return (
    <StatusStamp
      status={INVOICE_STATUS_FAMILY[invoice.status]}
      label={status.invoice[invoice.status]}
      {...(invoice.daysOverdue > 0 ? { severity: t.late(invoice.daysOverdue) } : {})}
      // Reported-but-unchecked money is asserted, not true. Dashed border.
      {...(invoice.status === 'payment_reported' ? { provisional: true } : {})}
    />
  );
}

function ExposureCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  tone: 'critical' | 'attention' | 'ready' | 'dormant';
}) {
  const t = useWords(dashboardWords);
  // Off-road vehicles are not "OK" just because nothing is on fire; they are
  // dormant, earning nothing, and worth watching.
  const stamp = tone === 'critical' ? t.risk.urgent : tone === 'attention' ? t.risk.soon : tone === 'ready' ? t.risk.ok : t.risk.watch;
  return (
    <div
      className="min-w-[220px] flex-1 px-4 py-3"
      style={{ background: 'var(--surface)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)', borderRadius: 'var(--r-2)' }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-serif text-[14px] italic" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>
        <StatusStamp status={tone} label={stamp} />
      </div>
      <p className="num mt-1 text-[28px] leading-none tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {value}
      </p>
      <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        {detail}
      </p>
    </div>
  );
}

function InvoiceDetail({ invoice }: { invoice: Invoice }) {
  const t = useWords(dashboardWords);
  const status = useWords(statusWords);
  const verified = Number.parseFloat(invoice.receivedVerified);
  const reported = Number.parseFloat(invoice.receivedReported);
  const total = Number.parseFloat(invoice.total);

  return (
    <>
      <SheetSection caption={t.invoiceSheet.amount}>
        <DetailGrid>
          <Detail label={t.invoiceSheet.withoutGst}>
            <MoneyCell value={invoice.taxableValue} accounting={false} />
          </Detail>
          <Detail label={t.invoiceSheet.gst}>
            <MoneyCell value={invoice.gstAmount} accounting={false} />
          </Detail>
          <Detail label={t.invoiceSheet.total}>
            <MoneyCell value={invoice.total} accounting={false} />
          </Detail>
          <Detail label={t.invoiceSheet.due}>
            <MoneyCell value={invoice.balanceDue} accounting={false} />
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.invoiceSheet.payment}>
        <div className="pb-2">
          <ProportionBar
            summary={t.invoiceSheet.barSummary(formatINR(invoice.receivedVerified), formatINR(invoice.total))}
            height={22}
            segments={[
              { label: t.invoiceSheet.checked, value: verified, tone: 'var(--status-ready)' },
              ...(reported > verified
                ? [{ label: t.invoiceSheet.notChecked, value: reported - verified, tone: 'var(--status-attention)' }]
                : []),
              { label: t.invoiceSheet.due, value: Math.max(0, total - Math.max(verified, reported)), tone: 'var(--surface-sunken)' },
            ]}
          />
        </div>
        {/* Four distinct states, and they must not be collapsed. "Part-paid"
            and "nothing received" are different conversations to have with a
            customer, and an invoice sitting on unchecked money is a different
            conversation again — with your own accounts desk: until a second
            person checks it, it is counted as collected nowhere and the
            invoice stays open. */}
        {reported > verified ? (
          <Note>{t.invoiceSheet.paidNotChecked(formatINR(String(reported - verified)))}</Note>
        ) : verified >= total ? (
          <Note>{t.invoiceSheet.allPaid}</Note>
        ) : verified > 0 ? (
          <Note>{t.invoiceSheet.partPaid(formatINR(invoice.receivedVerified), formatINR(invoice.balanceDue), invoice.daysOverdue)}</Note>
        ) : (
          <Note>{t.invoiceSheet.nothingYet}</Note>
        )}
      </SheetSection>

      <SheetSection caption={t.invoiceSheet.gstPapers}>
        <DetailGrid>
          {/* The IRN, under its plain name. Below the e-invoicing limit there
              is none, and that is not a gap. */}
          <Detail label={t.invoiceSheet.eInvoice}>{invoice.irn ?? status.ewb.not_required}</Detail>
          {/* Under the e-way bill threshold none is needed. */}
          <Detail label={t.invoiceSheet.ewb}>
            {invoice.ewbNumbers.length > 0 ? invoice.ewbNumbers.join(', ') : status.ewb.not_required}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.invoiceSheet.loads(invoice.tripIds.length)}>
        {invoice.tripIds.length === 0 ? (
          // Raised directly rather than from the dispatch board.
          <Note>{t.invoiceSheet.noLoads}</Note>
        ) : (
          <ul className="text-[13px]">
            {invoice.tripIds.map((id) => {
              const trip = TRIPS.find((candidate) => candidate.id === id);
              if (!trip) return null;
              return (
                <li key={id} className="flex items-center justify-between gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <span className="font-id">{trip.tripNumber}</span>
                  <span className="text-right" style={{ color: 'var(--text-secondary)' }}>
                    {t.invoiceSheet.load(formatQty(trip.soldUnits, 1), productLabel(trip.productCode))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </SheetSection>
    </>
  );
}

function StockDetail({ position }: { position: StockPosition }) {
  const t = useWords(dashboardWords);
  const coverDays = position.dispatchedTodayUnits > 0 ? position.units / position.dispatchedTodayUnits : null;
  const opening = position.units - position.producedTodayUnits + position.dispatchedTodayUnits;

  return (
    <>
      <SheetSection caption={t.stockSheet.stock}>
        <DetailGrid>
          <Detail label={t.stockSheet.inStock}>
            <QuantityCell value={position.units} decimals={1} uom={t.units} />
          </Detail>
          <Detail label={t.stockSheet.inTonnes}>
            <QuantityCell value={position.tonnes} decimals={1} uom={t.tonnesUnit} />
          </Detail>
          {/* The safety level. */}
          <Detail label={t.stockSheet.minimum}>
            <QuantityCell value={position.safetyUnits} decimals={0} uom={t.units} />
          </Detail>
          {/* Days of cover at today's dispatch rate. */}
          <Detail label={t.stockSheet.lasts}>
            {coverDays === null ? t.stockSheet.nothingSent : t.stockSheet.days(formatQty(coverDays, 1))}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.stockSheet.today}>
        <WaterfallChart
          summary={t.stockSheet.summary(
            formatQty(opening, 1),
            formatQty(position.producedTodayUnits, 1),
            formatQty(position.dispatchedTodayUnits, 1),
          )}
          height={180}
          format={(v) => formatQty(v, 0)}
          steps={[
            { label: t.stockSheet.start, delta: opening, total: true },
            { label: t.stockSheet.made, delta: position.producedTodayUnits },
            { label: t.stockSheet.sent, delta: -position.dispatchedTodayUnits },
            { label: t.stockSheet.now, delta: 0, total: true },
          ]}
        />
      </SheetSection>

      <SheetSection caption={t.stockSheet.lastCount}>
        <Detail label={t.stockSheet.countedOn}>{formatDate(position.lastCountedOn)}</Detail>
        {/* Book stock against the last physical count. Past the tolerance and
            unexplained, the figure is book stock, not a measured pile — so the
            line says to measure it. */}
        {Math.abs(position.countVarianceUnits) > 5 ? (
          <Note>{t.stockSheet.gap(formatQty(Math.abs(position.countVarianceUnits), 1), position.countVarianceUnits < 0)}</Note>
        ) : (
          <Note>{t.stockSheet.matches}</Note>
        )}
        <div className="mt-3">
          {/* The conversion used for this product: 1 unit = 100 CFT = so many tonnes. */}
          <Detail label={t.stockSheet.oneUnit}>
            {t.stockSheet.conversion(formatQty(position.tonnes / Math.max(position.units, 0.0001), 3))}
          </Detail>
        </div>
      </SheetSection>
    </>
  );
}

function invoiceColumns(t: DashboardText): Column<Invoice>[] {
  // No column groups: "Document · Value · Standing" over six columns told the
  // reader nothing the headers did not.
  return [
    {
      key: 'number',
      header: t.invoices.invoice,
      type: 'id',
      sticky: true,
      width: 160,
      render: (i) => i.number,
    },
    { key: 'customer', header: t.invoices.customer, render: (i) => <Stacked primary={i.customerName} /> },
    { key: 'total', header: t.invoices.total, unit: '₹', type: 'money', render: (i) => <MoneyCell value={i.total} /> },
    {
      key: 'verified',
      header: t.invoices.paidChecked,
      unit: '₹',
      type: 'money',
      render: (i) => <MoneyCell value={i.receivedVerified} />,
    },
    {
      key: 'balance',
      header: t.invoices.due,
      unit: '₹',
      type: 'money',
      render: (i) => <MoneyCell value={i.balanceDue} />,
    },
    {
      key: 'status',
      header: t.invoices.status,
      type: 'status',
      width: 150,
      render: (i) => <InvoiceStamp invoice={i} />,
    },
  ];
}

function stockColumns(t: DashboardText): Column<StockPosition>[] {
  return [
    {
      key: 'product',
      header: t.stock.product,
      sticky: true,
      width: 180,
      render: (s) => productLabel(s.productCode),
    },
    { key: 'units', header: t.stock.inStock, unit: t.units, type: 'num', render: (s) => <QuantityCell value={s.units} decimals={1} /> },
    // The tonne equivalent of the units at hand.
    { key: 'tonnes', header: t.stock.tonnes, type: 'num', render: (s) => <QuantityCell value={s.tonnes} decimals={1} /> },
    {
      key: 'produced',
      header: t.stock.madeToday,
      unit: t.units,
      type: 'num',
      render: (s) => <QuantityCell value={s.producedTodayUnits} decimals={1} />,
    },
    {
      key: 'dispatched',
      header: t.stock.sentToday,
      unit: t.units,
      type: 'num',
      render: (s) => <QuantityCell value={s.dispatchedTodayUnits} decimals={1} />,
    },
    {
      // Book stock against the last physical count.
      key: 'variance',
      header: t.stock.countGap,
      unit: t.units,
      type: 'num',
      render: (s) => (
        <span style={{ color: Math.abs(s.countVarianceUnits) > 5 ? 'var(--status-attention)' : undefined }}>
          <QuantityCell value={s.countVarianceUnits} decimals={1} />
        </span>
      ),
    },
  ];
}
