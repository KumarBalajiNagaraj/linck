import { useEffect, useMemo, useState } from 'react';
import { formatDateTime, formatINR, parseTypedAmount, type ImportOutcome, type PlannedClaim } from '@linck/domain';
import { DRIVERS, VEHICLES } from '@linck/mock';
import type { StatusFamily } from '@linck/tokens';
import {
  Button,
  Chip,
  ConfirmModal,
  DataTable,
  Detail,
  DetailGrid,
  EmptyState,
  IdCell,
  Note,
  PageHeader,
  Provisional,
  QuantityCell,
  Rail,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { useExpenses } from './expenseStore.js';
import { ChatArchiveError, readChatArchive } from './whatsappArchive.js';
import {
  billFromClaim,
  demoSource,
  fetchInboxSource,
  inboxIdsOf,
  InboxUnavailable,
  markInboxImported,
  planIntake,
  readIntake,
  sourceFromArchive,
  type IntakeClaim,
  type IntakeSource,
} from './whatsappImport.js';

/**
 * DIESEL SLIPS FROM WHATSAPP.
 *
 * The drivers mostly cannot read or write, so nothing here asks them to. A
 * driver fills diesel, photographs the bunk's slip and sends the photo on
 * WhatsApp — to the fleet's WhatsApp Business number, which files it here
 * and answers with a thumbs-up, or to the old drivers' group, whose export
 * can be imported instead. Linck reads each slip; the fleet manager looks
 * down one list, settles what the slip could not, and adds the bills. From
 * there they are ordinary bills awaiting validation.
 */

type Row = PlannedClaim<IntakeClaim>;

const OUTCOME: Record<ImportOutcome, { family: StatusFamily; label: string }> = {
  add: { family: 'active', label: 'Ready to add' },
  needs_details: { family: 'attention', label: 'Needs details' },
  repeat: { family: 'dormant', label: 'Repeat' },
  already_imported: { family: 'dormant', label: 'Already imported' },
  already_in_linck: { family: 'dormant', label: 'Already in Linck' },
  no_fill: { family: 'dormant', label: 'No fill' },
};

const VIEWS = ['all', 'ready', 'needs', 'left'] as const;
type View = (typeof VIEWS)[number];
const inView = (view: View, r: Row) =>
  view === 'all' || (view === 'ready' ? r.outcome === 'add' : view === 'needs' ? r.outcome === 'needs_details' : r.outcome !== 'add' && r.outcome !== 'needs_details');

/** What the fleet manager settled by hand, per claim. */
interface Override {
  vehicleId?: string;
  driverId?: string;
  amount?: string;
  litres?: string;
  leaveOut?: boolean;
}

const FIELD_CLASS = 'h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[13px]';
const FIELD_STYLE: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

const driverName = (id: string | null) => DRIVERS.find((d) => d.id === id)?.name ?? null;
const reg = (id: string | null) => VEHICLES.find((v) => v.id === id)?.displayReg ?? null;

export function WhatsAppDieselImport() {
  const { persona } = useApp();
  const bills = useExpenses((s) => s.bills);
  const add = useExpenses((s) => s.add);
  const [source, setSource] = useState<IntakeSource | null>(null);
  const [claims, setClaims] = useState<IntakeClaim[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [view, setView] = useViewParam(VIEWS, 'all');

  const load = async (get: () => Promise<IntakeSource>) => {
    setProblem(null);
    setNotice(null);
    try {
      const src = await get();
      setProgress({ done: 0, total: 0 });
      const read = await readIntake(src, { notDrivers: [persona.name], onProgress: (done, total) => setProgress({ done, total }) });
      setSource(src);
      setClaims(read);
      setOverrides({});
    } catch (err) {
      setProblem(err instanceof InboxUnavailable || err instanceof ChatArchiveError ? err.message : `Could not read that: ${String(err)}`);
    } finally {
      setProgress(null);
    }
  };

  // The manager's settlements applied, then everything planned against the live ledger.
  const plan = useMemo(() => {
    const settled = claims.map((c) => {
      const o = overrides[c.key];
      if (!o) return c;
      const amount = o.amount === undefined ? c.amount : parseTypedAmount(o.amount);
      const litres = o.litres === undefined ? c.litres : parseTypedAmount(o.litres, 3);
      return {
        ...c,
        vehicleId: o.vehicleId ?? c.vehicleId,
        driverId: o.driverId ?? c.driverId,
        amount,
        litres,
      };
    });
    return planIntake(settled, bills);
  }, [claims, overrides, bills]);

  const ready = plan.filter((r) => r.outcome === 'add' && !overrides[r.claim.key]?.leaveOut);
  const readyAmount = ready.reduce((s, r) => s + Math.round((r.claim.amount ?? 0) * 100), 0) / 100;
  const readyLitres = ready.reduce((s, r) => s + Math.round((r.claim.litres ?? 0) * 100), 0) / 100;
  const rows = plan.filter((r) => inView(view, r));
  const selected = plan.find((r) => r.claim.key === selectedKey) ?? null;

  const commit = () => {
    if (!source) return;
    for (const r of ready) add(billFromClaim(r.claim, source));
    void markInboxImported(ready.flatMap((r) => inboxIdsOf(r.claim, source)));
    setNotice(`${ready.length} bills worth ${formatINR(readyAmount)} added. They wait for validation under Fleet → Expenses.`);
    setConfirming(false);
  };

  const columns: Column<Row>[] = [
    {
      key: 'sent',
      header: 'Sent',
      sticky: true,
      width: 190,
      render: (r) => (
        <Stacked
          primary={driverName(r.claim.driverId) ?? r.claim.sender}
          secondary={`${formatDateTime(r.claim.at)}${r.claim.driverId && driverName(r.claim.driverId) !== r.claim.sender ? ` · ${r.claim.sender}` : ''}`}
        />
      ),
    },
    { key: 'outcome', header: 'Outcome', type: 'status', width: 170, render: (r) => <OutcomeStamp row={r} leftOut={overrides[r.claim.key]?.leaveOut === true} /> },
    { key: 'vehicle', header: 'Vehicle', type: 'id', width: 140, render: (r) => (reg(r.claim.vehicleId) ? <IdCell>{reg(r.claim.vehicleId)}</IdCell> : null) },
    { key: 'litres', header: 'Litres', unit: 'L', type: 'num', width: 90, render: (r) => (r.claim.litres === null ? null : <QuantityCell value={r.claim.litres} decimals={2} />) },
    {
      key: 'amount',
      header: 'Amount',
      unit: '₹',
      type: 'money',
      width: 120,
      render: (r) => (r.claim.amount === null ? null : <Provisional>{r.claim.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Provisional>),
    },
    { key: 'bunk', header: 'Bunk · bill', render: (r) => (r.claim.vendor || r.claim.billNumber ? <Stacked primary={r.claim.vendor ?? '–'} secondary={r.claim.billNumber ?? ''} /> : null) },
    {
      key: 'why',
      header: 'To check',
      render: (r) => {
        const first = r.reason ?? r.claim.issues[0];
        return first ? (
          <span className="block max-w-[26rem] whitespace-normal py-1.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {first}
            {r.claim.issues.length > 1 && !r.reason ? ` (+${r.claim.issues.length - 1} more)` : ''}
          </span>
        ) : null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Diesel slips from WhatsApp"
        actions={
          <>
            <Button variant="primary" onClick={() => void load(fetchInboxSource)} disabled={progress !== null}>
              Fetch from WhatsApp
            </Button>
            <label
              className="inline-flex h-11 cursor-pointer items-center px-3 text-[14px] font-medium focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--focus-ring)] [@media(hover:hover)]:h-[34px]"
              style={FIELD_STYLE}
            >
              Import chat export
              <input
                type="file"
                multiple
                accept=".zip,.txt,image/*,application/pdf"
                className="sr-only"
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  if (files.length > 0) void load(async () => sourceFromArchive(await readChatArchive(files)));
                }}
              />
            </label>
            <Button onClick={() => void load(async () => demoSource())} disabled={progress !== null}>
              Try the demo slips
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-2 px-6 pt-4">
        <Note>
          Drivers only have to photograph the bunk slip and send it to the fleet&apos;s WhatsApp Business number — no typing.
          The photo gets a 👍 when it arrives; Linck reads the litres, rupees, bill number and vehicle off the slip. A fleet
          still using a drivers&apos; group can import its &ldquo;Export chat&rdquo; file here instead.
        </Note>
        {progress ? (
          <p className="text-[13px]" aria-live="polite" style={{ color: 'var(--text-secondary)' }}>
            {progress.total === 0 ? 'Collecting the messages…' : `Reading slip ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`}
          </p>
        ) : null}
        {problem ? (
          <p className="relative pl-3 text-[13px]" style={{ color: 'var(--status-critical)' }}>
            <Rail status="critical" />
            {problem}
          </p>
        ) : null}
        {notice ? (
          <p className="text-[13px]" style={{ color: 'var(--status-ready)' }} aria-live="polite">
            {notice}
          </p>
        ) : null}
      </div>

      {source ? (
        <>
          <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <Chip active={view === 'all'} onClick={() => setView('all')} count={plan.length}>
              Everything read
            </Chip>
            <Chip active={view === 'ready'} onClick={() => setView('ready')} count={plan.filter((r) => inView('ready', r)).length}>
              Ready to add
            </Chip>
            <Chip active={view === 'needs'} onClick={() => setView('needs')} count={plan.filter((r) => inView('needs', r)).length}>
              Needs details
            </Chip>
            <Chip active={view === 'left'} onClick={() => setView('left')} count={plan.filter((r) => inView('left', r)).length}>
              Not added
            </Chip>
            <span className="ml-auto text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              From {source.via}
            </span>
          </div>
          <Section>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.claim.key}
              onRowClick={(r) => setSelectedKey(r.claim.key)}
              selectedKey={selectedKey ?? undefined}
              rail={(r) => ({ status: OUTCOME[r.outcome].family, provenance: 'proposed' })}
              isDormant={(r) => OUTCOME[r.outcome].family === 'dormant' || overrides[r.claim.key]?.leaveOut === true}
              empty={
                plan.length === 0 ? (
                  <EmptyState fact="No diesel messages in this chat." because="Nothing in it mentions a fill or carries a slip photo." />
                ) : (
                  <EmptyState fact="Nothing in this view." because="Every message read is in another view." action={{ label: 'Show everything read', onClick: () => setView('all') }} />
                )
              }
            />
          </Section>
          <div
            className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mt-6 flex flex-wrap items-end justify-between gap-4 px-6 py-4 md:bottom-0"
            style={{ background: 'var(--surface-sunken)', borderTop: '1px solid var(--border-strong)' }}
          >
            <div className="min-w-0 max-w-[720px]">
              <p className="font-serif text-[15px] italic" style={{ color: 'var(--text-primary)' }}>
                {ready.length} bills ready · {formatINR(readyAmount)} · {readyLitres.toLocaleString('en-IN')} L
              </p>
              <p className="mt-1 font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                Every figure was read by Linck. Adding them sends them for validation, where each is checked against its slip.
              </p>
            </div>
            <Button variant="primary" disabled={ready.length === 0} onClick={() => setConfirming(true)}>
              Add {ready.length} bills for validation
            </Button>
          </div>
        </>
      ) : !progress ? (
        <div className="px-6 pt-6">
          <EmptyState
            fact="No slips fetched yet."
            because="Fetch what drivers sent to the business number, import a group's chat export, or try the demo slips."
          />
        </div>
      ) : null}
      <div className="h-10" />

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={commit}
        title="Add these diesel bills"
        confirmLabel={`Add ${ready.length} bills`}
        consequence={
          <>
            <span className="block">
              {ready.length} diesel bills, {readyLitres.toLocaleString('en-IN')} litres, {formatINR(readyAmount)} in all, go to the fleet
              desk as awaiting validation.
            </span>
            <span className="mt-3 block" style={{ color: 'var(--text-tertiary)' }}>
              Messages that are repeats, already in Linck, not a fill, or still missing details are left where they are.
            </span>
          </>
        }
      />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedKey(null)}
        width="split"
        title={selected ? (driverName(selected.claim.driverId) ?? selected.claim.sender) : ''}
        identifier={selected ? formatDateTime(selected.claim.at) : undefined}
        {...(selected ? { status: { family: OUTCOME[selected.outcome].family, label: OUTCOME[selected.outcome].label } } : {})}
      >
        {selected ? (
          <ClaimDetail
            key={selected.claim.key}
            row={selected}
            demoText={selected.claim.attachments.map((a) => source?.slipTexts?.[a]).find(Boolean) ?? null}
            override={overrides[selected.claim.key] ?? {}}
            onOverride={(o) => setOverrides((all) => ({ ...all, [selected.claim.key]: { ...all[selected.claim.key], ...o } }))}
          />
        ) : null}
      </SideSheet>
    </>
  );
}

function OutcomeStamp({ row, leftOut }: { row: Row; leftOut: boolean }) {
  if (leftOut) return <StatusStamp status="dormant" label="Left out" />;
  const o = OUTCOME[row.outcome];
  const checks = row.outcome === 'add' ? row.claim.issues.length : 0;
  return (
    <span className="flex items-center gap-1.5">
      <StatusStamp status={o.family} label={o.label} provisional={row.outcome === 'add'} />
      {checks > 0 ? (
        <span className="text-[11px]" style={{ color: 'var(--status-attention)' }}>
          {checks} to check
        </span>
      ) : null}
    </span>
  );
}

function ClaimDetail({
  row,
  demoText,
  override,
  onOverride,
}: {
  row: Row;
  demoText: string | null;
  override: Override;
  onOverride: (o: Override) => void;
}) {
  const c = row.claim;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!c.photo || !c.photo.type.startsWith('image/')) return undefined;
    const u = URL.createObjectURL(c.photo);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [c.photo]);
  const slip = c.slip;

  return (
    <>
      <SheetSection caption="What the driver sent">
        {url ? <img src={url} alt="Slip photo from WhatsApp" className="max-h-[420px] w-full object-contain" /> : null}
        {!url && demoText ? (
          <pre className="whitespace-pre-wrap p-2 font-mono text-[11px]" style={FIELD_STYLE}>
            {demoText}
          </pre>
        ) : null}
        {!url && !demoText ? <Note>{c.attachments.length > 0 ? 'The photo is not in this export.' : 'No photo — words only.'}</Note> : null}
        <p className="mt-2 text-[13px]" style={{ color: c.text ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
          {c.text || 'No words with it.'}
        </p>
      </SheetSection>

      <SheetSection caption="What Linck read">
        <DetailGrid>
          <Detail label="Vehicle">{reg(c.vehicleId) ?? '–'}</Detail>
          <Detail label="Driver">{driverName(c.driverId) ?? `Not on the roster (${c.sender})`}</Detail>
          <Detail label="Litres">{c.litres ?? '–'}</Detail>
          <Detail label="Amount">{c.amount === null ? '–' : formatINR(c.amount)}</Detail>
          <Detail label="₹ a litre">{c.ratePerLitre ?? '–'}</Detail>
          <Detail label="Bunk">{c.vendor ?? '–'}</Detail>
          <Detail label="Bill number">{c.billNumber ?? '–'}</Detail>
          <Detail label="Slip read by">{slip?.engine ?? 'Not read'}</Detail>
        </DetailGrid>
        {c.filledFromSlip.length > 0 ? (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            From the slip, not the message: {c.filledFromSlip.join(', ')}.
          </p>
        ) : null}
      </SheetSection>

      {row.reason || c.issues.length > 0 ? (
        <SheetSection caption="To check">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px]" style={{ color: 'var(--text-primary)' }}>
            {row.reason ? <li>{row.reason}</li> : null}
            {c.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </SheetSection>
      ) : null}

      {row.outcome === 'add' || row.outcome === 'needs_details' ? (
        <SheetSection caption="Settle what the slip could not">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Labelled label="Vehicle">
              <select
                value={override.vehicleId ?? c.vehicleId ?? ''}
                onChange={(e) => onOverride({ vehicleId: e.target.value })}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              >
                <option value="">—</option>
                {VEHICLES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayReg}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label="Driver who filled">
              <select
                value={override.driverId ?? c.driverId ?? ''}
                onChange={(e) => onOverride({ driverId: e.target.value })}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              >
                <option value="">Not known</option>
                {DRIVERS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label="Litres, as on the slip">
              <input
                inputMode="decimal"
                value={override.litres ?? (c.litres === null ? '' : String(c.litres))}
                onChange={(e) => onOverride({ litres: e.target.value })}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              />
            </Labelled>
            <Labelled label="Amount ₹, as on the slip">
              <input
                inputMode="decimal"
                value={override.amount ?? (c.amount === null ? '' : String(c.amount))}
                onChange={(e) => onOverride({ amount: e.target.value })}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              />
            </Labelled>
          </div>
          <div className="mt-3">
            <Button onClick={() => onOverride({ leaveOut: !override.leaveOut })}>{override.leaveOut ? 'Put it back in' : 'Leave this one out'}</Button>
          </div>
        </SheetSection>
      ) : null}
    </>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}
