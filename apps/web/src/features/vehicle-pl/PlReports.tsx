import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { formatDate } from '@linck/domain';
import type { PlMonthRow, PlOutstandingRow, PlTripReportRow, PlVehicleRow } from '@linck/mock';
import { Button, Chip, DataTable, EmptyState, IdCell, MoneyCell, PageHeader, QuantityCell, Stacked, type Column } from '@linck/ui';
import { monthNames } from '../../i18n/format.js';
import { useWords } from '../../i18n/words.js';
import { Refusal } from '../../shell/Field.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { now } from '../expenses/bills.js';
import { downloadXlsx, PrintView, type ReportSheet } from './exporters.js';
import { FilterBar, NO_FILTER, NotRead, PlTiles, type FilterState } from './PlParts.js';
import { sheetPath, type PlProblem, type SheetFilter } from './plStore.js';
import { problemText } from './plText.js';
import { usePlReports, useSheetOptions, type AllReports } from './sheets.js';
import { monthsSheet, outstandingSheet, tripsSheet, vehiclesSheet } from './reportSheets.js';
import { plWords, sheetWords } from './words.js';

const TABS = ['trips', 'vehicles', 'months', 'customers', 'vendors'] as const;
type Tab = (typeof TABS)[number];

/**
 * Overview / Accounts → Profit reports (LIN-22): trip-wise, vehicle-wise and
 * monthly P&L, and what customers owe and vendors are owed — the director's
 * and accounts'. One period and search for every tab; Excel takes every
 * report, one sheet each; PDF / Print takes the tab on screen.
 */
export function PlReports() {
  const w = useWords(plWords);
  const sw = useWords(sheetWords);
  const months = useWords(monthNames);
  const navigate = useNavigate();
  const [tab, setTab] = useViewParam(TABS, 'trips');
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [printing, setPrinting] = useState<ReportSheet[] | null>(null);
  /** Live only: why Excel could not read every report. */
  const [problem, setProblem] = useState<PlProblem | null>(null);
  const f: SheetFilter = { from: filter.from || null, to: filter.to || null, q: filter.q, vehicleId: filter.vehicleId || null, customerId: filter.customerId || null };

  const reports = usePlReports(f, tab);
  const trips = reports.read.trips.data;
  const vehicles = reports.read.vehicles.data;
  const monthly = reports.read.months.data;
  const customersDue = reports.read.customers.data;
  const vendorsDue = reports.read.vendors.data;

  const monthLabel = (m: string) => `${months[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const subtitle = filter.from || filter.to ? w.periodLine(filter.from ? formatDate(filter.from) : '…', filter.to ? formatDate(filter.to) : '…') : w.allDates;
  const sheetFor = (t: Tab, r: AllReports): ReportSheet => {
    switch (t) {
      case 'trips':
        return tripsSheet(w, r.trips, subtitle);
      case 'vehicles':
        return vehiclesSheet(w, r.vehicles, subtitle);
      case 'months':
        return monthsSheet(w, r.months, monthLabel, subtitle);
      case 'customers':
        return outstandingSheet(w, r.customers, 'customer', subtitle);
      case 'vendors':
        return outstandingSheet(w, r.vendors, 'vendor', subtitle);
    }
  };
  const onScreen: AllReports = { trips, vehicles, months: monthly, customers: customersDue, vendors: vendorsDue };
  // Excel takes every report, one sheet each: live, those not read yet are read first.
  const excel = () => {
    setProblem(null);
    void reports.withAll((all) => downloadXlsx(`vehicle-pl-reports-${formatDate(now())}`, TABS.map((t) => sheetFor(t, all)))).then(setProblem);
  };
  const print = () => setPrinting([sheetFor(tab, onScreen)]);

  const { vehicles: vehicleOptions, customers: customerOptions } = useSheetOptions();

  const plCols = <T extends { sales: string; materialCost: string; totalEnRoute: string; net: string; profitPct: number | null }>(): Column<T>[] => [
    { key: 'sales', header: w.col.sales, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.sales} /> },
    { key: 'purchase', header: w.col.purchase, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.materialCost} /> },
    { key: 'road', header: w.col.enRoute, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.totalEnRoute} /> },
    { key: 'profit', header: w.col.profit, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.net} /> },
    { key: 'pct', header: w.col.pct, type: 'num', render: (r) => (r.profitPct === null ? '—' : r.profitPct.toFixed(2)) },
  ];
  const tripCols: Column<PlTripReportRow>[] = [
    {
      key: 'trip',
      header: w.col.trip,
      type: 'id',
      sticky: true,
      render: (r) => <Stacked primary={<IdCell>{r.tripNumber ?? (r.kind === 'payment' ? w.sheetPayment : w.noTripYet)}</IdCell>} secondary={`${formatDate(r.date)} · ${r.sheetNumber}`} />,
    },
    { key: 'vehicle', header: w.col.vehicle, render: (r) => <Stacked primary={r.registrationNumber} secondary={r.driverName} /> },
    { key: 'customer', header: w.col.customer, render: (r) => <Stacked primary={r.customers.join(', ') || '—'} secondary={r.vendors.join(', ')} /> },
    { key: 'km', header: w.col.km, type: 'num', render: (r) => <QuantityCell value={r.pl.distanceKm} decimals={0} /> },
    ...plCols<PlTripReportRow['pl']>().map((c) => ({ ...c, render: (r: PlTripReportRow) => c.render(r.pl) })),
  ];
  const vehicleCols: Column<PlVehicleRow>[] = [
    { key: 'vehicle', header: w.col.vehicle, type: 'id', sticky: true, render: (r) => <Stacked primary={<IdCell>{r.registrationNumber}</IdCell>} secondary={r.vehicleModel} /> },
    { key: 'trips', header: w.col.trips, type: 'num', render: (r) => r.trips },
    { key: 'km', header: w.col.km, type: 'num', render: (r) => <QuantityCell value={r.distanceKm} decimals={0} /> },
    { key: 'kmpl', header: w.col.mileage, type: 'num', render: (r) => (r.mileageKmpl === null ? '—' : r.mileageKmpl.toFixed(2)) },
    ...plCols<PlVehicleRow>(),
  ];
  const monthCols: Column<PlMonthRow>[] = [
    { key: 'month', header: w.col.month, type: 'id', sticky: true, render: (r) => monthLabel(r.month) },
    { key: 'trips', header: w.col.trips, type: 'num', render: (r) => r.trips },
    { key: 'km', header: w.col.km, type: 'num', render: (r) => <QuantityCell value={r.distanceKm} decimals={0} /> },
    ...plCols<PlMonthRow>(),
    { key: 'gst', header: w.col.gstToPay, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.gstToPay} /> },
  ];
  const dueCols = (role: 'customer' | 'vendor'): Column<PlOutstandingRow>[] => [
    { key: 'name', header: w.col.name, type: 'id', sticky: true, render: (r) => <Stacked primary={r.name} secondary={r.gstin ?? r.phone} /> },
    { key: 'trips', header: w.col.trips, type: 'num', render: (r) => r.trips },
    { key: 'billed', header: w.col.billed, group: w.col.groupDue, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.billed} /> },
    { key: 'settled', header: role === 'customer' ? w.col.received : w.col.paid, group: w.col.groupDue, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.settled} /> },
    { key: 'due', header: w.col.due, group: w.col.groupDue, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.due} /> },
    { key: 'status', header: w.col.status, render: (r) => (r.due.startsWith('-') ? w.paidExtra : w.status[r.status]) },
    { key: 'last', header: w.col.last, render: (r) => formatDate(r.lastDate) },
  ];

  const shown = reports.read[tab];
  const empty = shown.state !== 'ready' ? <NotRead read={shown} /> : <EmptyState fact={w.noRows} because={w.noneMatchWhy} action={{ label: w.showAll, onClick: () => setFilter(NO_FILTER) }} />;
  const toSheet = (sheetId: string) => void navigate({ to: sheetPath(sheetId) });
  const loss = (net: string) => (net.startsWith('-') ? { status: 'critical' as const } : undefined);

  return (
    <div className="pl-screen">
      <PageHeader
        eyebrow={w.reportsEyebrow}
        title={w.reportsTitle}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={excel}>{w.excel}</Button>
            <Button onClick={print}>{w.print}</Button>
          </div>
        }
      />
      <div className="flex flex-wrap gap-1.5 px-4 pt-3 md:px-6">
        {TABS.map((t) => (
          <Chip key={t} active={tab === t} onClick={() => setTab(t)}>
            {w.tabs[t]}
          </Chip>
        ))}
      </div>
      <FilterBar value={filter} onChange={setFilter} vehicles={tab === 'customers' || tab === 'vendors' ? undefined : vehicleOptions} customers={tab === 'trips' ? customerOptions : undefined} />
      {problem && (
        <div className="px-4 pt-3 md:px-6">
          <Refusal text={problemText(problem, sw)} />
        </div>
      )}
      <PlTiles total={trips.total} asOf={formatDate(now())} />
      {tab === 'trips' && <DataTable columns={tripCols} rows={trips.rows} rowKey={(r) => `${r.sheetId}:${r.tripId ?? r.kind}`} rail={(r) => loss(r.pl.net)} onRowClick={(r) => toSheet(r.sheetId)} empty={empty} />}
      {tab === 'vehicles' && <DataTable columns={vehicleCols} rows={vehicles.rows} rowKey={(r) => r.vehicleId} rail={(r) => loss(r.net)} empty={empty} />}
      {tab === 'months' && <DataTable columns={monthCols} rows={monthly.rows} rowKey={(r) => r.month} rail={(r) => loss(r.net)} empty={empty} />}
      {tab === 'customers' && <DataTable columns={dueCols('customer')} rows={customersDue.rows} rowKey={(r) => r.partyId} empty={empty} />}
      {tab === 'vendors' && <DataTable columns={dueCols('vendor')} rows={vendorsDue.rows} rowKey={(r) => r.partyId} empty={empty} />}
      {printing && <PrintView sheets={printing} printedOn={formatDate(now())} onClose={() => setPrinting(null)} />}
    </div>
  );
}
