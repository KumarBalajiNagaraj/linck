import { useMemo, useState } from 'react';
import { businessDate, can, formatDate, formatINRCompact } from '@linck/domain';
import {
  DRIVERS,
  EXPENSE_KIND_LABEL,
  EXPENSE_STATUS_FAMILY,
  EXPENSE_STATUS_LABEL,
  expensesForSite,
  VEHICLES,
  type ExpenseBill,
} from '@linck/mock';
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
import { UploadBillSheet } from './UploadBillSheet.js';

/**
 * The expenses database — diesel bills, repair bills, tyres, spares, tolls.
 *
 * One screen, two desks: the fleet manager's bills under Fleet and the store
 * manager's under Stores. Every bill walks one fixed chain: its own desk
 * validates it, the director approves it, accounts pays it. The chips are that
 * chain, in order.
 */

const STATUS_ORDER: ExpenseBill['status'][] = ['submitted', 'validated', 'approved', 'paid', 'rejected'];
const VIEWS = ['all', ...STATUS_ORDER, 'corrected'] as const;

const DESK_COPY: Record<ExpenseBill['desk'], { eyebrow: string; upload: string }> = {
  fleet: { eyebrow: 'Fleet', upload: 'fleet.expense.upload' },
  stores: { eyebrow: 'Stores', upload: 'stores.expense.upload' },
};

export function ExpenseRegister({ desk }: { desk: ExpenseBill['desk'] }) {
  const { persona, siteScope, density } = useApp();
  const bills = useExpenses((s) => s.bills);
  const [view, setView] = useViewParam(VIEWS, 'all');
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mayUpload = can(persona.grants, DESK_COPY[desk].upload, { siteId: siteScope });

  const all = useMemo(
    () => [...expensesForSite(siteScope, desk, bills)].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)),
    [siteScope, desk, bills],
  );
  const rows =
    view === 'all' ? all : view === 'corrected' ? all.filter((e) => e.provenance === 'overridden') : all.filter((e) => e.status === view);
  const awaiting = all.filter((e) => e.status === 'submitted');
  const awaitingValue = awaiting.reduce((s, e) => s + Number.parseFloat(e.amount), 0);
  const selected = selectedId ? (all.find((e) => e.id === selectedId) ?? null) : null;

  return (
    <>
      <PageHeader
        eyebrow={DESK_COPY[desk].eyebrow}
        title="Expenses"
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
              {awaiting.length} bills worth {formatINRCompact(awaitingValue)} waiting to be validated
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
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(e) => e.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(e) => setSelectedId(e.id)}
          isDormant={(e) => e.status === 'rejected'}
          rail={(e) => ({ status: EXPENSE_STATUS_FAMILY[e.status], provenance: e.provenance })}
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

      <UploadBillSheet open={uploading} onClose={() => setUploading(false)} desk={desk} />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        title={selected?.billNumber ?? ''}
        identifier={selected ? `${EXPENSE_KIND_LABEL[selected.kind]} · ${selected.vendor}` : undefined}
        {...(selected
          ? { status: { family: EXPENSE_STATUS_FAMILY[selected.status], label: EXPENSE_STATUS_LABEL[selected.status] } }
          : {})}
      >
        {selected ? <BillDetail key={selected.id} bill={selected} mayCorrect={mayUpload && selected.status === 'submitted'} /> : null}
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
  const [draft, setDraft] = useState<Record<EditableKey, string>>(() => ({
    billNumber: bill.billNumber,
    // The IST calendar date the bill carries, not the UTC date of IST midnight.
    billDate: businessDate(bill.billDate),
    vendor: bill.vendor,
    litres: bill.litres === null ? '' : String(bill.litres),
    amount: bill.amount,
  }));

  const saveCorrection = () => {
    const amount = Number.parseFloat(draft.amount);
    const litres = draft.litres.trim() === '' ? null : Number.parseFloat(draft.litres);
    if (!Number.isFinite(amount) || amount <= 0 || (litres !== null && !Number.isFinite(litres))) return;
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
                ? Number.parseFloat(value) !== Number.parseFloat(f.captured)
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
      <SheetSection caption="The scan">
        {bill.attachment ? (
          bill.attachment.mimeType === 'application/pdf' ? (
            <a href={bill.attachment.url} target="_blank" rel="noreferrer" className="text-[13px]" style={{ color: 'var(--brand)' }}>
              Open {bill.attachment.fileName} ({bill.attachment.sizeKb} KB)
            </a>
          ) : (
            <img src={bill.attachment.url} alt={`Scan of bill ${bill.billNumber}`} className="max-h-[420px] w-full object-contain" />
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
                  value={draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  className="h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[13px]"
                  style={{ background: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'inset 0 0 0 1px var(--border-strong)', borderRadius: 'var(--r-1)' }}
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={saveCorrection}>
              Save correction
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
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
          <Detail label="Vehicle">{VEHICLES.find((v) => v.id === bill.vehicleId)?.displayReg ?? '–'}</Detail>
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
    </>
  );
}

const columns: Column<ExpenseBill>[] = [
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
    render: (e) => <StatusStamp status={EXPENSE_STATUS_FAMILY[e.status]} label={EXPENSE_STATUS_LABEL[e.status]} />,
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
    render: (e) =>
      e.attachment ? (
        <span title={e.attachment.fileName} style={{ color: 'var(--text-secondary)' }}>
          ▣
        </span>
      ) : null,
  },
  {
    key: 'vehicle',
    header: 'Vehicle',
    type: 'id',
    width: 140,
    group: 'Against',
    render: (e) => <IdCell>{VEHICLES.find((v) => v.id === e.vehicleId)?.displayReg ?? null}</IdCell>,
  },
  {
    key: 'driver',
    header: 'Driver',
    group: 'Against',
    render: (e) => DRIVERS.find((d) => d.id === e.driverId)?.name ?? null,
  },
  {
    key: 'litres',
    header: 'Litres',
    unit: 'L',
    type: 'num',
    width: 90,
    group: 'Amount',
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
