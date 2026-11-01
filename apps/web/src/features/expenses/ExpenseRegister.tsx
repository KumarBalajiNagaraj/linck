import { useMemo, useState } from 'react';
import { availableActions, businessDate, can, formatDate, parseTypedAmount } from '@linck/domain';
import { EXPENSE_STATUS_FAMILY, expensesForSite, type ExpenseBill } from '@linck/mock';
import type { StatusFamily } from '@linck/tokens';
import {
  AsOfStamp,
  Button,
  Chip,
  ConfidenceMeter,
  DataTable,
  Detail,
  DetailGrid,
  EmptyState,
  IdCell,
  MoneyCell,
  Note,
  PageHeader,
  QuantityCell,
  Rail,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  type Column,
} from '@linck/ui';
import { useLang, type Lang } from '../../i18n/lang.js';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords, wordsNow } from '../../i18n/words.js';
import { useInrCompact } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { BatchBar, BillHistory, ChainActions, STEP_ACTION, useProblemWords } from './ApprovalChain.js';
import { driverLabel, now, useBills, useCorrectBill, vehicleLabel, type BillList } from './bills.js';
import type { BillProblem } from './expenseApi.js';
import { actorFor } from './expenseStore.js';
import { UploadBillSheet } from './UploadBillSheet.js';
import { expenseWords } from './words.js';

/**
 * The expenses database — diesel bills, repair bills, tyres, spares, tolls.
 *
 * One screen, three views: the fleet manager's bills under Fleet, the store
 * manager's under Stores, and both desks together under Finance, where the
 * director and accounts work. Every bill walks one fixed chain (LIN-14): its
 * own desk validates it, the director approves it, accounts passes it and
 * records the payment. The chips are that chain, in order; picking one step
 * offers to do that step for every bill in it at once.
 */

const STATUS_ORDER: ExpenseBill['status'][] = ['submitted', 'validated', 'approved', 'passed', 'paid', 'rejected', 'deleted'];
const VIEWS = ['all', ...STATUS_ORDER, 'corrected'] as const;

/** Each desk's upload key. Finance sees both desks and uploads to neither. */
const UPLOAD_KEY: Record<ExpenseBill['desk'], string> = {
  fleet: 'fleet.expense.upload',
  stores: 'stores.expense.upload',
};

export function ExpenseRegister({ desk }: { desk: ExpenseBill['desk'] | null }) {
  const inr = useInrCompact();
  const { persona, siteScope, density } = useApp();
  const list = useBills();
  const { bills } = list;
  const [view, setView] = useViewParam(VIEWS, 'all');
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lang = useLang((s) => s.lang);
  const t = useWords(expenseWords);
  const status = useWords(statusWords);

  const mayUpload = desk !== null && can(persona.grants, UPLOAD_KEY[desk], { siteId: siteScope });
  const actor = actorFor(persona);
  // A bill asks for action only from whoever may take its next step; to
  // everyone else it is in flight, with the ball in another court.
  const isMine = (e: ExpenseBill) => {
    const step = STEP_ACTION[e.status];
    return step !== undefined && availableActions(e, actor).some((o) => o.action === step && o.allowed);
  };
  const family = (e: ExpenseBill): StatusFamily =>
    isMine(e) ? 'attention' : e.status === 'submitted' ? 'pending' : EXPENSE_STATUS_FAMILY[e.status];
  const columns = useMemo(() => columnsFor(desk, family, lang), [desk, persona, lang]);

  const all = useMemo(
    () => [...expensesForSite(siteScope, desk, bills)].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)),
    [siteScope, desk, bills],
  );
  const rows =
    view === 'all' ? all : view === 'corrected' ? all.filter((e) => e.provenance === 'overridden') : all.filter((e) => e.status === view);
  const awaiting = all.filter(isMine);
  const awaitingValue = awaiting.reduce((s, e) => s + Math.round(Number.parseFloat(e.amount) * 100), 0) / 100;
  const selected = selectedId ? (all.find((e) => e.id === selectedId) ?? null) : null;

  return (
    <>
      <PageHeader
        eyebrow={desk ? t.desk[desk] : t.desk.finance}
        title={desk ? t.register.title : t.register.financeTitle}
        actions={
          mayUpload ? (
            <Button variant="primary" onClick={() => setUploading(true)}>
              {t.register.addBill}
            </Button>
          ) : undefined
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf={list.asOf} source="expense_bills" freshness="live" />
            <span className="text-[14px]" style={{ color: awaiting.length > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              {t.register.waitingForYou(awaiting.length, inr(awaitingValue))}
            </span>
          </span>
        }
      />
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={all.length}>
          {t.register.all}
        </Chip>
        {STATUS_ORDER.map((s) => (
          <Chip key={s} active={view === s} onClick={() => setView(s)} count={all.filter((e) => e.status === s).length}>
            {status.expense[s]}
          </Chip>
        ))}
        <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-strong)' }} />
        <Chip active={view === 'corrected'} onClick={() => setView('corrected')} count={all.filter((e) => e.provenance === 'overridden').length}>
          {t.register.corrected}
        </Chip>
      </div>
      <BatchBar key={`${view}-${persona.key}`} bills={rows} status={STATUS_ORDER.includes(view as ExpenseBill['status']) ? (view as ExpenseBill['status']) : null} />
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(e) => e.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(e) => setSelectedId(e.id)}
          isDormant={(e) => e.status === 'rejected' || e.status === 'deleted'}
          rail={(e) => ({ status: family(e), provenance: e.provenance })}
          empty={
            list.state !== 'ready' ? (
              <BillsNotHere list={list} />
            ) : all.length === 0 ? (
              <EmptyState fact={t.register.noBills} />
            ) : (
              <EmptyState fact={t.register.noneInList} action={{ label: t.register.showAll, onClick: () => setView('all') }} />
            )
          }
        />
      </Section>
      <div className="h-10" />

      {desk ? <UploadBillSheet open={uploading} onClose={() => setUploading(false)} desk={desk} /> : null}

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        // The vendor reads as a title; the bill number is an identifier, set in
        // the mono face where 0 and O cannot be confused against the paper.
        title={selected ? `${status.expenseKind[selected.kind]} · ${selected.vendor}` : ''}
        identifier={selected?.billNumber}
        {...(selected ? { status: { family: family(selected), label: status.expense[selected.status] } } : {})}
      >
        {selected ? <BillDetail key={selected.id} bill={selected} mayCorrect={selected.status === 'submitted' && (mayUpload || isMine(selected))} /> : null}
      </SideSheet>
    </>
  );
}

/** Live only: the bills are on their way, or could not be read. */
export function BillsNotHere({ list }: { list: BillList }) {
  const t = useWords(expenseWords);
  const say = useProblemWords();
  if (list.state === 'loading') return <EmptyState fact={t.live.loading} />;
  return (
    <EmptyState
      fact={t.live.failed}
      {...(list.problem ? { because: say(list.problem) } : {})}
      action={{ label: t.live.retry, onClick: list.retry }}
    />
  );
}

type EditableKey = 'billNumber' | 'billDate' | 'vendor' | 'litres' | 'amount';

/**
 * MANUAL OVERRIDE. While a bill is still awaiting validation, whoever keyed
 * it may correct what capture read. The captured value is never overwritten:
 * it stays on the capture record beside the correction and who made it.
 */
function BillDetail({ bill, mayCorrect }: { bill: ExpenseBill; mayCorrect: boolean }) {
  const { persona } = useApp();
  const correct = useCorrectBill();
  const t = useWords(expenseWords);
  const d = t.detail;
  const status = useWords(statusWords);
  const say = useProblemWords();
  const [editing, setEditing] = useState(false);
  const [unviewable, setUnviewable] = useState(false);
  const [problem, setProblem] = useState<keyof typeof d.errors | null>(null);
  /** Live: the API would not take the correction — the bill was signed meanwhile, say. */
  const [refused, setRefused] = useState<BillProblem | null>(null);
  const [draft, setDraft] = useState<Record<EditableKey, string>>(() => ({
    billNumber: bill.billNumber,
    // The IST calendar date the bill carries, not the UTC date of IST midnight.
    billDate: businessDate(bill.billDate),
    vendor: bill.vendor,
    litres: bill.litres === null ? '' : String(bill.litres),
    amount: bill.amount,
  }));

  const saveCorrection = () => {
    // Read as strictly as at upload: "12,500" is twelve and a half thousand,
    // and a figure that cannot be read is refused, not rounded to a guess.
    const amount = parseTypedAmount(draft.amount);
    const litres = draft.litres.trim() === '' ? null : parseTypedAmount(draft.litres, 3);
    const today = businessDate(now());
    const why: keyof typeof d.errors | null =
      amount === null || amount <= 0
        ? 'amount'
        : litres !== null && litres <= 0
          ? 'litres'
          : draft.litres.trim() !== '' && litres === null
            ? 'litres'
            : bill.kind === 'diesel' && litres === null
              ? 'dieselLitres'
              : !/^\d{4}-\d{2}-\d{2}$/.test(draft.billDate)
                ? 'date'
                : draft.billDate > today
                  ? 'futureDate'
                  : !draft.billNumber.trim() || !draft.vendor.trim()
                    ? 'blank'
                    : null;
    setProblem(why);
    if (why || amount === null) return;
    const next: Record<EditableKey, string> = { ...draft, amount: amount.toFixed(2), litres: litres === null ? '' : String(litres) };
    const capture = bill.capture
      ? {
          ...bill.capture,
          fields: bill.capture.fields.map((f) => {
            if (!(f.key in next)) return f;
            const value = next[f.key as EditableKey];
            const same = (a: string, b: string) =>
              f.key === 'amount' || f.key === 'litres' ? parseTypedAmount(a, 3) === parseTypedAmount(b, 3) : a.trim().toUpperCase() === b.trim().toUpperCase();
            const differs = f.captured !== null && !same(value, f.captured);
            // A correction is credited to whoever made it. Saving a fix to the
            // vendor does not make this person the author of someone else's
            // earlier fix to the amount.
            const by = differs ? (f.overriddenBy && same(value, f.value) ? f.overriddenBy : persona.name) : null;
            return { ...f, value, overridden: differs, overriddenBy: by };
          }),
        }
      : null;
    const patch: Partial<ExpenseBill> = {
      billNumber: next.billNumber.trim(),
      billDate: new Date(`${next.billDate}T00:00:00+05:30`).toISOString(),
      vendor: next.vendor.trim(),
      litres,
      amount: next.amount,
      capture,
      provenance: capture ? (capture.fields.some((f) => f.overridden) ? 'overridden' : 'confirmed') : bill.provenance,
    };
    setRefused(null);
    void correct.run({ bill, patch }).then((no) => {
      setRefused(no);
      if (!no) setEditing(false);
    });
  };

  return (
    <>
      <ChainActions bill={bill} />
      <SheetSection caption={d.photo}>
        {bill.attachment ? (
          bill.attachment.mimeType === 'application/pdf' || unviewable ? (
            <a href={bill.attachment.url} target="_blank" rel="noreferrer" className="text-[14px]" style={{ color: 'var(--brand)' }}>
              {d.openFile(bill.attachment.fileName, bill.attachment.sizeKb)}
            </a>
          ) : (
            <img
              src={bill.attachment.url}
              alt={d.photoAlt(bill.billNumber)}
              className="max-h-[420px] w-full object-contain"
              onError={() => setUnviewable(true)}
            />
          )
        ) : (
          <Note>{d.noPhoto}</Note>
        )}
      </SheetSection>
      {bill.capture ? (
        <SheetSection caption={d.readFromPhoto}>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-strong)', color: 'var(--text-tertiary)' }}>
                <th className="py-1 pr-3 text-left font-medium">{d.field}</th>
                <th className="py-1 pr-3 text-left font-medium">{d.photoSays}</th>
                <th className="py-1 pr-3 text-left font-medium">{d.saved}</th>
              </tr>
            </thead>
            <tbody>
              {bill.capture.fields.map((f) => (
                <tr key={f.key} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td className="py-1.5 pr-3" style={{ color: 'var(--text-secondary)' }}>
                    {d.fields[f.key] ?? f.label}
                  </td>
                  <td className="py-1.5 pr-3">
                    {f.captured === null ? (
                      <span style={{ color: 'var(--text-tertiary)' }}>{d.notRead}</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {f.confidence ? <ConfidenceMeter level={f.confidence} /> : null}
                        <span className="font-id">{f.key === 'kind' ? (status.expenseKind[f.captured as ExpenseBill['kind']] ?? f.captured) : f.captured}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="font-id" style={{ color: f.overridden ? 'var(--status-attention)' : 'var(--text-primary)' }}>
                      {(f.key === 'kind' ? status.expenseKind[f.value as ExpenseBill['kind']] : f.value) || '–'}
                    </span>
                    {f.overridden ? (
                      <span className="block text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                        {d.correctedBy(f.overriddenBy ?? '')}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }} title={bill.capture.engine}>
            {d.readBy}
          </p>
        </SheetSection>
      ) : null}
      {editing ? (
        <SheetSection caption={d.correctTitle}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                ['billNumber', d.fields.billNumber!, 'text'],
                ['billDate', d.fields.billDate!, 'date'],
                ['vendor', d.fields.vendor!, 'text'],
                ...(bill.kind === 'diesel' ? [['litres', d.fields.litres!, 'text']] : []),
                ['amount', d.fields.amountRupees!, 'text'],
              ] as [EditableKey, string, string][]
            ).map(([key, label, type]) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  {label}
                </span>
                <input
                  type={type}
                  {...(type === 'date' ? { max: businessDate(now()) } : {})}
                  value={draft[key]}
                  onChange={(e) => setDraft((was) => ({ ...was, [key]: e.target.value }))}
                  className="h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[38px] [@media(hover:hover)]:text-[14px]"
                  style={{ background: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'inset 0 0 0 1px var(--border-strong)', borderRadius: 'var(--r-1)' }}
                />
              </label>
            ))}
          </div>
          {problem ? (
            <p className="relative mt-2 pl-3 text-[14px]" style={{ color: 'var(--status-critical)' }}>
              <Rail status="critical" />
              {d.errors[problem]}
            </p>
          ) : refused ? (
            <p className="relative mt-2 pl-3 text-[14px]" style={{ color: 'var(--status-critical)' }}>
              <Rail status="critical" />
              {say(refused)}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={saveCorrection} disabled={correct.busy}>
              {correct.busy ? t.live.saving : d.save}
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setProblem(null);
                setRefused(null);
              }}
            >
              {d.cancel}
            </Button>
          </div>
        </SheetSection>
      ) : mayCorrect ? (
        <div className="pb-2">
          <Button onClick={() => setEditing(true)}>{d.correct}</Button>
        </div>
      ) : null}
      <SheetSection caption={d.bill}>
        <DetailGrid>
          <Detail label={d.fields.billNumber!}>
            <IdCell>{bill.billNumber}</IdCell>
          </Detail>
          <Detail label={d.fields.billDate!}>{formatDate(bill.billDate)}</Detail>
          <Detail label={d.fields.vendor!}>{bill.vendor}</Detail>
          <Detail label={d.fields.whatFor!}>{bill.description || status.expenseKind[bill.kind]}</Detail>
          {bill.desk === 'fleet' ? <Detail label={d.fields.vehicle!}>{vehicleLabel(bill.vehicleId) ?? '–'}</Detail> : null}
          {bill.litres !== null ? (
            <Detail label={d.fields.litres!}>
              <QuantityCell value={bill.litres} decimals={1} uom="L" />
            </Detail>
          ) : null}
          <Detail label={d.fields.amount!}>
            <MoneyCell value={bill.amount} />
          </Detail>
          <Detail label={d.fields.addedBy!}>{bill.submittedBy}</Detail>
        </DetailGrid>
      </SheetSection>
      <BillHistory bill={bill} />
    </>
  );
}

/**
 * The register's columns. A stores bill is against no vehicle and no driver
 * and is never counted in litres, so its register does not carry those
 * columns — a column of dashes on every row is noise, not information.
 */
function columnsFor(desk: ExpenseBill['desk'] | null, family: (e: ExpenseBill) => StatusFamily, lang: Lang): Column<ExpenseBill>[] {
  const c = wordsNow(expenseWords, lang).register.columns;
  const status = wordsNow(statusWords, lang);
  const all: (Column<ExpenseBill> & { fleetOnly?: true })[] = [
    {
      key: 'bill',
      header: c.bill,
      type: 'id',
      sticky: true,
      width: 160,
      group: c.groupBill,
      // IST calendar date. A bill dated 06-08 is stored as IST midnight, which
      // is 18:30 on 05-08 in UTC — slicing the ISO string shows the wrong day.
      render: (e) => <Stacked primary={<IdCell>{e.billNumber}</IdCell>} secondary={formatDate(e.billDate)} />,
    },
    {
      key: 'status',
      header: c.status,
      type: 'status',
      width: 200,
      group: c.groupBill,
      render: (e) => <StatusStamp status={family(e)} label={status.expense[e.status]} />,
    },
    {
      key: 'kind',
      header: c.type,
      width: 90,
      group: c.groupBill,
      render: (e) => status.expenseKind[e.kind],
    },
    { key: 'vendor', header: c.shop, group: c.groupBill, render: (e) => <Stacked primary={e.vendor} secondary={e.description || undefined} /> },
    {
      key: 'scan',
      header: c.photo,
      width: 80,
      group: c.groupBill,
      // A word, not a mark: the square glyphs belong to status.
      render: (e) =>
        e.attachment ? (
          <span title={e.attachment.fileName} className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {e.attachment.mimeType === 'application/pdf' ? c.pdf : c.photo}
          </span>
        ) : null,
    },
    {
      key: 'vehicle',
      header: c.vehicle,
      type: 'id',
      width: 140,
      group: c.groupFor,
      fleetOnly: true,
      render: (e) => {
        const reg = vehicleLabel(e.vehicleId);
        return reg ? <IdCell>{reg}</IdCell> : null;
      },
    },
    {
      key: 'driver',
      header: c.driver,
      group: c.groupFor,
      fleetOnly: true,
      render: (e) => driverLabel(e.driverId),
    },
    {
      key: 'litres',
      header: c.litres,
      unit: 'L',
      type: 'num',
      width: 90,
      group: c.groupAmount,
      fleetOnly: true,
      render: (e) => (e.litres === null ? null : <QuantityCell value={e.litres} decimals={1} />),
    },
    {
      key: 'amount',
      header: c.amount,
      unit: '₹',
      type: 'money',
      width: 120,
      group: c.groupAmount,
      render: (e) => <MoneyCell value={e.amount} />,
    },
    { key: 'by', header: c.addedBy, group: c.groupAmount, render: (e) => e.submittedBy },
  ];
  return all.filter((c) => desk !== 'stores' || !c.fleetOnly).map(({ fleetOnly: _fleetOnly, ...c }) => c);
}
