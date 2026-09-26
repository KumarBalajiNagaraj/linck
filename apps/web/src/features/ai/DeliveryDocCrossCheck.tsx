import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COMPARED_FIELD_LABEL,
  crossCheckDeliveryDocuments,
  DEFAULT_DATE_WINDOW_DAYS,
  DEFAULT_WEIGHT_TOLERANCE_KG,
  DELIVERY_DOC_LABEL,
  DELIVERY_FIELD_LABEL,
  DELIVERY_PAPER_TYPES,
  formatDate,
  formatDateTime,
  UNCLEAR,
  type ComparedField,
  type CrossCheckResult,
  type DeliveryFieldKey,
  type ExtractedDocument,
  type ExtractedValue,
  type FieldComparison,
  type FieldStatus,
  type NetWeightCheck,
  type OverallResult,
} from '@linck/domain';
import { DELIVERY_DOC_SAMPLES } from '@linck/mock';
import type { StatusFamily } from '@linck/tokens';
import {
  Button,
  ConfidenceMeter,
  ConfirmModal,
  DataTable,
  Note,
  PageHeader,
  Provisional,
  Section,
  StatusStamp,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useCrossChecks, type RecordedCheck } from './crossCheckStore.js';

/**
 * DELIVERY DOCUMENT CROSS-CHECK.
 *
 * One load, three papers: the crusher's delivery challan, the transporter's
 * material-received challan and the customer's delivery memo. Type or paste
 * what each paper says and the screen works out which paper is which, pulls
 * the fields out and compares them.
 *
 * It is a checker, not a clerk: every value is shown exactly as read beside
 * the form it was compared in, nothing unreadable is guessed, and nothing
 * missing is borrowed from another paper. Everything it reads is pencil —
 * hatched, with dashed stamps — until a person confirms the check against
 * the papers and records it.
 */

interface Slot {
  /** Stable handle: the cross-check keys every paper by it. The name is only a label. */
  key: string;
  name: string;
  text: string;
  /** Object URL of an attached photo, to read the paper alongside the text. */
  photo: string | null;
}

const emptySlots = (): Slot[] => [1, 2, 3].map((n) => ({ key: `paper-${n}`, name: `Paper ${n}`, text: '', photo: null }));

const FIELD_STATUS_FAMILY: Record<FieldStatus, StatusFamily> = {
  MATCH: 'ready',
  MISMATCH: 'critical',
  // Missing information is for a person to chase, not someone else's turn.
  MISSING: 'attention',
  UNCLEAR: 'attention',
};

const OVERALL_FAMILY: Record<OverallResult, StatusFamily> = {
  MATCHED: 'ready',
  'PARTIALLY MATCHED': 'attention',
  MISMATCHED: 'critical',
};

const EXTRACTED_ORDER: DeliveryFieldKey[] = [
  'documentNumber',
  'date',
  'issuer',
  'party',
  'vehicle',
  'material',
  'quantity',
  'grossWeight',
  'tareWeight',
  'netWeight',
  'loadingLocation',
  'unloadingLocation',
];

/**
 * What a field's absence from a paper means. 'missing' is information the
 * cross-check needed and did not get; a sentence says why the gap does not
 * matter; null is a field this paper need not carry.
 */
function absence(doc: ExtractedDocument, key: DeliveryFieldKey): 'missing' | string | null {
  const f = doc.fields;
  switch (key) {
    case 'vehicle':
    case 'date':
    case 'material':
    case 'party':
      return 'missing';
    case 'quantity':
      return f.netWeight ? 'Not written apart; the net weight is the quantity' : 'missing';
    case 'netWeight':
      return f.quantity?.unit === 'MT' ? 'Not written apart; the quantity received is the net' : 'missing';
    case 'grossWeight':
    case 'tareWeight':
      // A memo shows no weights at all, and needs none; a paper that shows
      // some of them and not this one cannot have its net checked.
      return doc.netCheck.status === 'NOT_POSSIBLE' ? 'missing' : null;
    default:
      return null;
  }
}

const FIELD_STYLE: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

export function DeliveryDocCrossCheck() {
  const [slots, setSlots] = useState<Slot[]>(emptySlots);
  // Bumped on Clear and Load sample so the file pickers remount empty.
  const [generation, setGeneration] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const persona = useApp((s) => s.persona);
  const { records, record } = useCrossChecks();

  // Photos are object URLs; each is released when its slot lets go of it,
  // and whatever is left when the screen closes.
  const live = useRef<Slot[]>(slots);
  useEffect(() => {
    live.current = slots;
  }, [slots]);
  useEffect(
    () => () => {
      for (const s of live.current) if (s.photo) URL.revokeObjectURL(s.photo);
    },
    [],
  );

  const papers = useMemo(() => slots.filter((s) => s.text.trim() !== '' || s.photo !== null), [slots]);
  const result = useMemo(
    () => (papers.length === 0 ? null : crossCheckDeliveryDocuments(papers.map((s) => ({ id: s.key, name: s.name, text: s.text })))),
    [papers],
  );
  // A verdict needs two papers whose text was given; a photo on its own has been read by nobody.
  const typed = papers.filter((s) => s.text.trim() !== '').length;
  const signature = JSON.stringify(papers.map((s) => [s.name, s.text.trim()]));
  const recorded = records.find((r) => r.signature === signature);
  const confirmed = recorded !== undefined;

  const update = (key: string, patch: Partial<Slot>) =>
    setSlots((all) =>
      all.map((s) => {
        if (s.key !== key) return s;
        if ('photo' in patch && s.photo && s.photo !== patch.photo) URL.revokeObjectURL(s.photo);
        return { ...s, ...patch };
      }),
    );

  const replaceAll = (next: Slot[]) => {
    for (const s of slots) if (s.photo) URL.revokeObjectURL(s.photo);
    setSlots(next);
    setGeneration((g) => g + 1);
  };

  const loadSample = () =>
    replaceAll(DELIVERY_DOC_SAMPLES.map((d, i) => ({ key: `paper-${i + 1}`, name: d.id, text: d.text, photo: null })));

  const attach = (key: string, file: File) => {
    if (file.type.startsWith('image/')) {
      update(key, { photo: URL.createObjectURL(file), name: file.name });
      return;
    }
    void file.text().then((text) => update(key, { text, name: file.name }));
  };

  const load = result ? loadIdentity(result) : null;

  const recordCheck = () => {
    if (!result || !load) return;
    record({
      signature,
      recordedAt: new Date().toISOString(),
      recordedBy: persona.name,
      dcNumber: load.dcNumber,
      vehicle: load.vehicle,
      date: load.date,
      papers: papers.map((s) => ({ name: s.name, text: s.text })),
      result,
    });
    setConfirming(false);
  };

  return (
    <>
      <PageHeader
        eyebrow="Review queue"
        title="Delivery document cross-check"
        actions={
          <>
            <Button onClick={loadSample}>Load sample load</Button>
            <Button onClick={() => replaceAll(emptySlots())}>Clear</Button>
          </>
        }
      />

      <Section caption="One load, up to three papers" title="What each paper says">
        <div className="grid grid-cols-1 gap-6 px-6 lg:grid-cols-3">
          {slots.map((slot) => (
            <PaperSlot
              key={slot.key}
              slot={slot}
              generation={generation}
              doc={result?.documents.find((d) => d.id === slot.key)}
              onChange={(patch) => update(slot.key, patch)}
              onAttach={(file) => attach(slot.key, file)}
            />
          ))}
        </div>
        <div className="px-6 pt-4">
          <Note>
            Linck does not read the photos yet. Attach one to keep it beside the text, then type or paste what the paper
            says. Mark anything you cannot make out as [illegible]: it is reported as UNCLEAR, never guessed.
          </Note>
        </div>
      </Section>

      {result && typed >= 2 ? (
        <>
          <Verdict result={result} confirmed={confirmed} />
          <Comparison result={result} confirmed={confirmed} />
          <Extracted result={result} confirmed={confirmed} />

          {/* ── What recording does. Permanent, never a toast. ── */}
          <div
            className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mt-6 flex flex-wrap items-end justify-between gap-4 px-6 py-4 md:bottom-0"
            style={{ background: 'var(--surface-sunken)', borderTop: '1px solid var(--border-strong)' }}
          >
            <div className="min-w-0 max-w-[720px] sm:min-w-[280px]">
              <p className="font-serif text-[15px] italic" style={{ color: 'var(--text-primary)' }}>
                {recorded
                  ? `Recorded by ${recorded.recordedBy} at ${formatDateTime(recorded.recordedAt)}.`
                  : 'Everything above was read by Linck and is still in pencil.'}
              </p>
              <p className="mt-1 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {recorded
                  ? 'Change any paper and it becomes a new check, to be confirmed again.'
                  : `Check the values against the papers, then record the result against ${describeLoad(load)}. Recording posts nothing to the ledger.`}
              </p>
            </div>
            <Button variant="primary" disabled={confirmed} onClick={() => setConfirming(true)}>
              {confirmed ? 'Recorded' : 'Confirm and record'}
            </Button>
          </div>

          <ConfirmModal
            open={confirming}
            onClose={() => setConfirming(false)}
            onConfirm={recordCheck}
            title="Record this cross-check"
            confirmLabel="Confirm and record"
            consequence={
              <>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusStamp
                    status={OVERALL_FAMILY[result.overall]}
                    label={result.overall}
                    severity={result.overall === 'MISMATCHED' ? result.mismatchCount : undefined}
                  />
                  <span>for {describeLoad(load)}.</span>
                </span>
                <span className="mt-3 block">
                  The values read off {papers.length} papers, the verdict and{' '}
                  {result.explanations.length === 1 ? 'its one explanation' : `all ${result.explanations.length} explanations`} are kept
                  as they stand now.
                </span>
                <span className="mt-3 block" style={{ color: 'var(--text-tertiary)' }}>
                  Confirming says a person has looked at the papers and agrees this is what they say. That person is{' '}
                  {persona.name}, and the record will carry that name.
                </span>
              </>
            }
          />
        </>
      ) : result ? (
        <>
          <div className="px-6 pt-6">
            <Note>Add the text of a second paper to cross-check the load. Until then, this is only what was read from one paper.</Note>
          </div>
          <Extracted result={result} confirmed={false} />
        </>
      ) : (
        <div className="px-6 pt-6">
          <Note>
            Type or paste the text of at least two of the load&apos;s papers — the DC, the transporter&apos;s
            material-received challan and the customer&apos;s delivery memo — or load the sample load.
          </Note>
        </div>
      )}

      {records.length > 0 ? <RecordedChecks records={records} /> : null}
      <div className="h-10" />
    </>
  );
}

/* ------------------------------------------------------------ paper slot */

function PaperSlot({
  slot,
  generation,
  doc,
  onChange,
  onAttach,
}: {
  slot: Slot;
  generation: number;
  doc: ExtractedDocument | undefined;
  onChange: (patch: Partial<Slot>) => void;
  onAttach: (file: File) => void;
}) {
  const filled = slot.text !== '' || slot.photo !== null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        value={slot.name}
        onChange={(e) => onChange({ name: e.target.value })}
        aria-label="Paper name"
        className="h-11 w-full px-2 text-[14px] font-medium [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[13px]"
        style={FIELD_STYLE}
      />
      {slot.photo ? (
        <img src={slot.photo} alt={`Photo of ${slot.name}`} className="max-h-56 w-full object-contain" style={{ borderRadius: 'var(--r-1)' }} />
      ) : null}
      <textarea
        value={slot.text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={12}
        placeholder="Type or paste what this paper says. Mark anything you cannot read as [illegible]."
        aria-label={`Text of ${slot.name}`}
        className="w-full p-2 font-mono text-[12px] leading-snug"
        style={FIELD_STYLE}
      />
      <div className="flex flex-wrap items-center gap-2">
        {/* A file picker dressed as a button: the native control is too small to hit on a phone. */}
        <label
          className="inline-flex h-11 cursor-pointer items-center px-3 text-[14px] font-medium focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 [@media(hover:hover)]:h-[34px]"
          style={{ ...FIELD_STYLE, color: 'var(--text-primary)' }}
        >
          {slot.photo ? 'Replace photo or .txt' : 'Attach photo or .txt'}
          <input
            key={generation}
            type="file"
            accept="image/*,.txt,text/plain"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared at once, so choosing the same file again still fires.
              e.target.value = '';
              if (file) onAttach(file);
            }}
          />
        </label>
        {filled ? (
          <Button variant="destructive" onClick={() => onChange({ text: '', photo: null })}>
            Remove paper
          </Button>
        ) : null}
      </div>
      <DetectedType doc={doc} />
    </div>
  );
}

function DetectedType({ doc }: { doc: ExtractedDocument | undefined }) {
  if (!doc) return null;
  if (doc.unread) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        <StatusStamp status="attention" label="Not read" />
        <span>Photo only — type or paste what it says to include it.</span>
      </span>
    );
  }
  if (doc.type === 'unknown') {
    return (
      <span className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        <StatusStamp status="attention" label="Unrecognised" />
        <span>{doc.typeNote}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
        Reads as {DELIVERY_DOC_LABEL[doc.type]}
      </span>
      <ConfidenceMeter level={doc.typeConfidence === 0 ? 1 : doc.typeConfidence} />
      <span>because it says {doc.typeEvidence.map((e) => `“${e}”`).join(', ')}</span>
    </span>
  );
}

/* --------------------------------------------------------------- verdict */

function Verdict({ result, confirmed }: { result: CrossCheckResult; confirmed: boolean }) {
  const read = result.documents.filter((d) => !d.unread);
  return (
    <Section caption="Cross-verification" title="Do the papers describe the same load?">
      <div className="flex flex-col gap-3 px-6">
        <div className="flex flex-wrap items-center gap-3">
          <StatusStamp
            status={OVERALL_FAMILY[result.overall]}
            label={result.overall}
            severity={result.overall === 'MISMATCHED' ? result.mismatchCount : undefined}
            provisional={!confirmed}
          />
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {read.length} {read.length === 1 ? 'paper' : 'papers'} compared
            {result.missingTypes.length > 0
              ? ` · no ${result.missingTypes.map((t) => DELIVERY_DOC_LABEL[t]).join(' or ')} paper`
              : ''}
          </span>
        </div>
        {result.explanations.length > 0 ? (
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px]" style={{ color: 'var(--text-primary)' }}>
            {result.explanations.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ol>
        ) : (
          <Note>Every row agrees, and net = gross − tare adds up on every paper that shows its weights.</Note>
        )}
        <Note>
          Between papers, weights may differ by up to {DEFAULT_WEIGHT_TOLERANCE_KG} kg — two weighbridges — and dates by{' '}
          {DEFAULT_DATE_WINDOW_DAYS} day, for a load that crosses midnight. On any one paper, net = gross − tare must be
          exact to the kilogram.
        </Note>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------ comparison */

type ComparisonRow = { kind: 'field'; c: FieldComparison } | { kind: 'net' };

interface PaperColumn {
  key: string;
  header: string;
  doc: ExtractedDocument | null;
}

/**
 * The issue's three columns, always, in its order — a paper not given is a
 * column that says so. Any further paper (unrecognised, or a second of one
 * type) gets its own column after them.
 */
function paperColumns(result: CrossCheckResult): PaperColumn[] {
  const firsts = DELIVERY_PAPER_TYPES.map((t) => result.documents.find((d) => !d.unread && d.type === t) ?? null);
  const extras = result.documents.filter((d) => !d.unread && !firsts.includes(d));
  return [
    ...DELIVERY_PAPER_TYPES.map((t, i) => ({ key: t, header: DELIVERY_DOC_LABEL[t], doc: firsts[i]! })),
    ...extras.map((d) => ({
      key: d.id,
      header: d.type === 'unknown' ? `${d.name} (unrecognised)` : `${d.name} (another ${DELIVERY_DOC_LABEL[d.type]})`,
      doc: d,
    })),
  ];
}

function Comparison({ result, confirmed }: { result: CrossCheckResult; confirmed: boolean }) {
  const read = result.documents.filter((d) => !d.unread);
  const netStatus = worstNet(read.map((d) => d.netCheck));
  const rows: ComparisonRow[] = [...result.comparisons.map((c) => ({ kind: 'field' as const, c })), { kind: 'net' }];
  const rowLabel = (r: ComparisonRow) => (r.kind === 'field' ? COMPARED_FIELD_LABEL[r.c.field] : 'Net = Gross − Tare');

  const columns: Column<ComparisonRow>[] = [
    {
      key: 'field',
      header: 'Field',
      sticky: true,
      render: (r) => <span className="font-medium">{rowLabel(r)}</span>,
    },
    ...paperColumns(result).map(
      (p): Column<ComparisonRow> => ({
        key: p.key,
        header: p.header,
        render: (r) => {
          if (!p.doc) return <Absent word="No paper" />;
          if (r.kind === 'net') return <NetCell check={p.doc.netCheck} confirmed={confirmed} />;
          const value = r.c.values.find((v) => v.docId === p.doc!.id)?.value ?? null;
          return <ValueCell value={value} mismatch={r.c.status === 'MISMATCH'} confirmed={confirmed} />;
        },
      }),
    ),
    {
      key: 'status',
      header: 'Status',
      type: 'status',
      render: (r) =>
        r.kind === 'field' ? (
          <StatusStamp
            status={FIELD_STATUS_FAMILY[r.c.status]}
            label={r.c.status}
            severity={r.c.status === 'MISMATCH' ? mismatchSeverity(r.c) : undefined}
            provisional={!confirmed}
          />
        ) : (
          <StatusStamp status={netStatus.family} label={netStatus.label} severity={netStatus.severity} provisional={!confirmed} />
        ),
    },
    {
      key: 'why',
      header: 'Why',
      render: (r) => {
        const text = r.kind === 'field' ? r.c.explanation : netStatus.why;
        return text ? (
          <span className="block min-w-[12rem] max-w-[20rem] whitespace-normal py-2 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {text}
          </span>
        ) : null;
      },
    },
  ];

  return (
    <Section caption="Field by field" title="Comparison">
      <div className="px-6">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => (r.kind === 'field' ? r.c.field : 'net')}
          rail={(r) => ({ status: r.kind === 'field' ? FIELD_STATUS_FAMILY[r.c.status] : netStatus.family })}
        />
      </div>
    </Section>
  );
}

/**
 * The integer a critical stamp carries: how far apart the weights or dates
 * are, or how many papers are out of line.
 */
function mismatchSeverity(c: FieldComparison): string | number {
  const readable = c.values.map((v) => v.value).filter((v): v is ExtractedValue => v !== null && v.normalized !== UNCLEAR);
  if ((c.field === 'quantity' || c.field === 'netWeight') && readable.every((v) => v.unit === 'MT')) {
    const kg = readable.map((v) => Math.round(v.amount! * 1000));
    return `${(Math.max(...kg) - Math.min(...kg)).toLocaleString('en-IN')} kg`;
  }
  if (c.field === 'date') {
    const days = readable.map((v) => Date.parse(v.normalized) / 86_400_000);
    return `${Math.round(Math.max(...days) - Math.min(...days))} d`;
  }
  return c.disagreements;
}

function worstNet(checks: NetWeightCheck[]): { family: StatusFamily; label: string; severity?: string; why: string } {
  const failed = checks.filter((c) => c.status === 'MISMATCH');
  if (failed.length > 0) {
    const worst = Math.max(...failed.map((c) => Math.abs(c.differenceKg ?? 0)));
    return {
      family: 'critical',
      label: 'Does not add up',
      severity: `${worst.toLocaleString('en-IN')} kg`,
      why: `On ${failed.length === 1 ? 'one paper' : `${failed.length} papers`}, the net written is not gross − tare.`,
    };
  }
  if (checks.some((c) => c.status === 'NOT_POSSIBLE' || c.implausible)) {
    return { family: 'attention', label: 'Cannot check', why: 'A paper shows some of its weights but not enough readable ones to check.' };
  }
  if (checks.some((c) => c.status === 'OK')) return { family: 'ready', label: 'Adds up', why: 'Every paper that shows a gross and a tare adds up to its net.' };
  return { family: 'attention', label: 'Not checked', why: 'No paper shows a gross and a tare weight.' };
}

function NetCell({ check, confirmed }: { check: NetWeightCheck; confirmed: boolean }) {
  if (check.status === 'NOT_APPLICABLE') {
    return <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No gross or tare</span>;
  }
  const stamp: Record<Exclude<NetWeightCheck['status'], 'NOT_APPLICABLE'>, { family: StatusFamily; label: string }> = {
    OK: { family: 'ready', label: 'Adds up' },
    MISMATCH: { family: 'critical', label: 'Does not add up' },
    NOT_POSSIBLE: { family: 'attention', label: 'Cannot check' },
  };
  const s = stamp[check.status];
  return (
    <span className="flex max-w-[18rem] flex-col gap-1 whitespace-normal py-2">
      <StatusStamp
        status={check.implausible && check.status !== 'MISMATCH' ? 'attention' : s.family}
        label={s.label}
        severity={check.status === 'MISMATCH' ? `${Math.abs(check.differenceKg ?? 0).toLocaleString('en-IN')} kg` : undefined}
        provisional={!confirmed}
      />
      <span className="text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
        {check.explanation}
      </span>
    </span>
  );
}

/** A value as read, with the form it was compared in beneath it. Machine-read, so pencil until confirmed. */
function ValueCell({ value, mismatch, confirmed }: { value: ExtractedValue | null; mismatch: boolean; confirmed: boolean }) {
  if (!value) return <Absent word="Not on this paper" />;
  if (value.normalized === UNCLEAR) {
    return (
      <span className="flex flex-col gap-1 py-2">
        <Provisional confirmed={confirmed}>{value.raw}</Provisional>
        <StatusStamp status="attention" label="Unclear" provisional={!confirmed} />
      </span>
    );
  }
  return (
    <span className="flex flex-col py-2">
      <Provisional confirmed={confirmed}>
        <span style={mismatch ? { color: 'var(--status-critical)', fontWeight: 600 } : undefined}>{value.raw}</span>
      </Provisional>
      <span className="font-id text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        {value.normalized}
      </span>
      {value.derivedFrom ? (
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          from “{value.label ?? DELIVERY_FIELD_LABEL[value.derivedFrom]}”
        </span>
      ) : null}
    </span>
  );
}

/** Missing information: a glyph and a word at readable contrast, never a faint dash. */
function Absent({ word }: { word: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: 'var(--status-attention)' }}>
      <span aria-hidden="true">◐</span>
      {word}
    </span>
  );
}

/* ------------------------------------------------------------ extraction */

function Extracted({ result, confirmed }: { result: CrossCheckResult; confirmed: boolean }) {
  const read = result.documents.filter((d) => !d.unread);
  if (read.length === 0) return null;
  return (
    <Section caption="Everything read off each paper" title="Extracted fields">
      <div className="grid grid-cols-1 gap-6 px-6 xl:grid-cols-2">
        {read.map((d) => (
          <ExtractedTable key={d.id} doc={d} confirmed={confirmed} />
        ))}
      </div>
    </Section>
  );
}

function ExtractedTable({ doc, confirmed }: { doc: ExtractedDocument; confirmed: boolean }) {
  const columns: Column<DeliveryFieldKey>[] = [
    { key: 'field', header: 'Field', sticky: true, render: (k) => DELIVERY_FIELD_LABEL[k] },
    {
      key: 'raw',
      header: 'As read',
      render: (k) => {
        const v = doc.fields[k];
        return v ? (
          <Provisional confirmed={confirmed}>
            <span className="inline-block min-w-[10rem] max-w-[16rem] whitespace-normal">{v.raw}</span>
          </Provisional>
        ) : null;
      },
    },
    {
      key: 'normalized',
      header: 'Compared as',
      render: (k) => {
        const v = doc.fields[k];
        if (!v) {
          const gap = absence(doc, k);
          return gap === 'missing' ? (
            <Absent word="Missing" />
          ) : gap ? (
            <span className="block max-w-[14rem] whitespace-normal text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
              {gap}
            </span>
          ) : null;
        }
        return (
          <span className="flex flex-col py-1.5">
            {v.normalized === UNCLEAR ? (
              <StatusStamp status="attention" label="Unclear" provisional={!confirmed} />
            ) : (
              <span className="font-id">{v.normalized}</span>
            )}
            {v.note ? (
              <span className="max-w-[18rem] whitespace-normal text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                {v.note}
              </span>
            ) : null}
          </span>
        );
      },
    },
  ];
  return (
    <div className="min-w-0">
      <p className="pb-1 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {doc.name}{' '}
        <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>
          — {DELIVERY_DOC_LABEL[doc.type]}
        </span>
      </p>
      <DataTable
        columns={columns}
        rows={EXTRACTED_ORDER}
        rowKey={(k) => k}
        density="compact"
        rail={(k) => {
          const v = doc.fields[k];
          if (!v) return absence(doc, k) === 'missing' ? { status: 'attention' } : undefined;
          if (v.normalized === UNCLEAR) return { status: 'attention', provenance: confirmed ? 'confirmed' : 'proposed' };
          return { provenance: confirmed ? 'confirmed' : 'proposed' };
        }}
      />
    </div>
  );
}

/* --------------------------------------------------------------- records */

interface LoadIdentity {
  dcNumber: string | null;
  vehicle: string | null;
  date: string | null;
}

/** What identifies the load: the DC's number, and the vehicle and date the papers give. */
function loadIdentity(result: CrossCheckResult): LoadIdentity {
  const readable = (field: ComparedField) =>
    result.comparisons.find((c) => c.field === field)?.values.find((v) => v.value && v.value.normalized !== UNCLEAR)?.value?.normalized ?? null;
  const dc = result.documents.find((d) => d.type === 'delivery_challan')?.fields.documentNumber;
  return {
    dcNumber: dc && dc.normalized !== UNCLEAR ? dc.normalized : null,
    vehicle: readable('vehicle'),
    date: readable('date'),
  };
}

function describeLoad(load: LoadIdentity | null): string {
  if (!load) return 'this load';
  const parts = [load.dcNumber ? `DC ${load.dcNumber}` : null, load.vehicle, load.date ? formatDate(load.date) : null].filter(Boolean);
  return parts.length > 0 ? `the load ${parts.join(' · ')}` : 'this load';
}

function RecordedChecks({ records }: { records: RecordedCheck[] }) {
  const columns: Column<RecordedCheck>[] = [
    { key: 'when', header: 'Recorded', sticky: true, render: (r) => formatDateTime(r.recordedAt) },
    { key: 'dc', header: 'DC', type: 'id', render: (r) => r.dcNumber },
    { key: 'vehicle', header: 'Vehicle', type: 'id', render: (r) => r.vehicle },
    { key: 'date', header: 'Load date', render: (r) => (r.date ? formatDate(r.date) : null) },
    { key: 'papers', header: 'Papers', type: 'num', render: (r) => r.papers.length },
    {
      key: 'result',
      header: 'Result',
      type: 'status',
      render: (r) => (
        <StatusStamp
          status={OVERALL_FAMILY[r.result.overall]}
          label={r.result.overall}
          severity={r.result.overall === 'MISMATCHED' ? r.result.mismatchCount : undefined}
        />
      ),
    },
    { key: 'by', header: 'By', render: (r) => r.recordedBy },
  ];
  return (
    <Section caption="Confirmed by a person" title="Recorded checks">
      <div className="px-6">
        <DataTable columns={columns} rows={records} rowKey={(r) => r.id} rail={(r) => ({ status: OVERALL_FAMILY[r.result.overall], provenance: 'confirmed' })} />
      </div>
    </Section>
  );
}
