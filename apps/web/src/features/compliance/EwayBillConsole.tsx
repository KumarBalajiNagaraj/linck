import { useMemo, useState } from 'react';
import { formatDate, formatDateTime, formatINR } from '@linck/domain';
import {
  blockedGstinsFor,
  ewayBillsForSite,
  ewayBillSummary,
  ewbClock,
  ewbHeldByGstin,
  ewbThreshold,
  ewbValidityDays,
  EWB_CANCEL_WINDOW_HOURS,
  EWB_INTER_STATE_THRESHOLD,
  EWB_INTRA_STATE_THRESHOLD,
  EWB_KM_PER_DAY,
  EWB_ODC_KM_PER_DAY,
  EWB_PART_A_WINDOW_DAYS,
  EWB_PART_B_EXEMPT_KM,
  formatEwbNumber,
  GST_STATE_ABBR,
  GST_STATE_NAMES,
  gstinStanding,
  NOW,
  vehiclesForSite,
  type EwayBill,
  type EwbClock,
  type EwbStanding,
} from '@linck/mock';
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
  Modal,
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
  useMinWidth,
  type Column,
} from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useInrCompact } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { complianceWords, ENGLISH_MONTH_NAMES, type ComplianceWords } from './words.js';

/**
 * THE E-WAY BILL CONSOLE.
 *
 * Inter-state movement is material for this business, and the border is where
 * the rules bite. Everything on this screen exists to keep four separate
 * facts from being smeared into one "compliance" colour:
 *
 *   1. THE THRESHOLD IS ASYMMETRIC. Inside Tamil Nadu no bill is owed below
 *      ₹1,00,000, so most tipper loads are legitimately paperwork-free — the
 *      screen must NOT read them as missing. Cross a border and the limit is
 *      ₹50,000, which almost every load clears. That asymmetry is carried by a
 *      labelled TYPE column, never by hue alone — and by the route chart,
 *      where the limit is a dashed tick sitting at two different places. The
 *      same tipper load can be paperwork-free at home and a detention risk an
 *      hour up the road; nothing about the material changed, only the border.
 *   2. PART A AND PART B ARE DIFFERENT DOCUMENTS. Part A is the consignment,
 *      Part B is the vehicle, and only Part B starts the validity clock. Part
 *      A stands alone for 15 days waiting for a vehicle number and then dies
 *      quietly. That clock is surfaced, because nothing on the portal shouts
 *      when it runs out.
 *   3. A BLANK PART B IS NOT ALWAYS A FAILURE. Under 50 km in the same state,
 *      consignor to transporter, it is simply not required (Rule 138(3)).
 *   4. RULE 138E IS NOT A ROW ERROR. Two unfiled GSTR-3B periods and the
 *      portal refuses to generate anything on that GSTIN — every tipper in the
 *      yard stops at once. It belongs to the registration, in a banner, not
 *      repeated forty times down a column.
 *
 * Every word on the screen is in ./words.ts, in English and Tamil (LIN-23). A
 * consignment is a "load" on screen, as everywhere else in the product. The
 * clock's own `label` and `severity` from @linck/mock are English, so the
 * screen words them from the clock's numbers instead.
 */

type Filter = 'all' | 'inter' | 'pending' | 'expiring' | 'dead' | 'blocked' | 'exempt';

interface Row {
  bill: EwayBill;
  clock: EwbClock;
  /** Part B keyed in this session — asserted here, not yet acknowledged by the portal. */
  keyed: boolean;
  /** Cancelled from this console in this session. Same caveat. */
  voided: boolean;
}

/** Worst first. An expired bill on the road outranks everything else on screen. */
const RANK: Record<EwbStanding, number> = {
  expired: 0,
  part_a_lapsed: 1,
  blocked: 2,
  expiring: 3,
  to_generate: 4,
  part_b_pending: 5,
  active: 6,
  cancelled: 7,
  not_required: 8,
};

const HOUR_MS = 3_600_000;

/** The shape a registration takes on the portal: no spaces, no dashes. */
const PLATE_EXAMPLE = 'TN29AB1015';

/**
 * The reason the record carries when a bill is cancelled from this console —
 * what the portal is told. It is data on the record; the screen shows its own
 * words for a bill cancelled here (see `say.cancelledHere`).
 */
const CONSOLE_CANCEL_REASON = 'Cancelled from the console inside the 24-hour window';

export function EwayBillConsole() {
  const { siteScope, density } = useApp();
  const t = useWords(complianceWords);
  const inr = useInrCompact();
  const standingWords = useWords(statusWords).ewb;
  const w = t.ewb;
  const [filter, setFilter] = useState<Filter>('all');
  const [lane, setLane] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /** Demo-local Part B ledger. Nothing persists; it exists to start the clock. */
  const [partB, setPartB] = useState<Record<string, string>>({});
  /** Demo-local cancellations, keyed by bill id, value is the stated reason. */
  const [voided, setVoided] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  /**
   * The route chart reserves its label gutter in real pixels, so the gutter is
   * a render decision rather than a stylesheet one: 140px of it on a phone
   * leaves the bars about a centimetre long. The labels are short — "TN → KA
   * (7)" — so a narrow gutter costs nothing and gives the bars room to be
   * read. The same flag compacts the money: four ticks of ₹1,00,000 across
   * 180px of axis run into each other and print as one smear, where ₹1.00 L
   * does not. The full figures stay in the chart summary.
   */
  const wideLabels = useMinWidth('sm');
  const columns = useMemo(() => makeColumns(t, standingWords), [t, standingWords]);

  const base = ewayBillsForSite(siteScope);

  const all = useMemo<Row[]>(() => {
    return base
      .map<Row>((bill) => {
        const keyedVehicle = partB[bill.id];
        const voidedReason = voided[bill.id];
        // The optimistic row goes through the SAME derivation as a portal row:
        // entering Part B is what starts the validity clock, so the object is
        // rewritten and re-clocked rather than special-cased downstream. A
        // cancellation keyed here is folded in the same way, which is why the
        // tiles and the standing chart move the instant the modal is confirmed.
        let resolved: EwayBill = bill;
        if (keyedVehicle && bill.stage === 'part_a_only') {
          resolved = {
            ...resolved,
            stage: 'active',
            partBVehicle: keyedVehicle,
            partBEnteredAt: NOW.toISOString(),
          };
        }
        if (voidedReason) {
          resolved = {
            ...resolved,
            stage: 'cancelled',
            cancelledAt: NOW.toISOString(),
            cancelReason: voidedReason,
          };
        }
        return {
          bill: resolved,
          clock: ewbClock(resolved, NOW),
          keyed: Boolean(keyedVehicle),
          voided: Boolean(voidedReason),
        };
      })
      .sort(
        (a, b) =>
          RANK[a.clock.standing] - RANK[b.clock.standing] ||
          (a.clock.msLeft ?? 0) - (b.clock.msLeft ?? 0) ||
          Number.parseFloat(b.bill.consignmentValue) - Number.parseFloat(a.bill.consignmentValue),
      );
  }, [base, partB, voided]);

  const summary = useMemo(() => ewayBillSummary(all.map((r) => r.bill), NOW), [all]);
  const blocked = useMemo(() => blockedGstinsFor(all.map((r) => r.bill)), [all]);

  /** One count per standing, for the proportion bar. Derived, never stored. */
  const tally = useMemo(() => {
    const n = (s: EwbStanding) => all.filter((r) => r.clock.standing === s).length;
    return {
      active: n('active'),
      partBPending: n('part_b_pending'),
      expiring: n('expiring'),
      dead: n('expired') + n('part_a_lapsed'),
      cancelled: n('cancelled'),
      cannotRaise: n('blocked') + n('to_generate'),
      notRequired: n('not_required'),
    };
  }, [all]);

  /**
   * Consignment value by lane, averaged.
   *
   * Averaged rather than summed on purpose: the threshold is a per-consignment
   * test, so a summed bar and a per-consignment tick would be two different
   * units drawn against one axis, which is the fastest way to make a chart lie.
   */
  const lanes = useMemo(() => {
    const map = new Map<
      string,
      { key: string; from: string; to: string; movement: 'intra_state' | 'inter_state'; total: number; count: number }
    >();
    for (const r of all) {
      const key = laneKey(r.bill);
      const entry = map.get(key) ?? {
        key,
        from: r.bill.fromStateCode,
        to: r.bill.toStateCode,
        movement: r.bill.movement,
        total: 0,
        count: 0,
      };
      entry.total += Number.parseFloat(r.bill.consignmentValue);
      entry.count += 1;
      map.set(key, entry);
    }
    return [...map.values()]
      .map((e) => ({
        ...e,
        average: e.total / e.count,
        threshold: e.movement === 'inter_state' ? EWB_INTER_STATE_THRESHOLD : EWB_INTRA_STATE_THRESHOLD,
      }))
      .sort((a, b) => b.average - a.average);
  }, [all]);

  const rows = useMemo(() => {
    const byStanding = (() => {
      switch (filter) {
        case 'inter':
          return all.filter((r) => r.bill.movement === 'inter_state');
        case 'pending':
          return all.filter((r) => r.clock.standing === 'part_b_pending');
        case 'expiring':
          return all.filter((r) => r.clock.standing === 'expiring');
        case 'dead':
          return all.filter((r) => r.clock.standing === 'expired' || r.clock.standing === 'part_a_lapsed');
        case 'blocked':
          return all.filter((r) => r.clock.standing === 'blocked' || r.clock.standing === 'to_generate');
        case 'exempt':
          return all.filter((r) => r.clock.standing === 'not_required');
        default:
          return all;
      }
    })();
    return lane === null ? byStanding : byStanding.filter((r) => laneKey(r.bill) === lane);
  }, [all, filter, lane]);

  const current = all.find((r) => r.bill.id === selected);
  const history = useMemo(
    () =>
      current
        ? all
            .filter((r) => r.bill.tripNumber === current.bill.tripNumber)
            .sort((a, b) => a.bill.attempt - b.bill.attempt)
        : [],
    [all, current],
  );
  const fleet = vehiclesForSite(siteScope);
  const window_ = current ? cancelWindow(current.bill, NOW) : null;
  const currentSeverity = current ? severityOf(current, t) : undefined;

  const clearFilters = () => {
    setFilter('all');
    setLane(null);
  };

  const inter = formatINR(EWB_INTER_STATE_THRESHOLD, { decimals: 0 });
  const intra = formatINR(EWB_INTRA_STATE_THRESHOLD, { decimals: 0 });

  return (
    <>
      <PageHeader
        eyebrow={t.common.eyebrow}
        title={w.title}
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source={w.source} freshness="live" />
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {w.interLine(summary.interState, inter)}
            </span>
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {w.intraLine(summary.intraState, intra)}
            </span>
          </span>
        }
      />

      {/* Rule 138E stops the whole yard, so it is stated once, against the
          registration it belongs to — never as forty identical row errors.
          Filing the return lifts the block; nothing on this screen can. */}
      {blocked.length > 0 ? (
        <div className="flex flex-col gap-2 px-6 pt-4">
          {blocked.map((g) => {
            const held = ewbHeldByGstin(
              all.map((r) => r.bill),
              g.gstin,
            );
            const value = held.reduce((s, b) => s + Number.parseFloat(b.consignmentValue), 0);
            return (
              <div
                key={g.gstin}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3"
                style={{
                  background: 'var(--surface)',
                  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                  borderLeft: '3px solid var(--status-critical)',
                  borderRadius: 'var(--r-2)',
                }}
              >
                <StatusStamp status="critical" label={standingWords.blocked} severity={held.length} />
                <span className="text-[14px]" style={{ color: 'var(--text-primary)' }}>
                  <IdCell>{g.gstin}</IdCell> — {w.banner.cannotMake(g.legalEntityName)}
                </span>
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {w.banner.notFiled(g.missedReturnPeriods.map((p) => periodWords(p, t)).join(', '))}
                </span>
                <span className="w-full font-serif text-[13px] italic" style={{ color: 'var(--status-critical)' }}>
                  {w.banner.held(held.length, formatINR(value, { decimals: 0 }))}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* One tile per row on a phone: at half of 375px the Tamil eyebrows and
          deltas wrap to four lines under a number, which reads as noise
          rather than a figure. */}
      <TileRow className="mt-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-r [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0">
        <KpiTile
          eyebrow={w.kpi.valid}
          hero
          value={String(summary.inForce)}
          delta={{ text: w.kpi.toOther(summary.interStateInForce) }}
          asOfInHeader
        />
        {/* Part A stands 15 days without a vehicle number, then dies. */}
        <KpiTile
          eyebrow={standingWords.part_b_pending}
          value={String(summary.partBPending)}
          delta={
            summary.partBTightestDaysLeft === null
              ? undefined
              : {
                  text: w.kpi.addWithin(summary.partBTightestDaysLeft),
                  tone: summary.partBTightestDaysLeft <= 3 ? 'attention' : 'neutral',
                }
          }
          asOfInHeader
        />
        {/* An extension can be filed 8 hours either side of expiry, and only
            while the vehicle is still on the road. */}
        <KpiTile
          eyebrow={w.kpi.expiring}
          value={String(summary.expiring)}
          delta={{
            text: w.kpi.alreadyExpired(summary.expired),
            tone: summary.expired > 0 ? 'critical' : summary.expiring > 0 ? 'attention' : 'neutral',
          }}
          asOfInHeader
        />
        <KpiTile
          eyebrow={w.kpi.blocked}
          value={String(blocked.length)}
          delta={{
            text: blocked.length === 0 ? w.kpi.allFiled : w.kpi.cannotGetBill(summary.blocked),
            tone: blocked.length > 0 ? 'critical' : 'neutral',
          }}
          asOfInHeader
        />
      </TileRow>

      <div className="grid grid-cols-1 xl:grid-cols-2">
        <Section title={w.standing.title}>
          <div className="px-6">
            <ProportionBar
              summary={w.standing.summary({
                all: all.length,
                valid: tally.active + tally.expiring,
                noVehicle: tally.partBPending,
                dead: tally.dead,
                notMade: tally.cannotRaise,
                notNeeded: tally.notRequired,
              })}
              segments={[
                { label: standingWords.active, value: tally.active, tone: 'var(--chart-2)' },
                { label: standingWords.part_b_pending, value: tally.partBPending, tone: 'var(--chart-3)' },
                { label: standingWords.expiring, value: tally.expiring, tone: 'var(--status-attention)' },
                { label: w.groups.dead, value: tally.dead, tone: 'var(--status-critical)' },
                { label: standingWords.cancelled, value: tally.cancelled, tone: 'var(--chart-5)' },
                { label: w.groups.notMade, value: tally.cannotRaise, tone: 'var(--status-critical)' },
                { label: standingWords.not_required, value: tally.notRequired, tone: 'var(--chart-4)' },
              ].filter((s) => s.value > 0)}
            />
            {/* A fat "not needed" band is not a filing backlog — it is the
                intra-Tamil Nadu exemption doing its job on short local loads.
                Only the coloured bands cost anything at a check post. */}
            <ChartCaption>{w.standing.notNeededOk(standingWords.not_required)}</ChartCaption>
          </div>
        </Section>

        <Section title={w.lanes.title}>
          <div className="px-6">
            {/* Every route that leaves the state sits under a tick half the
                height of the one that stays inside it. */}
            <BarChart
              summary={w.lanes.summary(inter, intra)}
              data={lanes.map((e) => ({
                label: laneLabel(e.from, e.to, e.count),
                value: Math.round(e.average),
                marker: e.threshold,
                ...(lane === e.key ? { tone: 'var(--chart-1)' } : {}),
              }))}
              format={(v) => (wideLabels ? formatINR(v, { decimals: 0 }) : inr(v))}
              labelWidth={wideLabels ? 140 : 84}
              onSelect={(d) => {
                const hit = lanes.find((e) => laneLabel(e.from, e.to, e.count) === d.label);
                if (hit) setLane(hit.key === lane ? null : hit.key);
              }}
            />
            <ChartCaption>{w.lanes.caption}</ChartCaption>
          </div>
        </Section>
      </div>

      <div
        className="mt-7 flex flex-wrap items-center gap-2 px-6 py-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={all.length}>
          {t.common.all}
        </Chip>
        <Chip active={filter === 'inter'} onClick={() => setFilter('inter')} count={summary.interState}>
          {w.otherState}
        </Chip>
        <Chip active={filter === 'pending'} onClick={() => setFilter('pending')} count={summary.partBPending}>
          {standingWords.part_b_pending}
        </Chip>
        <Chip active={filter === 'expiring'} onClick={() => setFilter('expiring')} count={summary.expiring}>
          {standingWords.expiring}
        </Chip>
        <Chip active={filter === 'dead'} onClick={() => setFilter('dead')} count={summary.expired + summary.partALapsed}>
          {w.groups.dead}
        </Chip>
        <Chip active={filter === 'blocked'} onClick={() => setFilter('blocked')} count={summary.blocked}>
          {w.groups.notMade}
        </Chip>
        <Chip active={filter === 'exempt'} onClick={() => setFilter('exempt')} count={summary.notRequired}>
          {standingWords.not_required}
        </Chip>
        {lane === null ? null : (
          <Chip active onClick={() => setLane(null)}>
            {w.lanes.chip(laneWords(lane))}
            <span className="num tabular-nums opacity-70">{rows.length}</span>
            <span aria-hidden="true">×</span>
          </Chip>
        )}
      </div>

      <Section title={w.loads}>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.bill.id}
          selectedKey={selected}
          onRowClick={(r) => setSelected(r.bill.id)}
          isDormant={(r) => r.clock.standing === 'cancelled' || r.clock.standing === 'not_required'}
          rail={(r) => ({
            status: r.clock.family,
            provenance: 'human',
            ...(r.clock.fillRatio === null ? {} : { fillRatio: r.clock.fillRatio }),
          })}
          // Either nothing here needs a bill today, or the filter is narrower
          // than the day's dispatch — one button answers both.
          empty={<EmptyState fact={w.empty} action={{ label: t.common.showAll, onClick: clearFilters }} />}
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={current !== undefined}
        // Escape reaches the sheet and the cancel dialogue together, and the
        // sheet closing unmounts the dialogue before its own handler runs — so
        // the flag is cleared here, or the next bill opened would arrive with
        // its cancel dialogue already up.
        onClose={() => {
          setSelected(undefined);
          setCancelOpen(false);
        }}
        width="form"
        title={current?.bill.customerName ?? ''}
        identifier={
          current ? (formatEwbNumber(current.bill.ewbNumber) ?? `${current.bill.invoiceNumber} · ${w.notMade}`) : undefined
        }
        {...(current
          ? {
              status: {
                family: current.clock.family,
                label: standingWords[current.clock.standing],
                ...(currentSeverity === undefined ? {} : { severity: currentSeverity }),
                ...(current.keyed || current.voided ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={current ? revisionOf(current.bill, t) : undefined}
        footer={
          current && window_ && isCancellable(current.bill) ? (
            <>
              <Button variant="destructive" className="shrink-0" onClick={() => setCancelOpen(true)}>
                {w.sheet.cancel}
              </Button>
              {/* The footer bar is one fixed-height row, so the window is
                  stated in one short line that fits beside the button on a
                  375px sheet as well as on a desk. */}
              <span
                className="font-serif text-[12px] italic leading-snug sm:text-[13px]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {window_.open ? w.sheet.cancelLeft(t.common.span(window_.msLeft)) : w.sheet.cancelOver}
              </span>
            </>
          ) : undefined
        }
      >
        {current ? (
          <ConsignmentDetail
            row={current}
            history={history}
            fleet={fleet.map((v) => ({ reg: v.registrationNumber, label: v.displayReg, model: v.model }))}
            draft={draft}
            onDraft={setDraft}
            onEnter={(vehicle) => {
              setPartB((s) => ({ ...s, [current.bill.id]: vehicle }));
              setDraft('');
            }}
            onUndo={() =>
              setPartB((s) => {
                const next = { ...s };
                delete next[current.bill.id];
                return next;
              })
            }
          />
        ) : null}
      </SideSheet>

      {/* Cancellation is legal for 24 hours after generation and not one minute
          longer, so the console offers two different dialogues rather than one
          that pretends the rule is negotiable. Cancelling voids the number for
          the trip: the load cannot move on it afterwards, and a fresh bill is
          raised as the next attempt. The invoice is not touched. */}
      {current && window_ && window_.open ? (
        <ConfirmModal
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          onConfirm={() =>
            setVoided((s) => ({
              ...s,
              [current.bill.id]: CONSOLE_CANCEL_REASON,
            }))
          }
          title={w.sheet.confirm.title(formatEwbNumber(current.bill.ewbNumber) ?? current.bill.invoiceNumber)}
          destructive
          confirmLabel={w.sheet.confirm.yes}
          {...(current.bill.ewbNumber === null ? {} : { confirmPhrase: current.bill.ewbNumber })}
          consequence={
            <>
              <p>
                {w.sheet.confirm.made(formatDateTime(current.bill.generatedAt))}{' '}
                {w.sheet.confirm.canCancelFor(t.common.span(window_.msLeft))}
              </p>
              <p className="mt-2">{w.sheet.confirm.after}</p>
              <p className="mt-2">{w.sheet.confirm.invoiceStays(current.bill.invoiceNumber)}</p>
            </>
          }
        />
      ) : current && window_ ? (
        // The portal refuses a late cancellation, and so does this console.
        // What is left is the accounting route: let the bill run out, settle
        // with a credit note, and raise fresh papers for whatever moved.
        <Modal
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          title={w.sheet.tooLate.title}
          footer={<Button onClick={() => setCancelOpen(false)}>{t.common.ok}</Button>}
        >
          <p className="font-serif text-[14px] italic" style={{ color: 'var(--text-primary)' }}>
            {w.sheet.tooLate.made(formatEwbNumber(current.bill.ewbNumber) ?? '', formatDateTime(current.bill.generatedAt))}{' '}
            {w.sheet.tooLate.rule(EWB_CANCEL_WINDOW_HOURS)}
          </p>
          <p className="mt-3 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
            {w.sheet.tooLate.next(current.bill.invoiceNumber)}
          </p>
        </Modal>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------- sheet */

/**
 * The consignment, opened.
 *
 * Everything the row could not say: the limit this movement lives under and how
 * much room is left against it, both clocks drawn rather than described, and the
 * generation history — which is the only place a cancel-and-regenerate stops
 * looking like two unrelated bills against one trip.
 */
function ConsignmentDetail({
  row,
  history,
  fleet,
  draft,
  onDraft,
  onEnter,
  onUndo,
}: {
  row: Row;
  history: Row[];
  fleet: { reg: string; label: string; model: string }[];
  draft: string;
  onDraft: (v: string) => void;
  onEnter: (vehicle: string) => void;
  onUndo: () => void;
}) {
  const t = useWords(complianceWords);
  const standingWords = useWords(statusWords).ewb;
  const w = t.ewb;
  const s = w.sheet;
  const L = s.labels;
  const { bill, clock, keyed } = row;
  const value = Number.parseFloat(bill.consignmentValue);
  const threshold = ewbThreshold(bill);
  const headroom = threshold - value;
  const supplier = gstinStanding(bill.supplierGstin);
  const interCompany = bill.transporterGstin !== null && bill.transporterGstin !== bill.supplierGstin;

  return (
    <>
      <SheetSection caption={t.common.note}>
        <Note>{consequence(row, t)}</Note>
      </SheetSection>

      <SheetSection caption={s.bill}>
        <DetailGrid>
          <Detail label={L.invoice}>
            <IdCell>{bill.invoiceNumber}</IdCell>
          </Detail>
          <Detail label={L.trip}>
            <IdCell>{bill.tripNumber}</IdCell>
          </Detail>
          <Detail label={L.invoiceDate}>{formatDate(bill.documentDate)}</Detail>
          <Detail label={L.madeOn}>{bill.generatedAt === null ? w.notMade : formatDateTime(bill.generatedAt)}</Detail>
          <Detail label={L.gstin} wide>
            <IdCell>{bill.supplierGstin}</IdCell>
            {supplier ? <span style={{ color: 'var(--text-secondary)' }}> · {supplier.legalEntityName}</span> : null}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={s.load}>
        <DetailGrid>
          <Detail label={L.customer} wide>
            {bill.customerName}
          </Detail>
          <Detail label={L.material}>
            {bill.productCode} · HSN <IdCell>{bill.hsnCode}</IdCell>
          </Detail>
          <Detail label={L.amount}>
            <MoneyCell value={bill.consignmentValue} accounting={false} decimals={0} />
          </Detail>
          <Detail label={L.limit}>
            <MoneyCell value={threshold} accounting={false} decimals={0} />
            <span style={{ color: 'var(--text-secondary)' }}>
              {' '}
              · {bill.movement === 'inter_state' ? s.toOtherStates : s.insideTamilNadu}
            </span>
          </Detail>
          {/* Inside Tamil Nadu the same load would face the ₹50,000 limit the
              moment it crossed into Karnataka. */}
          <Detail label={L.difference}>
            {headroom >= 0 ? (
              s.below(formatINR(headroom, { decimals: 0 }))
            ) : (
              <span style={{ color: 'var(--text-primary)' }}>{s.above(formatINR(Math.abs(headroom), { decimals: 0 }))}</span>
            )}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption={s.route}>
        <DetailGrid>
          <Detail label={L.from}>
            {bill.fromPlace}
            <span className="font-id" style={{ color: 'var(--text-tertiary)' }}>
              {' '}
              {bill.fromStateCode}
            </span>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>
              {GST_STATE_NAMES[bill.fromStateCode] ?? bill.fromStateCode}
            </span>
          </Detail>
          <Detail label={L.to}>
            {bill.toPlace}
            <span className="font-id" style={{ color: 'var(--text-tertiary)' }}>
              {' '}
              {bill.toStateCode}
            </span>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>
              {GST_STATE_NAMES[bill.toStateCode] ?? bill.toStateCode}
            </span>
          </Detail>
          <Detail label={L.type}>{bill.movement === 'inter_state' ? w.otherState : w.insideTn}</Detail>
          <Detail label={L.distance}>
            <QuantityCell value={bill.distanceKm} decimals={0} uom={t.common.km} />
          </Detail>
        </DetailGrid>
      </SheetSection>

      {clock.partADeadline !== null ? (
        <SheetSection caption={s.partAWindow}>
          <DetailGrid>
            <Detail label={L.endsAt}>{formatDateTime(clock.partADeadline)}</Detail>
            <Detail label={L.daysLeft}>
              {clock.partBDaysLeft === null
                ? '–'
                : clock.partBDaysLeft > 0
                  ? s.daysOf(clock.partBDaysLeft, EWB_PART_A_WINDOW_DAYS)
                  : standingWords.part_a_lapsed}
            </Detail>
          </DetailGrid>
          {clock.partBDaysLeft !== null && clock.partBDaysLeft > 0 ? (
            <div className="pt-1">
              <ProportionBar
                height={20}
                summary={s.windowSummary(clock.partBDaysLeft, EWB_PART_A_WINDOW_DAYS)}
                segments={[
                  {
                    label: s.used,
                    value: EWB_PART_A_WINDOW_DAYS - clock.partBDaysLeft,
                    tone: 'var(--chart-5)',
                  },
                  {
                    label: s.leftPart,
                    value: clock.partBDaysLeft,
                    tone: clock.partBDaysLeft <= 3 ? 'var(--status-attention)' : 'var(--chart-2)',
                  },
                ]}
              />
            </div>
          ) : (
            // The window ran out: this number can never be completed, so the
            // vehicle goes on a fresh bill, not on this one.
            <Note>{s.windowOver}</Note>
          )}

          {/* Entering Part B. The only write that changes the clock: a vehicle
              number turns a dormant Part A into a bill with validity running.
              Unspaced, because that is what the portal accepts, and hatched
              until the portal acknowledges it — keyed here is not filed there. */}
          {clock.standing === 'part_b_pending' ? (
            keyed ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {s.addedAs}
                </span>
                <Provisional confirmed={false} by="person">
                  <span className="font-id text-[13px]">{spacedReg(bill.partBVehicle ?? '')}</span>
                </Provisional>
                <Button onClick={onUndo}>{t.common.undo}</Button>
                <span className="w-full font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  {s.portalWaiting}
                </span>
              </div>
            ) : (
              <PartBEntry
                bill={bill}
                daysLeft={clock.partBDaysLeft}
                draft={draft}
                onDraft={onDraft}
                fleet={fleet}
                onEnter={onEnter}
              />
            )
          ) : null}
        </SheetSection>
      ) : null}

      <SheetSection caption={s.validity}>
        <DetailGrid>
          <Detail label={L.vehicle}>
            {bill.partBVehicle === null ? (
              bill.partBExemptUnder50km ? (
                <span style={{ color: 'var(--text-secondary)' }}>{w.notNeededKm(bill.distanceKm)}</span>
              ) : (
                '–'
              )
            ) : keyed ? (
              <Provisional confirmed={false} by="person">
                <span className="font-id">{spacedReg(bill.partBVehicle)}</span>
              </Provisional>
            ) : (
              <span className="font-id">{spacedReg(bill.partBVehicle)}</span>
            )}
          </Detail>
          <Detail label={L.transporter}>
            {bill.transporterName ?? '–'}
            {interCompany ? <span style={{ color: 'var(--text-secondary)' }}> · {w.otherCompany}</span> : null}
          </Detail>
          <Detail label={L.vehicleAdded}>
            {bill.partBEnteredAt === null ? '–' : formatDateTime(bill.partBEnteredAt)}
          </Detail>
          {/* One day per 200 km or part thereof; over-dimensional cargo — a
              plant move, not a tipper load — earns a day per 20 km. */}
          <Detail label={L.rule}>
            {s.rule(bill.overDimensional ? EWB_ODC_KM_PER_DAY : EWB_KM_PER_DAY, bill.overDimensional)}
          </Detail>
          <Detail label={L.daysGiven}>
            {clock.validityDays === null ? '–' : s.daysFor(clock.validityDays, bill.distanceKm)}
          </Detail>
          <Detail label={L.validTill}>{clock.validUntil === null ? '–' : formatDateTime(clock.validUntil)}</Detail>
          <Detail label={L.timeLeft} wide>
            {clock.msLeft === null ? (
              '–'
            ) : clock.msLeft <= 0 ? (
              <span style={{ color: 'var(--status-critical)' }}>{w.ago(t.common.span(clock.msLeft))}</span>
            ) : (
              <span
                style={{ color: clock.standing === 'expiring' ? 'var(--status-attention)' : 'var(--text-primary)' }}
              >
                {w.left(t.common.span(clock.msLeft))}
              </span>
            )}
          </Detail>
        </DetailGrid>

        {clock.fillRatio !== null && clock.validUntil !== null ? (
          <div className="pt-1">
            <ProportionBar
              height={20}
              summary={
                clock.msLeft !== null && clock.msLeft <= 0
                  ? s.validitySpent(t.common.span(clock.msLeft))
                  : s.validityLeft(Math.round(clock.fillRatio * 100))
              }
              segments={[
                { label: s.used, value: Math.max(0.001, 1 - clock.fillRatio), tone: 'var(--chart-5)' },
                {
                  label: s.leftPart,
                  value: clock.fillRatio,
                  tone:
                    clock.standing === 'expired'
                      ? 'var(--status-critical)'
                      : clock.standing === 'expiring'
                        ? 'var(--status-attention)'
                        : 'var(--chart-2)',
                },
              ]}
            />
          </div>
        ) : null}
      </SheetSection>

      <SheetSection caption={s.history}>
        {history.length <= 1 ? (
          // One attempt: nothing was cancelled and regenerated against this
          // trip, so this number is the only paper that ever existed for it.
          <Note>{s.onlyOne}</Note>
        ) : (
          <ul>
            {history.map((h) => {
              const severity = severityOf(h, t);
              return (
                <li
                  key={h.bill.id}
                  className="flex flex-col gap-1 px-2 py-2"
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    background: h.bill.id === bill.id ? 'var(--surface-selected)' : undefined,
                  }}
                >
                  <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                      {w.nth(h.bill.attempt)} ·{' '}
                      {h.bill.ewbNumber ? (
                        <IdCell>{formatEwbNumber(h.bill.ewbNumber)}</IdCell>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>{w.notMade}</span>
                      )}
                    </span>
                    <StatusStamp
                      status={h.clock.family}
                      label={standingWords[h.clock.standing]}
                      {...(severity === undefined ? {} : { severity })}
                      {...(h.keyed || h.voided ? { provisional: true } : {})}
                    />
                  </span>
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {s.made(formatDateTime(h.bill.generatedAt))}
                    {h.bill.cancelledAt === null ? '' : ` · ${s.cancelledAt(formatDateTime(h.bill.cancelledAt))}`}
                    {h.bill.partBVehicle === null ? '' : ` · ${spacedReg(h.bill.partBVehicle)}`}
                  </span>
                  {/* A reason somebody typed is shown as typed. */}
                  {h.voided ? <Note>{w.say.cancelledHere}</Note> : h.bill.cancelReason ? <Note>{h.bill.cancelReason}</Note> : null}
                </li>
              );
            })}
          </ul>
        )}
      </SheetSection>
    </>
  );
}

/**
 * The Part B input.
 *
 * The number goes in unspaced because that is what the portal accepts, and the
 * button stays disabled until the pattern is one a registration plate can
 * actually take — rejecting it after submission would mean losing the clock to
 * a typo. Spaces and dashes are stripped before the check, so the only fix
 * worth saying is the shape of a real number.
 */
function PartBEntry({
  bill,
  daysLeft,
  draft,
  onDraft,
  fleet,
  onEnter,
}: {
  bill: EwayBill;
  daysLeft: number | null;
  draft: string;
  onDraft: (v: string) => void;
  fleet: { reg: string; label: string; model: string }[];
  onEnter: (vehicle: string) => void;
}) {
  const t = useWords(complianceWords);
  const s = t.ewb.sheet;
  const cleaned = draft.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const valid = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/.test(cleaned);
  const wrong = draft !== '' && !valid;

  return (
    <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-3 sm:gap-y-2">
      {/* Full measure on a phone, 190px once there is a row to sit in. The
          height follows the same rule as Button: 44px where the pointer cannot
          hover, 38px on a desk. */}
      <label className="flex w-full flex-col gap-1 sm:w-[190px]">
        <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {s.vehicleNo}
        </span>
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          list="ewb-fleet"
          placeholder={PLATE_EXAMPLE}
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={wrong}
          className="font-id h-11 w-full px-2 text-[14px] uppercase [@media(hover:hover)]:h-[38px]"
          style={{
            background: 'var(--surface)',
            color: 'var(--text-primary)',
            boxShadow: `inset 0 0 0 1px ${wrong ? 'var(--status-attention)' : 'var(--border-strong)'}`,
            borderRadius: 'var(--r-1)',
          }}
        />
      </label>
      <datalist id="ewb-fleet">
        {fleet.map((v) => (
          <option key={v.reg} value={v.reg}>
            {v.label} · {v.model}
          </option>
        ))}
      </datalist>
      <Button variant="primary" disabled={!valid} onClick={() => onEnter(cleaned)} className="w-full sm:w-auto">
        {s.add}
      </Button>
      <span
        className="w-full font-serif text-[13px] italic"
        style={{ color: wrong ? 'var(--status-attention)' : 'var(--text-tertiary)' }}
      >
        {wrong
          ? s.typeLike(PLATE_EXAMPLE)
          : s.hint(daysLeft ?? 0, ewbValidityDays(bill.distanceKm, bill.overDimensional))}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- derivation */

function laneKey(bill: EwayBill): string {
  return `${bill.fromStateCode}>${bill.toStateCode}`;
}

function laneLabel(from: string, to: string, count: number): string {
  return `${GST_STATE_ABBR[from] ?? from} → ${GST_STATE_ABBR[to] ?? to} (${count})`;
}

function laneWords(key: string): string {
  const parts = key.split('>');
  const from = parts[0] ?? '';
  const to = parts[1] ?? '';
  return `${GST_STATE_ABBR[from] ?? from} → ${GST_STATE_ABBR[to] ?? to}`;
}

/** A bill that exists and has not already been withdrawn. */
function isCancellable(bill: EwayBill): boolean {
  return bill.ewbNumber !== null && (bill.stage === 'active' || bill.stage === 'part_a_only');
}

interface CancelWindow {
  open: boolean;
  /** Positive while the window is open, negative once it has shut. */
  msLeft: number;
}

/**
 * The 24-hour cancellation window, computed against the clock rather than read
 * off a flag — same reason the standings are derived. A bill raised at 03:34 is
 * cancellable this morning and not this evening, and no stored field survives
 * that.
 */
function cancelWindow(bill: EwayBill, now: Date): CancelWindow | null {
  if (!bill.generatedAt) return null;
  const closes = Date.parse(bill.generatedAt) + EWB_CANCEL_WINDOW_HOURS * HOUR_MS;
  return {
    open: now.getTime() < closes,
    msLeft: closes - now.getTime(),
  };
}

function spacedReg(reg: string): string {
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/.exec(reg);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : reg;
}

/** A return period as the data writes it ("May 2026"), in the reader's language. */
function periodWords(period: string, t: ComplianceWords): string {
  const m = /^([A-Za-z]+) (\d{4})$/.exec(period);
  const index = m ? ENGLISH_MONTH_NAMES.indexOf(m[1] ?? '') : -1;
  return m && index >= 0 ? t.common.monthLong(index, Number(m[2])) : period;
}

/** `2nd bill · 08-08-2026` under the sheet title. A first bill needs no number. */
function revisionOf(bill: EwayBill, t: ComplianceWords): string | undefined {
  const parts = [bill.attempt > 1 ? t.ewb.nth(bill.attempt) : null, bill.generatedAt ? formatDate(bill.generatedAt) : null].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The integer beside the status word, in the reader's language: days on the
 * Part A window, time left (or since) on a running bill, and how long after
 * it was raised a bill was cancelled. The same figures the clock carries.
 */
function severityOf(row: Row, t: ComplianceWords): string | undefined {
  const { bill, clock } = row;
  switch (clock.standing) {
    case 'part_b_pending':
    case 'part_a_lapsed':
      return clock.partBDaysLeft === null ? undefined : t.common.daysShort(Math.abs(clock.partBDaysLeft));
    case 'active':
    case 'expiring':
    case 'expired':
      return clock.msLeft === null ? undefined : t.common.span(clock.msLeft);
    case 'cancelled':
      return bill.cancelledAt && bill.generatedAt
        ? t.common.hours(Math.round((Date.parse(bill.cancelledAt) - Date.parse(bill.generatedAt)) / HOUR_MS))
        : undefined;
    default:
      return undefined;
  }
}

/**
 * What the row means, in the words the person at the check post would use.
 * Every standing gets a different sentence — an expired bill and a load that
 * never needed one are not the same fact and must never share copy.
 *
 * The why behind each, kept here: an expired bill on a moving load is
 * detention and penalty under section 129; an extension can be filed 8 hours
 * either side of expiry, only while the vehicle is in transit; a lapsed Part
 * A can never be completed; a 138E block lifts only when the returns are
 * filed.
 */
function consequence(row: Row, t: ComplianceWords): string {
  const { bill, clock } = row;
  const say = t.ewb.say;

  switch (clock.standing) {
    case 'not_required': {
      // Below the limit is the everyday case and is worded from the numbers.
      // Any other exemption is shown as it was recorded.
      const headroom = ewbThreshold(bill) - Number.parseFloat(bill.consignmentValue);
      if (headroom >= 0) return say.notNeeded;
      return bill.exemptReason ? `${say.notNeededShort} ${bill.exemptReason}` : say.notNeededShort;
    }
    case 'blocked':
      return say.blocked;
    case 'to_generate':
      return say.toMake;
    case 'part_b_pending':
      return say.addVehicle(clock.partBDaysLeft ?? 0);
    case 'part_a_lapsed':
      return say.lapsed;
    case 'active':
      return bill.partBExemptUnder50km ? say.under50(EWB_PART_B_EXEMPT_KM) : say.validTill(formatDateTime(clock.validUntil));
    case 'expiring':
      return say.endsSoon(formatDateTime(clock.validUntil));
    case 'expired':
      return say.expired;
    case 'cancelled':
      if (row.voided) return say.cancelledHere;
      return bill.cancelReason ? `${say.cancelled} ${bill.cancelReason}` : say.cancelled;
    default:
      return '';
  }
}

/* ----------------------------------------------------------------- columns */

/**
 * The console's columns, in the reader's language. No supra-header groups —
 * each header already names its column, and a second row of captions was a
 * second set of words to read before the first row of data.
 */
function makeColumns(t: ComplianceWords, standingWords: Record<EwbStanding, string>): Column<Row>[] {
  const w = t.ewb;
  return [
    {
      key: 'ewb',
      header: w.columns.number,
      type: 'id',
      sticky: true,
      width: 196,
      render: (r) => (
        <Stacked
          primary={
            r.bill.ewbNumber ? (
              <IdCell>{formatEwbNumber(r.bill.ewbNumber)}</IdCell>
            ) : (
              <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {w.notMade}
              </span>
            )
          }
          secondary={r.bill.generatedAt ? formatDate(r.bill.generatedAt) : formatDate(r.bill.documentDate)}
        />
      ),
    },
    {
      key: 'against',
      header: w.columns.invoice,
      width: 172,
      render: (r) => (
        <Stacked
          primary={<span className="font-id text-[12px]">{r.bill.invoiceNumber}</span>}
          secondary={r.bill.attempt > 1 ? `${r.bill.tripNumber} · ${w.nth(r.bill.attempt)}` : r.bill.tripNumber}
        />
      ),
    },
    {
      key: 'customer',
      header: w.columns.customer,
      width: 216,
      render: (r) => <Stacked primary={r.bill.customerName} secondary={`${r.bill.productCode} · HSN ${r.bill.hsnCode}`} />,
    },
    {
      key: 'movement',
      header: w.columns.type,
      width: 150,
      // The asymmetry, said in words inside its own column. A boxed rule marks
      // a load leaving the state so the distinction survives with every hue
      // stripped out.
      render: (r) => (
        <Stacked
          primary={
            r.bill.movement === 'inter_state' ? (
              <span
                className="inline-flex min-h-[20px] items-center px-1.5 text-[11px] font-medium uppercase tracking-[0.06em]"
                style={{
                  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                  borderRadius: 'var(--r-1)',
                  color: 'var(--text-primary)',
                }}
              >
                {w.otherState}
              </span>
            ) : (
              <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-secondary)' }}>
                {w.insideTn}
              </span>
            )
          }
          secondary={w.limit(formatINR(ewbThreshold(r.bill), { decimals: 0 }))}
        />
      ),
    },
    {
      key: 'route',
      header: w.columns.route,
      width: 208,
      render: (r) => (
        <span
          title={w.routeTitle(
            GST_STATE_NAMES[r.bill.fromStateCode] ?? r.bill.fromStateCode,
            GST_STATE_NAMES[r.bill.toStateCode] ?? r.bill.toStateCode,
          )}
        >
          <Stacked
            primary={`${r.bill.fromPlace} → ${r.bill.toPlace}`}
            secondary={
              <span className="font-id">
                {r.bill.fromStateCode} {GST_STATE_ABBR[r.bill.fromStateCode] ?? ''} → {r.bill.toStateCode}{' '}
                {GST_STATE_ABBR[r.bill.toStateCode] ?? ''}
              </span>
            }
          />
        </span>
      ),
    },
    {
      key: 'value',
      header: w.columns.amount,
      unit: '₹',
      type: 'money',
      width: 128,
      render: (r) => <MoneyCell value={r.bill.consignmentValue} decimals={0} />,
    },
    {
      key: 'partb',
      header: w.columns.vehicle,
      width: 208,
      render: (r) => {
        const { bill, clock, keyed } = r;
        if (bill.partBExemptUnder50km && bill.partBVehicle === null) {
          return (
            <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-secondary)' }}>
              {w.notNeededKm(bill.distanceKm)}
            </span>
          );
        }
        if (bill.partBVehicle === null) {
          return clock.standing === 'part_b_pending' || clock.standing === 'part_a_lapsed' ? (
            <span
              className="text-[12px]"
              style={{ color: clock.standing === 'part_a_lapsed' ? 'var(--status-critical)' : 'var(--text-secondary)' }}
            >
              {clock.standing === 'part_a_lapsed' ? w.notAddedInTime : w.kpi.addWithin(clock.partBDaysLeft ?? 0)}
            </span>
          ) : null;
        }
        // A vehicle that belongs to another of the group's companies.
        const interCompany = bill.transporterGstin !== null && bill.transporterGstin !== bill.supplierGstin;
        const reg = <span className="font-id">{spacedReg(bill.partBVehicle)}</span>;
        return (
          <Stacked
            primary={keyed ? <Provisional confirmed={false} by="person">{reg}</Provisional> : reg}
            secondary={
              interCompany ? `${bill.transporterName ?? ''} · ${w.otherCompany}` : (bill.transporterName ?? undefined)
            }
          />
        );
      },
    },
    {
      key: 'validUntil',
      header: w.columns.validTill,
      width: 156,
      render: (r) =>
        r.clock.validUntil === null ? null : (
          <Stacked
            primary={formatDateTime(r.clock.validUntil)}
            secondary={`${t.common.days(r.clock.validityDays ?? 0)}${r.bill.overDimensional ? ` · ${w.oversize}` : ''}`}
          />
        ),
    },
    {
      key: 'distance',
      header: w.columns.distance,
      unit: t.common.km,
      type: 'num',
      width: 106,
      render: (r) => <QuantityCell value={r.bill.distanceKm} decimals={0} />,
    },
    {
      key: 'left',
      header: w.columns.timeLeft,
      width: 128,
      render: (r) => {
        if (r.clock.msLeft === null) {
          // A Part A with no Part B has a clock of its own — a different one.
          return r.clock.partBDaysLeft === null ? null : (
            <span className="num tabular-nums text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              {r.clock.partBDaysLeft > 0 ? w.partA(r.clock.partBDaysLeft) : w.partALapsed}
            </span>
          );
        }
        const dead = r.clock.msLeft <= 0;
        const span = t.common.span(r.clock.msLeft);
        return (
          <span
            className="num tabular-nums"
            style={{
              color: dead
                ? 'var(--status-critical)'
                : r.clock.standing === 'expiring'
                  ? 'var(--status-attention)'
                  : undefined,
            }}
          >
            {dead ? w.ago(span) : span}
          </span>
        );
      },
    },
    {
      key: 'standing',
      header: w.columns.status,
      type: 'status',
      width: 186,
      render: (r) => (
        <StatusStamp
          status={r.clock.family}
          label={standingWords[r.clock.standing]}
          severity={severityOf(r, t)}
          fillRatio={r.clock.fillRatio ?? undefined}
          provisional={r.keyed || r.voided}
        />
      ),
    },
    {
      key: 'note',
      header: t.common.note,
      render: (r) => (
        <span
          className="font-serif text-[13px] italic"
          style={{
            color:
              r.clock.standing === 'expired' || r.clock.standing === 'part_a_lapsed' || r.clock.standing === 'blocked'
                ? 'var(--status-critical)'
                : 'var(--text-secondary)',
          }}
        >
          {consequence(r, t)}
        </span>
      ),
    },
  ];
}
