import { useMemo } from 'react';
import {
  CUSTOMERS_MASTER,
  invoicesForSite,
  isInvoiceOverdue,
  PURCHASE_ORDERS,
  SITES,
  type Customer,
} from '@linck/mock';
import {
  AsOfStamp,
  Chip,
  DataTable,
  EmptyState,
  IdCell,
  MoneyCell,
  PageHeader,
  Section,
  Stacked,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

/**
 * The customer database.
 *
 * One row per customer the desk sells to, with the three things the
 * coordinator checks before promising a lorry on the phone: what they still
 * owe us, whether any of it is overdue, and whether an order of theirs is
 * sitting unapproved.
 */

type View = 'all' | 'overdue' | 'open_orders';
const VIEWS: readonly View[] = ['all', 'overdue', 'open_orders'];

interface CustomerRow {
  customer: Customer;
  outstanding: number;
  overdueCount: number;
  openOrders: number;
  siteName: string;
}

export function CustomerDatabase() {
  const { siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');

  const rows = useMemo<CustomerRow[]>(() => {
    const invoices = invoicesForSite(siteScope);
    return CUSTOMERS_MASTER.filter((c) => siteScope === null || c.servedFromSiteId === siteScope).map((c) => {
      const theirs = invoices.filter((i) => i.customerId === c.id && i.status !== 'draft' && i.status !== 'closed');
      return {
        customer: c,
        outstanding: theirs.reduce((s, i) => s + Number.parseFloat(i.balanceDue), 0),
        overdueCount: theirs.filter(isInvoiceOverdue).length,
        openOrders: PURCHASE_ORDERS.filter(
          (p) => p.customerId === c.id && (p.status === 'pending_approval' || p.status === 'approved' || p.status === 'part_dispatched'),
        ).length,
        siteName: SITES.find((s) => s.id === c.servedFromSiteId)?.name ?? '–',
      };
    });
  }, [siteScope]);

  const visible =
    view === 'overdue' ? rows.filter((r) => r.overdueCount > 0) : view === 'open_orders' ? rows.filter((r) => r.openOrders > 0) : rows;

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Customers"
        meta={<AsOfStamp asOf="14:42" source="sales.customers" freshness="live" />}
      />
      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={rows.length}>
          All customers
        </Chip>
        <Chip active={view === 'overdue'} onClick={() => setView('overdue')} count={rows.filter((r) => r.overdueCount > 0).length}>
          With overdue invoices
        </Chip>
        <Chip active={view === 'open_orders'} onClick={() => setView('open_orders')} count={rows.filter((r) => r.openOrders > 0).length}>
          With open orders
        </Chip>
      </div>
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={visible}
          rowKey={(r) => r.customer.id}
          rail={(r) => (r.overdueCount > 0 ? { status: 'critical' } : undefined)}
          empty={
            <EmptyState
              fact="No customers match this view."
              because="Nobody at this site is overdue or waiting on an order."
              action={{ label: 'Show all customers', onClick: () => setView('all') }}
            />
          }
        />
      </Section>
      <div className="h-10" />
    </>
  );
}

const columns: Column<CustomerRow>[] = [
  {
    key: 'name',
    header: 'Customer',
    sticky: true,
    width: 260,
    group: 'Identity',
    render: (r) => <Stacked primary={r.customer.name} secondary={r.customer.site} />,
  },
  {
    key: 'gstin',
    header: 'GSTIN',
    type: 'id',
    width: 170,
    group: 'Identity',
    render: (r) => <IdCell>{r.customer.gstin ?? 'B2C — no GSTIN'}</IdCell>,
  },
  {
    key: 'contact',
    header: 'Contact',
    group: 'Identity',
    render: (r) => <Stacked primary={r.customer.contactName} secondary={r.customer.phone} />,
  },
  { key: 'site', header: 'Served from', group: 'Identity', render: (r) => r.siteName },
  {
    key: 'terms',
    header: 'Terms',
    unit: 'days',
    type: 'num',
    width: 90,
    group: 'Credit',
    render: (r) => (r.customer.paymentTermsDays === 0 ? 'Cash' : r.customer.paymentTermsDays),
  },
  {
    key: 'limit',
    header: 'Credit limit',
    unit: '₹',
    type: 'money',
    width: 130,
    group: 'Credit',
    render: (r) => <MoneyCell value={r.customer.creditLimit} decimals={0} />,
  },
  {
    key: 'outstanding',
    header: 'Outstanding',
    unit: '₹',
    type: 'money',
    width: 130,
    group: 'Credit',
    render: (r) => <MoneyCell value={r.outstanding} decimals={0} />,
  },
  {
    key: 'overdue',
    header: 'Overdue invoices',
    type: 'num',
    width: 130,
    group: 'Credit',
    render: (r) => (
      <span className="num tabular-nums" style={{ color: r.overdueCount > 0 ? 'var(--status-critical)' : undefined }}>
        {r.overdueCount}
      </span>
    ),
  },
  { key: 'orders', header: 'Open orders', type: 'num', width: 110, group: 'Orders', render: (r) => r.openOrders },
];
