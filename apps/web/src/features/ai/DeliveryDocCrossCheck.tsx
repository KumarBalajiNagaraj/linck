import { useEffect, useMemo, useRef, useState } from 'react';
import {
  crossCheckDeliveryDocuments,
  DEFAULT_DATE_WINDOW_DAYS,
  DEFAULT_WEIGHT_TOLERANCE_KG,
  DELIVERY_PAPER_TYPES,
  formatDate,
  formatDateTime,
  materialParts,
  paperName,
  UNCLEAR,
  type AgreementNote,
  type ComparedField,
  type CrossCheckIssue,
  type CrossCheckResult,
  type DeliveryFieldKey,
  type ExtractedDocument,
  type ExtractedValue,
  type FieldComparison,
  type FieldFinding,
  type FieldStatus,
  type NetFinding,
  type NetWeightCheck,
  type OverallResult,
  type TypeNote,
  type ValueNote,
  type WeightConflict,
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
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useCrossChecks, type RecordedCheck } from './crossCheckStore.js';
import { crossCheckWords } from './words.js';

/**
 * CHECK DELIVERY PAPERS — the delivery document cross-check.
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
 * the papers and records it. Recording posts nothing to the ledger.
 *
 * The comparison itself lives in `@linck/domain` and answers in codes with
 * values; this screen words them, short, in English or Tamil (`words.ts`).
 */

type Text = (typeof crossCheckWords)['en'];

interface Slot {
  /** Stable handle: the cross-check keys every paper by it. The name is only a label. */
  key: string;
  /** What the person called the paper. Empty until they do; it is "Paper 1" until then. */
  name: string;
  text: string;
  /** Object URL of an attached photo, to read the paper alongside the text. */
  photo: string | null;
}

const emptySlots = (): Slot[] => [1, 2, 3].map((n) => ({ key: `paper-${n}`, name: '', text: '', photo: null }));

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

/** Identifiers get the mono face with a slashed zero. */
const ID_KEYS = new Set<DeliveryFieldKey | ComparedField>(['vehicle', 'documentNumber']);

/**
 * What a field's absence from a paper means. 'missing' is information the
 * cross-check needed and did not get; the other two are a paper that wrote
 * one figure for both the quantity and the net weight, so the gap does not
 * matter; null is a field this paper need not carry.
 */
type Absence = 'missing' | 'net-is-quantity' | 'quantity-is-net' | null;

function absence(doc: ExtractedDocument, key: DeliveryFieldKey): Absence {
  const f = doc.fields;
  switch (key) {
    case 'vehicle':
    case 'date':
    case 'material':
    case 'party':
      return 'missing';
    case 'quantity':
      return f.netWeight ? 'net-is-quantity' : 'missing';
    case 'netWeight':
      return f.quantity?.unit === 'MT' ? 'quantity-is-net' : 'missing';
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

/* ------------------------------------------------------------- wording */

/** Weights arrive in whole kilograms; a paper writes them in tonnes. */
const tonnesOf = (kg: number) => String(Math.round(kg) / 1000);

/**
 * Words for what the cross-check found, in the reader's language. Papers are
 * called what `paperName` says: by kind, by kind and name where two share a
 * kind, by name where the kind is not known.
 */
function sayer(t: Text, documents: readonly ExtractedDocument[]) {
  const paper = (id: string): string => {
    const d = documents.find((x) => x.id === id);
    if (!d) return id;
    const n = paperName(d, documents);
    return n.code === 'type' ? t.kind[n.type] : n.code === 'type-and-name' ? `${t.kind[n.type]} “${n.name}”` : `“${n.name}”`;
  };
  const papers = (ids: readonly string[]) => t.and(ids.map(paper));
  const weight = (kg: number) => t.tonnes(tonnesOf(kg));
  const kgs = (kg: number) => t.kg(kg.toLocaleString('en-IN'));
  const mm = (size: string) => t.mm(size.replace(/MM$/i, ''));

  /** The form a value was compared in, worded: a date as a date, jelly as jelly. */
  const comparedAs = (v: ExtractedValue, key: DeliveryFieldKey | ComparedField): string => {
    if (v.amount !== undefined && v.unit) {
      const n = String(v.amount);
      return v.unit === 'MT' ? t.tonnes(n) : t.volume(n, t.unit[v.unit]);
    }
    if (key === 'date') return formatDate(v.normalized);
    if (key === 'material') {
      const { kind, name, size } = materialParts(v.normalized);
      if (kind) return size ? `${t.material[kind]} ${mm(size)}` : t.material[kind];
      // Not a known material: compared as written, so shown as written.
      if (name === '' && size) return mm(size);
    }
    return v.normalized;
  };

  const valueNote = (n: ValueNote): string => {
    switch (n.code) {
      case 'marked-unreadable':
        return t.note.marked;
      case 'not-a-registration':
        return t.note.notRegistration;
      case 'two-registrations':
        return t.note.twoRegistrations(n.found.join(', '));
      case 'not-a-date':
        return t.note.notDate;
      case 'no-such-date':
        return t.note.noSuchDate;
      case 'percentage':
        return t.note.percentage;
      case 'no-number':
        return t.note.noNumber;
      case 'many-numbers':
        return t.note.manyNumbers;
      case 'bad-number':
        return t.note.badNumber(n.token);
      case 'not-a-unit':
        return t.note.notUnit(n.word);
      case 'unit-from-paper':
        return t.note.unitFromPaper(t.unit[n.unit]);
      case 'read-as-kg':
        return t.note.readAsKg;
      case 'read-as-tonnes':
        return t.note.readAsTonnes;
      case 'not-a-load':
        return t.note.notALoad(t.tonnes(String(n.tonnes)));
      case 'written-in-kg':
        return t.note.writtenInKg;
      case 'empty':
        return t.note.empty;
      case 'size-only':
        return t.note.sizeOnly;
      case 'material-unknown':
        return t.note.materialUnknown;
      case 'columns-misaligned':
        return t.note.columns;
    }
  };

  /** Printed words the papers carry, quoted, never translated. */
  const quotes = (evidence: readonly string[]) => evidence.map((e) => `“${e}”`).join(', ');

  const typeNote = (n: TypeNote): string => {
    switch (n.code) {
      case 'no-text':
        return t.typeNote.noText;
      case 'no-delivery-words':
        return t.typeNote.noDeliveryWords;
      case 'other-paper':
        return t.typeNote.otherPaper(t.otherPaper[n.paper]);
      case 'tie':
        return t.typeNote.tie(t.kind[n.types[0]], t.kind[n.types[1]]);
      case 'weak':
        return t.typeNote.weak(quotes(n.evidence), t.kind[n.type]);
    }
  };

  const agreement = (n: AgreementNote): string => {
    switch (n.code) {
      case 'kg-apart':
        return t.why.kgApart(n.kg);
      case 'days-apart':
        return t.why.daysApart(t.days(n.days));
      case 'same-volume':
        return t.why.sameVolume(n.cft);
      case 'size-only':
        return t.why.sizeOnly;
    }
  };

  const conflict = (c: WeightConflict): string =>
    c.code === 'tare-not-below-gross' ? t.tareNotBelowGross(weight(c.tareKg), weight(c.grossKg)) : t.netAboveGross(weight(c.netKg), weight(c.grossKg));

  /** What one paper's full − empty = net came to. */
  const net = (f: NetFinding): string => {
    switch (f.code) {
      case 'no-weights':
        return t.noWeights;
      case 'net-only':
        return t.netOnly;
      case 'no-gross-or-tare':
        return [
          f.gross === 'absent' ? t.noGross : f.gross === 'unreadable' ? t.grossUnclear : null,
          f.tare === 'absent' ? t.noTare : f.tare === 'unreadable' ? t.tareUnclear : null,
        ]
          .filter((s): s is string => s !== null)
          .join(' ');
      case 'no-net':
        return `${t.worksOut(weight(f.calculatedKg))} ${f.net === 'absent' ? t.noNet : t.netUnclear}`;
      case 'adds-up':
        return `${t.sum(tonnesOf(f.grossKg), tonnesOf(f.tareKg), weight(f.netKg))}.`;
      case 'does-not-add-up':
        return `${t.sum(tonnesOf(f.grossKg), tonnesOf(f.tareKg), weight(f.calculatedKg))}. ${t.paperSays(weight(f.statedKg))}`;
    }
  };

  /** Why a row of the comparison says what it says. Null where the values say it. */
  const why = (f: FieldFinding | null): string | null => {
    if (!f) return null;
    switch (f.code) {
      case 'differs':
        return null;
      case 'weight-and-volume':
        return t.why.weightAndVolume;
      case 'unreadable':
      case 'party-unreadable':
        return t.why.unreadable(papers(f.docIds));
      case 'on-no-paper':
        return t.why.onNoPaper;
      case 'on-one-paper':
        return t.why.onOnePaper(paper(f.docId));
      case 'size-on-one-paper':
        return t.why.sizeOnOne(mm(f.size));
      case 'not-on-every-paper':
        return t.why.notOn(papers(f.missing));
      case 'close-enough': {
        const notes = [...new Set(f.pairs.map((p) => agreement(p.note)))].join(', ');
        return f.allowance ? t.why.allowed(notes) : `${notes}.`;
      }
      case 'party-not-issuer':
        return f.breaks.map((b) => t.issue.partyNotFrom(paper(b.docId), b.party)).join(' ');
      case 'party-unlinked':
        return t.why.partyUnlinked;
      case 'party-missing':
        return t.why.partyMissing(papers(f.missing));
      case 'party-linked':
        return t.why.partyLinked;
    }
  };

  /** A compared field that is a problem, in one sentence and what backs it up. */
  const fieldIssue = (field: string, f: FieldFinding): { text: string; detail: string[] } => {
    switch (f.code) {
      case 'differs':
        return { text: t.issue.differs(field), detail: [] };
      case 'weight-and-volume':
        return { text: t.issue.weightAndVolume(field), detail: [] };
      case 'unreadable':
        return { text: t.issue.unreadable(field, papers(f.docIds)), detail: f.note ? [`${valueNote(f.note)}.`] : [] };
      case 'on-no-paper':
        return { text: t.issue.onNoPaper(field), detail: [] };
      case 'on-one-paper':
        return { text: t.issue.onOnePaper(field, paper(f.docId)), detail: [] };
      case 'size-on-one-paper':
        return { text: t.issue.sizeOnOne(field, mm(f.size)), detail: [] };
      case 'not-on-every-paper':
        return { text: t.issue.notOnEvery(field, papers(f.missing)), detail: [] };
      case 'party-not-issuer':
        return { text: f.breaks.map((b) => t.issue.partyNotFrom(paper(b.docId), b.party)).join(' '), detail: [] };
      case 'party-unreadable':
        return { text: t.issue.partyUnreadable(papers(f.docIds)), detail: [] };
      case 'party-unlinked':
        return { text: t.issue.partyUnlinked, detail: [t.why.partyUnlinked] };
      case 'party-missing':
        return { text: t.issue.partyMissing(papers(f.missing)), detail: [] };
      // A match is never listed as a problem; worded all the same.
      case 'close-enough':
      case 'party-linked':
        return { text: why(f) ?? field, detail: [] };
    }
  };

  /** A problem with the load: one sentence, and what backs it up. */
  const issue = (i: CrossCheckIssue): { text: string; detail: string[] } => {
    switch (i.code) {
      case 'field':
        return fieldIssue(t.compared[i.field], i.finding);
      case 'net': {
        const name = paper(i.docId);
        const text =
          i.finding.code === 'does-not-add-up'
            ? t.issue.netWrong(name, kgs(Math.abs(i.finding.differenceKg)), i.finding.differenceKg > 0)
            : i.status === 'NOT_POSSIBLE'
              ? t.issue.netCannot(name)
              : t.issue.netImpossible(name);
        const detail = i.finding.code === 'does-not-add-up' || i.status === 'NOT_POSSIBLE' ? [net(i.finding)] : [];
        return { text, detail: [...detail, ...i.conflicts.map(conflict)] };
      }
      case 'no-weights-anywhere':
        return { text: t.issue.noWeightsAnywhere, detail: [] };
      case 'no-text':
        return { text: t.issue.noText(paper(i.docId)), detail: [] };
      case 'unknown-paper':
        return { text: t.issue.unknownPaper(paper(i.docId)), detail: i.note ? [typeNote(i.note)] : [] };
      case 'same-type-twice': {
        const names = i.docIds.map((id) => `“${documents.find((d) => d.id === id)?.name ?? id}”`);
        return { text: t.issue.sameKindTwice(i.docIds.length, t.kind[i.type]), detail: [t.and(names)] };
      }
      case 'papers-missing':
        return { text: t.issue.papersMissing(t.or(i.types.map((k) => t.kind[k]))), detail: [] };
      case 'too-few-papers':
        return { text: t.issue.tooFew, detail: [] };
    }
  };

  return { paper, weight, kgs, comparedAs, valueNote, typeNote, quotes, conflict, net, why, issue };
}

type Say = ReturnType<typeof sayer>;

/* ------------------------------------------------------------------ screen */

export function DeliveryDocCrossCheck() {
  const t = useWords(crossCheckWords);
  const [slots, setSlots] = useState<Slot[]>(emptySlots);
  // Bumped on Clear and Show sample so the file pickers remount empty.
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

  // A paper is called by the name the person gave it, else "Paper 1" in the
  // reader's language — which is the name the cross-check is given too.
  const papers = useMemo(
    () => slots.flatMap((s, i) => (s.text.trim() !== '' || s.photo !== null ? [{ ...s, shown: s.name.trim() || t.paperN(i + 1) }] : [])),
    [slots, t],
  );
  const result = useMemo(
    () => (papers.length === 0 ? null : crossCheckDeliveryDocuments(papers.map((s) => ({ id: s.key, name: s.shown, text: s.text })))),
    [papers],
  );
  const say = useMemo(() => sayer(t, result?.documents ?? []), [t, result]);
  // A verdict needs two papers whose text was given; a photo on its own has been read by nobody.
  const typed = papers.filter((s) => s.text.trim() !== '').length;
  // What the person gave, not what the screen calls it: switching language is not a new check.
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

  // The samples' own ids are English demo captions; the papers are called
  // Paper 1–3 like any others, and what each one is is read off its text.
  const loadSample = () => replaceAll(DELIVERY_DOC_SAMPLES.map((d, i) => ({ key: `paper-${i + 1}`, name: '', text: d.text, photo: null })));

  const attach = (key: string, file: File) => {
    if (file.type.startsWith('image/')) {
      update(key, { photo: URL.createObjectURL(file), name: file.name });
      return;
    }
    void file.text().then((text) => update(key, { text, name: file.name }));
  };

  const load = result ? loadIdentity(result) : null;
  const loadWords = describeLoad(load, t);

  const recordCheck = () => {
    if (!result || !load) return;
    record({
      signature,
      recordedAt: new Date().toISOString(),
      recordedBy: persona.name,
      dcNumber: load.dcNumber,
      vehicle: load.vehicle,
      date: load.date,
      papers: papers.map((s) => ({ name: s.shown, text: s.text })),
      result,
    });
    setConfirming(false);
  };

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        actions={
          <>
            <Button onClick={loadSample}>{t.sample}</Button>
            <Button onClick={() => replaceAll(emptySlots())}>{t.clear}</Button>
          </>
        }
      />

      <Section caption={t.papersCaption} title={t.papersTitle}>
        <div className="grid grid-cols-1 gap-6 px-6 lg:grid-cols-3">
          {slots.map((slot, i) => (
            <PaperSlot
              key={slot.key}
              slot={slot}
              placeholder={t.paperN(i + 1)}
              generation={generation}
              doc={result?.documents.find((d) => d.id === slot.key)}
              say={say}
              onChange={(patch) => update(slot.key, patch)}
              onAttach={(file) => attach(slot.key, file)}
            />
          ))}
        </div>
        {/* Linck does not read the photos yet. A photo is kept beside the text
            so the person typing can read the paper; anything they cannot make
            out they mark with "?", and it is reported as unclear, never
            guessed. */}
        <div className="px-6 pt-4">
          <Note>{t.noPhotoReading}</Note>
        </div>
      </Section>

      {result && typed >= 2 ? (
        <>
          <Verdict result={result} confirmed={confirmed} say={say} />
          <Comparison result={result} confirmed={confirmed} say={say} />
          <Extracted result={result} confirmed={confirmed} say={say} />

          {/* ── What recording does. Permanent, never a toast. ── */}
          <div
            className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mt-6 flex flex-wrap items-end justify-between gap-4 px-6 py-4 md:bottom-0"
            style={{ background: 'var(--surface-sunken)', borderTop: '1px solid var(--border-strong)' }}
          >
            <div className="min-w-0 max-w-[720px] sm:min-w-[280px]">
              <p className="font-serif text-[15px] italic" style={{ color: 'var(--text-primary)' }}>
                {recorded ? t.savedBy(recorded.recordedBy, formatDateTime(recorded.recordedAt)) : loadWords ? t.load(loadWords) : t.checkThenSave}
              </p>
              {recorded || loadWords ? (
                <p className="mt-1 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  {recorded ? t.changeToRecheck : t.checkThenSave}
                </p>
              ) : null}
            </div>
            <Button variant="primary" disabled={confirmed} onClick={() => setConfirming(true)}>
              {confirmed ? t.saved : t.saveResult}
            </Button>
          </div>

          {/* What is kept: the values read off the papers, the verdict and
              every problem, as they stand now, under the name of the person
              who says they looked at the papers. */}
          <ConfirmModal
            open={confirming}
            onClose={() => setConfirming(false)}
            onConfirm={recordCheck}
            title={t.saveTitle}
            confirmLabel={t.save}
            consequence={
              <>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusStamp
                    status={OVERALL_FAMILY[result.overall]}
                    label={t.overall[result.overall]}
                    severity={result.overall === 'MISMATCHED' ? result.mismatchCount : undefined}
                  />
                  {loadWords ? <span>{t.load(loadWords)}</span> : null}
                </span>
                <span className="mt-3 block" style={{ color: 'var(--text-tertiary)' }}>
                  {t.savingSays(persona.name)}
                </span>
              </>
            }
          />
        </>
      ) : result ? (
        <>
          <div className="px-6 pt-6">
            <Note>{t.addSecond}</Note>
          </div>
          <Extracted result={result} confirmed={false} say={say} />
        </>
      ) : (
        <div className="px-6 pt-6">
          <Note>{t.typeTwo}</Note>
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
  placeholder,
  generation,
  doc,
  say,
  onChange,
  onAttach,
}: {
  slot: Slot;
  placeholder: string;
  generation: number;
  doc: ExtractedDocument | undefined;
  say: Say;
  onChange: (patch: Partial<Slot>) => void;
  onAttach: (file: File) => void;
}) {
  const t = useWords(crossCheckWords);
  const filled = slot.text !== '' || slot.photo !== null;
  const shown = slot.name.trim() || placeholder;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        value={slot.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder={placeholder}
        aria-label={t.paperName}
        className="h-11 w-full px-2 text-[14px] font-medium placeholder:font-normal placeholder:text-[color:var(--text-secondary)] [@media(hover:hover)]:h-[36px]"
        style={FIELD_STYLE}
      />
      {slot.photo ? (
        <img src={slot.photo} alt={t.photoOf(shown)} className="max-h-56 w-full object-contain" style={{ borderRadius: 'var(--r-1)' }} />
      ) : null}
      <textarea
        value={slot.text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={12}
        placeholder={t.typeHere}
        aria-label={t.textOf(shown)}
        className="w-full p-2 font-mono text-[13px] leading-snug"
        style={FIELD_STYLE}
      />
      <div className="flex flex-wrap items-center gap-2">
        {/* A file picker dressed as a button: the native control is too small to hit on a phone. */}
        <label
          className="inline-flex h-11 cursor-pointer items-center px-3 text-[14px] font-medium focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 [@media(hover:hover)]:h-[38px]"
          style={{ ...FIELD_STYLE, color: 'var(--text-primary)' }}
        >
          {slot.photo ? t.changePhoto : t.addPhoto}
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
            {t.delete}
          </Button>
        ) : null}
      </div>
      <DetectedType doc={doc} say={say} />
    </div>
  );
}

/**
 * Which paper this reads as. The printed words that decided it are quoted on
 * hover, in the paper's own language, so a person can disagree.
 */
function DetectedType({ doc, say }: { doc: ExtractedDocument | undefined; say: Say }) {
  const t = useWords(crossCheckWords);
  if (!doc) return null;
  if (doc.unread) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        <StatusStamp status="attention" label={t.noText} />
        <span>{t.typePhoto}</span>
      </span>
    );
  }
  if (doc.type === 'unknown') {
    return (
      <span className="flex flex-wrap items-center gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        <StatusStamp status="attention" label={t.unknown} />
        {doc.typeNote ? <span>{say.typeNote(doc.typeNote)}</span> : null}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" title={t.found(say.quotes(doc.typeEvidence))}>
      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
        {t.looksLike(t.kind[doc.type])}
      </span>
      <ConfidenceMeter level={doc.typeConfidence === 0 ? 1 : doc.typeConfidence} />
    </span>
  );
}

/* --------------------------------------------------------------- verdict */

function Verdict({ result, confirmed, say }: { result: CrossCheckResult; confirmed: boolean; say: Say }) {
  const t = useWords(crossCheckWords);
  const read = result.documents.filter((d) => !d.unread);
  return (
    <Section caption={t.resultCaption} title={t.resultTitle}>
      <div className="flex flex-col gap-3 px-6">
        <div className="flex flex-wrap items-center gap-3">
          <StatusStamp
            status={OVERALL_FAMILY[result.overall]}
            label={t.overall[result.overall]}
            severity={result.overall === 'MISMATCHED' ? result.mismatchCount : undefined}
            provisional={!confirmed}
          />
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {t.papers(read.length)}
          </span>
        </div>
        {/* Worst first, as the cross-check ranks them. */}
        {result.issues.length > 0 ? (
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-[14px]" style={{ color: 'var(--text-primary)' }}>
            {result.issues.map((issue, i) => {
              const said = say.issue(issue);
              return (
                <li key={i}>
                  {said.text}
                  {said.detail.length > 0 ? (
                    <span className="block text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      {said.detail.join(' ')}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <Note>{t.allGood}</Note>
        )}
        {/* Between papers, weights may differ by two weighbridges' display
            steps and dates by a day, for a load that crosses midnight. On any
            one paper, net = gross − tare must be exact to the kilogram. */}
        <Note>{t.mayDiffer(DEFAULT_WEIGHT_TOLERANCE_KG, t.days(DEFAULT_DATE_WINDOW_DAYS))}</Note>
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
function paperColumns(result: CrossCheckResult, t: Text): PaperColumn[] {
  const firsts = DELIVERY_PAPER_TYPES.map((k) => result.documents.find((d) => !d.unread && d.type === k) ?? null);
  const extras = result.documents.filter((d) => !d.unread && !firsts.includes(d));
  return [
    ...DELIVERY_PAPER_TYPES.map((k, i) => ({ key: k, header: t.kind[k], doc: firsts[i]! })),
    ...extras.map((d) => ({
      key: d.id,
      header: d.type === 'unknown' ? t.unknownCol(d.name) : t.secondCol(d.name, t.kind[d.type]),
      doc: d,
    })),
  ];
}

function Comparison({ result, confirmed, say }: { result: CrossCheckResult; confirmed: boolean; say: Say }) {
  const t = useWords(crossCheckWords);
  const read = result.documents.filter((d) => !d.unread);
  const netStatus = worstNet(
    read.map((d) => d.netCheck),
    t,
    say,
  );
  const rows: ComparisonRow[] = [...result.comparisons.map((c) => ({ kind: 'field' as const, c })), { kind: 'net' }];
  const rowLabel = (r: ComparisonRow) => (r.kind === 'field' ? t.compared[r.c.field] : t.netRow);

  const columns: Column<ComparisonRow>[] = [
    {
      key: 'field',
      header: t.item,
      sticky: true,
      render: (r) => <span className="font-medium">{rowLabel(r)}</span>,
    },
    ...paperColumns(result, t).map(
      (p): Column<ComparisonRow> => ({
        key: p.key,
        header: p.header,
        render: (r) => {
          if (!p.doc) return <Absent word={t.noPaper} />;
          if (r.kind === 'net') return <NetCell check={p.doc.netCheck} confirmed={confirmed} say={say} />;
          const value = r.c.values.find((v) => v.docId === p.doc!.id)?.value ?? null;
          return <ValueCell value={value} field={r.c.field} mismatch={r.c.status === 'MISMATCH'} confirmed={confirmed} say={say} />;
        },
      }),
    ),
    {
      // The stamp, and under it why — one column, so a row reads left to right
      // as "what each paper says, then what that means".
      key: 'status',
      header: t.result,
      type: 'status',
      render: (r) => {
        const why = r.kind === 'field' ? say.why(r.c.finding) : netStatus.why;
        return (
          <span className="flex flex-col items-start gap-1 py-2">
            {r.kind === 'field' ? (
              <StatusStamp
                status={FIELD_STATUS_FAMILY[r.c.status]}
                label={t.status[r.c.status]}
                severity={r.c.status === 'MISMATCH' ? mismatchSeverity(r.c, t, say) : undefined}
                provisional={!confirmed}
              />
            ) : (
              <StatusStamp status={netStatus.family} label={netStatus.label} severity={netStatus.severity} provisional={!confirmed} />
            )}
            {why ? (
              // Narrow on a phone, where this column sits beside the row's
              // name at the top of its card.
              <span
                className="block max-w-[10rem] whitespace-normal text-[13px] leading-snug md:min-w-[11rem] md:max-w-[18rem]"
                style={{ color: 'var(--text-secondary)' }}
              >
                {why}
              </span>
            ) : null}
          </span>
        );
      },
    },
  ];

  return (
    <Section caption={t.compareCaption} title={t.compareTitle}>
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
 * The figure a critical stamp carries: how far apart the weights or dates
 * are, or how many papers are out of line.
 */
function mismatchSeverity(c: FieldComparison, t: Text, say: Say): string | number {
  const readable = c.values.map((v) => v.value).filter((v): v is ExtractedValue => v !== null && v.normalized !== UNCLEAR);
  if ((c.field === 'quantity' || c.field === 'netWeight') && readable.every((v) => v.unit === 'MT')) {
    const kg = readable.map((v) => Math.round(v.amount! * 1000));
    return say.kgs(Math.max(...kg) - Math.min(...kg));
  }
  if (c.field === 'date') {
    const days = readable.map((v) => Date.parse(v.normalized) / 86_400_000);
    return t.days(Math.round(Math.max(...days) - Math.min(...days)));
  }
  return c.disagreements;
}

function worstNet(checks: NetWeightCheck[], t: Text, say: Say): { family: StatusFamily; label: string; severity?: string; why: string } {
  const failed = checks.filter((c) => c.status === 'MISMATCH');
  if (failed.length > 0) {
    const worst = Math.max(...failed.map((c) => Math.abs(c.differenceKg ?? 0)));
    return { family: 'critical', label: t.net.MISMATCH, severity: say.kgs(worst), why: t.netWrongOn(failed.length) };
  }
  if (checks.some((c) => c.status === 'NOT_POSSIBLE' || c.implausible)) {
    return { family: 'attention', label: t.net.NOT_POSSIBLE, why: t.netSomeMissing };
  }
  if (checks.some((c) => c.status === 'OK')) return { family: 'ready', label: t.net.OK, why: t.netAllRight };
  return { family: 'attention', label: t.notChecked, why: t.issue.noWeightsAnywhere };
}

function NetCell({ check, confirmed, say }: { check: NetWeightCheck; confirmed: boolean; say: Say }) {
  const t = useWords(crossCheckWords);
  if (check.status === 'NOT_APPLICABLE') {
    return (
      <span className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
        {say.net(check.finding)}
      </span>
    );
  }
  const family: Record<Exclude<NetWeightCheck['status'], 'NOT_APPLICABLE'>, StatusFamily> = {
    OK: 'ready',
    MISMATCH: 'critical',
    NOT_POSSIBLE: 'attention',
  };
  return (
    <span className="flex max-w-[18rem] flex-col gap-1 whitespace-normal py-2">
      <StatusStamp
        status={check.implausible && check.status !== 'MISMATCH' ? 'attention' : family[check.status]}
        label={t.net[check.status]}
        severity={check.status === 'MISMATCH' ? say.kgs(Math.abs(check.differenceKg ?? 0)) : undefined}
        provisional={!confirmed}
      />
      <span className="text-[13px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
        {[say.net(check.finding), ...check.conflicts.map(say.conflict)].join(' ')}
      </span>
    </span>
  );
}

/** A value as read, with the form it was compared in beneath it. Machine-read, so pencil until confirmed. */
function ValueCell({
  value,
  field,
  mismatch,
  confirmed,
  say,
}: {
  value: ExtractedValue | null;
  field: ComparedField;
  mismatch: boolean;
  confirmed: boolean;
  say: Say;
}) {
  const t = useWords(crossCheckWords);
  if (!value) return <Absent word={t.notWritten} />;
  if (value.normalized === UNCLEAR) {
    return (
      <span className="flex flex-col gap-1 py-2">
        <Provisional confirmed={confirmed}>{value.raw}</Provisional>
        <StatusStamp status="attention" label={t.status.UNCLEAR} provisional={!confirmed} />
      </span>
    );
  }
  return (
    <span className="flex flex-col py-2">
      <Provisional confirmed={confirmed}>
        <span style={mismatch ? { color: 'var(--status-critical)', fontWeight: 600 } : undefined}>{value.raw}</span>
      </Provisional>
      <span className={ID_KEYS.has(field) ? 'font-id text-[12px]' : 'text-[12px]'} style={{ color: 'var(--text-tertiary)' }}>
        {say.comparedAs(value, field)}
      </span>
      {value.derivedFrom ? (
        <span className="max-w-[11rem] whitespace-normal text-[12px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
          {t.from(value.label ?? t.field[value.derivedFrom])}
        </span>
      ) : null}
    </span>
  );
}

/** Missing information: a glyph and a word at readable contrast, never a faint dash. */
function Absent({ word }: { word: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[13px] font-medium" style={{ color: 'var(--status-attention)' }}>
      <span aria-hidden="true">◐</span>
      {word}
    </span>
  );
}

/* ------------------------------------------------------------ extraction */

function Extracted({ result, confirmed, say }: { result: CrossCheckResult; confirmed: boolean; say: Say }) {
  const t = useWords(crossCheckWords);
  const read = result.documents.filter((d) => !d.unread);
  if (read.length === 0) return null;
  return (
    <Section caption={t.readCaption} title={t.readTitle}>
      <div className="grid grid-cols-1 gap-6 px-6 xl:grid-cols-2">
        {read.map((d) => (
          <ExtractedTable key={d.id} doc={d} confirmed={confirmed} say={say} />
        ))}
      </div>
    </Section>
  );
}

function ExtractedTable({ doc, confirmed, say }: { doc: ExtractedDocument; confirmed: boolean; say: Say }) {
  const t = useWords(crossCheckWords);
  const columns: Column<DeliveryFieldKey>[] = [
    { key: 'field', header: t.item, sticky: true, render: (k) => t.field[k] },
    {
      key: 'raw',
      header: t.onPaper,
      render: (k) => {
        const v = doc.fields[k];
        return v ? (
          <Provisional confirmed={confirmed}>
            <span className="inline-block max-w-[16rem] whitespace-normal md:min-w-[10rem]">{v.raw}</span>
          </Provisional>
        ) : null;
      },
    },
    {
      key: 'normalized',
      header: t.readAs,
      render: (k) => {
        const v = doc.fields[k];
        if (!v) {
          const gap = absence(doc, k);
          return gap === 'missing' ? (
            <Absent word={t.missing} />
          ) : gap ? (
            <span className="block max-w-[14rem] whitespace-normal text-[12px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
              {gap === 'net-is-quantity' ? t.sameAsNet : t.sameAsQuantity}
            </span>
          ) : null;
        }
        return (
          <span className="flex flex-col py-1.5">
            {v.normalized === UNCLEAR ? (
              <StatusStamp status="attention" label={t.status.UNCLEAR} provisional={!confirmed} />
            ) : (
              <span className={ID_KEYS.has(k) ? 'font-id' : 'max-w-[14rem] whitespace-normal'}>{say.comparedAs(v, k)}</span>
            )}
            {v.note ? (
              <span className="max-w-[18rem] whitespace-normal text-[12px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                {say.valueNote(v.note)}
              </span>
            ) : null}
          </span>
        );
      },
    },
  ];
  return (
    <div className="min-w-0">
      <p className="pb-1 text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {doc.name}{' '}
        <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>
          — {t.kind[doc.type]}
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

/** "DC 6630 · TN22EH9857 · 13-03-2026", or null when the papers say none of it. */
function describeLoad(load: LoadIdentity | null, t: Text): string | null {
  if (!load) return null;
  const parts = [load.dcNumber ? t.dc(load.dcNumber) : null, load.vehicle, load.date ? formatDate(load.date) : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function RecordedChecks({ records }: { records: RecordedCheck[] }) {
  const t = useWords(crossCheckWords);
  const columns: Column<RecordedCheck>[] = [
    { key: 'when', header: t.rec.when, sticky: true, render: (r) => formatDateTime(r.recordedAt) },
    { key: 'dc', header: t.rec.dc, type: 'id', render: (r) => r.dcNumber },
    { key: 'vehicle', header: t.rec.vehicle, type: 'id', render: (r) => r.vehicle },
    { key: 'date', header: t.rec.date, render: (r) => (r.date ? formatDate(r.date) : null) },
    { key: 'papers', header: t.rec.papers, type: 'num', render: (r) => r.papers.length },
    {
      key: 'result',
      header: t.rec.result,
      type: 'status',
      render: (r) => (
        <StatusStamp
          status={OVERALL_FAMILY[r.result.overall]}
          label={t.overall[r.result.overall]}
          severity={r.result.overall === 'MISMATCHED' ? r.result.mismatchCount : undefined}
        />
      ),
    },
    { key: 'by', header: t.rec.by, render: (r) => r.recordedBy },
  ];
  return (
    <Section caption={t.savedCaption} title={t.savedTitle}>
      <div className="px-6">
        <DataTable columns={columns} rows={records} rowKey={(r) => r.id} rail={(r) => ({ status: OVERALL_FAMILY[r.result.overall], provenance: 'confirmed' })} />
      </div>
    </Section>
  );
}
