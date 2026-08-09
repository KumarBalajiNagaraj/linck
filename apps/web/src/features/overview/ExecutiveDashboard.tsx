import { useMemo, useState } from 'react';
import { formatINR, formatINRCompact, formatQty } from '@linck/domain';
import {
  DOWNTIME_CAUSES,
  documentExposure,
  fleetCounts,
  INVOICES,
  INVOICE_STATUS_FAMILY,
  INVOICE_STATUS_LABEL,
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
import { useApp } from '../../shell/store.js';

/**
 * The Managing Director's screen.
 *
 * Every tile carries an as-of + source stamp, because the fastest way to lose
 * an executive is a number they cannot trace. Where a figure is not derived
 * from the ledger — fleet uptime, utilisation — the stamp names the real
 * source so nobody goes hunting for uptime inside accounting.
 *
 * Coloured tile backgrounds are banned here. A green revenue tile beside a red
 * cost tile makes this look like a slot machine and spends the colour budget
 * the real alerts need — which is also why every chart on this page draws from
 * the monochrome ramp and spends colour only where something is wrong.
 */
export function ExecutiveDashboard() {
  const { siteScope, density } = useApp();
  const [range, setRange] = useState<'today' | 'fy'>('today');
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [stock, setStock] = useState<StockPosition | null>(null);

  const fleet = fleetCounts(siteScope);
  const trade = todayTrade(siteScope);
  const ar = receivables();
  const docs = documentExposure(siteScope);

  const revenueSeries = LAST_14.map((d) => ({ label: d.label, value: d.revenue }));
  const marginPctSeries = LAST_14.map((d) => ({
    label: d.label,
    value: Math.round((d.margin / d.revenue) * 1000) / 10,
  }));
  const uptimeSeries = LAST_14.map((d) => ({ label: d.label, value: d.uptimePct }));

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
    TRIPS.filter((t) => t.invoiceId !== null).reduce((s, t) => s + t.soldUnits, 0) * 10,
  ) / 10;
  const ownUse = Math.round(TRIPS.filter((t) => t.purpose === 'own_use').reduce((s, t) => s + t.soldUnits, 0) * 10) / 10;
  const returned = Math.round(TRIPS.filter((t) => t.status === 'returned').reduce((s, t) => s + t.soldUnits, 0) * 10) / 10;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Executive dashboard"
        meta={<AsOfStamp asOf="14:42" source="v_exec_daily" freshness="materialised" />}
        actions={
          <>
            <Chip active={range === 'today'} onClick={() => setRange('today')}>
              Today
            </Chip>
            <Chip active={range === 'fy'} onClick={() => setRange('fy')}>
              This FY to date
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
          eyebrow="Cash position"
          hero
          value={formatINRCompact(8_42_00_000)}
          delta={{ text: '↑ ₹12.4 L on last week' }}
          asOf="14:42"
          source="v_bank_position"
          title="₹8,42,00,000.00"
        />
        <KpiTile
          eyebrow="Receivable, outstanding"
          value={formatINRCompact(ar.outstanding)}
          delta={{
            text: `${ar.overdueCount} invoices overdue · ${formatINRCompact(ar.overdueAmount)}`,
            tone: ar.overdueCount > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source="v_ar_ageing"
        />
        {/* The owner's hard rule, as a number on the MD's screen: money someone
            says arrived that a second person has not confirmed. It is counted
            as collected nowhere in this system. */}
        <KpiTile
          eyebrow="Reported, not yet verified"
          value={formatINRCompact(ar.reportedUnverified)}
          delta={{ text: `${ar.reportedUnverifiedCount} receipts await a second pair of eyes`, tone: 'attention' }}
          asOf="14:42"
          source="v_receipt_verification"
        />
        <div className="relative">
          <KpiTile
            eyebrow="Fleet uptime"
            value={`${formatQty(fleet.uptimePct, 1)}%`}
            delta={{
              text: `${fleet.breakdown} down · ${fleet.idle} idle · ${fleet.underService} in service`,
              tone: fleet.breakdown > 0 ? 'critical' : 'neutral',
            }}
            asOf="14:42"
            source="v_fleet_uptime"
            freshness="live"
          />
          {/*
            Parked in the tile's top-right corner on a wide screen, where there
            is dead space beside the eyebrow. On a narrow one that corner is
            occupied — the sparkline sat straight on top of "Fleet uptime" — so
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
        <Section caption="Fourteen days" title="Revenue and what is left of it">
          <div className="px-0">
            <TrendChart
              data={revenueSeries}
              summary={`Revenue over fourteen days, averaging ${formatINRCompact(
                revenueSeries.reduce((s, p) => s + p.value, 0) / revenueSeries.length,
              )} a day. Sundays fall to roughly a quarter.`}
              seriesLabel="Revenue"
              height={170}
              format={(v) => formatINRCompact(v)}
            />
            <ChartCaption>
              The dips are Sundays — the plant runs a half shift and most lorries stand. A weekday dip is the one
              worth asking about.
            </ChartCaption>
          </div>
        </Section>

        <Section caption="Fourteen days" title="Contribution margin">
          <TrendChart
            data={marginPctSeries}
            summary={`Contribution margin between ${formatQty(
              Math.min(...marginPctSeries.map((p) => p.value)),
              1,
            )}% and ${formatQty(Math.max(...marginPctSeries.map((p) => p.value)), 1)}%.`}
            seriesLabel="Margin"
            benchmark={{ value: 32, label: '32% target' }}
            flagBelow={28}
            height={170}
            format={(v) => `${formatQty(v, 0)}%`}
          />
          <ChartCaption>
            After diesel, batta and toll — before tyres, maintenance and depreciation, which are absorbed monthly.
          </ChartCaption>
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
        in the business.
      */}
      <Section caption="The number nobody can produce today" title="Where the material went">
        <div className="px-6">
          <WideChart minWidth={460}>
            <WaterfallChart
              summary={`Produced ${formatQty(trade.producedUnits, 1)} units and dispatched ${formatQty(
                trade.dispatchedUnits,
                1,
              )}, leaving ${formatQty(trade.gapUnits, 1)} on the ground.`}
              height={230}
              format={(v) => formatQty(v, 0)}
              steps={[
                { label: 'Produced', delta: trade.producedUnits, total: true },
                { label: 'Dispatched', delta: -trade.dispatchedUnits },
                { label: 'Own use', delta: -ownUse },
                { label: 'Returned', delta: returned },
                { label: 'In stock', delta: 0, total: true },
              ]}
            />
          </WideChart>
          <ChartCaption>
            Units, not tonnes — the trade settles in units of 100 CFT. Own-use loads and returned loads are drawn
            explicitly so they never disappear into shrinkage and get blamed on the plant supervisor.
          </ChartCaption>

          <div className="mt-6">
            <ProportionBar
              summary={`${formatQty(invoicedUnits, 1)} of ${formatQty(
                trade.dispatchedUnits,
                1,
              )} dispatched units carry an invoice. ${formatQty(
                Math.max(0, trade.dispatchedUnits - invoicedUnits),
                1,
              )} units have left the yard with no paper against them yet.`}
              segments={[
                { label: 'Invoiced', value: invoicedUnits, tone: 'var(--chart-1)' },
                {
                  label: 'Dispatched, not yet invoiced',
                  value: Math.max(0, trade.dispatchedUnits - invoicedUnits),
                  tone: 'var(--status-attention)',
                },
              ]}
            />
            <ChartCaption>
              Of what left the yard, how much has an invoice behind it. Some lag is normal — credit customers are
              billed fortnightly against delivery challans — but this bar is where volume moving without paper
              would show up first.
            </ChartCaption>
          </div>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-2 xl:grid-cols-2">
        <Section caption="Where the money is sitting" title="Receivables by age">
          <AgeingBar
            summary={`₹${formatQty(ar.outstanding / 100000, 1)} lakh outstanding, of which ${formatINRCompact(
              ar.overdueAmount,
            )} is past due.`}
            buckets={[
              { label: 'Not yet due', value: Math.max(0, ar.outstanding - ar.overdueAmount) },
              ...ar.ageing.map((a) => ({ label: `${a.bucket} days`, value: a.amount })),
            ]}
            format={(v) => formatINRCompact(v)}
          />
          <ChartCaption>
            Darker is older. Nothing here is red — an ageing bucket is a fact about time, and spending an alert
            colour on it would leave nothing left for the invoices that are actually in trouble.
          </ChartCaption>
        </Section>

        <Section caption="Thirty days" title="What the fleet lost time to">
          <WideChart minWidth={460}>
            <BarChart
              summary={`${DOWNTIME_CAUSES[0]?.label} cost the most downtime at ${DOWNTIME_CAUSES[0]?.hours} hours.`}
              data={DOWNTIME_CAUSES.slice(0, 6).map((c) => ({
                label: c.label,
                value: c.hours,
                tone: c.label === 'No load allotted' ? 'var(--status-attention)' : 'var(--chart-2)',
              }))}
              format={(v) => `${Math.round(v)}h`}
              labelWidth={168}
            />
          </WideChart>
          <ChartCaption>
            &ldquo;No load allotted&rdquo; is the only one here that is not a repair — it is a selling problem
            wearing a maintenance costume, which is why it is the one bar spending colour.
          </ChartCaption>
        </Section>
      </div>

      <Section caption="Thirty days, in trade units" title="What actually sold">
        <div className="px-6">
          <ProportionBar
            summary={`${PRODUCT_MIX[0]?.label} is the largest seller at ${Math.round(
              ((PRODUCT_MIX[0]?.units ?? 0) / PRODUCT_MIX.reduce((s, p) => s + p.units, 0)) * 100,
            )}% of units.`}
            segments={PRODUCT_MIX.slice(0, 6).map((p) => ({ label: p.label, value: p.units }))}
          />
        </div>
      </Section>

      <Section caption="Standing risk" title="Compliance exposure">
        <div className="flex flex-wrap gap-3 px-6">
          <ExposureCard
            label="Documents already expired"
            value={docs.expired}
            detail={`${docs.blocking} of them stop the vehicle at the gate`}
            tone={docs.expired > 0 ? 'critical' : 'ready'}
          />
          <ExposureCard
            label="Expiring within 30 days"
            value={docs.expiringSoon}
            detail="Insurance, fitness certificates and permits"
            tone="attention"
          />
          <ExposureCard
            label="Vehicles off road"
            value={fleet.offRoad}
            detail="Earning nothing, still costing EMI and insurance"
            tone="dormant"
          />
        </div>
      </Section>

      <Section caption="Order to cash" title="Invoices needing attention">
        <DataTable
          density={density}
          columns={invoiceColumns}
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

      <Section caption="What is on the ground right now" title="Stock at hand">
        <DataTable
          density={density}
          columns={stockColumns}
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

      <SideSheet
        open={invoice !== null}
        onClose={() => setInvoice(null)}
        title={invoice?.customerName ?? ''}
        identifier={invoice?.number}
        {...(invoice
          ? {
              status: {
                family: INVOICE_STATUS_FAMILY[invoice.status],
                label: INVOICE_STATUS_LABEL[invoice.status],
                ...(invoice.daysOverdue > 0 ? { severity: `+${invoice.daysOverdue}d` } : {}),
                ...(invoice.status === 'payment_reported' ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={invoice ? `RAISED ${invoice.date.slice(8, 10)}-${invoice.date.slice(5, 7)}` : undefined}
      >
        {invoice ? <InvoiceDetail invoice={invoice} /> : null}
      </SideSheet>

      <SideSheet
        open={stock !== null}
        onClose={() => setStock(null)}
        title={PRODUCTS.find((p) => p.code === stock?.productCode)?.label ?? ''}
        identifier={stock?.productCode}
        {...(stock
          ? {
              status: {
                family: stock.units < stock.safetyUnits ? ('attention' as const) : ('ready' as const),
                label: stock.units < stock.safetyUnits ? 'Below safety' : 'Healthy',
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
  return (
    <div
      className="min-w-[220px] flex-1 px-4 py-3"
      style={{ background: 'var(--surface)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)', borderRadius: 'var(--r-2)' }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
          {label}
        </span>
        <StatusStamp status={tone} label={tone === 'critical' ? 'act now' : tone === 'attention' ? 'soon' : 'ok'} />
      </div>
      <p className="num mt-1 text-[28px] leading-none tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {value}
      </p>
      <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {detail}
      </p>
    </div>
  );
}

function InvoiceDetail({ invoice }: { invoice: Invoice }) {
  const verified = Number.parseFloat(invoice.receivedVerified);
  const reported = Number.parseFloat(invoice.receivedReported);
  const total = Number.parseFloat(invoice.total);

  return (
    <>
      <SheetSection caption="Value">
        <DetailGrid>
          <Detail label="Taxable">
            <MoneyCell value={invoice.taxableValue} accounting={false} />
          </Detail>
          <Detail label="GST at 5%">
            <MoneyCell value={invoice.gstAmount} accounting={false} />
          </Detail>
          <Detail label="Invoice total">
            <MoneyCell value={invoice.total} accounting={false} />
          </Detail>
          <Detail label="Balance due">
            <MoneyCell value={invoice.balanceDue} accounting={false} />
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Collection">
        <div className="pb-2">
          <ProportionBar
            summary={`${formatINR(invoice.receivedVerified)} verified of ${formatINR(invoice.total)}.`}
            height={22}
            segments={[
              { label: 'Verified', value: verified, tone: 'var(--status-ready)' },
              ...(reported > verified
                ? [{ label: 'Reported only', value: reported - verified, tone: 'var(--status-attention)' }]
                : []),
              { label: 'Outstanding', value: Math.max(0, total - Math.max(verified, reported)), tone: 'var(--surface-sunken)' },
            ]}
          />
        </div>
        {/* Four distinct states, and they must not be collapsed. "Part-paid"
            and "nothing received" are different conversations to have with a
            customer, and an invoice sitting on unverified money is a different
            conversation again — with your own accounts desk. */}
        {reported > verified ? (
          <Note>
            {formatINR(String(reported - verified))} has been reported as received but not cross-verified by a
            second person. It is not counted as collected anywhere, and this invoice stays open until it is.
          </Note>
        ) : verified >= total ? (
          <Note>Fully collected and verified. This invoice can be closed.</Note>
        ) : verified > 0 ? (
          <Note>
            {formatINR(invoice.receivedVerified)} verified, {formatINR(invoice.balanceDue)} still outstanding
            {invoice.daysOverdue > 0 ? ` and ${invoice.daysOverdue} days past due` : ''}.
          </Note>
        ) : (
          <Note>Nothing has been received against this invoice yet.</Note>
        )}
      </SheetSection>

      <SheetSection caption="Compliance">
        <DetailGrid>
          <Detail label="IRN">{invoice.irn ?? 'Not required at this value'}</Detail>
          <Detail label="e-Way bills">
            {invoice.ewbNumbers.length > 0 ? invoice.ewbNumbers.join(', ') : 'None — under the threshold'}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={`Loads on this invoice (${invoice.tripIds.length})`}>
        {invoice.tripIds.length === 0 ? (
          <Note>No trips are linked. This was raised directly rather than from the dispatch board.</Note>
        ) : (
          <ul className="text-[13px]">
            {invoice.tripIds.map((id) => {
              const trip = TRIPS.find((t) => t.id === id);
              if (!trip) return null;
              return (
                <li key={id} className="flex items-center justify-between py-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <span className="font-id">{trip.tripNumber}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {formatQty(trip.soldUnits, 1)} units · {trip.productCode}
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
  const product = PRODUCTS.find((p) => p.code === position.productCode);
  const coverDays = position.dispatchedTodayUnits > 0 ? position.units / position.dispatchedTodayUnits : null;

  return (
    <>
      <SheetSection caption="Position">
        <DetailGrid>
          <Detail label="At hand">
            <QuantityCell value={position.units} decimals={1} uom="units" />
          </Detail>
          <Detail label="Tonne equivalent">
            <QuantityCell value={position.tonnes} decimals={1} uom="MT" />
          </Detail>
          <Detail label="Safety level">
            <QuantityCell value={position.safetyUnits} decimals={0} uom="units" />
          </Detail>
          <Detail label="Days of cover">
            {coverDays === null ? 'No dispatch today' : `${formatQty(coverDays, 1)} days`}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Today's movement">
        <WaterfallChart
          summary={`Opened at ${formatQty(
            position.units - position.producedTodayUnits + position.dispatchedTodayUnits,
            1,
          )} units, produced ${formatQty(position.producedTodayUnits, 1)}, dispatched ${formatQty(
            position.dispatchedTodayUnits,
            1,
          )}.`}
          height={180}
          format={(v) => formatQty(v, 0)}
          steps={[
            {
              label: 'Opening',
              delta: position.units - position.producedTodayUnits + position.dispatchedTodayUnits,
              total: true,
            },
            { label: 'Produced', delta: position.producedTodayUnits },
            { label: 'Dispatched', delta: -position.dispatchedTodayUnits },
            { label: 'Closing', delta: 0, total: true },
          ]}
        />
      </SheetSection>

      <SheetSection caption="Control">
        <Detail label="Last physical count">{position.lastCountedOn.slice(0, 10)}</Detail>
        {Math.abs(position.countVarianceUnits) > 5 ? (
          <Note>
            {formatQty(Math.abs(position.countVarianceUnits), 1)} units {position.countVarianceUnits < 0 ? 'short' : 'over'}{' '}
            against the last count, and unexplained. Treat this figure as book stock, not a measured pile.
          </Note>
        ) : (
          <Note>Book stock and the last physical count agree within tolerance.</Note>
        )}
        <div className="mt-3">
          <Detail label="Conversion used">
            1 unit = 100 CFT ={' '}
            {formatQty(position.tonnes / Math.max(position.units, 0.0001), 3)} tonnes for {product?.label}
          </Detail>
        </div>
      </SheetSection>
    </>
  );
}

const invoiceColumns: Column<Invoice>[] = [
  {
    key: 'number',
    header: 'Invoice',
    type: 'id',
    sticky: true,
    width: 160,
    group: 'Document',
    render: (i) => i.number,
  },
  { key: 'customer', header: 'Customer', group: 'Document', render: (i) => <Stacked primary={i.customerName} /> },
  { key: 'total', header: 'Total', unit: '₹', type: 'money', group: 'Value', render: (i) => <MoneyCell value={i.total} /> },
  {
    key: 'verified',
    header: 'Verified',
    unit: '₹',
    type: 'money',
    group: 'Value',
    render: (i) => <MoneyCell value={i.receivedVerified} />,
  },
  {
    key: 'balance',
    header: 'Balance',
    unit: '₹',
    type: 'money',
    group: 'Value',
    render: (i) => <MoneyCell value={i.balanceDue} />,
  },
  {
    key: 'status',
    header: 'Status',
    type: 'status',
    width: 150,
    group: 'Standing',
    render: (i) => (
      <StatusStamp
        status={INVOICE_STATUS_FAMILY[i.status]}
        label={INVOICE_STATUS_LABEL[i.status]}
        {...(i.daysOverdue > 0 ? { severity: `+${i.daysOverdue}d` } : {})}
        // Reported-but-unverified money is asserted, not true. Dashed border.
        {...(i.status === 'payment_reported' ? { provisional: true } : {})}
      />
    ),
  },
];

const stockColumns: Column<StockPosition>[] = [
  {
    key: 'product',
    header: 'Product',
    sticky: true,
    width: 180,
    render: (s) => PRODUCTS.find((p) => p.code === s.productCode)?.label ?? s.productCode,
  },
  { key: 'units', header: 'At hand', unit: 'units', type: 'num', render: (s) => <QuantityCell value={s.units} decimals={1} /> },
  { key: 'tonnes', header: 'Equivalent', unit: 'MT', type: 'num', render: (s) => <QuantityCell value={s.tonnes} decimals={1} /> },
  {
    key: 'produced',
    header: 'Produced today',
    unit: 'units',
    type: 'num',
    group: 'Movement today',
    render: (s) => <QuantityCell value={s.producedTodayUnits} decimals={1} />,
  },
  {
    key: 'dispatched',
    header: 'Dispatched today',
    unit: 'units',
    type: 'num',
    group: 'Movement today',
    render: (s) => <QuantityCell value={s.dispatchedTodayUnits} decimals={1} />,
  },
  {
    key: 'variance',
    header: 'Count variance',
    unit: 'units',
    type: 'num',
    group: 'Control',
    render: (s) => (
      <span style={{ color: Math.abs(s.countVarianceUnits) > 5 ? 'var(--status-attention)' : undefined }}>
        <QuantityCell value={s.countVarianceUnits} decimals={1} />
      </span>
    ),
  },
];
