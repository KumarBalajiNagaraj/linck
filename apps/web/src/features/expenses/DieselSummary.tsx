import { useMemo } from 'react';
import { formatDate, formatINR, summarizeDiesel } from '@linck/domain';
import { expensesForSite, type ExpenseBill } from '@linck/mock';
import { Chip, DataTable, EmptyState, IdCell, MoneyCell, PageHeader, Provisional, QuantityCell, Section, type Column } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { driverLabel, useBills, vehicleLabel } from './bills.js';
import { BillsNotHere } from './ExpenseRegister.js';
import { expenseWords } from './words.js';

/**
 * DIESEL, BY VEHICLE AND BY DRIVER.
 *
 * Every diesel bill in Linck — slips read off WhatsApp, bills uploaded,
 * bills keyed — summed per vehicle or per the driver who filled. Rejected
 * and deleted bills are left out; bills nobody has validated yet are counted, and their
 * rupees are hatched, because until the fleet manager checks a slip the
 * figure is only what was read off it.
 *
 * The driver is whoever sent the slip, not whoever is rostered on the
 * vehicle: a relief driver's fill is his, and the summary says so.
 */

const VIEWS = ['vehicle', 'driver'] as const;

interface Line {
  key: string;
  label: string;
  fills: number;
  litres: number;
  amount: number;
  /** Rupees still awaiting validation: read, not yet checked. */
  unchecked: number;
}

const paise = (b: ExpenseBill) => Math.round(Number.parseFloat(b.amount) * 100);

export function DieselSummary() {
  const { siteScope } = useApp();
  const list = useBills();
  const { bills } = list;
  const [view, setView] = useViewParam(VIEWS, 'vehicle');
  const t = useWords(expenseWords);
  const w = t.summary;

  const diesel = useMemo(
    () => expensesForSite(siteScope, 'fleet', bills).filter((b) => b.kind === 'diesel' && b.status !== 'rejected' && b.status !== 'deleted'),
    [siteScope, bills],
  );

  const lines = useMemo<Line[]>(() => {
    const keyOf = view === 'vehicle' ? (b: ExpenseBill) => b.vehicleId ?? 'none' : (b: ExpenseBill) => b.driverId ?? 'none';
    const rows = diesel.map((b) => ({ key: keyOf(b), litres: b.litres, amount: b.amount, unchecked: b.status === 'submitted' ? paise(b) : 0 }));
    const unchecked = new Map<string, number>();
    for (const r of rows) unchecked.set(r.key, (unchecked.get(r.key) ?? 0) + r.unchecked);
    return summarizeDiesel(rows, (r) => r.key).map((line) => ({
      ...line,
      label:
        line.key === 'none'
          ? view === 'vehicle'
            ? w.noVehicle
            : w.driverNotKnown
          : view === 'vehicle'
            ? (vehicleLabel(line.key) ?? line.key)
            : (driverLabel(line.key) ?? line.key),
      unchecked: (unchecked.get(line.key) ?? 0) / 100,
    }));
  }, [diesel, view, w]);

  const total = {
    litres: lines.reduce((s, l) => s + Math.round(l.litres * 100), 0) / 100,
    amount: diesel.reduce((s, b) => s + paise(b), 0) / 100,
    unchecked: diesel.filter((b) => b.status === 'submitted').reduce((s, b) => s + paise(b), 0) / 100,
  };
  const dates = diesel.map((b) => b.billDate).sort();

  const columns: Column<Line>[] = [
    {
      key: 'who',
      header: view === 'vehicle' ? w.vehicle : w.driver,
      sticky: true,
      type: view === 'vehicle' ? 'id' : 'text',
      render: (l) => (view === 'vehicle' && l.key !== 'none' ? <IdCell>{l.label}</IdCell> : l.label),
    },
    { key: 'fills', header: w.fills, type: 'num', width: 80, render: (l) => l.fills },
    { key: 'litres', header: w.litres, unit: 'L', type: 'num', width: 110, render: (l) => <QuantityCell value={l.litres} decimals={2} /> },
    { key: 'amount', header: w.amount, unit: '₹', type: 'money', width: 130, render: (l) => <MoneyCell value={l.amount.toFixed(2)} /> },
    {
      key: 'rate',
      header: w.perLitre,
      unit: '₹',
      type: 'num',
      width: 100,
      render: (l) => (l.litres > 0 ? (l.amount / l.litres).toFixed(2) : null),
    },
    {
      key: 'unchecked',
      header: w.notCheckedCol,
      unit: '₹',
      type: 'money',
      width: 150,
      render: (l) => (l.unchecked > 0 ? <Provisional>{l.unchecked.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Provisional> : null),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.desk.fleet}
        title={w.title}
        meta={
          <span className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
            {w.meta(diesel.length, total.litres.toLocaleString('en-IN'), formatINR(total.amount))}
            {total.unchecked > 0 ? ` · ${w.notChecked(formatINR(total.unchecked))}` : ''}
            {dates.length > 0 ? ` · ${w.dated(formatDate(dates[0]), formatDate(dates[dates.length - 1]))}` : ''}
          </span>
        }
      />
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'vehicle'} onClick={() => setView('vehicle')}>
          {w.byVehicle}
        </Chip>
        <Chip active={view === 'driver'} onClick={() => setView('driver')}>
          {w.byDriver}
        </Chip>
      </div>
      <Section>
        <DataTable
          columns={columns}
          rows={lines}
          rowKey={(l) => l.key}
          empty={list.state !== 'ready' ? <BillsNotHere list={list} /> : <EmptyState fact={w.none} />}
        />
      </Section>
      <div className="h-10" />
    </>
  );
}
