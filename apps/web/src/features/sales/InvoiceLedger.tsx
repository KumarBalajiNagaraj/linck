import { useMemo, useState } from 'react';
import { formatDate, formatINR, formatINRCompact } from '@linck/domain';
import {
  CUSTOMERS_LIST,
  INVOICE_STATUS_FAMILY,
  INVOICE_STATUS_LABEL,
  LAST_14,
  PRODUCTS,
  RECEIPTS,
  TRIPS,
  VEHICLES,
  invoicesForSite,
  type Invoice,
  type Trip,
} from '@linck/mock';
import {
  AgeingBar,
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
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  TileRow,
  TrendChart,
  useIsPhone,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

const LEDGER_VIEWS = ['all', 'overdue', 'reported', 'part_paid', 'closed'] as const;

/**
 * The receivables ledger.
 *
 * The owner's hard rule is the spine of this screen: AN INVOICE DOES NOT CLOSE
 * UNTIL THE PAYMENT RECEIVED IS CONFIRMED AND CROSS-VERIFIED. The rule is not a
 * tooltip here — it is the status trail in the side sheet, and it is the
 * hatch on every rupee somebody has merely SAID arrived.
 *
 * Reported money is never folded into the verified column and is counted as
 * collected nowhere. It keeps its own column wearing the dashed rule, which is
 * why a bad month makes this screen visibly go stripey from across the room.
 */

/** The lifecycle, in order. Rank is what the trail and the hatch are computed from. */
const TRAIL = [
  { key: 'draft', label: 'Draft', family: 'dormant' },
  { key: 'issued', label: 'Issued', family: 'active' },
  { key: 'part_paid', label: 'Part-paid', family: 'attention' },
  { key: 'payment_reported', label: 'Reported', family: 'attention' },
  { key: 'payment_verified', label: 'Verified', family: 'ready' },
  { key: 'closed', label: 'Closed', family: 'dormant' },
] as const;

/** Overdue is not a lifecycle step — it is an issued invoice that ran out of days. */
const RANK: Record<Invoice['status'], number> = {
  draft: 0, issued: 1, overdue: 1, part_paid: 2, payment_reported: 3, payment_verified: 4, closed: 5,
};
/** The step at which money is asserted; nothing past it is true until step 4. */
const REPORTED_RANK = 3;
const VERIFIED_RANK = 4;

interface LedgerRow {
  invoice: Invoice;
  status: Invoice['status'];
  total: number;
  verified: number;
  /** Reported by one person, not confirmed by a second. Always its own figure. */
  reportedUnverified: number;
  balance: number;
  daysOverdue: number;
  fillRatio: number;
}

/** One derivation, so the tiles, the rail, the trail and the sentence cannot disagree. */
function derive(invoice: Invoice, crossChecked: boolean, closedHere: boolean): LedgerRow {
  const total = Number.parseFloat(invoice.total);
  const banked = Number.parseFloat(invoice.receivedVerified);
  const reported = Number.parseFloat(invoice.receivedReported);
  const verified = crossChecked ? Math.max(banked, reported) : banked;
  const balance = Math.round((total - verified) * 100) / 100;

  return {
    invoice,
    status: closedHere ? 'closed' : crossChecked ? (balance <= 0 ? 'payment_verified' : 'part_paid') : invoice.status,
    total,
    verified,
    reportedUnverified: crossChecked ? 0 : Math.max(0, reported - banked),
    balance,
    daysOverdue: balance > 0 ? invoice.daysOverdue : 0,
    fillRatio: total > 0 ? verified / total : 0,
  };
}

/**
 * Mirrors `isInvoiceOverdue` in @linck/mock — past due, money still owed, and a
 * live receivable (never a draft or a closed file) — applied to the derived
 * row so an in-session cross-check that clears the balance clears it here.
 */
const isOverdue = (r: LedgerRow) => r.daysOverdue > 0 && r.status !== 'draft' && r.status !== 'closed';
const isPartPaid = (r: LedgerRow) => r.verified > 0 && r.balance > 0;
const isReported = (r: LedgerRow) => r.reportedUnverified > 0;
const isClosed = (r: LedgerRow) => r.status === 'closed';
/** Live receivable: neither a draft nobody has sent nor a closed file. */
const isLive = (r: LedgerRow) => r.status !== 'closed' && r.status !== 'draft';

/**
 * Customer names run long. The bar chart needs the head of the name, not all of
 * it — and on a phone the label gutter is half the width, so the head is
 * shorter still. The full name stays in the chart summary and in the ledger's
 * "Billed to" column, so nothing is actually lost by trimming the axis.
 */
function shortName(name: string, max = 24): string {
  const head = name.split(' — ')[0] ?? name;
  return head.length > max ? `${head.slice(0, max - 1)}…` : head;
}

export function InvoiceLedger() {
  const { density, siteScope } = useApp();
  // The bar chart's label gutter and bar height are SVG geometry, not CSS —
  // a media query cannot reach them, so this is one of the few places the
  // hook is the right tool rather than a breakpoint class.
  const phone = useIsPhone();
  const [filter, setFilter] = useViewParam(LEDGER_VIEWS, 'all');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // "What would the ageing look like if every reported rupee were true?" — the
  // owner's rule, made into a switch you can flip and watch the bar move.
  const [ageingBasis, setAgeingBasis] = useState<'verified' | 'reported'>('verified');
  // Demo state: cross-checks recorded in this session, invoices closed after one,
  // and the invoices this session has chased.
  const [crossChecked, setCrossChecked] = useState<string[]>([]);
  const [closedHere, setClosedHere] = useState<string[]>([]);
  const [reminded, setReminded] = useState<string[]>([]);
  const [closing, setClosing] = useState(false);

  /**
   * Site scope goes through `invoicesForSite` — the same selector the sales
   * command board counts with, so its "overdue" card and this ledger's
   * Overdue chip can never be scoped differently. (An invoice's site is the
   * site of the trips it bills; one with no trips stays visible everywhere.)
   */
  const rows = useMemo(
    () => invoicesForSite(siteScope).map((i) => derive(i, crossChecked.includes(i.id), closedHere.includes(i.id))),
    [siteScope, crossChecked, closedHere],
  );

  const visible = useMemo(() => {
    const scoped = customerId === null ? rows : rows.filter((r) => r.invoice.customerId === customerId);
    if (filter === 'overdue') return scoped.filter(isOverdue);
    if (filter === 'reported') return scoped.filter(isReported);
    if (filter === 'part_paid') return scoped.filter(isPartPaid);
    if (filter === 'closed') return scoped.filter(isClosed);
    return scoped;
  }, [rows, filter, customerId]);

  const openInvoices = rows.filter(isLive);
  const outstanding = openInvoices.reduce((s, r) => s + r.balance, 0);
  const overdue = openInvoices.filter(isOverdue);
  const unverified = rows.filter(isReported);

  /**
   * AGEING. On the verified basis a bucket holds the whole balance, because
   * reported money has not arrived. Flip to the reported basis and every claimed
   * rupee is deducted — the difference between the two bars is exactly how much
   * of this ageing profile is resting on somebody's word.
   */
  const ageingBuckets = useMemo(() => {
    const owed = (r: LedgerRow) =>
      ageingBasis === 'verified' ? r.balance : Math.max(0, r.balance - r.reportedUnverified);
    const bucket = (pred: (r: LedgerRow) => boolean) =>
      openInvoices.filter(pred).reduce((s, r) => s + owed(r), 0);
    return [
      { label: 'Not yet due', value: bucket((r) => r.daysOverdue === 0) },
      { label: '1–30 days', value: bucket((r) => r.daysOverdue > 0 && r.daysOverdue <= 30) },
      { label: '31–60 days', value: bucket((r) => r.daysOverdue > 30 && r.daysOverdue <= 60) },
      { label: 'Over 60 days', value: bucket((r) => r.daysOverdue > 60) },
    ];
  }, [openInvoices, ageingBasis]);

  const ageingTotal = ageingBuckets.reduce((s, b) => s + b.value, 0);
  const beyondSixty = ageingBuckets[3]?.value ?? 0;

  /**
   * COLLECTIONS against BILLING. A collections line on its own only says
   * whether the counter had a busy day. Drawn against the average day's
   * billing, it says whether receivables grew or shrank — which is the
   * question the ledger exists to answer.
   */
  const collectionSeries = LAST_14.map((d) => ({ label: d.label, value: d.collectedVerified }));
  const avgCollected = collectionSeries.reduce((s, p) => s + p.value, 0) / collectionSeries.length;
  const avgBilled = LAST_14.reduce((s, d) => s + d.revenue, 0) / LAST_14.length;
  const shortDays = collectionSeries.filter((p) => p.value < avgBilled).length;

  /** Concentration of risk. One name carrying a third of the book is the story. */
  const byCustomer = useMemo(() => {
    const map = new Map<string, { id: string; name: string; balance: number; overdueAmount: number; worstDays: number }>();
    for (const r of openInvoices) {
      if (r.balance <= 0) continue;
      const entry = map.get(r.invoice.customerId) ?? {
        id: r.invoice.customerId,
        name: r.invoice.customerName,
        balance: 0,
        overdueAmount: 0,
        worstDays: 0,
      };
      entry.balance += r.balance;
      if (r.daysOverdue > 0) {
        entry.overdueAmount += r.balance;
        entry.worstDays = Math.max(entry.worstDays, r.daysOverdue);
      }
      map.set(r.invoice.customerId, entry);
    }
    return [...map.values()].sort((a, b) => b.balance - a.balance);
  }, [openInvoices]);

  const topCustomer = byCustomer[0];
  const customerBars = byCustomer.map((c) => ({
    // The dashed tick is the overdue slice of the same bar, so the gap between
    // tick and bar end is money still inside its terms. Colour is spent only
    // where MOST of what a customer owes has already run out of days.
    label: shortName(c.name, phone ? 13 : 24),
    value: c.balance,
    ...(c.overdueAmount > 0 ? { marker: c.overdueAmount } : {}),
    ...(c.overdueAmount >= c.balance / 2 ? { tone: 'var(--status-attention)' } : {}),
  }));

  // Looked up in the full set, not the filtered one: cross-verifying an invoice
  // drops it out of the "reported" filter, and the sheet must stay open to show
  // the hatch dissolving. That is the whole confirmation moment.
  const selected = rows.find((r) => r.invoice.id === selectedId);
  const canClose = selected !== undefined && RANK[selected.status] >= VERIFIED_RANK && selected.status !== 'closed' && selected.balance <= 0;

  // Written once because it is rendered in two different places depending on
  // the width — in the section header on a desk, above the bar on a phone.
  const basisToggle = (
    <>
      <Chip active={ageingBasis === 'verified'} onClick={() => setAgeingBasis('verified')}>
        Verified basis
      </Chip>
      <Chip active={ageingBasis === 'reported'} onClick={() => setAgeingBasis('reported')}>
        If every claim were true
      </Chip>
    </>
  );

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Invoice ledger"
        meta={<AsOfStamp asOf="14:42" source="v_ar_ledger" freshness="materialised" />}
        actions={
          // The header's action slot does not shrink, so on a narrow screen the
          // two controls would push the title off the page. Capping the measure
          // makes them stack under each other instead; from `sm` up they sit on
          // one line exactly as before.
          <div className="flex max-w-[172px] flex-wrap items-center justify-end gap-2 sm:max-w-none">
            <Chip active>FY 2026-27</Chip>
            <Button variant="secondary">Export for the CA</Button>
          </div>
        }
      />

      {/*
        One tile per row on a phone.

        Two tiles across 375px leaves 131px of measure inside the tile padding,
        which wraps "Counted to the verification date, never to the reporting
        date" to four lines and overflows the `v_receipt_verification` source
        stamp outright — a mono string wider than its own column. Stacked, the
        hairline that separates tiles turns from a vertical rule into a
        horizontal one, and the last tile drops its rule so it does not double
        up with the row's own bottom border.
      */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <KpiTile
          eyebrow="Outstanding, verified basis"
          hero
          value={formatINRCompact(outstanding)}
          delta={{ text: `${openInvoices.length} invoices open` }}
          asOf="14:42"
          source="v_ar_ledger"
          freshness="materialised"
          title={formatINR(outstanding)}
        />
        <KpiTile
          eyebrow="Overdue"
          value={formatINRCompact(overdue.reduce((s, r) => s + r.balance, 0))}
          delta={{ text: `${overdue.length} invoices past their due date`, tone: overdue.length > 0 ? 'critical' : 'neutral' }}
          asOf="14:42"
          source="v_ar_ageing"
          freshness="materialised"
        />
        {/* The rule, as a number. This money is counted as collected nowhere. */}
        <KpiTile
          eyebrow="Reported, not yet verified"
          value={formatINRCompact(unverified.reduce((s, r) => s + r.reportedUnverified, 0))}
          delta={{ text: `${unverified.length} awaiting a second pair of eyes`, tone: unverified.length > 0 ? 'attention' : 'neutral' }}
          asOf="14:42"
          source="v_receipt_verification"
        />
        <KpiTile
          eyebrow="Average days to collect"
          value="41.2 days"
          delta={{ text: 'Counted to the verification date, never to the reporting date' }}
          asOf="06:00"
          source="v_ar_collection_days_90d"
          freshness="materialised"
        />
      </TileRow>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-6 xl:grid-cols-2">
        <Section
          caption="Where the money is sitting"
          title="Receivables by age"
          // "If every claim were true" is a long chip, and the section header
          // puts its actions on the same line as the title. On a phone that
          // squeezed "Receivables by age" down to a 88px column four lines
          // deep, so below `md` the basis toggle drops out of the header and
          // becomes its own full-width row above the bar it governs — the same
          // two chips, doing the same job, with room to be read.
          actions={phone ? null : basisToggle}
        >
          {phone ? <div className="mb-2 flex flex-wrap gap-2">{basisToggle}</div> : null}
          <AgeingBar
            summary={`${formatINRCompact(ageingTotal)} outstanding on the ${
              ageingBasis === 'verified' ? 'verified' : 'reported'
            } basis, of which ${formatINRCompact(beyondSixty)} has run past sixty days.`}
            buckets={ageingBuckets}
            format={(v) => formatINRCompact(v)}
          />
          <ChartCaption>
            Darker is older; nothing here is red, because an ageing bucket is a fact about time and the alert
            colour is owed to the invoices actually in trouble. Flip the basis and the bar shrinks by{' '}
            {formatINRCompact(unverified.reduce((s, r) => s + r.reportedUnverified, 0))} — that is the part of
            this profile no second person has confirmed.
          </ChartCaption>
        </Section>

        <Section caption="Fourteen days" title="Collections that cleared verification">
          <TrendChart
            data={collectionSeries}
            summary={`Verified collections averaging ${formatINRCompact(
              avgCollected,
            )} a day against ${formatINRCompact(avgBilled)} billed; ${shortDays} of fourteen days fell short of the billing run-rate.`}
            seriesLabel="Collected"
            benchmark={{ value: avgBilled, label: `${formatINRCompact(avgBilled)} billed/day` }}
            flagBelow={avgBilled * 0.55}
            height={170}
            format={(v) => formatINRCompact(v)}
          />
          <ChartCaption>
            The dashed rule is what an average day bills. Days under it are days receivables grew, whatever the
            sales board says — and the ringed days are the ones that barely collected half of what went out.
          </ChartCaption>
        </Section>
      </div>

      <Section
        caption="Concentration of risk"
        title="Outstanding by customer"
        actions={
          customerId !== null ? (
            <Button variant="secondary" onClick={() => setCustomerId(null)}>
              Clear customer filter
            </Button>
          ) : null
        }
      >
        <div className="px-6">
          {byCustomer.length === 0 ? (
            <EmptyState fact="Nothing is outstanding in this scope." because="Every live invoice here is verified in full." />
          ) : (
            <>
              <BarChart
                summary={
                  topCustomer
                    ? `${topCustomer.name} owes ${formatINRCompact(topCustomer.balance)}, ${Math.round(
                        (topCustomer.balance / (outstanding || 1)) * 100,
                      )}% of everything outstanding, across ${byCustomer.length} paying customers.`
                    : 'No outstanding balances.'
                }
                data={customerBars}
                format={(v) => formatINRCompact(v)}
                // 190px of name gutter plus a 64px value gutter leaves 73px of
                // actual bar inside a 327px phone column, which is a chart you
                // cannot read a ratio off. Halving the gutter gives the bars
                // roughly 155px and keeps the comparison the chart exists for.
                labelWidth={phone ? 108 : 190}
                // Each bar is a tap target that pins the ledger to a customer,
                // so it grows to a thumb's worth of height on a phone.
                barHeight={phone ? 36 : 22}
                onSelect={(d) => {
                  // Matched by position, not by label — two builders can share the
                  // first twenty-four characters of a name and must not share a filter.
                  const idx = customerBars.findIndex((b) => b === d);
                  const match = idx >= 0 ? byCustomer[idx] : undefined;
                  setCustomerId(match && match.id !== customerId ? match.id : null);
                }}
              />
              <ChartCaption>
                The dashed tick on each bar is the part already past its due date, so the gap to the bar end is
                money still inside terms. Pick a bar to pin the ledger below to that customer — one name carrying
                a third of the book is a credit-limit conversation, not a collections one.
              </ChartCaption>
            </>
          )}
        </div>
      </Section>

      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
          All invoices
        </Chip>
        <Chip active={filter === 'overdue'} onClick={() => setFilter('overdue')} count={rows.filter(isOverdue).length}>
          Overdue
        </Chip>
        <Chip active={filter === 'reported'} onClick={() => setFilter('reported')} count={unverified.length}>
          Reported, not verified
        </Chip>
        <Chip active={filter === 'part_paid'} onClick={() => setFilter('part_paid')} count={rows.filter(isPartPaid).length}>
          Part-paid
        </Chip>
        <Chip active={filter === 'closed'} onClick={() => setFilter('closed')} count={rows.filter(isClosed).length}>
          Closed
        </Chip>
        {customerId !== null ? (
          <Chip active onClick={() => setCustomerId(null)}>
            {shortName(byCustomer.find((c) => c.id === customerId)?.name ?? CUSTOMERS_LIST.find((c) => c.id === customerId)?.name ?? 'Customer')} ×
          </Chip>
        ) : null}
        {/* Right-aligned beside the chips on a wide screen; once the chips wrap
            it becomes its own left-aligned line rather than a stray fragment
            pushed to the far edge of the last row. */}
        <span
          className="w-full font-serif text-[13px] italic sm:ml-auto sm:w-auto"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Select an invoice to open its trail.
        </span>
      </div>

      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={visible}
          rowKey={(r) => r.invoice.id}
          selectedKey={selectedId}
          onRowClick={(r) => setSelectedId(r.invoice.id === selectedId ? undefined : r.invoice.id)}
          isDormant={(r) => r.status === 'draft'}
          // A 62%-paid invoice shows a 62% rail. Verified money only, never reported.
          rail={(r) => ({ status: INVOICE_STATUS_FAMILY[r.status], fillRatio: r.fillRatio })}
          empty={
            <EmptyState
              fact="No invoices in this view."
              because="Nothing in scope matches the filter — the ledger itself is not empty."
              action={{ label: 'Show all invoices', onClick: () => { setFilter('all'); setCustomerId(null); } }}
            />
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== undefined}
        onClose={() => setSelectedId(undefined)}
        width="form"
        title={selected?.invoice.customerName ?? ''}
        identifier={selected?.invoice.number}
        {...(selected
          ? {
              status: {
                family: INVOICE_STATUS_FAMILY[selected.status],
                label: INVOICE_STATUS_LABEL[selected.status],
                ...(selected.daysOverdue > 0 ? { severity: `+${selected.daysOverdue}d` } : {}),
                ...(selected.reportedUnverified > 0 ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={selected ? `RAISED ${formatDate(selected.invoice.date)}` : undefined}
        footer={
          selected ? (
            <>
              {selected.reportedUnverified > 0 ? (
                <Button
                  variant="primary"
                  onClick={() => setCrossChecked((ids) => [...ids, selected.invoice.id])}
                >
                  Cross-verify {formatINR(selected.reportedUnverified, { decimals: 0 })}
                </Button>
              ) : null}
              {canClose ? (
                <Button variant="primary" onClick={() => setClosing(true)}>
                  Close this invoice
                </Button>
              ) : null}
              <Button
                variant="secondary"
                disabled={reminded.includes(selected.invoice.id)}
                onClick={() => setReminded((ids) => (ids.includes(selected.invoice.id) ? ids : [...ids, selected.invoice.id]))}
              >
                {reminded.includes(selected.invoice.id) ? 'Reminder sent' : 'Send a reminder'}
              </Button>
              {/*
                The footer is a single fixed-height row. "Cross-verify ₹1,25,000"
                and "Send a reminder" already consume all 335px of it on a phone,
                so the provenance stamp moves into the sheet body rather than
                being pushed off the edge — see the tail of InvoiceDetail.
              */}
              <span className="ml-auto hidden sm:block">
                <AsOfStamp asOf="14:42" source="v_ar_invoice_detail" freshness="materialised" />
              </span>
            </>
          ) : undefined
        }
      >
        {selected ? <InvoiceDetail row={selected} density={density} reminded={reminded.includes(selected.invoice.id)} /> : null}
      </SideSheet>

      {/* Closing is the assertion the owner's whole rule protects, so it is the
          one action on this screen that stops and asks. */}
      {selected ? (
        <ConfirmModal
          open={closing}
          onClose={() => setClosing(false)}
          onConfirm={() => setClosedHere((ids) => [...ids, selected.invoice.id])}
          title="Close this invoice"
          confirmLabel="Close it"
          consequence={
            <>
              Closing {selected.invoice.number} asserts that the full {formatINR(selected.total, { decimals: 0 })}{' '}
              was received and cross-verified against the bank statement. It leaves the receivables ledger, stops
              appearing in the ageing, and stops chasing {selected.invoice.customerName}. Reopening it is an audit
              entry, not a click.
            </>
          }
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ detail */

function InvoiceDetail({
  row,
  density,
  reminded,
}: {
  row: LedgerRow;
  density: 'compact' | 'default' | 'comfortable' | 'touch';
  reminded: boolean;
}) {
  const { invoice } = row;
  const rank = RANK[row.status];
  const isVerified = rank >= VERIFIED_RANK;
  const receipt = RECEIPTS.find((r) => r.suggestedInvoiceId === invoice.id && r.verifiedBy === null);
  const trips = TRIPS.filter((t) => invoice.tripIds.includes(t.id));
  const customer = CUSTOMERS_LIST.find((c) => c.id === invoice.customerId);
  const outstanding = Math.max(0, row.balance - row.reportedUnverified);

  return (
    <>
      <SheetSection caption="Status trail">
        <div
          className="px-4 py-3"
          style={{
            background: 'var(--surface)',
            borderRadius: 'var(--r-2)',
            border: `1px ${row.reportedUnverified > 0 ? 'dashed var(--provisional-rule)' : 'solid var(--border-strong)'}`,
          }}
        >
          {/*
            THE STATUS TRAIL. Every step from "reported" onward stays dashed until
            a second person has cross-verified the money.

            Six stamps and five connectors measure about 620px, so the trail has
            never fitted a phone and would not fit one at any type size — the
            words themselves are the width. Below `sm` it turns through ninety
            degrees: the same six steps, the same connector, read top to bottom.
            Nothing is dropped or abbreviated, and the connector keeps carrying
            its meaning, because solid-versus-dashed is a border STYLE and works
            just as well down the left edge as along the top.
          */}
          <div className="flex flex-col items-start sm:flex-row sm:items-center sm:overflow-x-auto sm:pb-1">
            {TRAIL.map((step, i) => {
              // Solid up to the step actually reached; dashed for the stretch
              // that is still only asserted.
              const reached = i + 1 <= rank;
              return (
                <span key={step.key} className="flex shrink-0 flex-col items-start sm:flex-row sm:items-center">
                  <StatusStamp
                    // A step nobody has reached is PENDING — achromatic, dotted, no colour budget spent.
                    status={i <= rank && (step.key !== 'part_paid' || row.verified > 0) ? step.family : 'pending'}
                    label={step.label}
                    provisional={i >= REPORTED_RANK && !isVerified}
                    {...(step.key === 'payment_verified' && isVerified ? { fillRatio: row.fillRatio } : {})}
                  />
                  {i < TRAIL.length - 1 ? (
                    <span
                      aria-hidden="true"
                      // Vertical hairline under the stamp's rail on a phone;
                      // horizontal between stamps from `sm` up. Widths switch
                      // side, the style and colour are set once for both.
                      className="my-1 ml-[9px] mr-0 block h-3.5 w-0 border-l sm:my-0 sm:ml-1 sm:mr-1 sm:h-0 sm:w-5 sm:border-l-0 sm:border-t"
                      style={{
                        borderStyle: reached ? 'solid' : 'dashed',
                        borderColor: reached ? 'var(--border-strong)' : 'var(--provisional-rule)',
                      }}
                    />
                  ) : null}
                </span>
              );
            })}
          </div>

          <p className="mt-3 max-w-[64ch] text-[14px]" style={{ color: 'var(--text-primary)' }}>
            {blockingLine(row, receipt?.recordedBy ?? null, receipt?.date ?? null)}
          </p>
          {receipt && row.reportedUnverified > 0 ? (
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              Received as {receipt.method.toUpperCase()}
              {receipt.reference ? <> · <IdCell>{receipt.reference}</IdCell></> : ' · no bank reference, taken as cash'}
            </p>
          ) : null}
        </div>
        {reminded ? (
          <div className="mt-2">
            <Note>
              A reminder went to {invoice.customerName} at 14:42 today. Nothing about the money has changed — only
              that you asked for it.
            </Note>
          </div>
        ) : null}
      </SheetSection>

      <SheetSection caption="Collection">
        <ProportionBar
          summary={`${formatINR(row.verified, { decimals: 0 })} verified of ${formatINR(row.total, {
            decimals: 0,
          })}${row.reportedUnverified > 0 ? `, with ${formatINR(row.reportedUnverified, { decimals: 0 })} reported but unconfirmed` : ''}.`}
          height={22}
          segments={[
            { label: 'Verified', value: row.verified, tone: 'var(--status-ready)' },
            ...(row.reportedUnverified > 0
              ? [{ label: 'Reported only', value: row.reportedUnverified, tone: 'var(--status-attention)' }]
              : []),
            { label: 'Outstanding', value: outstanding, tone: 'var(--surface-sunken)' },
          ]}
        />
        <ChartCaption>
          The middle band is money in nobody's hands: claimed by one person, confirmed by none. It sits outside
          the verified segment on purpose and never joins it without a second signature.
        </ChartCaption>
      </SheetSection>

      <SheetSection caption="What was billed">
        <DetailGrid>
          <Detail label="Taxable value">
            <MoneyCell value={invoice.taxableValue} accounting={false} />
          </Detail>
          <Detail label="GST at 5%">
            <MoneyCell value={invoice.gstAmount} accounting={false} />
          </Detail>
          <Detail label="Invoice total">
            <MoneyCell value={invoice.total} accounting={false} />
          </Detail>
          <Detail label="Verified against the bank">
            <MoneyCell value={row.verified} accounting={false} />
          </Detail>
          {/* Never summed into the line above it. That is the whole rule. */}
          <Detail label="Reported, not verified">
            {row.reportedUnverified > 0 ? (
              <Provisional>
                <MoneyCell value={row.reportedUnverified} accounting={false} />
              </Provisional>
            ) : (
              <MoneyCell value={0} accounting={false} />
            )}
          </Detail>
          <Detail label="Balance due">
            <MoneyCell value={row.balance} accounting={false} />
          </Detail>
        </DetailGrid>
        <div className="mt-2">
          <Note>
            Billed to {customer?.site ?? invoice.customerName} · raised {formatDate(invoice.date)} · due{' '}
            {formatDate(invoice.dueDate)}
          </Note>
        </div>
      </SheetSection>

      <SheetSection caption="Statutory references">
        <DetailGrid>
          <Detail label="IRN">{invoice.irn ? <IdCell>{invoice.irn}</IdCell> : <NotRequired />}</Detail>
          <Detail label="E-way bills">
            {invoice.ewbNumbers.length > 0 ? <IdCell>{invoice.ewbNumbers.join(', ')}</IdCell> : <NotRequired />}
          </Detail>
          <Detail label="Loads billed">
            <QuantityCell value={trips.length} decimals={0} />
          </Detail>
        </DetailGrid>
        <div className="mt-2">
          <Note>
            Most intra-TN tipper loads sit under the ₹1,00,000 consignment threshold and below the e-invoicing
            turnover trigger, so a blank here is the normal path, not a gap.
          </Note>
        </div>
      </SheetSection>

      <SheetSection caption={`The loads this invoice bills (${trips.length})`}>
        <DataTable
          density={density}
          columns={tripColumns}
          rows={trips}
          rowKey={(t) => t.id}
          empty={
            <EmptyState
              fact="No trips are linked to this invoice."
              because="It was raised against an advance or a counter sale, so there is no dispatch to reconcile against."
            />
          }
        />
      </SheetSection>

      {/* The sheet's own footer carries this from `sm` up, where there is room
          beside the buttons. On a phone there is not, and a provenance stamp is
          not something to drop — so it lands here instead, at the foot of the
          thing it vouches for. */}
      <div className="mt-5 sm:hidden">
        <AsOfStamp asOf="14:42" source="v_ar_invoice_detail" freshness="materialised" />
      </div>
    </>
  );
}

/** The one sentence stating exactly what is stopping this invoice from closing. */
function blockingLine(row: LedgerRow, reportedBy: string | null, reportedOn: string | null): string {
  const amt = (n: number) => formatINR(n, { decimals: 0 });
  if (row.status === 'closed') return `Closed. ${amt(row.total)} verified in full against the bank statement.`;
  if (row.status === 'draft') return 'Still a draft. Nothing has gone to the customer, so nothing is collectable yet.';
  if (row.reportedUnverified > 0)
    return `${amt(row.reportedUnverified)} reported by ${reportedBy ?? 'the counter'} on ${formatDate(reportedOn ?? row.invoice.date)} has not been verified by a second person. The invoice stays open until it is.`;
  if (row.balance <= 0) return 'Nothing is blocking closure. Every rupee is verified — this invoice can be closed.';
  const late = row.daysOverdue > 0 ? `, ${row.daysOverdue} days past due` : '';
  if (row.verified > 0) return `${amt(row.verified)} of ${amt(row.total)} is verified. ${amt(row.balance)} is still outstanding${late}.`;
  return `No payment has been reported against this invoice. ${amt(row.balance)} is outstanding${late}.`;
}

/** Below the threshold there is nothing to show. That is a fact, not an alarm. */
function NotRequired() {
  return <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-secondary)' }}>not required at this value</span>;
}

/* ----------------------------------------------------------------- columns */

const columns: Column<LedgerRow>[] = [
  { key: 'number', header: 'Number', type: 'id', sticky: true, width: 168, group: 'Document', render: (r) => r.invoice.number },
  { key: 'date', header: 'Raised', width: 106, group: 'Document', render: (r) => formatDate(r.invoice.date) },
  {
    key: 'customer',
    header: 'Billed to',
    group: 'Customer',
    render: (r) => <Stacked primary={r.invoice.customerName} secondary={CUSTOMERS_LIST.find((c) => c.id === r.invoice.customerId)?.site} />,
  },
  { key: 'taxable', header: 'Taxable', unit: '₹', type: 'money', group: 'Value', render: (r) => <MoneyCell value={r.invoice.taxableValue} /> },
  { key: 'gst', header: 'GST', unit: '₹', type: 'money', group: 'Value', render: (r) => <MoneyCell value={r.invoice.gstAmount} /> },
  { key: 'total', header: 'Total', unit: '₹', type: 'money', group: 'Value', render: (r) => <MoneyCell value={r.total} /> },
  { key: 'verified', header: 'Verified', unit: '₹', type: 'money', group: 'Received', render: (r) => <MoneyCell value={r.verified} /> },
  {
    key: 'reported',
    header: 'Reported only',
    unit: '₹',
    type: 'money',
    group: 'Received',
    // Its own column, hatched, and never added into Verified. Asserted, not true.
    render: (r) => (r.reportedUnverified > 0 ? <Provisional><MoneyCell value={r.reportedUnverified} /></Provisional> : null),
  },
  { key: 'balance', header: 'Balance', unit: '₹', type: 'money', group: 'Received', render: (r) => <MoneyCell value={r.balance} /> },
  {
    key: 'status',
    header: 'Status',
    type: 'status',
    width: 176,
    group: 'Standing',
    render: (r) => (
      <StatusStamp
        status={INVOICE_STATUS_FAMILY[r.status]}
        label={INVOICE_STATUS_LABEL[r.status]}
        fillRatio={r.fillRatio}
        provisional={r.reportedUnverified > 0}
        {...(r.daysOverdue > 0 ? { severity: `+${r.daysOverdue}d` } : {})}
      />
    ),
  },
];

/** Where a billed quantity came from decides whether the customer can argue with it. */
const BASIS_LABEL: Record<Trip['qtyBasis'], string> = {
  loader_buckets: 'Loader buckets',
  plant_weighbridge: 'Plant weighbridge',
  customer_weighbridge: 'Customer weighbridge',
  agreed_units: 'Agreed units',
};

const tripColumns: Column<Trip>[] = [
  { key: 'trip', header: 'Trip', type: 'id', sticky: true, width: 150, render: (t) => t.tripNumber },
  { key: 'vehicle', header: 'Vehicle', type: 'id', width: 140, render: (t) => VEHICLES.find((v) => v.id === t.vehicleId)?.displayReg ?? null },
  { key: 'product', header: 'Material', render: (t) => PRODUCTS.find((p) => p.code === t.productCode)?.label ?? t.productCode },
  { key: 'units', header: 'Sold', unit: 'units', type: 'num', width: 100, render: (t) => <QuantityCell value={t.soldUnits} decimals={1} /> },
  { key: 'revenue', header: 'Line value', unit: '₹', type: 'money', width: 128, render: (t) => <MoneyCell value={t.revenue} /> },
  {
    key: 'basis',
    header: 'Quantity basis',
    width: 176,
    // Buckets and agreed units are an assertion; a weighbridge ticket is not.
    render: (t) =>
      t.qtyBasis === 'agreed_units' || t.qtyBasis === 'loader_buckets' ? <Provisional>{BASIS_LABEL[t.qtyBasis]}</Provisional> : BASIS_LABEL[t.qtyBasis],
  },
];
