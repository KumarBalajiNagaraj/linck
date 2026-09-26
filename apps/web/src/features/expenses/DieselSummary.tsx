import { useMemo } from 'react';
import { formatDate, formatINR, summarizeDiesel } from '@linck/domain';
import { DRIVERS, expensesForSite, VEHICLES, type ExpenseBill } from '@linck/mock';
import { Chip, DataTable, EmptyState, IdCell, MoneyCell, PageHeader, Provisional, QuantityCell, Section, type Column } from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { useExpenses } from './expenseStore.js';

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
  const bills = useExpenses((s) => s.bills);
  const [view, setView] = useViewParam(VIEWS, 'vehicle');

  const diesel = useMemo(
    () => expensesForSite(siteScope, 'fleet', bills).filter((b) => b.kind === 'diesel' && b.status !== 'rejected' && b.status !== 'deleted'),
    [siteScope, bills],
  );

  const lines = useMemo<Line[]>(() => {
    const keyOf = view === 'vehicle' ? (b: ExpenseBill) => b.vehicleId ?? 'none' : (b: ExpenseBill) => b.driverId ?? 'none';
    const rows = diesel.map((b) => ({ key: keyOf(b), litres: b.litres, amount: b.amount, unchecked: b.status === 'submitted' ? paise(b) : 0 }));
    const unchecked = new Map<string, number>();
    for (const r of rows) unchecked.set(r.key, (unchecked.get(r.key) ?? 0) + r.unchecked);
    return summarizeDiesel(rows, (r) => r.key).map((t) => ({
      ...t,
      label:
        t.key === 'none'
          ? view === 'vehicle'
            ? 'No vehicle'
            : 'Driver not known'
          : view === 'vehicle'
            ? (VEHICLES.find((v) => v.id === t.key)?.displayReg ?? t.key)
            : (DRIVERS.find((d) => d.id === t.key)?.name ?? t.key),
      unchecked: (unchecked.get(t.key) ?? 0) / 100,
    }));
  }, [diesel, view]);

  const total = {
    litres: lines.reduce((s, l) => s + Math.round(l.litres * 100), 0) / 100,
    amount: diesel.reduce((s, b) => s + paise(b), 0) / 100,
    unchecked: diesel.filter((b) => b.status === 'submitted').reduce((s, b) => s + paise(b), 0) / 100,
  };
  const dates = diesel.map((b) => b.billDate).sort();

  const columns: Column<Line>[] = [
    {
      key: 'who',
      header: view === 'vehicle' ? 'Vehicle' : 'Driver',
      sticky: true,
      type: view === 'vehicle' ? 'id' : 'text',
      render: (l) => (view === 'vehicle' && l.key !== 'none' ? <IdCell>{l.label}</IdCell> : l.label),
    },
    { key: 'fills', header: 'Fills', type: 'num', width: 80, render: (l) => l.fills },
    { key: 'litres', header: 'Litres', unit: 'L', type: 'num', width: 110, render: (l) => <QuantityCell value={l.litres} decimals={2} /> },
    { key: 'amount', header: 'Amount', unit: '₹', type: 'money', width: 130, render: (l) => <MoneyCell value={l.amount.toFixed(2)} /> },
    {
      key: 'rate',
      header: 'Per litre',
      unit: '₹',
      type: 'num',
      width: 100,
      render: (l) => (l.litres > 0 ? (l.amount / l.litres).toFixed(2) : null),
    },
    {
      key: 'unchecked',
      header: 'Not yet validated',
      unit: '₹',
      type: 'money',
      width: 150,
      render: (l) => (l.unchecked > 0 ? <Provisional>{l.unchecked.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Provisional> : null),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Diesel summary"
        meta={
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {diesel.length} fills · {total.litres.toLocaleString('en-IN')} L · {formatINR(total.amount)}
            {total.unchecked > 0 ? ` · ${formatINR(total.unchecked)} not yet validated` : ''}
            {dates.length > 0 ? ` · bills dated ${formatDate(dates[0])} to ${formatDate(dates[dates.length - 1])}` : ''}
          </span>
        }
      />
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'vehicle'} onClick={() => setView('vehicle')}>
          By vehicle
        </Chip>
        <Chip active={view === 'driver'} onClick={() => setView('driver')}>
          By driver
        </Chip>
      </div>
      <Section>
        <DataTable
          columns={columns}
          rows={lines}
          rowKey={(l) => l.key}
          empty={<EmptyState fact="No diesel bills at this site." because="None has been uploaded, keyed or read off WhatsApp here yet." />}
        />
      </Section>
      <div className="h-10" />
    </>
  );
}
