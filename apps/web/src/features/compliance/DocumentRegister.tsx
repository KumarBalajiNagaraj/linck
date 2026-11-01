import { useEffect, useMemo, useRef, useState } from 'react';
import { can, formatDate, formatINR, formatINRCompact } from '@linck/domain';
import { DOCUMENTS, vehiclesForSite, type ComplianceDocument, type Vehicle } from '@linck/mock';
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
  Provisional,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  TileRow,
  useIsPhone,
  type BarDatum,
  type Column,
} from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { complianceWords, type ComplianceWords } from './words.js';

/**
 * THE DOCUMENT & EXPIRY REGISTER.
 *
 * The owner keys every insurance end date and permit date by hand. This screen
 * is the payoff for that typing: a shoebox of paper becomes a dated obligation
 * list, sorted so the worst thing is the first thing.
 *
 * Two facts are kept apart on purpose, because conflating them is how a tipper
 * ends up impounded:
 *   - EXPIRED AND BLOCKING — insurance, fitness, road tax, state permit. The
 *     vehicle does not leave the gate. Critical, double-width rail, integer.
 *   - EXPIRED AND NOT BLOCKING — PUC, national permit. A fine, an inconvenience,
 *     not a stopped truck. Attention, and a different word.
 *
 * And the cash-flow strip exists because "what is expiring" is a compliance
 * question, while "what does renewing it cost me this month" is the question
 * accounts actually opens this screen to answer. Hence two charts with two
 * different audiences: money by month for accounts, counts by bucket for fleet.
 *
 * Every word on the screen is in ./words.ts, in English and Tamil (LIN-23).
 * The screen says what is true and what to do; the reasons stay here.
 */

type Stage = 'open' | 'filed' | 'received';
type Row = { doc: ComplianceDocument; vehicle: Vehicle; stage: Stage; daysLeft: number; expiresOn: string };
type Filter = 'all' | 'expired' | 'soon' | 'blocking';
type BucketKey = 'blocking' | 'lapsed' | 'due30' | 'due90' | 'later';
type DocWords = ComplianceWords['docs'];
/** An IST calendar month: `key` is `YYYY-MM`, `month` is 0–11. */
type Month = { key: string; year: number; month: number };

const RENEWAL_DAYS = 365;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

export function DocumentRegister() {
  const { persona, siteScope, density } = useApp();
  const t = useWords(complianceWords);
  const w = t.docs;
  /* Charts are drawn in real pixels, so the gutter reserved for their direct
     labels is a number and not a class. On a phone the month labels ("Aug 2026")
     need far less than the desk build gives them, and handing the difference
     back to the plot is the difference between bars and slivers. */
  const isPhone = useIsPhone();
  const [filterRail, pinTop] = usePinBelowStickyAbove(isPhone);
  const [filter, setFilter] = useState<Filter>('all');
  const [docType, setDocType] = useState<ComplianceDocument['type'] | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /** Chart-driven narrowings. Both clear from the strip above the table. */
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [bucket, setBucket] = useState<BucketKey | null>(null);
  const [horizon, setHorizon] = useState<6 | 12>(6);
  const [confirming, setConfirming] = useState(false);
  /** Demo-local renewal ledger. Nothing here persists; it exists to show the row move. */
  const [renewals, setRenewals] = useState<Record<string, Stage>>({});

  const canWrite = can(persona.grants, 'compliance.document.write', { siteId: siteScope });
  const columns = useMemo(() => makeColumns(t), [t]);

  const all = useMemo<Row[]>(() => {
    const byId = new Map(vehiclesForSite(siteScope).map((v) => [v.id, v]));
    return DOCUMENTS.flatMap<Row>((doc) => {
      const vehicle = byId.get(doc.vehicleId);
      if (!vehicle) return [];
      const stage = renewals[doc.id] ?? 'open';
      // A renewal that has landed pushes the date out a year — the row visibly
      // leaves the top of the list, which is the whole point of doing the work.
      const shift = stage === 'received' ? RENEWAL_DAYS : 0;
      return [
        {
          doc,
          vehicle,
          stage,
          daysLeft: doc.daysLeft + shift,
          expiresOn: new Date(Date.parse(doc.expiresOn) + shift * DAY_MS).toISOString(),
        },
      ];
    }).sort((a, b) => rank(a) - rank(b) || a.daysLeft - b.daysLeft);
  }, [siteScope, renewals]);

  const expired = all.filter((r) => r.daysLeft < 0);
  const blocking = expired.filter((r) => r.doc.blocksOperation);
  const in30 = all.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 30);
  const in90 = all.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 90);
  const annualBook = sumCost(all);

  /* ---- chart (a): renewal cash falling due, month by month ---------------
     Accounts does not care that four papers expire in October; it cares that
     October costs ₹1.4 lakh. Lapsed money is drawn as its own leading bar
     because it is not "due in August" — it was due already, and it is the one
     bar on this page allowed to spend a colour.

     The three cards above the bars are cumulative and the bars are not. A
     month standing well above its neighbours is the one to move papers out
     of — an FC or a permit can be renewed early without losing the unexpired
     months, and insurance cannot. */
  const months = useMemo(() => monthWindow(horizon), [horizon]);
  const monthLabel = (m: { year: number; month: number }) => t.common.month(m.month, m.year);
  const lapsed = useMemo(() => all.filter((r) => r.daysLeft < 0), [all]);
  const dueByMonth = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of all) {
      if (r.daysLeft < 0) continue;
      const key = istMonthKey(r.expiresOn);
      const list = map.get(key);
      if (list) list.push(r);
      else map.set(key, [r]);
    }
    return map;
  }, [all]);

  const cashBars: BarDatum[] = [
    ...(lapsed.length > 0 ? [{ label: w.cash.expiredBar, value: sumCost(lapsed), tone: 'var(--status-critical)' }] : []),
    ...months.map((m) => ({ label: monthLabel(m), value: sumCost(dueByMonth.get(m.key) ?? []) })),
  ];
  const peakMonth = months.reduce<{ label: string; amount: number }>(
    (best, m) => {
      const amount = sumCost(dueByMonth.get(m.key) ?? []);
      return amount > best.amount ? { label: monthLabel(m), amount } : best;
    },
    { label: '–', amount: 0 },
  );

  /* ---- chart (b): how many papers sit in each expiry bucket ---------------
     The top two bars both say "expired" and are completely different
     problems — one is a stopped truck earning nothing, the other is a receipt
     at a check post. Everything below them is a diary entry, not an
     emergency, which is why only the first two spend a colour. */
  const bucketBars: BarDatum[] = BUCKETS.map((b) => {
    const count = all.filter(b.test).length;
    return { label: w.buckets[b.key], value: count, ...(b.tone ? { tone: b.tone } : {}) };
  });

  const rows = useMemo(() => {
    const base =
      filter === 'expired' ? expired : filter === 'soon' ? in30 : filter === 'blocking' ? blocking : all;
    let out = docType ? base.filter((r) => r.doc.type === docType) : base;
    if (monthKey === 'lapsed') out = out.filter((r) => r.daysLeft < 0);
    else if (monthKey !== null) out = out.filter((r) => r.daysLeft >= 0 && istMonthKey(r.expiresOn) === monthKey);
    if (bucket !== null) {
      const spec = BUCKETS.find((b) => b.key === bucket);
      if (spec) out = out.filter(spec.test);
    }
    return out;
  }, [all, expired, in30, blocking, filter, docType, monthKey, bucket]);

  const current = all.find((r) => r.doc.id === selected);
  const siblings = current ? all.filter((r) => r.vehicle.id === current.vehicle.id) : [];

  const clearAll = () => {
    setFilter('all');
    setDocType(null);
    setMonthKey(null);
    setBucket(null);
  };

  const setStage = (id: string, stage: Stage) => setRenewals((s) => ({ ...s, [id]: stage }));

  /* The sheet footer is a fixed 56px row that does not wrap, so a button plus
     a sentence beside it only fits on a desk. On a phone the sentence moves to
     the foot of the sheet body rather than being dropped. Same words,
     different place.

     Only a landed renewal gets one: the new date is the thing to check. Why
     there are two stages at all — filing is not the same as holding the
     paper — is what the second button and its confirmation say. */
  const footnote =
    current === undefined || !canWrite || current.stage !== 'received'
      ? null
      : w.sheet.newExpiry(formatDate(current.expiresOn));

  return (
    <>
      <PageHeader
        eyebrow={t.common.eyebrow}
        title={w.title}
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source={w.source} freshness="materialised" />
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {w.summary(all.length, new Set(all.map((r) => r.vehicle.id)).size)}
            </span>
          </span>
        }
      />

      {/* One tile per row on a phone. At half of 375px the Tamil eyebrows wrap
          to three lines under a 40px number, which reads as noise rather than
          a figure. The hairline that separates tiles turns from a vertical
          rule into a horizontal one to match. */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-[var(--border-subtle)] max-sm:[&>*:not(:last-child)]:border-b sm:[&>*]:border-r">
        <KpiTile
          eyebrow={w.kpi.expired}
          hero
          value={String(expired.length)}
          delta={{
            text: w.kpi.stopping(blocking.length),
            tone: blocking.length > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source={w.source}
        />
        <KpiTile
          eyebrow={w.kpi.in30}
          value={String(in30.length)}
          delta={{ text: w.kpi.toRenew(formatINRCompact(sumCost(in30))), tone: in30.length > 0 ? 'attention' : 'neutral' }}
          asOf="14:42"
          source={w.source}
        />
        {/* Ninety days out is far enough to book the RTO slot calmly. */}
        <KpiTile eyebrow={w.kpi.in90} value={String(in90.length)} asOf="14:42" source={w.source} />
        {/* Insurance, FC, permits, road tax and PUC for the sites in scope. */}
        <KpiTile
          eyebrow={w.kpi.yearly}
          value={formatINRCompact(annualBook)}
          asOf="14:42"
          source={w.source}
          freshness="materialised"
        />
      </TileRow>

      <Section
        title={w.cash.title}
        actions={
          /* Wrapping the pair lets the two chips drop under one another on a
             narrow header instead of squeezing the title to one word a line. */
          <div className="flex flex-wrap justify-end gap-2">
            <Chip active={horizon === 6} onClick={() => setHorizon(6)}>
              {t.common.months(6)}
            </Chip>
            <Chip active={horizon === 12} onClick={() => setHorizon(12)}>
              {t.common.months(12)}
            </Chip>
          </div>
        }
      >
        {/* Cumulative: the 60-day card includes the 30-day one, and the first
            includes what has already lapsed — that bill is owed today. */}
        <div className="grid gap-3 px-6 sm:grid-cols-2 lg:grid-cols-3">
          <DueCard label={w.cash.upTo(30)} amount={sumCost(all.filter((r) => r.daysLeft <= 30))} note={w.cash.withExpired} />
          <DueCard label={w.cash.upTo(60)} amount={sumCost(all.filter((r) => r.daysLeft <= 60))} />
          <DueCard label={w.cash.upTo(90)} amount={sumCost(all.filter((r) => r.daysLeft <= 90))} />
        </div>

        <div className="mt-5 px-6">
          <BarChart
            data={cashBars}
            summary={w.cash.summary(formatINRCompact(sumCost(lapsed)), peakMonth.label, formatINRCompact(peakMonth.amount))}
            format={(v) => formatINRCompact(v)}
            labelWidth={isPhone ? 104 : 140}
            onSelect={(d) => {
              const match = months.find((m) => monthLabel(m) === d.label);
              const next = match ? match.key : 'lapsed';
              setMonthKey((k) => (k === next ? null : next));
            }}
          />
          <ChartCaption>{w.tapBar}</ChartCaption>
        </div>
      </Section>

      <Section title={w.when.title}>
        <div className="px-6">
          {/* These labels are the finding — "Expired · vehicle stops" is the
              whole distinction this chart exists to draw — so they are never
              truncated to fit a phone. They are short enough now to sit in
              their gutter at 375px, so the chart no longer scrolls sideways. */}
          <BarChart
            data={bucketBars}
            summary={w.when.summary(blocking.length, expired.length - blocking.length, in30.length)}
            format={(v) => String(Math.round(v))}
            labelWidth={isPhone ? 176 : 200}
            onSelect={(d) => {
              const spec = BUCKETS.find((b) => w.buckets[b.key] === d.label);
              if (!spec) return;
              setBucket((b) => (b === spec.key ? null : spec.key));
            }}
          />
          <ChartCaption>{w.tapBar}</ChartCaption>
        </div>
      </Section>

      {/* THE FILTER RAIL, AND WHY IT PINS ITSELF ON A PHONE.
          Eleven chips wrapped onto five rows would cost a third of a phone
          screen before a single document showed, and once you are 200 cards
          down a 348-row register the only way back to them is a long thumb
          drag. So below `md` they become one horizontally scrolling row that
          pins itself directly under the shell's own section strip, at an
          offset measured off that strip rather than assumed. On a desk there
          is room to wrap and no reason to pin at all. */}
      <div
        ref={filterRail}
        className="sticky z-10 mt-7 md:static md:z-auto"
        style={{ top: pinTop, background: 'var(--surface)' }}
      >
        <div
          className="flex items-center gap-2 overflow-x-auto px-6 py-2 [&>*]:shrink-0 [&>*]:whitespace-nowrap md:flex-wrap md:overflow-visible md:py-3"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={all.length}>
            {t.common.all}
          </Chip>
          <Chip active={filter === 'expired'} onClick={() => setFilter('expired')} count={expired.length}>
            {w.filters.expired}
          </Chip>
          <Chip active={filter === 'soon'} onClick={() => setFilter('soon')} count={in30.length}>
            {w.filters.soon}
          </Chip>
          <Chip active={filter === 'blocking'} onClick={() => setFilter('blocking')} count={blocking.length}>
            {w.filters.blocking}
          </Chip>
          <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-default)' }} />
          {DOC_TYPES.map((type) => (
            <Chip key={type} active={docType === type} onClick={() => setDocType(docType === type ? null : type)}>
              {w.docType[type]}
            </Chip>
          ))}
        </div>

        {/* The chart narrowings ride inside the same pinned block. Undoing one
            is the reason you would scroll back up, so it travels with the
            chips rather than sitting above them and scrolling away. */}
        {monthKey !== null || bucket !== null ? (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2"
            style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-sunken)' }}
          >
            <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {w.showing}
            </span>
            {monthKey !== null ? (
              <Chip active onClick={() => setMonthKey(null)}>
                {monthKey === 'lapsed' ? w.cash.expiredBar : monthLabel(monthOfKey(monthKey))} ×
              </Chip>
            ) : null}
            {bucket !== null ? (
              <Chip active onClick={() => setBucket(null)}>
                {w.buckets[bucket]} ×
              </Chip>
            ) : null}
            <span className="num text-[13px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
              {w.narrowed(rows.length, all.length)}
            </span>
          </div>
        ) : null}
      </div>

      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.doc.id}
          selectedKey={selected}
          onRowClick={(r) => setSelected(r.doc.id)}
          rail={(r) => ({
            status: family(r),
            provenance: 'human',
            fillRatio: Math.max(0, Math.min(1, r.daysLeft / 90)),
          })}
          // Either the paperwork here is in order, or the filter is narrower
          // than the shoebox — one button answers both.
          empty={<EmptyState fact={w.empty} action={{ label: t.common.showAll, onClick: clearAll }} />}
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={current !== undefined}
        // Escape reaches the sheet and the confirmation together, and the sheet
        // closing unmounts the confirmation before its own handler runs — so the
        // flag is cleared here, or the next paper opened would arrive with
        // "new papers in hand?" already asked about it.
        onClose={() => {
          setSelected(undefined);
          setConfirming(false);
        }}
        width="form"
        title={current ? w.docType[current.doc.type] : ''}
        identifier={current ? `${current.doc.number} · ${current.vehicle.displayReg}` : undefined}
        {...(current
          ? {
              status: {
                family: family(current),
                label: label(current, w),
                ...(current.stage === 'received' ? {} : { severity: t.common.daysShort(Math.abs(current.daysLeft)) }),
                ...(current.stage === 'filed' ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={current ? w.sheet.expires(formatDate(current.expiresOn)) : undefined}
        footer={
          current ? (
            canWrite ? (
              current.stage === 'received' ? (
                <>
                  <Button onClick={() => setStage(current.doc.id, 'open')}>{t.common.undo}</Button>
                  <span className="hidden font-serif text-[13px] italic sm:inline" style={{ color: 'var(--text-tertiary)' }}>
                    {footnote}
                  </span>
                </>
              ) : current.stage === 'filed' ? (
                // Two full labels in a 335px footer that cannot wrap: the type
                // drops a step and the padding tightens on a phone so both
                // still read in full rather than one of them being cut.
                <>
                  <Button
                    variant="primary"
                    className="whitespace-nowrap max-sm:px-2.5 max-sm:text-[13px]"
                    onClick={() => setConfirming(true)}
                  >
                    {w.sheet.gotPapers}
                  </Button>
                  <Button
                    className="whitespace-nowrap max-sm:px-2.5 max-sm:text-[13px]"
                    onClick={() => setStage(current.doc.id, 'open')}
                  >
                    {t.common.undo}
                  </Button>
                </>
              ) : (
                <Button variant="primary" className="whitespace-nowrap" onClick={() => setStage(current.doc.id, 'filed')}>
                  {w.sheet.markApplied}
                </Button>
              )
            ) : (
              <span className="font-serif text-[13px] italic leading-tight" style={{ color: 'var(--text-tertiary)' }}>
                {w.sheet.readOnly}
              </span>
            )
          ) : null
        }
      >
        {current ? (
          <DocumentDetail
            row={current}
            siblings={siblings}
            footnote={footnote}
            onOpenSibling={(id) => setSelected(id)}
          />
        ) : null}
      </SideSheet>

      {/* Confirming receipt asserts a statutory fact — that a valid paper is
          physically in the file — and it is what unblocks the gate. It gets a
          modal, not a button that fires on the way past. */}
      <ConfirmModal
        open={confirming && current !== undefined}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          if (current) setStage(current.doc.id, 'received');
        }}
        title={w.sheet.confirm.title}
        confirmLabel={w.sheet.confirm.yes}
        consequence={
          current ? (
            <>
              <p>
                {w.sheet.confirm.what(
                  w.docType[current.doc.type],
                  current.vehicle.displayReg,
                  formatDate(current.doc.expiresOn),
                  formatDate(new Date(Date.parse(current.doc.expiresOn) + RENEWAL_DAYS * DAY_MS).toISOString()),
                )}
              </p>
              {/* The gate releases a blocked vehicle on the strength of this
                  entry; for a PUC or a national permit it only stops the flag. */}
              {current.doc.blocksOperation ? <p className="mt-2">{w.sheet.confirm.gate}</p> : null}
              <p className="mt-2">{w.sheet.confirm.onlyInHand}</p>
            </>
          ) : null
        }
      />
    </>
  );
}

/* ----------------------------------------------------------------- sticky */

/**
 * WHERE THE FILTER RAIL PINS ITSELF, MEASURED RATHER THAN GUESSED.
 *
 * On a phone the shell already pins a section strip to the top of the scroll
 * area, and this screen's filter rail has to come to rest directly under it.
 * The height of that strip is not a constant anyone can write down: it is a
 * 36px chip plus padding plus a hairline, plus however many pixels the
 * platform spends on a horizontal scrollbar — nothing on a real phone, ten in
 * a desktop emulator. Hard-coding either number leaves a bright seam of
 * scrolling content in the other one.
 *
 * So measure it. This reads the strip and never writes to it; if there is no
 * sticky element above us — a workspace with a single screen in it — the rail
 * pins to the top of the scroll area on its own and the offset is zero.
 */
function usePinBelowStickyAbove(active: boolean): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);

  useEffect(() => {
    if (!active) {
      setTop(0);
      return undefined;
    }
    const above = ref.current?.parentElement?.firstElementChild;
    if (!(above instanceof HTMLElement) || above === ref.current) {
      setTop(0);
      return undefined;
    }
    if (getComputedStyle(above).position !== 'sticky') {
      setTop(0);
      return undefined;
    }
    const measure = () => setTop(above.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(above);
    return () => observer.disconnect();
  }, [active]);

  return [ref, top];
}

/* ------------------------------------------------------------- side sheet */

/**
 * What an expiry costs, per document, at sheet length — kept here as the
 * reasoning behind the short advice the sheet shows:
 *   - Insurance: motor cover stops at midnight on the date with no grace
 *     period, and a third-party claim lands on the owner personally. Nothing
 *     about renewing it needs the vehicle present.
 *   - FC: it is the first paper an RTO flying squad asks for, and renewing it
 *     costs a day of earnings because the tipper must be driven to the yard —
 *     so book early and pair it with the PUC.
 *   - Road tax: before the date it is a line item, after it a penalty, and
 *     arrears build every quarter. No inspection, so no reason to lapse.
 *   - State permit: the paper that authorises the load itself, loaded or
 *     empty. Renew it first when several fall close together.
 *   - National permit: only matters across the border; inside Tamil Nadu the
 *     state permit carries the vehicle. Worth questioning if it never leaves.
 *   - PUC: a fine at a check post and nothing more — never stop a loaded
 *     vehicle over it. Six months, cheap, twenty minutes at a centre.
 */
function DocumentDetail({
  row,
  siblings,
  footnote,
  onOpenSibling,
}: {
  row: Row;
  siblings: Row[];
  /** Rendered here only on a phone, where the footer cannot hold it. */
  footnote: string | null;
  onOpenSibling: (id: string) => void;
}) {
  const t = useWords(complianceWords);
  const w = t.docs;
  const L = w.sheet.labels;
  const isPhone = useIsPhone();
  const advice = w.sheet.advice[row.doc.type];
  const validity = VALIDITY_MONTHS[row.doc.type];
  const issued = new Date(Date.parse(row.expiresOn));
  issued.setUTCMonth(issued.getUTCMonth() - validity);

  const others = siblings.filter((s) => s.doc.id !== row.doc.id);
  const vehicleBook = sumCost(siblings);
  const soonest = siblings.reduce<Row | null>((worst, s) => (worst === null || s.daysLeft < worst.daysLeft ? s : worst), null);

  return (
    <>
      <SheetSection caption={t.common.note}>
        <Note>{row.daysLeft < 0 ? advice.expired : advice.live}</Note>
        {/* Keyed in is not the paper in the file: until somebody confirms
            receipt, a blocking paper still holds the vehicle at the gate. */}
        {row.stage === 'filed' ? (
          <div className="mt-2">
            <Note>
              {w.sheet.appliedNote}
              {row.daysLeft < 0 && row.doc.blocksOperation ? ` ${w.sheet.stillStops}` : ''}
            </Note>
          </div>
        ) : null}
      </SheetSection>

      <SheetSection caption={w.sheet.details}>
        <DetailGrid>
          <Detail label={L.document}>{w.docType[row.doc.type]}</Detail>
          <Detail label={L.number}>
            <IdCell>{row.doc.number}</IdCell>
          </Detail>
          <Detail label={L.issuedBy}>{row.doc.issuer}</Detail>
          <Detail label={L.vehicle}>
            <IdCell>{row.vehicle.displayReg}</IdCell>
            <span className="ml-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              {row.vehicle.model} · {w.tonnes(row.vehicle.classTonnes)}
            </span>
          </Detail>
          <Detail label={L.issuedOn}>
            {/* Nobody keys the issue date — only the end date goes into the book.
                This is the expiry read back through the statutory validity
                period, so it is inferred, and it says so. */}
            <Provisional>{formatDate(issued.toISOString())}</Provisional>
          </Detail>
          <Detail label={L.expiresOn}>
            {row.stage === 'open' ? (
              formatDate(row.expiresOn)
            ) : (
              <Provisional confirmed={row.stage === 'received'} originalValue={formatDate(row.doc.expiresOn)}>
                {formatDate(row.expiresOn)}
              </Provisional>
            )}
          </Detail>
          <Detail label={L.validFor}>{t.common.months(validity)}</Detail>
          <Detail label={row.daysLeft < 0 ? L.daysLate : L.daysLeft}>
            {row.daysLeft < 0 ? (
              <span style={{ color: row.doc.blocksOperation ? 'var(--status-critical)' : 'var(--status-attention)' }}>
                <QuantityCell value={Math.abs(row.daysLeft)} decimals={0} />
              </span>
            ) : (
              <QuantityCell value={row.daysLeft} decimals={0} />
            )}
          </Detail>
          <Detail label={L.cost}>
            <MoneyCell value={row.doc.cost} accounting={false} decimals={0} />
          </Detail>
          <Detail label={L.ifExpired}>{row.doc.blocksOperation ? w.sheet.stops : w.sheet.fineOnly}</Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={w.sheet.others(others.length)}>
        {others.length === 0 ? (
          // A vehicle with a single paper on record is itself worth a phone call.
          <Note>{w.sheet.noOthers}</Note>
        ) : (
          <>
            {/* Label, standing and price on one line need about 420px before
                the label starts truncating to nothing. Below `sm` the row
                becomes two lines — name, then standing and price facing each
                other — and grows to a 44px target for a thumb. */}
            <ul className="text-[13px]">
              {others.map((s) => (
                <li key={s.doc.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <button
                    type="button"
                    onClick={() => onOpenSibling(s.doc.id)}
                    className="flex min-h-11 w-full flex-col items-stretch justify-center gap-1 py-2 text-left sm:min-h-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:py-1.5 [@media(hover:hover)]:min-h-0"
                  >
                    <span className="min-w-0 truncate sm:flex-1" style={{ color: 'var(--text-primary)' }}>
                      {w.docType[s.doc.type]}
                    </span>
                    <span className="flex items-center justify-between gap-3 sm:contents">
                      <StatusStamp status={family(s)} label={label(s, w)} severity={t.common.daysShort(Math.abs(s.daysLeft))} />
                      <span className="w-24 shrink-0 text-right">
                        <MoneyCell value={s.doc.cost} accounting={false} decimals={0} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              {/* Renewals get batched per vehicle, because the trip to the RTO
                  is the expensive part, not the fee — worth clearing in one
                  visit when two or more fall inside the same quarter. */}
              <BarChart
                data={siblings.map((s) => ({
                  label: w.docType[s.doc.type],
                  value: Number.parseFloat(s.doc.cost ?? '0'),
                  ...(s.daysLeft < 0
                    ? { tone: s.doc.blocksOperation ? 'var(--status-critical)' : 'var(--status-attention)' }
                    : {}),
                }))}
                summary={w.sheet.fileSummary(formatINRCompact(vehicleBook), soonest ? w.docType[soonest.doc.type] : null)}
                format={(v) => formatINRCompact(v)}
                labelWidth={isPhone ? 120 : 150}
                onSelect={(d) => {
                  const hit = siblings.find((s) => w.docType[s.doc.type] === d.label);
                  if (hit) onOpenSibling(hit.doc.id);
                }}
              />
              <ChartCaption>{w.sheet.fileCaption(formatINR(vehicleBook, { decimals: 0 }))}</ChartCaption>
            </div>
          </>
        )}
      </SheetSection>

      {footnote ? (
        <p className="mt-5 font-serif text-[13px] italic sm:hidden" style={{ color: 'var(--text-tertiary)' }}>
          {footnote}
        </p>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- derivation */

/** Blocking-and-expired outranks everything. Then plain expired. Then the rest. */
function rank(r: Row): number {
  if (r.daysLeft < 0) return r.doc.blocksOperation ? 0 : 1;
  return 2;
}

function family(r: Row) {
  if (r.stage === 'filed') return 'pending' as const;
  if (r.daysLeft < 0) return r.doc.blocksOperation ? ('critical' as const) : ('attention' as const);
  if (r.daysLeft <= 30) return 'attention' as const;
  if (r.daysLeft <= 90) return 'pending' as const;
  return 'ready' as const;
}

/**
 * The status word. An expired PUC and an expired FC are not the same problem,
 * so the non-blocking one carries "fine" in the word itself — never colour alone.
 */
function label(r: Row, w: DocWords): string {
  if (r.stage === 'received') return w.status.renewed;
  if (r.stage === 'filed') return w.status.applied;
  if (r.daysLeft < 0) return r.doc.blocksOperation ? w.status.expired : w.status.expiredFine;
  if (r.daysLeft <= 30) return w.status.expiring;
  if (r.daysLeft <= 90) return w.status.renewSoon;
  return w.status.valid;
}

/**
 * The line in the table: what the paper means today, in the gateman's words.
 * Far-off papers say nothing — a diary entry is not news.
 */
function consequence(r: Row, w: DocWords): string | null {
  if (r.stage === 'filed') return r.daysLeft < 0 && r.doc.blocksOperation ? w.appliedStops : w.applied;
  if (r.daysLeft < 0) return w.lapse[r.doc.type];
  if (r.daysLeft <= 30) return w.renewBefore(formatDate(r.expiresOn));
  return null;
}

function sumCost(rows: Row[]): number {
  return rows.reduce((s, r) => s + Number.parseFloat(r.doc.cost ?? '0'), 0);
}

/** IST calendar month of an instant, as `YYYY-MM`. */
function istMonthKey(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` back to a month, for the chip that undoes a chart narrowing. */
function monthOfKey(key: string): { year: number; month: number } {
  const [year, month] = key.split('-');
  return { year: Number(year), month: Number(month) - 1 };
}

/** The next `n` IST calendar months, starting with the one we are standing in. */
function monthWindow(n: number): Month[] {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const out: Month[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1, 12));
    out.push({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
    });
  }
  return out;
}

const BUCKETS: { key: BucketKey; test: (r: Row) => boolean; tone?: string }[] = [
  {
    key: 'blocking',
    test: (r) => r.daysLeft < 0 && r.doc.blocksOperation,
    tone: 'var(--status-critical)',
  },
  {
    key: 'lapsed',
    test: (r) => r.daysLeft < 0 && !r.doc.blocksOperation,
    tone: 'var(--status-attention)',
  },
  { key: 'due30', test: (r) => r.daysLeft >= 0 && r.daysLeft <= 30 },
  { key: 'due90', test: (r) => r.daysLeft > 30 && r.daysLeft <= 90 },
  { key: 'later', test: (r) => r.daysLeft > 90 },
];

/** Statutory validity, used to read the issue date back off the expiry date. */
const VALIDITY_MONTHS: Record<ComplianceDocument['type'], number> = {
  insurance: 12,
  fitness: 24,
  road_tax: 12,
  permit: 60,
  national_permit: 12,
  puc: 6,
};

const DOC_TYPES: ComplianceDocument['type'][] = ['insurance', 'fitness', 'permit', 'national_permit', 'road_tax', 'puc'];

/* ---------------------------------------------------------------- columns */

/**
 * The register's columns, in the reader's language.
 *
 * No supra-header groups: "Vehicle" over "Vehicle" and "Document" over
 * "Document" said every word twice. The issuer moved to the sheet — it is a
 * fact about the paper, not a reason to act on the row.
 */
function makeColumns(t: ComplianceWords): Column<Row>[] {
  const w = t.docs;
  return [
    {
      key: 'vehicle',
      header: w.columns.vehicle,
      type: 'id',
      sticky: true,
      width: 190,
      render: (r) => (
        <Stacked
          primary={<IdCell>{r.vehicle.displayReg}</IdCell>}
          secondary={`${r.vehicle.model} · ${w.tonnes(r.vehicle.classTonnes)}`}
        />
      ),
    },
    {
      key: 'doc',
      header: w.columns.document,
      width: 160,
      render: (r) => w.docType[r.doc.type],
    },
    { key: 'number', header: w.columns.number, type: 'id', width: 150, render: (r) => <IdCell>{r.doc.number}</IdCell> },
    {
      key: 'expires',
      header: w.columns.expires,
      width: 130,
      render: (r) =>
        r.stage === 'open' ? (
          formatDate(r.expiresOn)
        ) : (
          // Filed but not in hand is asserted, not true. Received dries the ink.
          <Provisional confirmed={r.stage === 'received'} originalValue={formatDate(r.doc.expiresOn)}>
            {formatDate(r.expiresOn)}
          </Provisional>
        ),
    },
    {
      key: 'runway',
      header: w.columns.daysLeft,
      type: 'num',
      width: 104,
      render: (r) => (
        <span
          style={{
            color:
              r.daysLeft < 0 && r.doc.blocksOperation
                ? 'var(--status-critical)'
                : r.daysLeft <= 30
                  ? 'var(--status-attention)'
                  : undefined,
          }}
        >
          {r.daysLeft < 0 ? w.late(Math.abs(r.daysLeft)) : <QuantityCell value={r.daysLeft} decimals={0} />}
        </span>
      ),
    },
    {
      key: 'status',
      header: w.columns.status,
      type: 'status',
      width: 168,
      render: (r) => (
        <StatusStamp
          status={family(r)}
          label={label(r, w)}
          severity={r.stage === 'received' ? undefined : t.common.daysShort(Math.abs(r.daysLeft))}
          provisional={r.stage === 'filed'}
        />
      ),
    },
    {
      key: 'consequence',
      header: t.common.note,
      // Set in the data face, not Newsreader italic: inside a table cell the
      // italic reads as an annotation about the row rather than a value in it,
      // and this column is a value. The margin-note voice belongs in the sheet.
      render: (r) => {
        const text = consequence(r, w);
        return text ? (
          <span
            className="text-[13px]"
            style={{ color: r.daysLeft < 0 && r.doc.blocksOperation ? 'var(--status-critical)' : 'var(--text-secondary)' }}
          >
            {text}
          </span>
        ) : null;
      },
    },
    {
      key: 'cost',
      header: w.columns.cost,
      unit: '₹',
      type: 'money',
      width: 118,
      render: (r) => <MoneyCell value={r.doc.cost} decimals={0} />,
    },
  ];
}

/* ------------------------------------------------------------------ cards */

function DueCard({ label: caption, amount, note }: { label: string; amount: number; note?: string }) {
  return (
    // The 240px floor is gone: the grid above decides how many cards ride
    // abreast, so the card only has to fill whatever cell it lands in.
    <div
      className="min-w-0 px-4 py-3"
      style={{ background: 'var(--surface)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)', borderRadius: 'var(--r-2)' }}
    >
      <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {caption}
      </span>
      <p className="num mt-1 text-[24px] leading-none tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {formatINRCompact(amount)}
      </p>
      {note ? (
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
