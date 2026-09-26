import { useMemo, useState } from 'react';
import { can, formatINR, formatINRCompact, formatQty } from '@linck/domain';
import { INDENTS, NOW, SITES, type Indent } from '@linck/mock';
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
  Provisional,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  TargetGauge,
  TileRow,
  useIsTouch,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

const INDENT_VIEWS = ['open', 'all', 'breakdown', 'below_reorder'] as const;

/**
 * The Indent Queue.
 *
 * Stores is the smallest team and the one most likely to abandon a system that
 * asks too much, so this screen deliberately does one thing: show what has
 * been asked for, what it will cost, and whether the plant is standing still
 * waiting for it.
 *
 * The ordering rule is the whole design. A breakdown indent is not a more
 * urgent routine indent — it means a crusher or a tipper is stopped RIGHT NOW
 * and every hour it sits in this queue is production that does not happen. So
 * urgency sorts above age, and a breakdown line says what is stopped rather
 * than just saying "urgent".
 *
 * The two charts follow from that. The ageing bar answers "how long has the
 * plant been waiting on us", which is the only question this desk is actually
 * judged on. The spend bar answers the finance question sitting underneath it —
 * what has already been committed, and how much more is queued behind it.
 */

type Stage = Indent['status'];

const URGENCY_RANK: Record<Indent['urgency'], number> = { breakdown: 0, urgent: 1, routine: 2 };

const STAGE_FAMILY = {
  submitted: 'pending',
  approved: 'active',
  issued: 'ready',
  rejected: 'dormant',
} as const;

const STAGE_LABEL: Record<Stage, string> = {
  submitted: 'Awaiting approval',
  approved: 'Approved',
  issued: 'Issued',
  rejected: 'Rejected',
};

const URGENCY_LABEL: Record<Indent['urgency'], string> = {
  breakdown: 'Breakdown',
  urgent: 'Urgent',
  routine: 'Routine',
};

const URGENCY_FAMILY = {
  breakdown: 'critical',
  urgent: 'attention',
  routine: 'pending',
} as const;

/**
 * Item code prefixes carry the stores category. There is no category column in
 * the source, and inventing one would be a lie — but the coding scheme is real
 * and the storekeeper reads it that way every day.
 */
const CATEGORY_LABEL: Record<string, string> = {
  SP: 'Plant spares',
  CN: 'Consumables',
  TY: 'Tyres and tubes',
};

function categoryOf(itemCode: string): string {
  return CATEGORY_LABEL[itemCode.slice(0, 2)] ?? 'Other stores';
}

function siteName(siteId: string): string {
  return SITES.find((s) => s.id === siteId)?.name ?? siteId;
}

/** Hours a row has been sitting in this queue, against the fixed data clock. */
function waitedHours(indent: Indent): number {
  return (NOW.getTime() - Date.parse(indent.raisedOn)) / 3_600_000;
}

function formatWait(hours: number): string {
  if (hours < 1) return 'under an hour';
  if (hours < 24) return `${Math.round(hours)} hours`;
  return `${formatQty(hours / 24, 1)} days`;
}

/** Ordered, and the later ones are the ones that cost money. */
const WAIT_BUCKETS: { label: string; upto: number }[] = [
  { label: 'Under 4 h', upto: 4 },
  { label: '4 – 12 h', upto: 12 },
  { label: '12 – 24 h', upto: 24 },
  { label: 'Over a day', upto: Number.POSITIVE_INFINITY },
];

type Lens = 'all' | Indent['urgency'];
type GroupBy = 'site' | 'category';

interface Row extends Indent {
  stage: Stage;
  /** Whether the item is out of stock — a zero here is why the plant is down. */
  shortBy: number;
  waited: number;
}

interface SpendGroup {
  key: string;
  label: string;
  /** The bar label actually drawn — carries the stoppage in words, not in hue. */
  display: string;
  committed: number;
  awaiting: number;
  stopped: boolean;
}

export function IndentQueue() {
  const { persona, siteScope, density } = useApp();
  // Bar rows are 22px on a mouse — a deliberate density choice — and 22px is
  // not a thumb target. Keyed to the pointer, not the screen: a weighbridge
  // terminal is a wide display that still gets fingers.
  const touch = useIsTouch();
  const [overrides, setOverrides] = useState<Record<string, Stage>>({});
  const [filter, setFilter] = useViewParam(INDENT_VIEWS, 'open');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [lens, setLens] = useState<Lens>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('site');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  const mayApprove = can(persona.grants, 'stores.indent.approve', { siteId: siteScope });

  const rows = useMemo<Row[]>(() => {
    const scoped = siteScope ? INDENTS.filter((i) => i.siteId === siteScope) : INDENTS;
    return scoped
      .map((indent) => ({
        ...indent,
        stage: overrides[indent.id] ?? indent.status,
        shortBy: Math.max(0, indent.reorderLevel - indent.stockOnHand),
        waited: waitedHours(indent),
      }))
      .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || Date.parse(a.raisedOn) - Date.parse(b.raisedOn));
  }, [siteScope, overrides]);

  const isOpen = (r: Row) => r.stage === 'submitted' || r.stage === 'approved';
  const groupKeyOf = (r: Row, by: GroupBy) => (by === 'site' ? r.siteId : categoryOf(r.itemCode));

  const visible = useMemo(() => {
    const byStage =
      filter === 'all'
        ? rows
        : filter === 'breakdown'
          ? rows.filter((r) => r.urgency === 'breakdown')
          : filter === 'below_reorder'
            ? rows.filter((r) => r.stockOnHand < r.reorderLevel)
            : rows.filter(isOpen);
    return groupFilter ? byStage.filter((r) => groupKeyOf(r, groupBy) === groupFilter) : byStage;
  }, [rows, filter, groupFilter, groupBy]);

  const awaiting = rows.filter((r) => r.stage === 'submitted');
  const breakdownWaiting = awaiting.filter((r) => r.urgency === 'breakdown');
  const committed = rows
    .filter((r) => r.stage === 'approved' || r.stage === 'issued')
    .reduce((sum, r) => sum + Number.parseFloat(r.estimatedValue), 0);
  const awaitingValue = awaiting.reduce((sum, r) => sum + Number.parseFloat(r.estimatedValue), 0);

  const oldestHours = awaiting.length ? Math.max(...awaiting.map((r) => r.waited)) : 0;

  /* --- Chart (a): how long the queue has kept somebody waiting ----------- */

  const ageingRows = useMemo(
    () => rows.filter((r) => isOpen(r) && (lens === 'all' || r.urgency === lens)),
    [rows, lens],
  );

  const ageingBuckets = useMemo(
    () =>
      WAIT_BUCKETS.map((b, i) => {
        const floor = i === 0 ? 0 : (WAIT_BUCKETS[i - 1]?.upto ?? 0);
        return { label: b.label, value: ageingRows.filter((r) => r.waited >= floor && r.waited < b.upto).length };
      }),
    [ageingRows],
  );

  const overADay = ageingBuckets[3]?.value ?? 0;

  /**
   * The buckets the bar will not be able to label itself.
   *
   * `AgeingBar` direct-labels each segment and drops the caption when the
   * segment is narrower than the words — about a sixth of a 327px phone bar,
   * and an empty bucket every time. Restating only those underneath keeps every
   * rung of the ladder legible without printing any label twice.
   */
  const unlabelledBuckets = ageingBuckets.filter((b) => b.value / (ageingRows.length || 1) < 0.2);

  /* --- Chart (b): where the money has been committed --------------------- */

  const groups = useMemo<SpendGroup[]>(() => {
    const map = new Map<string, SpendGroup>();
    for (const r of rows) {
      const key = groupKeyOf(r, groupBy);
      const label = groupBy === 'site' ? siteName(r.siteId) : key;
      const g = map.get(key) ?? { key, label, display: label, committed: 0, awaiting: 0, stopped: false };
      const value = Number.parseFloat(r.estimatedValue);
      if (r.stage === 'approved' || r.stage === 'issued') g.committed += value;
      if (r.stage === 'submitted') {
        g.awaiting += value;
        if (r.urgency === 'breakdown') g.stopped = true;
      }
      map.set(key, g);
    }
    return [...map.values()]
      .map((g) => ({ ...g, display: g.stopped ? `${g.label} · stopped` : g.label }))
      .sort((a, b) => b.committed - a.committed || b.awaiting - a.awaiting);
  }, [rows, groupBy]);

  const spendBars = groups.map((g) => ({
    label: g.display,
    value: g.committed,
    ...(g.awaiting > 0 ? { marker: g.awaiting } : {}),
    ...(g.stopped ? { tone: 'var(--status-critical)' } : {}),
  }));

  const topGroup = groups[0];
  const stoppedGroups = groups.filter((g) => g.stopped);

  /* --- Selection, and the two things that mutate it --------------------- */

  // Read from `rows`, not `visible` — otherwise approving an indent under the
  // "Open" filter would snatch the sheet away mid-decision.
  const selectedRow = rows.find((r) => r.id === selected);
  const rejectRow = rows.find((r) => r.id === confirmReject);
  const siblings = selectedRow
    ? rows.filter((r) => r.id !== selectedRow.id && r.forAsset !== null && r.forAsset === selectedRow.forAsset)
    : [];

  const setStage = (id: string, stage: Stage) => setOverrides((prev) => ({ ...prev, [id]: stage }));

  const pickGroup = (label: string) => {
    const hit = groups.find((g) => g.display === label);
    if (!hit) return;
    setGroupFilter((prev) => (prev === hit.key ? null : hit.key));
  };

  const changeGroupBy = (next: GroupBy) => {
    setGroupBy(next);
    setGroupFilter(null);
  };

  const groupFilterLabel = groups.find((g) => g.key === groupFilter)?.label ?? null;

  /*
   * The two chip rows are declared once and placed twice.
   *
   * A section header on a phone cannot hold "Committed spend, and what is
   * queued behind it" and a pair of chips on the same line — the header is a
   * `justify-between` flex, so the chips either squash the title or push off
   * the right edge. So below `sm` the chips leave the header and ride above
   * the chart as their own scrolling strip. Exactly one of the two placements
   * is ever rendered — the other is `display: none`, so nothing is focusable
   * twice and no state is duplicated.
   */
  const lensChips = (
    <>
      <Chip active={lens === 'all'} onClick={() => setLens('all')}>
        All
      </Chip>
      <Chip active={lens === 'breakdown'} onClick={() => setLens('breakdown')}>
        Breakdown
      </Chip>
      <Chip active={lens === 'urgent'} onClick={() => setLens('urgent')}>
        Urgent
      </Chip>
      <Chip active={lens === 'routine'} onClick={() => setLens('routine')}>
        Routine
      </Chip>
    </>
  );

  const groupChips = (
    <>
      <Chip active={groupBy === 'site'} onClick={() => changeGroupBy('site')}>
        By site
      </Chip>
      <Chip active={groupBy === 'category'} onClick={() => changeGroupBy('category')}>
        By category
      </Chip>
    </>
  );

  /** Chips in a strip that scrolls rather than squashing. */
  const stripClass = 'flex gap-2 overflow-x-auto px-6 pb-3 sm:hidden [&>button]:shrink-0';

  return (
    <>
      <PageHeader
        eyebrow="Stores"
        title="Indent queue"
        meta={<AsOfStamp asOf="14:42" source="v_indent_queue" freshness="live" />}
        actions={<Button variant="primary">Raise an indent</Button>}
      />

      {/*
        Two tiles across a phone leaves ~130px of measure, and these deltas are
        sentences — "A plant or a tipper is stopped until these are approved"
        wraps to six lines and the number stops being the thing you read. One
        tile per row below `sm`; the separating hairline turns from a right edge
        into a bottom one so the stack still reads as a ruled panel.
      */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <KpiTile
          eyebrow="Awaiting approval"
          hero
          value={String(awaiting.length)}
          delta={{
            text: `${formatINRCompact(awaitingValue)} of spend not yet committed`,
            ...(breakdownWaiting.length > 0 ? { tone: 'critical' as const } : {}),
          }}
          asOf="14:42"
          source="v_indent_queue"
        />
        {/*
          The number that should make somebody get up from their desk. A
          breakdown indent sitting in a queue is a stopped crusher, and the
          hours are the cost.
        */}
        <KpiTile
          eyebrow="Breakdown indents waiting"
          value={String(breakdownWaiting.length)}
          delta={{
            text:
              breakdownWaiting.length > 0
                ? 'A plant or a tipper is stopped until these are approved'
                : 'Nothing is stopped waiting on stores',
            ...(breakdownWaiting.length > 0 ? { tone: 'critical' as const } : {}),
          }}
          asOf="14:42"
          source="v_indent_queue"
        />
        <KpiTile
          eyebrow="Oldest in queue"
          value={oldestHours >= 24 ? `${formatQty(oldestHours / 24, 1)} days` : `${Math.round(oldestHours)} hours`}
          delta={{
            text: 'Ageing is the control here, not a blocked button',
            ...(oldestHours > 24 ? { tone: 'attention' as const } : {}),
          }}
          asOf="14:42"
          source="v_indent_queue"
        />
        <KpiTile
          eyebrow="Committed spend"
          value={formatINRCompact(committed)}
          delta={{ text: 'Approved or already issued this period' }}
          asOf="14:42"
          source="v_procurement_commitment"
        />
      </TileRow>

      {/*
        The outer inset goes on the two-column layout only. Below `sm` the
        wrapper padding stacked on top of the Section's own `px-6` cost 96px of
        a 375px screen and left the ageing bar drawn in a 279px trench, out of
        line with every other rule on the page.
      */}
      <div className="grid grid-cols-1 gap-x-8 px-0 pt-6 sm:px-6 xl:grid-cols-2">
        <Section
          caption="Open indents, by how long they have waited"
          title="The clock on this desk"
          actions={<div className="hidden items-center gap-2 sm:flex">{lensChips}</div>}
        >
          <div className={stripClass}>{lensChips}</div>
          <div className="px-6">
            {ageingRows.length === 0 ? (
              <p className="font-serif py-6 text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                Nothing open at this urgency. Try another split.
              </p>
            ) : (
              <>
                <AgeingBar
                  height={64}
                  summary={`${ageingRows.length} open ${lens === 'all' ? '' : `${URGENCY_LABEL[lens].toLowerCase()} `}indent${
                    ageingRows.length === 1 ? '' : 's'
                  }, of which ${overADay} ${overADay === 1 ? 'has' : 'have'} waited more than a day.`}
                  buckets={ageingBuckets}
                  format={(v) => (v === 1 ? '1 indent' : `${Math.round(v)} indents`)}
                />
                {/*
                  On a 327px bar a thin segment loses its caption, so the phone
                  reader is left with a grey block and no idea which rung of the
                  ladder it is. These are the direct labels the bar could not
                  fit, moved below it — not a legend, and never a repeat of one
                  the bar already drew.
                */}
                {unlabelledBuckets.length > 0 ? (
                  <dl className="mt-2 grid grid-cols-2 gap-x-5 sm:hidden">
                    {unlabelledBuckets.map((b) => (
                      <div
                        key={b.label}
                        className="flex items-baseline justify-between gap-2 py-1"
                        style={{ borderBottom: '1px solid var(--border-subtle)' }}
                      >
                        <dt className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                          {b.label}
                        </dt>
                        <dd className="num text-[12px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {b.value === 1 ? '1 indent' : `${b.value} indents`}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </>
            )}
            <ChartCaption>
              Darker is older. A routine indent ageing past a day is a purchasing habit; a breakdown indent in
              that last bucket is a day of crushing the group never gets back.
            </ChartCaption>
          </div>
        </Section>

        <Section
          caption={groupBy === 'site' ? 'By requesting site' : 'By stores category'}
          title="Committed spend, and what is queued behind it"
          actions={<div className="hidden items-center gap-2 sm:flex">{groupChips}</div>}
        >
          <div className={stripClass}>{groupChips}</div>
          <div className="px-6">
            {/*
              The bar labels are drawn at a fixed 176px so a site name is never
              truncated. On a 327px phone that left 87px of plot, which is not a
              bar chart, it is a hint of one. So the chart keeps its real width
              and scrolls inside its own box — the page itself never moves
              sideways, and no site loses its name to fit.
            */}
            <div className="overflow-x-auto sm:overflow-x-visible">
              {/*
                The 12px inset is the overrun allowance. "Karapakkam Crusher ·
                stopped" measures 176px against a 166px label budget, so it
                reaches ten pixels left of where the chart starts. On a desk it
                bleeds harmlessly into the section gutter; inside a scroll box
                it would be shaved, and a site would silently lose the word that
                says it is stopped.
              */}
              <div className="min-w-[520px] pl-3 sm:min-w-0 sm:pl-0">
                <BarChart
                  barHeight={touch ? 40 : 22}
                  summary={
                    topGroup
                      ? `${topGroup.label} carries the most committed spend at ${formatINRCompact(topGroup.committed)}${
                          stoppedGroups.length > 0
                            ? `. ${stoppedGroups.map((g) => g.label).join(' and ')} ${
                                stoppedGroups.length === 1 ? 'has' : 'have'
                              } a breakdown indent still unapproved.`
                            : '.'
                        }`
                      : 'No indents in scope.'
                  }
                  data={spendBars}
                  format={(v) => formatINRCompact(v)}
                  labelWidth={groupBy === 'site' ? 176 : 148}
                  onSelect={(d) => pickGroup(d.label)}
                />
              </div>
            </div>
            <ChartCaption>
              The bar is money already approved or issued; the dashed tick is what is still sitting unapproved
              behind it. A short bar with a long tick is a desk that has stopped deciding, not a site that has
              stopped spending. Pick a bar to filter the queue below.
            </ChartCaption>
          </div>
        </Section>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={filter === 'open'} onClick={() => setFilter('open')} count={rows.filter(isOpen).length}>
          Open
        </Chip>
        <Chip active={filter === 'breakdown'} onClick={() => setFilter('breakdown')} count={rows.filter((r) => r.urgency === 'breakdown').length}>
          Breakdown
        </Chip>
        <Chip active={filter === 'below_reorder'} onClick={() => setFilter('below_reorder')} count={rows.filter((r) => r.stockOnHand < r.reorderLevel).length}>
          Below reorder level
        </Chip>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
          Everything
        </Chip>

        {groupFilterLabel ? (
          <Chip active onClick={() => setGroupFilter(null)}>
            {groupFilterLabel} — clear
          </Chip>
        ) : null}

        {!mayApprove ? (
          /* On a phone the strip has already wrapped, so `ml-auto` would only
             ragged-right a sentence that needs the whole line anyway. */
          <span
            className="font-serif w-full text-[13px] italic sm:ml-auto sm:w-auto"
            style={{ color: 'var(--text-tertiary)' }}
          >
            You can read this queue but not approve from it — {persona.roleLabel} does not hold stores.indent.approve.
          </span>
        ) : null}
      </div>

      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={visible}
          rowKey={(r) => r.id}
          selectedKey={selected}
          onRowClick={(r) => setSelected(r.id === selected ? undefined : r.id)}
          isDormant={(r) => r.stage === 'rejected'}
          rail={(r) => ({
            status: r.urgency === 'breakdown' && r.stage === 'submitted' ? 'critical' : STAGE_FAMILY[r.stage],
          })}
          empty={
            groupFilterLabel ? (
              <EmptyState
                fact={`Nothing matches ${groupFilterLabel} under this filter.`}
                because="The bar you clicked has indents, but none of them are in the stage you are looking at."
                action={{ label: 'Clear the site filter', onClick: () => setGroupFilter(null) }}
              />
            ) : (
              <EmptyState
                fact="Nothing is waiting in this queue."
                because="Every indent raised for this site has been approved, issued or closed."
                action={{ label: 'Show everything', onClick: () => setFilter('all') }}
              />
            )
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selectedRow !== undefined}
        onClose={() => setSelected(undefined)}
        title={selectedRow?.itemName ?? ''}
        identifier={selectedRow?.number}
        {...(selectedRow
          ? {
              status: {
                family: STAGE_FAMILY[selectedRow.stage],
                label: STAGE_LABEL[selectedRow.stage],
                ...(selectedRow.stage === 'submitted'
                  ? { severity: `+${Math.round(selectedRow.waited)}h` }
                  : {}),
              },
            }
          : {})}
        revision={
          selectedRow
            ? `RAISED ${selectedRow.raisedOn.slice(8, 10)}-${selectedRow.raisedOn.slice(5, 7)} ${selectedRow.raisedOn.slice(11, 16)}`
            : undefined
        }
        footer={
          selectedRow ? (
            mayApprove ? (
              /*
                The sheet footer is one fixed-height row that does not wrap. On
                a 375px panel "Mark issued from stores" plus its aside ran off
                the right edge, so the buttons are pinned at their natural width
                and the aside is allowed to shrink and set on two lines inside
                the same 56px band — the sentence stays, it just sets tighter.
              */
              selectedRow.stage === 'submitted' ? (
                <>
                  <Button className="shrink-0" variant="primary" onClick={() => setStage(selectedRow.id, 'approved')}>
                    Approve
                  </Button>
                  <Button className="shrink-0" variant="destructive" onClick={() => setConfirmReject(selectedRow.id)}>
                    Reject
                  </Button>
                  <span
                    className="font-serif ml-auto min-w-0 text-right text-[12px] italic leading-snug"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Waiting {formatWait(selectedRow.waited)}
                  </span>
                </>
              ) : selectedRow.stage === 'approved' ? (
                <>
                  <Button className="shrink-0" variant="primary" onClick={() => setStage(selectedRow.id, 'issued')}>
                    Mark issued from stores
                  </Button>
                  <span
                    className="font-serif ml-auto min-w-0 text-right text-[12px] italic leading-snug"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Approved — the gate is the counter now
                  </span>
                </>
              ) : (
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {STAGE_LABEL[selectedRow.stage]} — nothing further to do here.
                </span>
              )
            ) : (
              <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                Read-only — {persona.roleLabel} does not hold stores.indent.approve.
              </span>
            )
          ) : null
        }
      >
        {selectedRow ? <IndentDetail row={selectedRow} siblings={siblings} /> : null}
      </SideSheet>

      {/*
        Reject is the only irreversible move on this screen, and the consequence
        is not "a record changes state" — it is that a named crusher stays off
        until somebody re-raises the paperwork. On a breakdown line the operator
        types the indent number out, because that is a decision that should cost
        ten seconds of attention rather than one stray click.
      */}
      <ConfirmModal
        open={rejectRow !== undefined}
        onClose={() => setConfirmReject(null)}
        onConfirm={() => {
          if (rejectRow) setStage(rejectRow.id, 'rejected');
        }}
        title="Reject this indent"
        destructive
        confirmLabel="Reject the indent"
        {...(rejectRow?.urgency === 'breakdown' ? { confirmPhrase: rejectRow.number } : {})}
        consequence={
          rejectRow ? (
            <>
              {rejectRow.raisedBy} asked for {formatQty(rejectRow.quantity, 0)} {rejectRow.uom} of{' '}
              {rejectRow.itemName} against {rejectRow.forAsset ?? 'general stores'}, worth about{' '}
              {formatINR(rejectRow.estimatedValue)}.{' '}
              {rejectRow.urgency === 'breakdown'
                ? `${rejectRow.forAsset ?? 'The plant'} is stopped now and stays stopped — rejecting this does not restart it, it only takes it off your list. It has already been waiting ${formatWait(rejectRow.waited)}.`
                : rejectRow.stockOnHand === 0
                  ? `Nothing is on hand, so ${rejectRow.forAsset ?? 'the job'} waits until somebody raises this again.`
                  : `${formatQty(rejectRow.stockOnHand, 0)} ${rejectRow.uom} remain on hand, so nothing stops today — but the reorder level of ${formatQty(rejectRow.reorderLevel, 0)} stays breached.`}
            </>
          ) : null
        }
      />
    </>
  );
}

/**
 * The sheet. Everything the row could not say: who asked and how long ago, the
 * unit rate implied by the estimate, the stock position drawn against the
 * reorder level, and the plain consequence of leaving it alone.
 */
function IndentDetail({ row, siblings }: { row: Row; siblings: Row[] }) {
  const estimate = Number.parseFloat(row.estimatedValue);
  const unitRate = row.quantity > 0 ? estimate / row.quantity : null;

  return (
    <>
      <SheetSection caption="The request">
        <DetailGrid>
          <Detail label="Urgency">
            <StatusStamp status={URGENCY_FAMILY[row.urgency]} label={URGENCY_LABEL[row.urgency]} />
          </Detail>
          <Detail label="Raised by">{row.raisedBy}</Detail>
          <Detail label="Raised">
            {row.raisedOn.slice(8, 10)}-{row.raisedOn.slice(5, 7)} at {row.raisedOn.slice(11, 16)}
          </Detail>
          <Detail label="Waiting">{formatWait(row.waited)}</Detail>
          <Detail label="Site">{siteName(row.siteId)}</Detail>
          <Detail label="Stores category">{categoryOf(row.itemCode)}</Detail>
          <Detail label="Against" wide>
            {row.forAsset ?? 'General stores — not booked to an asset'}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Item and value">
        <DetailGrid>
          <Detail label="Item code">
            <IdCell>{row.itemCode}</IdCell>
          </Detail>
          <Detail label="Quantity wanted">
            <QuantityCell value={row.quantity} decimals={0} uom={row.uom} />
          </Detail>
          {/* An indent estimate is a storekeeper's guess against the last rate
              paid, not a quotation. It must never read as a committed price. */}
          <Detail label="Estimated value">
            <Provisional>
              <MoneyCell value={row.estimatedValue} accounting={false} />
            </Provisional>
          </Detail>
          <Detail label={`Implied rate per ${row.uom}`}>
            {unitRate === null ? '–' : <MoneyCell value={unitRate} accounting={false} decimals={0} />}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Stock against the reorder level">
        <TargetGauge
          value={row.stockOnHand}
          target={row.reorderLevel}
          height={52}
          label="On hand"
          format={(v) => `${formatQty(v, 0)} ${row.uom}`}
          summary={
            row.stockOnHand === 0
              ? `Nothing on hand against a reorder level of ${formatQty(row.reorderLevel, 0)} ${row.uom}.`
              : row.stockOnHand < row.reorderLevel
                ? `${formatQty(row.stockOnHand, 0)} ${row.uom} on hand against a reorder level of ${formatQty(row.reorderLevel, 0)} — short by ${formatQty(row.shortBy, 0)}.`
                : `${formatQty(row.stockOnHand, 0)} ${row.uom} on hand, above the reorder level of ${formatQty(row.reorderLevel, 0)}.`
          }
        />
        <ChartCaption>
          The upright mark is the reorder level, not a maximum. Stock sitting on it is already late — the level
          exists to be re-ordered at, not run down to.
        </ChartCaption>

        {/* Preserved verbatim from the old inline panel: the sentence that
            makes a storekeeper act rather than acknowledge. */}
        <div className="mt-3">
          <Note>
            {row.stockOnHand === 0
              ? `Nothing on hand. ${row.forAsset ?? 'The plant'} stays down until this is issued.`
              : row.stockOnHand < row.reorderLevel
                ? `${formatQty(row.stockOnHand, 0)} ${row.uom} on hand against a reorder level of ${formatQty(row.reorderLevel, 0)} — short by ${formatQty(row.shortBy, 0)}.`
                : `${formatQty(row.stockOnHand, 0)} ${row.uom} on hand, above the reorder level. This one can wait for a consolidated order.`}
          </Note>
        </div>
      </SheetSection>

      <SheetSection caption={`Also queued against this asset (${siblings.length})`}>
        {row.forAsset === null ? (
          <Note>Not booked to an asset, so there is nothing to consolidate it with.</Note>
        ) : siblings.length === 0 ? (
          <Note>This is the only indent standing against {row.forAsset}. Nothing to combine into one order.</Note>
        ) : (
          <ul className="text-[13px]">
            {siblings.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <span className="min-w-0">
                  <span className="font-id text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                    {s.number}
                  </span>
                  <span className="block truncate" style={{ color: 'var(--text-primary)' }}>
                    {s.itemName}
                  </span>
                </span>
                <span className="shrink-0">
                  <StatusStamp status={STAGE_FAMILY[s.stage]} label={STAGE_LABEL[s.stage]} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </SheetSection>

      <SheetSection caption="Where it stands">
        <Detail label="Stage">
          <StatusStamp status={STAGE_FAMILY[row.stage]} label={STAGE_LABEL[row.stage]} />
        </Detail>
        <Note>
          {row.stage === 'submitted'
            ? `Approval is the only thing between this line and the counter. It has been ${formatWait(row.waited)}.`
            : row.stage === 'approved'
              ? 'Approved. Nothing moves until stores physically issues it and books the movement against the asset.'
              : row.stage === 'issued'
                ? 'Issued from stores and booked against the asset. The cost lands in this month.'
                : 'Rejected. Nothing was issued, and the shortfall above is still a shortfall.'}
        </Note>
      </SheetSection>
    </>
  );
}

const columns: Column<Row>[] = [
  {
    key: 'number',
    header: 'Indent',
    type: 'id',
    sticky: true,
    width: 170,
    group: 'Request',
    render: (r) => <Stacked primary={<IdCell>{r.number}</IdCell>} secondary={r.raisedBy} />,
  },
  {
    key: 'urgency',
    header: 'Urgency',
    type: 'status',
    width: 140,
    group: 'Request',
    render: (r) =>
      r.urgency === 'breakdown' ? (
        <StatusStamp status="critical" label="Breakdown" />
      ) : r.urgency === 'urgent' ? (
        <StatusStamp status="attention" label="Urgent" />
      ) : (
        <StatusStamp status="pending" label="Routine" />
      ),
  },
  {
    key: 'waited',
    header: 'Waiting',
    width: 110,
    group: 'Request',
    render: (r) => (
      <span style={{ color: r.waited > 24 && r.stage === 'submitted' ? 'var(--status-attention)' : undefined }}>
        {formatWait(r.waited)}
      </span>
    ),
  },
  {
    key: 'item',
    header: 'Item',
    group: 'Item',
    render: (r) => <Stacked primary={r.itemName} secondary={r.itemCode} />,
  },
  {
    key: 'for',
    header: 'Against',
    group: 'Item',
    render: (r) => r.forAsset,
  },
  {
    key: 'qty',
    header: 'Wanted',
    type: 'num',
    width: 110,
    group: 'Quantity',
    render: (r) => <QuantityCell value={r.quantity} decimals={0} uom={r.uom} />,
  },
  {
    key: 'onhand',
    header: 'On hand',
    type: 'num',
    width: 110,
    group: 'Quantity',
    render: (r) => (
      // Zero on hand against a breakdown indent is the whole story of the row.
      <span style={{ color: r.stockOnHand === 0 ? 'var(--status-critical)' : r.stockOnHand < r.reorderLevel ? 'var(--status-attention)' : undefined }}>
        <QuantityCell value={r.stockOnHand} decimals={0} />
      </span>
    ),
  },
  {
    key: 'reorder',
    header: 'Reorder at',
    type: 'num',
    width: 110,
    group: 'Quantity',
    render: (r) => (
      <span style={{ color: 'var(--text-tertiary)' }}>
        <QuantityCell value={r.reorderLevel} decimals={0} />
      </span>
    ),
  },
  {
    key: 'value',
    header: 'Estimated',
    unit: '₹',
    type: 'money',
    width: 130,
    group: 'Money',
    render: (r) => <MoneyCell value={r.estimatedValue} />,
  },
  {
    key: 'stage',
    header: 'Stage',
    type: 'status',
    width: 170,
    group: 'Standing',
    render: (r) => <StatusStamp status={STAGE_FAMILY[r.stage]} label={STAGE_LABEL[r.stage]} />,
  },
];
