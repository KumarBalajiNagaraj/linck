import { useMemo, useState } from 'react';
import { can } from '@linck/domain';
import {
  AsOfStamp,
  Button,
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
import { useAddCustomer, useChangeCustomer, useCustomerRows, useCustomers, type CustomerRow, type CustomerRows } from './customers.js';
import { CustomerSheet, useCustomerProblem } from './CustomerSheet.js';
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
 *
 * LIVE (VITE_API_URL set) the customers and their orders are the API's
 * (customers.ts), and the sales desk adds and changes customers here. Loads
 * and invoices are not on the API yet, so live a site's list is the
 * customers served from it or with an order there, and what they owe is left
 * out rather than shown from the sample invoices.
 */

type View = 'all' | 'overdue' | 'open_orders';
const VIEWS: readonly View[] = ['all', 'overdue', 'open_orders'];

/** Columns read off invoices: shown only where invoices are known. */
const DUE_COLUMNS = ['outstanding', 'overdue'];

export function CustomerDatabase() {
  const { persona, siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');
  const t = useWords(customerWords);
  const s = useWords(salesWords);
  const list = useCustomerRows(siteScope);
  const { rows, dues, orderCounts } = list;
  const customers = useCustomers().rows;
  const add = useAddCustomer();
  const change = useChangeCustomer();
  /** The sheet: a customer's id, 'new', or closed. Live only; the demo's master is read-only. */
  const [sheet, setSheet] = useState<string | null>(null);
  const columns = useMemo(
    () => customerColumns(t, s).filter((c) => (dues || !DUE_COLUMNS.includes(c.key)) && (orderCounts || c.key !== 'orders')),
    [t, s, dues, orderCounts],
  );

  // A view whose figures are not known here shows everyone, not nobody.
  const shown: View = (view === 'overdue' && !dues) || (view === 'open_orders' && !orderCounts) ? 'all' : view;
  const overdue = rows.filter((r) => (r.overdueCount ?? 0) > 0);
  const withOrders = rows.filter((r) => (r.openOrders ?? 0) > 0);
  const visible = shown === 'overdue' ? overdue : shown === 'open_orders' ? withOrders : rows;
  const mayAdd = add !== null && can(persona.grants, 'sales.customer.write', { siteId: siteScope });
  const open = sheet === 'new' ? null : (customers.find((c) => c.id === sheet) ?? null);

  return (
    <>
      <PageHeader
        eyebrow={s.eyebrow}
        title={t.title}
        // From sales.customers.
        meta={<AsOfStamp asOf={list.asOf} source={s.src.customers} freshness="live" />}
        actions={
          mayAdd ? (
            <Button variant="primary" onClick={() => setSheet('new')}>
              {t.add}
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={shown === 'all'} onClick={() => setView('all')} count={rows.length}>
          {s.all}
        </Chip>
        {dues ? (
          <Chip active={shown === 'overdue'} onClick={() => setView('overdue')} count={overdue.length}>
            {t.overdueInvoices}
          </Chip>
        ) : null}
        {orderCounts ? (
          <Chip active={shown === 'open_orders'} onClick={() => setView('open_orders')} count={withOrders.length}>
            {t.openOrders}
          </Chip>
        ) : null}
      </div>
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={visible}
          rowKey={(r) => r.customer.id}
          rail={(r) => ((r.overdueCount ?? 0) > 0 ? { status: 'critical' } : undefined)}
          // Live, a row opens the customer, to read in full and change.
          {...(change ? { onRowClick: (r: CustomerRow) => setSheet(r.customer.id), selectedKey: open?.id } : {})}
          empty={
            // Genuinely empty and filtered-empty are different problems and
            // never share copy (see EmptyState). Empty at a site means nobody
            // has a load, an invoice or an order there yet.
            list.state !== 'ready' ? (
              <CustomersNotHere list={list} />
            ) : rows.length === 0 ? (
              <EmptyState fact={t.noneAtSite} />
            ) : (
              <EmptyState
                fact={shown === 'overdue' ? t.noneOverdue : t.noneWithOrders}
                action={{ label: s.showAll, onClick: () => setView('all') }}
              />
            )
          }
        />
      </Section>
      <div className="h-10" />
      {sheet === 'new' || open ? <CustomerSheet key={sheet} customer={open} onClose={() => setSheet(null)} /> : null}
    </>
  );
}

/** Live only: the customers are on their way, or could not be read. */
function CustomersNotHere({ list }: { list: CustomerRows }) {
  const t = useWords(customerWords);
  const s = useWords(salesWords);
  const say = useCustomerProblem();
  if (list.state === 'loading') return <EmptyState fact={t.loading} />;
  return <EmptyState fact={t.failed} {...(list.problem ? { because: say(list.problem) } : {})} action={{ label: s.retry, onClick: list.retry }} />;
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
    { key: 'site', header: t.ourSite, group: t.groups.details, render: (r) => r.siteName ?? t.otherSite },
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
        <span className="num tabular-nums" style={{ color: (r.overdueCount ?? 0) > 0 ? 'var(--status-critical)' : undefined }}>
          {r.overdueCount}
        </span>
      ),
    },
    { key: 'orders', header: t.openOrders, type: 'num', width: 110, group: t.groups.orders, render: (r) => r.openOrders },
  ];
}
