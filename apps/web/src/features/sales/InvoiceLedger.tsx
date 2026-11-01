import { useMemo, useState } from 'react';
import { formatDate, formatINR } from '@linck/domain';
import {
  CUSTOMERS_LIST,
  INVOICE_STATUS_FAMILY,
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
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useDayMonth, useInrCompact } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { shortName } from './shortName.js';
import { invoiceWords, salesWords, type InvoiceText, type SalesText } from './words.js';

const LEDGER_VIEWS = ['all', 'overdue', 'reported', 'part_paid', 'closed'] as const;

/**
 * The receivables ledger ("Invoices" on screen).
 *
 * The owner's hard rule is the spine of this screen: AN INVOICE DOES NOT CLOSE
 * UNTIL THE PAYMENT RECEIVED IS CONFIRMED AND CROSS-VERIFIED. The rule is not a
 * tooltip here — it is the status trail in the side sheet, and it is the
 * hatch on every rupee somebody has merely SAID arrived.
 *
 * Reported money is never folded into the verified column and is counted as
 * collected nowhere. It keeps its own column wearing the dashed rule, which is
 * why a bad month makes this screen visibly go stripey from across the room.
 *
 * On screen "verified" is "checked" and "reported" is "not checked"
 * (docs/WRITING.md): one person noted the money, a second has not yet matched
 * it against the bank.
 */

/** The lifecycle, in order. Rank is what the trail and the hatch are computed from. */
const TRAIL = [
  { key: 'draft', family: 'dormant' },
  { key: 'issued', family: 'active' },
  { key: 'part_paid', family: 'attention' },
  { key: 'payment_reported', family: 'attention' },
  { key: 'payment_verified', family: 'ready' },
  { key: 'closed', family: 'dormant' },
] as const;

/** Overdue is not a lifecycle step — it is an issued invoice that ran out of days. */
const RANK: Record<Invoice['status'], number> = {
  draft: 0, issued: 1, overdue: 1, part_paid: 2, payment_reported: 3, payment_verified: 4, closed: 5,
};
/** The step at which money is asserted; nothing past it is true until step 4. */
const REPORTED_RANK = 3;
const VERIFIED_RANK = 4;

/** GST on aggregates and sand, as billed. */
const GST_PCT = 5;

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

type StatusText = (typeof statusWords)['en'];

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
  const t = useWords(invoiceWords);
  const s = useWords(salesWords);
  const status = useWords(statusWords);
  const columns = useMemo(() => ledgerColumns(t, s, status), [t, s, status]);
  const inr = useInrCompact();
  const dayMonth = useDayMonth();

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
   *
   * Darker is older; nothing here is red, because an ageing bucket is a fact
   * about time and the alert colour is owed to the invoices actually in trouble.
   */
  const ageingBuckets = useMemo(() => {
    const owed = (r: LedgerRow) =>
      ageingBasis === 'verified' ? r.balance : Math.max(0, r.balance - r.reportedUnverified);
    const bucket = (pred: (r: LedgerRow) => boolean) =>
      openInvoices.filter(pred).reduce((s, r) => s + owed(r), 0);
    return [
      { label: t.buckets.notDue, value: bucket((r) => r.daysOverdue === 0) },
      { label: t.buckets.d30, value: bucket((r) => r.daysOverdue > 0 && r.daysOverdue <= 30) },
      { label: t.buckets.d60, value: bucket((r) => r.daysOverdue > 30 && r.daysOverdue <= 60) },
      { label: t.buckets.over60, value: bucket((r) => r.daysOverdue > 60) },
    ];
  }, [openInvoices, ageingBasis, t]);

  const ageingTotal = ageingBuckets.reduce((s, b) => s + b.value, 0);
  const beyondSixty = ageingBuckets[3]?.value ?? 0;

  /**
   * COLLECTIONS against BILLING. A collections line on its own only says
   * whether the counter had a busy day. Drawn against the average day's
   * billing, it says whether receivables grew or shrank — which is the
   * question the ledger exists to answer. The ringed days are the ones that
   * barely collected half of what went out.
   */
  const collectionSeries = LAST_14.map((d) => ({ label: dayMonth(d.date), value: d.collectedVerified }));
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
    // where MOST of what a customer owes has already run out of days. On a
    // phone the label gutter is half the width, so the name is shorter still.
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
  const selectedStatus = selected
    ? {
        family: INVOICE_STATUS_FAMILY[selected.status],
        label: status.invoice[selected.status],
        ...(selected.daysOverdue > 0 ? { severity: t.lateDays(selected.daysOverdue) } : {}),
        ...(selected.reportedUnverified > 0 ? { provisional: true } : {}),
      }
    : undefined;

  return (
    <>
      <PageHeader
        eyebrow={s.eyebrow}
        title={t.title}
        // From v_ar_ledger.
        meta={<AsOfStamp asOf="14:42" source={s.src.invoices} freshness="materialised" />}
        actions={
          // Below `sm` the page header is a column, so these sit under the
          // title and wrap only when they do not fit — a fixed cap here used
          // to break the Tamil button label onto two lines.
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Chip active>{t.year('2026-27')}</Chip>
            <Button variant="secondary">{t.download}</Button>
          </div>
        }
      />

      {/*
        One tile per row on a phone: two tiles across 375px leaves 131px of
        measure inside the tile padding. Stacked, the hairline that separates
        tiles turns from a vertical rule into a horizontal one, and the last
        tile drops its rule so it does not double up with the row's own
        bottom border.
      */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        {/* Outstanding on the verified basis: only checked money counts as paid (v_ar_ledger). */}
        <KpiTile
          eyebrow={t.moneyDue}
          hero
          value={inr(outstanding)}
          delta={{ text: t.openN(openInvoices.length) }}
          title={formatINR(outstanding)}
          asOfInHeader
        />
        {/* v_ar_ageing. */}
        <KpiTile
          eyebrow={status.invoice.overdue}
          value={inr(overdue.reduce((s, r) => s + r.balance, 0))}
          delta={{ text: t.pastDueN(overdue.length), tone: overdue.length > 0 ? 'critical' : 'neutral' }}
          asOfInHeader
        />
        {/* The rule, as a number. This money is counted as collected nowhere —
            it waits for a second pair of eyes (v_receipt_verification). */}
        <KpiTile
          eyebrow={status.invoice.payment_reported}
          value={inr(unverified.reduce((s, r) => s + r.reportedUnverified, 0))}
          delta={{ text: t.toCheckN(unverified.length), tone: unverified.length > 0 ? 'attention' : 'neutral' }}
          asOfInHeader
        />
        {/* Counted to the verification date, never to the reporting date
            (v_ar_collection_days_90d). */}
        <KpiTile
          eyebrow={t.daysToPay}
          value={t.daysN('41.2')}
          delta={{ text: t.avgTillChecked }}
          asOf="06:00"
          source={s.src.payments}
          freshness="materialised"
        />
      </TileRow>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-6 xl:grid-cols-2">
        <Section title={t.dueByDays}>
          {/* The basis chips are its own row above the bar they govern, at
              every width. In the section header they shared a line with the
              title, which squeezed both — and Tamil words are longer still. */}
          <div className="mb-2 flex flex-wrap gap-2">
            <Chip active={ageingBasis === 'verified'} onClick={() => setAgeingBasis('verified')}>
              {t.checkedOnly}
            </Chip>
            <Chip active={ageingBasis === 'reported'} onClick={() => setAgeingBasis('reported')}>
              {t.withUnchecked}
            </Chip>
          </div>
          <AgeingBar
            summary={t.ageingSummary(inr(ageingTotal), inr(beyondSixty))}
            buckets={ageingBuckets}
            format={inr}
          />
        </Section>

        <Section caption={t.last14} title={t.moneyReceived}>
          <TrendChart
            data={collectionSeries}
            summary={t.trendSummary(inr(avgCollected), inr(avgBilled), shortDays)}
            seriesLabel={t.received}
            benchmark={{ value: avgBilled, label: t.billedPerDay(inr(avgBilled)) }}
            flagBelow={avgBilled * 0.55}
            height={170}
            format={inr}
          />
          {/* The dashed rule is what an average day bills. Days under it are
              days receivables grew, whatever the sales board says. */}
          <ChartCaption>{t.underLine}</ChartCaption>
        </Section>
      </div>

      <Section
        title={t.dueByCustomer}
        actions={
          customerId !== null ? (
            <Button variant="secondary" onClick={() => setCustomerId(null)}>
              {s.showAll}
            </Button>
          ) : null
        }
      >
        <div className="px-6">
          {byCustomer.length === 0 ? (
            // Every live invoice in this scope is checked in full.
            <EmptyState fact={t.noMoneyDue} />
          ) : (
            <>
              <BarChart
                summary={
                  topCustomer
                    ? t.topSummary(
                        topCustomer.name,
                        inr(topCustomer.balance),
                        Math.round((topCustomer.balance / (outstanding || 1)) * 100),
                      )
                    : t.noMoneyDue
                }
                data={customerBars}
                format={inr}
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
              {/* One name carrying a third of the book is a credit-limit
                  conversation, not a collections one. */}
              <ChartCaption>{t.markHint}</ChartCaption>
            </>
          )}
        </div>
      </Section>

      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
          {s.all}
        </Chip>
        <Chip active={filter === 'overdue'} onClick={() => setFilter('overdue')} count={rows.filter(isOverdue).length}>
          {status.invoice.overdue}
        </Chip>
        <Chip active={filter === 'reported'} onClick={() => setFilter('reported')} count={unverified.length}>
          {status.invoice.payment_reported}
        </Chip>
        <Chip active={filter === 'part_paid'} onClick={() => setFilter('part_paid')} count={rows.filter(isPartPaid).length}>
          {status.invoice.part_paid}
        </Chip>
        <Chip active={filter === 'closed'} onClick={() => setFilter('closed')} count={rows.filter(isClosed).length}>
          {status.invoice.closed}
        </Chip>
        {customerId !== null ? (
          <Chip active onClick={() => setCustomerId(null)}>
            {shortName(byCustomer.find((c) => c.id === customerId)?.name ?? CUSTOMERS_LIST.find((c) => c.id === customerId)?.name ?? s.customer)} ×
          </Chip>
        ) : null}
        {/* Right-aligned beside the chips on a wide screen; once the chips wrap
            it becomes its own left-aligned line rather than a stray fragment
            pushed to the far edge of the last row. */}
        <span
          className="w-full font-serif text-[13px] italic sm:ml-auto sm:w-auto"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {t.openForDetails}
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
            // Nothing in scope matches the filter — the ledger itself is not empty.
            <EmptyState
              fact={t.noInvoicesHere}
              action={{ label: s.showAll, onClick: () => { setFilter('all'); setCustomerId(null); } }}
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
        // On a phone the sheet header sets the stamp on its own row under the
        // customer's name, so the name keeps the full width.
        {...(selectedStatus ? { status: selectedStatus } : {})}
        revision={selected ? t.dated(formatDate(selected.invoice.date)) : undefined}
        footer={
          selected ? (
            <>
              {/* A second person matches the reported money against the bank. */}
              {selected.reportedUnverified > 0 ? (
                <Button
                  variant="primary"
                  onClick={() => setCrossChecked((ids) => [...ids, selected.invoice.id])}
                >
                  {t.check(formatINR(selected.reportedUnverified, { decimals: 0 }))}
                </Button>
              ) : null}
              {canClose ? (
                <Button variant="primary" onClick={() => setClosing(true)}>
                  {t.closeInvoice}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                disabled={reminded.includes(selected.invoice.id)}
                onClick={() => setReminded((ids) => (ids.includes(selected.invoice.id) ? ids : [...ids, selected.invoice.id]))}
              >
                {reminded.includes(selected.invoice.id) ? t.reminderSent : t.sendReminder}
              </Button>
            </>
          ) : undefined
        }
      >
        {selected ? (
          <InvoiceDetail row={selected} density={density} reminded={reminded.includes(selected.invoice.id)} />
        ) : null}
      </SideSheet>

      {/* Closing is the assertion the owner's whole rule protects, so it is the
          one action on this screen that stops and asks. Closing says the full
          total was received and cross-verified against the bank statement; it
          leaves the ledger and the ageing and stops the chasing. Reopening it
          is an audit entry, not a click. */}
      {selected ? (
        <ConfirmModal
          open={closing}
          onClose={() => setClosing(false)}
          onConfirm={() => setClosedHere((ids) => [...ids, selected.invoice.id])}
          title={t.closeTitle}
          confirmLabel={t.closeYes}
          consequence={
            <>
              <p>{t.closeWhat(selected.invoice.number, formatINR(selected.total, { decimals: 0 }))}</p>
              <p className="mt-2">{t.closeNote}</p>
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
  const t = useWords(invoiceWords);
  const s = useWords(salesWords);
  const status = useWords(statusWords);
  const tripCols = useMemo(() => tripColumns(s), [s]);
  const { invoice } = row;
  const rank = RANK[row.status];
  const isVerified = rank >= VERIFIED_RANK;
  const receipt = RECEIPTS.find((r) => r.suggestedInvoiceId === invoice.id && r.verifiedBy === null);
  const trips = TRIPS.filter((t) => invoice.tripIds.includes(t.id));
  const customer = CUSTOMERS_LIST.find((c) => c.id === invoice.customerId);
  const outstanding = Math.max(0, row.balance - row.reportedUnverified);
  const amt = (n: number) => formatINR(n, { decimals: 0 });

  return (
    <>
      <SheetSection caption={t.steps}>
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
            a second person has cross-verified the money. The steps are the same
            status words the list uses.

            Six stamps and five connectors are wider than a phone at any type
            size — the words themselves are the width. Below `sm` it turns
            through ninety degrees: the same six steps, the same connector, read
            top to bottom. The connector keeps its meaning, because
            solid-versus-dashed is a border STYLE and works just as well down
            the left edge as along the top.
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
                    label={status.invoice[step.key]}
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
            {blockingLine(row, receipt?.recordedBy ?? null, receipt?.date ?? null, t)}
          </p>
          {receipt && row.reportedUnverified > 0 ? (
            <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {t.paidBy(t.methods[receipt.method])}
              {/* No bank reference means it was taken as cash. */}
              {receipt.reference ? <> · <IdCell>{receipt.reference}</IdCell></> : ` · ${t.noBankRef}`}
            </p>
          ) : null}
        </div>
        {/* Nothing about the money changes — only that you asked for it. */}
        {reminded ? (
          <div className="mt-2">
            <Note>{t.reminderNote(invoice.customerName, '14:42')}</Note>
          </div>
        ) : null}
      </SheetSection>

      <SheetSection caption={t.groups.received}>
        <ProportionBar
          summary={t.collectionSummary(
            amt(row.verified),
            amt(row.total),
            row.reportedUnverified > 0 ? amt(row.reportedUnverified) : null,
          )}
          height={22}
          // The middle band is money in nobody's hands: claimed by one person,
          // confirmed by none. It sits outside the checked segment on purpose
          // and never joins it without a second signature.
          segments={[
            { label: t.checked, value: row.verified, tone: 'var(--status-ready)' },
            ...(row.reportedUnverified > 0
              ? [{ label: t.notChecked, value: row.reportedUnverified, tone: 'var(--status-attention)' }]
              : []),
            { label: t.due, value: outstanding, tone: 'var(--surface-sunken)' },
          ]}
        />
      </SheetSection>

      <SheetSection caption={t.invoiceAmount}>
        <DetailGrid>
          <Detail label={t.beforeGst}>
            <MoneyCell value={invoice.taxableValue} accounting={false} />
          </Detail>
          <Detail label={t.gstAt(GST_PCT)}>
            <MoneyCell value={invoice.gstAmount} accounting={false} />
          </Detail>
          <Detail label={s.total}>
            <MoneyCell value={invoice.total} accounting={false} />
          </Detail>
          {/* Verified against the bank. */}
          <Detail label={t.receivedChecked}>
            <MoneyCell value={row.verified} accounting={false} />
          </Detail>
          {/* Never summed into the line above it. That is the whole rule. */}
          <Detail label={t.receivedNotChecked}>
            {row.reportedUnverified > 0 ? (
              <Provisional by="person">
                <MoneyCell value={row.reportedUnverified} accounting={false} />
              </Provisional>
            ) : (
              <MoneyCell value={0} accounting={false} />
            )}
          </Detail>
          <Detail label={t.due}>
            <MoneyCell value={row.balance} accounting={false} />
          </Detail>
        </DetailGrid>
        <div className="mt-2">
          <Note>{t.datesLine(customer?.site ?? invoice.customerName, formatDate(invoice.date), formatDate(invoice.dueDate))}</Note>
        </div>
      </SheetSection>

      {/* Most intra-TN tipper loads sit under the ₹1,00,000 consignment
          threshold and below the e-invoicing turnover trigger, so a blank here
          is the normal path, not a gap — it says "Not needed", calmly. */}
      <SheetSection caption={t.papers}>
        <DetailGrid>
          {/* IRN: the e-invoice reference number. */}
          <Detail label={t.eInvoiceNo}>{invoice.irn ? <IdCell>{invoice.irn}</IdCell> : <NotNeeded label={t.notNeeded} />}</Detail>
          <Detail label={t.ewbs}>
            {invoice.ewbNumbers.length > 0 ? <IdCell>{invoice.ewbNumbers.join(', ')}</IdCell> : <NotNeeded label={t.notNeeded} />}
          </Detail>
          <Detail label={t.loads}>
            <QuantityCell value={trips.length} decimals={0} />
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.loadsN(trips.length)}>
        <DataTable
          density={density}
          columns={tripCols}
          rows={trips}
          rowKey={(t) => t.id}
          // Raised against an advance or a counter sale: no dispatch to match.
          empty={<EmptyState fact={t.noLoads} />}
        />
      </SheetSection>
    </>
  );
}

/** The one sentence stating exactly what is stopping this invoice from closing. */
function blockingLine(row: LedgerRow, reportedBy: string | null, reportedOn: string | null, t: InvoiceText): string {
  const amt = (n: number) => formatINR(n, { decimals: 0 });
  const b = t.blocking;
  if (row.status === 'closed') return b.closed(amt(row.total));
  if (row.status === 'draft') return b.draft;
  // Reported by one person, not yet verified by a second; the invoice stays open until it is.
  if (row.reportedUnverified > 0)
    return b.reported(reportedBy ?? b.someone, amt(row.reportedUnverified), formatDate(reportedOn ?? row.invoice.date));
  if (row.balance <= 0) return b.allChecked;
  if (row.verified > 0) return b.partly(amt(row.verified), amt(row.total), amt(row.balance), row.daysOverdue);
  return b.nothing(amt(row.balance), row.daysOverdue);
}

/** Below the threshold there is nothing to show. That is a fact, not an alarm. */
function NotNeeded({ label }: { label: string }) {
  return (
    <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-secondary)' }}>
      {label}
    </span>
  );
}

/* ----------------------------------------------------------------- columns */

function ledgerColumns(t: InvoiceText, s: SalesText, status: StatusText): Column<LedgerRow>[] {
  return [
    {
      key: 'number',
      header: t.invoiceNo,
      type: 'id',
      sticky: true,
      width: 168,
      group: t.groups.invoice,
      render: (r) => r.invoice.number,
    },
    { key: 'date', header: s.date, width: 110, group: t.groups.invoice, render: (r) => formatDate(r.invoice.date) },
    {
      key: 'customer',
      header: s.customer,
      render: (r) => <Stacked primary={r.invoice.customerName} secondary={CUSTOMERS_LIST.find((c) => c.id === r.invoice.customerId)?.site} />,
    },
    // Taxable value: the amount before GST.
    { key: 'taxable', header: t.beforeGst, unit: '₹', type: 'money', group: t.groups.amount, render: (r) => <MoneyCell value={r.invoice.taxableValue} /> },
    { key: 'gst', header: t.gst, unit: '₹', type: 'money', group: t.groups.amount, render: (r) => <MoneyCell value={r.invoice.gstAmount} /> },
    { key: 'total', header: s.total, unit: '₹', type: 'money', group: t.groups.amount, render: (r) => <MoneyCell value={r.total} /> },
    { key: 'verified', header: t.checked, unit: '₹', type: 'money', group: t.groups.received, render: (r) => <MoneyCell value={r.verified} /> },
    {
      key: 'reported',
      header: t.notChecked,
      unit: '₹',
      type: 'money',
      group: t.groups.received,
      // Its own column, hatched, and never added into Checked. Asserted, not true.
      render: (r) => (r.reportedUnverified > 0 ? <Provisional by="person"><MoneyCell value={r.reportedUnverified} /></Provisional> : null),
    },
    { key: 'balance', header: t.due, unit: '₹', type: 'money', group: t.groups.received, render: (r) => <MoneyCell value={r.balance} /> },
    {
      key: 'status',
      header: s.status,
      type: 'status',
      width: 190,
      render: (r) => (
        <StatusStamp
          status={INVOICE_STATUS_FAMILY[r.status]}
          label={status.invoice[r.status]}
          fillRatio={r.fillRatio}
          provisional={r.reportedUnverified > 0}
          {...(r.daysOverdue > 0 ? { severity: t.lateDays(r.daysOverdue) } : {})}
        />
      ),
    },
  ];
}

/** Material names are the product's own names and are not translated. */
const materialOf = (trip: Trip) => PRODUCTS.find((p) => p.code === trip.productCode)?.label ?? trip.productCode;

function tripColumns(s: SalesText): Column<Trip>[] {
  return [
    { key: 'trip', header: s.trip, type: 'id', sticky: true, width: 150, render: (trip) => trip.tripNumber },
    { key: 'vehicle', header: s.vehicle, type: 'id', width: 140, render: (trip) => VEHICLES.find((v) => v.id === trip.vehicleId)?.displayReg ?? null },
    { key: 'product', header: s.material, render: (trip) => materialOf(trip) },
    { key: 'units', header: s.sold, unit: s.units, type: 'num', width: 110, render: (trip) => <QuantityCell value={trip.soldUnits} decimals={1} /> },
    { key: 'revenue', header: s.amount, unit: '₹', type: 'money', width: 128, render: (trip) => <MoneyCell value={trip.revenue} /> },
    {
      key: 'basis',
      header: s.countedBy,
      width: 190,
      // Where a billed quantity came from decides whether the customer can
      // argue with it. Buckets and agreed units are an assertion; a
      // weighbridge ticket is not.
      render: (trip) =>
        trip.qtyBasis === 'agreed_units' || trip.qtyBasis === 'loader_buckets' ? (
          <Provisional by="person">{s.basis[trip.qtyBasis]}</Provisional>
        ) : (
          s.basis[trip.qtyBasis]
        ),
    },
  ];
}
