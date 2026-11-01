import { useMemo, useState } from 'react';
import { businessDate, formatDate, formatDateTime, formatINR } from '@linck/domain';
import {
  INVOICES,
  INVOICE_STATUS_FAMILY,
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
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useInrCompact } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { verifyWords, type MatchReason } from './words.js';

/**
 * CHECK PAYMENTS (payment verification queue).
 *
 * This screen exists to enforce one rule: money reported is not money
 * confirmed, and an invoice does not close until a second person has seen the
 * bank line. Every row here is money the ledger refuses to count as collected.
 * Linck ranks the likely invoice and states its reason, but it is neither of
 * the two people: one person adds a payment, a different person checks it.
 *
 * Two decisions worth defending:
 *
 *   1. The two-person block is PRINTED, never hidden. Whoever added a payment
 *      cannot check it — but the button stays visible, disabled, with the
 *      reason beside it. Hide the reason and a three-person accounts office
 *      with one person on leave concludes the software is broken, and the fix
 *      they invent is a shared login. That is a worse outcome than a blocked
 *      button, so the block explains itself.
 *
 *   2. The age counter is the real control. A blocked button stops a bad
 *      check; it does not get a good one done. So the oldest item's age sits in
 *      the tile row, every row carries its days waiting, and the queue is drawn
 *      as an ageing bar — the shape of the backlog is the thing the accounts
 *      head is accountable for, not the shape of the rulebook.
 *
 * The two charts answer the two questions this desk actually gets asked. How
 * old is the backlog (age), and how much of it is cash (how it was paid) — cash
 * carries no UTR to check against a bank line, so its share is the share of the
 * queue that can only ever be checked by a custody trail: who took it, who
 * counted it, and which day's deposit slip it went into. The screen says only
 * the last part, because that is the one a clerk can act on.
 *
 * Checking happens from the side sheet, not from the row. Confirming money off
 * an eight-column table row is confirming a summary; the sheet puts the stated
 * match reason and the customer's other unpaid invoices in front of the person
 * signing — an amount that fits an older invoice better than the suggested one
 * is the commonest way money lands against the wrong bill.
 *
 * WORDS (LIN-23). Every word is in ./words.ts, in English and Tamil, short and
 * plain: "check", never "verify"; "payment", never "receipt"; "added by", never
 * "recorded by". The match reason comes from the engine as an English sentence,
 * so the three reasons it gives are mapped to words here; one it has never
 * given before is shown as sent rather than hidden.
 *
 * NOTE ON SITE SCOPE: receipts are org-level, not site-level — a bank account
 * belongs to the company, not to the Karapakkam crusher — so `siteScope` is
 * deliberately not read here. Scoping this list by plant would hide money.
 */

/** The one match reason strong enough to batch. Anything softer is checked one at a time. */
const EXACT_UTR_REASON = 'UTR exact, amount exact, date +1d';

/** The engine's reasons, as it states them today, keyed to the screen's words. */
const REASON_KEY: Readonly<Record<string, MatchReason>> = {
  [EXACT_UTR_REASON]: 'utrExact',
  'Amount exact, customer match, no UTR on bank line': 'amountAndCustomer',
  'Oldest open invoice for this customer, amount within ₹500': 'oldestOpen',
};

/** A reason in the reader's language. One the screen has no words for is shown as sent. */
function reasonWords(reason: string | null, words: Readonly<Record<MatchReason, string>>): string | null {
  if (reason === null) return null;
  const key = REASON_KEY[reason];
  return key === undefined ? reason : words[key];
}

/** Past this, an unchecked payment stops being a queue and starts being a control failure. */
const STALE_DAYS = 7;

/**
 * The time the figures are from, printed under them. Where they come from is a
 * hover away, in plain words (`t.source`). For whoever has to trace them: the
 * queue and the tiles read `v_receipt_verification`, the waiting-longest tile
 * reads `v_receipt_ageing`.
 */
const AS_OF = '14:42';

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
 * What confirming these payments would actually do to the ledger.
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
    <dl className="mt-2 flex flex-col gap-1.5 md:hidden">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-3 text-[13px]">
          <dt className="flex min-w-0 items-baseline gap-2" style={{ color: 'var(--text-secondary)' }}>
            <span
              aria-hidden="true"
              className="block h-2.5 w-2.5 shrink-0 translate-y-[1px]"
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
  const t = useWords(verifyWords);
  const inr = useInrCompact();
  const [verifiedNow, setVerifiedNow] = useState<Record<string, true>>({});
  const [filter, setFilter] = useState<'all' | 'utr' | 'cash' | 'blocked' | 'stale'>('all');
  const [stripDismissed, setStripDismissed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Ids awaiting confirmation — one for a sheet check, many for the batch. */
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

  // Checked today = what this session confirmed, plus what someone else already
  // confirmed on today's IST business date. Both are equally real.
  const verifiedToday: VerifiedRow[] = [
    ...pending
      .filter((r) => verifiedNow[r.id] !== undefined)
      .map((r) => ({ receipt: r, verifier: persona.name, inSession: true })),
    ...RECEIPTS.filter(
      (r) => r.verifiedBy !== null && r.verifiedAt !== null && businessDate(r.verifiedAt) === businessDate(NOW),
    ).map((r) => ({ receipt: r, verifier: r.verifiedBy ?? '', inSession: false })),
  ];
  const checkedByYou = verifiedToday.filter((v) => v.inSession).length;

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

  // Age is measured in money, not row count. Nine tiny cash payments and one
  // ₹7 L RTGS are not the same backlog, and a count would draw them the same.
  const ageingBuckets = [
    { label: t.age.today, value: sum(queue.filter((r) => ageDays(r.date) === 0)) },
    { label: t.age.oneToThree, value: sum(queue.filter((r) => ageDays(r.date) >= 1 && ageDays(r.date) <= 3)) },
    { label: t.age.fourToSeven, value: sum(queue.filter((r) => ageDays(r.date) >= 4 && ageDays(r.date) <= STALE_DAYS)) },
    { label: t.age.over(STALE_DAYS), value: sum(queue.filter((r) => ageDays(r.date) > STALE_DAYS)) },
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
      label: t.method[m.method],
      value: m.value,
      tone: `var(--chart-${Math.min(5, i + 1)})`,
    })),
    ...(cashTotal > 0 ? [{ label: t.method.cash, value: cashTotal, tone: 'var(--status-attention)' }] : []),
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

  // No column groups: five supra-headers over eight columns were five more
  // things to read and told nobody where to look.
  const queueColumns: Column<Receipt>[] = [
    {
      key: 'date',
      header: t.col.date,
      width: 150,
      sticky: true,
      render: (r) => <Stacked primary={formatDate(r.date)} secondary={t.ago(ageDays(r.date))} />,
    },
    {
      key: 'reference',
      header: t.col.reference,
      type: 'id',
      width: 160,
      // Cash has no UTR. The dash is the honest answer; the cash line under the
      // chart says what checks a cash payment instead.
      render: (r) => <IdCell>{r.reference}</IdCell>,
    },
    { key: 'method', header: t.col.how, width: 104, render: (r) => t.method[r.method] },
    {
      key: 'customer',
      header: t.col.customer,
      render: (r) => <Stacked primary={r.customerName} />,
    },
    {
      key: 'amount',
      header: t.col.amount,
      unit: '₹',
      type: 'money',
      width: 140,
      // Reported, not confirmed. The hatch is the ledger's position on it.
      render: (r) => (
        <Provisional by="person">
          <MoneyCell value={r.amount} />
        </Provisional>
      ),
    },
    {
      key: 'match',
      header: t.col.likelyInvoice,
      width: 170,
      // Just the number. Why Linck chose it is read where the decision is
      // made, in the sheet; the strongest reason has its own chip ("UTR
      // matches"). Printed in every row, the reasons were most of the words
      // on this screen and, in Tamil, pushed the status off its edge.
      render: (r) => {
        const number = invoiceNumber(r.suggestedInvoiceId);
        return number === null ? null : <IdCell>{number}</IdCell>;
      },
    },
    { key: 'recordedBy', header: t.col.addedBy, width: 130, render: (r) => r.recordedBy },
    {
      key: 'standing',
      header: t.col.status,
      width: 150,
      // The row states the standing; the signing happens in the sheet, where
      // the match reason and the customer's other unpaid invoices are visible.
      // The days waiting are already under the date, so the stamp does not
      // repeat them.
      //
      // A payment this person added says so in the stamp itself — the reason
      // it is blocked is the label, so it can never be separated from the
      // mark. What follows from it (someone else must check) is the page's
      // rule, and is repeated beside the disabled button in the sheet.
      render: (r) =>
        blockedFor(r) ? (
          <StatusStamp status="dormant" label={t.stamp.youAdded} />
        ) : (
          <StatusStamp status="pending" label={t.stamp.waiting} provisional />
        ),
    },
  ];

  const verifiedColumns: Column<VerifiedRow>[] = [
    {
      key: 'date',
      header: t.col.date,
      width: 150,
      sticky: true,
      render: (v) => formatDate(v.receipt.date),
    },
    {
      key: 'reference',
      header: t.col.reference,
      type: 'id',
      width: 160,
      render: (v) => <IdCell>{v.receipt.reference}</IdCell>,
    },
    { key: 'customer', header: t.col.customer, render: (v) => v.receipt.customerName },
    {
      key: 'amount',
      header: t.col.amount,
      unit: '₹',
      type: 'money',
      width: 140,
      // Confirmed: the hatch dissolves, the rule goes solid. That is the whole event.
      render: (v) => (
        <Provisional confirmed by="person">
          <MoneyCell value={v.receipt.amount} />
        </Provisional>
      ),
    },
    {
      key: 'invoice',
      header: t.col.invoice,
      width: 180,
      render: (v) => <IdCell>{invoiceNumber(v.receipt.suggestedInvoiceId)}</IdCell>,
    },
    { key: 'recordedBy', header: t.col.addedBy, width: 130, render: (v) => v.receipt.recordedBy },
    {
      key: 'verifier',
      header: t.col.checkedBy,
      width: 200,
      render: (v) => (
        <span className="flex items-center gap-2">
          <span>{v.verifier}</span>
          {v.inSession ? <StatusStamp status="ready" label={t.stamp.justNow} /> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      {/* Who is signed in is in the top bar; the page does not repeat it. */}
      <PageHeader eyebrow={t.eyebrow} title={t.title} meta={<AsOfStamp asOf={AS_OF} source={t.source} freshness="materialised" />} />

      {/* The rule, once, in the words of the person it applies to. */}
      <p className="font-serif px-6 pt-4 text-[15px] italic" style={{ color: 'var(--text-secondary)' }}>
        {t.rule}
      </p>

      {/* Stacked on a phone with a hairline BETWEEN tiles rather than a stray
          right edge, and pulled back to the page's px-6 measure so the tile
          numbers line up with the line above them. */}
      <TileRow className="mt-4 grid-cols-1 [&>*]:border-[var(--border-subtle)] max-md:[&>*]:border-b max-md:[&>*]:px-6 max-md:[&>*:last-child]:border-b-0 md:grid-cols-3 md:[&>*]:border-r">
        <KpiTile
          eyebrow={t.tiles.waiting}
          value={inr(queueTotal)}
          // None of this counts as collected anywhere until it is checked.
          delta={{ text: t.payments(queue.length), tone: 'attention' }}
          asOfInHeader
        />
        <KpiTile
          eyebrow={t.tiles.checkedToday}
          value={inr(sum(verifiedToday.map((v) => v.receipt)))}
          delta={{
            text: checkedByYou > 0 ? t.paymentsByYou(verifiedToday.length, checkedByYou) : t.payments(verifiedToday.length),
          }}
          asOfInHeader
        />
        {/* The age counter, not the blocked button, is the actual control.
            A queue nobody clears is the failure mode this rule invites. */}
        <KpiTile
          eyebrow={t.tiles.oldest}
          value={oldest === null ? '–' : t.days(ageDays(oldest.date))}
          delta={{
            text: oldest === null ? t.tiles.noneWaiting : `${oldest.customerName} · ${t.method[oldest.method]}`,
            tone: oldest !== null && ageDays(oldest.date) > STALE_DAYS ? 'critical' : 'neutral',
          }}
          asOfInHeader
        />
      </TileRow>

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-2 xl:grid-cols-2">
        <Section title={t.age.title}>
          <AgeingBar
            summary={t.age.summary(inr(queueTotal), inr(ageingBuckets[3]?.value ?? 0), STALE_DAYS)}
            buckets={ageingBuckets}
            format={inr}
          />
          <NarrowLegend
            items={ageingBuckets.map((b, i) => ({
              label: b.label,
              value: inr(b.value),
              tone: `var(--chart-${Math.min(5, i + 1)})`,
            }))}
          />
          {/* Nothing here is red: an age bucket is a fact about time. The
              right-hand end is money waiting on a person, not on a rule. */}
          <ChartCaption>{t.age.darker}</ChartCaption>
        </Section>

        <Section title={t.how.title}>
          <ProportionBar summary={t.how.summary(cashSharePct, inr(queueTotal))} segments={methodSegments} />
          <NarrowLegend
            items={methodSegments.map((s) => ({ label: s.label, value: inr(s.value), tone: s.tone }))}
          />
          {/* Every banked method leaves a UTR or a cheque number a second
              person can match. Cash leaves nothing — which is why it is the one
              segment spending colour, and why this line is about cash. */}
          <ChartCaption>{t.how.cashNote}</ChartCaption>
        </Section>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={queue.length}>
          {t.chips.all}
        </Chip>
        <Chip active={filter === 'utr'} onClick={() => setFilter('utr')} count={exactUtr.length}>
          {t.chips.utr}
        </Chip>
        <Chip active={filter === 'cash'} onClick={() => setFilter('cash')} count={queue.filter((r) => r.method === 'cash').length}>
          {t.chips.cash}
        </Chip>
        {/* The chip the ageing bar argues for: the oldest bucket, one click away. */}
        <Chip active={filter === 'stale'} onClick={() => setFilter('stale')} count={staleCount}>
          {t.chips.over(STALE_DAYS)}
        </Chip>
        {/* Named for why they are blocked: you added them. */}
        <Chip active={filter === 'blocked'} onClick={() => setFilter('blocked')} count={queue.filter(blockedFor).length}>
          {t.chips.mine}
        </Chip>
      </div>

      {exactUtr.length > 0 && !stripDismissed ? (
        <div className="px-6 pt-4">
          {/* Exact UTR, exact amount and a next-day value date — the only
              match strong enough to check as a batch. */}
          <SuggestionStrip
            applyLabel={eligibleForBatch.length > 0 ? t.strip.checkAll(eligibleForBatch.length) : t.strip.nothing}
            onApply={eligibleForBatch.length > 0 ? () => setConfirming(eligibleForBatch.map((r) => r.id)) : undefined}
            onDismiss={() => setStripDismissed(true)}
          >
            {t.strip.match(exactUtr.length)} {blockedInBatch > 0 ? t.strip.yours(blockedInBatch) : null}
          </SuggestionStrip>
        </div>
      ) : null}

      <Section title={t.queue.title}>
        {rows.length > 0 ? (
          <p className="px-6 pb-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {t.queue.hint}
          </p>
        ) : null}
        <DataTable
          density={density}
          columns={queueColumns}
          rows={rows}
          rowKey={(r) => r.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(r) => setSelectedId(r.id)}
          rail={(r) => ({ status: ageDays(r.date) > STALE_DAYS ? 'critical' : 'pending', provenance: r.provenance })}
          empty={
            // Filtered-empty and genuinely-empty are different: the first
            // offers the way back to everything, because the money is still there.
            <EmptyState
              fact={filter === 'all' ? t.queue.allChecked : t.queue.noneHere}
              {...(filter === 'all' ? {} : { action: { label: t.queue.showAll, onClick: () => setFilter('all') } })}
            />
          }
        />
      </Section>

      <Section title={t.checked.title}>
        <DataTable
          density={density}
          columns={verifiedColumns}
          rows={verifiedToday}
          rowKey={(v) => v.receipt.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(v) => setSelectedId(v.receipt.id)}
          rail={() => ({ status: 'ready', provenance: 'confirmed' })}
          empty={<EmptyState fact={t.checked.none} />}
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        title={selected?.customerName ?? ''}
        identifier={selected?.reference ?? (selected ? t.sheet.cash : undefined)}
        {...(selected
          ? {
              status:
                selectedVerifier !== null
                  ? { family: 'ready' as const, label: t.stamp.checked }
                  : { family: 'pending' as const, label: t.stamp.waiting, provisional: true },
            }
          : {})}
        footer={
          selected === null ? undefined : selectedVerifier !== null ? (
            // The sheet footer is a fixed 56px band. On a phone it has ~335px of
            // width, so the sentence beside the stamp has to be allowed to wrap
            // inside its own share of the row — the alternative is copy spilling
            // out over the scroll area above it.
            <span className="flex w-full min-w-0 items-center gap-2.5">
              <StatusStamp status="ready" label={t.stamp.checked} />
              <span className="min-w-0 flex-1 text-[12px] leading-tight sm:text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                {t.sheet.checkedBy(selectedVerifier)}
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
                {t.sheet.check}
              </Button>
              <span className="min-w-0 flex-1 text-[12px] leading-tight sm:text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                {selectedBlocked ? t.sheet.yours : t.sheet.after}
              </span>
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
        title={confirmTargets.length === 1 ? t.confirm.titleOne : t.confirm.titleMany(confirmTargets.length)}
        confirmLabel={confirmTargets.length === 1 ? t.confirm.yesOne : t.confirm.yesMany(confirmTargets.length)}
        consequence={
          // One fact a line: whose money, then what checking it does.
          <>
            <p>
              {confirmTargets.length === 1
                ? t.confirm.one(formatINR(confirmTargets[0]?.amount ?? '0'), confirmTargets[0]?.recordedBy ?? '')
                : t.confirm.many(confirmTargets.length, formatINR(confirmTotal))}
            </p>
            {confirmEffects.length === 0 ? (
              // No suggested invoice: the money is confirmed into the ledger
              // and allocation stays an open job.
              <p className="mt-1">{t.confirm.noInvoice}</p>
            ) : (
              <>
                <p className="mt-1">{closesCount > 0 ? t.confirm.closes(closesCount) : t.confirm.noneCloses}</p>
                <ul className="font-sans mt-3 not-italic">
                  {confirmEffects.map((e) => (
                    // Number over effect on a phone; the two side by side need
                    // ~380px and the modal has 343 at 375.
                    <li
                      key={e.invoice.id}
                      className="flex flex-col gap-x-3 py-1.5 text-[13px] sm:flex-row sm:items-baseline sm:justify-between"
                      style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                    >
                      <span className="font-id">{e.invoice.number}</span>
                      <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                        {formatINR(e.applied, { decimals: 0 })} ·{' '}
                        {e.remaining <= 0.5 ? t.confirm.fullyPaid : t.confirm.stillDue(formatINR(e.remaining, { decimals: 0 }))}
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
 * The payment, as the second person needs to see it.
 *
 * More than the row carried: the stated match reason, what the suggested
 * invoice looks like before and after this money lands, and the customer's
 * OTHER unpaid invoices so a wrong allocation is visible rather than assumed.
 * The two-person rule itself is in the footer, beside the button it governs.
 */
function ReceiptDetail({ receipt, verifier }: { receipt: Receipt; verifier: string | null }) {
  const t = useWords(verifyWords);
  const status = useWords(statusWords);
  const suggested = invoiceOf(receipt.suggestedInvoiceId);
  const others = openInvoicesFor(receipt.customerId).filter((i) => i.id !== receipt.suggestedInvoiceId);
  const amount = amountOf(receipt);
  const isCash = receipt.method === 'cash' && receipt.reference === null;

  return (
    <>
      <SheetSection caption={t.sheet.payment}>
        <DetailGrid>
          <Detail label={t.sheet.date}>
            {formatDate(receipt.date)} · {t.ago(ageDays(receipt.date))}
          </Detail>
          <Detail label={t.sheet.amount}>
            <Provisional confirmed={verifier !== null} by="person">
              <MoneyCell value={receipt.amount} accounting={false} />
            </Provisional>
          </Detail>
          <Detail label={t.sheet.how}>{t.method[receipt.method]}</Detail>
          {isCash ? null : (
            <Detail label={receipt.method === 'cheque' ? t.sheet.chequeNo : t.sheet.utrNo}>
              <IdCell>{receipt.reference}</IdCell>
            </Detail>
          )}
          <Detail label={t.sheet.addedBy}>{receipt.recordedBy}</Detail>
          {verifier !== null ? (
            <>
              <Detail label={t.sheet.checkedByLabel}>{verifier}</Detail>
              <Detail label={t.sheet.checkedOn}>
                {receipt.verifiedAt !== null ? formatDateTime(receipt.verifiedAt) : t.stamp.justNow}
              </Detail>
            </>
          ) : null}
        </DetailGrid>
        {/* Cash has no bank reference to match against a statement line. What
            stands in for it is the custody trail; the deposit slip is the part
            the person checking can actually look at. */}
        {receipt.reference === null ? <Note>{t.how.cashNote}</Note> : null}
      </SheetSection>

      <SheetSection caption={t.sheet.likelyInvoice}>
        {suggested === null ? (
          // Checking confirms the money without allocating it; the allocation
          // stays an open job.
          <Note>{t.sheet.noInvoice}</Note>
        ) : (
          <>
            <DetailGrid>
              <Detail label={t.sheet.invoice}>
                <IdCell>{suggested.number}</IdCell>
              </Detail>
              <Detail label={t.sheet.status}>
                <StatusStamp
                  status={INVOICE_STATUS_FAMILY[suggested.status]}
                  label={status.invoice[suggested.status]}
                  {...(suggested.daysOverdue > 0 ? { severity: t.late(suggested.daysOverdue) } : {})}
                  {...(suggested.status === 'payment_reported' ? { provisional: true } : {})}
                />
              </Detail>
              <Detail label={t.sheet.total}>
                <MoneyCell value={suggested.total} accounting={false} />
              </Detail>
              <Detail label={t.sheet.dueBefore}>
                <MoneyCell value={suggested.balanceDue} accounting={false} />
              </Detail>
            </DetailGrid>
            {/* The reason as the ranker stated it, so the person signing can
                disagree with it. */}
            <Note>{t.sheet.why(reasonWords(receipt.suggestionReason, t.reason) ?? t.sheet.noReason)}</Note>
            {/* The middle segment exists only because somebody said so.
                Checking is what moves it into the first; nothing else does. */}
            <div className="pt-3">
              <ProportionBar
                summary={t.sheet.barSummary(formatINR(suggested.receivedVerified), formatINR(suggested.total), formatINR(receipt.amount))}
                height={22}
                segments={[
                  { label: t.sheet.barChecked, value: Number.parseFloat(suggested.receivedVerified), tone: 'var(--status-ready)' },
                  { label: t.sheet.barThis, value: amount, tone: 'var(--status-attention)' },
                  {
                    label: t.sheet.barDue,
                    value: Math.max(
                      0,
                      Number.parseFloat(suggested.total) - Number.parseFloat(suggested.receivedVerified) - amount,
                    ),
                    tone: 'var(--surface-sunken)',
                  },
                ]}
              />
            </div>
          </>
        )}
      </SheetSection>

      <SheetSection caption={t.sheet.others(others.length)}>
        {others.length === 0 ? (
          // Then the suggested invoice is the only place this money can land.
          <Note>{t.sheet.noOthers}</Note>
        ) : (
          <>
            <ul className="text-[13px]">
              {others.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="font-id">{i.number}</span>
                    <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                      {t.sheet.dated(formatDate(i.date), formatDate(i.dueDate))}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <MoneyCell value={i.balanceDue} />
                    <StatusStamp
                      status={INVOICE_STATUS_FAMILY[i.status]}
                      label={status.invoice[i.status]}
                      {...(i.daysOverdue > 0 ? { severity: t.late(i.daysOverdue) } : {})}
                    />
                  </span>
                </li>
              ))}
            </ul>
            {/* Shown so a wrong allocation is visible rather than assumed. */}
            <div className="pt-2">
              <Note>{t.sheet.rightInvoice}</Note>
            </div>
          </>
        )}
      </SheetSection>
    </>
  );
}
