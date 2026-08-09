import { useMemo, useState } from 'react';
import { businessDate, formatDate, formatDayMonth, formatQty, PRODUCT_DENSITIES, tonnesToUnits } from '@linck/domain';
import { NOW, PRODUCTION_RUNS, PRODUCTS, SITES, type ProductionRun } from '@linck/mock';
import {
  AsOfStamp,
  Button,
  ChartCaption,
  Chip,
  ConfirmModal,
  DataTable,
  Dash,
  Detail,
  DetailGrid,
  EmptyState,
  Note,
  PageHeader,
  Provisional,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  StatusStamp,
  SuggestionStrip,
  TrendChart,
  useIsPhone,
  YieldFlow,
  type Column,
  type FlowOutput,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';

/**
 * SHIFT PRODUCTION ENTRY.
 *
 * A crusher is JOINT PRODUCTION, not a bill of materials. One heap of boulder
 * goes in and six saleable co-products come out at the same instant — you
 * cannot make 20mm without also making dust. So there is no "quantity
 * produced" field on this screen; there is an input, and there is a repeating
 * output block, and the relationship between them is the whole record.
 *
 * The mass balance is therefore the feature, not a validation. Some loss is
 * real: moisture leaves the pile, fines blow off the belt, the last bucket of
 * a stockpile is never square. Outside ±8% something left the yard without
 * paper — and the operator is told exactly that, in those words, without the
 * form refusing to save. A blocked save at 11pm produces a fabricated number,
 * not a corrected one.
 */

/** The mix this plant normally runs, as a share of boulder fed in. */
const USUAL_SHARE_PCT: Record<string, number> = {
  MSAND: 28,
  PSAND: 11,
  AGG20: 19,
  AGG10: 14,
  AGG6: 8,
  DUST: 16,
};

const BAND_PCT = 8;

const DOWNTIME_REASONS = [
  'Belt slip',
  'Power outage — TNEB',
  'Jaw plate change',
  'Feeder jam',
  'Cone liner wear',
  'No boulder at feed hopper',
];

interface OutputRow {
  key: string;
  productCode: string;
  tonnes: string;
  /** True while the figure came from the suggested mix and no one has touched it. */
  suggested: boolean;
}

function seedOutputs(): OutputRow[] {
  return Object.keys(USUAL_SHARE_PCT).map((code, i) => ({
    key: `out-${i}`,
    productCode: code,
    tonnes: '',
    suggested: false,
  }));
}

function num(raw: string): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function productLabel(code: string): string {
  return PRODUCTS.find((p) => p.code === code)?.label ?? PRODUCT_DENSITIES[code]?.label ?? code;
}

/**
 * Ribbons for the yield flow. `expectedPct` is spread conditionally rather than
 * passed as `undefined` — a co-product this plant has no usual share for (GSB
 * blended off the fines, say) must show no drift at all, which is a different
 * statement from "drift of nothing".
 */
function flowOutputs(entries: { productCode: string; tonnes: number }[]): FlowOutput[] {
  return entries.map((o) => {
    const expected = USUAL_SHARE_PCT[o.productCode];
    return {
      label: productLabel(o.productCode),
      value: o.tonnes,
      ...(expected === undefined ? {} : { expectedPct: expected }),
    };
  });
}

export function ProductionRunEntry() {
  const { siteScope, density } = useApp();
  // The sheet footer is a fixed 56px row that does not wrap. On a phone the
  // caveat sentence cannot share it with the button, so it moves into the body
  // — still the last thing read before the thumb reaches the action.
  const phone = useIsPhone();

  const scoped = useMemo(
    () => PRODUCTION_RUNS.filter((r) => (siteScope ? r.siteId === siteScope : true)),
    [siteScope],
  );
  const crushers = useMemo(() => [...new Set((scoped.length ? scoped : PRODUCTION_RUNS).map((r) => r.crusher))], [scoped]);
  const operators = useMemo(() => [...new Set(PRODUCTION_RUNS.map((r) => r.operator))], []);

  const [date, setDate] = useState(businessDate(NOW));
  const [shift, setShift] = useState<'day' | 'night'>('day');
  const [crusher, setCrusher] = useState(crushers[0] ?? 'Jaw + VSI — KRP 250TPH');
  const [operator, setOperator] = useState(operators[0] ?? '');
  const [runHours, setRunHours] = useState('9.5');
  const [downtimeHours, setDowntimeHours] = useState('0');
  const [downtimeReason, setDowntimeReason] = useState('');
  const [boulderIn, setBoulderIn] = useState('');
  const [outputs, setOutputs] = useState<OutputRow[]>(seedOutputs);
  const [mixDismissed, setMixDismissed] = useState(false);
  const [recorded, setRecorded] = useState<ProductionRun[]>([]);
  const [selected, setSelected] = useState<ProductionRun | null>(null);
  const [confirmOffBand, setConfirmOffBand] = useState(false);
  const [offBandOnly, setOffBandOnly] = useState(false);

  const inTonnes = num(boulderIn);
  const outTonnes = outputs.reduce((s, o) => s + num(o.tonnes), 0);
  const diffTonnes = inTonnes - outTonnes;
  const diffPct = inTonnes > 0 ? (diffTonnes / inTonnes) * 100 : 0;
  const outOfBand = inTonnes > 0 && Math.abs(diffPct) > BAND_PCT;

  const downtime = num(downtimeHours);
  const reasonMissing = downtime > 0 && downtimeReason.trim() === '';
  const canRecord = inTonnes > 0 && outTonnes > 0 && !reasonMissing;
  const offerMix = inTonnes > 0 && outTonnes === 0 && !mixDismissed;

  // Switching plant must never leave a Thiruvallur cone selected on a
  // Karapakkam entry — the select falls back rather than showing a blank.
  const crusherValue = crushers.includes(crusher) ? crusher : (crushers[0] ?? crusher);

  // The live ribbons. Two rows keyed to the same product are ONE pile in the
  // yard, so they are added together before they are drawn — otherwise the
  // operator sees two thin M-Sand ribbons and neither one is the truth.
  const liveFlow = useMemo<FlowOutput[]>(() => {
    const byCode = new Map<string, number>();
    for (const o of outputs) {
      const t = num(o.tonnes);
      if (t <= 0) continue;
      byCode.set(o.productCode, (byCode.get(o.productCode) ?? 0) + t);
    }
    return flowOutputs([...byCode].map(([productCode, tonnes]) => ({ productCode, tonnes })));
  }, [outputs]);

  function editTonnes(key: string, value: string) {
    setOutputs((rs) => rs.map((r) => (r.key === key ? { ...r, tonnes: value, suggested: false } : r)));
  }

  function applyUsualMix() {
    setOutputs((rs) =>
      rs.map((r) => {
        const share = USUAL_SHARE_PCT[r.productCode];
        if (share === undefined) return r;
        return { ...r, tonnes: (Math.round(inTonnes * share) / 100).toFixed(1), suggested: true };
      }),
    );
  }

  /** Refill the form from a shift that already happened, marked unconfirmed. */
  function adoptRun(run: ProductionRun) {
    setBoulderIn(String(run.boulderInTonnes));
    setOutputs(
      run.outputs.map((o, i) => ({
        key: `out-${i}`,
        productCode: o.productCode,
        tonnes: String(o.tonnes),
        suggested: true,
      })),
    );
    setMixDismissed(true);
    setSelected(null);
  }

  function record() {
    const id = `run-local-${recorded.length + 1}`;
    const run: ProductionRun = {
      id,
      date: `${date}T00:00:00.000Z`,
      shift,
      siteId: siteScope ?? 'site-krp',
      crusher: crusherValue,
      operator,
      runHours: num(runHours),
      downtimeHours: downtime,
      downtimeReason: downtime > 0 ? downtimeReason.trim() : null,
      boulderInTonnes: inTonnes,
      outputs: outputs
        .filter((o) => num(o.tonnes) > 0)
        .map((o) => ({
          productCode: o.productCode,
          units: Math.round((PRODUCT_DENSITIES[o.productCode] ? tonnesToUnits(num(o.tonnes), o.productCode) : 0) * 10) / 10,
          tonnes: num(o.tonnes),
        })),
      massBalancePct: Math.round(diffPct * 10) / 10,
      provenance: 'human',
    };
    setRecorded((rs) => [run, ...rs]);
    // The sheet opens on what was just written — the operator's receipt, and
    // the last chance to see the split before the shift is behind them.
    setSelected(run);
    setBoulderIn('');
    setOutputs(seedOutputs());
    setMixDismissed(false);
  }

  /**
   * The save path. An off-band shift is NOT refused — it is read back to the
   * operator in tonnes and then written exactly as keyed. Blocking here just
   * teaches people to fudge the boulder figure until the form goes quiet.
   */
  function attemptRecord() {
    if (outOfBand) {
      setConfirmOffBand(true);
      return;
    }
    record();
  }

  const rows = [...recorded, ...scoped];
  const offBandRows = rows.filter((r) => Math.abs(r.massBalancePct) > BAND_PCT);
  const visibleRows = offBandOnly ? offBandRows : rows;

  // Oldest first — a balance drifting one way over a fortnight is a worn liner
  // or a weighbridge out of calibration, not six unrelated bad shifts.
  const balanceSeries = rows
    .slice(0, 14)
    .reverse()
    .map((r) => ({
      label: `${formatDayMonth(r.date)} ${r.shift === 'day' ? 'D' : 'N'}`,
      value: r.massBalancePct,
    }));

  return (
    <>
      <PageHeader
        eyebrow="Production"
        title="Shift production entry"
        meta={<AsOfStamp asOf="14:42" source="v_production_runs" freshness="live" />}
        actions={
          // The header does not wrap and does not shrink its actions, so two
          // 44px buttons beside the title leave the h1 about 80px — narrow
          // enough that "production" overflows the page. They stack instead
          // until there is room for both on one line.
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button onClick={() => setOutputs(seedOutputs())}>Reset outputs</Button>
            <Button variant="primary" disabled={!canRecord} onClick={attemptRecord}>
              Record shift
            </Button>
          </div>
        }
      />

      <Section caption="One heap in, six piles out" title="The shift">
        <div className="grid gap-x-6 gap-y-4 px-6 md:grid-cols-3 xl:grid-cols-4">
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT_CLASS} style={INPUT_STYLE} />
          </Field>
          {/* Not a <label> — a label wrapping buttons would fire the first chip. */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
              Shift
            </span>
            {/* Two twelve-hour chips are wider than a phone. They wrap rather
                than shrink — a half-legible "Night · 18:00–" is worse than two
                lines. */}
            <span className="flex min-h-11 flex-wrap items-center gap-2 [@media(hover:hover)]:min-h-[34px]">
              <Chip active={shift === 'day'} onClick={() => setShift('day')}>
                Day · 06:00–18:00
              </Chip>
              <Chip active={shift === 'night'} onClick={() => setShift('night')}>
                Night · 18:00–06:00
              </Chip>
            </span>
          </div>
          <Field label="Crusher">
            <select value={crusherValue} onChange={(e) => setCrusher(e.target.value)} className={INPUT_CLASS} style={INPUT_STYLE}>
              {crushers.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Operator">
            <select value={operator} onChange={(e) => setOperator(e.target.value)} className={INPUT_CLASS} style={INPUT_STYLE}>
              {operators.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
          <Field label="Run hours" unit="h">
            <input
              type="number"
              inputMode="decimal"
              step="0.5"
              value={runHours}
              onChange={(e) => setRunHours(e.target.value)}
              className={INPUT_CLASS}
              style={INPUT_STYLE}
            />
          </Field>
          <Field label="Downtime" unit="h">
            <input
              type="number"
              inputMode="decimal"
              step="0.5"
              value={downtimeHours}
              onChange={(e) => setDowntimeHours(e.target.value)}
              className={INPUT_CLASS}
              style={INPUT_STYLE}
            />
          </Field>
          <Field
            label="Downtime reason"
            help={reasonMissing ? 'Hours the plant stood still need a cause, or the utilisation report cannot explain itself.' : undefined}
          >
            <select
              value={downtimeReason}
              onChange={(e) => setDowntimeReason(e.target.value)}
              disabled={downtime === 0}
              className={INPUT_CLASS}
              style={{ ...INPUT_STYLE, ...(reasonMissing ? { boxShadow: 'inset 0 0 0 1px var(--status-attention)' } : {}) }}
            >
              <option value="">{downtime === 0 ? 'No downtime' : 'Choose a reason'}</option>
              {DOWNTIME_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Boulder fed in" unit="MT" help="Weighbridge tickets for the shift, added up.">
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              placeholder="0.0"
              value={boulderIn}
              onChange={(e) => setBoulderIn(e.target.value)}
              className={INPUT_CLASS}
              style={INPUT_STYLE}
            />
          </Field>
        </div>
      </Section>

      <Section
        caption="Joint production — every co-product comes off the same boulder"
        title="What the shift made"
        actions={
          <button
            type="button"
            onClick={() => setOutputs((rows2) => [...rows2, { key: `out-${Date.now()}`, productCode: 'GSB', tonnes: '', suggested: false }])}
            className={`${TEXT_BUTTON_CLASS} text-[13px] font-medium`}
            style={{ color: 'var(--brand)' }}
          >
            Add a co-product
          </button>
        }
      >
        {offerMix ? (
          <div className="px-6 pb-3">
            <SuggestionStrip onApply={applyUsualMix} onDismiss={() => setMixDismissed(true)} applyLabel="Fill from the usual mix">
              This crusher normally splits {formatQty(inTonnes, 1)} MT of boulder into 28% M-sand, 19% 20mm, 16% dust, 14% 10mm,
              11% P-sand and 8% 6mm. Filled figures stay marked as unconfirmed until you correct or accept each one.
            </SuggestionStrip>
          </div>
        ) : null}

        <div className="px-6">
          {outputs.map((row) => {
            const t = num(row.tonnes);
            const units = PRODUCT_DENSITIES[row.productCode] && t > 0 ? tonnesToUnits(t, row.productCode) : null;
            const share = inTonnes > 0 ? (t / inTonnes) * 100 : null;
            const usual = USUAL_SHARE_PCT[row.productCode];
            const derived = (
              <span className="num text-[13px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
                {units === null ? <span style={{ color: 'var(--text-tertiary)' }}>–</span> : formatQty(units, 2)}
                <span className="ml-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  units
                </span>
              </span>
            );
            return (
              // On a desk the row reads left to right: what it is, how much of
              // it, then the derived margin. On a phone that same line is
              // 370px of content in a 327px viewport, so it becomes a stack —
              // the pile, then the weight, then the two derived figures on
              // their own line. Nothing is dropped; the reading order is the
              // same, just folded.
              <div
                key={row.key}
                className="flex flex-col gap-2 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3 sm:py-2"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                <select
                  value={row.productCode}
                  onChange={(e) =>
                    setOutputs((rows2) => rows2.map((r) => (r.key === row.key ? { ...r, productCode: e.target.value } : r)))
                  }
                  className={`${INPUT_CLASS} sm:w-[190px]`}
                  style={INPUT_STYLE}
                >
                  {PRODUCTS.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="flex items-center gap-2 sm:gap-3">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    placeholder="0.0"
                    value={row.tonnes}
                    onChange={(e) => editTonnes(row.key, e.target.value)}
                    className={`${INPUT_CLASS} num flex-1 text-right tabular-nums sm:w-[120px] sm:flex-none`}
                    style={INPUT_STYLE}
                  />
                  <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
                    MT
                  </span>
                </span>

                {/* The right margin: everything here is derived, never keyed. */}
                <span className="flex flex-wrap items-center gap-x-6 gap-y-1 sm:ml-auto sm:flex-nowrap">
                  <span className="w-full text-[12px] sm:w-[150px] sm:text-right" style={{ color: 'var(--text-secondary)' }}>
                    {share === null ? (
                      <span className="font-serif italic" style={{ color: 'var(--text-tertiary)' }}>
                        share shows once boulder is keyed
                      </span>
                    ) : (
                      <>
                        <span className="num tabular-nums">{formatQty(share, 1)}%</span> of input
                        <span className="ml-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {usual === undefined ? '· no usual share' : `· usually ${usual}%`}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="sm:w-[120px] sm:text-right">{row.suggested ? <Provisional>{derived}</Provisional> : derived}</span>
                  <button
                    type="button"
                    onClick={() => setOutputs((rows2) => rows2.filter((r) => r.key !== row.key))}
                    className={`${TEXT_BUTTON_CLASS} ml-auto text-[12px] sm:ml-0`}
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Remove
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        {/* THE SPLIT, DRAWN. One trunk, one ribbon per pile, and the gap drawn
            rather than left out — a bar chart of six co-products would lose the
            only fact that matters, which is that they all came off one heap. */}
        <div className="mt-5 px-6">
          {inTonnes > 0 && liveFlow.length > 0 ? (
            <>
              {/* A flow needs a trunk, a run of ribbon and a label gutter. Below
                  520px the ribbons collapse to a 13px stub and the diagram
                  stops saying anything, so on a phone it keeps its width and
                  scrolls inside itself rather than squashing. The left padding
                  is the room the input label needs — a scroll box clips at its
                  padding edge, and "Boulder fed in" sits outside the plot. */}
              <div className="overflow-x-auto pl-4 sm:overflow-visible sm:pl-0">
                <div className="min-w-[520px] sm:min-w-0">
                  <YieldFlow
                    inputLabel="Boulder fed in"
                    inputValue={inTonnes}
                    outputs={liveFlow}
                    lossLabel="Unaccounted"
                    unit="MT"
                    height={Math.max(220, 46 * (liveFlow.length + 1))}
                    format={(v) => formatQty(v, 1)}
                    summary={`${formatQty(inTonnes, 1)} MT of boulder splitting into ${liveFlow.length} co-product${
                      liveFlow.length === 1 ? '' : 's'
                    } totalling ${formatQty(outTonnes, 1)} MT, leaving ${formatQty(Math.abs(diffTonnes), 1)} MT (${formatQty(
                      Math.abs(diffPct),
                      1,
                    )}%) unaccounted for.`}
                  />
                </div>
              </div>
              <ChartCaption>
                Drift is measured against the mix this crusher normally runs, so a ribbon reading
                &ldquo;+6.2 vs usual&rdquo; means the screen deck or the cone setting moved, not that the shift was
                good or bad. Watch M-Sand and dust together — dust climbing while M-Sand falls is a worn VSI rotor
                tip, and it shows here days before anyone opens the machine.
              </ChartCaption>
            </>
          ) : (
            <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              The split draws itself once boulder in and at least one pile are keyed.
            </p>
          )}
        </div>

        {/* THE BALANCE STRIP — pinned, live, and never a blocking error.
            It stops being pinned below md. Three figures, a stamp and a
            sentence stack to roughly 170px on a phone, which pinned would be a
            third of the viewport parked on top of the fields being keyed — and
            it would land exactly where the fixed tab bar already is. Unpinned
            it still sits directly under the outputs, which on a phone is the
            only place the eye is anyway. */}
        <div
          className="static z-10 mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3 md:sticky md:bottom-0 md:gap-x-10"
          style={{
            background: 'var(--surface-sunken)',
            borderTop: '1px solid var(--border-strong)',
            borderBottom: '1px solid var(--border-strong)',
          }}
        >
          <Figure label="Boulder in" value={inTonnes > 0 ? formatQty(inTonnes, 1) : '–'} />
          <Figure label="Product out" value={outTonnes > 0 ? formatQty(outTonnes, 1) : '–'} />
          <Figure
            label="Unaccounted"
            value={inTonnes > 0 ? formatQty(diffTonnes, 1) : '–'}
            suffix={inTonnes > 0 ? `${formatQty(diffPct, 1)}%` : undefined}
            emphasis={outOfBand}
            tone={outOfBand ? 'var(--status-attention)' : undefined}
          />
          <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 md:w-auto md:flex-1">
            {inTonnes === 0 ? null : (
              <StatusStamp
                status={outOfBand ? 'attention' : 'ready'}
                label={outOfBand ? 'Off band' : 'In band'}
                severity={`±${BAND_PCT}%`}
              />
            )}
            <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-secondary)' }}>
              {inTonnes === 0
                ? 'Key the boulder weight and the balance runs itself.'
                : !outOfBand
                  ? 'Moisture, dust and fines explain a gap this size. Nothing to chase.'
                  : diffPct > 0
                    ? `${formatQty(Math.abs(diffTonnes), 1)} MT went in and has not landed in any pile — about ${formatQty(Math.abs(diffTonnes) / 20, 1)} tipper loads with no paper against them.`
                    : `Output exceeds boulder fed in. Either a weighbridge ticket for the shift is missing, or yesterday's stockpile got counted into tonight.`}
            </span>
          </span>
        </div>
      </Section>

      <Section caption="Fourteen shifts" title="Has the plant been balancing?">
        <div className="px-6">
          {/* Fourteen day/night labels and a 96px direct-label gutter do not
              fit in 327px. The chart keeps its measure and scrolls sideways
              inside this box; the page itself never does. */}
          <div className="overflow-x-auto sm:overflow-visible">
            <div className="min-w-[520px] sm:min-w-0">
              <TrendChart
                data={balanceSeries}
                summary={
                  offBandRows.length === 0
                    ? `Mass balance stayed inside ±${BAND_PCT}% across all ${balanceSeries.length} recent shifts.`
                    : `${offBandRows.length} of ${rows.length} shifts fell outside ±${BAND_PCT}%, the worst at ${formatQty(
                        offBandRows.reduce((w, r) => (Math.abs(r.massBalancePct) > Math.abs(w) ? r.massBalancePct : w), 0),
                        1,
                      )}%.`
                }
                seriesLabel="Unaccounted"
                band={{ from: -BAND_PCT, to: BAND_PCT }}
                flagBelow={-BAND_PCT}
                flagAbove={BAND_PCT}
                height={190}
                format={(v) => `${formatQty(v, 0)}%`}
              />
            </div>
          </div>
          <ChartCaption>
            The shaded band is the tolerance moisture and fines can honestly explain. One shift outside it is a bad
            weighbridge ticket; a run of them drifting the same way is material leaving the yard, and the shift that
            broke the pattern is the one to open first. D and N mark day and night — night shifts drifting alone
            usually means the gate weighman went home.
          </ChartCaption>
        </div>
      </Section>

      <Section
        caption="Every shift already logged at this plant"
        title="Recent runs"
        actions={
          // One wrapping child rather than three rigid siblings: the section
          // header does not wrap, so two chips and a stamp would push the page
          // sideways on a phone.
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Chip active={!offBandOnly} onClick={() => setOffBandOnly(false)}>
              All {rows.length}
            </Chip>
            <Chip active={offBandOnly} onClick={() => setOffBandOnly(true)}>
              Off band {offBandRows.length}
            </Chip>
            <AsOfStamp asOf="14:42" source="v_production_runs" freshness="materialised" />
          </div>
        }
      >
        <DataTable
          density={density}
          columns={columns}
          rows={visibleRows}
          rowKey={(r) => r.id}
          selectedKey={selected?.id}
          onRowClick={(r) => setSelected(r)}
          rail={(r) => ({
            provenance: r.provenance,
            ...(Math.abs(r.massBalancePct) > BAND_PCT ? { status: 'attention' as const } : {}),
          })}
          empty={
            offBandOnly ? (
              <EmptyState
                fact="No shift here is outside the band."
                because="Every run logged at this plant balances within ±8%, so there is nothing to chase."
              />
            ) : (
              <EmptyState
                fact="No shifts recorded at this site."
                because="Crushing is logged per plant — the quarry and the workshop have no runs of their own."
              />
            )
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        width="form"
        title={selected ? `${selected.shift === 'day' ? 'Day' : 'Night'} shift · ${formatDate(selected.date)}` : ''}
        identifier={selected?.id.toUpperCase()}
        {...(selected
          ? {
              status: {
                family: Math.abs(selected.massBalancePct) > BAND_PCT ? ('attention' as const) : ('ready' as const),
                label: Math.abs(selected.massBalancePct) > BAND_PCT ? 'Off band' : 'In band',
                severity: `${formatQty(selected.massBalancePct, 1)}%`,
                ...(selected.provenance === 'proposed' ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={selected ? `${selected.operator.toUpperCase()} · ${formatDayMonth(selected.date)}` : undefined}
        footer={
          selected ? (
            <>
              <Button onClick={() => adoptRun(selected)}>Copy this split into the form</Button>
              {phone ? null : (
                <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  Lands unconfirmed until each figure is corrected or accepted.
                </span>
              )}
            </>
          ) : null
        }
      >
        {selected ? (
          <>
            <RunDetail run={selected} />
            {phone ? (
              <p className="mt-5 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                Lands unconfirmed until each figure is corrected or accepted.
              </p>
            ) : null}
          </>
        ) : null}
      </SideSheet>

      <ConfirmModal
        open={confirmOffBand}
        onClose={() => setConfirmOffBand(false)}
        onConfirm={record}
        title="This shift does not balance"
        confirmLabel="Record it as keyed"
        consequence={
          diffTonnes > 0 ? (
            <>
              {formatQty(inTonnes, 1)} MT of boulder went in and {formatQty(outTonnes, 1)} MT came out as product.{' '}
              {formatQty(Math.abs(diffTonnes), 1)} MT — roughly {formatQty(Math.abs(diffTonnes) / 20, 1)} tipper loads —
              is not in any pile. That is {formatQty(Math.abs(diffPct), 1)}% against a band of ±{BAND_PCT}%. The shift
              will be saved exactly as you keyed it and flagged for the plant manager. Nothing is corrected for you.
            </>
          ) : (
            <>
              {formatQty(outTonnes, 1)} MT of product came out of {formatQty(inTonnes, 1)} MT of boulder —{' '}
              {formatQty(Math.abs(diffTonnes), 1)} MT more than went in, or {formatQty(Math.abs(diffPct), 1)}% against a
              band of ±{BAND_PCT}%. Either a weighbridge ticket for the shift is missing, or yesterday's stockpile has
              been counted into tonight. The shift will be saved exactly as you keyed it and flagged.
            </>
          )
        }
      />
    </>
  );
}

/**
 * The whole shift, opened from one row.
 *
 * The table can show hours and a balance percentage; it cannot show WHICH pile
 * ran thin. That is the reason this sheet exists — the same yield flow the
 * operator watched while keying, redrawn for a shift that is already history.
 */
function RunDetail({ run }: { run: ProductionRun }) {
  const outTotal = Math.round(run.outputs.reduce((s, o) => s + o.tonnes, 0) * 10) / 10;
  const diff = Math.round((run.boulderInTonnes - outTotal) * 10) / 10;
  const offBand = Math.abs(run.massBalancePct) > BAND_PCT;
  const site = SITES.find((s) => s.id === run.siteId);
  const utilisation = run.runHours + run.downtimeHours;

  return (
    <>
      <SheetSection caption="The shift">
        <DetailGrid>
          <Detail label="Date">{formatDate(run.date)}</Detail>
          <Detail label="Shift">{run.shift === 'day' ? 'Day · 06:00–18:00' : 'Night · 18:00–06:00'}</Detail>
          <Detail label="Crusher">{run.crusher}</Detail>
          <Detail label="Operator">{run.operator}</Detail>
          <Detail label="Plant">{site?.name ?? run.siteId}</Detail>
          <Detail label="Recorded by">{run.provenance === 'proposed' ? 'Suggested, unconfirmed' : 'Keyed by hand'}</Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="Hours">
        <DetailGrid>
          <Detail label="Ran">
            <QuantityCell value={run.runHours} decimals={1} uom="h" />
          </Detail>
          <Detail label="Stood still">
            <QuantityCell value={run.downtimeHours} decimals={1} uom="h" />
          </Detail>
          <Detail label="Because" wide>
            {run.downtimeReason ?? (run.downtimeHours > 0 ? 'Not stated' : 'Ran clean all shift')}
          </Detail>
        </DetailGrid>
        <Note>
          {run.downtimeHours === 0
            ? 'No stoppage logged, so every hour of this shift is answerable to the tonnage above.'
            : `${formatQty((run.downtimeHours / utilisation) * 100, 0)}% of the shift stood still. At this plant's usual rate that is about ${formatQty(
                run.downtimeHours * 25,
                0,
              )} MT of boulder never fed.`}
        </Note>
      </SheetSection>

      <SheetSection caption="What one heap became">
        {/* The sheet is 640px on a desk and the full screen on a phone. The
            flow keeps one measure and scrolls inside itself at the narrow end. */}
        <div className="overflow-x-auto pl-3 sm:overflow-visible sm:pl-0">
          <div className="min-w-[500px] sm:min-w-0">
            <YieldFlow
              inputLabel="Boulder in"
              inputValue={run.boulderInTonnes}
              outputs={flowOutputs(run.outputs)}
              lossLabel="Unaccounted"
              unit="MT"
              height={Math.max(220, 44 * (run.outputs.length + 1))}
              format={(v) => formatQty(v, 1)}
              summary={`${formatQty(run.boulderInTonnes, 1)} MT of boulder became ${formatQty(
                outTotal,
                1,
              )} MT across ${run.outputs.length} co-products, with ${formatQty(Math.abs(diff), 1)} MT unaccounted.`}
            />
          </div>
        </div>
      </SheetSection>

      <SheetSection caption={`Every pile off this boulder (${run.outputs.length})`}>
        <ul className="text-[13px]">
          {run.outputs.map((o) => {
            const share = (o.tonnes / run.boulderInTonnes) * 100;
            const usual = USUAL_SHARE_PCT[o.productCode];
            const drift = usual === undefined ? null : share - usual;
            const tonnesCell = <QuantityCell value={o.tonnes} decimals={1} uom="MT" />;
            return (
              // Pile, units, tonnes and drift are 420px of line in a 335px
              // sheet. On a phone the pile name takes its own line and the
              // three figures sit under it, spread across the width.
              <li
                key={o.productCode}
                className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                <span style={{ color: 'var(--text-primary)' }}>{productLabel(o.productCode)}</span>
                <span className="flex items-baseline justify-between gap-4 sm:justify-end">
                  <span style={{ color: 'var(--text-secondary)' }}>
                    <QuantityCell value={o.units} decimals={1} uom="units" />
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>
                    {run.provenance === 'proposed' ? <Provisional>{tonnesCell}</Provisional> : tonnesCell}
                  </span>
                  <span
                    className="num text-right tabular-nums text-[12px] sm:w-[132px]"
                    style={{
                      color: drift !== null && Math.abs(drift) > 3 ? 'var(--status-attention)' : 'var(--text-tertiary)',
                    }}
                  >
                    {formatQty(share, 1)}%
                    {drift === null
                      ? ' · no usual share'
                      : ` · ${drift >= 0 ? '+' : ''}${formatQty(drift, 1)} vs usual`}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </SheetSection>

      <SheetSection
        caption="Mass balance"
        actions={
          <StatusStamp
            status={offBand ? 'attention' : 'ready'}
            label={offBand ? 'Off band' : 'In band'}
            severity={`±${BAND_PCT}%`}
          />
        }
      >
        <DetailGrid>
          <Detail label="Boulder in">
            <QuantityCell value={run.boulderInTonnes} decimals={1} uom="MT" />
          </Detail>
          <Detail label="Product out">
            <QuantityCell value={outTotal} decimals={1} uom="MT" />
          </Detail>
          <Detail label="Unaccounted">
            <QuantityCell value={diff} decimals={1} uom="MT" />
          </Detail>
          <Detail label="As a share of input">
            <span className="num tabular-nums" style={{ color: offBand ? 'var(--status-attention)' : undefined }}>
              {formatQty(run.massBalancePct, 1)}%
            </span>
          </Detail>
        </DetailGrid>
        <Note>
          {!offBand
            ? 'Moisture leaving the pile, fines off the belt and an unsquare last bucket explain a gap this size. Nothing to chase.'
            : diff > 0
              ? `${formatQty(Math.abs(diff), 1)} MT left the yard without paper against it — about ${formatQty(
                  Math.abs(diff) / 20,
                  1,
                )} tipper loads. Start with the gate register for this shift, not with the operator.`
              : 'More product than boulder. A weighbridge ticket for the feed is missing, or an old stockpile was counted into this shift.'}
        </Note>
      </SheetSection>

      <SheetSection caption="Provenance">
        <Detail label="How this record was made" wide>
          {run.provenance === 'proposed'
            ? 'Proposed from the usual mix and never confirmed by the operator'
            : 'Keyed by the shift operator from weighbridge tickets'}
        </Detail>
        {run.provenance === 'proposed' ? (
          <Note>
            Every tonnage here is an estimate the system offered, which is why the figures carry the unconfirmed mark.
            It counts towards nothing in stock or costing until someone at the plant accepts it.
          </Note>
        ) : (
          <Note>
            Tonnages came off weighbridge tickets for the shift. Units are derived from the density table, never keyed.
          </Note>
        )}
      </SheetSection>
    </>
  );
}

/**
 * One control measure for every field on this screen.
 *
 * 44px and 16px on a touch pointer, 34px and 13px on a desk — keyed to hover
 * rather than width, because a weighbridge terminal is a wide screen a wet
 * thumb still has to hit. The 16px is not decoration: iOS zooms the whole page
 * when a field under 16px takes focus, which on this form throws the operator
 * out of the mass-balance strip mid-entry.
 */
const INPUT_CLASS =
  'h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[13px]';

/** A text button that still clears 44px where there is no mouse. */
const TEXT_BUTTON_CLASS = 'inline-flex min-h-11 items-center [@media(hover:hover)]:min-h-0';
const INPUT_STYLE: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

function Field({
  label,
  unit,
  help,
  children,
}: {
  label: string;
  unit?: string;
  help?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
        {label}
        {unit ? <span className="ml-1 normal-case">{unit}</span> : null}
      </span>
      {children}
      {help ? (
        <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-secondary)' }}>
          {help}
        </span>
      ) : null}
    </label>
  );
}

/**
 * The three balance figures. Weight 600 lands on the difference and only while
 * it is outside the band — one of exactly two places in the product where it
 * appears at all.
 */
function Figure({
  label,
  value,
  suffix,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  suffix?: string | undefined;
  emphasis?: boolean;
  tone?: string | undefined;
}) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {label}
        <span className="ml-1 not-italic">MT</span>
      </span>
      <span
        className="num leading-none tabular-nums"
        style={{ color: tone ?? 'var(--text-primary)', fontWeight: emphasis ? 600 : 400, letterSpacing: '-0.02em' }}
      >
        <span className="text-[22px]">{value}</span>
        {suffix ? <span className="ml-2 text-[14px]">{suffix}</span> : null}
      </span>
    </span>
  );
}

const columns: Column<ProductionRun>[] = [
  {
    key: 'date',
    header: 'Date',
    sticky: true,
    width: 118,
    group: 'Shift',
    render: (r) => formatDate(r.date),
  },
  { key: 'shift', header: 'Shift', width: 74, group: 'Shift', render: (r) => (r.shift === 'day' ? 'Day' : 'Night') },
  { key: 'crusher', header: 'Crusher', group: 'Shift', render: (r) => r.crusher },
  { key: 'operator', header: 'Operator', group: 'Shift', render: (r) => r.operator },
  {
    key: 'runHours',
    header: 'Run',
    unit: 'h',
    type: 'num',
    width: 82,
    group: 'Hours',
    render: (r) => <QuantityCell value={r.runHours} decimals={1} />,
  },
  {
    key: 'downtime',
    header: 'Stood still',
    unit: 'h',
    type: 'num',
    width: 104,
    group: 'Downtime',
    render: (r) => (
      <span style={{ color: r.downtimeHours > 1.5 ? 'var(--status-attention)' : undefined }}>
        <QuantityCell value={r.downtimeHours} decimals={1} />
      </span>
    ),
  },
  {
    key: 'reason',
    header: 'Because',
    width: 180,
    group: 'Downtime',
    // A cause is a fact about the shift, so it sets in the data face like any
    // other. No reason at all renders an en dash — "stood still for nothing
    // stated" and "never stood still" are not the same record.
    render: (r) => (r.downtimeReason ? <span style={{ color: 'var(--text-secondary)' }}>{r.downtimeReason}</span> : <Dash />),
  },
  {
    key: 'in',
    header: 'Boulder in',
    unit: 'MT',
    type: 'num',
    width: 116,
    group: 'Mass balance',
    render: (r) => <QuantityCell value={r.boulderInTonnes} decimals={1} />,
  },
  {
    key: 'out',
    header: 'Product out',
    unit: 'MT',
    type: 'num',
    width: 120,
    group: 'Mass balance',
    render: (r) => <QuantityCell value={r.outputs.reduce((s, o) => s + o.tonnes, 0)} decimals={1} />,
  },
  {
    key: 'balance',
    header: 'Unaccounted',
    unit: '%',
    type: 'num',
    width: 128,
    group: 'Mass balance',
    render: (r) => (
      <span style={{ color: Math.abs(r.massBalancePct) > BAND_PCT ? 'var(--status-attention)' : undefined }}>
        <QuantityCell value={r.massBalancePct} decimals={1} />
      </span>
    ),
  },
];
