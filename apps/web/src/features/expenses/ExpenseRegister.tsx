import { useMemo, useState } from 'react';
import { availableActions, businessDate, can, formatDate, formatINRCompact, parseTypedAmount } from '@linck/domain';
import {
  DRIVERS,
  EXPENSE_KIND_LABEL,
  EXPENSE_STATUS_FAMILY,
  EXPENSE_STATUS_LABEL,
  expensesForSite,
  NOW,
  VEHICLES,
  type ExpenseBill,
} from '@linck/mock';
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
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { BatchBar, BillHistory, ChainActions, STEP_ACTION } from './ApprovalChain.js';
import { actorFor, useExpenses } from './expenseStore.js';
import { UploadBillSheet } from './UploadBillSheet.js';

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
const DESK_COPY: Record<ExpenseBill['desk'], { eyebrow: string; upload: string }> = {
  fleet: { eyebrow: 'Fleet', upload: 'fleet.expense.upload' },
  stores: { eyebrow: 'Stores', upload: 'stores.expense.upload' },
};

export function ExpenseRegister({ desk }: { desk: ExpenseBill['desk'] | null }) {
  const { persona, siteScope, density } = useApp();
  const bills = useExpenses((s) => s.bills);
  const [view, setView] = useViewParam(VIEWS, 'all');
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mayUpload = desk !== null && can(persona.grants, DESK_COPY[desk].upload, { siteId: siteScope });
  const actor = actorFor(persona);
  // A bill asks for action only from whoever may take its next step; to
  // everyone else it is in flight, with the ball in another court.
  const isMine = (e: ExpenseBill) => {
    const step = STEP_ACTION[e.status];
    return step !== undefined && availableActions(e, actor).some((o) => o.action === step && o.allowed);
  };
  const family = (e: ExpenseBill): StatusFamily =>
    isMine(e) ? 'attention' : e.status === 'submitted' ? 'pending' : EXPENSE_STATUS_FAMILY[e.status];
  const columns = useMemo(() => columnsFor(desk, family), [desk, persona]);

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
        eyebrow={desk ? DESK_COPY[desk].eyebrow : 'Finance'}
        title={desk ? 'Expenses' : 'Expense bills'}
        actions={
          mayUpload ? (
            <Button variant="primary" onClick={() => setUploading(true)}>
              Upload bill
            </Button>
          ) : undefined
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source="expense_bills" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {awaiting.length} bills worth {formatINRCompact(awaitingValue)} wait on you
            </span>
          </span>
        }
      />
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={all.length}>
          All bills
        </Chip>
        {STATUS_ORDER.map((s) => (
          <Chip key={s} active={view === s} onClick={() => setView(s)} count={all.filter((e) => e.status === s).length}>
            {EXPENSE_STATUS_LABEL[s]}
          </Chip>
        ))}
        <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-strong)' }} />
        <Chip active={view === 'corrected'} onClick={() => setView('corrected')} count={all.filter((e) => e.provenance === 'overridden').length}>
          Capture corrected by hand
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
            all.length === 0 ? (
              <EmptyState fact="No expense bills at this site." because="Nothing has been submitted here yet." />
            ) : (
              <EmptyState
                fact="No bills match this view."
                because="Nothing at this site is at that step of the approval chain."
                action={{ label: 'Show all bills', onClick: () => setView('all') }}
              />
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
        title={selected ? `${EXPENSE_KIND_LABEL[selected.kind]} · ${selected.vendor}` : ''}
        identifier={selected?.billNumber}
        {...(selected ? { status: { family: family(selected), label: EXPENSE_STATUS_LABEL[selected.status] } } : {})}
      >
        {selected ? <BillDetail key={selected.id} bill={selected} mayCorrect={selected.status === 'submitted' && (mayUpload || isMine(selected))} /> : null}
      </SideSheet>
    </>
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
  const update = useExpenses((s) => s.update);
  const [editing, setEditing] = useState(false);
  const [unviewable, setUnviewable] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
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
    const today = businessDate(NOW);
    const why =
      amount === null || amount <= 0
        ? 'Type the amount as printed, such as 12,500.00.'
        : litres !== null && litres <= 0
          ? 'Type the litres as printed, such as 120.45.'
          : draft.litres.trim() !== '' && litres === null
            ? 'Type the litres as printed, such as 120.45.'
            : !/^\d{4}-\d{2}-\d{2}$/.test(draft.billDate)
              ? 'Pick the date printed on the bill.'
              : draft.billDate > today
                ? 'A bill cannot be dated after today.'
                : !draft.billNumber.trim() || !draft.vendor.trim()
                  ? 'The bill number and vendor cannot be blank.'
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
            const differs =
              f.captured !== null &&
              (f.key === 'amount' || f.key === 'litres'
                ? parseTypedAmount(value, 3) !== parseTypedAmount(f.captured, 3)
                : value.trim().toUpperCase() !== f.captured.trim().toUpperCase());
            return { ...f, value, overridden: differs, overriddenBy: differs ? persona.name : null };
          }),
        }
      : null;
    update(bill.id, {
      billNumber: next.billNumber.trim(),
      billDate: new Date(`${next.billDate}T00:00:00+05:30`).toISOString(),
      vendor: next.vendor.trim(),
      litres,
      amount: next.amount,
      capture,
      provenance: capture ? (capture.fields.some((f) => f.overridden) ? 'overridden' : 'confirmed') : bill.provenance,
    });
    setEditing(false);
  };

  return (
    <>
      <ChainActions bill={bill} />
      <SheetSection caption="The scan">
        {bill.attachment ? (
          bill.attachment.mimeType === 'application/pdf' || unviewable ? (
            <a href={bill.attachment.url} target="_blank" rel="noreferrer" className="text-[13px]" style={{ color: 'var(--brand)' }}>
              Open {bill.attachment.fileName} ({bill.attachment.sizeKb} KB)
            </a>
          ) : (
            <img
              src={bill.attachment.url}
              alt={`Scan of bill ${bill.billNumber}`}
              className="max-h-[420px] w-full object-contain"
              onError={() => setUnviewable(true)}
            />
          )
        ) : (
          <Note>No scan on file for this bill. It was keyed before uploads existed, or came in through WhatsApp.</Note>
        )}
      </SheetSection>
      {bill.capture ? (
        <SheetSection caption="Captured from the scan">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-strong)', color: 'var(--text-tertiary)' }}>
                <th className="py-1 pr-3 text-left font-medium">Field</th>
                <th className="py-1 pr-3 text-left font-medium">Scan read</th>
                <th className="py-1 pr-3 text-left font-medium">Ledger holds</th>
              </tr>
            </thead>
            <tbody>
              {bill.capture.fields.map((f) => (
                <tr key={f.key} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td className="py-1.5 pr-3" style={{ color: 'var(--text-secondary)' }}>
                    {f.label}
                  </td>
                  <td className="py-1.5 pr-3">
                    {f.captured === null ? (
                      <span style={{ color: 'var(--text-tertiary)' }}>not read</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {f.confidence ? <ConfidenceMeter level={f.confidence} /> : null}
                        <span className="font-id">{f.captured}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="font-id" style={{ color: f.overridden ? 'var(--status-attention)' : 'var(--text-primary)' }}>
                      {f.value || '–'}
                    </span>
                    {f.overridden ? (
                      <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        corrected by {f.overriddenBy}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Read by {bill.capture.engine}
          </p>
        </SheetSection>
      ) : null}
      {editing ? (
        <SheetSection caption="Correct this bill">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                ['billNumber', 'Bill number', 'text'],
                ['billDate', 'Bill date', 'date'],
                ['vendor', 'Vendor', 'text'],
                ...(bill.kind === 'diesel' ? [['litres', 'Litres', 'text']] : []),
                ['amount', 'Amount ₹', 'text'],
              ] as [EditableKey, string, string][]
            ).map(([key, label, type]) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
                  {label}
                </span>
                <input
                  type={type}
                  {...(type === 'date' ? { max: businessDate(NOW) } : {})}
                  value={draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  className="h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[13px]"
                  style={{ background: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'inset 0 0 0 1px var(--border-strong)', borderRadius: 'var(--r-1)' }}
                />
              </label>
            ))}
          </div>
          {problem ? (
            <p className="relative mt-2 pl-3 text-[12px]" style={{ color: 'var(--status-critical)' }}>
              <Rail status="critical" />
              {problem}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={saveCorrection}>
              Save correction
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </SheetSection>
      ) : mayCorrect ? (
        <div className="pb-2">
          <Button onClick={() => setEditing(true)}>Correct captured values</Button>
        </div>
      ) : null}
      <SheetSection caption="Bill">
        <DetailGrid>
          <Detail label="Bill number">
            <IdCell>{bill.billNumber}</IdCell>
          </Detail>
          <Detail label="Bill date">{formatDate(bill.billDate)}</Detail>
          <Detail label="Vendor">{bill.vendor}</Detail>
          <Detail label="What for">{bill.description}</Detail>
          {bill.desk === 'fleet' ? <Detail label="Vehicle">{VEHICLES.find((v) => v.id === bill.vehicleId)?.displayReg ?? '–'}</Detail> : null}
          {bill.litres !== null ? (
            <Detail label="Litres">
              <QuantityCell value={bill.litres} decimals={1} uom="L" />
            </Detail>
          ) : null}
          <Detail label="Amount">
            <MoneyCell value={bill.amount} />
          </Detail>
          <Detail label="Submitted by">{bill.submittedBy}</Detail>
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
function columnsFor(desk: ExpenseBill['desk'] | null, family: (e: ExpenseBill) => StatusFamily): Column<ExpenseBill>[] {
  const all: (Column<ExpenseBill> & { fleetOnly?: true })[] = [
    {
      key: 'bill',
      header: 'Bill',
      type: 'id',
      sticky: true,
      width: 160,
      group: 'Bill',
      // IST calendar date. A bill dated 06-08 is stored as IST midnight, which
      // is 18:30 on 05-08 in UTC — slicing the ISO string shows the wrong day.
      render: (e) => <Stacked primary={<IdCell>{e.billNumber}</IdCell>} secondary={formatDate(e.billDate)} />,
    },
    {
      key: 'status',
      header: 'Status',
      type: 'status',
      width: 200,
      group: 'Bill',
      render: (e) => <StatusStamp status={family(e)} label={EXPENSE_STATUS_LABEL[e.status]} />,
    },
    {
      key: 'kind',
      header: 'Type',
      width: 90,
      group: 'Bill',
      render: (e) => EXPENSE_KIND_LABEL[e.kind],
    },
    { key: 'vendor', header: 'Vendor', group: 'Bill', render: (e) => <Stacked primary={e.vendor} secondary={e.description} /> },
    {
      key: 'scan',
      header: 'Scan',
      width: 70,
      group: 'Bill',
      // A word, not a mark: the square glyphs belong to status.
      render: (e) =>
        e.attachment ? (
          <span title={e.attachment.fileName} className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {e.attachment.mimeType === 'application/pdf' ? 'PDF' : 'Photo'}
          </span>
        ) : null,
    },
    {
      key: 'vehicle',
      header: 'Vehicle',
      type: 'id',
      width: 140,
      group: 'Against',
      fleetOnly: true,
      render: (e) => {
        const reg = VEHICLES.find((v) => v.id === e.vehicleId)?.displayReg;
        return reg ? <IdCell>{reg}</IdCell> : null;
      },
    },
    {
      key: 'driver',
      header: 'Driver',
      group: 'Against',
      fleetOnly: true,
      render: (e) => DRIVERS.find((d) => d.id === e.driverId)?.name ?? null,
    },
    {
      key: 'litres',
      header: 'Litres',
      unit: 'L',
      type: 'num',
      width: 90,
      group: 'Amount',
      fleetOnly: true,
      render: (e) => (e.litres === null ? null : <QuantityCell value={e.litres} decimals={1} />),
    },
    {
      key: 'amount',
      header: 'Amount',
      unit: '₹',
      type: 'money',
      width: 120,
      group: 'Amount',
      render: (e) => <MoneyCell value={e.amount} />,
    },
    { key: 'by', header: 'Submitted by', group: 'Amount', render: (e) => e.submittedBy },
  ];
  return all.filter((c) => desk !== 'stores' || !c.fleetOnly).map(({ fleetOnly: _fleetOnly, ...c }) => c);
}
