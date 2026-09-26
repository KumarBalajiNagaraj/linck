import { useEffect, useRef, useState } from 'react';
import {
  businessDate,
  captureExpenseBill,
  formatINR,
  parseTypedAmount,
  sitesFor,
  type BillCapture,
  type BillFieldKey,
} from '@linck/domain';
import {
  EXPENSE_KIND_LABEL,
  NOW,
  SITES,
  VEHICLES,
  type BillCaptureRecord,
  type CapturedBillField,
  type ExpenseBill,
  type Vehicle,
} from '@linck/mock';
import { Button, ConfidenceMeter, Note, Rail, SheetSection, SideSheet } from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { newBillId, useExpenses } from './expenseStore.js';
import { readBillImage } from './ocr.js';

/**
 * UPLOAD A SCANNED BILL.
 *
 * The paper bill is the evidence; the typed fields are what gets approved and
 * paid. So the scan is required and shown beside the form while the fields are
 * keyed — a bill whose amount was typed without the paper in view is the one
 * that gets paid twice.
 *
 * AUTOMATIC CAPTURE (LIN-12). Attaching a photo reads it and fills the form
 * with what it found — each filled field marked with its confidence and the
 * line it came from. Every captured value is a proposal: the person keying
 * the bill checks it against the paper and corrects it, and a correction is
 * recorded beside the original rather than replacing it.
 *
 * The bill goes in as `submitted`, the first step of the fixed chain: its
 * desk validates, the director approves, accounts pays.
 *
 * It is booked to the site in scope — the register the uploader is looking
 * at, where the new row appears. The vehicle it is against may belong to
 * another of their sites: a repair bill keyed at the workshop is against a
 * crusher's tipper.
 */

/**
 * Scans people actually take: phone photos and the office scanner's PDF.
 * No HEIC — only Safari can show it, and a scan nobody can see is no evidence.
 * iPhones hand the browser a JPEG when HEIC is not on the list.
 */
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
/** A phone photo of a bill is 2–4 MB. Anything past this is a mistake, not a bill. */
const MAX_MB = 10;

const KINDS_BY_DESK: Record<ExpenseBill['desk'], ExpenseBill['kind'][]> = {
  fleet: ['diesel', 'repair', 'tyre', 'spares', 'toll', 'other'],
  stores: ['spares', 'tyre', 'repair', 'other'],
};

const UPLOAD_PERMISSION: Record<ExpenseBill['desk'], string> = {
  fleet: 'fleet.expense.upload',
  stores: 'stores.expense.upload',
};

const FIELD_STYLE: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};
const FIELD_CLASS = 'h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[13px]';

interface Draft {
  file: File | null;
  kind: ExpenseBill['kind'];
  billNumber: string;
  billDate: string;
  vendor: string;
  description: string;
  amount: string;
  litres: string;
  vehicleId: string;
}

const blank = (desk: ExpenseBill['desk']): Draft => ({
  file: null,
  kind: KINDS_BY_DESK[desk][0]!,
  billNumber: '',
  billDate: businessDate(NOW),
  vendor: '',
  description: '',
  amount: '',
  litres: '',
  vehicleId: '',
});

const ALL_SITE_IDS = SITES.map((s) => s.id);
const siteName = (id: string) => SITES.find((s) => s.id === id)?.name ?? id;

type ReadingState = { state: 'idle' | 'reading' | 'done' | 'failed' | 'pdf'; progress: number };

export function UploadBillSheet({
  open,
  onClose,
  desk,
}: {
  open: boolean;
  onClose: () => void;
  desk: ExpenseBill['desk'];
}) {
  const { persona, siteScope } = useApp();
  const add = useExpenses((s) => s.add);
  const [draft, setDraft] = useState<Draft>(() => blank(desk));
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [unviewable, setUnviewable] = useState(false);
  const [capture, setCapture] = useState<{ result: BillCapture; engine: string; text: string } | null>(null);
  const [reading, setReading] = useState<ReadingState>({ state: 'idle', progress: 0 });
  const [pasted, setPasted] = useState('');
  /** Ignores a slow read that finishes after the file was replaced. */
  const readToken = useRef(0);
  /**
   * Fields the person has set since this file was picked. A reading that
   * lands afterwards never overwrites them: reading takes seconds, and a
   * person who has already chosen "Repair" must not find "Other" back.
   */
  const touched = useRef(new Set<keyof Draft>());

  // The preview URL is released when it is replaced, when the sheet closes
  // without saving, and when the screen goes — but not once a saved bill
  // holds it, because the register shows that bill's scan from it.
  const held = useRef<{ url: string | null; saved: boolean }>({ url: null, saved: false });
  const release = () => {
    if (held.current.url && !held.current.saved) URL.revokeObjectURL(held.current.url);
    held.current = { url: null, saved: false };
  };
  useEffect(() => release, []);
  useEffect(() => {
    if (!open) {
      release();
      setDraft(blank(desk));
      setPreview(null);
      setFileError(null);
      setUnviewable(false);
      setCapture(null);
      setReading({ state: 'idle', progress: 0 });
      setPasted('');
      readToken.current += 1;
    }
  }, [open, desk]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    touched.current.add(key);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  // Vehicles at every site this person may upload for, the one in scope first.
  const uploadSites = sitesFor(persona.grants, UPLOAD_PERMISSION[desk], ALL_SITE_IDS);
  const siteOrder = [...uploadSites].sort((a, b) => Number(b === siteScope) - Number(a === siteScope));
  const vehicleGroups = siteOrder
    .map((siteId) => ({ siteId, vehicles: VEHICLES.filter((v) => v.siteId === siteId) }))
    .filter((g) => g.vehicles.length > 0);
  const offered = vehicleGroups.flatMap((g) => g.vehicles);
  const vehicle: Vehicle | null = offered.find((v) => v.id === draft.vehicleId) ?? null;
  const bookedTo = siteScope ?? vehicle?.siteId ?? (uploadSites.includes(persona.defaultSiteId ?? '') ? persona.defaultSiteId : uploadSites[0]) ?? null;

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    const refuse = (message: string) => {
      // The earlier scan and its reading go too: figures keyed from bill B
      // must never be submitted against bill A's photo.
      release();
      readToken.current += 1;
      setPreview(null);
      setDraft((d) => ({ ...d, file: null }));
      setCapture(null);
      setReading({ state: 'idle', progress: 0 });
      setFileError(message);
    };
    if (!ACCEPT.split(',').includes(file.type)) {
      refuse('That is not a JPG, PNG or PDF. Upload the scan of the bill itself; nothing is attached now.');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      refuse(`That file is over ${MAX_MB} MB. Retake the photo at a normal size; nothing is attached now.`);
      return;
    }
    release();
    const url = URL.createObjectURL(file);
    held.current = { url, saved: false };
    setFileError(null);
    setUnviewable(false);
    setPreview(url);
    setDraft((d) => ({ ...d, file }));
    touched.current = new Set();
    setCapture(null);
    if (file.type === 'application/pdf') {
      setReading({ state: 'pdf', progress: 0 });
      return;
    }
    const token = ++readToken.current;
    setReading({ state: 'reading', progress: 0 });
    readBillImage(file, (progress) => {
      if (token === readToken.current) setReading({ state: 'reading', progress });
    })
      .then((ocr) => {
        if (token !== readToken.current) return;
        applyCapture(captureExpenseBill(ocr.text, ocr.lineConfidence), ocr.engine, ocr.text);
        setReading({ state: 'done', progress: 1 });
      })
      .catch(() => {
        if (token === readToken.current) setReading({ state: 'failed', progress: 0 });
      });
  };

  /**
   * Fills the form from a capture. Only fields capture actually found are
   * filled, and — for a photo read in the background — only fields the
   * person has not set meanwhile. Text they paste and ask to capture is a
   * deliberate request, so it fills every field it finds.
   */
  const applyCapture = (result: BillCapture, engine: string, text: string, requested = false) => {
    setCapture({ result, engine, text });
    const f = result.fields;
    const free = (key: keyof Draft) => requested || !touched.current.has(key);
    setDraft((d) => {
      // "Other" with no word behind it is capture finding nothing, not a reading.
      const kindRead = f.kind && f.kind.source !== '' && KINDS_BY_DESK[desk].includes(f.kind.value as ExpenseBill['kind']);
      // Matched only against the vehicles the form can offer — a match
      // elsewhere would set a value the select cannot show.
      const match = f.vehicle ? offered.find((v) => v.registrationNumber === f.vehicle!.value) : undefined;
      return {
        ...d,
        kind: kindRead && free('kind') ? (f.kind!.value as ExpenseBill['kind']) : d.kind,
        billNumber: f.billNumber && free('billNumber') ? f.billNumber.value : d.billNumber,
        // A date capture could not read is cleared, not left on today: a
        // default that looks like an answer gets submitted without a glance.
        billDate: free('billDate') ? (f.billDate?.value ?? '') : d.billDate,
        vendor: f.vendor && free('vendor') ? f.vendor.value : d.vendor,
        amount: f.amount && free('amount') ? f.amount.value : d.amount,
        litres: f.litres && free('litres') ? f.litres.value : d.litres,
        vehicleId: match && free('vehicleId') ? match.id : d.vehicleId,
      };
    });
  };

  /** The captured reading for one form field, and whether the form now disagrees with it. */
  const capturedFor = (key: BillFieldKey, current: string): CapturedMark | null => {
    const field = capture?.result.fields[key];
    if (!field || (key === 'kind' && field.source === '')) return null;
    // A registration read cleanly but not among the vehicles offered is not a
    // correction the user made — it is a vehicle the form cannot pick.
    if (key === 'vehicle' && !current && !offered.some((v) => v.registrationNumber === field.value)) {
      return { value: field.value, confidence: field.confidence, source: field.source, corrected: false, unmatched: true };
    }
    const same =
      key === 'amount' || key === 'litres'
        ? parseTypedAmount(current, 3) !== null && parseTypedAmount(current, 3) === parseTypedAmount(field.value, 3)
        : current.trim().toUpperCase() === field.value.trim().toUpperCase();
    return { value: field.value, confidence: field.confidence, source: field.source, corrected: !same, unmatched: false };
  };

  const amount = parseTypedAmount(draft.amount);
  const litres = parseTypedAmount(draft.litres, 3);
  const today = businessDate(NOW);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(draft.billDate) && !Number.isNaN(Date.parse(`${draft.billDate}T00:00:00+05:30`));
  const needsVehicle = desk === 'fleet' && draft.kind !== 'toll' && draft.kind !== 'other';
  const amountError = draft.amount.trim() !== '' && (amount === null || amount <= 0) ? 'Type the total as printed, such as 12,500.00' : null;
  const litresError = draft.litres.trim() !== '' && (litres === null || litres <= 0) ? 'Type the litres as printed, such as 120.45' : null;
  const dateError = !dateOk ? 'Pick the date printed on the bill' : draft.billDate > today ? 'A bill cannot be dated after today' : null;
  const problems = [
    draft.file ? null : 'Attach the scanned bill',
    draft.billNumber.trim() ? null : 'Bill number',
    dateError ? 'Bill date' : null,
    draft.vendor.trim() ? null : 'Vendor',
    amount !== null && amount > 0 ? null : 'Amount',
    draft.kind === 'diesel' && !(litres !== null && litres > 0) ? 'Litres' : null,
    needsVehicle && !vehicle ? 'Vehicle' : null,
    bookedTo ? null : 'Site',
  ].filter((p): p is string => p !== null);

  const save = () => {
    if (problems.length > 0 || !draft.file || !preview || !bookedTo || amount === null || !dateOk) return;
    const record: BillCaptureRecord | null = capture
      ? {
          engine: capture.engine,
          capturedAt: NOW.toISOString(),
          warnings: capture.result.warnings,
          fields: (
            [
              ['kind', 'Type', draft.kind],
              ['billNumber', 'Bill number', draft.billNumber.trim()],
              ['billDate', 'Bill date', draft.billDate],
              ['vendor', 'Vendor', draft.vendor.trim()],
              ['vehicle', 'Vehicle', vehicle?.registrationNumber ?? ''],
              ['litres', 'Litres', draft.kind === 'diesel' && litres !== null ? String(litres) : ''],
              ['amount', 'Amount', amount.toFixed(2)],
            ] as [BillFieldKey, string, string][]
          ).map(([key, label, value]): CapturedBillField => {
            const c = capturedFor(key, value);
            return {
              key,
              label,
              captured: c?.value ?? null,
              confidence: c?.confidence ?? null,
              value,
              overridden: c?.corrected ?? false,
              overriddenBy: c?.corrected ? persona.name : null,
            };
          }),
        }
      : null;
    const anyOverride = record?.fields.some((f) => f.overridden) ?? false;
    add({
      id: newBillId(),
      desk,
      billNumber: draft.billNumber.trim(),
      kind: draft.kind,
      billDate: new Date(`${draft.billDate}T00:00:00+05:30`).toISOString(),
      vehicleId: vehicle?.id ?? null,
      driverId: draft.kind === 'diesel' ? (vehicle?.driverId ?? null) : null,
      vendor: draft.vendor.trim(),
      description: draft.description.trim() || EXPENSE_KIND_LABEL[draft.kind],
      litres: draft.kind === 'diesel' ? litres : null,
      amount: amount.toFixed(2),
      status: 'submitted',
      submittedBy: persona.name,
      submittedById: `user:${persona.key}`,
      submittedAt: NOW.toISOString(),
      siteId: bookedTo,
      // Keyed with no capture is a human value; captured and accepted as read
      // is confirmed; any correction marks the whole bill overridden.
      provenance: record ? (anyOverride ? 'overridden' : 'confirmed') : 'human',
      capture: record,
      attachment: {
        fileName: draft.file.name,
        mimeType: draft.file.type,
        sizeKb: Math.round(draft.file.size / 1024),
        url: preview,
      },
    });
    held.current.saved = true;
    onClose();
  };

  const isPdf = draft.file?.type === 'application/pdf';

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      width="split"
      title={desk === 'fleet' ? 'Upload a fleet bill' : 'Upload a stores bill'}
      footer={
        <>
          <Button variant="primary" onClick={save} disabled={problems.length > 0}>
            Submit for approval
          </Button>
          <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            {problems.length > 0
              ? `Still needed: ${problems.join(', ')}`
              : `Booked to ${siteName(bookedTo!)}. Goes to validation first, then the director, then accounts.`}
          </span>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <SheetSection caption="The scan">
          {/* No `capture`: on a phone that forces the camera, and a bill that
              arrived as a PDF on WhatsApp, or a photo already taken, could
              never be picked. Without it the phone offers camera and files. */}
          <label
            className="flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-2 p-3 text-center text-[13px] focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--focus-ring)]"
            style={FIELD_STYLE}
          >
            {preview && !isPdf && !unviewable ? (
              <img src={preview} alt="Scanned bill" className="max-h-[360px] w-full object-contain" onError={() => setUnviewable(true)} />
            ) : preview ? (
              <span style={{ color: 'var(--text-primary)' }}>
                {isPdf ? 'PDF attached' : 'Attached, but this browser cannot show it'} — {draft.file?.name}
              </span>
            ) : (
              <span style={{ color: 'var(--text-secondary)' }}>
                Tap to photograph the bill or choose the file
                <br />
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  JPG, PNG or PDF, up to {MAX_MB} MB
                </span>
              </span>
            )}
            <input
              type="file"
              accept={ACCEPT}
              className="sr-only"
              aria-label="Scanned bill"
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                // Cleared at once, so picking the same file again still fires.
                e.target.value = '';
              }}
            />
          </label>
          <CaptureStatus reading={reading} warnings={capture?.result.warnings ?? []} />
          {capture ? (
            <details className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <summary className="cursor-pointer">Text read from the {capture.engine === 'pasted text' ? 'pasted bill' : 'photo'}</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px]" style={FIELD_STYLE}>
                {capture.text}
              </pre>
            </details>
          ) : null}
          {reading.state === 'failed' || reading.state === 'pdf' || reading.state === 'done' ? (
            <details className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <summary className="cursor-pointer">Read from pasted text instead</summary>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={6}
                aria-label="Bill text"
                placeholder="Paste the bill's text here"
                className="mt-2 w-full p-2 font-mono text-[12px]"
                style={FIELD_STYLE}
              />
              <Button onClick={() => pasted.trim() && applyCapture(captureExpenseBill(pasted), 'pasted text', pasted, true)}>Capture from text</Button>
            </details>
          ) : null}
          {fileError ? (
            <p className="relative mt-2 pl-3 text-[12px]" style={{ color: 'var(--status-critical)' }}>
              <Rail status="critical" />
              {fileError}
            </p>
          ) : null}
        </SheetSection>

        <SheetSection caption="What the bill says">
          <div className="flex flex-col gap-3">
            <Field label="Type" captured={capturedFor('kind', draft.kind)}>
              <select value={draft.kind} onChange={(e) => set('kind', e.target.value as ExpenseBill['kind'])} className={FIELD_CLASS} style={FIELD_STYLE}>
                {KINDS_BY_DESK[desk].map((k) => (
                  <option key={k} value={k}>
                    {EXPENSE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bill number" captured={capturedFor('billNumber', draft.billNumber)}>
              <input value={draft.billNumber} onChange={(e) => set('billNumber', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label="Bill date" captured={capturedFor('billDate', draft.billDate)} error={dateError}>
              <input
                type="date"
                value={draft.billDate}
                max={today}
                onChange={(e) => set('billDate', e.target.value)}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              />
            </Field>
            <Field label="Vendor" captured={capturedFor('vendor', draft.vendor)}>
              <input value={draft.vendor} onChange={(e) => set('vendor', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label="What for">
              <input value={draft.description} onChange={(e) => set('description', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            {desk === 'fleet' ? (
              <Field label={needsVehicle ? 'Vehicle' : 'Vehicle (optional)'} captured={capturedFor('vehicle', vehicle?.registrationNumber ?? '')}>
                <select value={vehicle?.id ?? ''} onChange={(e) => set('vehicleId', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE}>
                  <option value="">—</option>
                  {vehicleGroups.map((g) => (
                    <optgroup key={g.siteId} label={siteName(g.siteId)}>
                      {g.vehicles.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.displayReg}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
            ) : null}
            {draft.kind === 'diesel' ? (
              <Field
                label="Litres"
                captured={capturedFor('litres', draft.litres)}
                error={litresError}
                echo={litres !== null && litres > 0 ? `${litres} L` : null}
              >
                <input inputMode="decimal" value={draft.litres} onChange={(e) => set('litres', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
              </Field>
            ) : null}
            <Field
              label="Amount ₹ (bill total, incl. GST)"
              captured={capturedFor('amount', draft.amount)}
              error={amountError}
              echo={amount !== null && amount > 0 ? formatINR(amount) : null}
            >
              <input inputMode="decimal" value={draft.amount} onChange={(e) => set('amount', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
          </div>
        </SheetSection>
      </div>
      <Note>Type what the paper says, not what it should say. A wrong bill is rejected at validation, never corrected silently.</Note>
    </SideSheet>
  );
}

interface CapturedMark {
  value: string;
  confidence: 1 | 2 | 3;
  source: string;
  corrected: boolean;
  /** Read cleanly, but matches nothing the form can select. */
  unmatched: boolean;
}

/**
 * A labelled field. The input itself never turns red — the typed value has to
 * stay readable while it is corrected; a rail and a line carry the alarm. The
 * echo reads back what a typed figure was taken as, before anyone submits it.
 */
function Field({
  label,
  children,
  captured,
  error = null,
  echo = null,
}: {
  label: string;
  children: React.ReactNode;
  captured?: CapturedMark | null;
  error?: string | null;
  echo?: string | null;
}) {
  return (
    <label className="relative flex flex-col gap-1">
      {error ? <Rail status="critical" className="-left-2" /> : null}
      <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
        {label}
        {captured ? (
          <span className="flex items-center gap-1.5 normal-case tracking-normal" title={`Read from: ${captured.source}`}>
            <ConfidenceMeter level={captured.confidence} />
            {captured.unmatched ? (
              <span style={{ color: 'var(--status-attention)' }}>scan read {captured.value} — not one of your vehicles</span>
            ) : captured.corrected ? (
              <span style={{ color: 'var(--status-attention)' }}>corrected — scan read {captured.value}</span>
            ) : (
              <span>read from scan</span>
            )}
          </span>
        ) : null}
      </span>
      {children}
      {error ? (
        <span className="text-[11px]" style={{ color: 'var(--status-critical)' }}>
          {error}
        </span>
      ) : echo ? (
        <span className="num text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          Read as {echo}
        </span>
      ) : null}
    </label>
  );
}

function CaptureStatus({ reading, warnings }: { reading: ReadingState; warnings: string[] }) {
  const text =
    reading.state === 'reading'
      ? `Reading the bill… ${Math.round(reading.progress * 100)}%`
      : reading.state === 'done'
        ? 'Read. Check every filled field against the paper — the bars show how sure the reading is.'
        : reading.state === 'failed'
          ? 'Could not read this photo. Key the fields from the paper.'
          : reading.state === 'pdf'
            ? 'PDFs are not read automatically yet. Key the fields, or paste the text below.'
            : null;
  if (!text) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 text-[12px]" style={{ color: reading.state === 'failed' ? 'var(--status-critical)' : 'var(--text-secondary)' }}>
      <span aria-live="polite">{text}</span>
      {warnings.map((w) => (
        <span key={w} style={{ color: 'var(--status-attention)' }}>
          {w}
        </span>
      ))}
    </div>
  );
}
