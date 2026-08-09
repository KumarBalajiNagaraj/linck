import { useEffect, useMemo, useRef, useState } from 'react';
import { can, formatDate, formatDayMonth, formatINR, formatINRCompact } from '@linck/domain';
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
import { useApp } from '../../shell/store.js';

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
 */

type Stage = 'open' | 'filed' | 'received';
type Row = { doc: ComplianceDocument; vehicle: Vehicle; stage: Stage; daysLeft: number; expiresOn: string };
type Filter = 'all' | 'expired' | 'soon' | 'blocking';
type BucketKey = 'blocking' | 'lapsed' | 'due30' | 'due90' | 'later';

const RENEWAL_DAYS = 365;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/** `Aug 26`. Month buckets are IST calendar months, like every other date here. */
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', month: 'short', year: '2-digit' });

export function DocumentRegister() {
  const { persona, siteScope, density } = useApp();
  /* Charts are drawn in real pixels, so the gutter reserved for their direct
     labels is a number and not a class. On a phone the month labels ("Aug 26")
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
     bar on this page allowed to spend a colour. */
  const months = useMemo(() => monthWindow(horizon), [horizon]);
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
    ...(lapsed.length > 0
      ? [{ label: 'Already lapsed', value: sumCost(lapsed), tone: 'var(--status-critical)' }]
      : []),
    ...months.map((m) => ({ label: m.label, value: sumCost(dueByMonth.get(m.key) ?? []) })),
  ];
  const peakMonth = months.reduce<{ label: string; amount: number }>(
    (best, m) => {
      const amount = sumCost(dueByMonth.get(m.key) ?? []);
      return amount > best.amount ? { label: m.label, amount } : best;
    },
    { label: '–', amount: 0 },
  );

  /* ---- chart (b): how many papers sit in each expiry bucket --------------- */
  const bucketBars: BarDatum[] = BUCKETS.map((b) => {
    const count = all.filter(b.test).length;
    return { label: b.label, value: count, ...(b.tone ? { tone: b.tone } : {}) };
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
     a sentence beside it only fits on a desk. The sentence is not decoration —
     "filing is not the same as holding the paper" is the whole reason the two
     stages exist — so on a phone it moves to the foot of the sheet body rather
     than being dropped. Same words, different place. */
  const footnote =
    current === undefined || !canWrite
      ? null
      : current.stage === 'received'
        ? `Expiry moved out to ${formatDate(current.expiresOn)}.`
        : current.stage === 'open'
          ? 'Filing is not the same as holding the paper.'
          : null;

  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        title="Document & expiry register"
        meta={
          <span className="flex flex-wrap items-center gap-4">
            <AsOfStamp asOf="14:42" source="v_document_expiry" freshness="materialised" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {all.length} documents across {new Set(all.map((r) => r.vehicle.id)).size} vehicles · every date keyed by
              hand at the office
            </span>
          </span>
        }
      />

      {/* One tile per row on a phone. Every delta here is a sentence — "3 of
          them stop the vehicle at the gate" — and at half of 375px that runs
          to four wrapped lines under a 40px number. The hairline that separates
          tiles turns from a vertical rule into a horizontal one to match. */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-[var(--border-subtle)] max-sm:[&>*:not(:last-child)]:border-b sm:[&>*]:border-r">
        <KpiTile
          eyebrow="Already expired"
          hero
          value={String(expired.length)}
          delta={{
            text: `${blocking.length} of them stop the vehicle at the gate`,
            tone: blocking.length > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source="v_document_expiry"
        />
        <KpiTile
          eyebrow="Expiring within 30 days"
          value={String(in30.length)}
          delta={{ text: `${formatINRCompact(sumCost(in30))} of renewals to fund`, tone: in30.length > 0 ? 'attention' : 'neutral' }}
          asOf="14:42"
          source="v_document_expiry"
        />
        <KpiTile
          eyebrow="Expiring within 90 days"
          value={String(in90.length)}
          delta={{ text: 'Far enough out to book RTO slots calmly' }}
          asOf="14:42"
          source="v_document_expiry"
        />
        <KpiTile
          eyebrow="Annual renewal book"
          value={formatINRCompact(annualBook)}
          delta={{ text: 'Insurance, FC, permits, road tax and PUC for this scope' }}
          asOf="14:42"
          source="v_document_cost_annual"
          freshness="materialised"
        />
      </TileRow>

      <Section
        caption="Not a compliance question — a cash question"
        title="Renewal cash falling due"
        actions={
          /* Wrapping the pair lets the two chips drop under one another on a
             narrow header instead of squeezing the title to one word a line. */
          <div className="flex flex-wrap justify-end gap-2">
            <Chip active={horizon === 6} onClick={() => setHorizon(6)}>
              Six months
            </Chip>
            <Chip active={horizon === 12} onClick={() => setHorizon(12)}>
              Twelve months
            </Chip>
          </div>
        }
      >
        <div className="grid gap-3 px-6 sm:grid-cols-2 lg:grid-cols-3">
          <DueCard label="Within 30 days" amount={sumCost(all.filter((r) => r.daysLeft <= 30))} note="Includes what has already lapsed — that bill is owed today" />
          <DueCard label="Within 60 days" amount={sumCost(all.filter((r) => r.daysLeft <= 60))} note="Cumulative, not incremental" />
          <DueCard label="Within 90 days" amount={sumCost(all.filter((r) => r.daysLeft <= 90))} note="Cumulative, not incremental" />
        </div>

        <div className="mt-5 px-6">
          <BarChart
            data={cashBars}
            summary={`${formatINRCompact(sumCost(lapsed))} of renewals has already lapsed and is owed today. Over the next ${horizon} months the heaviest month is ${peakMonth.label} at ${formatINRCompact(peakMonth.amount)}.`}
            format={(v) => formatINRCompact(v)}
            labelWidth={isPhone ? 92 : 140}
            onSelect={(d) => {
              const match = months.find((m) => m.label === d.label);
              const next = match ? match.key : 'lapsed';
              setMonthKey((k) => (k === next ? null : next));
            }}
          />
          <ChartCaption>
            The cards above are cumulative; these bars are not. A month standing well above its neighbours is the one
            to move papers out of — an FC or a permit can be renewed early without losing the unexpired months, and
            insurance cannot. Click a month to narrow the register to it.
          </ChartCaption>
        </div>
      </Section>

      <Section caption="How much paper is in trouble" title="Documents by expiry bucket">
        <div className="px-6">
          {/* These labels are the finding — "Expired — stops the truck" is the
              whole distinction this chart exists to draw — so they do not get
              shortened or truncated to fit a phone. The chart scrolls sideways
              inside its own box instead, and the page body does not move. */}
          <div className="-mx-6 overflow-x-auto px-6">
            <div className="min-w-[500px]">
              <BarChart
                data={bucketBars}
                summary={`${blocking.length} expired documents stop a vehicle at the gate, ${expired.length - blocking.length} expired ones are a fine only, and ${in30.length} more fall due within thirty days.`}
                format={(v) => String(Math.round(v))}
                labelWidth={200}
                onSelect={(d) => {
                  const spec = BUCKETS.find((b) => b.label === d.label);
                  if (!spec) return;
                  setBucket((b) => (b === spec.key ? null : spec.key));
                }}
              />
            </div>
          </div>
          <ChartCaption>
            The top two bars both say &ldquo;expired&rdquo; and are completely different problems — one is a stopped
            truck earning nothing, the other is a receipt at a check post. Everything below them is a diary entry, not
            an emergency, which is why only the first two spend a colour.
          </ChartCaption>
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
            All documents
          </Chip>
          <Chip active={filter === 'expired'} onClick={() => setFilter('expired')} count={expired.length}>
            Expired
          </Chip>
          <Chip active={filter === 'soon'} onClick={() => setFilter('soon')} count={in30.length}>
            Next 30 days
          </Chip>
          <Chip active={filter === 'blocking'} onClick={() => setFilter('blocking')} count={blocking.length}>
            Stops the vehicle
          </Chip>
          <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-default)' }} />
          {DOC_TYPES.map((t) => (
            <Chip key={t.type} active={docType === t.type} onClick={() => setDocType(docType === t.type ? null : t.type)}>
              {t.label}
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
              Narrowed from the charts
            </span>
            {monthKey !== null ? (
              <Chip active onClick={() => setMonthKey(null)}>
                {monthKey === 'lapsed' ? 'Already lapsed' : (months.find((m) => m.key === monthKey)?.label ?? monthKey)} ×
              </Chip>
            ) : null}
            {bucket !== null ? (
              <Chip active onClick={() => setBucket(null)}>
                {BUCKETS.find((b) => b.key === bucket)?.label} ×
              </Chip>
            ) : null}
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {rows.length} of {all.length} documents
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
          empty={
            <EmptyState
              fact="No document matches this view."
              because="Either the paperwork here is in order, or the filter is narrower than the shoebox."
              action={{ label: 'Show the whole register', onClick: clearAll }}
            />
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={current !== undefined}
        onClose={() => setSelected(undefined)}
        width="form"
        title={current?.doc.label ?? ''}
        identifier={current ? `${current.doc.number} · ${current.vehicle.displayReg}` : undefined}
        {...(current
          ? {
              status: {
                family: family(current),
                label: label(current),
                ...(current.stage === 'received' ? {} : { severity: `${Math.abs(current.daysLeft)}d` }),
                ...(current.stage === 'filed' ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={current ? `EXPIRES ${formatDate(current.expiresOn)}` : undefined}
        footer={
          current ? (
            canWrite ? (
              current.stage === 'received' ? (
                <>
                  <Button onClick={() => setStage(current.doc.id, 'open')}>Undo renewal</Button>
                  <span className="hidden font-serif text-[12px] italic sm:inline" style={{ color: 'var(--text-tertiary)' }}>
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
                    Confirm new papers received
                  </Button>
                  <Button
                    className="whitespace-nowrap max-sm:px-2.5 max-sm:text-[13px]"
                    onClick={() => setStage(current.doc.id, 'open')}
                  >
                    Withdraw filing
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="primary" className="whitespace-nowrap" onClick={() => setStage(current.doc.id, 'filed')}>
                    Record renewal filed
                  </Button>
                  <span className="hidden font-serif text-[12px] italic sm:inline" style={{ color: 'var(--text-tertiary)' }}>
                    {footnote}
                  </span>
                </>
              )
            ) : (
              <span className="font-serif text-[12px] italic leading-tight sm:text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                Accounts records renewals. You are reading this register, not keeping it.
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
        title="Confirm the new papers are in the file"
        confirmLabel="Papers are in hand"
        consequence={
          current ? (
            <>
              This records that a valid {current.doc.label.toLowerCase()} for {current.vehicle.displayReg} is
              physically held, and moves the expiry from {formatDate(current.doc.expiresOn)} to{' '}
              {formatDate(new Date(Date.parse(current.doc.expiresOn) + RENEWAL_DAYS * DAY_MS).toISOString())}.
              {current.doc.blocksOperation
                ? ' The gate will release this vehicle on the strength of this entry, so say yes only with the paper in your hand.'
                : ' The register will stop flagging it, so say yes only with the paper in your hand.'}
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
  const isPhone = useIsPhone();
  const copy = CONSEQUENCE_COPY[row.doc.type];
  const validity = VALIDITY_MONTHS[row.doc.type];
  const issued = new Date(Date.parse(row.expiresOn));
  issued.setUTCMonth(issued.getUTCMonth() - validity);

  const others = siblings.filter((s) => s.doc.id !== row.doc.id);
  const vehicleBook = sumCost(siblings);
  const soonest = siblings.reduce<Row | null>((worst, s) => (worst === null || s.daysLeft < worst.daysLeft ? s : worst), null);

  return (
    <>
      <SheetSection caption="What this actually costs you">
        <Note>{row.daysLeft < 0 ? copy.expired : copy.live}</Note>
        {row.stage === 'filed' ? (
          <div className="mt-2">
            <Note>
              The renewal has been keyed in but the paper is not in the file. Until somebody confirms receipt this
              register still treats the vehicle as {row.doc.blocksOperation ? 'stopped' : 'lapsed'}.
            </Note>
          </div>
        ) : null}
      </SheetSection>

      <SheetSection caption="The paper">
        <DetailGrid>
          <Detail label="Document">{row.doc.label}</Detail>
          <Detail label="Number">
            <IdCell>{row.doc.number}</IdCell>
          </Detail>
          <Detail label="Issued by">{row.doc.issuer}</Detail>
          <Detail label="Vehicle">
            <IdCell>{row.vehicle.displayReg}</IdCell>
            <span className="ml-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              {row.vehicle.model} · {row.vehicle.classTonnes}T
            </span>
          </Detail>
          <Detail label="Issued on">
            {/* Nobody keys the issue date — only the end date goes into the book.
                This is the expiry read back through the statutory validity
                period, so it is inferred, and it says so. */}
            <Provisional>{formatDate(issued.toISOString())}</Provisional>
          </Detail>
          <Detail label="Expires on">
            {row.stage === 'open' ? (
              formatDate(row.expiresOn)
            ) : (
              <Provisional confirmed={row.stage === 'received'} originalValue={formatDate(row.doc.expiresOn)}>
                {formatDate(row.expiresOn)}
              </Provisional>
            )}
          </Detail>
          <Detail label="Validity period">{validity} months</Detail>
          <Detail label="Runway">
            {row.daysLeft < 0 ? (
              <span style={{ color: row.doc.blocksOperation ? 'var(--status-critical)' : 'var(--status-attention)' }}>
                <QuantityCell value={Math.abs(row.daysLeft)} decimals={0} uom="days overdue" />
              </span>
            ) : (
              <QuantityCell value={row.daysLeft} decimals={0} uom="days left" />
            )}
          </Detail>
          <Detail label="Renewal cost">
            <MoneyCell value={row.doc.cost} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Stops the vehicle">{row.doc.blocksOperation ? 'Yes, at the gate' : 'No — a fine only'}</Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={`The rest of ${row.vehicle.displayReg}'s file (${others.length})`}>
        {others.length === 0 ? (
          <Note>This is the only document on record for the vehicle, which is itself worth a phone call.</Note>
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
                      {s.doc.label}
                    </span>
                    <span className="flex items-center justify-between gap-3 sm:contents">
                      <StatusStamp status={family(s)} label={label(s)} severity={`${Math.abs(s.daysLeft)}d`} />
                      <span className="w-24 shrink-0 text-right">
                        <MoneyCell value={s.doc.cost} accounting={false} decimals={0} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <BarChart
                data={siblings.map((s) => ({
                  label: s.doc.label,
                  value: Number.parseFloat(s.doc.cost ?? '0'),
                  ...(s.daysLeft < 0
                    ? { tone: s.doc.blocksOperation ? 'var(--status-critical)' : 'var(--status-attention)' }
                    : {}),
                }))}
                summary={`Renewing every paper on ${row.vehicle.displayReg} costs ${formatINRCompact(vehicleBook)}. ${
                  soonest ? `${soonest.doc.label} is the next to go.` : ''
                }`}
                format={(v) => formatINRCompact(v)}
                labelWidth={isPhone ? 108 : 150}
                onSelect={(d) => {
                  const hit = siblings.find((s) => s.doc.label === d.label);
                  if (hit) onOpenSibling(hit.doc.id);
                }}
              />
              <ChartCaption>
                Renewals get batched per vehicle, because the trip to the RTO is the expensive part, not the fee. The
                whole file is {formatINR(vehicleBook, { decimals: 0 })} — worth clearing in one visit if two
                or more of these fall inside the same quarter. Click a bar to open that paper.
              </ChartCaption>
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

function sumCost(rows: Row[]): number {
  return rows.reduce((s, r) => s + Number.parseFloat(r.doc.cost ?? '0'), 0);
}

/** IST calendar month of an instant, as `YYYY-MM`. */
function istMonthKey(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The next `n` IST calendar months, starting with the one we are standing in. */
function monthWindow(n: number): { key: string; label: string }[] {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1, 12));
    out.push({ key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, label: MONTH_FMT.format(d) });
  }
  return out;
}

const BUCKETS: { key: BucketKey; label: string; test: (r: Row) => boolean; tone?: string }[] = [
  {
    key: 'blocking',
    label: 'Expired — stops the truck',
    test: (r) => r.daysLeft < 0 && r.doc.blocksOperation,
    tone: 'var(--status-critical)',
  },
  {
    key: 'lapsed',
    label: 'Expired — fine only',
    test: (r) => r.daysLeft < 0 && !r.doc.blocksOperation,
    tone: 'var(--status-attention)',
  },
  { key: 'due30', label: 'Due within 30 days', test: (r) => r.daysLeft >= 0 && r.daysLeft <= 30 },
  { key: 'due90', label: 'Due in 31 to 90 days', test: (r) => r.daysLeft > 30 && r.daysLeft <= 90 },
  { key: 'later', label: 'Over 90 days of runway', test: (r) => r.daysLeft > 90 },
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

/** What an expiry actually costs you, per document type, in the gateman's words. */
const LAPSE_COPY: Record<ComplianceDocument['type'], string> = {
  insurance: 'Uninsured on the road. Stops the vehicle at the gate.',
  fitness: 'No fitness certificate. Stops the vehicle at the gate.',
  road_tax: 'Tax lapsed. Stops the vehicle at the gate, and arrears accrue.',
  permit: 'State permit lapsed. Stops the vehicle at the gate.',
  national_permit: 'Interstate loads blocked. Within Tamil Nadu it still runs.',
  puc: 'Fine at a check post. The tipper can still work today.',
};

/**
 * The same fact at sheet length. `expired` is what has already happened;
 * `live` is what to do about the date before it arrives — and those are
 * genuinely different advice per document, which is why this is not one string.
 */
const CONSEQUENCE_COPY: Record<ComplianceDocument['type'], { expired: string; live: string }> = {
  insurance: {
    expired:
      'Uninsured. The gate does not release the vehicle, and if it goes out anyway a single third-party claim lands on the owner personally. There is no grace period on motor cover — it stopped at midnight on the expiry date.',
    live: 'Motor cover ends on the date, with no grace period, so the renewal has to be paid before it and not on it. Nothing about this one needs the vehicle to be present.',
  },
  fitness: {
    expired:
      'No fitness certificate. Stops the vehicle at the gate, and it is the first paper an RTO flying squad asks for. Getting it back costs a working day, because the tipper has to physically go to the yard.',
    live: 'The vehicle has to be driven to the RTO yard for inspection, so this renewal costs a day of earnings on top of the fee. Book the slot early and pair it with the PUC.',
  },
  road_tax: {
    expired:
      'Road tax lapsed. Stops the vehicle at the gate, and arrears keep building every quarter it stays unpaid — the bill only ever goes one way.',
    live: 'Paid before the date it is a line item; paid after it is a penalty. Nothing here needs an inspection, so there is no reason for this one ever to lapse.',
  },
  permit: {
    expired:
      'State permit lapsed. Stops the vehicle at the gate — without it there is no authority to carry a load anywhere in Tamil Nadu, loaded or empty.',
    live: 'This is the paper that authorises the load itself. If several documents on this vehicle are close together, renew this one first.',
  },
  national_permit: {
    expired:
      'Interstate loads are blocked. Inside Tamil Nadu the tipper still runs on the state permit, so this does not stop the gate — it only closes the border.',
    live: 'Only matters if this vehicle actually crosses the border. If it has never left the state, this is optional spend and worth questioning at renewal.',
  },
  puc: {
    expired:
      'A fine at a check post, and nothing more. The tipper can still work today. Do not stop a loaded vehicle over this one.',
    live: 'Six months, cheap, and done in twenty minutes at any authorised centre. Batch it with the fitness inspection rather than making a separate trip.',
  },
};

/**
 * The consequence line. An expired PUC and an expired fitness certificate are
 * not the same problem, and the row has to say which one it is in words.
 */
function consequence(r: Row): string | null {
  if (r.stage === 'filed') return 'Renewal keyed in. The vehicle is still stopped until the paper is in the file.';
  if (r.daysLeft < 0) return LAPSE_COPY[r.doc.type];
  if (r.daysLeft <= 30) return `Book the renewal before ${formatDayMonth(r.expiresOn)}.`;
  return null;
}

const DOC_TYPES: { type: ComplianceDocument['type']; label: string }[] = [
  { type: 'insurance', label: 'Insurance' },
  { type: 'fitness', label: 'Fitness' },
  { type: 'permit', label: 'State permit' },
  { type: 'national_permit', label: 'National permit' },
  { type: 'road_tax', label: 'Road tax' },
  { type: 'puc', label: 'PUC' },
];

/* ---------------------------------------------------------------- columns */

const columns: Column<Row>[] = [
  {
    key: 'vehicle',
    header: 'Vehicle',
    type: 'id',
    sticky: true,
    width: 190,
    group: 'Vehicle',
    render: (r) => (
      <Stacked primary={<IdCell>{r.vehicle.displayReg}</IdCell>} secondary={`${r.vehicle.model} · ${r.vehicle.classTonnes}T`} />
    ),
  },
  {
    key: 'doc',
    header: 'Document',
    width: 200,
    group: 'Document',
    render: (r) => <Stacked primary={r.doc.label} secondary={r.doc.issuer} />,
  },
  { key: 'number', header: 'Number', type: 'id', width: 150, group: 'Document', render: (r) => <IdCell>{r.doc.number}</IdCell> },
  {
    key: 'expires',
    header: 'Expires on',
    width: 130,
    group: 'Validity',
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
    header: 'Runway',
    unit: 'days',
    type: 'num',
    width: 96,
    group: 'Validity',
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
        <QuantityCell value={r.daysLeft} decimals={0} />
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Standing',
    type: 'status',
    width: 168,
    group: 'Validity',
    render: (r) => (
      <StatusStamp
        status={family(r)}
        label={label(r)}
        severity={r.stage === 'received' ? undefined : `${Math.abs(r.daysLeft)}d`}
        provisional={r.stage === 'filed'}
      />
    ),
  },
  {
    key: 'consequence',
    header: 'What it means',
    group: 'Validity',
    // Set in the data face, not Newsreader italic: inside a table cell the
    // italic reads as an annotation about the row rather than a value in it,
    // and this column is a value. The margin-note voice belongs in the sheet.
    render: (r) => {
      const text = consequence(r);
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
    header: 'Renewal',
    unit: '₹',
    type: 'money',
    width: 118,
    group: 'Cost',
    render: (r) => <MoneyCell value={r.doc.cost} decimals={0} />,
  },
];

function label(r: Row): string {
  if (r.stage === 'received') return 'renewed';
  if (r.stage === 'filed') return 'renewal filed';
  if (r.daysLeft < 0) return r.doc.blocksOperation ? 'expired' : 'lapsed';
  if (r.daysLeft <= 30) return 'expiring';
  if (r.daysLeft <= 90) return 'renew soon';
  return 'valid';
}

/* ------------------------------------------------------------------ cards */

function DueCard({ label: caption, amount, note }: { label: string; amount: number; note: string }) {
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
      <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {note}
      </p>
    </div>
  );
}
