import { useMemo } from 'react';
import { formatINRCompact } from '@linck/domain';
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
  Chip,
  DataTable,
  EmptyState,
  IdCell,
  MoneyCell,
  PageHeader,
  QuantityCell,
  Section,
  Stacked,
  StatusStamp,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

/**
 * The expenses database — diesel bills, repair bills, tyres, spares, tolls.
 *
 * Every bill walks one fixed chain: the fleet manager validates it, the
 * director approves it, accounts pays it. The chips are that chain, in order,
 * so the fleet manager's own queue is always the first one after "all".
 */

const STATUS_ORDER: ExpenseBill['status'][] = ['submitted', 'validated', 'approved', 'paid', 'rejected'];
const VIEWS = ['all', ...STATUS_ORDER] as const;

export function ExpenseRegister() {
  const { siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');

  const all = useMemo(
    () => [...expensesForSite(siteScope)].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)),
    [siteScope],
  );
  const rows = view === 'all' ? all : all.filter((e) => e.status === view);
  const awaiting = all.filter((e) => e.status === 'submitted');
  const awaitingValue = awaiting.reduce((s, e) => s + Number.parseFloat(e.amount), 0);

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Expenses"
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source="fleet.expense_bills" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {awaiting.length} bills worth {formatINRCompact(awaitingValue)} waiting on the fleet manager
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
    render: (e) => <Stacked primary={<IdCell>{e.billNumber}</IdCell>} secondary={e.billDate.slice(0, 10)} />,
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
