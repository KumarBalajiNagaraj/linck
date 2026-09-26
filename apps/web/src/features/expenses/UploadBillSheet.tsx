import { useEffect, useState } from 'react';
import { EXPENSE_KIND_LABEL, NOW, vehiclesForSite, type ExpenseBill } from '@linck/mock';
import { Button, Note, SheetSection, SideSheet } from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { newBillId, useExpenses } from './expenseStore.js';

/**
 * UPLOAD A SCANNED BILL.
 *
 * The paper bill is the evidence; the typed fields are what gets approved and
 * paid. So the scan is required and shown beside the form while the fields are
 * keyed — a bill whose amount was typed without the paper in view is the one
 * that gets paid twice.
 *
 * The bill goes in as `submitted`, the first step of the fixed chain: its
 * desk validates, the director approves, accounts pays.
 */

/** Scans people actually take: phone photos and the office scanner's PDF. */
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,application/pdf';
/** A phone photo of a bill is 2–4 MB. Anything past this is a mistake, not a bill. */
const MAX_MB = 10;

const KINDS_BY_DESK: Record<ExpenseBill['desk'], ExpenseBill['kind'][]> = {
  fleet: ['diesel', 'repair', 'tyre', 'spares', 'toll', 'other'],
  stores: ['spares', 'tyre', 'repair', 'other'],
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
  billDate: NOW.toISOString().slice(0, 10),
  vendor: '',
  description: '',
  amount: '',
  litres: '',
  vehicleId: '',
});

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

  // The preview URL is released when it is replaced or the sheet closes —
  // except once it has been handed to a saved bill, which now owns it.
  useEffect(() => {
    if (!open) {
      setDraft(blank(desk));
      setPreview(null);
      setFileError(null);
    }
  }, [open, desk]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPT.split(',').includes(file.type)) {
      setFileError('That is not a photo or a PDF. Upload the scan of the bill itself.');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setFileError(`That file is over ${MAX_MB} MB. Retake the photo at a normal size.`);
      return;
    }
    setFileError(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    set('file', file);
  };

  const amount = Number.parseFloat(draft.amount);
  const litres = Number.parseFloat(draft.litres);
  const needsVehicle = desk === 'fleet' && draft.kind !== 'toll' && draft.kind !== 'other';
  const problems = [
    draft.file ? null : 'Attach the scanned bill',
    draft.billNumber.trim() ? null : 'Bill number',
    draft.vendor.trim() ? null : 'Vendor',
    Number.isFinite(amount) && amount > 0 ? null : 'Amount',
    draft.kind === 'diesel' && !(Number.isFinite(litres) && litres > 0) ? 'Litres' : null,
    needsVehicle && !draft.vehicleId ? 'Vehicle' : null,
  ].filter((p): p is string => p !== null);

  const vehicles = vehiclesForSite(siteScope);
  const siteId =
    (draft.vehicleId ? vehicles.find((v) => v.id === draft.vehicleId)?.siteId : null) ??
    siteScope ??
    (desk === 'stores' ? 'site-wsp' : 'site-krp');

  const save = () => {
    if (problems.length > 0 || !draft.file || !preview) return;
    const vehicle = vehicles.find((v) => v.id === draft.vehicleId) ?? null;
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
      submittedAt: NOW.toISOString(),
      siteId,
      provenance: 'human',
      attachment: {
        fileName: draft.file.name,
        mimeType: draft.file.type,
        sizeKb: Math.round(draft.file.size / 1024),
        url: preview,
      },
    });
    onClose();
  };

  const isPdf = draft.file?.type === 'application/pdf';

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      width="split"
      title="Upload a bill"
      identifier={desk === 'fleet' ? 'Fleet expenses' : 'Stores expenses'}
      footer={
        <>
          <Button variant="primary" onClick={save} disabled={problems.length > 0}>
            Submit for approval
          </Button>
          <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            {problems.length > 0 ? `Still needed: ${problems.join(', ')}` : 'Goes to validation first, then the director, then accounts.'}
          </span>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <SheetSection caption="The scan">
          <label
            className="flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-2 p-3 text-center text-[13px]"
            style={{ ...FIELD_STYLE, boxShadow: 'inset 0 0 0 1px var(--border-strong)', borderStyle: 'dashed' }}
          >
            {preview && !isPdf ? (
              <img src={preview} alt="Scanned bill" className="max-h-[360px] w-full object-contain" />
            ) : preview && isPdf ? (
              <span style={{ color: 'var(--text-primary)' }}>PDF attached — {draft.file?.name}</span>
            ) : (
              <span style={{ color: 'var(--text-secondary)' }}>
                Tap to photograph or choose the bill
                <br />
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  JPG, PNG, HEIC or PDF, up to {MAX_MB} MB
                </span>
              </span>
            )}
            <input
              type="file"
              accept={ACCEPT}
              capture="environment"
              className="sr-only"
              aria-label="Scanned bill"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </label>
          {fileError ? (
            <p className="mt-2 text-[12px]" style={{ color: 'var(--status-critical)' }}>
              {fileError}
            </p>
          ) : null}
        </SheetSection>

        <SheetSection caption="What the bill says">
          <div className="flex flex-col gap-3">
            <Field label="Type">
              <select value={draft.kind} onChange={(e) => set('kind', e.target.value as ExpenseBill['kind'])} className={FIELD_CLASS} style={FIELD_STYLE}>
                {KINDS_BY_DESK[desk].map((k) => (
                  <option key={k} value={k}>
                    {EXPENSE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bill number">
              <input value={draft.billNumber} onChange={(e) => set('billNumber', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label="Bill date">
              <input type="date" value={draft.billDate} onChange={(e) => set('billDate', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label="Vendor">
              <input value={draft.vendor} onChange={(e) => set('vendor', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label="What for">
              <input value={draft.description} onChange={(e) => set('description', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            {desk === 'fleet' ? (
              <Field label={needsVehicle ? 'Vehicle' : 'Vehicle (optional)'}>
                <select value={draft.vehicleId} onChange={(e) => set('vehicleId', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE}>
                  <option value="">—</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.displayReg}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {draft.kind === 'diesel' ? (
              <Field label="Litres">
                <input inputMode="decimal" value={draft.litres} onChange={(e) => set('litres', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
              </Field>
            ) : null}
            <Field label="Amount ₹ (bill total, incl. GST)">
              <input inputMode="decimal" value={draft.amount} onChange={(e) => set('amount', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
          </div>
        </SheetSection>
      </div>
      <Note>Type what the paper says, not what it should say. A wrong bill is rejected at validation, never corrected silently.</Note>
    </SideSheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}
