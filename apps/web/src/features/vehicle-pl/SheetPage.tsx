import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { calculateSheet, can, decimal, formatDate, purchaseFigures, saleFigures, type SheetCalc, type TripCalc } from '@linck/domain';
import { DRIVERS, VEHICLES, type PlDieselSource, type PlEnRouteKind, type PlMaintenanceKind, type PlPartyDue, type PlSaleInvoice, type PlSheetInput, type PlSheetRecord } from '@linck/mock';
import { Button, ConfirmModal, PageHeader, Rail, Section } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useExpenses } from '../expenses/expenseStore.js';
import { invoicePath, liveInvoices, useInvoices } from './invoiceStore.js';
import { invoiceWords } from './invoiceWords.js';
import { CTRL, FIELD_BOX, Signed } from './PlParts.js';
import {
  CLOSE,
  dieselBillsFor,
  draftDomain,
  fuelEntriesFor,
  mastersOf,
  ordersFor,
  LIST_PATH,
  READ_KEYS,
  readable,
  sheetPath,
  todayIso,
  usePl,
  usePlBook,
  WRITE,
  type PlProblem,
} from './plStore.js';
import { SheetInvoices } from './SheetInvoices.js';
import { plWords, sheetWords } from './words.js';

/* ------------------------------------------------------------- the draft */

let seq = 0;
const key = () => `k${(seq += 1)}`;
const MODES = ['UPI', 'NEFT', 'RTGS', 'IMPS', 'Cheque', 'Cash'] as const;
const MAINT: PlMaintenanceKind[] = ['tyre_rotation', 'wheel_alignment', 'greasing', 'engine_oil', 'coolant', 'misc'];

interface DDiesel { key: string; id?: string; source: PlDieselSource; litres: string; rate: string; amount: string; vendorId: string; vendor: string; billNumber: string; expenseBillId: string; fuelEntryId: string; filledAt: string | null; attachmentId: string | null }
interface DRoad { key: string; id?: string; kind: PlEnRouteKind; maintenanceKind: string; description: string; date: string; location: string; reference: string; amount: string; attachmentId: string | null }
interface DPurchase { key: string; id?: string; vendorId: string; location: string; materialId: string; hsnCode: string; unit: string; quantity: string; rate: string; gstBilled: boolean; gstRatePct: string; vendorGstin: string; invoiceNumber: string; invoiceDate: string; attachmentIds: string[] }
interface DSale { key: string; id?: string; customerId: string; location: string; purchaseOrderId: string; poRef: string; materialId: string; hsnCode: string; unit: string; quantity: string; rate: string; transport: string; gstBilled: boolean; gstRatePct: string; partyGstin: string; challanNumber: string; invoiceNumber: string; poAttachmentId: string | null; dcAttachmentId: string | null }
interface DPayment { key: string; id?: string; direction: 'in' | 'out'; partyId: string; paidOn: string; mode: (typeof MODES)[number]; reference: string; amount: string; note: string }
interface DTrip { key: string; id?: string; tripNumber?: string; date: string; startKm: string; endKm: string; batta: string; notes: string; diesel: DDiesel[]; enRoute: DRoad[]; purchases: DPurchase[]; sales: DSale[]; payments: DPayment[]; more: boolean }
interface Draft { siteId: string; vehicleId: string; registrationNumber: string; vehicleModel: string; driverId: string; driverName: string; driverPhone: string; startDate: string; endDate: string; startKm: string; endKm: string; batta: string; notes: string; diesel: DDiesel[]; enRoute: DRoad[]; payments: DPayment[]; trips: DTrip[] }

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const num = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
const amount = (v: string) => (v.trim() === '' ? null : v.trim());

const blankDiesel = (): DDiesel => ({ key: key(), source: 'typed', litres: '', rate: '', amount: '', vendorId: '', vendor: '', billNumber: '', expenseBillId: '', fuelEntryId: '', filledAt: null, attachmentId: null });
const blankRoad = (date: string): DRoad => ({ key: key(), kind: 'toll', maintenanceKind: '', description: '', date, location: '', reference: '', amount: '', attachmentId: null });
const blankPurchase = (date: string): DPurchase => ({ key: key(), vendorId: '', location: '', materialId: '', hsnCode: '', unit: '', quantity: '', rate: '', gstBilled: true, gstRatePct: '', vendorGstin: '', invoiceNumber: '', invoiceDate: date, attachmentIds: [] });
const blankSale = (): DSale => ({ key: key(), customerId: '', location: '', purchaseOrderId: '', poRef: '', materialId: '', hsnCode: '', unit: '', quantity: '', rate: '', transport: '', gstBilled: true, gstRatePct: '', partyGstin: '', challanNumber: '', invoiceNumber: '', poAttachmentId: null, dcAttachmentId: null });
const blankPayment = (direction: 'in' | 'out', date: string): DPayment => ({ key: key(), direction, partyId: '', paidOn: date, mode: 'UPI', reference: '', amount: '', note: '' });
const blankTrip = (date: string): DTrip => ({ key: key(), date, startKm: '', endKm: '', batta: '', notes: '', diesel: [], enRoute: [], purchases: [blankPurchase(date)], sales: [blankSale()], payments: [], more: false });

function fromRecord(r: PlSheetRecord): Draft {
  const diesel = (d: PlSheetRecord['diesel'][number]): DDiesel => ({ key: key(), id: d.id, source: d.source, litres: s(d.litres), rate: s(d.rate), amount: s(d.amount), vendorId: d.vendorId ?? '', vendor: d.vendor ?? '', billNumber: d.billNumber ?? '', expenseBillId: d.expenseBillId ?? '', fuelEntryId: d.fuelEntryId ?? '', filledAt: d.filledAt ?? null, attachmentId: d.attachment?.id ?? null });
  const road = (e: PlSheetRecord['enRoute'][number]): DRoad => ({ key: key(), id: e.id, kind: e.kind, maintenanceKind: e.maintenanceKind ?? '', description: e.description ?? '', date: e.date ?? '', location: e.location ?? '', reference: e.reference ?? '', amount: s(e.amount), attachmentId: e.attachment?.id ?? null });
  const pay = (m: PlSheetRecord['payments'][number]): DPayment => ({ key: key(), id: m.id, direction: m.direction, partyId: m.partyId, paidOn: m.paidOn, mode: m.mode, reference: m.reference ?? '', amount: s(m.amount), note: m.note ?? '' });
  return {
    siteId: r.siteId,
    vehicleId: r.vehicleId,
    registrationNumber: r.registrationNumber,
    vehicleModel: r.vehicleModel,
    driverId: r.driverId ?? '',
    driverName: r.driverName,
    driverPhone: r.driverPhone,
    startDate: r.startDate,
    endDate: r.endDate ?? '',
    startKm: s(r.startKm),
    endKm: s(r.endKm),
    batta: s(r.batta),
    notes: r.notes,
    diesel: r.diesel.map(diesel),
    enRoute: r.enRoute.map(road),
    payments: r.payments.map(pay),
    trips: [...r.trips]
      .sort((a, b) => (a.date === b.date ? a.tripNumber.localeCompare(b.tripNumber) : a.date < b.date ? -1 : 1))
      .map((t) => ({
        key: key(),
        id: t.id,
        tripNumber: t.tripNumber,
        date: t.date,
        startKm: s(t.startKm),
        endKm: s(t.endKm),
        batta: s(t.batta),
        notes: t.notes,
        diesel: t.diesel.map(diesel),
        enRoute: t.enRoute.map(road),
        payments: t.payments.map(pay),
        more: t.diesel.length + t.enRoute.length > 0 || t.batta !== null || t.startKm !== null,
        purchases: t.purchases.map((p) => ({ key: key(), id: p.id, vendorId: p.vendorId, location: p.location ?? '', materialId: p.materialId, hsnCode: p.hsnCode ?? '', unit: p.unit, quantity: s(p.quantity), rate: s(p.rate), gstBilled: p.gstBilled, gstRatePct: p.gstBilled ? s(p.gstRatePct) : '', vendorGstin: p.vendorGstin ?? '', invoiceNumber: p.invoiceNumber ?? '', invoiceDate: p.invoiceDate ?? '', attachmentIds: p.attachments.map((a) => a.id) })),
        sales: t.sales.map((x) => ({ key: key(), id: x.id, customerId: x.customerId, location: x.location ?? '', purchaseOrderId: x.purchaseOrderId ?? '', poRef: x.poRef ?? '', materialId: x.materialId, hsnCode: x.hsnCode ?? '', unit: x.unit, quantity: s(x.quantity), rate: s(x.rate), transport: s(x.transport), gstBilled: x.gstBilled, gstRatePct: x.gstBilled ? s(x.gstRatePct) : '', partyGstin: x.partyGstin ?? '', challanNumber: x.challanNumber ?? '', invoiceNumber: x.invoiceNumber ?? '', poAttachmentId: x.poAttachment?.id ?? null, dcAttachmentId: x.dcAttachment?.id ?? null })),
      })),
  };
}

function blankDraft(grantsSite: (siteId: string) => boolean): Draft {
  const today = todayIso();
  const vehicle = VEHICLES.find((v) => grantsSite(v.siteId));
  const driver = DRIVERS.find((d) => d.id === vehicle?.driverId);
  return {
    siteId: vehicle?.siteId ?? '',
    vehicleId: vehicle?.id ?? '',
    registrationNumber: vehicle?.displayReg ?? '',
    vehicleModel: vehicle?.model ?? '',
    driverId: driver?.id ?? '',
    driverName: driver?.name ?? '',
    driverPhone: driver?.phone ?? '',
    startDate: today,
    endDate: today,
    startKm: '',
    endKm: '',
    batta: '',
    notes: '',
    diesel: [blankDiesel()],
    enRoute: [],
    payments: [],
    trips: [blankTrip(today)],
  };
}

function toInput(d: Draft): PlSheetInput {
  const diesel = (x: DDiesel) => ({
    id: x.id ?? null,
    source: x.source,
    ...(x.source === 'expense_bill'
      ? { expenseBillId: x.expenseBillId || null }
      : x.source === 'fuel_entry'
        ? { fuelEntryId: x.fuelEntryId || null, litres: num(x.litres), amount: amount(x.amount), billNumber: x.billNumber, vendor: x.vendor, filledAt: x.filledAt }
        : { litres: num(x.litres), rate: amount(x.rate), vendorId: x.vendorId || null, billNumber: x.billNumber, attachmentId: x.attachmentId }),
  });
  const road = (x: DRoad) => ({ id: x.id ?? null, kind: x.kind, maintenanceKind: x.kind === 'maintenance' ? (x.maintenanceKind as PlMaintenanceKind) || null : null, description: x.description, date: x.date || null, location: x.location, reference: x.reference, amount: x.amount.trim(), attachmentId: x.attachmentId });
  const pay = (x: DPayment) => ({ id: x.id ?? null, direction: x.direction, partyId: x.partyId, paidOn: x.paidOn, mode: x.mode, reference: x.reference.trim().toUpperCase() || null, amount: x.amount.trim(), note: x.note });
  return {
    siteId: d.siteId,
    vehicleId: d.vehicleId,
    registrationNumber: d.registrationNumber,
    vehicleModel: d.vehicleModel,
    driverId: d.driverId || null,
    driverName: d.driverName,
    driverPhone: d.driverPhone,
    startDate: d.startDate,
    endDate: d.endDate || null,
    startKm: num(d.startKm),
    endKm: num(d.endKm),
    batta: amount(d.batta),
    notes: d.notes,
    diesel: d.diesel.map(diesel),
    enRoute: d.enRoute.map(road),
    payments: d.payments.map(pay),
    trips: d.trips.map((t) => ({
      id: t.id ?? null,
      date: t.date,
      startKm: num(t.startKm),
      endKm: num(t.endKm),
      batta: amount(t.batta),
      notes: t.notes,
      diesel: t.diesel.map(diesel),
      enRoute: t.enRoute.map(road),
      payments: t.payments.map(pay),
      purchases: t.purchases.map((p) => ({ id: p.id ?? null, vendorId: p.vendorId, location: p.location, materialId: p.materialId, hsnCode: p.hsnCode || null, unit: p.unit || null, quantity: num(p.quantity) ?? 0, rate: p.rate.trim(), gstBilled: p.gstBilled, gstRatePct: p.gstBilled ? num(p.gstRatePct) : null, vendorGstin: p.vendorGstin.trim().toUpperCase() || null, invoiceNumber: p.invoiceNumber, invoiceDate: p.invoiceDate || null, attachmentIds: p.attachmentIds })),
      sales: t.sales.map((x) => ({ id: x.id ?? null, customerId: x.customerId, location: x.location, purchaseOrderId: x.purchaseOrderId || null, poRef: x.poRef, materialId: x.materialId, hsnCode: x.hsnCode || null, unit: x.unit || null, quantity: num(x.quantity) ?? 0, rate: x.rate.trim(), transport: amount(x.transport), gstBilled: x.gstBilled, gstRatePct: x.gstBilled ? num(x.gstRatePct) : null, partyGstin: x.partyGstin.trim().toUpperCase() || null, challanNumber: x.challanNumber, invoiceNumber: x.invoiceNumber, poAttachmentId: x.poAttachmentId, dcAttachmentId: x.dcAttachmentId })),
    })),
  };
}

/* ------------------------------------------------------------ the parts */

type SW = (typeof sheetWords)['en'];

const REASON: Record<string, keyof SW['errors']> = {
  required: 'required',
  'must be more than zero': 'positive',
  'after today': 'afterToday',
  "outside the sheet's dates": 'outsideDates',
  'before the start date': 'beforeStart',
  'less than the start km': 'kmOrder',
  'required on a GST bill': 'gstin',
  'not one of your GST rates': 'notRate',
  'that GST rate is switched off': 'rateOff',
  'not a customer of this trip': 'notOnTrip',
  'not a vendor of this trip': 'notOnTrip',
  'no longer in use': 'notInUse',
  'required for maintenance, and only there': 'maintenanceKind',
  'say what the maintenance was': 'describe',
};

function problemText(p: PlProblem, w: SW): string {
  switch (p.code) {
    case 'invalid': {
      const k = REASON[p.reason] ?? 'other';
      const v = w.errors[k];
      return typeof v === 'string' ? v : w.errors.other;
    }
    case 'diesel-other-vehicle':
    case 'diesel-bill-void':
    case 'diesel-same-bill':
    case 'diesel-bill-exists':
      return w.errors[p.code](p.billNumber);
    case 'diesel-bill-on-sheet':
      return w.errors[p.code](p.billNumber, p.sheetNumber);
    case 'diesel-linked-elsewhere':
      return w.errors[p.code](p.sheetNumber);
    case 'not-paid-in-full':
      return w.errors[p.code](`₹${p.due}`);
    case 'sale-invoiced':
      return w.errors[p.code](p.tripNumber, p.status === 'draft' ? null : p.invoiceNumber);
    default:
      return w.errors[p.code];
  }
}

const problemField = (p: PlProblem | null) => (p && 'field' in p ? p.field : null);

function Field({ label, error, wide, children }: { label: string; error?: string | null; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`relative flex min-w-0 flex-col gap-1 ${wide ? 'col-span-2' : ''}`}>
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      <span className="relative flex min-w-0 pl-0">
        {error ? <Rail status="critical" /> : null}
        <span className="min-w-0 flex-1">{children}</span>
      </span>
      {error ? (
        <span className="text-[12px]" style={{ color: 'var(--status-critical)' }}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

function Shown({ value }: { value: React.ReactNode }) {
  return (
    <span className="block min-h-[34px] py-1.5 text-[14px]" style={{ color: value === '' || value === null ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
      {value === '' || value === null ? '—' : value}
    </span>
  );
}

function Txt({ ro, value, onChange, list, inputMode, placeholder, type = 'text' }: { ro: boolean; value: string; onChange: (v: string) => void; list?: string; inputMode?: 'decimal' | 'numeric' | 'text'; placeholder?: string; type?: 'text' | 'date' }) {
  if (ro) return <Shown value={type === 'date' && value ? formatDate(value) : value} />;
  return <input type={type} className={CTRL} style={FIELD_BOX} value={value} list={list} inputMode={inputMode} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function Sel({ ro, value, onChange, options, placeholder, add }: { ro: boolean; value: string; onChange: (v: string) => void; options: { value: string; label: string; disabled?: boolean }[]; placeholder?: string; add?: { label: string; onAdd: (name: string) => string | null } }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const sw = useWords(sheetWords);
  if (ro) return <Shown value={options.find((o) => o.value === value)?.label ?? ''} />;
  if (adding && add) {
    return (
      <span className="flex min-w-0 gap-1.5">
        <input className={CTRL} style={FIELD_BOX} autoFocus value={name} placeholder={sw.adding.name} onChange={(e) => setName(e.target.value)} />
        <Button
          variant="primary"
          onClick={() => {
            const made = name.trim() ? add.onAdd(name.trim()) : null;
            if (made) onChange(made);
            setAdding(false);
            setName('');
          }}
        >
          {sw.add}
        </Button>
        <Button onClick={() => setAdding(false)}>{sw.cancel}</Button>
      </span>
    );
  }
  return (
    <select
      className={CTRL}
      style={FIELD_BOX}
      value={value}
      onChange={(e) => (e.target.value === '__add' ? setAdding(true) : onChange(e.target.value))}
    >
      <option value="">{placeholder ?? ''}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {add && <option value="__add">+ {add.label}</option>}
    </select>
  );
}

function Toggle<T extends string>({ ro, value, options, onChange }: { ro: boolean; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  if (ro) return <Shown value={options.find((o) => o.value === value)?.label ?? ''} />;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="h-11 min-w-0 flex-1 px-2 text-[14px] [@media(hover:hover)]:h-[34px]"
          style={{
            borderRadius: 'var(--r-1)',
            background: value === o.value ? 'var(--brand)' : 'var(--surface)',
            color: value === o.value ? 'var(--text-inverse)' : 'var(--text-primary)',
            boxShadow: value === o.value ? undefined : 'inset 0 0 0 1px var(--border-strong)',
          }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      <span className={`block min-h-[34px] py-1.5 text-[14px] ${strong ? 'font-semibold' : ''}`}>
        <Signed value={value} />
      </span>
    </span>
  );
}

function Photo({ ro, label, ids, onChange, multiple }: { ro: boolean; label: string; ids: string[]; onChange: (ids: string[]) => void; multiple?: boolean }) {
  const sw = useWords(sheetWords);
  const files = usePl((st) => st.files);
  const sheets = usePl((st) => st.sheets);
  const known = useMemo(() => {
    const all = new Map(Object.entries(files));
    for (const sh of sheets) {
      for (const d of [...sh.diesel, ...sh.trips.flatMap((t) => t.diesel)]) if (d.attachment) all.set(d.attachment.id, d.attachment);
      for (const e of [...sh.enRoute, ...sh.trips.flatMap((t) => t.enRoute)]) if (e.attachment) all.set(e.attachment.id, e.attachment);
      for (const t of sh.trips) {
        for (const p of t.purchases) for (const a of p.attachments) all.set(a.id, a);
        for (const x of t.sales) for (const a of [x.poAttachment, x.dcAttachment]) if (a) all.set(a.id, a);
      }
    }
    return all;
  }, [files, sheets]);
  const upload = usePl((st) => st.upload);
  const names = ids.map((id) => known.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      <span className="flex min-h-[34px] min-w-0 flex-wrap items-center gap-2 text-[14px]">
        {names.length === 0 && ro && <span style={{ color: 'var(--text-tertiary)' }}>{sw.photo.none}</span>}
        {names.map((a) => (
          <a key={a.id} href={a.url || undefined} target="_blank" rel="noreferrer" className="max-w-[160px] truncate underline">
            {a.fileName}
          </a>
        ))}
        {!ro && (
          <label className="inline-flex h-11 cursor-pointer items-center px-3 text-[14px] [@media(hover:hover)]:h-[34px]" style={{ ...FIELD_BOX }}>
            {names.length && !multiple ? sw.photo.change : sw.photo.add}
            <input
              type="file"
              accept="image/*,application/pdf"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const a = upload(file);
                onChange(multiple ? [...ids, a.id] : [a.id]);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </span>
    </span>
  );
}

function LineFrame({ children, onRemove, ro, label }: { children: React.ReactNode; onRemove: () => void; ro: boolean; label: string }) {
  return (
    <div className="relative grid grid-cols-2 gap-x-3 gap-y-2 py-3 md:grid-cols-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      {children}
      {!ro && (
        <div className="col-span-2 flex justify-end md:col-span-4">
          <Button variant="destructive" onClick={onRemove} aria-label={label}>
            {label}
          </Button>
        </div>
      )}
    </div>
  );
}

const money = (v: string | number | null | undefined) => decimal.toFixed(decimal.dec(v ?? 0), 2);

/* -------------------------------------------------------------- the page */

export function SheetPage() {
  const w = useWords(sheetWords);
  const pw = useWords(plWords);
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { sheetId?: string };
  const { persona } = useApp();
  const book = usePlBook();
  const bills = useExpenses((st) => st.bills);
  const store = usePl();
  const masters = mastersOf(store);
  const allInvoices = useInvoices((st) => st.invoices);
  const invoiced = useMemo(() => liveInvoices(allInvoices), [allInvoices]);
  const record = params.sheetId ? (book.byId.get(params.sheetId) ?? null) : null;
  const writeAt = (siteId: string) => can(persona.grants, WRITE, { siteId });
  const [editing, setEditing] = useState(!params.sheetId);
  const [draft, setDraft] = useState<Draft>(() => (record ? fromRecord(record) : blankDraft(writeAt)));
  const [problem, setProblem] = useState<PlProblem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [closeProblem, setCloseProblem] = useState<string | null>(null);
  const ro = !editing;

  const input = useMemo(() => toInput(draft), [draft]);
  const calc: SheetCalc = useMemo(
    () => (editing || !record ? calculateSheet(draftDomain(input, record, store.materials, book.bills)) : book.calcs.get(record.id)!),
    [editing, record, input, store.materials, book.bills, book.calcs],
  );
  if (params.sheetId && !record) return <NotFound />;
  if (record && !readable(persona.grants, READ_KEYS, record.siteId)) return <NotFound />;

  const canWrite = writeAt(draft.siteId || record?.siteId || '');
  const canClose = record ? can(persona.grants, CLOSE, { siteId: record.siteId }) : false;
  const err = (path: string) => (problemField(problem) === path && problem ? problemText(problem, w) : null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setTrip = (i: number, patch: Partial<DTrip>) => setDraft((d) => ({ ...d, trips: d.trips.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const tripCalc = (i: number): TripCalc | undefined => (editing || !record ? calc.trips[`draft-${i}`] : calc.trips[draft.trips[i]?.id ?? '']);

  const vehicles = VEHICLES.filter((v) => writeAt(v.siteId) || v.id === draft.vehicleId).map((v) => ({ value: v.id, label: `${v.displayReg} · ${v.model}` }));
  const drivers = DRIVERS.map((d) => ({ value: d.id, label: d.name }));
  const partyOptions = (role: 'customer' | 'vendor') => (role === 'customer' ? masters.customers : masters.vendors).map((p) => ({ value: p.id, label: p.name }));
  const rateOptions = (current: string) =>
    masters.gstRates.filter((r) => r.active || String(r.ratePct) === current).map((r) => ({ value: String(r.ratePct), label: `${r.ratePct}%` }));
  const addParty = (role: 'customer' | 'vendor') => (name: string) => store.addParty({ role, name }).id;
  const addRate = (text: string) => {
    const n = Number(text.replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return String(store.addGstRate(n).ratePct);
  };

  const save = () => {
    setProblem(null);
    const result = store.save(input, record?.id ?? null, { name: persona.name, grants: persona.grants }, bills);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    // Places and GSTINs typed on lines go into the masters as well (the workbook's "addable").
    for (const t of input.trips) {
      for (const p of t.purchases) if (p.location) store.addLocation(p.vendorId, p.location);
      for (const x of t.sales) if (x.location) store.addLocation(x.customerId, x.location);
    }
    setEditing(false);
    if (!record) void navigate({ to: sheetPath(result.id) });
    else setDraft(fromRecord(usePl.getState().sheets.find((x) => x.id === record.id)!));
  };

  const title = record ? w.sheet(record.sheetNumber) : w.newSheet;
  return (
    <div className="pl-screen pb-24 md:pb-6">
      <PageHeader
        eyebrow={pw.title}
        title={title}
        meta={record ? <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{w.addedBy(record.createdBy, formatDate(record.createdAt))}</span> : undefined}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => void navigate({ to: LIST_PATH })}>{w.back}</Button>
            {record && !editing && canWrite && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                {w.edit}
              </Button>
            )}
            {record && editing && canWrite && (
              <Button variant="destructive" onClick={() => setConfirming(true)}>
                {w.delete}
              </Button>
            )}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Section caption={w.section.vehicle}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-4 md:px-6">
              <Field label={w.vehicle.vehicle} error={err('vehicleId') ?? err('siteId')} wide>
                <Sel
                  ro={ro || Boolean(record)}
                  value={draft.vehicleId}
                  options={vehicles}
                  placeholder={w.vehicle.pick}
                  onChange={(id) => {
                    const v = VEHICLES.find((x) => x.id === id);
                    const d = DRIVERS.find((x) => x.id === v?.driverId);
                    set({ vehicleId: id, siteId: v?.siteId ?? '', registrationNumber: v?.displayReg ?? '', vehicleModel: v?.model ?? '', driverId: d?.id ?? draft.driverId, driverName: d?.name ?? draft.driverName, driverPhone: d?.phone ?? draft.driverPhone });
                  }}
                />
              </Field>
              <Field label={w.vehicle.model}>
                <Shown value={draft.vehicleModel} />
              </Field>
              <Field label={w.vehicle.driver}>
                <Sel
                  ro={ro}
                  value={draft.driverId}
                  options={drivers}
                  placeholder={w.vehicle.pickDriver}
                  onChange={(id) => {
                    const d = DRIVERS.find((x) => x.id === id);
                    set({ driverId: id, driverName: d?.name ?? '', driverPhone: d?.phone ?? '' });
                  }}
                />
              </Field>
              <Field label={w.vehicle.phone}>
                <Shown value={draft.driverPhone} />
              </Field>
              <Field label={w.vehicle.start} error={err('startDate')}>
                <Txt ro={ro} type="date" value={draft.startDate} onChange={(v) => set({ startDate: v })} />
              </Field>
              <Field label={w.vehicle.end} error={err('endDate')}>
                <Txt ro={ro} type="date" value={draft.endDate} onChange={(v) => set({ endDate: v })} />
              </Field>
              <Field label={w.vehicle.batta}>
                <Txt ro={ro} inputMode="decimal" value={draft.batta} onChange={(v) => set({ batta: v })} />
              </Field>
              <Field label={w.vehicle.startKm}>
                <Txt ro={ro} inputMode="decimal" value={draft.startKm} onChange={(v) => set({ startKm: v })} />
              </Field>
              <Field label={w.vehicle.endKm} error={err('endKm')}>
                <Txt ro={ro} inputMode="decimal" value={draft.endKm} onChange={(v) => set({ endKm: v })} />
              </Field>
              <Field label={w.vehicle.distance}>
                <Shown value={calc.own.distanceKm === null ? '' : w.km(calc.own.distanceKm)} />
              </Field>
            </div>
          </Section>

          <Section caption={w.section.diesel}>
            <div className="px-4 md:px-6">
              <p className="py-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {w.hint.sheetCosts}
              </p>
              <DieselLines ro={ro} where="diesel" lines={draft.diesel} calc={calc.diesel} onChange={(diesel) => set({ diesel })} err={err} draft={draft} recordId={record?.id ?? null} />
            </div>
          </Section>

          <Section caption={w.section.enRoute}>
            <div className="px-4 md:px-6">
              <RoadLines ro={ro} where="enRoute" lines={draft.enRoute} onChange={(enRoute) => set({ enRoute })} err={err} date={draft.startDate} />
            </div>
          </Section>

          <Section caption={w.section.trips}>
            <div className="flex flex-col gap-3 px-4 py-3 md:px-6">
              {draft.trips.length === 0 && (
                <p className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                  {w.hint.noTrips}
                </p>
              )}
              {draft.trips.map((t, i) => (
                <TripCard
                  key={t.key}
                  index={i}
                  trip={t}
                  ro={ro}
                  calc={tripCalc(i)}
                  err={err}
                  onChange={(patch) => setTrip(i, patch)}
                  onRemove={() => set({ trips: draft.trips.filter((_, j) => j !== i) })}
                  partyOptions={partyOptions}
                  rateOptions={rateOptions}
                  addParty={addParty}
                  addRate={addRate}
                  draft={draft}
                  recordId={record?.id ?? null}
                  closing={!editing && canClose && record && t.id ? { sheetId: record.id, tripId: t.id } : null}
                  onCloseProblem={setCloseProblem}
                  closedBy={record?.trips.find((x) => x.id === t.id)?.closures ?? []}
                  invoiced={invoiced}
                />
              ))}
              {closeProblem && (
                <p className="text-[13px]" style={{ color: 'var(--status-critical)' }}>
                  {closeProblem}
                </p>
              )}
              {!ro && (
                <div>
                  <Button onClick={() => set({ trips: [...draft.trips, blankTrip(draft.trips.at(-1)?.date ?? draft.startDate)] })}>+ {w.addTrip}</Button>
                </div>
              )}
            </div>
          </Section>

          {record && !editing && <SheetInvoices record={record} />}

          <Section caption={w.section.sheetMoney}>
            <div className="px-4 md:px-6">
              <p className="py-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {w.hint.sheetMoney}
              </p>
              <PaymentLines ro={ro} where="payments" lines={draft.payments} onChange={(payments) => set({ payments })} err={err} parties={partyOptions} date={draft.endDate || draft.startDate} />
              <DuesTable dues={[...calc.dues]} paidExtra={calc.unsettled} />
            </div>
          </Section>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start" style={{ borderLeft: '1px solid var(--border-subtle)' }}>
          <PlBox calc={calc} tripNumbers={draft.trips.map((t, i) => t.tripNumber ?? w.unsavedTrip(i + 1))} tripKeys={draft.trips.map((t, i) => (editing || !record ? `draft-${i}` : t.id ?? ''))} />
        </aside>
      </div>

      {editing && (
        <div
          className="pl-savebar fixed inset-x-0 z-30 flex flex-wrap items-center gap-2 px-4 py-2 md:static md:px-6"
          style={{ bottom: 'calc(60px + env(safe-area-inset-bottom))', background: 'var(--surface)', borderTop: '1px solid var(--border-subtle)' }}
        >
          <span className="min-w-0 flex-1 text-[13px]">
            {problem ? (
              <span style={{ color: 'var(--status-critical)' }}>{problemField(problem) && problem.code !== 'sale-invoiced' ? w.errors.fix : problemText(problem, w)}</span>
            ) : (
              <span style={{ color: 'var(--text-secondary)' }}>
                {calc.pl.net.startsWith('-') ? w.box.loss : w.box.profit} <Signed value={calc.pl.net} strong />
              </span>
            )}
          </span>
          {record && (
            <Button
              onClick={() => {
                setDraft(fromRecord(record));
                setProblem(null);
                setEditing(false);
              }}
            >
              {w.cancel}
            </Button>
          )}
          <Button variant="primary" onClick={save}>
            {w.save}
          </Button>
        </div>
      )}

      {record && (
        <ConfirmModal
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            const result = store.remove(record.id, { name: persona.name, grants: persona.grants });
            if (result.ok) void navigate({ to: LIST_PATH });
            else setProblem(result.problem);
            setConfirming(false);
          }}
          title={w.confirm.title}
          consequence={w.confirm.consequence(record.sheetNumber, record.trips.length, `₹${money(book.calcs.get(record.id)?.pl.net)}`)}
          confirmLabel={w.confirm.yes}
          backLabel={w.confirm.back}
          destructive
        />
      )}
    </div>
  );
}

function NotFound() {
  const pw = useWords(plWords);
  return (
    <div className="px-6 py-10 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
      {pw.noneMatch}
    </div>
  );
}

/* ------------------------------------------------------------ the lines */

type Err = (path: string) => string | null;

function DieselLines({ ro, where, lines, calc, onChange, err, draft, recordId }: { ro: boolean; where: string; lines: DDiesel[]; calc: SheetCalc['diesel']; onChange: (l: DDiesel[]) => void; err: Err; draft: Draft; recordId: string | null }) {
  const w = useWords(sheetWords);
  const book = usePlBook();
  const bills = useExpenses((st) => st.bills);
  const store = usePl();
  const masters = mastersOf(store);
  const billOptions = dieselBillsFor(book, bills, draft.vehicleId).map((b) => ({
    value: b.id,
    label: `${b.billNumber} · ${formatDate(b.billDate)} · ₹${b.amount}${b.linkedSheet && b.linkedSheet.sheetId !== recordId ? ` · ${w.diesel.onSheet(b.linkedSheet.sheetNumber)}` : ''}`,
    disabled: Boolean(b.linkedSheet && b.linkedSheet.sheetId !== recordId),
  }));
  const fuelOptions = fuelEntriesFor(book, draft.vehicleId).map(({ entry, linkedSheet }) => ({
    value: entry.id,
    label: `${formatDate(entry.date)} · ${w.litres(entry.litres)} · ₹${entry.amount}${linkedSheet ? ` · ${w.diesel.onSheet(linkedSheet)}` : ''}`,
    disabled: Boolean(linkedSheet) && !lines.some((l) => l.fuelEntryId === entry.id),
  }));
  const bunks = masters.vendors.map((v) => ({ value: v.id, label: v.name }));
  const put = (i: number, patch: Partial<DDiesel>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div>
      {lines.map((l, i) => {
        const at = `${where}[${i}]`;
        const f = calc[`${at}`] ?? calc[l.id ?? ''];
        return (
          <LineFrame key={l.key} ro={ro} label={w.remove} onRemove={() => onChange(lines.filter((_, j) => j !== i))}>
            <div className="col-span-2 md:col-span-4">
              <Toggle
                ro={ro}
                value={l.source}
                options={[
                  { value: 'typed', label: w.diesel.typed },
                  { value: 'expense_bill', label: w.diesel.bill },
                  { value: 'fuel_entry', label: w.diesel.fuel },
                ]}
                onChange={(source) => put(i, { ...blankDiesel(), key: l.key, source })}
              />
            </div>
            {err(at) && (
              <p className="col-span-2 text-[12px] md:col-span-4" style={{ color: 'var(--status-critical)' }}>
                {err(at)}
              </p>
            )}
            {l.source === 'typed' && (
              <>
                <Field label={w.diesel.litres} error={err(`${at}.litres`)}>
                  <Txt ro={ro} inputMode="decimal" value={l.litres} onChange={(v) => put(i, { litres: v })} />
                </Field>
                <Field label={w.diesel.rate} error={err(`${at}.rate`)}>
                  <Txt ro={ro} inputMode="decimal" value={l.rate} onChange={(v) => put(i, { rate: v })} />
                </Field>
                <Figure label={w.diesel.amount} value={f?.amount ?? '0.00'} />
                <Field label={w.diesel.billNo}>
                  <Txt ro={ro} value={l.billNumber} onChange={(v) => put(i, { billNumber: v })} />
                </Field>
                <Field label={w.diesel.vendor} wide>
                  <Sel ro={ro} value={l.vendorId} options={bunks} placeholder={w.diesel.pickVendor} onChange={(v) => put(i, { vendorId: v })} add={{ label: w.adding.vendor, onAdd: (name) => store.addParty({ role: 'vendor', name }).id }} />
                </Field>
                <div className="col-span-2">
                  <Photo ro={ro} label={w.bought.photo} ids={l.attachmentId ? [l.attachmentId] : []} onChange={(ids) => put(i, { attachmentId: ids[0] ?? null })} />
                </div>
              </>
            )}
            {l.source === 'expense_bill' && (
              <>
                <Field label={w.diesel.pickBill} error={err(`${at}.expenseBillId`)} wide>
                  <Sel ro={ro} value={l.expenseBillId} options={billOptions} placeholder={billOptions.length ? w.diesel.pickBill : w.diesel.noBills} onChange={(v) => put(i, { expenseBillId: v })} />
                </Field>
                <Figure label={w.diesel.amount} value={f?.amount ?? '0.00'} />
                <Field label={w.diesel.litres}>
                  <Shown value={f?.litres === null || f?.litres === undefined ? '' : w.litres(f.litres)} />
                </Field>
                <p className="col-span-2 font-serif text-[12px] italic md:col-span-4" style={{ color: f && !f.counted ? 'var(--status-critical)' : 'var(--text-tertiary)' }}>
                  {f && !f.counted ? w.diesel.notCounted : w.diesel.fromBill}
                </p>
              </>
            )}
            {l.source === 'fuel_entry' && (
              <>
                <Field label={w.diesel.pickFuel} error={err(`${at}.fuelEntryId`)} wide>
                  <Sel
                    ro={ro}
                    value={l.fuelEntryId}
                    options={fuelOptions}
                    placeholder={fuelOptions.length ? w.diesel.pickFuel : w.diesel.noFuel}
                    onChange={(v) => {
                      const e = fuelEntriesFor(book, draft.vehicleId).find((x) => x.entry.id === v)?.entry;
                      put(i, { fuelEntryId: v, litres: s(e?.litres), amount: s(e?.amount), billNumber: e?.billNumber ?? '', vendor: e?.source === 'own_bunk' ? 'Own bunk' : 'Outside bunk', filledAt: e?.date ?? null });
                    }}
                  />
                </Field>
                <Figure label={w.diesel.amount} value={f?.amount ?? '0.00'} />
                <Field label={w.diesel.litres}>
                  <Shown value={l.litres ? w.litres(l.litres) : ''} />
                </Field>
              </>
            )}
          </LineFrame>
        );
      })}
      {!ro && (
        <div className="py-2">
          <Button onClick={() => onChange([...lines, blankDiesel()])}>+ {w.addLine}</Button>
        </div>
      )}
    </div>
  );
}

function RoadLines({ ro, where, lines, onChange, err, date }: { ro: boolean; where: string; lines: DRoad[]; onChange: (l: DRoad[]) => void; err: Err; date: string }) {
  const w = useWords(sheetWords);
  const pw = useWords(plWords);
  const put = (i: number, patch: Partial<DRoad>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div>
      {lines.map((l, i) => {
        const at = `${where}[${i}]`;
        return (
          <LineFrame key={l.key} ro={ro} label={w.remove} onRemove={() => onChange(lines.filter((_, j) => j !== i))}>
            <Field label={w.road.kind} wide>
              <Toggle ro={ro} value={l.kind} options={(['toll', 'police', 'maintenance'] as const).map((k) => ({ value: k, label: pw.kind[k] }))} onChange={(kind) => put(i, { kind, maintenanceKind: kind === 'maintenance' ? l.maintenanceKind : '' })} />
            </Field>
            {l.kind === 'maintenance' && (
              <Field label={w.road.sub} error={err(`${at}.maintenanceKind`)} wide>
                <Sel ro={ro} value={l.maintenanceKind} options={MAINT.map((k) => ({ value: k, label: pw.maintenance[k] }))} placeholder={w.road.sub} onChange={(v) => put(i, { maintenanceKind: v })} />
              </Field>
            )}
            {l.kind === 'maintenance' && l.maintenanceKind === 'misc' && (
              <Field label={w.road.describe} error={err(`${at}.description`)} wide>
                <Txt ro={ro} value={l.description} onChange={(v) => put(i, { description: v })} />
              </Field>
            )}
            <Field label={w.road.date}>
              <Txt ro={ro} type="date" value={l.date || date} onChange={(v) => put(i, { date: v })} />
            </Field>
            <Field label={w.road.amount} error={err(`${at}.amount`)}>
              <Txt ro={ro} inputMode="decimal" value={l.amount} onChange={(v) => put(i, { amount: v })} />
            </Field>
            <Field label={w.road.location}>
              <Txt ro={ro} value={l.location} onChange={(v) => put(i, { location: v })} />
            </Field>
            {l.kind === 'toll' && (
              <Field label={w.road.reference}>
                <Txt ro={ro} value={l.reference} onChange={(v) => put(i, { reference: v })} />
              </Field>
            )}
            <div className="col-span-2">
              <Photo ro={ro} label={w.bought.photo} ids={l.attachmentId ? [l.attachmentId] : []} onChange={(ids) => put(i, { attachmentId: ids[0] ?? null })} />
            </div>
          </LineFrame>
        );
      })}
      {!ro && (
        <div className="py-2">
          <Button onClick={() => onChange([...lines, blankRoad(date)])}>+ {w.addLine}</Button>
        </div>
      )}
    </div>
  );
}

function PaymentLines({ ro, where, lines, onChange, err, parties, date }: { ro: boolean; where: string; lines: DPayment[]; onChange: (l: DPayment[]) => void; err: Err; parties: (role: 'customer' | 'vendor') => { value: string; label: string }[]; date: string }) {
  const w = useWords(sheetWords);
  const put = (i: number, patch: Partial<DPayment>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div>
      {lines.map((l, i) => {
        const at = `${where}[${i}]`;
        return (
          <LineFrame key={l.key} ro={ro} label={w.remove} onRemove={() => onChange(lines.filter((_, j) => j !== i))}>
            <Field label={w.money.direction} wide>
              <Toggle ro={ro} value={l.direction} options={[{ value: 'in' as const, label: w.money.in }, { value: 'out' as const, label: w.money.out }]} onChange={(direction) => put(i, { direction, partyId: '' })} />
            </Field>
            <Field label={w.money.party} error={err(`${at}.partyId`)} wide>
              <Sel ro={ro} value={l.partyId} options={parties(l.direction === 'in' ? 'customer' : 'vendor')} placeholder={w.money.pickParty} onChange={(v) => put(i, { partyId: v })} />
            </Field>
            <Field label={w.money.amount} error={err(`${at}.amount`)}>
              <Txt ro={ro} inputMode="decimal" value={l.amount} onChange={(v) => put(i, { amount: v })} />
            </Field>
            <Field label={w.money.date} error={err(`${at}.paidOn`)}>
              <Txt ro={ro} type="date" value={l.paidOn} onChange={(v) => put(i, { paidOn: v })} />
            </Field>
            <Field label={w.money.mode}>
              <Sel ro={ro} value={l.mode} options={MODES.map((m) => ({ value: m, label: w.modes[m] }))} onChange={(v) => put(i, { mode: v as DPayment['mode'] })} />
            </Field>
            <Field label={w.money.reference} error={err(at)}>
              <Txt ro={ro} value={l.reference} onChange={(v) => put(i, { reference: v })} />
            </Field>
          </LineFrame>
        );
      })}
      {!ro && (
        <div className="flex flex-wrap gap-2 py-2">
          <Button onClick={() => onChange([...lines, blankPayment('in', date)])}>+ {w.money.in}</Button>
          <Button onClick={() => onChange([...lines, blankPayment('out', date)])}>+ {w.money.out}</Button>
        </div>
      )}
    </div>
  );
}

function DuesTable({ dues, paidExtra, closing, onClose, closedBy }: { dues: { partyId: string; role: string; billed: string; settled: string; due: string; status: PlPartyDue['status'] }[]; paidExtra?: { partyId: string }[]; closing?: boolean; onClose?: (partyId: string, close: boolean) => void; closedBy?: { partyId: string; closedBy: string }[] }) {
  const w = useWords(sheetWords);
  const pw = useWords(plWords);
  const parties = usePl((st) => st.parties);
  if (dues.length === 0) return null;
  const extra = new Set((paidExtra ?? []).map((d) => d.partyId));
  return (
    <div className="py-2">
      <p className="pb-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {w.money.dues}
      </p>
      <ul className="flex flex-col">
        {dues.map((d) => {
          const name = parties.find((p) => p.id === d.partyId)?.name ?? '';
          const who = closedBy?.find((c) => c.partyId === d.partyId)?.closedBy;
          return (
            <li key={`${d.role}:${d.partyId}`} className="grid grid-cols-2 gap-x-3 gap-y-1 py-2 md:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_minmax(0,1.4fr)]" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <span className="col-span-2 min-w-0 truncate text-[14px] md:col-span-1">
                {name} <span style={{ color: 'var(--text-tertiary)' }}>· {d.role === 'customer' ? w.money.in : w.money.out}</span>
              </span>
              <span className="text-[13px]">
                <span style={{ color: 'var(--text-tertiary)' }}>{w.money.billed} </span>
                <Signed value={d.billed} />
              </span>
              <span className="text-[13px]">
                <span style={{ color: 'var(--text-tertiary)' }}>{w.money.settled} </span>
                <Signed value={d.settled} />
              </span>
              <span className="text-[13px] font-semibold">
                <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>{w.money.due} </span>
                <Signed value={d.due} />
              </span>
              <span className="flex flex-wrap items-center gap-2 text-[13px]">
                <span style={{ color: d.status === 'pending' || d.status === 'partial' ? 'var(--status-attention)' : 'var(--text-secondary)' }}>
                  {d.due.startsWith('-') && extra.has(d.partyId) ? pw.paidExtra : pw.status[d.status]}
                </span>
                {d.status === 'closed' && who && <span style={{ color: 'var(--text-tertiary)' }}>{w.money.closedBy(who)}</span>}
                {closing && onClose && d.role === 'customer' && d.status === 'paid' && (
                  <Button variant="primary" onClick={() => onClose(d.partyId, true)}>
                    {w.money.closeIt}
                  </Button>
                )}
                {closing && onClose && d.role === 'customer' && d.status === 'closed' && <Button onClick={() => onClose(d.partyId, false)}>{w.money.reopen}</Button>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TripCard({
  index,
  trip,
  ro,
  calc,
  err,
  onChange,
  onRemove,
  partyOptions,
  rateOptions,
  addParty,
  addRate,
  draft,
  recordId,
  closing,
  onCloseProblem,
  closedBy,
  invoiced,
}: {
  index: number;
  trip: DTrip;
  ro: boolean;
  calc: TripCalc | undefined;
  err: Err;
  onChange: (patch: Partial<DTrip>) => void;
  onRemove: () => void;
  partyOptions: (role: 'customer' | 'vendor') => { value: string; label: string }[];
  rateOptions: (current: string) => { value: string; label: string }[];
  addParty: (role: 'customer' | 'vendor') => (name: string) => string;
  addRate: (text: string) => string | null;
  draft: Draft;
  recordId: string | null;
  closing: { sheetId: string; tripId: string } | null;
  onCloseProblem: (text: string | null) => void;
  closedBy: { partyId: string; closedBy: string }[];
  /** LIN-27: the live invoice each saved sale line is on. Such a line stays as billed. */
  invoiced: Map<string, PlSaleInvoice>;
}) {
  const w = useWords(sheetWords);
  const store = usePl();
  const bills = useExpenses((st) => st.bills);
  const { persona } = useApp();
  const masters = mastersOf(store);
  const at = `trips[${index}]`;
  const materials = masters.materials.filter((m) => m.active || trip.purchases.some((p) => p.materialId === m.id) || trip.sales.some((x) => x.materialId === m.id)).map((m) => ({ value: m.id, label: m.name }));
  const units = [...new Set(masters.materials.map((m) => m.unit))];
  const putP = (i: number, patch: Partial<DPurchase>) => onChange({ purchases: trip.purchases.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const putS = (i: number, patch: Partial<DSale>) => onChange({ sales: trip.sales.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const addMaterial = (line: { hsnCode: string; unit: string; gstRatePct: string }) => (name: string) => {
    const r = store.addMaterial({ name, hsnCode: line.hsnCode || null, unit: line.unit || 'unit', gstRatePct: Number(line.gstRatePct) || 5 });
    return r.ok ? r.material.id : null;
  };
  const tripParties = (role: 'customer' | 'vendor') => {
    const ids = new Set(role === 'customer' ? trip.sales.map((x) => x.customerId) : trip.purchases.map((p) => p.vendorId));
    return partyOptions(role).filter((o) => ids.has(o.value));
  };
  const locations = (partyId: string) => store.parties.find((p) => p.id === partyId)?.locations ?? [];
  const partyOf = (id: string) => store.parties.find((p) => p.id === id);
  return (
    <div className="flex flex-col" style={{ ...FIELD_BOX, padding: '12px' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-id text-[15px] font-semibold">{trip.tripNumber ? w.trip(trip.tripNumber) : w.newTrip}</span>
        <span className="flex-1" />
        {calc && (
          <span className="text-[13px]">
            <Signed value={calc.pl.net} strong />
            {calc.pl.profitPct !== null ? ` · ${calc.pl.profitPct.toFixed(2)}%` : ''}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 pt-2 md:grid-cols-4">
        <Field label={w.vehicle.tripDate} error={err(`${at}.date`)}>
          <Txt ro={ro} type="date" value={trip.date} onChange={(v) => onChange({ date: v })} />
        </Field>
        {!ro && (
          <div className="col-span-2 flex items-end md:col-span-1">
            <Button className="w-full" onClick={() => onChange({ more: !trip.more })}>
              {w.moreOnTrip}
            </Button>
          </div>
        )}
      </div>
      {(trip.more || (ro && (trip.startKm || trip.batta || trip.enRoute.length || trip.diesel.length))) && (
        <div className="pt-2">
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {w.section.tripMore}
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 py-2 md:grid-cols-4">
            <Field label={w.vehicle.startKm}>
              <Txt ro={ro} inputMode="decimal" value={trip.startKm} onChange={(v) => onChange({ startKm: v })} />
            </Field>
            <Field label={w.vehicle.endKm} error={err(`${at}.endKm`)}>
              <Txt ro={ro} inputMode="decimal" value={trip.endKm} onChange={(v) => onChange({ endKm: v })} />
            </Field>
            <Field label={w.vehicle.batta}>
              <Txt ro={ro} inputMode="decimal" value={trip.batta} onChange={(v) => onChange({ batta: v })} />
            </Field>
          </div>
          <RoadLines ro={ro} where={`${at}.enRoute`} lines={trip.enRoute} onChange={(enRoute) => onChange({ enRoute })} err={err} date={trip.date} />
          <DieselLines ro={ro} where={`${at}.diesel`} lines={trip.diesel} calc={calc?.diesel ?? {}} onChange={(diesel) => onChange({ diesel })} err={err} draft={draft} recordId={recordId} />
        </div>
      )}

      <p className="pt-3 text-[13px] font-semibold">{w.section.bought}</p>
      {trip.purchases.map((p, i) => {
        const pat = `${at}.purchases[${i}]`;
        const f = purchaseFigures({ id: '', vendorId: p.vendorId, quantity: p.quantity, rate: p.rate, gstBilled: p.gstBilled, gstRatePct: p.gstRatePct || masters.materials.find((m) => m.id === p.materialId)?.gstRatePct || 0 });
        const vendor = partyOf(p.vendorId);
        const listId = `pl-${trip.key}-p${i}`;
        return (
          <LineFrame key={p.key} ro={ro} label={w.remove} onRemove={() => onChange({ purchases: trip.purchases.filter((_, j) => j !== i) })}>
            <Field label={w.bought.vendor} error={err(`${pat}.vendorId`)} wide>
              <Sel ro={ro} value={p.vendorId} options={partyOptions('vendor')} placeholder={w.bought.pickVendor} onChange={(v) => putP(i, { vendorId: v, vendorGstin: partyOf(v)?.gstin ?? '', gstBilled: Boolean(partyOf(v)?.gstin) })} add={{ label: w.adding.vendor, onAdd: addParty('vendor') }} />
            </Field>
            <Field label={w.bought.location} wide>
              <Txt ro={ro} value={p.location} list={listId} onChange={(v) => putP(i, { location: v })} />
              <datalist id={listId}>
                {locations(p.vendorId).map((l) => (
                  <option key={l.id} value={l.name} />
                ))}
              </datalist>
            </Field>
            <Field label={w.bought.material} error={err(`${pat}.materialId`)} wide>
              <Sel
                ro={ro}
                value={p.materialId}
                options={materials}
                placeholder={w.bought.pickMaterial}
                onChange={(v) => {
                  const m = store.materials.find((x) => x.id === v);
                  putP(i, { materialId: v, hsnCode: m?.hsnCode ?? '', unit: m?.unit ?? '', gstRatePct: m ? String(m.gstRatePct) : '' });
                }}
                add={{ label: w.adding.material, onAdd: addMaterial(p) }}
              />
            </Field>
            <Field label={w.bought.hsn}>
              <Txt ro={ro} inputMode="numeric" value={p.hsnCode} onChange={(v) => putP(i, { hsnCode: v })} />
            </Field>
            <Field label={w.bought.unit}>
              <Txt ro={ro} value={p.unit} list="pl-units" onChange={(v) => putP(i, { unit: v })} />
            </Field>
            <Field label={w.bought.qty} error={err(`${pat}.quantity`)}>
              <Txt ro={ro} inputMode="decimal" value={p.quantity} onChange={(v) => putP(i, { quantity: v })} />
            </Field>
            <Field label={w.bought.rate} error={err(`${pat}.rate`)}>
              <Txt ro={ro} inputMode="decimal" value={p.rate} onChange={(v) => putP(i, { rate: v })} />
            </Field>
            <Figure label={w.bought.cost} value={f.amount} />
            <Field label={w.bought.billing}>
              <Toggle ro={ro} value={p.gstBilled ? 'gst' : 'none'} options={[{ value: 'gst' as const, label: w.bought.gst }, { value: 'none' as const, label: w.bought.nonGst }]} onChange={(v) => putP(i, { gstBilled: v === 'gst' })} />
            </Field>
            {p.gstBilled && (
              <>
                <Field label={w.bought.gstin} error={err(`${pat}.vendorGstin`)} wide>
                  <Txt ro={ro} value={p.vendorGstin} onChange={(v) => putP(i, { vendorGstin: v.toUpperCase() })} />
                  {!ro && vendor && !vendor.gstin && p.vendorGstin.length === 15 && (
                    <Button onClick={() => store.patchParty(vendor.id, { gstin: p.vendorGstin })}>{w.adding.gstinTo(vendor.name)}</Button>
                  )}
                </Field>
                <Field label={w.bought.gstRate} error={err(`${pat}.gstRatePct`)}>
                  <Sel ro={ro} value={p.gstRatePct} options={rateOptions(p.gstRatePct)} onChange={(v) => putP(i, { gstRatePct: v })} add={{ label: w.adding.rate, onAdd: addRate }} />
                </Field>
                <Figure label={w.bought.gstAmount} value={f.gstAmount} />
              </>
            )}
            <Figure label={w.bought.total} value={f.total} strong />
            <Field label={w.bought.invoice}>
              <Txt ro={ro} value={p.invoiceNumber} onChange={(v) => putP(i, { invoiceNumber: v })} />
            </Field>
            <div className="col-span-2">
              <Photo ro={ro} multiple label={w.bought.photo} ids={p.attachmentIds} onChange={(ids) => putP(i, { attachmentIds: ids })} />
            </div>
          </LineFrame>
        );
      })}
      {!ro && (
        <div className="py-2">
          <Button onClick={() => onChange({ purchases: [...trip.purchases, blankPurchase(trip.date)] })}>+ {w.addLine}</Button>
        </div>
      )}

      <p className="pt-3 text-[13px] font-semibold">{w.section.sold}</p>
      {trip.sales.map((x, i) => {
        const sat = `${at}.sales[${i}]`;
        const f = saleFigures({ id: '', customerId: x.customerId, quantity: x.quantity, rate: x.rate, transport: x.transport, gstBilled: x.gstBilled, gstRatePct: x.gstRatePct || masters.materials.find((m) => m.id === x.materialId)?.gstRatePct || 0 });
        const customer = partyOf(x.customerId);
        const listId = `pl-${trip.key}-s${i}`;
        const first = trip.purchases[0];
        // LIN-27: what a draft or issued invoice bills stays as billed. The PO reference, the photos and
        // the GSTIN (which a draft reads again at issue) are not billed fields, so they stay open.
        const on = x.id ? invoiced.get(x.id) : undefined;
        const lro = ro || Boolean(on);
        return (
          <LineFrame key={x.key} ro={lro} label={w.remove} onRemove={() => onChange({ sales: trip.sales.filter((_, j) => j !== i) })}>
            {on && <InvoiceNote on={on} editing={!ro} />}
            <Field label={w.sold.customer} error={err(`${sat}.customerId`)} wide>
              <Sel ro={lro} value={x.customerId} options={partyOptions('customer')} placeholder={w.sold.pickCustomer} onChange={(v) => putS(i, { customerId: v, partyGstin: partyOf(v)?.gstin ?? '', poRef: ordersFor(v)[0]?.customerPoRef ?? '', purchaseOrderId: ordersFor(v)[0]?.id ?? '' })} add={{ label: w.adding.customer, onAdd: addParty('customer') }} />
            </Field>
            <Field label={w.sold.location} wide>
              <Txt ro={lro} value={x.location} list={listId} onChange={(v) => putS(i, { location: v })} />
              <datalist id={listId}>
                {locations(x.customerId).map((l) => (
                  <option key={l.id} value={l.name} />
                ))}
              </datalist>
            </Field>
            <Field label={w.sold.poRef}>
              <Txt ro={ro} value={x.poRef} onChange={(v) => putS(i, { poRef: v, purchaseOrderId: '' })} />
            </Field>
            <Field label={w.bought.material} error={err(`${sat}.materialId`)}>
              <Sel
                ro={lro}
                value={x.materialId}
                options={materials}
                placeholder={w.bought.pickMaterial}
                onChange={(v) => {
                  const m = store.materials.find((y) => y.id === v);
                  putS(i, { materialId: v, hsnCode: m?.hsnCode ?? '', unit: m?.unit ?? '', gstRatePct: m ? String(m.gstRatePct) : '' });
                }}
                add={{ label: w.adding.material, onAdd: addMaterial(x) }}
              />
            </Field>
            {!lro && first?.materialId && (
              <div className="col-span-2 flex items-end">
                <Button onClick={() => putS(i, { materialId: first.materialId, hsnCode: first.hsnCode, unit: first.unit, quantity: first.quantity, gstRatePct: first.gstRatePct || x.gstRatePct })}>{w.sold.sameAsBought}</Button>
              </div>
            )}
            <Field label={w.bought.hsn}>
              <Txt ro={lro} inputMode="numeric" value={x.hsnCode} onChange={(v) => putS(i, { hsnCode: v })} />
            </Field>
            <Field label={w.bought.unit}>
              <Txt ro={lro} value={x.unit} list="pl-units" onChange={(v) => putS(i, { unit: v })} />
            </Field>
            <Field label={w.sold.qty} error={err(`${sat}.quantity`)}>
              <Txt ro={lro} inputMode="decimal" value={x.quantity} onChange={(v) => putS(i, { quantity: v })} />
            </Field>
            <Field label={w.sold.rate} error={err(`${sat}.rate`)}>
              <Txt ro={lro} inputMode="decimal" value={x.rate} onChange={(v) => putS(i, { rate: v })} />
            </Field>
            <Field label={w.sold.transport}>
              <Txt ro={lro} inputMode="decimal" value={x.transport} onChange={(v) => putS(i, { transport: v })} />
            </Field>
            <Figure label={w.sold.taxable} value={f.taxable} />
            <Field label={w.bought.billing}>
              <Toggle ro={lro} value={x.gstBilled ? 'gst' : 'none'} options={[{ value: 'gst' as const, label: w.bought.gst }, { value: 'none' as const, label: w.bought.nonGst }]} onChange={(v) => putS(i, { gstBilled: v === 'gst' })} />
            </Field>
            {x.gstBilled && (
              <>
                <Field label={w.sold.gstin} wide>
                  <Txt ro={ro} value={x.partyGstin} onChange={(v) => putS(i, { partyGstin: v.toUpperCase() })} />
                  {!ro && customer && !customer.gstin && x.partyGstin.length === 15 && <Button onClick={() => store.patchParty(customer.id, { gstin: x.partyGstin })}>{w.adding.gstinTo(customer.name)}</Button>}
                </Field>
                <Field label={w.bought.gstRate} error={err(`${sat}.gstRatePct`)}>
                  <Sel ro={lro} value={x.gstRatePct} options={rateOptions(x.gstRatePct)} onChange={(v) => putS(i, { gstRatePct: v })} add={{ label: w.adding.rate, onAdd: addRate }} />
                </Field>
                <Figure label={w.sold.gstAmount} value={f.gstAmount} />
              </>
            )}
            <Figure label={w.sold.total} value={f.total} strong />
            <Field label={w.sold.dc}>
              <Txt ro={lro} value={x.challanNumber} onChange={(v) => putS(i, { challanNumber: v })} />
            </Field>
            <Field label={w.sold.invoice}>
              <Txt ro={lro} value={x.invoiceNumber} onChange={(v) => putS(i, { invoiceNumber: v })} />
            </Field>
            <div className="col-span-2 flex flex-wrap gap-4">
              <Photo ro={ro} label={w.sold.poPhoto} ids={x.poAttachmentId ? [x.poAttachmentId] : []} onChange={(ids) => putS(i, { poAttachmentId: ids[0] ?? null })} />
              <Photo ro={ro} label={w.sold.dcPhoto} ids={x.dcAttachmentId ? [x.dcAttachmentId] : []} onChange={(ids) => putS(i, { dcAttachmentId: ids[0] ?? null })} />
            </div>
          </LineFrame>
        );
      })}
      {!ro && (
        <div className="py-2">
          <Button onClick={() => onChange({ sales: [...trip.sales, blankSale()] })}>+ {w.addLine}</Button>
        </div>
      )}

      <p className="pt-3 text-[13px] font-semibold">{w.section.money}</p>
      <PaymentLines ro={ro} where={`${at}.payments`} lines={trip.payments} onChange={(payments) => onChange({ payments })} err={err} parties={tripParties} date={trip.date} />
      {calc && (
        <DuesTable
          dues={calc.dues}
          closing={Boolean(closing)}
          closedBy={closedBy}
          onClose={(partyId, close) => {
            if (!closing) return;
            const r = store.close(closing.sheetId, closing.tripId, partyId, { name: persona.name, grants: persona.grants }, bills, close);
            onCloseProblem(r.ok ? null : problemText(r.problem, w));
          }}
        />
      )}
      {!ro && !trip.sales.some((x) => x.id && invoiced.has(x.id)) && (
        <div className="flex justify-end pt-2">
          <Button variant="destructive" onClick={onRemove}>
            {w.removeTrip}
          </Button>
        </div>
      )}
      <datalist id="pl-units">
        {units.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </div>
  );
}

/** Which invoice a sale line is on, and that it stays as billed while it is. */
function InvoiceNote({ on, editing }: { on: PlSaleInvoice; editing: boolean }) {
  const iw = useWords(invoiceWords);
  const text = on.status === 'draft' || !on.number ? iw.sheet.onDraft : iw.sheet.onInvoice(on.number);
  return (
    <p className="col-span-2 flex flex-wrap items-baseline gap-x-2 text-[13px] md:col-span-4">
      <Link to={invoicePath(on.id)} className="underline" style={{ color: 'var(--brand)' }}>
        {text}
      </Link>
      {editing && <span style={{ color: 'var(--text-tertiary)' }}>{iw.sheet.locked}</span>}
    </p>
  );
}

/* -------------------------------------------------------------- the box */

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'muted' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[14px]">
      <span style={{ color: tone === 'muted' ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>{label}</span>
      <span className={strong ? 'font-semibold' : ''}>
        <Signed value={value} />
      </span>
    </div>
  );
}

/** The live P&L: the sheet's total as the rules work it out from the form as it stands, then each trip. */
function PlBox({ calc, tripNumbers, tripKeys }: { calc: SheetCalc; tripNumbers: string[]; tripKeys: string[] }) {
  const w = useWords(sheetWords);
  const p = calc.pl;
  const loss = p.net.startsWith('-');
  return (
    <div className="flex flex-col gap-1 px-4 py-4 md:px-6">
      <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {w.box.title} · {w.box.sheetTotal}
      </p>
      <Row label={w.box.sales} value={p.sales} />
      <Row label={w.box.purchase} value={p.materialCost} />
      <Row label={w.box.gross} value={p.gross} />
      <Row label={w.box.diesel} value={p.diesel} tone="muted" />
      <Row label={w.box.batta} value={p.batta} tone="muted" />
      <Row label={w.box.road} value={p.enRoute} tone="muted" />
      <Row label={w.box.enRoute} value={p.totalEnRoute} />
      <div className="mt-1 flex items-baseline justify-between gap-3 py-2" style={{ borderTop: '1px solid var(--border-strong)' }}>
        <span className="text-[15px] font-semibold">{loss ? w.box.loss : w.box.profit}</span>
        <span className="text-[20px] font-semibold">
          <Signed value={p.net} />
        </span>
      </div>
      <div className="flex justify-between text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        <span>{w.box.pct}</span>
        <span className="num">{p.profitPct === null ? '—' : `${p.profitPct.toFixed(2)}%`}</span>
      </div>
      <p className="pt-1 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {w.box.rule}
      </p>
      <Row label={w.box.gstToPay} value={p.gstToPay} />
      <p className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {w.box.gstNote}
      </p>
      <div className="grid grid-cols-3 gap-2 py-2 text-[13px]">
        <span className="flex flex-col">
          <span style={{ color: 'var(--text-tertiary)' }}>{w.box.km}</span>
          <span className="num">{p.distanceKm ?? '—'}</span>
        </span>
        <span className="flex flex-col">
          <span style={{ color: 'var(--text-tertiary)' }}>{w.box.litres}</span>
          <span className="num">{w.litres(p.dieselLitres)}</span>
        </span>
        <span className="flex flex-col">
          <span style={{ color: 'var(--text-tertiary)' }}>{w.box.mileage}</span>
          <span className="num">{p.mileageKmpl ?? '—'}</span>
        </span>
      </div>
      <Row label={`${w.box.customers} · ${w.money.due}`} value={p.customerDue} />
      <Row label={`${w.box.vendors} · ${w.money.due}`} value={p.vendorDue} />
      {tripKeys.length > 0 && (
        <>
          <p className="pt-3 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
            {w.box.perTrip} · {calc.basis === 'km' ? w.box.byKm : w.box.even}
          </p>
          {tripKeys.map((k, i) => {
            const t = calc.trips[k];
            if (!t) return null;
            return (
              <div key={k} className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
                <span className="min-w-0 truncate font-id">{tripNumbers[i]}</span>
                <span className="flex gap-3">
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    <Signed value={t.pl.sales} />
                  </span>
                  <Signed value={t.pl.net} strong />
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
