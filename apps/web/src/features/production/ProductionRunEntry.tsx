import { useMemo, useState } from 'react';
import { businessDate, formatDate, formatQty, PRODUCT_DENSITIES, tonnesToUnits } from '@linck/domain';
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
import { useWords } from '../../i18n/words.js';
import { useDayMonth } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { DOWNTIME_REASONS, shiftWords, unitWords, type DowntimeReason } from './words.js';

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
 *
 * LIN-23: this screen is filled in by crusher operators, so it says as little
 * as it can, in English or Tamil (./words.ts): "Stone in", "Product out", and
 * a gap that is either "Missing" or "Extra" — never a signed percentage they
 * have to interpret.
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

/** Tonnes on one tipper, for saying a gap in loads. */
const TONNES_PER_LOAD = 20;

/** Boulder this plant feeds in an hour — how a stoppage is said in tonnes. */
const USUAL_TONNES_PER_HOUR = 25;

type Words = (typeof shiftWords)['en'];
type Units = (typeof unitWords)['en'];

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

/** A stop reason in the reader's language; one typed some other way stays as typed. */
function reasonLabel(raw: string, t: Words): string {
  return (DOWNTIME_REASONS as readonly string[]).includes(raw) ? t.reasons[raw as DowntimeReason] : raw;
}

/**
 * Ribbons for the yield flow.
 *
 * The flow can print each ribbon's drift against the usual mix ("+6.2 vs
 * usual"), which says the screen deck or the cone setting moved — dust
 * climbing while M-Sand falls is a worn VSI rotor tip, days before anyone opens
 * the machine. That drift is not passed here: the chart prints it in English
 * only, and the same "usually 28%" already sits on each product line beside
 * it. A co-product this plant has no usual share for (GSB blended off the
 * fines, say) shows no usual share at all.
 */
function flowOutputs(entries: { productCode: string; tonnes: number }[]): FlowOutput[] {
  return entries.map((o) => ({ label: productLabel(o.productCode), value: o.tonnes }));
}

export function ProductionRunEntry() {
  const { siteScope, density } = useApp();
  const t = useWords(shiftWords);
  const u = useWords(unitWords);
  const dayMonth = useDayMonth();
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
  // Hours the plant stood still need a cause, or the utilisation report cannot
  // explain itself.
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
      const tonnes = num(o.tonnes);
      if (tonnes <= 0) continue;
      byCode.set(o.productCode, (byCode.get(o.productCode) ?? 0) + tonnes);
    }
    return flowOutputs([...byCode].map(([productCode, tonnes]) => ({ productCode, tonnes })));
  }, [outputs]);

  const columns = useMemo(() => buildColumns(t, u), [t, u]);

  function editTonnes(key: string, value: string) {
    setOutputs((rs) => rs.map((r) => (r.key === key ? { ...r, tonnes: value, suggested: false } : r)));
  }

  /** Filled figures stay marked as unconfirmed until each is corrected or accepted. */
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
   * operator in tonnes and then written exactly as keyed, and flagged for the
   * plant manager. Nothing is corrected for them. Blocking here just teaches
   * people to fudge the boulder figure until the form goes quiet.
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
      label: `${dayMonth(r.date)} ${r.shift === 'day' ? t.dayMark : t.nightMark}`,
      value: r.massBalancePct,
    }));

  const gapTonnes = Math.abs(diffTonnes);
  const gapPct = Math.abs(diffPct);

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        meta={<AsOfStamp asOf="14:42" source="v_production_runs" freshness="live" />}
        actions={
          // The header does not wrap and does not shrink its actions, so two
          // 44px buttons beside the title leave the h1 too little room. They
          // stack instead until there is room for both on one line.
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button onClick={() => setOutputs(seedOutputs())}>{t.clear}</Button>
            <Button variant="primary" disabled={!canRecord} onClick={attemptRecord}>
              {t.save}
            </Button>
          </div>
        }
      />

      <Section title={t.shift}>
        <div className="grid gap-x-6 gap-y-4 px-6 md:grid-cols-3 xl:grid-cols-4">
          <Field label={t.date}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT_CLASS} style={INPUT_STYLE} />
          </Field>
          {/* Not a <label> — a label wrapping buttons would fire the first chip. */}
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS} style={{ color: 'var(--text-tertiary)' }}>
              {t.shift}
            </span>
            {/* Two twelve-hour chips are wider than a phone. They wrap rather
                than shrink — a half-legible "Night · 6 pm –" is worse than two
                lines. */}
            <span className="flex min-h-11 flex-wrap items-center gap-2 [@media(hover:hover)]:min-h-[38px]">
              <Chip active={shift === 'day'} onClick={() => setShift('day')}>
                {t.dayHours}
              </Chip>
              <Chip active={shift === 'night'} onClick={() => setShift('night')}>
                {t.nightHours}
              </Chip>
            </span>
          </div>
          <Field label={t.crusher}>
            <select value={crusherValue} onChange={(e) => setCrusher(e.target.value)} className={INPUT_CLASS} style={INPUT_STYLE}>
              {crushers.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label={t.operator}>
            <select value={operator} onChange={(e) => setOperator(e.target.value)} className={INPUT_CLASS} style={INPUT_STYLE}>
              {operators.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
          <Field label={t.hoursRun}>
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
          <Field label={t.hoursStopped}>
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
          <Field label={t.whyStopped} help={reasonMissing ? t.chooseWhy : undefined}>
            {/* The stored value is the English code; only its words change. */}
            <select
              value={downtimeReason}
              onChange={(e) => setDowntimeReason(e.target.value)}
              disabled={downtime === 0}
              className={INPUT_CLASS}
              style={{ ...INPUT_STYLE, ...(reasonMissing ? { boxShadow: 'inset 0 0 0 1px var(--status-attention)' } : {}) }}
            >
              <option value="">{downtime === 0 ? t.didNotStop : t.choose}</option>
              {DOWNTIME_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t.reasons[r]}
                </option>
              ))}
            </select>
          </Field>
          {/* The weighbridge tickets for the shift, added up. */}
          <Field label={t.stoneIn} unit={u.tonne} help={t.stoneHelp}>
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
        title={t.productOut}
        actions={
          <button
            type="button"
            onClick={() => setOutputs((rows2) => [...rows2, { key: `out-${Date.now()}`, productCode: 'GSB', tonnes: '', suggested: false }])}
            className={`${TEXT_BUTTON_CLASS} text-[14px] font-medium`}
            style={{ color: 'var(--brand)' }}
          >
            + {t.addProduct}
          </button>
        }
      >
        {offerMix ? (
          <div className="px-6 pb-3">
            <SuggestionStrip onApply={applyUsualMix} onDismiss={() => setMixDismissed(true)} applyLabel={t.fill}>
              {t.fillOffer(formatQty(inTonnes, 1))}
            </SuggestionStrip>
          </div>
        ) : null}

        <div className="px-6">
          {outputs.map((row) => {
            const tonnes = num(row.tonnes);
            const units = PRODUCT_DENSITIES[row.productCode] && tonnes > 0 ? tonnesToUnits(tonnes, row.productCode) : null;
            const share = inTonnes > 0 ? (tonnes / inTonnes) * 100 : null;
            const usual = USUAL_SHARE_PCT[row.productCode];
            const derived = (
              <span className="num text-[13px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
                {units === null ? <span style={{ color: 'var(--text-tertiary)' }}>–</span> : formatQty(units, 2)}
                <span className="ml-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  {u.unit}
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
                  aria-label={t.product}
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
                    aria-label={`${productLabel(row.productCode)} — ${u.tonne}`}
                    value={row.tonnes}
                    onChange={(e) => editTonnes(row.key, e.target.value)}
                    className={`${INPUT_CLASS} num flex-1 text-right tabular-nums sm:w-[120px] sm:flex-none`}
                    style={INPUT_STYLE}
                  />
                  <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                    {u.tonne}
                  </span>
                </span>

                {/* The right margin: everything here is derived, never keyed. The
                    share appears once stone in is typed; before that the line
                    stays quiet rather than repeating a hint six times. */}
                <span className="flex flex-wrap items-center gap-x-6 gap-y-1 sm:ml-auto sm:flex-nowrap">
                  <span className="num w-full text-[12px] tabular-nums sm:w-[150px] sm:text-right" style={{ color: 'var(--text-secondary)' }}>
                    {share === null ? null : t.share(formatQty(share, 1), usual)}
                  </span>
                  <span className="sm:w-[120px] sm:text-right">{row.suggested ? <Provisional>{derived}</Provisional> : derived}</span>
                  <button
                    type="button"
                    onClick={() => setOutputs((rows2) => rows2.filter((r) => r.key !== row.key))}
                    className={`${TEXT_BUTTON_CLASS} ml-auto px-1 text-[13px] sm:ml-0`}
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {t.delete}
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
            /* A flow needs a trunk, a run of ribbon and a label gutter. Below
               520px the ribbons collapse to a 13px stub and the diagram stops
               saying anything, so on a phone it keeps its width and scrolls
               inside itself rather than squashing. The left padding is the room
               the input label needs — a scroll box clips at its padding edge,
               and "Stone in" sits outside the plot. */
            <div className="overflow-x-auto pl-4 sm:overflow-visible sm:pl-0">
              <div className="min-w-[520px] sm:min-w-0">
                <YieldFlow
                  inputLabel={t.stoneIn}
                  inputValue={inTonnes}
                  outputs={liveFlow}
                  lossLabel={t.missing}
                  unit={u.tonne}
                  height={Math.max(220, 46 * (liveFlow.length + 1))}
                  format={(v) => formatQty(v, 1)}
                  summary={t.flowSummary(formatQty(inTonnes, 1), formatQty(outTonnes, 1), formatQty(diffTonnes, 1), formatQty(diffPct, 1))}
                />
              </div>
            </div>
          ) : (
            <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {t.flowHint}
            </p>
          )}
        </div>

        {/* THE BALANCE STRIP — pinned, live, and never a blocking error.
            It stops being pinned below md. Three figures, a stamp and a
            sentence stack to roughly 170px on a phone, which pinned would be a
            third of the viewport parked on top of the fields being keyed — and
            it would land exactly where the fixed tab bar already is. Unpinned
            it still sits directly under the outputs, which on a phone is the
            only place the eye is anyway.

            Moisture, dust and fines explain a gap inside the band; outside it,
            material went in and did not land in any pile — or, the other way,
            a weighbridge ticket is missing or yesterday's stockpile got counted
            into tonight. */}
        <div
          className="static z-10 mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3 md:sticky md:bottom-0 md:gap-x-10"
          style={{
            background: 'var(--surface-sunken)',
            borderTop: '1px solid var(--border-strong)',
            borderBottom: '1px solid var(--border-strong)',
          }}
        >
          <Figure label={t.stoneIn} unit={u.tonne} value={inTonnes > 0 ? formatQty(inTonnes, 1) : '–'} />
          <Figure label={t.productOut} unit={u.tonne} value={outTonnes > 0 ? formatQty(outTonnes, 1) : '–'} />
          <Figure
            label={diffTonnes < 0 ? t.extra : t.missing}
            unit={u.tonne}
            value={inTonnes > 0 ? formatQty(gapTonnes, 1) : '–'}
            suffix={inTonnes > 0 ? `${formatQty(gapPct, 1)}%` : undefined}
            emphasis={outOfBand}
            tone={outOfBand ? 'var(--status-attention)' : undefined}
          />
          <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 md:w-auto md:flex-1">
            {inTonnes === 0 ? null : (
              <StatusStamp status={outOfBand ? 'attention' : 'ready'} label={outOfBand ? t.notOk : t.ok} severity={`±${BAND_PCT}%`} />
            )}
            <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-secondary)' }}>
              {inTonnes === 0
                ? t.typeStoneFirst
                : !outOfBand
                  ? t.normal
                  : diffPct > 0
                    ? t.missingLine(formatQty(gapTonnes, 1), formatQty(gapTonnes / TONNES_PER_LOAD, 1))
                    : t.moreOut}
            </span>
          </span>
        </div>
      </Section>

      {/* The shaded band is the tolerance moisture and fines can honestly
          explain. One shift outside it is a bad weighbridge ticket; a run of
          them drifting the same way is material leaving the yard, and the shift
          that broke the pattern is the one to open first. Night shifts drifting
          alone usually means the gate weighman went home. */}
      <Section title={t.trend.title}>
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
                    ? t.trend.allIn(balanceSeries.length, BAND_PCT)
                    : t.trend.someOut(
                        offBandRows.length,
                        rows.length,
                        BAND_PCT,
                        formatQty(
                          offBandRows.reduce((w, r) => (Math.abs(r.massBalancePct) > Math.abs(w) ? r.massBalancePct : w), 0),
                          1,
                        ),
                      )
                }
                seriesLabel={t.trend.series}
                band={{ from: -BAND_PCT, to: BAND_PCT }}
                flagBelow={-BAND_PCT}
                flagAbove={BAND_PCT}
                height={190}
                format={(v) => `${formatQty(v, 0)}%`}
              />
            </div>
          </div>
          <ChartCaption>{t.trend.note(BAND_PCT)}</ChartCaption>
        </div>
      </Section>

      <Section
        title={t.past.title}
        actions={
          // One wrapping child rather than three rigid siblings: the section
          // header does not wrap, so two chips and a stamp would push the page
          // sideways on a phone.
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Chip active={!offBandOnly} onClick={() => setOffBandOnly(false)} count={rows.length}>
              {t.past.all}
            </Chip>
            <Chip active={offBandOnly} onClick={() => setOffBandOnly(true)} count={offBandRows.length}>
              {t.notOk}
            </Chip>
            <AsOfStamp asOf="14:42" source="v_production_runs" freshness="materialised" />
          </div>
        }
      >
        {/* Crushing is logged per plant — the quarry and the workshop have no
            runs of their own, so they show the empty state. */}
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
          empty={offBandOnly ? <EmptyState fact={t.past.allOk} /> : <EmptyState fact={t.past.none} />}
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        width="form"
        title={selected ? t.sheet.title(selected.shift === 'day' ? t.day : t.night, formatDate(selected.date)) : ''}
        identifier={selected?.id.toUpperCase()}
        {...(selected
          ? {
              status: {
                family: Math.abs(selected.massBalancePct) > BAND_PCT ? ('attention' as const) : ('ready' as const),
                label: Math.abs(selected.massBalancePct) > BAND_PCT ? t.notOk : t.ok,
                severity: `${formatQty(selected.massBalancePct, 1)}%`,
                ...(selected.provenance === 'proposed' ? { provisional: true } : {}),
              },
            }
          : {})}
        revision={selected ? `${selected.operator.toUpperCase()} · ${dayMonth(selected.date)}` : undefined}
        footer={
          selected ? (
            <>
              <Button onClick={() => adoptRun(selected)}>{t.sheet.use}</Button>
              {/* The copied figures land unconfirmed until each is corrected or accepted. */}
              {phone ? null : (
                <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  {t.sheet.checkAfter}
                </span>
              )}
            </>
          ) : null
        }
      >
        {selected ? (
          <>
            <RunDetail run={selected} t={t} u={u} />
            {phone ? (
              <p className="mt-5 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {t.sheet.checkAfter}
              </p>
            ) : null}
          </>
        ) : null}
      </SideSheet>

      <ConfirmModal
        open={confirmOffBand}
        onClose={() => setConfirmOffBand(false)}
        onConfirm={record}
        title={t.confirm.title}
        confirmLabel={t.confirm.save}
        consequence={
          <>
            <p>{t.confirm.inOut(formatQty(inTonnes, 1), formatQty(outTonnes, 1))}</p>
            <p className="mt-2">
              {diffTonnes > 0
                ? t.confirm.missing(formatQty(gapTonnes, 1), formatQty(gapPct, 1), formatQty(gapTonnes / TONNES_PER_LOAD, 1))
                : t.confirm.extra(formatQty(gapTonnes, 1), formatQty(gapPct, 1))}
            </p>
            <p className="mt-2">{t.confirm.kept}</p>
          </>
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
function RunDetail({ run, t, u }: { run: ProductionRun; t: Words; u: Units }) {
  const outTotal = Math.round(run.outputs.reduce((s, o) => s + o.tonnes, 0) * 10) / 10;
  const diff = Math.round((run.boulderInTonnes - outTotal) * 10) / 10;
  const offBand = Math.abs(run.massBalancePct) > BAND_PCT;
  const site = SITES.find((s) => s.id === run.siteId);
  const utilisation = run.runHours + run.downtimeHours;

  return (
    <>
      {/* How the record was made. A proposed run is an estimate the system
          offered from the usual mix, which is why its figures carry the
          unconfirmed mark; it counts towards nothing in stock or costing until
          someone at the plant accepts it. A typed run came off the weighbridge
          tickets, and its units are derived from the density table, never keyed. */}
      <SheetSection caption={t.sheet.shift}>
        <DetailGrid>
          <Detail label={t.date}>{formatDate(run.date)}</Detail>
          <Detail label={t.shift}>{run.shift === 'day' ? t.dayHours : t.nightHours}</Detail>
          <Detail label={t.crusher}>{run.crusher}</Detail>
          <Detail label={t.operator}>{run.operator}</Detail>
          <Detail label={t.sheet.site}>{site?.name ?? run.siteId}</Detail>
          <Detail label={t.sheet.entered}>{run.provenance === 'proposed' ? t.sheet.suggested : t.sheet.typed}</Detail>
        </DetailGrid>
        {run.provenance === 'proposed' ? <Note>{t.sheet.suggestedNote}</Note> : null}
      </SheetSection>

      <SheetSection caption={t.sheet.hours}>
        <DetailGrid>
          <Detail label={t.sheet.ran}>
            <QuantityCell value={run.runHours} decimals={1} uom={u.hour} />
          </Detail>
          <Detail label={t.sheet.stopped}>
            <QuantityCell value={run.downtimeHours} decimals={1} uom={u.hour} />
          </Detail>
          <Detail label={t.whyStopped} wide>
            {run.downtimeReason ? reasonLabel(run.downtimeReason, t) : run.downtimeHours > 0 ? t.sheet.notGiven : t.didNotStop}
          </Detail>
        </DetailGrid>
        {run.downtimeHours > 0 ? (
          <Note>
            {t.sheet.stoppedNote(
              formatQty((run.downtimeHours / utilisation) * 100, 0),
              formatQty(run.downtimeHours * USUAL_TONNES_PER_HOUR, 0),
            )}
          </Note>
        ) : null}
      </SheetSection>

      <SheetSection caption={t.sheet.split}>
        {/* The sheet is 640px on a desk and the full screen on a phone. The
            flow keeps one measure and scrolls inside itself at the narrow end. */}
        <div className="overflow-x-auto pl-3 sm:overflow-visible sm:pl-0">
          <div className="min-w-[500px] sm:min-w-0">
            <YieldFlow
              inputLabel={t.stoneIn}
              inputValue={run.boulderInTonnes}
              outputs={flowOutputs(run.outputs)}
              lossLabel={t.missing}
              unit={u.tonne}
              height={Math.max(220, 44 * (run.outputs.length + 1))}
              format={(v) => formatQty(v, 1)}
              summary={t.flowSummary(formatQty(run.boulderInTonnes, 1), formatQty(outTotal, 1), formatQty(diff, 1), formatQty(run.massBalancePct, 1))}
            />
          </div>
        </div>
      </SheetSection>

      <SheetSection caption={t.sheet.products(run.outputs.length)}>
        <ul className="text-[13px]">
          {run.outputs.map((o) => {
            const share = (o.tonnes / run.boulderInTonnes) * 100;
            const usual = USUAL_SHARE_PCT[o.productCode];
            const drift = usual === undefined ? null : share - usual;
            const tonnesCell = <QuantityCell value={o.tonnes} decimals={1} uom={u.tonne} />;
            return (
              // Pile, units, tonnes and share are 420px of line in a 335px
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
                    <QuantityCell value={o.units} decimals={1} uom={u.unit} />
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>
                    {run.provenance === 'proposed' ? <Provisional>{tonnesCell}</Provisional> : tonnesCell}
                  </span>
                  {/* More than three points off the usual share is a setting
                      that moved, so it takes the attention colour. */}
                  <span
                    className="num text-right tabular-nums text-[12px] sm:w-[150px]"
                    style={{
                      color: drift !== null && Math.abs(drift) > 3 ? 'var(--status-attention)' : 'var(--text-tertiary)',
                    }}
                  >
                    {t.sheet.share(formatQty(share, 1), usual)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </SheetSection>

      <SheetSection
        caption={t.sheet.balance}
        actions={<StatusStamp status={offBand ? 'attention' : 'ready'} label={offBand ? t.notOk : t.ok} severity={`±${BAND_PCT}%`} />}
      >
        <DetailGrid>
          <Detail label={t.stoneIn}>
            <QuantityCell value={run.boulderInTonnes} decimals={1} uom={u.tonne} />
          </Detail>
          <Detail label={t.productOut}>
            <QuantityCell value={outTotal} decimals={1} uom={u.tonne} />
          </Detail>
          <Detail label={diff < 0 ? t.extra : t.missing}>
            <span className="num tabular-nums" style={{ color: offBand ? 'var(--status-attention)' : undefined }}>
              <QuantityCell value={Math.abs(diff)} decimals={1} uom={u.tonne} /> · {formatQty(Math.abs(run.massBalancePct), 1)}%
            </span>
          </Detail>
        </DetailGrid>
        {/* Off band and short: start with the gate register for this shift,
            not with the operator. Off band and over: a weighbridge ticket for
            the feed is missing, or an old stockpile was counted into this shift. */}
        <Note>
          {!offBand
            ? t.normal
            : diff > 0
              ? t.sheet.missingNote(formatQty(Math.abs(diff), 1), formatQty(Math.abs(diff) / TONNES_PER_LOAD, 1))
              : t.moreOut}
        </Note>
      </SheetSection>
    </>
  );
}

/**
 * One control measure for every field on this screen.
 *
 * 44px and 16px on a touch pointer, 38px and 14px on a desk — the same height
 * as the buttons, keyed to hover rather than width, because a weighbridge
 * terminal is a wide screen a wet thumb still has to hit. The 16px is not
 * decoration: iOS zooms the whole page when a field under 16px takes focus,
 * which on this form throws the operator out of the balance strip mid-entry.
 */
const INPUT_CLASS =
  'h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[38px] [@media(hover:hover)]:text-[14px]';

/** Field labels: a size up from the table headers, because this form is read in a crusher cabin. */
const LABEL_CLASS = 'text-[12px] uppercase tracking-[0.04em]';

/** A text button that still clears 44px where there is no mouse. */
const TEXT_BUTTON_CLASS = 'inline-flex min-h-11 items-center [@media(hover:hover)]:min-h-[38px]';
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
      <span className={LABEL_CLASS} style={{ color: 'var(--text-tertiary)' }}>
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
  unit,
  value,
  suffix,
  emphasis,
  tone,
}: {
  label: string;
  unit: string;
  value: string;
  suffix?: string | undefined;
  emphasis?: boolean;
  tone?: string | undefined;
}) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {label}
        <span className="ml-1 not-italic">{unit}</span>
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

function buildColumns(t: Words, u: Units): Column<ProductionRun>[] {
  return [
    {
      key: 'date',
      header: t.columns.date,
      sticky: true,
      width: 118,
      render: (r) => formatDate(r.date),
    },
    { key: 'shift', header: t.columns.shift, width: 80, render: (r) => (r.shift === 'day' ? t.day : t.night) },
    { key: 'crusher', header: t.columns.crusher, render: (r) => r.crusher },
    { key: 'operator', header: t.columns.operator, render: (r) => r.operator },
    {
      key: 'runHours',
      header: t.columns.ran,
      type: 'num',
      width: 100,
      render: (r) => <QuantityCell value={r.runHours} decimals={1} />,
    },
    {
      key: 'downtime',
      header: t.columns.stopped,
      type: 'num',
      width: 116,
      render: (r) => (
        <span style={{ color: r.downtimeHours > 1.5 ? 'var(--status-attention)' : undefined }}>
          <QuantityCell value={r.downtimeHours} decimals={1} />
        </span>
      ),
    },
    {
      key: 'reason',
      header: t.columns.why,
      width: 180,
      // A cause is a fact about the shift, so it sets in the data face like any
      // other. No reason at all renders an en dash — "stood still for nothing
      // stated" and "never stood still" are not the same record.
      render: (r) => (r.downtimeReason ? <span style={{ color: 'var(--text-secondary)' }}>{reasonLabel(r.downtimeReason, t)}</span> : <Dash />),
    },
    {
      key: 'in',
      header: t.columns.stoneIn,
      unit: u.tonne,
      type: 'num',
      width: 128,
      render: (r) => <QuantityCell value={r.boulderInTonnes} decimals={1} />,
    },
    {
      key: 'out',
      header: t.columns.productOut,
      unit: u.tonne,
      type: 'num',
      width: 136,
      render: (r) => <QuantityCell value={r.outputs.reduce((s, o) => s + o.tonnes, 0)} decimals={1} />,
    },
    {
      key: 'balance',
      header: t.columns.gap,
      unit: '%',
      type: 'num',
      width: 120,
      render: (r) => (
        <span style={{ color: Math.abs(r.massBalancePct) > BAND_PCT ? 'var(--status-attention)' : undefined }}>
          <QuantityCell value={r.massBalancePct} decimals={1} />
        </span>
      ),
    },
  ];
}
