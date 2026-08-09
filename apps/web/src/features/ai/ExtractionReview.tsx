import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime, formatTime } from '@linck/domain';
import { EXTRACTION_JOBS, SITES, type ExtractedField, type ExtractionJob } from '@linck/mock';
import {
  AsOfStamp,
  BarChart,
  Button,
  ChartCaption,
  Chip,
  ConfidenceMeter,
  ConfirmModal,
  Detail,
  DetailGrid,
  EmptyState,
  HeatGrid,
  IdCell,
  Note,
  PageHeader,
  ProportionBar,
  Provisional,
  Section,
  SheetSection,
  SideSheet,
  StatusStamp,
  type HeatCell,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';

/**
 * THE EXTRACTION REVIEW QUEUE.
 *
 * The governing idea, and the reason this screen exists at all: Linck is a very
 * fast clerk with excellent handwriting and NO AUTHORITY. It may write in
 * pencil on onionskin. It may never write in ink and it may never post to the
 * ledger. Every value here is hatched until a person looks at the paper and
 * agrees with it.
 *
 * Two consequences shape the layout:
 *   - Fields are ordered by ASCENDING CONFIDENCE, worst first, because tab
 *     order should follow uncertainty rather than the layout of the bill.
 *   - AI values render at FULL CONTRAST. Dimming or italicising them would
 *     make the one task on this screen — reading a number against a scan —
 *     harder, and that produces wrong data. Provenance is carried by the
 *     hatch, the dashed rule and the extraction mark, never by legibility.
 */

interface FieldDraft {
  value: string;
  confirmed: boolean;
  /** The machine's original reading, kept the moment a human overrides it. */
  originalValue: string | null;
}

type DraftMap = Record<string, Record<string, FieldDraft>>;

type DocType = ExtractionJob['documentType'];

const FILTERS: { key: DocType | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything captured' },
  { key: 'diesel_bill', label: 'Diesel bills' },
  { key: 'weighbridge_slip', label: 'Weighbridge slips' },
  { key: 'vendor_invoice', label: 'Vendor invoices' },
  { key: 'insurance_renewal', label: 'Renewals' },
];

const DOC_TYPES: readonly DocType[] = ['diesel_bill', 'weighbridge_slip', 'vendor_invoice', 'insurance_renewal'];

const DOC_LABEL: Record<DocType, string> = {
  diesel_bill: 'Diesel bills',
  weighbridge_slip: 'Weighbridge slips',
  vendor_invoice: 'Vendor invoices',
  insurance_renewal: 'Renewals',
};

/**
 * The three confidence bands in the reviewer's words rather than the model's.
 * A reviewer does not care that a field scored 0.71; they care whether they are
 * checking it or reading past it.
 */
const CONFIDENCE_LABEL: Record<1 | 2 | 3, string> = {
  3: 'Read cleanly',
  2: 'Worth a look',
  1: 'Below the floor',
};

/**
 * OVERRIDE RATE BY DOCUMENT TYPE, SIX WEEKS.
 *
 * The only honest measure of extraction quality is how often a person had to
 * change what the machine read before posting it. Accuracy claimed by the model
 * about itself is worth nothing; an override is a human, holding the paper,
 * disagreeing.
 *
 * SOURCE, stated plainly: this is a demo series held in this file, not a
 * reading from the ledger. In the product it is `v_extraction_override_rate`, a
 * weekly roll-up of the review log keyed on `overriddenFrom` being non-null.
 * The shape is drawn from a real failure mode — a fuel outlet changing its
 * printer, which the model has never seen and the reviewer notices first.
 */
const OVERRIDE_WEEKS = ['W27', 'W28', 'W29', 'W30', 'W31', 'W32'];

const OVERRIDE_RATE: Record<DocType, number[]> = {
  diesel_bill: [0.06, 0.07, 0.09, 0.16, 0.27, 0.34],
  weighbridge_slip: [0.04, 0.05, 0.03, 0.04, 0.05, 0.04],
  vendor_invoice: [0.12, 0.11, 0.13, 0.1, 0.12, 0.11],
  insurance_renewal: [0.08, 0.09, 0.07, 0.08, 0.06, 0.07],
};

/** Above this, a document type is no longer being read — it is being retyped. */
const DRIFT_THRESHOLD = 0.25;

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The masthead of the paper each job was photographed from. */
const MASTHEAD: Record<DocType, { name: string; sub: string; kind: string }> = {
  diesel_bill: { name: 'SAKTHI FUELS', sub: 'GST ROAD, KARAPAKKAM · HSD RETAIL OUTLET · 33AABCS9921K1Z4', kind: 'CASH MEMO / FUEL BILL' },
  weighbridge_slip: { name: 'KRP WEIGHBRIDGE', sub: '60 MT ELECTRONIC PLATFORM · LIC 33/WB/2019 · STAMPED 04-2026', kind: 'WEIGHMENT SLIP' },
  vendor_invoice: { name: 'ANNAI TYRES', sub: 'AMBATTUR INDUSTRIAL ESTATE, CHENNAI 600058 · 33AAECA1234F1ZP', kind: 'TAX INVOICE' },
  insurance_renewal: { name: 'UNITED INDIA INSURANCE', sub: 'DIVISIONAL OFFICE 33 · MOTOR — GOODS CARRYING VEHICLE', kind: 'POLICY SCHEDULE' },
};

/** Identifiers get the mono face with a slashed zero; measured values do not. */
const ID_FIELDS = new Set(['vehicle', 'bill_no', 'ticket', 'policy', 'invoice_no', 'gstin']);

function seedDrafts(): DraftMap {
  const out: DraftMap = {};
  for (const job of EXTRACTION_JOBS) {
    const fields: Record<string, FieldDraft> = {};
    for (const f of job.fields) fields[f.key] = { value: f.value, confirmed: f.confirmed, originalValue: f.overriddenFrom };
    out[job.id] = fields;
  }
  return out;
}

export function ExtractionReview() {
  const { siteScope, persona } = useApp();
  const [drafts, setDrafts] = useState<DraftMap>(seedDrafts);
  const [settled, setSettled] = useState<string[]>([]);
  const [filter, setFilter] = useState<DocType | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  /** Narrows the reading list to one confidence band — set by the bar chart. */
  const [confidenceFocus, setConfidenceFocus] = useState<1 | 2 | 3 | null>(null);
  /** The job whose brief is open in the side sheet, before committing to review. */
  const [briefId, setBriefId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The confirm-all stagger runs on timers; they must not outlive the screen.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const pending = useMemo(
    () => EXTRACTION_JOBS.filter((j) => !settled.includes(j.id) && (siteScope === null || j.siteId === siteScope)),
    [settled, siteScope],
  );
  const queue = useMemo(() => pending.filter((j) => filter === 'all' || j.documentType === filter), [pending, filter]);

  const job = queue.find((j) => j.id === selectedId) ?? queue[0];
  const draftOf = (jobId: string, f: ExtractedField): FieldDraft =>
    drafts[jobId]?.[f.key] ?? { value: f.value, confirmed: f.confirmed, originalValue: f.overriddenFrom };
  const unconfirmedCount = (j: ExtractionJob) => j.fields.filter((f) => !draftOf(j.id, f).confirmed).length;

  // Worst first. Sort is stable, so equal confidence keeps document order.
  const ordered = useMemo(() => (job ? [...job.fields].sort((a, b) => a.confidence - b.confidence) : []), [job]);
  const visibleFields = confidenceFocus === null ? ordered : ordered.filter((f) => f.confidence === confidenceFocus);
  const remaining = job ? ordered.filter((f) => !draftOf(job.id, f).confirmed).length : 0;
  const activeKey = focusedKey ?? ordered.find((f) => job && !draftOf(job.id, f).confirmed)?.key ?? null;

  const queuedFields = queue.reduce((n, j) => n + j.fields.length, 0);
  const lowConfidence = queue.reduce((n, j) => n + j.fields.filter((f) => f.confidence === 1).length, 0);

  const brief = pending.find((j) => j.id === briefId) ?? null;

  /* ── What is waiting, before you open anything ──────────────────────────
     Two small charts that answer a question a reviewer actually has at 9am:
     what kind of paper is stacked up, and how much of it the model was unsure
     about. Both are computed over everything pending at this site, NOT over the
     current filter, so narrowing the queue never hides the picture. */
  const fieldsPending = pending.reduce((n, j) => n + j.fields.length, 0);

  const byType = DOC_TYPES.map((t) => ({
    label: DOC_LABEL[t],
    value: pending.filter((j) => j.documentType === t).reduce((n, j) => n + j.fields.length, 0),
  })).filter((s) => s.value > 0);

  const byConfidence = ([1, 2, 3] as const).map((level) => ({
    label: CONFIDENCE_LABEL[level],
    value: pending.reduce((n, j) => n + j.fields.filter((f) => f.confidence === level).length, 0),
    // The only colour on this band. A field below the floor is not a category,
    // it is a defect, and it is the one thing here that is wrong.
    tone: level === 1 ? 'var(--status-attention)' : level === 2 ? 'var(--chart-2)' : 'var(--chart-4)',
  }));

  /* ── Where the model has drifted ───────────────────────────────────────── */
  const drift = useMemo(() => {
    const rows: string[] = [];
    const rowType = new Map<string, DocType>();
    const cells: HeatCell[] = [];
    for (const t of DOC_TYPES) {
      const series = OVERRIDE_RATE[t];
      const latest = series[series.length - 1] ?? 0;
      // The current rate is baked into the row label, so the grid reads in
      // greyscale and on a printout — the tone only repeats what the word says.
      const row = `${DOC_LABEL[t]} · ${pct(latest)}`;
      rows.push(row);
      rowType.set(row, t);
      OVERRIDE_WEEKS.forEach((week, i) => {
        const rate = series[i] ?? 0;
        cells.push({
          row,
          col: week,
          intensity: Math.min(1, rate / 0.4),
          title: `${DOC_LABEL[t]} · ${week} · ${pct(rate)} of fields corrected by hand`,
          ...(rate >= DRIFT_THRESHOLD ? { tone: 'var(--status-attention)' } : {}),
        });
      });
    }
    const worst = DOC_TYPES.map((t) => {
      const series = OVERRIDE_RATE[t];
      return { type: t, first: series[0] ?? 0, latest: series[series.length - 1] ?? 0 };
    }).sort((a, b) => b.latest - a.latest)[0];
    return { rows, rowType, cells, worst };
  }, []);

  function confirmField(jobId: string, key: string) {
    setDrafts((all) => {
      const jd = all[jobId];
      const cur = jd?.[key];
      if (!jd || !cur) return all;
      return { ...all, [jobId]: { ...jd, [key]: { ...cur, confirmed: true } } };
    });
  }

  /** Confirm all drains the fields with a short stagger, so you see what you accepted. */
  function confirmAll(target: ExtractionJob) {
    const list = [...target.fields].sort((a, b) => a.confidence - b.confidence).filter((f) => !draftOf(target.id, f).confirmed);
    list.forEach((f, i) => {
      timers.current.push(
        setTimeout(() => {
          confirmField(target.id, f.key);
          setFocusedKey(f.key);
        }, i * 110),
      );
    });
  }

  function commitEdit(jobId: string, field: ExtractedField) {
    const next = editValue.trim();
    setEditingKey(null);
    setDrafts((all) => {
      const jd = all[jobId];
      const cur = jd?.[field.key];
      if (!jd || !cur || next === '') return all;
      const changed = next !== cur.value;
      return {
        ...all,
        [jobId]: {
          ...jd,
          // An override is a human-authored value: confirmed, but permanently
          // marked, because per-vendor override rates are the only honest
          // measure of extraction quality over time.
          [field.key]: { value: next, confirmed: true, originalValue: changed ? (cur.originalValue ?? field.value) : cur.originalValue },
        },
      };
    });
  }

  function openForReview(jobId: string) {
    setSelectedId(jobId);
    setBriefId(null);
    setFocusedKey(null);
    setEditingKey(null);
  }

  function closeJob(jobId: string) {
    // Advance to the NEXT document in the queue, falling back to whatever is
    // left — a reviewer's hands should not have to leave the keyboard.
    const at = queue.findIndex((j) => j.id === jobId);
    setSelectedId((queue[at + 1] ?? queue.find((j) => j.id !== jobId))?.id ?? null);
    setSettled((s) => [...s, jobId]);
    setFocusedKey(null);
    setEditingKey(null);
    setBriefId(null);
  }

  return (
    <>
      <PageHeader
        eyebrow="Linck reads"
        title="Extraction review"
        meta={
          <span className="flex flex-wrap items-center gap-4">
            <AsOfStamp asOf="14:42" source="v_extraction_queue" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {queue.length} documents waiting · {queuedFields} fields read · {lowConfidence} below the confidence floor
            </span>
          </span>
        }
      />

      {/* Five filters wrap to three rows on a 375px screen and eat a third of it
          before the queue starts, so below sm they become a scroll strip — the
          same gesture the section chips in the shell already use. */}
      <div
        className="flex items-center gap-2 overflow-x-auto px-6 py-3 sm:flex-wrap sm:overflow-x-visible"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        {FILTERS.map((f) => (
          <span key={f.key} className="shrink-0">
            <Chip
              active={filter === f.key}
              onClick={() => setFilter(f.key)}
              count={f.key === 'all' ? pending.length : pending.filter((j) => j.documentType === f.key).length}
            >
              {f.label}
            </Chip>
          </span>
        ))}
      </div>

      {pending.length > 0 ? (
        <div className="grid gap-x-8 gap-y-4 px-6 pt-4 lg:grid-cols-2">
          <div>
            <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              What kind of paper is stacked up — {fieldsPending} fields across {pending.length} documents
            </p>
            <ProportionBar
              height={22}
              summary={`${byType[0]?.label ?? 'Nothing'} account for ${
                byType[0] ? pct((byType[0].value || 0) / (fieldsPending || 1)) : '0%'
              } of the ${fieldsPending} fields waiting.`}
              segments={byType}
            />
            <ChartCaption>
              Weighbridge slips are five fields each and diesel bills are six, so a queue that looks short in documents
              is rarely short in keystrokes.
            </ChartCaption>
          </div>

          <div>
            <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              How sure the machine is — press a band to read only those fields
            </p>
            <BarChart
              summary={`Of ${fieldsPending} fields waiting, ${byConfidence[0]?.value ?? 0} fell below the confidence floor, ${
                byConfidence[1]?.value ?? 0
              } are worth a look and ${byConfidence[2]?.value ?? 0} read cleanly.`}
              data={byConfidence}
              labelWidth={124}
              barHeight={20}
              format={(v) => `${Math.round(v)}`}
              onSelect={(d) => {
                const level = ([1, 2, 3] as const).find((l) => CONFIDENCE_LABEL[l] === d.label) ?? null;
                setConfidenceFocus((cur) => (cur === level ? null : level));
              }}
            />
            <ChartCaption>
              Worst band first, the same order the reading pane uses. Below the floor means the model would not have
              staked anything on it — an odometer half-covered by a thumb, a GSTIN printed over a fold.
            </ChartCaption>
          </div>
        </div>
      ) : null}

      {job ? (
        <>
          {job.duplicateOf ? (
            <div
              className="mx-6 mt-4 flex flex-wrap items-center gap-3 px-3 py-2.5"
              style={{
                background: 'var(--status-attention-tint)',
                borderRadius: 'var(--r-2)',
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--status-attention) 45%, transparent)',
              }}
            >
              <StatusStamp status="attention" label="Possible duplicate" />
              <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                Matches {job.duplicateOf}. Confirming this a second time posts a second payable — a duplicate is a warning,
                not a block, so check the vendor&rsquo;s copy and decide.
              </p>
            </div>
          ) : null}

          <Section>
            {/* THREE PANES, THEN TWO, THEN ONE.
                Only at xl is there room for queue · paper · reading side by
                side: at 1024 the old three-track grid left the scan 28px wide,
                because a 224px queue and a 400px reading pane take everything a
                740px main has. From md the queue lies across the top as a
                scroll strip and the paper sits beside the reading, and on a
                phone the three stack in the order the work happens — pick the
                document, read the paper, correct the fields. */}
            <div className="grid gap-5 px-6 md:grid-cols-[minmax(0,1fr)_minmax(0,340px)] xl:grid-cols-[224px_minmax(0,1fr)_minmax(0,400px)]">
              {/* ── The queue ───────────────────────────────────────────── */}
              {/* py-1 leaves room for the Brief mark's enlarged hit area, which
                  would otherwise be clipped by this container's own scroll. */}
              <ol className="-mx-6 flex snap-x gap-2 overflow-x-auto px-6 py-1 md:col-span-2 xl:col-span-1 xl:mx-0 xl:flex-col xl:overflow-x-visible xl:px-0 xl:py-0">
                {queue.map((j) => {
                  const left = unconfirmedCount(j);
                  const here = j.id === job.id;
                  return (
                    <li key={j.id} className="relative w-[232px] shrink-0 snap-start xl:w-auto">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(j.id);
                          setFocusedKey(null);
                          setEditingKey(null);
                        }}
                        className="w-full px-3 py-2.5 pr-14 text-left"
                        style={{
                          background: here ? 'var(--surface-selected)' : 'var(--surface)',
                          borderRadius: 'var(--r-2)',
                          boxShadow: `inset 0 0 0 1px ${here ? 'var(--brand)' : 'var(--border-subtle)'}`,
                        }}
                      >
                        <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                          {MASTHEAD[j.documentType].kind.toLowerCase()}
                        </span>
                        <span className="mt-0.5 block text-[13px] leading-tight" style={{ color: 'var(--text-primary)' }}>
                          {j.label}
                        </span>
                        <span className="mt-2 flex items-center gap-2">
                          <StatusStamp
                            status={left === 0 ? 'ready' : 'pending'}
                            label={left === 0 ? 'Ready to post' : 'Unread'}
                            severity={left === 0 ? undefined : left}
                            fillRatio={(j.fields.length - left) / j.fields.length}
                            provisional={left > 0}
                          />
                          <span className="num text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                            {formatTime(j.capturedAt)}
                          </span>
                        </span>
                      </button>
                      {/* The brief. Sits inside the queue item rather than
                          replacing the click, because opening a document for
                          review is the fast path and it stays one press. */}
                      <button
                        type="button"
                        onClick={() => setBriefId(j.id)}
                        aria-label={`Brief on ${j.label}`}
                        // The mark stays 20px because it sits on a card corner;
                        // the invisible ::before takes the hit area to 44px on a
                        // pointer that cannot aim.
                        className="absolute right-2 top-2 px-1.5 py-0.5 text-[11px] before:absolute before:-inset-3 before:content-[''] [@media(hover:hover)]:before:hidden"
                        style={{ color: 'var(--brand)', borderRadius: 'var(--r-1)', background: 'var(--surface-raised)' }}
                      >
                        Brief
                      </button>
                    </li>
                  );
                })}
              </ol>

              {/* ── The paper ─────────────────────────────────────────────
                  A facsimile is the one thing on this screen that cannot be
                  reflowed: the ruled lines are a 28px repeat and every row must
                  sit on one, or the crop marks stop landing on the value they
                  point at. So the sheet keeps a floor width and scrolls INSIDE
                  ITSELF. A scan that will not narrow must never widen the page
                  underneath it. */}
              <div className="min-w-0 overflow-x-auto">
                <div
                  className="min-w-[272px] overflow-hidden"
                  style={{ background: 'var(--surface-raised)', borderRadius: 'var(--r-2)', boxShadow: 'inset 0 0 0 1px var(--border-strong)' }}
                >
                  <div className="px-5 pb-3 pt-5" style={{ borderBottom: '1px solid var(--border-strong)' }}>
                    <p className="font-id text-[15px] tracking-[0.06em]" style={{ color: 'var(--text-primary)' }}>
                      {MASTHEAD[job.documentType].name}
                    </p>
                    <p className="font-id mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                      {MASTHEAD[job.documentType].sub}
                    </p>
                    <p className="font-id mt-2 text-[11px] tracking-[0.14em]" style={{ color: 'var(--text-secondary)' }}>
                      {MASTHEAD[job.documentType].kind}
                    </p>
                  </div>

                  <div
                    className="py-0"
                    style={{
                      minHeight: 224,
                      backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 27px, var(--border-subtle) 27px 28px)',
                    }}
                  >
                    {job.fields.map((f) => {
                      const d = draftOf(job.id, f);
                      return (
                        <div
                          key={f.key}
                          className="flex h-7 items-center justify-between gap-3 px-5 sm:gap-6"
                          onMouseEnter={() => setFocusedKey(f.key)}
                          // Hover moves the crop marks on a desk. A thumb has no
                          // hover, so the paper is tappable too — pressing a line
                          // on the scan is the same act as pressing it in the list.
                          onClick={() => setFocusedKey(f.key)}
                        >
                          <span
                            className="font-id truncate text-[10px] uppercase tracking-[0.1em]"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {f.label}
                          </span>
                          <span className="relative inline-block shrink-0">
                            {activeKey === f.key ? <CropBox /> : null}
                            {/* Printed the way the paper prints it: ₹ leads, every other unit trails. */}
                            <span className="font-id relative text-[13px]" style={{ color: 'var(--text-primary)' }}>
                              {f.unit === '₹' ? <span className="mr-1">₹</span> : null}
                              {d.value}
                              {f.unit && f.unit !== '₹' ? <span className="ml-1">{f.unit}</span> : null}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div
                    className="flex flex-wrap items-end justify-between gap-4 px-5 pb-4 pt-4"
                    style={{ borderTop: '1px solid var(--border-strong)' }}
                  >
                    <span className="font-id text-[10px] uppercase tracking-[0.1em]" style={{ color: 'var(--text-tertiary)' }}>
                      Receiver&rsquo;s signature
                      <span className="mt-3 block h-px w-[120px]" style={{ background: 'var(--border-strong)' }} />
                    </span>
                    <span className="font-id min-w-0 text-right text-[10px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                      SCAN 2048×1536 · {formatDateTime(job.capturedAt)}
                      <br />
                      {job.capturedBy.toUpperCase()} · {(SITES.find((s) => s.id === job.siteId)?.name ?? 'Unknown site').toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── The reading ─────────────────────────────────────────── */}
              <div className="min-w-0">
                <div className="flex items-end justify-between gap-3 pb-2">
                  <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                    {confidenceFocus === null
                      ? 'Least certain first — that is where your eyes are worth most'
                      : `Only the fields Linck ${CONFIDENCE_LABEL[confidenceFocus].toLowerCase()}`}
                  </p>
                  {remaining > 0 ? (
                    <button
                      type="button"
                      onClick={() => confirmAll(job)}
                      // A text button, not a filled one — but it still has to be
                      // 44px to a thumb, so the box grows on a touch pointer and
                      // collapses back to the baseline on a desk.
                      className="inline-flex h-11 shrink-0 items-center text-[12px] font-medium [@media(hover:hover)]:h-auto"
                      style={{ color: 'var(--brand)' }}
                    >
                      Confirm all {remaining}
                    </button>
                  ) : null}
                </div>

                {confidenceFocus !== null ? (
                  <div className="pb-2">
                    <Chip active count={visibleFields.length} onClick={() => setConfidenceFocus(null)}>
                      {CONFIDENCE_LABEL[confidenceFocus]} — show every field
                    </Chip>
                  </div>
                ) : null}

                <ul style={{ background: 'var(--surface)', borderRadius: 'var(--r-2)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)' }}>
                  {visibleFields.length === 0 ? (
                    <li className="px-3 py-4">
                      <Note>Nothing on this document was read at that confidence. The band above clears the filter.</Note>
                    </li>
                  ) : null}
                  {visibleFields.map((f) => {
                    const d = draftOf(job.id, f);
                    const editing = editingKey === f.key;
                    const idish = ID_FIELDS.has(f.key);
                    return (
                      <li
                        key={f.key}
                        className="px-3 py-2.5"
                        onMouseEnter={() => setFocusedKey(f.key)}
                        onFocus={() => setFocusedKey(f.key)}
                        // Without this the crop marks on the scan are reachable
                        // only by hovering, which on a phone means not at all.
                        onClick={() => setFocusedKey(f.key)}
                        style={{
                          borderBottom: '1px solid var(--border-subtle)',
                          background: activeKey === f.key ? 'var(--surface-selected)' : 'transparent',
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
                            {f.label}
                            {f.unit ? <span className="ml-1 normal-case">{f.unit}</span> : null}
                          </span>
                          <ConfidenceMeter level={f.confidence} />
                          {/* Confirm and Edit are the two most-pressed controls
                              in the product. They keep their text-button
                              lightness on a desk and take the full 44px on a
                              thumb; -my-2 stops that height from stretching the
                              row it sits in. */}
                          <span className="-my-2 ml-auto flex shrink-0 items-center gap-1 [@media(hover:hover)]:my-0 [@media(hover:hover)]:gap-3">
                            {d.confirmed ? null : (
                              <button
                                type="button"
                                onClick={() => confirmField(job.id, f.key)}
                                className="inline-flex h-11 items-center px-1.5 text-[12px] font-medium [@media(hover:hover)]:h-auto [@media(hover:hover)]:px-0"
                                style={{ color: 'var(--brand)' }}
                              >
                                Confirm
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setEditingKey(f.key);
                                setEditValue(d.value);
                              }}
                              className="inline-flex h-11 items-center px-1.5 text-[12px] [@media(hover:hover)]:h-auto [@media(hover:hover)]:px-0"
                              style={{ color: 'var(--text-tertiary)' }}
                            >
                              {d.confirmed ? 'Change' : 'Edit'}
                            </button>
                          </span>
                        </div>

                        <div className="mt-1.5">
                          {editing ? (
                            <input
                              autoFocus
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => commitEdit(job.id, f)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit(job.id, f);
                                if (e.key === 'Escape') setEditingKey(null);
                              }}
                              inputMode={idish ? 'text' : 'decimal'}
                              className="num h-11 w-full px-2 text-[15px] tabular-nums [@media(hover:hover)]:h-8"
                              style={{
                                background: 'var(--surface-raised)',
                                color: 'var(--text-primary)',
                                borderRadius: 'var(--r-1)',
                                boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                              }}
                            />
                          ) : (
                            <Provisional
                              confirmed={d.confirmed}
                              overridden={d.originalValue !== null}
                              originalValue={d.originalValue ?? undefined}
                            >
                              {/* Full contrast, always. Provenance is the hatch, never dimmer ink. */}
                              <span className="text-[15px]" style={{ color: 'var(--text-primary)' }}>
                                {idish ? <IdCell>{d.value}</IdCell> : <span className="num tabular-nums">{d.value}</span>}
                              </span>
                            </Provisional>
                          )}
                        </div>

                        {d.originalValue !== null ? (
                          <p className="mt-1.5 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                            Linck read {d.originalValue} — corrected by {persona.name}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </Section>

          {/* ── Where the model has drifted ─────────────────────────────── */}
          <Section caption="Six weeks of the review log" title="How often a person had to correct the machine">
            <div className="px-6">
              <HeatGrid
                rows={drift.rows}
                cols={OVERRIDE_WEEKS}
                cells={drift.cells}
                rowLabelWidth={176}
                cellSize={18}
                summary={`Override rate by document type over six weeks. ${DOC_LABEL[drift.worst?.type ?? 'diesel_bill']} have risen from ${pct(
                  drift.worst?.first ?? 0,
                )} to ${pct(drift.worst?.latest ?? 0)} of fields corrected by hand; every other type has held steady.`}
                onSelect={(cell) => {
                  const t = drift.rowType.get(cell.row);
                  if (t) {
                    setFilter(t);
                    setSelectedId(null);
                    setConfidenceFocus(null);
                  }
                }}
              />
              <AsOfStamp asOf="W32" source="v_extraction_override_rate · demo series held in this file" freshness="materialised" />
              <ChartCaption>
                Diesel bills were fine until the last week of July, when Sakthi Fuels moved to a thermal roll that
                fades within a day in a cab. Nothing about Linck changed — the paper did, and the litres field is where
                it shows. Weighbridge slips are dot-matrix on carbon and have not moved. Press a row to pull only that
                document type into the queue.
              </ChartCaption>
            </div>
          </Section>

          {/* ── What confirming actually does. Permanent, never a toast. ── */}
          {/* The tab bar is fixed at the bottom of the phone at 60px plus the
              home indicator, and it is painted above this strip. Sticking to
              bottom-0 would post the document from behind it, so below md the
              strip stops one tab bar short. */}
          <div
            className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mt-6 flex flex-wrap items-end justify-between gap-4 px-6 py-4 md:bottom-0"
            style={{ background: 'var(--surface-sunken)', borderTop: '1px solid var(--border-strong)' }}
          >
            <div className="min-w-0 max-w-[720px] sm:min-w-[280px]">
              <p className="font-serif text-[15px] italic" style={{ color: 'var(--text-primary)' }}>
                {job.postsSummary}
              </p>
              <p className="mt-1 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                Linck writes in pencil. Nothing reaches the ledger until a person confirms every field on this document.
              </p>
            </div>
            {/* Stacked below sm, primary at the bottom where the thumb is —
                "12 fields left to confirm" and "Send back to Ravi" side by side
                are 340px of button on a 327px measure. */}
            <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
              <Button onClick={() => closeJob(job.id)}>Send back to {job.capturedBy.split(' ')[0] ?? 'capture'}</Button>
              <Button variant="primary" disabled={remaining > 0} onClick={() => setConfirming(true)}>
                {remaining > 0 ? `${remaining} fields left to confirm` : 'Confirm and post'}
              </Button>
            </div>
          </div>

          {/* The last gate. It restates the posting in the same words the footer
              used, because a confirmation that paraphrases is a confirmation
              nobody reads. */}
          <ConfirmModal
            open={confirming}
            onClose={() => setConfirming(false)}
            onConfirm={() => closeJob(job.id)}
            title="Post this document"
            confirmLabel="Confirm and post"
            consequence={
              <>
                <span className="block">{job.postsSummary}</span>
                {job.duplicateOf ? (
                  <span className="mt-3 flex flex-wrap items-center gap-2">
                    <StatusStamp status="attention" label="Possible duplicate" />
                    <span>Matches {job.duplicateOf}. Posting now creates a second payable.</span>
                  </span>
                ) : null}
                <span className="mt-3 block" style={{ color: 'var(--text-tertiary)' }}>
                  Linck wrote every figure on this document in pencil. Nothing reaches the ledger until a person
                  confirms it — that person is {persona.name}, and the posting will carry that name.
                </span>
              </>
            }
          />
        </>
      ) : settled.length > 0 || filter !== 'all' ? (
        <EmptyState
          fact={filter === 'all' ? 'Nothing is waiting to be read.' : 'No captures of that kind are waiting.'}
          because={
            filter === 'all'
              ? 'Every document photographed at this site today has been through a pair of human eyes.'
              : 'Other document types are still in the queue.'
          }
          action={
            filter === 'all'
              ? { label: "Put today's captures back", onClick: () => setSettled([]) }
              : { label: 'Show everything captured', onClick: () => setFilter('all') }
          }
        />
      ) : (
        <EmptyState
          fact="No documents have been captured for this site."
          because="Bills reach this queue when a driver, weighbridge operator or clerk photographs them."
        />
      )}

      <div className="h-4" />

      {/* ── The brief ──────────────────────────────────────────────────────
          What a reviewer wants before deciding to spend four minutes on a
          document: who photographed it and when, what it will post if it goes
          through, and whether it is a second copy of something already paid. */}
      <SideSheet
        open={brief !== null}
        onClose={() => setBriefId(null)}
        width="detail"
        title={brief?.label ?? ''}
        identifier={brief ? `${MASTHEAD[brief.documentType].kind} · ${brief.fields.length} FIELDS` : undefined}
        status={
          brief
            ? {
                family: unconfirmedCount(brief) === 0 ? 'ready' : 'pending',
                label: unconfirmedCount(brief) === 0 ? 'Ready to post' : 'Unread',
                severity: unconfirmedCount(brief) === 0 ? undefined : unconfirmedCount(brief),
                provisional: unconfirmedCount(brief) > 0,
              }
            : undefined
        }
        revision={brief ? `CAPTURED ${formatDateTime(brief.capturedAt)}` : undefined}
        footer={
          brief ? (
            <>
              <Button onClick={() => closeJob(brief.id)}>Send back to {brief.capturedBy.split(' ')[0] ?? 'capture'}</Button>
              <Button variant="primary" onClick={() => openForReview(brief.id)}>
                Open for review
              </Button>
            </>
          ) : null
        }
      >
        {brief ? <Brief job={brief} draftOf={draftOf} /> : null}
      </SideSheet>
    </>
  );
}

/**
 * The brief. Deliberately does NOT let you confirm a field — confirmation
 * happens against the scan or it does not happen at all, and a sheet that
 * accepted values without the paper beside them would be the one place in this
 * product where the machine got its authority back.
 */
function Brief({
  job,
  draftOf,
}: {
  job: ExtractionJob;
  draftOf: (jobId: string, f: ExtractedField) => FieldDraft;
}) {
  const site = SITES.find((s) => s.id === job.siteId)?.name ?? null;
  const lowest = job.fields.reduce<1 | 2 | 3>((m, f) => (f.confidence < m ? f.confidence : m), 3);
  const confirmed = job.fields.filter((f) => draftOf(job.id, f).confirmed).length;
  const spread = ([1, 2, 3] as const)
    .map((level) => ({
      label: CONFIDENCE_LABEL[level],
      value: job.fields.filter((f) => f.confidence === level).length,
      tone: level === 1 ? 'var(--status-attention)' : level === 2 ? 'var(--chart-2)' : 'var(--chart-4)',
    }))
    .filter((s) => s.value > 0);

  return (
    <>
      <SheetSection caption="Who captured it">
        <DetailGrid>
          <Detail label="Photographed by">{job.capturedBy}</Detail>
          <Detail label="Photographed at">{formatDateTime(job.capturedAt)}</Detail>
          <Detail label="Site">{site ?? '–'}</Detail>
          <Detail label="Document type">{DOC_LABEL[job.documentType]}</Detail>
        </DetailGrid>
      </SheetSection>

      <SheetSection caption="How much reading it needs">
        <DetailGrid>
          <Detail label="Fields read">
            {job.fields.length} · {confirmed} already confirmed
          </Detail>
          <Detail label="Lowest confidence">
            <span className="inline-flex items-center gap-2">
              <ConfidenceMeter level={lowest} />
              {CONFIDENCE_LABEL[lowest]}
            </span>
          </Detail>
        </DetailGrid>
        <div className="pt-1">
          <ProportionBar
            height={20}
            summary={`${job.fields.length} fields: ${spread
              .map((s) => `${s.value} ${s.label.toLowerCase()}`)
              .join(', ')}.`}
            segments={spread}
          />
        </div>
        <ChartCaption>
          One field below the floor is worth four minutes. Four of them means the photograph is the problem, not the
          model — send it back rather than retyping the bill.
        </ChartCaption>
      </SheetSection>

      <SheetSection caption="What Linck read">
        <ul className="text-[13px]">
          {[...job.fields]
            .sort((a, b) => a.confidence - b.confidence)
            .map((f) => {
              const d = draftOf(job.id, f);
              return (
                <li
                  key={f.key}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                  <span className="flex min-w-0 items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    {f.label}
                    <ConfidenceMeter level={f.confidence} />
                  </span>
                  <Provisional
                    confirmed={d.confirmed}
                    overridden={d.originalValue !== null}
                    originalValue={d.originalValue ?? undefined}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>
                      {ID_FIELDS.has(f.key) ? (
                        <IdCell>{d.value}</IdCell>
                      ) : (
                        <span className="num tabular-nums">
                          {f.unit === '₹' ? '₹' : ''}
                          {d.value}
                          {f.unit && f.unit !== '₹' ? ` ${f.unit}` : ''}
                        </span>
                      )}
                    </span>
                  </Provisional>
                </li>
              );
            })}
        </ul>
      </SheetSection>

      <SheetSection caption="What confirming will post">
        <Note>{job.postsSummary}</Note>
      </SheetSection>

      {job.duplicateOf ? (
        <SheetSection caption="Before you open it">
          <div className="flex flex-wrap items-center gap-2 pb-2">
            <StatusStamp status="attention" label="Possible duplicate" />
          </div>
          <Note>
            Matches {job.duplicateOf}. Confirming this a second time posts a second payable — a duplicate is a warning,
            not a block, so check the vendor&rsquo;s copy and decide.
          </Note>
        </SheetSection>
      ) : null}
    </>
  );
}

/**
 * The focus box on the scan: brand tint, a 1px brand rule and four 8px
 * L-shaped ticks set outside the corners, like crop marks on a photograph.
 * Brand is correct here — it says "you are here", not a status.
 */
const CORNER_TICKS: { id: string; style: React.CSSProperties }[] = [
  { id: 'tl', style: { top: -4, left: -4, borderTop: '1px solid var(--brand)', borderLeft: '1px solid var(--brand)' } },
  { id: 'tr', style: { top: -4, right: -4, borderTop: '1px solid var(--brand)', borderRight: '1px solid var(--brand)' } },
  { id: 'bl', style: { bottom: -4, left: -4, borderBottom: '1px solid var(--brand)', borderLeft: '1px solid var(--brand)' } },
  { id: 'br', style: { bottom: -4, right: -4, borderBottom: '1px solid var(--brand)', borderRight: '1px solid var(--brand)' } },
];

function CropBox() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -inset-x-1.5 -inset-y-0.5"
      style={{ background: 'var(--brand-tint)', border: '1px solid var(--brand)' }}
    >
      {CORNER_TICKS.map((tick) => (
        <span key={tick.id} className="absolute h-2 w-2" style={tick.style} />
      ))}
    </span>
  );
}
