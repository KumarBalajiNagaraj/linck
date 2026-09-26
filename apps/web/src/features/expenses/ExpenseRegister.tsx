import { useMemo, useState } from 'react';
import { can, formatDate, formatINRCompact } from '@linck/domain';
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
const VIEWS = ['all', ...STATUS_ORDER] as const;

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
  const rows = view === 'all' ? all : all.filter((e) => e.status === view);
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
      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={all.length}>
          All bills
        </Chip>
        {STATUS_ORDER.map((s) => (
          <Chip key={s} active={view === s} onClick={() => setView(s)} count={all.filter((e) => e.status === s).length}>
            {EXPENSE_STATUS_LABEL[s]}
          </Chip>
        ))}
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
            <EmptyState
              fact="No bills match this view."
              because="Nothing at this site is at that step of the approval chain."
              action={{ label: 'Show all bills', onClick: () => setView('all') }}
            />
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
        {selected ? <BillDetail bill={selected} /> : null}
      </SideSheet>
    </>
  );
}

function BillDetail({ bill }: { bill: ExpenseBill }) {
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
