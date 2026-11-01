import { useMemo } from 'react';
import {
  CUSTOMERS_MASTER,
  invoicesForSite,
  isInvoiceOverdue,
  purchaseOrdersForSite,
  SITES,
  tripsForSite,
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
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { customerWords, salesWords, type CustomerText, type SalesText } from './words.js';

/**
 * The customer database.
 *
 * One row per customer the desk sells to, with the three things the
 * coordinator checks before promising a lorry on the phone: what they still
 * owe us, whether any of it is overdue, and whether an order of theirs is
 * sitting unapproved.
 *
 * SCOPED BY ACTIVITY, like every other sales screen. At a site the list is the
 * customers who have a load, an invoice or an order there — the same trips,
 * invoices and orders the dispatch board, ledger and order list show at that
 * scope — so a customer counted on the command board is always findable here.
 * "Our site" is the customer's usual plant, a fact about them, not a filter.
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
  const t = useWords(customerWords);
  const s = useWords(salesWords);
  const columns = useMemo(() => customerColumns(t, s), [t, s]);

  const rows = useMemo<CustomerRow[]>(() => {
    const invoices = invoicesForSite(siteScope);
    const orders = purchaseOrdersForSite(siteScope);
    const trips = tripsForSite(siteScope);
    const active = new Set([...invoices, ...orders, ...trips].map((x) => x.customerId));
    return CUSTOMERS_MASTER.filter((c) => siteScope === null || active.has(c.id)).map((c) => {
      const theirs = invoices.filter((i) => i.customerId === c.id && i.status !== 'draft' && i.status !== 'closed');
      return {
        customer: c,
        outstanding: theirs.reduce((s, i) => s + Number.parseFloat(i.balanceDue), 0),
        overdueCount: theirs.filter(isInvoiceOverdue).length,
        openOrders: orders.filter(
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
        eyebrow={s.eyebrow}
        title={t.title}
        // From sales.customers.
        meta={<AsOfStamp asOf="14:42" source={s.src.customers} freshness="live" />}
      />
      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={rows.length}>
          {s.all}
        </Chip>
        <Chip active={view === 'overdue'} onClick={() => setView('overdue')} count={rows.filter((r) => r.overdueCount > 0).length}>
          {t.overdueInvoices}
        </Chip>
        <Chip active={view === 'open_orders'} onClick={() => setView('open_orders')} count={rows.filter((r) => r.openOrders > 0).length}>
          {t.openOrders}
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
            // Genuinely empty and filtered-empty are different problems and
            // never share copy (see EmptyState). Empty at a site means nobody
            // has a load, an invoice or an order there yet.
            rows.length === 0 ? (
              <EmptyState fact={t.noneAtSite} />
            ) : (
              <EmptyState
                fact={view === 'overdue' ? t.noneOverdue : t.noneWithOrders}
                action={{ label: s.showAll, onClick: () => setView('all') }}
              />
            )
          }
        />
      </Section>
      <div className="h-10" />
    </>
  );
}

function customerColumns(t: CustomerText, s: SalesText): Column<CustomerRow>[] {
  return [
    {
      key: 'name',
      header: s.customer,
      sticky: true,
      width: 260,
      group: t.groups.details,
      render: (r) => <Stacked primary={r.customer.name} secondary={r.customer.site} />,
    },
    {
      key: 'gstin',
      header: t.gstNo,
      type: 'id',
      width: 170,
      group: t.groups.details,
      // A walk-in counter customer is billed B2C and has no GSTIN.
      render: (r) => (r.customer.gstin ? <IdCell>{r.customer.gstin}</IdCell> : t.noGst),
    },
    {
      key: 'contact',
      header: t.contact,
      group: t.groups.details,
      render: (r) => <Stacked primary={r.customer.contactName} secondary={r.customer.phone} />,
    },
    { key: 'site', header: t.ourSite, group: t.groups.details, render: (r) => r.siteName },
    {
      key: 'terms',
      header: t.creditDays,
      type: 'num',
      width: 110,
      group: t.groups.money,
      render: (r) => (r.customer.paymentTermsDays === 0 ? t.cash : r.customer.paymentTermsDays),
    },
    {
      key: 'limit',
      header: t.creditLimit,
      unit: '₹',
      type: 'money',
      width: 130,
      group: t.groups.money,
      render: (r) => <MoneyCell value={r.customer.creditLimit} decimals={0} />,
    },
    {
      key: 'outstanding',
      header: t.moneyDue,
      unit: '₹',
      type: 'money',
      width: 130,
      group: t.groups.money,
      render: (r) => <MoneyCell value={r.outstanding} decimals={0} />,
    },
    {
      key: 'overdue',
      header: t.overdueInvoices,
      type: 'num',
      width: 130,
      group: t.groups.money,
      render: (r) => (
        <span className="num tabular-nums" style={{ color: r.overdueCount > 0 ? 'var(--status-critical)' : undefined }}>
          {r.overdueCount}
        </span>
      ),
    },
    { key: 'orders', header: t.openOrders, type: 'num', width: 110, group: t.groups.orders, render: (r) => r.openOrders },
  ];
}
