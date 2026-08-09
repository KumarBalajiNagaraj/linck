import { useMemo, useState } from 'react';
import { formatDate, formatDateTime, formatINR, formatINRCompact } from '@linck/domain';
import {
  blockedGstinsFor,
  ewayBillsForSite,
  ewayBillSummary,
  ewbClock,
  ewbHeldByGstin,
  ewbThreshold,
  ewbTimeLeftLabel,
  EWB_CANCEL_WINDOW_HOURS,
  EWB_INTER_STATE_THRESHOLD,
  EWB_INTRA_STATE_THRESHOLD,
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
import { useApp } from '../../shell/store.js';

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
 *      labelled MOVEMENT column, never by hue alone — and by the lane chart,
 *      where the limit is a dashed tick sitting at two different places.
 *   2. PART A AND PART B ARE DIFFERENT DOCUMENTS. Part A stands alone for 15
 *      days waiting for a vehicle number and then dies quietly. That clock is
 *      surfaced, because nothing on the portal shouts when it runs out.
 *   3. A BLANK PART B IS NOT ALWAYS A FAILURE. Under 50 km in the same state,
 *      consignor to transporter, it is simply not required.
 *   4. RULE 138E IS NOT A ROW ERROR. Two unfiled GSTR-3B periods and the
 *      portal refuses to generate anything on that GSTIN — every tipper in the
 *      yard stops at once. It belongs to the registration, in a banner, not
 *      repeated forty times down a column.
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

export function EwayBillConsole() {
  const { siteScope, density } = useApp();
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
   * The lane chart reserves its label gutter in real pixels, so the gutter is a
   * render decision rather than a stylesheet one: 140px of it on a phone leaves
   * the bars about a centimetre long. The labels are short — "TN → KA · 7" —
   * so a narrow gutter costs nothing and gives the bars room to be read. The
   * same flag compacts the money: four ticks of ₹1,00,000 across 180px of axis
   * run into each other and print as one smear, where ₹1.00 L does not. The
   * full figures stay in the chart summary.
   */
  const wideLabels = useMinWidth('sm');

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

  const clearFilters = () => {
    setFilter('all');
    setLane(null);
  };

  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        title="e-Way bill console"
        meta={
          <span className="flex flex-wrap items-center gap-4">
            <AsOfStamp asOf="14:42" source="v_eway_bill_standing" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {summary.interState} consignments cross a state border at a{' '}
              {formatINR(EWB_INTER_STATE_THRESHOLD, { decimals: 0 })} limit · {summary.intraState} stay inside Tamil
              Nadu, where the limit is {formatINR(EWB_INTRA_STATE_THRESHOLD, { decimals: 0 })}
            </span>
          </span>
        }
      />

      {/* Rule 138E stops the whole yard, so it is stated once, against the
          registration it belongs to — never as forty identical row errors. */}
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
                <StatusStamp status="critical" label="blocked 138E" severity={held.length} />
                <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                  <IdCell>{g.gstin}</IdCell> — {g.legalEntityName} cannot generate any e-way bill.
                </span>
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  GSTR-3B unfiled for {g.missedReturnPeriods.join(' and ')}; last filed {g.lastFiledPeriod}. Blocked since{' '}
                  {formatDateTime(g.blockedSince)}.
                </span>
                <span className="w-full font-serif text-[13px] italic" style={{ color: 'var(--status-critical)' }}>
                  {held.length} loads worth {formatINR(value, { decimals: 0 })} are standing in the yard behind this. Filing
                  the return lifts the block — nothing on this screen can.
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* One tile per row on a phone. Every delta here is a sentence — "the
          tightest Part A dies in 4 days" — and at half of 375px it wraps to
          four lines under a number, which reads as noise rather than a figure. */}
      <TileRow className="mt-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-r [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0">
        <KpiTile
          eyebrow="Bills in force"
          hero
          value={String(summary.inForce)}
          delta={{ text: `${summary.interStateInForce} of them cross a state border` }}
          asOf="14:42"
          source="v_eway_bill_standing"
        />
        <KpiTile
          eyebrow="Part B pending"
          value={String(summary.partBPending)}
          delta={{
            text:
              summary.partBTightestDaysLeft === null
                ? `Part A stands ${EWB_PART_A_WINDOW_DAYS} days without a vehicle number`
                : `The tightest Part A dies in ${summary.partBTightestDaysLeft} days`,
            tone:
              summary.partBTightestDaysLeft !== null && summary.partBTightestDaysLeft <= 3 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_eway_bill_part_a_window"
        />
        <KpiTile
          eyebrow="Expiring within 24 hours"
          value={String(summary.expiring)}
          delta={{
            text: `${summary.expired} already expired · extension is possible 8 hours either side`,
            tone: summary.expired > 0 ? 'critical' : summary.expiring > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="v_eway_bill_validity"
        />
        <KpiTile
          eyebrow="Registrations blocked"
          value={String(blocked.length)}
          delta={{
            text:
              blocked.length === 0
                ? 'Every GSTIN is current on GSTR-3B'
                : `${summary.blocked} consignments cannot be raised at all`,
            tone: blocked.length > 0 ? 'critical' : 'neutral',
          }}
          asOf="14:42"
          source="v_gstin_filing_standing"
          freshness="materialised"
        />
      </TileRow>

      <div className="grid grid-cols-1 xl:grid-cols-2">
        <Section caption="Every consignment on the board" title="Where the paperwork stands">
          <div className="px-6">
            <ProportionBar
              summary={`${all.length} consignments: ${tally.active + tally.expiring} bills in force, ${
                tally.partBPending
              } waiting on a vehicle number, ${tally.dead} dead or lapsed, ${tally.cannotRaise} that cannot be raised at all, and ${
                tally.notRequired
              } that owe no bill.`}
              segments={[
                { label: 'In force', value: tally.active, tone: 'var(--chart-2)' },
                { label: 'Part B pending', value: tally.partBPending, tone: 'var(--chart-3)' },
                { label: 'Expiring', value: tally.expiring, tone: 'var(--status-attention)' },
                { label: 'Expired or lapsed', value: tally.dead, tone: 'var(--status-critical)' },
                { label: 'Cancelled', value: tally.cancelled, tone: 'var(--chart-5)' },
                { label: 'Cannot be raised', value: tally.cannotRaise, tone: 'var(--status-critical)' },
                { label: 'No bill owed', value: tally.notRequired, tone: 'var(--chart-4)' },
              ].filter((s) => s.value > 0)}
            />
            <ChartCaption>
              A fat &ldquo;no bill owed&rdquo; band is not a filing backlog — it is the intra-Tamil Nadu exemption doing
              its job on short local loads. Only the coloured bands cost anything at a check post, and the blocked ones
              among them cannot be cleared from this screen at all.
            </ChartCaption>
          </div>
        </Section>

        <Section caption="Average consignment value, with the limit that lane actually lives under" title="The threshold asymmetry, drawn">
          <div className="px-6">
            <BarChart
              summary={`Average consignment value by lane. The dashed tick is the applicable limit — ${formatINR(
                EWB_INTER_STATE_THRESHOLD,
                { decimals: 0 },
              )} across a border, ${formatINR(EWB_INTRA_STATE_THRESHOLD, {
                decimals: 0,
              })} inside Tamil Nadu — so the same tick sits at two different places.`}
              data={lanes.map((e) => ({
                label: laneLabel(e.from, e.to, e.count),
                value: Math.round(e.average),
                marker: e.threshold,
                ...(lane === e.key ? { tone: 'var(--chart-1)' } : {}),
              }))}
              format={(v) => (wideLabels ? formatINR(v, { decimals: 0 }) : formatINRCompact(v))}
              labelWidth={wideLabels ? 140 : 84}
              onSelect={(d) => {
                const hit = lanes.find((e) => laneLabel(e.from, e.to, e.count) === d.label);
                if (hit) setLane(hit.key === lane ? null : hit.key);
              }}
            />
            <ChartCaption>
              Every lane that leaves the state sits under a tick half the height of the one that stays inside it. The
              same tipper load can be paperwork-free at home and a detention risk an hour up the road — nothing about
              the material changed, only the border. Click a lane to hold the table to it.
            </ChartCaption>
          </div>
        </Section>
      </div>

      <div
        className="mt-7 flex flex-wrap items-center gap-2 px-6 py-3"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={all.length}>
          Everything moving
        </Chip>
        <Chip active={filter === 'inter'} onClick={() => setFilter('inter')} count={summary.interState}>
          Inter-state
        </Chip>
        <Chip active={filter === 'pending'} onClick={() => setFilter('pending')} count={summary.partBPending}>
          Part B pending
        </Chip>
        <Chip active={filter === 'expiring'} onClick={() => setFilter('expiring')} count={summary.expiring}>
          Expiring in 24h
        </Chip>
        <Chip active={filter === 'dead'} onClick={() => setFilter('dead')} count={summary.expired + summary.partALapsed}>
          Expired or lapsed
        </Chip>
        <Chip active={filter === 'blocked'} onClick={() => setFilter('blocked')} count={summary.blocked}>
          Cannot be raised
        </Chip>
        <Chip active={filter === 'exempt'} onClick={() => setFilter('exempt')} count={summary.notRequired}>
          No bill owed
        </Chip>
        {lane === null ? null : (
          <Chip active onClick={() => setLane(null)} count={rows.length}>
            Lane {laneWords(lane)} — clear
          </Chip>
        )}
      </div>

      <Section
        caption="Part A is the consignment, Part B is the vehicle — and only Part B starts the clock"
        title="Consignments and their bills"
      >
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
          empty={
            <EmptyState
              fact="No consignment matches this view."
              because="Either nothing here needs a bill today, or the filter is narrower than the day's dispatch."
              action={{ label: 'Show everything moving', onClick: clearFilters }}
            />
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={current !== undefined}
        onClose={() => setSelected(undefined)}
        width="form"
        title={current?.bill.customerName ?? ''}
        identifier={
          current
            ? (formatEwbNumber(current.bill.ewbNumber) ?? `${current.bill.invoiceNumber} · no bill raised`)
            : undefined
        }
        {...(current
          ? {
              status: {
                family: current.clock.family,
                label: current.clock.label,
                ...(current.clock.severity === null ? {} : { severity: current.clock.severity }),
                ...(current.keyed || current.voided ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={
          current
            ? `ATTEMPT ${current.bill.attempt}${current.bill.generatedAt ? ` · ${formatDate(current.bill.generatedAt)}` : ''}`
            : undefined
        }
        footer={
          current && window_ && isCancellable(current.bill) ? (
            <>
              <Button variant="destructive" className="shrink-0" onClick={() => setCancelOpen(true)}>
                Cancel this e-way bill
              </Button>
              {/* The footer bar is one fixed-height row. Beside a 44px button on
                  a 375px sheet the full sentence needs four lines and spills out
                  of it, so the narrow reading states the same fact in one. */}
              <span
                className="font-serif text-[12px] italic leading-snug sm:hidden"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {window_.open
                  ? `${ewbTimeLeftLabel(window_.msLeft)} left to cancel`
                  : `Window shut ${ewbTimeLeftLabel(window_.msLeft)} ago`}
              </span>
              <span
                className="hidden font-serif text-[13px] italic sm:inline"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {window_.open
                  ? `The portal accepts a cancellation for another ${ewbTimeLeftLabel(window_.msLeft)}.`
                  : `The ${EWB_CANCEL_WINDOW_HOURS}-hour window closed ${ewbTimeLeftLabel(window_.msLeft)} ago.`}
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
          that pretends the rule is negotiable. */}
      {current && window_ && window_.open ? (
        <ConfirmModal
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          onConfirm={() =>
            setVoided((s) => ({
              ...s,
              [current.bill.id]: 'Cancelled from the console inside the 24-hour window',
            }))
          }
          title={`Cancel ${formatEwbNumber(current.bill.ewbNumber) ?? 'this bill'}`}
          destructive
          confirmLabel="Cancel the bill"
          {...(current.bill.ewbNumber === null ? {} : { confirmPhrase: current.bill.ewbNumber })}
          consequence={
            <>
              Raised {formatDateTime(current.bill.generatedAt)}, {hoursWords(window_.hoursSince)} ago. The window is still
              open — it closes {formatDateTime(window_.closesAt)}, in {ewbTimeLeftLabel(window_.msLeft)}. Cancelling
              voids this number for {current.bill.tripNumber}: the load cannot move on it afterwards, and a fresh bill
              must be raised as attempt {current.bill.attempt + 1}. Invoice {current.bill.invoiceNumber} is not touched.
            </>
          }
        />
      ) : current && window_ ? (
        <Modal
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          title="This bill can no longer be cancelled"
          footer={<Button onClick={() => setCancelOpen(false)}>Understood</Button>}
        >
          <p className="font-serif text-[14px] italic" style={{ color: 'var(--text-primary)' }}>
            {formatEwbNumber(current.bill.ewbNumber)} was raised {formatDateTime(current.bill.generatedAt)}, which is{' '}
            {hoursWords(window_.hoursSince)} ago. Cancellation is only legal within {EWB_CANCEL_WINDOW_HOURS} hours of
            generation, and that window shut {ewbTimeLeftLabel(window_.msLeft)} ago. The portal will refuse, and so does
            this console.
          </p>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            What is left is the accounting route: let the bill run out, then settle the consignment with a credit note
            against {current.bill.invoiceNumber} and raise fresh documents for whatever actually moved.
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
  const { bill, clock, keyed } = row;
  const value = Number.parseFloat(bill.consignmentValue);
  const threshold = ewbThreshold(bill);
  const headroom = threshold - value;
  const supplier = gstinStanding(bill.supplierGstin);
  const interCompany = bill.transporterGstin !== null && bill.transporterGstin !== bill.supplierGstin;

  return (
    <>
      <SheetSection caption="What this means">
        <Note>{consequence(row)}</Note>
      </SheetSection>

      <SheetSection caption="Document">
        <DetailGrid>
          <Detail label="Raised against">
            <IdCell>{bill.invoiceNumber}</IdCell>
          </Detail>
          <Detail label="Trip">
            <IdCell>{bill.tripNumber}</IdCell>
          </Detail>
          <Detail label="Document date">{formatDate(bill.documentDate)}</Detail>
          <Detail label="Part A accepted">
            {bill.generatedAt === null ? 'Never raised' : formatDateTime(bill.generatedAt)}
          </Detail>
          <Detail label="Supplier registration" wide>
            <IdCell>{bill.supplierGstin}</IdCell>
            {supplier ? (
              <span style={{ color: 'var(--text-secondary)' }}> · {supplier.legalEntityName}</span>
            ) : null}
          </Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Consignment and the limit it lives under">
        <DetailGrid>
          <Detail label="Customer" wide>
            {bill.customerName}
          </Detail>
          <Detail label="Material">
            {bill.productCode} · HSN <IdCell>{bill.hsnCode}</IdCell>
          </Detail>
          <Detail label="Consignment value">
            <MoneyCell value={bill.consignmentValue} accounting={false} decimals={0} />
          </Detail>
          <Detail label="Applicable limit">
            <MoneyCell value={threshold} accounting={false} decimals={0} />
            <span style={{ color: 'var(--text-secondary)' }}>
              {' '}
              · {bill.movement === 'inter_state' ? 'across a border' : 'inside Tamil Nadu'}
            </span>
          </Detail>
          <Detail label="Headroom against the limit">
            {headroom >= 0 ? (
              <>
                {formatINR(headroom, { decimals: 0 })} under
              </>
            ) : (
              <span style={{ color: 'var(--text-primary)' }}>
                {formatINR(Math.abs(headroom), { decimals: 0 })} over — a bill is owed
              </span>
            )}
          </Detail>
        </DetailGrid>
        {bill.movement === 'intra_state' ? (
          <Note>
            The same load crossing into Karnataka would face a{' '}
            {formatINR(EWB_INTER_STATE_THRESHOLD, { decimals: 0 })} limit instead, and would owe a bill whatever this
            one does.
          </Note>
        ) : null}
      </SheetSection>

      <SheetSection caption="Route">
        <DetailGrid>
          <Detail label="From">
            {bill.fromPlace}
            <span className="font-id" style={{ color: 'var(--text-tertiary)' }}>
              {' '}
              {bill.fromStateCode}
            </span>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>
              {GST_STATE_NAMES[bill.fromStateCode] ?? bill.fromStateCode}
            </span>
          </Detail>
          <Detail label="To">
            {bill.toPlace}
            <span className="font-id" style={{ color: 'var(--text-tertiary)' }}>
              {' '}
              {bill.toStateCode}
            </span>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>
              {GST_STATE_NAMES[bill.toStateCode] ?? bill.toStateCode}
            </span>
          </Detail>
          <Detail label="Movement">{bill.movement === 'inter_state' ? 'Inter-state' : 'Intra-state'}</Detail>
          <Detail label="Distance">
            <QuantityCell value={bill.distanceKm} decimals={0} uom="km" />
          </Detail>
        </DetailGrid>
      </SheetSection>

      {clock.partADeadline !== null ? (
        <SheetSection caption={`Part A window — ${EWB_PART_A_WINDOW_DAYS} days to find a vehicle`}>
          <DetailGrid>
            <Detail label="Dies at">{formatDateTime(clock.partADeadline)}</Detail>
            <Detail label="Days left">
              {clock.partBDaysLeft === null
                ? '–'
                : clock.partBDaysLeft > 0
                  ? `${clock.partBDaysLeft} of ${EWB_PART_A_WINDOW_DAYS}`
                  : 'Gone'}
            </Detail>
          </DetailGrid>
          {clock.partBDaysLeft !== null && clock.partBDaysLeft > 0 ? (
            <div className="pt-1">
              <ProportionBar
                height={20}
                summary={`${clock.partBDaysLeft} of ${EWB_PART_A_WINDOW_DAYS} days left before Part A dies unused.`}
                segments={[
                  {
                    label: 'Spent',
                    value: EWB_PART_A_WINDOW_DAYS - clock.partBDaysLeft,
                    tone: 'var(--chart-5)',
                  },
                  {
                    label: 'Left',
                    value: clock.partBDaysLeft,
                    tone: clock.partBDaysLeft <= 3 ? 'var(--status-attention)' : 'var(--chart-2)',
                  },
                ]}
              />
            </div>
          ) : (
            <Note>
              The window ran out. This number cannot be completed at all — the vehicle goes on a fresh bill, not on this
              one.
            </Note>
          )}

          {/* Entering Part B. The only write that changes the clock: a vehicle
              number turns a dormant Part A into a bill with validity running.
              Unspaced, because that is what the portal accepts, and hatched
              until the portal acknowledges it — keyed here is not filed there. */}
          {clock.standing === 'part_b_pending' ? (
            keyed ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Part B keyed as
                </span>
                <Provisional confirmed={false}>
                  <span className="font-id text-[13px]">{spacedReg(bill.partBVehicle ?? '')}</span>
                </Provisional>
                <Button onClick={onUndo}>Undo Part B</Button>
                <span className="w-full font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  The clock started at 14:42. Still to be acknowledged by the portal.
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

      <SheetSection caption="Part B and the validity it buys">
        <DetailGrid>
          <Detail label="Vehicle">
            {bill.partBVehicle === null ? (
              bill.partBExemptUnder50km ? (
                <span style={{ color: 'var(--text-secondary)' }}>
                  Not required — {bill.distanceKm} km, same state
                </span>
              ) : (
                '–'
              )
            ) : keyed ? (
              <Provisional confirmed={false}>
                <span className="font-id">{spacedReg(bill.partBVehicle)}</span>
              </Provisional>
            ) : (
              <span className="font-id">{spacedReg(bill.partBVehicle)}</span>
            )}
          </Detail>
          <Detail label="Transporter">
            {bill.transporterName ?? '–'}
            {interCompany ? (
              <span style={{ color: 'var(--text-secondary)' }}> · inter-company leg</span>
            ) : null}
          </Detail>
          <Detail label="Part B entered">
            {bill.partBEnteredAt === null ? '–' : formatDateTime(bill.partBEnteredAt)}
          </Detail>
          <Detail label="Validity slab used">
            {bill.overDimensional
              ? `1 day per 20 km — over-dimensional cargo`
              : `1 day per 200 km or part thereof`}
          </Detail>
          <Detail label="Days granted">
            {clock.validityDays === null ? '–' : `${clock.validityDays} for ${bill.distanceKm} km`}
          </Detail>
          <Detail label="Valid until">{clock.validUntil === null ? '–' : formatDateTime(clock.validUntil)}</Detail>
          <Detail label="Time remaining" wide>
            {clock.msLeft === null ? (
              '–'
            ) : clock.msLeft <= 0 ? (
              <span style={{ color: 'var(--status-critical)' }}>{ewbTimeLeftLabel(clock.msLeft)} ago</span>
            ) : (
              <span
                style={{ color: clock.standing === 'expiring' ? 'var(--status-attention)' : 'var(--text-primary)' }}
              >
                {ewbTimeLeftLabel(clock.msLeft)} left
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
                  ? `Validity fully spent — expired ${ewbTimeLeftLabel(clock.msLeft)} ago.`
                  : `${Math.round(clock.fillRatio * 100)}% of the granted validity is still unspent.`
              }
              segments={[
                { label: 'Run down', value: Math.max(0.001, 1 - clock.fillRatio), tone: 'var(--chart-5)' },
                {
                  label: 'Left',
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

        {bill.overDimensional ? (
          <Note>
            Over-dimensional cargo earns a day per 20 km instead of 200, so {bill.distanceKm} km buys{' '}
            {ewbValidityWords(bill.distanceKm, true)} rather than one. A plant move is not a tipper load and the portal
            knows it.
          </Note>
        ) : null}
      </SheetSection>

      <SheetSection caption={`Generation attempts on ${bill.tripNumber}`}>
        {history.length <= 1 ? (
          <Note>
            One attempt. Nothing has been cancelled and regenerated against this trip, so this number is the only paper
            that has ever existed for the load.
          </Note>
        ) : (
          <ul>
            {history.map((h) => (
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
                    Attempt {h.bill.attempt} ·{' '}
                    {h.bill.ewbNumber ? (
                      <IdCell>{formatEwbNumber(h.bill.ewbNumber)}</IdCell>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)' }}>none raised</span>
                    )}
                  </span>
                  <StatusStamp
                    status={h.clock.family}
                    label={h.clock.label}
                    {...(h.clock.severity === null ? {} : { severity: h.clock.severity })}
                    {...(h.keyed || h.voided ? { provisional: true } : {})}
                  />
                </span>
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  Raised {formatDateTime(h.bill.generatedAt)}
                  {h.bill.cancelledAt === null ? '' : ` · cancelled ${formatDateTime(h.bill.cancelledAt)}`}
                  {h.bill.partBVehicle === null ? '' : ` · ${spacedReg(h.bill.partBVehicle)}`}
                </span>
                {h.bill.cancelReason ? <Note>{h.bill.cancelReason}</Note> : null}
              </li>
            ))}
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
 * a typo.
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
  const cleaned = draft.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const valid = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/.test(cleaned);

  return (
    <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
      {/* Full measure on a phone, 190px once there is a row to sit in. The
          height follows the same rule as Button: 44px where the pointer cannot
          hover, 34px on a desk where density is the point. */}
      <input
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        list="ewb-fleet"
        placeholder="TN29AB1015"
        aria-label="Part B vehicle number"
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="font-id h-11 w-full px-2 text-[14px] uppercase sm:w-[190px] [@media(hover:hover)]:h-[34px]"
        style={{
          background: 'var(--surface)',
          color: 'var(--text-primary)',
          boxShadow: 'inset 0 0 0 1px var(--border-strong)',
          borderRadius: 'var(--r-1)',
        }}
      />
      <datalist id="ewb-fleet">
        {fleet.map((v) => (
          <option key={v.reg} value={v.reg}>
            {v.label} · {v.model}
          </option>
        ))}
      </datalist>
      <Button
        variant="primary"
        disabled={!valid}
        onClick={() => onEnter(cleaned)}
        className="w-full sm:w-auto"
      >
        Enter Part B and start the clock
      </Button>
      <span className="w-full font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {draft !== '' && !valid
          ? 'That is not a registration number the portal will take. No spaces, no dashes.'
          : `${daysLeft ?? 0}d left on Part A. Entering it grants ${ewbValidityWords(
              bill.distanceKm,
              bill.overDimensional,
            )}.`}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- derivation */

function laneKey(bill: EwayBill): string {
  return `${bill.fromStateCode}>${bill.toStateCode}`;
}

function laneLabel(from: string, to: string, count: number): string {
  return `${GST_STATE_ABBR[from] ?? from} → ${GST_STATE_ABBR[to] ?? to} · ${count}`;
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
  hoursSince: number;
  /** Positive while the window is open, negative once it has shut. */
  msLeft: number;
  closesAt: string;
}

/**
 * The 24-hour cancellation window, computed against the clock rather than read
 * off a flag — same reason the standings are derived. A bill raised at 03:34 is
 * cancellable this morning and not this evening, and no stored field survives
 * that.
 */
function cancelWindow(bill: EwayBill, now: Date): CancelWindow | null {
  if (!bill.generatedAt) return null;
  const generated = Date.parse(bill.generatedAt);
  const closes = generated + EWB_CANCEL_WINDOW_HOURS * HOUR_MS;
  return {
    open: now.getTime() < closes,
    hoursSince: (now.getTime() - generated) / HOUR_MS,
    msLeft: closes - now.getTime(),
    closesAt: new Date(closes).toISOString(),
  };
}

function hoursWords(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function spacedReg(reg: string): string {
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/.exec(reg);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : reg;
}

function ewbValidityWords(distanceKm: number, odc: boolean): string {
  const days = Math.max(1, Math.ceil(distanceKm / (odc ? 20 : 200)));
  return `${days} day${days === 1 ? '' : 's'} at 1 day per ${odc ? 20 : 200} km`;
}

/**
 * What the row means, in the words the person at the check post would use.
 * Every standing gets a different sentence — an expired bill and a load that
 * never needed one are not the same fact and must never share copy.
 */
function consequence(row: Row): string {
  const { bill, clock } = row;
  const headroom = ewbThreshold(bill) - Number.parseFloat(bill.consignmentValue);

  switch (clock.standing) {
    case 'not_required':
      return `${bill.exemptReason ?? 'Below the limit for this movement'} — ${formatINR(headroom, { decimals: 0 })} of headroom. The invoice alone carries this load.`;
    case 'blocked':
      return `${gstinStanding(bill.supplierGstin)?.legalEntityName ?? 'This registration'} is blocked under Rule 138E. Nothing can be raised on this GSTIN until the returns are filed.`;
    case 'to_generate':
      return 'Part A has not been raised. The tipper does not leave the gate on this one.';
    case 'part_b_pending':
      return `Part A dies in ${clock.partBDaysLeft} days. Key the vehicle number before then, or raise the bill again from scratch.`;
    case 'part_a_lapsed':
      return `Part A stood ${EWB_PART_A_WINDOW_DAYS} days without a vehicle number and is now dead. This number cannot be completed — generate a fresh bill.`;
    case 'active':
      return bill.partBExemptUnder50km
        ? `Under ${EWB_PART_B_EXEMPT_KM} km inside Tamil Nadu, consignor to transporter — Part B is not required. The blank is correct.`
        : `Valid until ${formatDateTime(clock.validUntil)} — ${ewbValidityWords(bill.distanceKm, bill.overDimensional)}.`;
    case 'expiring':
      return `Runs out at ${formatDateTime(clock.validUntil)}. Extension can be filed 8 hours either side of expiry, and only while the vehicle is still in transit.`;
    case 'expired':
      return `Expired ${ewbTimeLeftLabel(clock.msLeft ?? 0)} ago. A load moving on this number is detention and penalty under section 129.`;
    case 'cancelled':
      return `Cancelled ${clock.severity ?? ''} after generation, inside the 24-hour window. ${bill.cancelReason ?? ''}`;
    default:
      return '';
  }
}

/* ----------------------------------------------------------------- columns */

const columns: Column<Row>[] = [
  {
    key: 'ewb',
    header: 'EWB number',
    type: 'id',
    sticky: true,
    width: 196,
    group: 'Document',
    render: (r) => (
      <Stacked
        primary={
          r.bill.ewbNumber ? (
            <IdCell>{formatEwbNumber(r.bill.ewbNumber)}</IdCell>
          ) : (
            <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              none raised
            </span>
          )
        }
        secondary={r.bill.generatedAt ? formatDate(r.bill.generatedAt) : formatDate(r.bill.documentDate)}
      />
    ),
  },
  {
    key: 'against',
    header: 'Against',
    width: 172,
    group: 'Document',
    render: (r) => (
      <Stacked
        primary={<span className="font-id text-[12px]">{r.bill.invoiceNumber}</span>}
        secondary={
          r.bill.attempt > 1
            ? `${r.bill.tripNumber} · attempt ${r.bill.attempt}`
            : r.bill.tripNumber
        }
      />
    ),
  },
  {
    key: 'customer',
    header: 'Customer',
    width: 216,
    group: 'Consignment',
    render: (r) => <Stacked primary={r.bill.customerName} secondary={`${r.bill.productCode} · HSN ${r.bill.hsnCode}`} />,
  },
  {
    key: 'movement',
    header: 'Movement',
    width: 146,
    group: 'Consignment',
    // The asymmetry, said in words inside its own column. A boxed rule marks
    // inter-state so the distinction survives with every hue stripped out.
    render: (r) => (
      <Stacked
        primary={
          r.bill.movement === 'inter_state' ? (
            <span
              className="inline-flex h-[18px] items-center px-1.5 text-[11px] font-medium uppercase tracking-[0.06em]"
              style={{
                boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                borderRadius: 'var(--r-1)',
                color: 'var(--text-primary)',
              }}
            >
              Inter-state
            </span>
          ) : (
            <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-secondary)' }}>
              Intra-state
            </span>
          )
        }
        secondary={`limit ${formatINR(ewbThreshold(r.bill), { decimals: 0 })}`}
      />
    ),
  },
  {
    key: 'route',
    header: 'From → to',
    width: 208,
    group: 'Consignment',
    render: (r) => (
      <span
        title={`${GST_STATE_NAMES[r.bill.fromStateCode] ?? r.bill.fromStateCode} to ${GST_STATE_NAMES[r.bill.toStateCode] ?? r.bill.toStateCode}`}
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
    header: 'Value',
    unit: '₹',
    type: 'money',
    width: 128,
    group: 'Consignment',
    render: (r) => <MoneyCell value={r.bill.consignmentValue} decimals={0} />,
  },
  {
    key: 'partb',
    header: 'Part B vehicle',
    width: 208,
    group: 'Vehicle',
    render: (r) => {
      const { bill, clock, keyed } = r;
      if (bill.partBExemptUnder50km && bill.partBVehicle === null) {
        return (
          <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-secondary)' }}>
            Not required — {bill.distanceKm} km, same state
          </span>
        );
      }
      if (bill.partBVehicle === null) {
        return clock.standing === 'part_b_pending' || clock.standing === 'part_a_lapsed' ? (
          <span
            className="text-[12px]"
            style={{ color: clock.standing === 'part_a_lapsed' ? 'var(--status-critical)' : 'var(--text-secondary)' }}
          >
            {clock.standing === 'part_a_lapsed'
              ? 'Never entered — window gone'
              : `Awaiting a vehicle · ${clock.partBDaysLeft}d of ${EWB_PART_A_WINDOW_DAYS} left`}
          </span>
        ) : null;
      }
      const interCompany = bill.transporterGstin !== null && bill.transporterGstin !== bill.supplierGstin;
      const reg = <span className="font-id">{spacedReg(bill.partBVehicle)}</span>;
      return (
        <Stacked
          primary={keyed ? <Provisional confirmed={false}>{reg}</Provisional> : reg}
          secondary={
            interCompany ? `${bill.transporterName} — inter-company leg` : (bill.transporterName ?? undefined)
          }
        />
      );
    },
  },
  {
    key: 'validUntil',
    header: 'Valid until',
    width: 156,
    group: 'Validity',
    render: (r) =>
      r.clock.validUntil === null ? null : (
        <Stacked
          primary={formatDateTime(r.clock.validUntil)}
          secondary={`${r.clock.validityDays}d granted${r.bill.overDimensional ? ' · ODC' : ''}`}
        />
      ),
  },
  {
    key: 'distance',
    header: 'Distance',
    unit: 'km',
    type: 'num',
    width: 106,
    group: 'Validity',
    render: (r) => (
      <Stacked
        primary={<QuantityCell value={r.bill.distanceKm} decimals={0} />}
        secondary={r.bill.overDimensional ? '1d / 20 km' : '1d / 200 km'}
      />
    ),
  },
  {
    key: 'left',
    header: 'Time left',
    width: 122,
    group: 'Validity',
    render: (r) => {
      if (r.clock.msLeft === null) {
        // A Part A with no Part B has a clock of its own — a different one.
        return r.clock.partBDaysLeft === null ? null : (
          <span className="num tabular-nums text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            Part A {r.clock.partBDaysLeft > 0 ? `${r.clock.partBDaysLeft}d` : 'gone'}
          </span>
        );
      }
      const dead = r.clock.msLeft <= 0;
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
          {ewbTimeLeftLabel(r.clock.msLeft)}
          {dead ? ' ago' : ''}
        </span>
      );
    },
  },
  {
    key: 'standing',
    header: 'Standing',
    type: 'status',
    width: 186,
    group: 'Standing',
    render: (r) => (
      <StatusStamp
        status={r.clock.family}
        label={r.clock.label}
        severity={r.clock.severity ?? undefined}
        fillRatio={r.clock.fillRatio ?? undefined}
        provisional={r.keyed || r.voided}
      />
    ),
  },
  {
    key: 'note',
    header: 'What it means',
    group: 'Standing',
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
        {consequence(r)}
      </span>
    ),
  },
];
