import { useMemo, useState } from 'react';
import { can, formatDateTime, formatINR, formatQty } from '@linck/domain';
import { indentsForSite, isIndentOpen, NOW, SITES, type Indent } from '@linck/mock';
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
  TileRow,
  useIsPhone,
  useIsTouch,
  type Column,
} from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useInrCompact } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { CATEGORY_CODES, indentWords, type CategoryCode } from './words.js';

const INDENT_VIEWS = ['open', 'fleet', 'all', 'breakdown', 'below_reorder'] as const;

/**
 * Material requests (the stores "indent queue").
 *
 * Stores is the smallest team and the one most likely to abandon a system that
 * asks too much, so this screen deliberately does one thing: show what has
 * been asked for, what it will cost, and whether the plant is standing still
 * waiting for it.
 *
 * The ordering rule is the whole design. A breakdown request is not a more
 * urgent routine request — it means a crusher or a tipper is stopped RIGHT NOW
 * and every hour it sits in this queue is production that does not happen. So
 * urgency sorts above age, and a breakdown line says what is stopped rather
 * than just saying "urgent".
 *
 * The two charts follow from that. The ageing bar answers "how long has the
 * plant been waiting on us", which is the only question this desk is actually
 * judged on. The spend bar answers the finance question sitting underneath it —
 * what has already been committed, and how much more is queued behind it.
 *
 * LIN-23: every word is in ./words.ts, in English and Tamil, and kept short.
 * The reasoning that used to be printed under the charts lives in these
 * comments instead: a routine request ageing past a day is a purchasing habit;
 * a breakdown request in that last bucket is a day of crushing the group never
 * gets back; a short spend bar with a long dashed tick is a desk that has
 * stopped deciding, not a site that has stopped spending.
 */

type Stage = Indent['status'];
type Words = (typeof indentWords)['en'];
type StageWords = (typeof statusWords)['en']['indent'];

const URGENCY_RANK: Record<Indent['urgency'], number> = { breakdown: 0, urgent: 1, routine: 2 };

const STAGE_FAMILY = {
  submitted: 'pending',
  approved: 'active',
  issued: 'ready',
  rejected: 'dormant',
} as const;

const URGENCY_FAMILY = {
  breakdown: 'critical',
  urgent: 'attention',
  routine: 'pending',
} as const;

/**
 * Item code prefixes carry the stores category. There is no category column in
 * the source, and inventing one would be a lie — but the coding scheme is real
 * and the storekeeper reads it that way every day. The code, not its word, is
 * the group key, so a chosen bar survives a switch of language.
 */
function categoryOf(itemCode: string): CategoryCode {
  const prefix = itemCode.slice(0, 2);
  return (CATEGORY_CODES as readonly string[]).includes(prefix) ? (prefix as CategoryCode) : 'other';
}

function siteName(siteId: string): string {
  return SITES.find((s) => s.id === siteId)?.name ?? siteId;
}

/** Hours a row has been sitting in this queue, against the fixed data clock. */
function waitedHours(indent: Indent): number {
  return (NOW.getTime() - Date.parse(indent.raisedOn)) / 3_600_000;
}

/** `08-08 12:42` — the sheet's corner line, where the year is implied. */
function shortDateTime(iso: string): string {
  const full = formatDateTime(iso);
  return `${full.slice(0, 5)} ${full.slice(11)}`;
}

/**
 * Upper edges of the waiting-time buckets, in hours. Ordered, and the later
 * ones are the ones that cost money. Their words are in ./words.ts, by position.
 */
const WAIT_BUCKET_UPTO = [4, 12, 24, Number.POSITIVE_INFINITY] as const;

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

/** The permission behind Approve. Kept on hover for the admin, never printed. */
const APPROVE_PERMISSION = 'stores.indent.approve';

export function IndentQueue() {
  const { persona, siteScope, density } = useApp();
  const t = useWords(indentWords);
  const inr = useInrCompact();
  const stageWord = useWords(statusWords).indent;
  // Bar rows are 22px on a mouse — a deliberate density choice — and 22px is
  // not a thumb target. Keyed to the pointer, not the screen: a weighbridge
  // terminal is a wide display that still gets fingers.
  const touch = useIsTouch();
  /**
   * On a phone a row becomes a card whose corner holds the urgency stamp, so
   * the stage goes under the request number, where it has the card's full
   * width. (The sheet needs no such help: on a phone its header sets the stamp
   * on its own row under the title.)
   */
  const phone = useIsPhone();
  const [overrides, setOverrides] = useState<Record<string, Stage>>({});
  const [filter, setFilter] = useViewParam(INDENT_VIEWS, 'open');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [lens, setLens] = useState<Lens>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('site');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  const mayApprove = can(persona.grants, APPROVE_PERMISSION, { siteId: siteScope });

  const rows = useMemo<Row[]>(() => {
    // Shared with the fleet board's count: a fleet requisition also shows at
    // the home site of the tipper it is for, not only where it was raised.
    return indentsForSite(siteScope)
      .map((indent) => ({
        ...indent,
        stage: overrides[indent.id] ?? indent.status,
        shortBy: Math.max(0, indent.reorderLevel - indent.stockOnHand),
        waited: waitedHours(indent),
      }))
      .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || Date.parse(a.raisedOn) - Date.parse(b.raisedOn));
  }, [siteScope, overrides]);

  const isOpen = (r: Row) => r.stage === 'submitted' || r.stage === 'approved';
  /** Same rule as the fleet board's "Open store requests" card, on the live stage. */
  const isFleetOpen = (r: Row) => r.requestedFor === 'fleet' && isIndentOpen({ ...r, status: r.stage });
  const groupKeyOf = (r: Row, by: GroupBy): string => (by === 'site' ? r.siteId : categoryOf(r.itemCode));

  const visible = useMemo(() => {
    const byStage =
      filter === 'all'
        ? rows
        : filter === 'breakdown'
          ? rows.filter((r) => r.urgency === 'breakdown')
          : filter === 'below_reorder'
            ? rows.filter((r) => r.stockOnHand < r.reorderLevel)
            : filter === 'fleet'
              ? rows.filter(isFleetOpen)
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
      WAIT_BUCKET_UPTO.map((upto, i) => {
        const floor = i === 0 ? 0 : (WAIT_BUCKET_UPTO[i - 1] ?? 0);
        return { label: t.ageing.buckets[i] ?? '', value: ageingRows.filter((r) => r.waited >= floor && r.waited < upto).length };
      }),
    [ageingRows, t],
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
      const label = groupBy === 'site' ? siteName(r.siteId) : t.category[key as CategoryCode];
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
      .map((g) => ({ ...g, display: g.stopped ? t.spend.stopped(g.label) : g.label }))
      .sort((a, b) => b.committed - a.committed || b.awaiting - a.awaiting);
  }, [rows, groupBy, t]);

  const spendBars = groups.map((g) => ({
    label: g.display,
    value: g.committed,
    ...(g.awaiting > 0 ? { marker: g.awaiting } : {}),
    ...(g.stopped ? { tone: 'var(--status-critical)' } : {}),
  }));

  const topGroup = groups[0];
  const stoppedGroups = groups.filter((g) => g.stopped);

  const columns = useMemo(() => buildColumns(t, stageWord, phone), [t, stageWord, phone]);

  /* --- Selection, and the two things that mutate it --------------------- */

  // Read from `rows`, not `visible` — otherwise approving a request under the
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
   * Chip rows and section headers.
   *
   * A section header on a phone cannot hold its title and a row of chips on
   * the same line — the header is a `justify-between` flex, so the chips
   * either squash the title or push off the right edge. So the two grouping
   * chips are declared once and placed twice: in the header from `sm` up, and
   * below it as their own scrolling strip on a phone. Exactly one of the two
   * placements is ever rendered — the other is `display: none`, so nothing is
   * focusable twice and no state is duplicated.
   *
   * The four waiting-time chips are wider than half a desk in Tamil, so they
   * always ride in a strip under their title.
   */
  const lensChips = (
    <>
      <Chip active={lens === 'all'} onClick={() => setLens('all')}>
        {t.ageing.all}
      </Chip>
      <Chip active={lens === 'breakdown'} onClick={() => setLens('breakdown')}>
        {t.urgency.breakdown}
      </Chip>
      <Chip active={lens === 'urgent'} onClick={() => setLens('urgent')}>
        {t.urgency.urgent}
      </Chip>
      <Chip active={lens === 'routine'} onClick={() => setLens('routine')}>
        {t.urgency.routine}
      </Chip>
    </>
  );

  const groupChips = (
    <>
      <Chip active={groupBy === 'site'} onClick={() => changeGroupBy('site')}>
        {t.spend.bySite}
      </Chip>
      <Chip active={groupBy === 'category'} onClick={() => changeGroupBy('category')}>
        {t.spend.byType}
      </Chip>
    </>
  );

  /** The stage as the sheet shows it; a waiting request carries its hours. */
  const stageStamp = (row: Row) => ({
    family: STAGE_FAMILY[row.stage],
    label: stageWord[row.stage],
    ...(row.stage === 'submitted' ? { severity: t.sheet.waited(Math.round(row.waited)) } : {}),
  });
  const sheetStamp = selectedRow ? stageStamp(selectedRow) : undefined;

  /** Chips in a strip that scrolls rather than squashing. */
  const stripClass = 'flex gap-2 overflow-x-auto px-6 pb-3 sm:hidden [&>button]:shrink-0';
  const wideStripClass = 'flex gap-2 overflow-x-auto px-6 pb-3 [&>button]:shrink-0';

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        meta={<AsOfStamp asOf="14:42" source="v_indent_queue" freshness="live" />}
        actions={<Button variant="primary">{t.ask}</Button>}
      />

      {/*
        One tile per row below `sm`: two tiles across a phone leaves ~130px of
        measure, and a Tamil delta wraps to four lines in that. The separating
        hairline turns from a right edge into a bottom one so the stack still
        reads as a ruled panel.
      */}
      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <KpiTile
          eyebrow={t.tiles.waiting}
          hero
          value={String(awaiting.length)}
          delta={{
            text: t.tiles.worth(inr(awaitingValue)),
            ...(breakdownWaiting.length > 0 ? { tone: 'critical' as const } : {}),
          }}
          asOfInHeader
        />
        {/*
          The number that should make somebody get up from their desk. A
          breakdown request sitting in a queue is a stopped crusher or tipper,
          and the hours are the cost.
        */}
        <KpiTile
          eyebrow={t.tiles.breakdown}
          value={String(breakdownWaiting.length)}
          delta={{
            text: breakdownWaiting.length > 0 ? t.tiles.stopped : t.tiles.nothingStopped,
            ...(breakdownWaiting.length > 0 ? { tone: 'critical' as const } : {}),
          }}
          asOfInHeader
        />
        {/* Ageing is the control on this desk, not a blocked button — so past a
            day the tile says so, in the attention colour. */}
        <KpiTile
          eyebrow={t.tiles.oldest}
          value={t.age(oldestHours)}
          delta={oldestHours > 24 ? { text: t.tiles.late, tone: 'attention' } : undefined}
          asOfInHeader
        />
        <KpiTile
          eyebrow={t.tiles.approved}
          value={inr(committed)}
          delta={{ text: t.tiles.approvedNote }}
          asOfInHeader
        />
      </TileRow>

      {/*
        The outer inset goes on the two-column layout only. Below `sm` the
        wrapper padding stacked on top of the Section's own `px-6` cost 96px of
        a 375px screen and left the ageing bar drawn in a 279px trench, out of
        line with every other rule on the page.
      */}
      <div className="grid grid-cols-1 gap-x-8 px-0 pt-6 sm:px-6 xl:grid-cols-2">
        <Section caption={t.ageing.caption} title={t.ageing.title}>
          <div className={wideStripClass}>{lensChips}</div>
          <div className="px-6">
            {ageingRows.length === 0 ? (
              <p className="font-serif py-6 text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {t.ageing.none}
              </p>
            ) : (
              <>
                {/* Darker is older: later buckets sit later in the ramp. */}
                <AgeingBar
                  height={64}
                  summary={t.ageing.summary(ageingRows.length, overADay)}
                  buckets={ageingBuckets}
                  format={(v) => t.ageing.count(Math.round(v))}
                />
                {/*
                  On a 327px bar a thin segment loses its caption, so the phone
                  reader is left with a grey block and no idea which rung of the
                  ladder it is. These are the direct labels the bar could not
                  fit, moved below it — not a legend, and never a repeat of one
                  the bar already drew.
                */}
                {unlabelledBuckets.length > 0 ? (
                  <dl className="mt-2 grid grid-cols-1 sm:hidden">
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
                          {t.ageing.count(b.value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </>
            )}
          </div>
        </Section>

        <Section title={t.spend.title} actions={<div className="hidden items-center gap-2 sm:flex">{groupChips}</div>}>
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
                The 32px inset is the overrun allowance. "Karapakkam Crusher ·
                நிற்கிறது" measures about 195px against a 166px label budget, so
                it reaches thirty pixels left of where the chart starts. On a
                desk it bleeds harmlessly into the section gutter; inside a
                scroll box it would be shaved, and a site would silently lose
                the word that says it is stopped.
              */}
              <div className="min-w-[520px] pl-8 sm:min-w-0 sm:pl-0">
                <BarChart
                  barHeight={touch ? 40 : 22}
                  summary={
                    topGroup
                      ? t.spend.summary(
                          topGroup.label,
                          inr(topGroup.committed),
                          stoppedGroups.map((g) => g.label),
                        )
                      : t.spend.none
                  }
                  data={spendBars}
                  format={inr}
                  labelWidth={groupBy === 'site' ? 176 : 148}
                  onSelect={(d) => pickGroup(d.label)}
                />
              </div>
            </div>
            <ChartCaption>{t.spend.legend}</ChartCaption>
          </div>
        </Section>
      </div>

      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={filter === 'open'} onClick={() => setFilter('open')} count={rows.filter(isOpen).length}>
          {t.filters.open}
        </Chip>
        <Chip active={filter === 'fleet'} onClick={() => setFilter('fleet')} count={rows.filter(isFleetOpen).length}>
          {t.filters.fleet}
        </Chip>
        <Chip active={filter === 'breakdown'} onClick={() => setFilter('breakdown')} count={rows.filter((r) => r.urgency === 'breakdown').length}>
          {t.filters.breakdown}
        </Chip>
        <Chip active={filter === 'below_reorder'} onClick={() => setFilter('below_reorder')} count={rows.filter((r) => r.stockOnHand < r.reorderLevel).length}>
          {t.filters.low}
        </Chip>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
          {t.filters.all}
        </Chip>

        {groupFilterLabel ? (
          <Chip active onClick={() => setGroupFilter(null)}>
            {groupFilterLabel}
            <span aria-hidden="true">✕</span>
            <span className="sr-only">{t.filters.clear}</span>
          </Chip>
        ) : null}

        {!mayApprove ? (
          /* On a phone the strip has already wrapped, so `ml-auto` would only
             ragged-right a sentence that needs the whole line anyway. */
          <span
            className="font-serif w-full text-[13px] italic sm:ml-auto sm:w-auto"
            style={{ color: 'var(--text-tertiary)' }}
            title={APPROVE_PERMISSION}
          >
            {t.viewOnly}
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
                fact={t.empty.group(groupFilterLabel)}
                action={{ label: groupBy === 'site' ? t.empty.allSites : t.empty.allTypes, onClick: () => setGroupFilter(null) }}
              />
            ) : (
              <EmptyState fact={t.empty.nothing} action={{ label: t.empty.showAll, onClick: () => setFilter('all') }} />
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
        status={sheetStamp}
        revision={selectedRow ? t.sheet.asked(shortDateTime(selectedRow.raisedOn)) : undefined}
        footer={
          selectedRow ? (
            mayApprove ? (
              /*
                The sheet footer is one fixed-height row that does not wrap, so
                the buttons are pinned at their natural width and the aside is
                allowed to shrink and set on two lines inside the same 56px band.
              */
              selectedRow.stage === 'submitted' ? (
                <>
                  <Button className="shrink-0" variant="primary" onClick={() => setStage(selectedRow.id, 'approved')}>
                    {t.sheet.approve}
                  </Button>
                  <Button className="shrink-0" variant="destructive" onClick={() => setConfirmReject(selectedRow.id)}>
                    {t.sheet.reject}
                  </Button>
                  <span
                    className="font-serif ml-auto min-w-0 text-right text-[12px] italic leading-snug"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {t.sheet.waiting(t.wait(selectedRow.waited))}
                  </span>
                </>
              ) : selectedRow.stage === 'approved' ? (
                // Approved: the gate is the counter now, so the one thing left
                // to do here is record that stores handed it over.
                <Button className="shrink-0" variant="primary" onClick={() => setStage(selectedRow.id, 'issued')}>
                  {t.sheet.markGiven}
                </Button>
              ) : (
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {t.sheet.done(stageWord[selectedRow.stage])}
                </span>
              )
            ) : (
              <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }} title={APPROVE_PERMISSION}>
                {t.sheet.viewOnly}
              </span>
            )
          ) : null
        }
      >
        {selectedRow ? <IndentDetail row={selectedRow} siblings={siblings} t={t} stageWord={stageWord} /> : null}
      </SideSheet>

      {/*
        Reject is the only irreversible move on this screen, and the consequence
        is not "a record changes state" — it is that a named crusher stays off
        until somebody asks again. On a breakdown line the operator types the
        request number out, because that is a decision that should cost ten
        seconds of attention rather than one stray click.
      */}
      <ConfirmModal
        open={rejectRow !== undefined}
        onClose={() => setConfirmReject(null)}
        onConfirm={() => {
          if (rejectRow) setStage(rejectRow.id, 'rejected');
        }}
        title={t.reject.title}
        destructive
        confirmLabel={t.reject.confirm}
        {...(rejectRow?.urgency === 'breakdown' ? { confirmPhrase: rejectRow.number } : {})}
        consequence={
          rejectRow ? (
            <>
              <p>
                {t.reject.asked(
                  rejectRow.raisedBy,
                  formatQty(rejectRow.quantity, 0),
                  rejectRow.uom,
                  rejectRow.itemName,
                  formatINR(rejectRow.estimatedValue, { decimals: 0 }),
                )}
              </p>
              {/* Rejecting a breakdown request does not restart anything; it
                  only takes the stoppage off this list. */}
              <p className="mt-2">
                {rejectRow.urgency === 'breakdown'
                  ? t.reject.stopped(rejectRow.forAsset)
                  : rejectRow.stockOnHand === 0
                    ? t.reject.noStock
                    : t.reject.inStock(formatQty(rejectRow.stockOnHand, 0), rejectRow.uom)}
              </p>
            </>
          ) : null
        }
      />
    </>
  );
}

/**
 * The sheet. Everything the row could not say: who asked and when, the unit
 * rate implied by the estimate, and the stock against its minimum with the one
 * line that makes a storekeeper act rather than acknowledge.
 */
function IndentDetail({ row, siblings, t, stageWord }: { row: Row; siblings: Row[]; t: Words; stageWord: StageWords }) {
  const estimate = Number.parseFloat(row.estimatedValue);
  const unitRate = row.quantity > 0 ? estimate / row.quantity : null;
  // Zero in stock against a breakdown request is the whole story of the row.
  const stockColor =
    row.stockOnHand === 0 ? 'var(--status-critical)' : row.stockOnHand < row.reorderLevel ? 'var(--status-attention)' : undefined;

  return (
    <>
      <SheetSection caption={t.sheet.request}>
        <DetailGrid>
          <Detail label={t.sheet.urgency}>
            <StatusStamp status={URGENCY_FAMILY[row.urgency]} label={t.urgency[row.urgency]} />
          </Detail>
          <Detail label={t.sheet.askedBy}>{row.raisedBy}</Detail>
          <Detail label={t.sheet.askedOn}>
            <span className="num tabular-nums">{formatDateTime(row.raisedOn)}</span>
          </Detail>
          <Detail label={t.sheet.waitingFor}>{t.wait(row.waited)}</Detail>
          <Detail label={t.sheet.site}>{siteName(row.siteId)}</Detail>
          <Detail label={t.sheet.type}>{t.category[categoryOf(row.itemCode)]}</Detail>
          <Detail label={t.sheet.for} wide>
            {row.forAsset ?? t.sheet.general}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={t.sheet.item}>
        <DetailGrid>
          <Detail label={t.sheet.itemCode}>
            <IdCell>{row.itemCode}</IdCell>
          </Detail>
          <Detail label={t.sheet.wanted}>
            <QuantityCell value={row.quantity} decimals={0} uom={row.uom} />
          </Detail>
          {/* A request's estimate is a storekeeper's guess against the last
              rate paid, not a quotation. It must never read as a committed price. */}
          <Detail label={t.sheet.estimate}>
            <Provisional by="person">
              <MoneyCell value={row.estimatedValue} accounting={false} />
            </Provisional>
          </Detail>
          <Detail label={t.sheet.rate(row.uom)}>
            {unitRate === null ? '–' : <MoneyCell value={unitRate} accounting={false} decimals={0} />}
          </Detail>
        </DetailGrid>
      </SheetSection>

      {/* The minimum is the reorder level, not a maximum: stock sitting on it is
          already late, because the level exists to be re-ordered at, not run
          down to. Figures rather than a gauge — the counts say it plainly. */}
      <SheetSection caption={t.sheet.stock}>
        <DetailGrid>
          <Detail label={t.sheet.inStock}>
            <span style={stockColor ? { color: stockColor } : undefined}>
              <QuantityCell value={row.stockOnHand} decimals={0} uom={row.uom} />
            </span>
          </Detail>
          <Detail label={t.sheet.minimum}>
            <QuantityCell value={row.reorderLevel} decimals={0} uom={row.uom} />
          </Detail>
          {row.shortBy > 0 ? (
            <Detail label={t.sheet.shortBy}>
              <span style={{ color: 'var(--status-attention)' }}>
                <QuantityCell value={row.shortBy} decimals={0} uom={row.uom} />
              </span>
            </Detail>
          ) : null}
        </DetailGrid>
        <div className="mt-2">
          <Note>
            {row.stockOnHand === 0
              ? t.sheet.noStock(row.forAsset)
              : row.stockOnHand < row.reorderLevel
                ? t.sheet.lowStock
                : t.sheet.enough}
          </Note>
        </div>
      </SheetSection>

      {/* Other requests for the same machine or vehicle, so they can go out as
          one order. A request booked to no asset has nothing to combine with. */}
      {row.forAsset !== null ? (
        <SheetSection caption={t.sheet.alsoFor(row.forAsset)}>
          {siblings.length === 0 ? (
            <Note>{t.sheet.noOthers}</Note>
          ) : (
            <ul className="text-[13px]">
              {siblings.map((s) => (
                // Stacked on a narrow sheet: the Tamil "waiting approval" stamp
                // alone is two thirds of a phone's width.
                <li
                  key={s.id}
                  className="flex flex-col items-start gap-1 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                  <span className="min-w-0 max-w-full">
                    <span className="font-id text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                      {s.number}
                    </span>
                    <span className="block truncate" style={{ color: 'var(--text-primary)' }}>
                      {s.itemName}
                    </span>
                  </span>
                  <span className="shrink-0">
                    <StatusStamp status={STAGE_FAMILY[s.stage]} label={stageWord[s.stage]} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SheetSection>
      ) : null}
    </>
  );
}

/**
 * The queue's columns.
 *
 * The stage sits beside the urgency, so a desk that cannot fit ten columns
 * still shows what is waiting without a sideways scroll; the minimum stock
 * rides under the stock figure it is read against, and the machine or vehicle
 * name may wrap. On a phone the row becomes a card whose corner stamp is the
 * urgency, and the stage goes under the request number, where it has the
 * card's full width (see `phone` in IndentQueue).
 */
function buildColumns(t: Words, stageWord: StageWords, phone: boolean): Column<Row>[] {
  const stage = (r: Row) => <StatusStamp status={STAGE_FAMILY[r.stage]} label={stageWord[r.stage]} />;
  return [
    {
      key: 'number',
      header: t.columns.request,
      type: 'id',
      sticky: true,
      width: 150,
      render: (r) =>
        phone ? (
          <>
            <Stacked primary={<IdCell>{r.number}</IdCell>} secondary={r.raisedBy} />
            <span className="mt-1.5 block font-sans">{stage(r)}</span>
          </>
        ) : (
          <Stacked primary={<IdCell>{r.number}</IdCell>} secondary={r.raisedBy} />
        ),
    },
    {
      key: 'urgency',
      header: t.columns.urgency,
      type: 'status',
      render: (r) => <StatusStamp status={URGENCY_FAMILY[r.urgency]} label={t.urgency[r.urgency]} />,
    },
    {
      key: 'stage',
      header: t.columns.status,
      type: 'status',
      // Null on a phone card: the stage is already under the request number.
      render: (r) => (phone ? null : stage(r)),
    },
    {
      key: 'waited',
      header: t.columns.waiting,
      render: (r) => (
        <span style={{ color: r.waited > 24 && r.stage === 'submitted' ? 'var(--status-attention)' : undefined }}>
          {t.wait(r.waited)}
        </span>
      ),
    },
    {
      key: 'item',
      header: t.columns.item,
      render: (r) => <Stacked primary={r.itemName} secondary={r.itemCode} />,
    },
    {
      key: 'for',
      header: t.columns.for,
      render: (r) => (r.forAsset ? <span className="inline-block min-w-[110px] whitespace-normal leading-tight">{r.forAsset}</span> : null),
    },
    {
      key: 'qty',
      header: t.columns.wanted,
      type: 'num',
      width: 90,
      render: (r) => <QuantityCell value={r.quantity} decimals={0} uom={r.uom} />,
    },
    {
      key: 'onhand',
      header: t.columns.inStock,
      type: 'num',
      width: 120,
      render: (r) => (
        <Stacked
          primary={
            // Zero in stock against a breakdown request is the whole story of the row.
            <span style={{ color: r.stockOnHand === 0 ? 'var(--status-critical)' : r.stockOnHand < r.reorderLevel ? 'var(--status-attention)' : undefined }}>
              <QuantityCell value={r.stockOnHand} decimals={0} />
            </span>
          }
          secondary={<span className="num tabular-nums">{t.columns.min(formatQty(r.reorderLevel, 0))}</span>}
        />
      ),
    },
    {
      key: 'value',
      header: t.columns.amount,
      unit: '₹',
      type: 'money',
      width: 120,
      render: (r) => <MoneyCell value={r.estimatedValue} />,
    },
  ];
}
