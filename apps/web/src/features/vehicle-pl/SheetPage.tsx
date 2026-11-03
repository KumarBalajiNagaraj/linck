import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { calculateSheet, can, decimal, formatDate, purchaseFigures, saleFigures, type SheetCalc, type TripCalc } from '@linck/domain';
import { DRIVERS, VEHICLES, type PlPartyDue, type PlSaleInvoice } from '@linck/mock';
import { Button, ConfirmModal, EmptyState, PageHeader, Rail, Section } from '@linck/ui';
import { LIVE } from '../../auth/api.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { spacedRegistration, useSites, vehicleRef } from '../expenses/bills.js';
import { invoicePath } from './invoiceStore.js';
import { invoiceWords } from './invoiceWords.js';
import { CTRL, FIELD_BOX, Signed } from './PlParts.js';
import type { Masters } from './plApi.js';
import { CLOSE, draftDomain, LIST_PATH, READ_KEYS, readable, sheetPath, WRITE, type PlProblem } from './plStore.js';
import { problemField, problemText } from './plText.js';
import {
  FUEL_ENTRIES_OFFERED,
  SheetBeingEdited,
  useCloseTrip,
  useDeleteSheet,
  useDieselBills,
  useFuelEntries,
  useMasterMoves,
  useMasterRefusal,
  useOrdersFor,
  usePhotos,
  usePlMasters,
  useSaveSheet,
  useSheet,
  useWritableSites,
  type SheetView,
} from './sheets.js';
import {
  asText as s,
  blankDiesel,
  blankDraft,
  blankPayment,
  blankPurchase,
  blankRoad,
  blankSale,
  blankTrip,
  fromRecord,
  MAINT,
  MODES,
  toInput,
  typedBlankDraft,
  type DDiesel,
  type DPayment,
  type DPurchase,
  type DRoad,
  type DSale,
  type DTrip,
  type Draft,
} from './sheetDraft.js';
import { SheetInvoices } from './SheetInvoices.js';
import { plWords, sheetWords } from './words.js';

/* ------------------------------------------------------------ the parts */

/** A labelled field. `echo` reads back what was typed (live: a vehicle number, as it will be kept). */
function Field({ label, error, wide, echo, children }: { label: string; error?: string | null; wide?: boolean; echo?: string | null; children: React.ReactNode }) {
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
      ) : echo ? (
        <span className="num text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {echo}
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

/** Adding to a master from a line: the demo's id at once; live, once the API has answered (null: refused). */
type Adder = (name: string) => string | null | Promise<string | null>;

function Sel({ ro, value, onChange, options, placeholder, add }: { ro: boolean; value: string; onChange: (v: string) => void; options: { value: string; label: string; disabled?: boolean }[]; placeholder?: string; add?: { label: string; onAdd: Adder } }) {
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
            if (made instanceof Promise) void made.then((id) => id && onChange(id));
            else if (made) onChange(made);
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
  const { known, upload } = usePhotos();
  /** Live only: a photo on its way to the API, or why it was refused. */
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<PlProblem | null>(null);
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
                if (a instanceof Promise) {
                  setSending(true);
                  setRefused(null);
                  void a.then((got) => {
                    setSending(false);
                    if ('code' in got) setRefused(got);
                    else onChange(multiple ? [...ids, got.id] : [got.id]);
                  });
                } else onChange(multiple ? [...ids, a.id] : [a.id]);
                e.target.value = '';
              }}
            />
          </label>
        )}
        {sending && <span style={{ color: 'var(--text-secondary)' }}>{sw.photo.sending}</span>}
      </span>
      {refused && (
        <span className="text-[12px]" role="alert" style={{ color: 'var(--status-critical)' }}>
          {problemText(refused, sw)}
        </span>
      )}
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

/**
 * Fleet → Vehicle P&L → a trip sheet (LIN-22): one vehicle and driver from a
 * start date to an end date, its trips, every line on them, and the P&L box
 * that works the profit out as the sheet is typed.
 *
 * The sheet comes from sheets.ts: the demo store, or live the API. Live, the
 * page waits for the sheet and the masters its pickers offer; a sheet that is
 * not there, or not this person's to read, is not found, as in the demo.
 */
export function SheetPage() {
  const params = useParams({ strict: false }) as { sheetId?: string };
  const { persona } = useApp();
  const sheet = useSheet(params.sheetId);
  const masters = usePlMasters();
  const view = sheet.data;
  if (params.sheetId && sheet.state !== 'ready') return <NotRead read={sheet} />;
  if (params.sheetId && !view) return <NotFound />;
  if (view && !readable(persona.grants, READ_KEYS, view.record.siteId)) return <NotFound />;
  if (masters.state !== 'ready') return <NotRead read={masters} />;
  return (
    <SheetBeingEdited.Provider value={view}>
      <SheetForm key={params.sheetId ?? 'new'} view={view} masters={masters.data} />
    </SheetBeingEdited.Provider>
  );
}

const NO_INVOICES = new Map<string, PlSaleInvoice>();

function SheetForm({ view, masters }: { view: SheetView | null; masters: Masters }) {
  const w = useWords(sheetWords);
  const pw = useWords(plWords);
  const navigate = useNavigate();
  const { persona, siteScope } = useApp();
  const sites = useSites();
  const writable = useWritableSites();
  const moves = useMasterMoves();
  const saving = useSaveSheet();
  const deleting = useDeleteSheet();
  const record = view?.record ?? null;
  const invoiced = view?.invoiced ?? NO_INVOICES;
  const writeAt = (siteId: string) => can(persona.grants, WRITE, { siteId });
  const [editing, setEditing] = useState(!record);
  const [draft, setDraft] = useState<Draft>(() =>
    record ? fromRecord(record) : LIVE ? typedBlankDraft(writable.find((x) => x.id === siteScope)?.id ?? writable[0]?.id ?? '') : blankDraft(writeAt),
  );
  const [problem, setProblem] = useState<PlProblem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [closeProblem, setCloseProblem] = useState<string | null>(null);
  const ro = !editing;
  const { bills } = useDieselBills(draft.vehicleId);
  /** Live: why a party, material, rate or GSTIN added from a line was refused. */
  const masterRefusal = useMasterRefusal((st) => st.problem);
  const clearMasterRefusal = useMasterRefusal((st) => st.set);
  useEffect(() => () => clearMasterRefusal(null), [clearMasterRefusal]);

  // Live, a sheet read again (someone else saved it) is shown as it now is, unless it is being edited.
  const shownAt = useRef(record?.updatedAt);
  useEffect(() => {
    if (!LIVE || editing || !record || shownAt.current === record.updatedAt) return;
    shownAt.current = record.updatedAt;
    setDraft(fromRecord(record));
  }, [record, editing]);

  const input = useMemo(() => toInput(draft), [draft]);
  const calc: SheetCalc = useMemo(
    () => (editing || !view ? calculateSheet(draftDomain(input, record, masters.materials, bills)) : view.calc),
    [editing, view, record, input, masters.materials, bills],
  );

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
  const addParty = (role: 'customer' | 'vendor') => (name: string) => moves.addParty(role, name, draft.siteId);
  const addRate = (text: string) => {
    const n = Number(text.replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return moves.addRate(n);
  };

  const save = async () => {
    setProblem(null);
    clearMasterRefusal(null);
    // Live, a vehicle is kept as its registration, written as people write it: TN 38 AL 1050.
    const sent = LIVE ? { ...input, registrationNumber: spacedRegistration(input.vehicleId) || input.registrationNumber.trim() } : input;
    const result = await saving.run({ input: sent, record });
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setEditing(false);
    if (!record) void navigate({ to: sheetPath(result.id) });
    else {
      shownAt.current = result.record.updatedAt;
      setDraft(fromRecord(result.record));
    }
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
              {LIVE ? (
                <>
                  <Field
                    label={w.vehicle.vehicle}
                    error={err('vehicleId') ?? err('registrationNumber')}
                    echo={!ro && !record && draft.vehicleId ? w.vehicle.readAs(spacedRegistration(draft.vehicleId)) : null}
                    wide
                  >
                    <Txt ro={ro || Boolean(record)} value={draft.registrationNumber} placeholder="TN 38 AL 1050" onChange={(v) => set({ registrationNumber: v.toUpperCase(), vehicleId: vehicleRef(v) ?? '' })} />
                  </Field>
                  <Field label={w.vehicle.site} error={err('siteId')}>
                    <Sel
                      ro={ro || Boolean(record)}
                      value={draft.siteId}
                      options={(ro || record ? sites : writable).map((x) => ({ value: x.id, label: x.name }))}
                      placeholder={w.vehicle.pickSite}
                      onChange={(siteId) => set({ siteId })}
                    />
                  </Field>
                  <Field label={w.vehicle.model} error={err('vehicleModel')}>
                    <Txt ro={ro} value={draft.vehicleModel} onChange={(v) => set({ vehicleModel: v })} />
                  </Field>
                  <Field label={w.vehicle.driver} error={err('driverName')}>
                    <Txt ro={ro} value={draft.driverName} onChange={(v) => set({ driverName: v })} />
                  </Field>
                  <Field label={w.vehicle.phone} error={err('driverPhone')}>
                    <Txt ro={ro} inputMode="numeric" value={draft.driverPhone} onChange={(v) => set({ driverPhone: v })} />
                  </Field>
                </>
              ) : (
                <>
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
                </>
              )}
              <Field label={w.vehicle.start} error={err('startDate')}>
                <Txt ro={ro} type="date" value={draft.startDate} onChange={(v) => set({ startDate: v })} />
              </Field>
              <Field label={w.vehicle.end} error={err('endDate')}>
                <Txt ro={ro} type="date" value={draft.endDate} onChange={(v) => set({ endDate: v })} />
              </Field>
              <Field label={w.vehicle.batta} error={err('batta')}>
                <Txt ro={ro} inputMode="decimal" value={draft.batta} onChange={(v) => set({ batta: v })} />
              </Field>
              <Field label={w.vehicle.startKm} error={err('startKm')}>
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

          {record && !editing && <SheetInvoices record={record} invoiced={invoiced} />}

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
            ) : masterRefusal ? (
              <span role="alert" style={{ color: 'var(--status-critical)' }}>
                {problemText(masterRefusal, w)}
              </span>
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
          <Button variant="primary" disabled={saving.busy} onClick={() => void save()}>
            {saving.busy ? w.saving : w.save}
          </Button>
        </div>
      )}

      {record && (
        <ConfirmModal
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            void deleting.run(record).then((refused) => {
              if (!refused) void navigate({ to: LIST_PATH });
              else setProblem(refused);
              setConfirming(false);
            });
          }}
          title={w.confirm.title}
          consequence={w.confirm.consequence(record.sheetNumber, record.trips.length, `₹${money(view?.calc.pl.net)}`)}
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

/**
 * Live only: the sheet, or the masters its pickers offer, on their way, or
 * not read. A sheet the API says is not there, or not this person's, is not
 * found, as the demo says of one.
 */
function NotRead({ read }: { read: { state: 'loading' | 'ready' | 'failed'; problem: PlProblem | null; retry: () => void } }) {
  const w = useWords(sheetWords);
  if (read.state === 'failed' && (read.problem?.code === 'gone' || read.problem?.code === 'needs-permission')) return <NotFound />;
  if (read.state === 'loading') return <EmptyState fact={w.loading} />;
  return <EmptyState fact={w.failed} {...(read.problem ? { because: problemText(read.problem, w) } : {})} action={{ label: w.retry, onClick: read.retry }} />;
}

/* ------------------------------------------------------------ the lines */

type Err = (path: string) => string | null;

function DieselLines({ ro, where, lines, calc, onChange, err, draft, recordId }: { ro: boolean; where: string; lines: DDiesel[]; calc: SheetCalc['diesel']; onChange: (l: DDiesel[]) => void; err: Err; draft: Draft; recordId: string | null }) {
  const w = useWords(sheetWords);
  const masters = usePlMasters().data;
  const moves = useMasterMoves();
  const fuelEntries = useFuelEntries(draft.vehicleId);
  const billOptions = useDieselBills(draft.vehicleId).options.map((b) => ({
    value: b.id,
    label: `${b.billNumber} · ${formatDate(b.billDate)} · ₹${b.amount}${b.linkedSheet && b.linkedSheet.sheetId !== recordId ? ` · ${w.diesel.onSheet(b.linkedSheet.sheetNumber)}` : ''}`,
    disabled: Boolean(b.linkedSheet && b.linkedSheet.sheetId !== recordId),
  }));
  const fuelOptions = fuelEntries.map(({ entry, linkedSheet }) => ({
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
                  // Live, the fuel register is not on the API: no fuel entry to link.
                  ...(FUEL_ENTRIES_OFFERED || l.source === 'fuel_entry' ? [{ value: 'fuel_entry' as const, label: w.diesel.fuel }] : []),
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
                <Field label={w.diesel.billNo} error={err(`${at}.billNumber`)}>
                  <Txt ro={ro} value={l.billNumber} onChange={(v) => put(i, { billNumber: v })} />
                </Field>
                <Field label={w.diesel.vendor} error={err(`${at}.vendorId`)} wide>
                  <Sel ro={ro} value={l.vendorId} options={bunks} placeholder={w.diesel.pickVendor} onChange={(v) => put(i, { vendorId: v })} add={{ label: w.adding.vendor, onAdd: (name) => moves.addParty('vendor', name, draft.siteId) }} />
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
                      const e = fuelEntries.find((x) => x.entry.id === v)?.entry;
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
            <Field label={w.road.date} error={err(`${at}.date`)}>
              <Txt ro={ro} type="date" value={l.date || date} onChange={(v) => put(i, { date: v })} />
            </Field>
            <Field label={w.road.amount} error={err(`${at}.amount`)}>
              <Txt ro={ro} inputMode="decimal" value={l.amount} onChange={(v) => put(i, { amount: v })} />
            </Field>
            <Field label={w.road.location} error={err(`${at}.location`)}>
              <Txt ro={ro} value={l.location} onChange={(v) => put(i, { location: v })} />
            </Field>
            {l.kind === 'toll' && (
              <Field label={w.road.reference} error={err(`${at}.reference`)}>
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
            <Field label={w.money.reference} error={err(at) ?? err(`${at}.reference`)}>
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
  const parties = usePlMasters().data.parties;
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
  addParty: (role: 'customer' | 'vendor') => Adder;
  addRate: Adder;
  draft: Draft;
  recordId: string | null;
  closing: { sheetId: string; tripId: string } | null;
  onCloseProblem: (text: string | null) => void;
  closedBy: { partyId: string; closedBy: string }[];
  /** LIN-27: the live invoice each saved sale line is on. Such a line stays as billed. */
  invoiced: Map<string, PlSaleInvoice>;
}) {
  const w = useWords(sheetWords);
  const masters = usePlMasters().data;
  const moves = useMasterMoves();
  const closeTrip = useCloseTrip();
  const ordersFor = useOrdersFor();
  const at = `trips[${index}]`;
  const materials = masters.materials.filter((m) => m.active || trip.purchases.some((p) => p.materialId === m.id) || trip.sales.some((x) => x.materialId === m.id)).map((m) => ({ value: m.id, label: m.name }));
  const units = [...new Set(masters.materials.map((m) => m.unit))];
  const putP = (i: number, patch: Partial<DPurchase>) => onChange({ purchases: trip.purchases.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const putS = (i: number, patch: Partial<DSale>) => onChange({ sales: trip.sales.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const addMaterial = (line: { hsnCode: string; unit: string; gstRatePct: string }) => (name: string) =>
    moves.addMaterial({ name, hsnCode: line.hsnCode || null, unit: line.unit || 'unit', gstRatePct: Number(line.gstRatePct) || 5 });
  const tripParties = (role: 'customer' | 'vendor') => {
    const ids = new Set(role === 'customer' ? trip.sales.map((x) => x.customerId) : trip.purchases.map((p) => p.vendorId));
    return partyOptions(role).filter((o) => ids.has(o.value));
  };
  const locations = (partyId: string) => masters.parties.find((p) => p.id === partyId)?.locations ?? [];
  const partyOf = (id: string) => masters.parties.find((p) => p.id === id);
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
            <Field label={w.vehicle.startKm} error={err(`${at}.startKm`)}>
              <Txt ro={ro} inputMode="decimal" value={trip.startKm} onChange={(v) => onChange({ startKm: v })} />
            </Field>
            <Field label={w.vehicle.endKm} error={err(`${at}.endKm`)}>
              <Txt ro={ro} inputMode="decimal" value={trip.endKm} onChange={(v) => onChange({ endKm: v })} />
            </Field>
            <Field label={w.vehicle.batta} error={err(`${at}.batta`)}>
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
            <Field label={w.bought.location} error={err(`${pat}.location`)} wide>
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
                  const m = masters.materials.find((x) => x.id === v);
                  putP(i, { materialId: v, hsnCode: m?.hsnCode ?? '', unit: m?.unit ?? '', gstRatePct: m ? String(m.gstRatePct) : '' });
                }}
                add={{ label: w.adding.material, onAdd: addMaterial(p) }}
              />
            </Field>
            <Field label={w.bought.hsn} error={err(`${pat}.hsnCode`)}>
              <Txt ro={ro} inputMode="numeric" value={p.hsnCode} onChange={(v) => putP(i, { hsnCode: v })} />
            </Field>
            <Field label={w.bought.unit} error={err(`${pat}.unit`)}>
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
                    <Button onClick={() => moves.saveGstin(vendor.id, p.vendorGstin)}>{w.adding.gstinTo(vendor.name)}</Button>
                  )}
                </Field>
                <Field label={w.bought.gstRate} error={err(`${pat}.gstRatePct`)}>
                  <Sel ro={ro} value={p.gstRatePct} options={rateOptions(p.gstRatePct)} onChange={(v) => putP(i, { gstRatePct: v })} add={{ label: w.adding.rate, onAdd: addRate }} />
                </Field>
                <Figure label={w.bought.gstAmount} value={f.gstAmount} />
              </>
            )}
            <Figure label={w.bought.total} value={f.total} strong />
            <Field label={w.bought.invoice} error={err(`${pat}.invoiceNumber`) ?? err(`${pat}.invoiceDate`)}>
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
            <Field label={w.sold.location} error={err(`${sat}.location`)} wide>
              <Txt ro={lro} value={x.location} list={listId} onChange={(v) => putS(i, { location: v })} />
              <datalist id={listId}>
                {locations(x.customerId).map((l) => (
                  <option key={l.id} value={l.name} />
                ))}
              </datalist>
            </Field>
            <Field label={w.sold.poRef} error={err(`${sat}.poRef`) ?? err(`${sat}.purchaseOrderId`)}>
              <Txt ro={ro} value={x.poRef} onChange={(v) => putS(i, { poRef: v, purchaseOrderId: '' })} />
            </Field>
            <Field label={w.bought.material} error={err(`${sat}.materialId`)}>
              <Sel
                ro={lro}
                value={x.materialId}
                options={materials}
                placeholder={w.bought.pickMaterial}
                onChange={(v) => {
                  const m = masters.materials.find((y) => y.id === v);
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
            <Field label={w.bought.hsn} error={err(`${sat}.hsnCode`)}>
              <Txt ro={lro} inputMode="numeric" value={x.hsnCode} onChange={(v) => putS(i, { hsnCode: v })} />
            </Field>
            <Field label={w.bought.unit} error={err(`${sat}.unit`)}>
              <Txt ro={lro} value={x.unit} list="pl-units" onChange={(v) => putS(i, { unit: v })} />
            </Field>
            <Field label={w.sold.qty} error={err(`${sat}.quantity`)}>
              <Txt ro={lro} inputMode="decimal" value={x.quantity} onChange={(v) => putS(i, { quantity: v })} />
            </Field>
            <Field label={w.sold.rate} error={err(`${sat}.rate`)}>
              <Txt ro={lro} inputMode="decimal" value={x.rate} onChange={(v) => putS(i, { rate: v })} />
            </Field>
            <Field label={w.sold.transport} error={err(`${sat}.transport`)}>
              <Txt ro={lro} inputMode="decimal" value={x.transport} onChange={(v) => putS(i, { transport: v })} />
            </Field>
            <Figure label={w.sold.taxable} value={f.taxable} />
            <Field label={w.bought.billing}>
              <Toggle ro={lro} value={x.gstBilled ? 'gst' : 'none'} options={[{ value: 'gst' as const, label: w.bought.gst }, { value: 'none' as const, label: w.bought.nonGst }]} onChange={(v) => putS(i, { gstBilled: v === 'gst' })} />
            </Field>
            {x.gstBilled && (
              <>
                <Field label={w.sold.gstin} error={err(`${sat}.partyGstin`)} wide>
                  <Txt ro={ro} value={x.partyGstin} onChange={(v) => putS(i, { partyGstin: v.toUpperCase() })} />
                  {!ro && customer && !customer.gstin && x.partyGstin.length === 15 && <Button onClick={() => moves.saveGstin(customer.id, x.partyGstin)}>{w.adding.gstinTo(customer.name)}</Button>}
                </Field>
                <Field label={w.bought.gstRate} error={err(`${sat}.gstRatePct`)}>
                  <Sel ro={lro} value={x.gstRatePct} options={rateOptions(x.gstRatePct)} onChange={(v) => putS(i, { gstRatePct: v })} add={{ label: w.adding.rate, onAdd: addRate }} />
                </Field>
                <Figure label={w.sold.gstAmount} value={f.gstAmount} />
              </>
            )}
            <Figure label={w.sold.total} value={f.total} strong />
            <Field label={w.sold.dc} error={err(`${sat}.challanNumber`)}>
              <Txt ro={lro} value={x.challanNumber} onChange={(v) => putS(i, { challanNumber: v })} />
            </Field>
            <Field label={w.sold.invoice} error={err(`${sat}.invoiceNumber`)}>
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
            void closeTrip.run({ sheetId: closing.sheetId, tripId: closing.tripId, partyId, close }).then((refused) => onCloseProblem(refused ? problemText(refused, w) : null));
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
