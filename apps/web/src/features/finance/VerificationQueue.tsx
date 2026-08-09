import { useMemo, useState } from 'react';
import { businessDate, formatDate, formatDateTime, formatINR, formatINRCompact } from '@linck/domain';
import {
  INVOICES,
  INVOICE_STATUS_FAMILY,
  INVOICE_STATUS_LABEL,
  NOW,
  pendingVerification,
  RECEIPTS,
  type Invoice,
  type Receipt,
} from '@linck/mock';
import {
  AgeingBar,
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
  MoneyCell,
  Note,
  PageHeader,
  ProportionBar,
  Provisional,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  SuggestionStrip,
  TileRow,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';

/**
 * PAYMENT VERIFICATION QUEUE.
 *
 * This screen exists to enforce one rule: money reported is not money
 * confirmed, and an invoice does not close until a second person has seen the
 * bank line. Every row here is money the ledger refuses to count as collected.
 *
 * Two decisions worth defending:
 *
 *   1. The four-eyes block is PRINTED, never hidden. Whoever recorded a receipt
 *      cannot verify it — but the button stays visible, disabled, with the
 *      reason beside it. Hide the reason and a three-person accounts office
 *      with one person on leave concludes the software is broken, and the fix
 *      they invent is a shared login. That is a worse outcome than a blocked
 *      button, so the block explains itself.
 *
 *   2. The ageing counter is the real control. A blocked button stops a bad
 *      verification; it does not get a good one done. So the oldest item's age
 *      sits in the tile row, every row carries its days-in-queue, and the queue
 *      is drawn as an ageing bar — the shape of the backlog is the thing the
 *      accounts head is accountable for, not the shape of the rulebook.
 *
 * The two charts answer the two questions this desk actually gets asked. How
 * old is the backlog (ageing), and how much of it is cash (method mix) — cash
 * carries no UTR to check against a bank line, so its share is the share of the
 * queue that can only ever be verified by a custody trail.
 *
 * Verification happens from the side sheet, not from the row. Confirming money
 * off a seven-column table row is confirming a summary; the sheet puts the
 * stated match reason, the customer's other open invoices and the four-eyes
 * rule in front of the person signing, which is what "a second pair of eyes"
 * was supposed to mean.
 *
 * NOTE ON SITE SCOPE: receipts are org-level, not site-level — a bank account
 * belongs to the company, not to the Karapakkam crusher — so `siteScope` is
 * deliberately not read here. Scoping this list by plant would hide money.
 */

const METHOD_LABEL: Record<Receipt['method'], string> = {
  cash: 'Cash',
  neft: 'NEFT',
  rtgs: 'RTGS',
  imps: 'IMPS',
  upi: 'UPI',
  cheque: 'Cheque',
};

/** The one match reason strong enough to batch. Anything softer is verified one at a time. */
const EXACT_UTR_REASON = 'UTR exact, amount exact, date +1d';

/** Past this, an unverified receipt stops being a queue and starts being a control failure. */
const STALE_DAYS = 7;

function ageDays(iso: string): number {
  return Math.max(0, Math.floor((NOW.getTime() - Date.parse(iso)) / 86_400_000));
}

function invoiceOf(invoiceId: string | null): Invoice | null {
  return INVOICES.find((i) => i.id === invoiceId) ?? null;
}

function invoiceNumber(invoiceId: string | null): string | null {
  return invoiceOf(invoiceId)?.number ?? null;
}

function sum(list: Receipt[]): number {
  return list.reduce((s, r) => s + Number.parseFloat(r.amount), 0);
}

function amountOf(receipt: Receipt): number {
  return Number.parseFloat(receipt.amount);
}

/** Open invoices for a customer — what allocation could legitimately go against. */
function openInvoicesFor(customerId: string): Invoice[] {
  return INVOICES.filter((i) => i.customerId === customerId && i.status !== 'closed' && i.status !== 'draft');
}

interface AllocationEffect {
  invoice: Invoice;
  applied: number;
  balance: number;
  remaining: number;
}

/**
 * What confirming these receipts would actually do to the ledger.
 *
 * Stated per invoice rather than as one total, because "closes two invoices and
 * part-pays a third" is the sentence the person signing needs, and a single
 * rupee figure hides it.
 */
function allocationEffect(receipts: Receipt[]): AllocationEffect[] {
  const applied = new Map<string, number>();
  for (const r of receipts) {
    if (r.suggestedInvoiceId === null) continue;
    applied.set(r.suggestedInvoiceId, (applied.get(r.suggestedInvoiceId) ?? 0) + amountOf(r));
  }

  const out: AllocationEffect[] = [];
  for (const [invoiceId, value] of Array.from(applied.entries())) {
    const invoice = invoiceOf(invoiceId);
    if (invoice === null) continue;
    const balance = Number.parseFloat(invoice.balanceDue);
    out.push({ invoice, applied: value, balance, remaining: Math.max(0, balance - value) });
  }
  return out;
}

/**
 * The numbers the bars stop drawing when the page gets narrow.
 *
 * Both bars label a segment in place, and both drop the label when the segment
 * is too thin to hold one — at 375px that is most of them, so the ageing bar
 * arrives as four unlabelled blocks. The bar is still the right picture (the
 * SHAPE of the backlog is the finding); this restores the figures underneath it
 * below `md` rather than shrinking type nobody can read. It disappears the
 * moment the segments are wide enough to label themselves.
 */
function NarrowLegend({ items }: { items: { label: string; value: string; tone: string }[] }) {
  return (
    <dl className="mt-2 flex flex-col gap-1 md:hidden">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-3 text-[12px]">
          <dt className="flex min-w-0 items-baseline gap-2" style={{ color: 'var(--text-secondary)' }}>
            <span
              aria-hidden="true"
              className="block h-2 w-2 shrink-0 translate-y-[1px]"
              style={{ background: item.tone }}
            />
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

interface VerifiedRow {
  receipt: Receipt;
  verifier: string;
  inSession: boolean;
}

export function VerificationQueue() {
  const { persona, density } = useApp();
  const [verifiedNow, setVerifiedNow] = useState<Record<string, true>>({});
  const [filter, setFilter] = useState<'all' | 'utr' | 'cash' | 'blocked' | 'stale'>('all');
  const [stripDismissed, setStripDismissed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Ids awaiting confirmation — one for a sheet verify, many for the batch. */
  const [confirming, setConfirming] = useState<string[] | null>(null);

  const pending = pendingVerification();
  const queue = pending.filter((r) => verifiedNow[r.id] === undefined);
  const blockedFor = (r: Receipt) => r.recordedBy === persona.name;

  const rows = useMemo(() => {
    switch (filter) {
      case 'utr':
        return queue.filter((r) => r.suggestionReason === EXACT_UTR_REASON);
      case 'cash':
        return queue.filter((r) => r.method === 'cash');
      case 'blocked':
        return queue.filter((r) => r.recordedBy === persona.name);
      case 'stale':
        return queue.filter((r) => ageDays(r.date) > STALE_DAYS);
      default:
        return queue;
    }
  }, [queue, filter, persona.name]);

  // Verified today = what this session confirmed, plus what someone else already
  // confirmed on today's IST business date. Both are equally real.
  const verifiedToday: VerifiedRow[] = [
    ...pending
      .filter((r) => verifiedNow[r.id] !== undefined)
      .map((r) => ({ receipt: r, verifier: persona.name, inSession: true })),
    ...RECEIPTS.filter(
      (r) => r.verifiedBy !== null && r.verifiedAt !== null && businessDate(r.verifiedAt) === businessDate(NOW),
    ).map((r) => ({ receipt: r, verifier: r.verifiedBy ?? '', inSession: false })),
  ];

  const exactUtr = queue.filter((r) => r.suggestionReason === EXACT_UTR_REASON);
  const eligibleForBatch = exactUtr.filter((r) => !blockedFor(r));
  const blockedInBatch = exactUtr.length - eligibleForBatch.length;
  const staleCount = queue.filter((r) => ageDays(r.date) > STALE_DAYS).length;

  const verify = (ids: string[]) =>
    setVerifiedNow((prev) => {
      const next: Record<string, true> = { ...prev };
      for (const id of ids) next[id] = true;
      return next;
    });

  const oldest = queue.reduce<Receipt | null>((old, r) => (old === null || ageDays(r.date) > ageDays(old.date) ? r : old), null);

  /* --------------------------------------------------------------- charts */

  // Ageing is measured in money, not row count. Nine tiny cash receipts and one
  // ₹7 L RTGS are not the same backlog, and a count would draw them the same.
  const ageingBuckets = [
    { label: 'Today', value: sum(queue.filter((r) => ageDays(r.date) === 0)) },
    { label: '1–3 days', value: sum(queue.filter((r) => ageDays(r.date) >= 1 && ageDays(r.date) <= 3)) },
    { label: '4–7 days', value: sum(queue.filter((r) => ageDays(r.date) >= 4 && ageDays(r.date) <= STALE_DAYS)) },
    { label: `Over ${STALE_DAYS} days`, value: sum(queue.filter((r) => ageDays(r.date) > STALE_DAYS)) },
  ];

  const queueTotal = sum(queue);
  const cashTotal = sum(queue.filter((r) => r.method === 'cash'));
  const cashSharePct = queueTotal > 0 ? Math.round((cashTotal / queueTotal) * 100) : 0;

  // Banked methods take the monochrome ramp because a UTR is a UTR. Cash takes
  // the attention hue — it is the only method with nothing to check against a
  // bank line, so it is the only one where something can quietly be wrong.
  const bankedTotals = (['neft', 'rtgs', 'imps', 'upi', 'cheque'] as const)
    .map((method) => ({ method, value: sum(queue.filter((r) => r.method === method)) }))
    .filter((m) => m.value > 0)
    .sort((a, b) => b.value - a.value);

  const methodSegments = [
    ...bankedTotals.map((m, i) => ({
      label: METHOD_LABEL[m.method],
      value: m.value,
      tone: `var(--chart-${Math.min(5, i + 1)})`,
    })),
    ...(cashTotal > 0 ? [{ label: 'Cash', value: cashTotal, tone: 'var(--status-attention)' }] : []),
  ];

  /* ---------------------------------------------------------- the selection */

  const selected = selectedId === null ? null : (RECEIPTS.find((r) => r.id === selectedId) ?? null);
  const selectedVerifier =
    selected === null ? null : verifiedNow[selected.id] !== undefined ? persona.name : selected.verifiedBy;
  const selectedBlocked = selected !== null && blockedFor(selected);

  const confirmTargets =
    confirming === null
      ? []
      : confirming.map((id) => RECEIPTS.find((r) => r.id === id)).filter((r): r is Receipt => r !== undefined);
  const confirmEffects = allocationEffect(confirmTargets);
  const confirmTotal = sum(confirmTargets);
  const closesCount = confirmEffects.filter((e) => e.remaining <= 0.5).length;

  const queueColumns: Column<Receipt>[] = [
    {
      key: 'date',
      header: 'Received',
      group: 'Receipt',
      width: 150,
      sticky: true,
      render: (r) => (
        <Stacked
          primary={formatDate(r.date)}
          secondary={ageDays(r.date) === 0 ? 'today' : `${ageDays(r.date)}d in queue`}
        />
      ),
    },
    {
      key: 'reference',
      header: 'Reference',
      type: 'id',
      group: 'Receipt',
      width: 160,
      // Cash has no UTR. The dash is the honest answer; the footnote below the
      // table says what actually verifies a cash receipt instead.
      render: (r) => <IdCell>{r.reference}</IdCell>,
    },
    { key: 'method', header: 'Method', group: 'Receipt', width: 96, render: (r) => METHOD_LABEL[r.method] },
    {
      key: 'customer',
      header: 'Customer',
      group: 'Party',
      render: (r) => <Stacked primary={r.customerName} />,
    },
    {
      key: 'amount',
      header: 'Amount',
      unit: '₹',
      type: 'money',
      group: 'Amount',
      width: 140,
      // Reported, not confirmed. The hatch is the ledger's position on it.
      render: (r) => (
        <Provisional>
          <MoneyCell value={r.amount} />
        </Provisional>
      ),
    },
    {
      key: 'match',
      header: 'Linck suggests',
      group: 'Match',
      width: 300,
      render: (r) => {
        const number = invoiceNumber(r.suggestedInvoiceId);
        if (number === null) return null;
        return (
          <Stacked
            primary={<IdCell>{number}</IdCell>}
            secondary={<span style={{ color: 'var(--text-tertiary)' }}>{r.suggestionReason}</span>}
          />
        );
      },
    },
    { key: 'recordedBy', header: 'Recorded by', group: 'Control', width: 130, render: (r) => r.recordedBy },
    {
      key: 'standing',
      header: 'Second pair of eyes',
      group: 'Control',
      width: 260,
      // The row states the standing; the signing happens in the sheet, where
      // the match reason and the customer's other open invoices are visible.
      render: (r) =>
        blockedFor(r) ? (
          // Wraps rather than squeezes: in the phone card this pair has ~300px,
          // and the reason must stay printed beside the stamp, not truncated.
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatusStamp status="dormant" label="Blocked" />
            <span style={{ color: 'var(--text-tertiary)' }}>You recorded this one — it needs someone else.</span>
          </span>
        ) : (
          <StatusStamp status="pending" label="Awaiting" severity={`${ageDays(r.date)}d`} provisional />
        ),
    },
  ];

  const verifiedColumns: Column<VerifiedRow>[] = [
    {
      key: 'date',
      header: 'Received',
      group: 'Receipt',
      width: 150,
      sticky: true,
      render: (v) => formatDate(v.receipt.date),
    },
    {
      key: 'reference',
      header: 'Reference',
      type: 'id',
      group: 'Receipt',
      width: 160,
      render: (v) => <IdCell>{v.receipt.reference}</IdCell>,
    },
    { key: 'customer', header: 'Customer', group: 'Party', render: (v) => v.receipt.customerName },
    {
      key: 'amount',
      header: 'Amount',
      unit: '₹',
      type: 'money',
      group: 'Amount',
      width: 140,
      // Confirmed: the hatch dissolves, the rule goes solid. That is the whole event.
      render: (v) => (
        <Provisional confirmed>
          <MoneyCell value={v.receipt.amount} />
        </Provisional>
      ),
    },
    {
      key: 'invoice',
      header: 'Applied to',
      group: 'Match',
      width: 180,
      render: (v) => <IdCell>{invoiceNumber(v.receipt.suggestedInvoiceId)}</IdCell>,
    },
    { key: 'recordedBy', header: 'Recorded by', group: 'Control', width: 130, render: (v) => v.receipt.recordedBy },
    {
      key: 'verifier',
      header: 'Verified by',
      group: 'Control',
      width: 200,
      render: (v) => (
        <span className="flex items-center gap-2">
          <span>{v.verifier}</span>
          {v.inSession ? <StatusStamp status="ready" label="Just now" /> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Finance · Receipts"
        title="Payment verification"
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source="v_receipt_verification" freshness="materialised" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              Signed in as {persona.name} · {persona.roleLabel}
            </span>
          </span>
        }
      />

      {/* Stated once, plainly, where it cannot be missed: the ranking engine is
          not one of the two people. It proposes and shows its reason; the two
          signatures on a receipt are both human. */}
      <p className="font-serif px-6 pt-4 text-[14px] italic" style={{ color: 'var(--text-secondary)' }}>
        An invoice does not close on a report of payment. Linck ranks the likely match and states the reason it used —
        it counts as neither of the two people. One person records, a different person confirms.
      </p>

      {/* Stacked on a phone with a hairline BETWEEN tiles rather than a stray
          right edge, and pulled back to the page's px-6 measure so the tile
          numbers line up with the prose above them. */}
      <TileRow className="mt-4 grid-cols-1 [&>*]:border-[var(--border-subtle)] max-md:[&>*]:border-b max-md:[&>*]:px-6 max-md:[&>*:last-child]:border-b-0 md:grid-cols-3 md:[&>*]:border-r">
        <KpiTile
          eyebrow="Awaiting verification"
          value={formatINRCompact(queueTotal)}
          delta={{ text: `${queue.length} receipts · counted as collected nowhere`, tone: 'attention' }}
          asOf="14:42"
          source="v_receipt_verification"
          freshness="materialised"
        />
        <KpiTile
          eyebrow="Verified today"
          value={formatINRCompact(sum(verifiedToday.map((v) => v.receipt)))}
          delta={{
            text: `${verifiedToday.length} receipts · ${verifiedToday.filter((v) => v.inSession).length} at this desk`,
          }}
          asOf="14:42"
          source="v_receipt_verification"
        />
        {/* The ageing counter, not the blocked button, is the actual control.
            A queue nobody clears is the failure mode this rule invites. */}
        <KpiTile
          eyebrow="Oldest in the queue"
          value={oldest === null ? '–' : `${ageDays(oldest.date)} days`}
          delta={{
            text: oldest === null ? 'Nothing waiting' : `${oldest.customerName} · ${METHOD_LABEL[oldest.method]}`,
            tone: oldest !== null && ageDays(oldest.date) > STALE_DAYS ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source="v_receipt_ageing"
          freshness="materialised"
        />
      </TileRow>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-2 xl:grid-cols-2">
        <Section caption="How long the money has been waiting" title="The queue by age">
          <AgeingBar
            summary={`${formatINRCompact(queueTotal)} awaiting a second signature across ${queue.length} receipts, of which ${formatINRCompact(
              ageingBuckets[3]?.value ?? 0,
            )} has waited more than ${STALE_DAYS} days.`}
            buckets={ageingBuckets}
            format={(v) => formatINRCompact(v)}
          />
          <NarrowLegend
            items={ageingBuckets.map((b, i) => ({
              label: b.label,
              value: formatINRCompact(b.value),
              tone: `var(--chart-${Math.min(5, i + 1)})`,
            }))}
          />
          <ChartCaption>
            Darker is older. The right-hand end is the only part that matters at a review — money sitting there is not
            waiting on a rule, it is waiting on a person, and the customer has long since assumed it is settled.
          </ChartCaption>
        </Section>

        <Section caption="What the queue is made of" title="Receipts by method">
          <ProportionBar
            summary={`Cash is ${cashSharePct}% of the ${formatINRCompact(queueTotal)} waiting — ${formatINRCompact(
              cashTotal,
            )} with no bank line to check it against.`}
            segments={methodSegments}
          />
          <NarrowLegend
            items={methodSegments.map((s) => ({ label: s.label, value: formatINRCompact(s.value), tone: s.tone }))}
          />
          <ChartCaption>
            Every banked method leaves a UTR or a cheque number a second person can match. Cash leaves nothing, so its
            share is the share of this queue that can only ever be verified by a custody trail — which is why it is the
            one segment spending colour.
          </ChartCaption>
        </Section>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={queue.length}>
          Everything waiting
        </Chip>
        <Chip active={filter === 'utr'} onClick={() => setFilter('utr')} count={exactUtr.length}>
          Exact UTR match
        </Chip>
        <Chip active={filter === 'cash'} onClick={() => setFilter('cash')} count={queue.filter((r) => r.method === 'cash').length}>
          Cash
        </Chip>
        {/* The chip the ageing bar argues for: the oldest bucket, one click away. */}
        <Chip active={filter === 'stale'} onClick={() => setFilter('stale')} count={staleCount}>
          Waiting over {STALE_DAYS} days
        </Chip>
        <Chip
          active={filter === 'blocked'}
          onClick={() => setFilter('blocked')}
          count={queue.filter(blockedFor).length}
        >
          Blocked for you
        </Chip>
      </div>

      {exactUtr.length > 0 && !stripDismissed ? (
        <div className="px-6 pt-4">
          <SuggestionStrip
            applyLabel={eligibleForBatch.length > 0 ? `Verify these ${eligibleForBatch.length}` : 'Nothing to apply'}
            onApply={
              eligibleForBatch.length > 0 ? () => setConfirming(eligibleForBatch.map((r) => r.id)) : undefined
            }
            onDismiss={() => setStripDismissed(true)}
          >
            {exactUtr.length} receipts match a bank line on exact UTR, exact amount and a next-day value date.{' '}
            {blockedInBatch > 0
              ? `${blockedInBatch} of them you recorded yourself and will stay in the queue for someone else.`
              : 'Apply verification to all of them?'}
          </SuggestionStrip>
        </div>
      ) : null}

      <Section
        caption="Money reported, not yet confirmed"
        title="Awaiting a second pair of eyes"
        actions={<AsOfStamp asOf="14:42" source="v_receipt_verification" freshness="materialised" />}
      >
        <DataTable
          density={density}
          columns={queueColumns}
          rows={rows}
          rowKey={(r) => r.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(r) => setSelectedId(r.id)}
          rail={(r) => ({ status: ageDays(r.date) > STALE_DAYS ? 'critical' : 'pending', provenance: r.provenance })}
          empty={
            <EmptyState
              fact={filter === 'all' ? 'Nothing is waiting on a second signature.' : 'No receipt in this view.'}
              because={
                filter === 'all'
                  ? 'Every reported receipt has been cross-verified. Invoices can close.'
                  : 'The filter is narrower than the queue — the money is still there.'
              }
              {...(filter === 'all'
                ? {}
                : { action: { label: 'Show everything waiting', onClick: () => setFilter('all') } })}
            />
          }
        />
        <p className="font-serif px-6 pt-3 text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
          Cash receipts carry no UTR, so the reference reads as a dash rather than a blank. What verifies cash is the
          custody trail instead — who took it, who counted it, and which day&rsquo;s deposit slip it went into. Open a
          row to see the match Linck proposed, the reason it used, and the customer&rsquo;s other open invoices.
        </p>
      </Section>

      <Section
        caption="Confirmed by two people"
        title="Verified today"
        actions={<AsOfStamp asOf="14:42" source="v_receipt_verification" freshness="live" />}
      >
        <DataTable
          density={density}
          columns={verifiedColumns}
          rows={verifiedToday}
          rowKey={(v) => v.receipt.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(v) => setSelectedId(v.receipt.id)}
          rail={() => ({ status: 'ready', provenance: 'confirmed' })}
          empty={
            <EmptyState
              fact="Nothing has been verified today."
              because="Until a second person confirms, none of it counts as collected."
            />
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        title={selected?.customerName ?? ''}
        identifier={selected?.reference ?? (selected ? 'No reference — cash' : undefined)}
        {...(selected
          ? {
              status:
                selectedVerifier !== null
                  ? { family: 'ready' as const, label: 'Verified' }
                  : {
                      family: 'pending' as const,
                      label: 'Awaiting',
                      severity: `${ageDays(selected.date)}d`,
                      provisional: true,
                    },
            }
          : {})}
        revision={selected ? `RECORDED BY ${selected.recordedBy.toUpperCase()}` : undefined}
        footer={
          selected === null ? undefined : selectedVerifier !== null ? (
            // The sheet footer is a fixed 56px band. On a phone it has ~335px of
            // width, so the sentence beside the stamp has to be allowed to wrap
            // inside its own share of the row and to set a step smaller — the
            // alternative is copy spilling out over the scroll area above it.
            <span className="flex w-full min-w-0 items-center gap-2.5">
              <StatusStamp status="ready" label="Verified" />
              <span
                className="font-serif min-w-0 flex-1 text-[11px] italic leading-tight sm:text-[12px]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Confirmed by {selectedVerifier}, who did not record it. Two people have now seen this money.
              </span>
            </span>
          ) : (
            <span className="flex w-full min-w-0 items-center gap-2.5">
              {/* Disabled, never hidden — and the reason sits beside it, because
                  a button that vanishes teaches an office to share a login. */}
              <Button
                variant="primary"
                className="shrink-0"
                disabled={selectedBlocked}
                onClick={() => setConfirming([selected.id])}
              >
                Verify this receipt
              </Button>
              {selectedBlocked ? (
                <span
                  className="font-serif min-w-0 flex-1 text-[11px] italic leading-tight sm:text-[12px]"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  You recorded this one — it needs someone else.
                </span>
              ) : (
                <span
                  className="font-serif min-w-0 flex-1 text-[11px] italic leading-tight sm:text-[12px]"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Confirming counts this money as collected.
                </span>
              )}
            </span>
          )
        }
      >
        {selected ? <ReceiptDetail receipt={selected} verifier={selectedVerifier} /> : null}
      </SideSheet>

      <ConfirmModal
        open={confirming !== null && confirmTargets.length > 0}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          verify(confirmTargets.map((r) => r.id));
          setSelectedId(null);
        }}
        title={confirmTargets.length === 1 ? 'Verify this receipt?' : `Verify ${confirmTargets.length} receipts?`}
        confirmLabel={confirmTargets.length === 1 ? 'Verify' : `Verify all ${confirmTargets.length}`}
        consequence={
          <>
            {confirmTargets.length === 1 ? (
              <>Confirming {formatINR(confirmTargets[0]?.amount ?? '0')} recorded by {confirmTargets[0]?.recordedBy}. </>
            ) : (
              <>
                Confirming {formatINR(confirmTotal)} across {confirmTargets.length} receipts, each matched on exact UTR.{' '}
              </>
            )}
            {confirmEffects.length === 0 ? (
              <>
                None of them carries a suggested invoice, so this confirms the money into the ledger without closing
                anything. Allocation stays open.
              </>
            ) : (
              <>
                {closesCount > 0
                  ? `This closes ${closesCount === 1 ? 'one invoice' : `${closesCount} invoices`} outright.`
                  : 'No invoice is closed by it — every one stays part-paid.'}
                <ul className="font-sans mt-3 not-italic">
                  {confirmEffects.map((e) => (
                    // Number over effect on a phone; the two side by side need
                    // ~380px and the modal has 343 at 375.
                    <li
                      key={e.invoice.id}
                      className="flex flex-col gap-x-3 py-1 text-[13px] sm:flex-row sm:items-baseline sm:justify-between"
                      style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                    >
                      <span className="font-id">{e.invoice.number}</span>
                      <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                        {formatINR(e.applied, { decimals: 0 })} applied ·{' '}
                        {e.remaining <= 0.5
                          ? 'balance cleared'
                          : `${formatINR(e.remaining, { decimals: 0 })} still due`}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        }
      />
    </>
  );
}

/**
 * The receipt, as the second person needs to see it.
 *
 * More than the row carried: the stated matching reason, what the suggested
 * invoice looks like before and after this money lands, the customer's OTHER
 * open invoices so a wrong allocation is visible rather than assumed, and the
 * four-eyes rule printed where the signing happens.
 */
function ReceiptDetail({ receipt, verifier }: { receipt: Receipt; verifier: string | null }) {
  const suggested = invoiceOf(receipt.suggestedInvoiceId);
  const others = openInvoicesFor(receipt.customerId).filter((i) => i.id !== receipt.suggestedInvoiceId);
  const amount = amountOf(receipt);
  const age = ageDays(receipt.date);

  return (
    <>
      <SheetSection caption="The receipt">
        <DetailGrid>
          <Detail label="Received on">
            {formatDate(receipt.date)} · {age === 0 ? 'today' : `${age} days in the queue`}
          </Detail>
          <Detail label="Amount reported">
            <Provisional confirmed={verifier !== null}>
              <MoneyCell value={receipt.amount} accounting={false} />
            </Provisional>
          </Detail>
          <Detail label="Method">{METHOD_LABEL[receipt.method]}</Detail>
          <Detail label={receipt.method === 'cheque' ? 'Cheque number' : 'Bank reference'}>
            <IdCell>{receipt.reference}</IdCell>
          </Detail>
          <Detail label="Recorded by">{receipt.recordedBy}</Detail>
          <Detail label="Entered as of">{formatDate(receipt.date)}</Detail>
          <Detail label="Verified by">{verifier ?? '–'}</Detail>
          <Detail label="Verified at">
            {receipt.verifiedAt !== null ? formatDateTime(receipt.verifiedAt) : verifier !== null ? 'Just now' : '–'}
          </Detail>
        </DetailGrid>
        {receipt.reference === null ? (
          <Note>
            Cash carries no bank reference, so there is nothing to match against a statement line. What stands in for it
            is the custody trail — who took it, who counted it, and which day&rsquo;s deposit slip it went into.
          </Note>
        ) : null}
      </SheetSection>

      <SheetSection caption="What Linck proposes, and why">
        {suggested === null ? (
          <Note>
            No invoice was ranked high enough to suggest. Verifying confirms the money without allocating it, and the
            allocation stays an open job.
          </Note>
        ) : (
          <>
            <DetailGrid>
              <Detail label="Suggested invoice">
                <IdCell>{suggested.number}</IdCell>
              </Detail>
              <Detail label="Standing">
                <StatusStamp
                  status={INVOICE_STATUS_FAMILY[suggested.status]}
                  label={INVOICE_STATUS_LABEL[suggested.status]}
                  {...(suggested.daysOverdue > 0 ? { severity: `+${suggested.daysOverdue}d` } : {})}
                  {...(suggested.status === 'payment_reported' ? { provisional: true } : {})}
                />
              </Detail>
              <Detail label="Invoice total">
                <MoneyCell value={suggested.total} accounting={false} />
              </Detail>
              <Detail label="Balance before this">
                <MoneyCell value={suggested.balanceDue} accounting={false} />
              </Detail>
            </DetailGrid>
            <Note>Match reason as stated by the ranker: {receipt.suggestionReason ?? 'none recorded'}.</Note>
            <div className="pt-3">
              <ProportionBar
                summary={`${formatINR(suggested.receivedVerified)} verified of ${formatINR(
                  suggested.total,
                )}; this receipt would cover a further ${formatINR(receipt.amount)}.`}
                height={22}
                segments={[
                  { label: 'Verified', value: Number.parseFloat(suggested.receivedVerified), tone: 'var(--status-ready)' },
                  { label: 'This receipt', value: amount, tone: 'var(--status-attention)' },
                  {
                    label: 'Still due',
                    value: Math.max(
                      0,
                      Number.parseFloat(suggested.total) - Number.parseFloat(suggested.receivedVerified) - amount,
                    ),
                    tone: 'var(--surface-sunken)',
                  },
                ]}
              />
              <ChartCaption>
                The middle segment is the part that only exists because somebody said so. Verifying is what moves it
                into the first segment; nothing else does.
              </ChartCaption>
            </div>
          </>
        )}
      </SheetSection>

      <SheetSection caption={`Other open invoices for this customer (${others.length})`}>
        {others.length === 0 ? (
          <Note>
            Nothing else is open for {receipt.customerName}, so the suggested invoice is the only place this money can
            land.
          </Note>
        ) : (
          <>
            <ul className="text-[13px]">
              {others.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-col gap-1 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="font-id">{i.number}</span>
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      raised {formatDate(i.date)} · due {formatDate(i.dueDate)}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <MoneyCell value={i.balanceDue} />
                    <StatusStamp
                      status={INVOICE_STATUS_FAMILY[i.status]}
                      label={INVOICE_STATUS_LABEL[i.status]}
                      {...(i.daysOverdue > 0 ? { severity: `+${i.daysOverdue}d` } : {})}
                    />
                  </span>
                </li>
              ))}
            </ul>
            <Note>
              Shown so a wrong allocation is visible rather than assumed. An amount that matches an older invoice
              better than the suggested one is the commonest way money ends up against the wrong bill.
            </Note>
          </>
        )}
      </SheetSection>

      <SheetSection caption="The rule this desk runs on">
        <Note>
          One person records a receipt, a different person confirms it. {receipt.recordedBy} recorded this one, so{' '}
          {receipt.recordedBy} cannot verify it — anyone else in accounts can. Until a second person does, the amount is
          counted as collected nowhere in this system and the invoice stays open.
        </Note>
      </SheetSection>
    </>
  );
}
