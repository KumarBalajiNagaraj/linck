import { useEffect, useMemo, useState } from 'react';
import { formatDateTime, formatINR, parseTypedAmount, sitesFor, type ImportOutcome, type PlannedClaim } from '@linck/domain';
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
import { LIVE } from '../../auth/api.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { useProblemWords } from './ApprovalChain.js';
import { driverLabel, useBills, useImportClaims, useSiteName, useSites, vehicleLabel, vehicleRef } from './bills.js';
import { BillRefused } from './expenseApi.js';
import { expenseWords } from './words.js';
import { ChatArchiveError, readChatArchive } from './whatsappArchive.js';
import {
  demoSource,
  fetchInboxSource,
  InboxUnavailable,
  liveRosters,
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
 *
 * LIVE (VITE_API_URL set), the bills already in Linck are the API's, and
 * adding sends the slips to `POST /whatsapp/imports`, which takes each
 * message once however many phones export it. There is no fleet list or
 * driver roster on the API yet, so a slip's vehicle is the registration it
 * gives (whatsappImport.ts `liveRosters`), typed in where it gives none, and
 * the demo's sample fleet, drivers and slips are not offered at all.
 */

type Row = PlannedClaim<IntakeClaim>;

const OUTCOME_FAMILY: Record<ImportOutcome, StatusFamily> = {
  add: 'active',
  needs_details: 'attention',
  repeat: 'dormant',
  already_imported: 'dormant',
  already_in_linck: 'dormant',
  no_fill: 'dormant',
};

const VIEWS = ['all', 'ready', 'needs', 'left'] as const;
type View = (typeof VIEWS)[number];
const inView = (view: View, r: Row) =>
  view === 'all' || (view === 'ready' ? r.outcome === 'add' : view === 'needs' ? r.outcome === 'needs_details' : r.outcome !== 'add' && r.outcome !== 'needs_details');

/** What the fleet manager settled by hand, per claim. */
interface Override {
  vehicleId?: string;
  /** Live: the vehicle number as typed. */
  vehicleText?: string;
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

const driverName = (id: string | null) => driverLabel(id);
const reg = (id: string | null) => vehicleLabel(id);

export function WhatsAppDieselImport() {
  const { persona, siteScope } = useApp();
  const t = useWords(expenseWords);
  const w = t.whatsapp;
  const say = useProblemWords();
  const list = useBills();
  const { bills } = list;
  const importClaims = useImportClaims();
  const sites = useSites();
  const siteName = useSiteName();
  const [source, setSource] = useState<IntakeSource | null>(null);
  const [claims, setClaims] = useState<IntakeClaim[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** Kept as what went wrong, so it is worded in whichever language is showing. */
  const [problem, setProblem] = useState<unknown>(null);
  const [notice, setNotice] = useState<{ count: number; amount: number; before: number } | null>(null);
  // Live, the bills are booked as the upload sheet books one: to the site in
  // scope, else the person's own, else the first they may add bills at. The
  // demo books each to its sample vehicle's site.
  const uploadSites = sitesFor(
    persona.grants,
    'fleet.expense.upload',
    sites.map((site) => site.id),
  );
  const bookedTo = siteScope ?? (uploadSites.includes(persona.defaultSiteId ?? '') ? persona.defaultSiteId : uploadSites[0]) ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [view, setView] = useViewParam(VIEWS, 'all');

  const load = async (get: () => Promise<IntakeSource>) => {
    setProblem(null);
    setNotice(null);
    try {
      const src = await get();
      setProgress({ done: 0, total: 0 });
      const read = await readIntake(src, {
        notDrivers: [persona.name],
        ...(LIVE ? { rosters: liveRosters(bills) } : {}),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setSource(src);
      setClaims(read);
      setOverrides({});
    } catch (err) {
      setProblem(err);
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
        vehicleId: o.vehicleText !== undefined ? vehicleRef(o.vehicleText) : (o.vehicleId ?? c.vehicleId),
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
    void importClaims.run({ rows: ready, source, siteId: bookedTo }).then((out) => {
      if ('problem' in out) {
        setProblem(new BillRefused(out.problem));
        return;
      }
      setProblem(null);
      setNotice({ count: out.count, amount: out.paise / 100, before: out.before });
    });
    setConfirming(false);
  };

  const problemText =
    problem === null
      ? null
      : problem instanceof InboxUnavailable
        ? problem.reason === 'sign-in'
          ? w.inbox.signIn
          : problem.reason === 'status'
            ? w.inbox.status(problem.status ?? 0)
            : w.inbox.unreachable
        : problem instanceof ChatArchiveError
          ? problem.reason === 'too-big'
            ? w.archive.tooBig
            : w.archive.noChat
          : problem instanceof BillRefused
            ? say(problem.problem)
            : w.couldNotRead;
  const via = source ? (source.kind === 'inbox' ? w.businessNumber : source.kind === 'demo' ? `${source.via} ${w.demoSuffix}` : source.via) : '';

  const columns: Column<Row>[] = [
    {
      key: 'sent',
      header: w.columns.sent,
      sticky: true,
      width: 190,
      render: (r) => (
        <Stacked
          primary={driverName(r.claim.driverId) ?? r.claim.sender}
          secondary={`${formatDateTime(r.claim.at)}${r.claim.driverId && driverName(r.claim.driverId) !== r.claim.sender ? ` · ${r.claim.sender}` : ''}`}
        />
      ),
    },
    { key: 'outcome', header: w.columns.result, type: 'status', width: 170, render: (r) => <OutcomeStamp row={r} leftOut={overrides[r.claim.key]?.leaveOut === true} /> },
    { key: 'vehicle', header: w.columns.vehicle, type: 'id', width: 140, render: (r) => (reg(r.claim.vehicleId) ? <IdCell>{reg(r.claim.vehicleId)}</IdCell> : null) },
    { key: 'litres', header: w.columns.litres, unit: 'L', type: 'num', width: 90, render: (r) => (r.claim.litres === null ? null : <QuantityCell value={r.claim.litres} decimals={2} />) },
    {
      key: 'amount',
      header: w.columns.amount,
      unit: '₹',
      type: 'money',
      width: 120,
      render: (r) => (r.claim.amount === null ? null : <Provisional>{r.claim.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Provisional>),
    },
    { key: 'bunk', header: w.columns.bunk, render: (r) => (r.claim.vendor || r.claim.billNumber ? <Stacked primary={r.claim.vendor ?? '–'} secondary={r.claim.billNumber ?? ''} /> : null) },
    {
      key: 'why',
      header: w.columns.toCheck,
      render: (r) => {
        const first = r.reason ? t.reason(r.reason) : r.claim.issues[0] ? t.notice(r.claim.issues[0]) : null;
        return first ? (
          <span className="block max-w-[26rem] whitespace-normal py-1.5 text-[13px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {first}
            {r.claim.issues.length > 1 && !r.reason ? w.more(r.claim.issues.length - 1) : ''}
          </span>
        ) : null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.desk.fleet}
        title={w.title}
        actions={
          <>
            <Button variant="primary" onClick={() => void load(fetchInboxSource)} disabled={progress !== null}>
              {w.fetch}
            </Button>
            <label
              className="inline-flex h-11 cursor-pointer items-center px-3 text-[14px] font-medium focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--focus-ring)] [@media(hover:hover)]:h-[34px]"
              style={FIELD_STYLE}
            >
              {w.importChat}
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
            {/* Live, the demo's sample slips would become this company's bills. */}
            {LIVE ? null : (
              <Button onClick={() => void load(async () => demoSource())} disabled={progress !== null}>
                {w.demo}
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-2 px-6 pt-4">
        <Note>{w.note}</Note>
        {progress ? (
          <p className="text-[14px]" aria-live="polite" style={{ color: 'var(--text-secondary)' }}>
            {progress.total === 0 ? w.collecting : w.readingSlip(Math.min(progress.done + 1, progress.total), progress.total)}
          </p>
        ) : null}
        {problemText ? (
          <p className="relative pl-3 text-[14px]" style={{ color: 'var(--status-critical)' }}>
            <Rail status="critical" />
            {problemText}
          </p>
        ) : null}
        {importClaims.busy ? (
          <p className="text-[14px]" aria-live="polite" style={{ color: 'var(--text-secondary)' }}>
            {t.live.saving}
          </p>
        ) : null}
        {notice ? (
          <p className="text-[14px]" style={{ color: 'var(--status-ready)' }} aria-live="polite">
            {w.added(notice.count, formatINR(notice.amount))}
            {notice.before > 0 ? ` ${w.addedBefore(notice.before)}` : ''}
          </p>
        ) : null}
      </div>

      {source ? (
        <>
          <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <Chip active={view === 'all'} onClick={() => setView('all')} count={plan.length}>
              {w.chips.all}
            </Chip>
            <Chip active={view === 'ready'} onClick={() => setView('ready')} count={plan.filter((r) => inView('ready', r)).length}>
              {w.chips.ready}
            </Chip>
            <Chip active={view === 'needs'} onClick={() => setView('needs')} count={plan.filter((r) => inView('needs', r)).length}>
              {w.chips.needs}
            </Chip>
            <Chip active={view === 'left'} onClick={() => setView('left')} count={plan.filter((r) => inView('left', r)).length}>
              {w.chips.left}
            </Chip>
            <span className="ml-auto text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              {w.from(via)}
            </span>
          </div>
          <Section>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.claim.key}
              onRowClick={(r) => setSelectedKey(r.claim.key)}
              selectedKey={selectedKey ?? undefined}
              rail={(r) => ({ status: OUTCOME_FAMILY[r.outcome], provenance: 'proposed' })}
              isDormant={(r) => OUTCOME_FAMILY[r.outcome] === 'dormant' || overrides[r.claim.key]?.leaveOut === true}
              empty={
                plan.length === 0 ? (
                  <EmptyState fact={w.noDiesel} />
                ) : (
                  <EmptyState fact={w.noneInList} action={{ label: w.showAll, onClick: () => setView('all') }} />
                )
              }
            />
          </Section>
          <div
            className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mt-6 flex flex-wrap items-end justify-between gap-4 px-6 py-4 md:bottom-0"
            style={{ background: 'var(--surface-sunken)', borderTop: '1px solid var(--border-strong)' }}
          >
            <div className="min-w-0 max-w-[720px]">
              <p className="text-[16px]" style={{ color: 'var(--text-primary)' }}>
                {w.readyLine(ready.length, formatINR(readyAmount), readyLitres)}
              </p>
              <p className="mt-1 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                {w.readySub}
              </p>
            </div>
            {/* Live, not before the bills already in Linck are read: they are what a repeat is checked against. */}
            <Button variant="primary" disabled={ready.length === 0 || importClaims.busy || list.state !== 'ready'} onClick={() => setConfirming(true)}>
              {importClaims.busy ? t.live.saving : w.addN(ready.length)}
            </Button>
          </div>
        </>
      ) : !progress ? (
        <div className="px-6 pt-6">
          <EmptyState fact={w.nothingYet} because={LIVE ? w.nothingYetHowLive : w.nothingYetHow} />
        </div>
      ) : null}
      <div className="h-10" />

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={commit}
        title={w.confirmTitle}
        confirmLabel={w.addN(ready.length)}
        consequence={
          <>
            <span className="block">{w.confirmBody(ready.length, readyLitres, formatINR(readyAmount))}</span>
            {LIVE && bookedTo ? <span className="mt-3 block">{w.savedTo(siteName(bookedTo))}</span> : null}
            <span className="mt-3 block" style={{ color: 'var(--text-tertiary)' }}>
              {w.confirmRest}
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
        {...(selected ? { status: { family: OUTCOME_FAMILY[selected.outcome], label: w.outcome[selected.outcome] } } : {})}
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
  const w = useWords(expenseWords).whatsapp;
  if (leftOut) return <StatusStamp status="dormant" label={w.leftOutStamp} />;
  const checks = row.outcome === 'add' ? row.claim.issues.length : 0;
  return (
    <span className="flex items-center gap-1.5">
      <StatusStamp status={OUTCOME_FAMILY[row.outcome]} label={w.outcome[row.outcome]} provisional={row.outcome === 'add'} />
      {checks > 0 ? (
        <span className="text-[12px]" style={{ color: 'var(--status-attention)' }}>
          {w.toCheckCount(checks)}
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
  const t = useWords(expenseWords);
  const w = t.whatsapp;
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
      <SheetSection caption={w.sent}>
        {url ? <img src={url} alt={w.slipAlt} className="max-h-[420px] w-full object-contain" /> : null}
        {!url && demoText ? (
          <pre className="whitespace-pre-wrap p-2 font-mono text-[11px]" style={FIELD_STYLE}>
            {demoText}
          </pre>
        ) : null}
        {!url && !demoText ? <Note>{c.attachments.length > 0 ? w.photoNotInFile : w.noPhoto}</Note> : null}
        <p className="mt-2 text-[14px]" style={{ color: c.text ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
          {c.text || w.noWords}
        </p>
      </SheetSection>

      <SheetSection caption={w.read}>
        <DetailGrid>
          <Detail label={t.detail.fields.vehicle!}>{reg(c.vehicleId) ?? '–'}</Detail>
          <Detail label={w.driver}>{driverName(c.driverId) ?? w.notOnList(c.sender)}</Detail>
          <Detail label={t.detail.fields.litres!}>{c.litres ?? '–'}</Detail>
          <Detail label={t.detail.fields.amount!}>{c.amount === null ? '–' : formatINR(c.amount)}</Detail>
          <Detail label={w.perLitre}>{c.ratePerLitre ?? '–'}</Detail>
          <Detail label={w.bunk}>{c.vendor ?? '–'}</Detail>
          <Detail label={t.detail.fields.billNumber!}>{c.billNumber ?? '–'}</Detail>
          <Detail label={w.slip}>{slip ? w.slipRead : w.slipNotRead}</Detail>
        </DetailGrid>
        {c.filledFromSlip.length > 0 ? (
          <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {w.fromSlip(c.filledFromSlip.map((f) => w.slipParts[f]))}
          </p>
        ) : null}
      </SheetSection>

      {row.reason || c.issues.length > 0 ? (
        <SheetSection caption={w.toCheck}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px]" style={{ color: 'var(--text-primary)' }}>
            {row.reason ? <li>{t.reason(row.reason)}</li> : null}
            {c.issues.map((i, n) => (
              <li key={`${i.code}-${n}`}>{t.notice(i)}</li>
            ))}
          </ul>
        </SheetSection>
      ) : null}

      {row.outcome === 'add' || row.outcome === 'needs_details' ? (
        <SheetSection caption={w.fix}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {LIVE ? (
              // No fleet list on the API yet: the vehicle number is typed, and no driver is picked.
              <Labelled label={t.detail.fields.vehicle!}>
                <input
                  value={override.vehicleText ?? (c.vehicleId ? (vehicleLabel(c.vehicleId) ?? '') : (c.vehicleText ?? ''))}
                  onChange={(e) => onOverride({ vehicleText: e.target.value })}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${FIELD_CLASS} font-id`}
                  style={FIELD_STYLE}
                />
              </Labelled>
            ) : (
              <>
                <Labelled label={t.detail.fields.vehicle!}>
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
                <Labelled label={w.driver}>
                  <select
                    value={override.driverId ?? c.driverId ?? ''}
                    onChange={(e) => onOverride({ driverId: e.target.value })}
                    className={FIELD_CLASS}
                    style={FIELD_STYLE}
                  >
                    <option value="">{w.notKnown}</option>
                    {DRIVERS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Labelled>
              </>
            )}
            <Labelled label={t.detail.fields.litres!}>
              <input
                inputMode="decimal"
                value={override.litres ?? (c.litres === null ? '' : String(c.litres))}
                onChange={(e) => onOverride({ litres: e.target.value })}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              />
            </Labelled>
            <Labelled label={t.detail.fields.amountRupees!}>
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
            <Button onClick={() => onOverride({ leaveOut: !override.leaveOut })}>{override.leaveOut ? w.putBack : w.leaveOut}</Button>
          </div>
        </SheetSection>
      ) : null}
    </>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}
