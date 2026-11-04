import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { formatDate, sumPl } from '@linck/domain';
import { NOW, type PlMonthRow, type PlOutstandingRow, type PlTripReportRow, type PlVehicleRow } from '@linck/mock';
import { Button, Chip, DataTable, EmptyState, IdCell, MoneyCell, PageHeader, QuantityCell, Stacked, type Column } from '@linck/ui';
import { monthNames } from '../../i18n/format.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { downloadXlsx, PrintView, type ReportSheet } from './exporters.js';
import { attention, customerReport, lossTrips, previousRange, type CustomerPlRow } from './insights.js';
import { FilterBar, NO_FILTER, PlTiles, useAgainst, type Comparison, type FilterState } from './PlParts.js';
import { PlSummary, type SummaryActions } from './PlSummary.js';
import { monthReport, outstandingReport, READ_KEYS, reportUnits, sheetPath, tripReport, usePl, usePlBook, vehicleReport, type SheetFilter } from './plStore.js';
import { customersPlSheet, monthsSheet, outstandingSheet, tripsSheet, vehiclesSheet } from './reportSheets.js';
import { plWords } from './words.js';

const TABS = ['summary', 'trips', 'vehicles', 'customersPl', 'months', 'customers', 'vendors'] as const;
type Tab = (typeof TABS)[number];
type ReportTab = Exclude<Tab, 'summary'>;
const REPORT_TABS = TABS.filter((t): t is ReportTab => t !== 'summary');

/**
 * Overview / Accounts → Profit reports (LIN-22): a summary first — where
 * each ₹100 of sales went, the best and worst vehicles and customers, what is
 * worth a look, all set against the period before — then trip-wise,
 * vehicle-wise, customer-wise and monthly P&L, and what customers owe and
 * vendors are owed. One period and search for every tab; a tap on a vehicle,
 * customer or month opens its trips. Excel takes every report, one sheet
 * each; PDF / Print takes the tab on screen (the summary prints vehicle-wise
 * and monthly).
 */
export function PlReports() {
  const w = useWords(plWords);
  const months = useWords(monthNames);
  const { persona } = useApp();
  const navigate = useNavigate();
  const book = usePlBook();
  const parties = usePl((s) => s.parties);
  const [tab, setTab] = useViewParam(TABS, 'summary');
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [lossesOnly, setLossesOnly] = useState(false);
  const againstWords = useAgainst();
  const [printing, setPrinting] = useState<ReportSheet[] | null>(null);
  const f: SheetFilter = { from: filter.from || null, to: filter.to || null, q: filter.q, vehicleId: filter.vehicleId || null, customerId: filter.customerId || null };

  const units = useMemo(() => reportUnits(book, persona.grants, READ_KEYS, { ...f, q: null }), [book, persona.grants, f.from, f.to, f.vehicleId, f.customerId]);
  const searched = useMemo(() => reportUnits(book, persona.grants, READ_KEYS, f), [book, persona.grants, f.from, f.to, f.q, f.vehicleId, f.customerId]);
  const trips = useMemo(() => tripReport(book, searched), [book, searched]);
  const vehicles = useMemo(() => vehicleReport(searched), [searched]);
  const monthly = useMemo(() => monthReport(searched), [searched]);
  const customersDue = useMemo(() => outstandingReport(book, units, 'customer', f.q), [book, units, f.q]);
  const vendorsDue = useMemo(() => outstandingReport(book, units, 'vendor', f.q), [book, units, f.q]);
  const customersPl = useMemo(() => customerReport(book, searched, f.customerId), [book, searched, f.customerId]);
  const customersPlTotal = useMemo(() => sumPl(customersPl, customersPl.reduce((n, r) => n + r.trips, 0)), [customersPl]);
  // "Losses only": the trips that lost money, and their total.
  const shownTrips = useMemo(() => {
    if (!lossesOnly) return trips;
    const rows = trips.rows.filter((r) => r.kind === 'trip' && r.pl.net.startsWith('-'));
    return { rows, total: sumPl(rows.map((r) => r.pl), rows.length) };
  }, [trips, lossesOnly]);

  // The same filter, one period back, for the ▲▼ against each figure.
  const prev = previousRange(filter.period, filter.from, filter.to);
  const previous = useMemo((): Comparison | null => {
    if (!prev) return null;
    const before = tripReport(book, reportUnits(book, persona.grants, READ_KEYS, { ...f, from: prev.from, to: prev.to }));
    if (before.total.trips === 0) return null;
    return { totals: before.total, against: againstWords(prev) };
  }, [book, persona.grants, prev?.from, prev?.to, prev?.key, f.q, f.vehicleId, f.customerId, againstWords]);
  const worthALook = useMemo(
    () => attention({ total: trips.total, previous: previous?.totals ?? null, lossTrips: lossTrips(trips.rows), vehicles: vehicles.rows, customers: customersPl, dues: customersDue.rows }),
    [trips, previous, vehicles, customersPl, customersDue],
  );

  const monthLabel = (m: string) => `${months[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const subtitle = filter.from || filter.to ? w.periodLine(filter.from ? formatDate(filter.from) : '…', filter.to ? formatDate(filter.to) : '…') : w.allDates;
  const all: Record<ReportTab, () => ReportSheet> = {
    trips: () => tripsSheet(w, shownTrips, subtitle),
    vehicles: () => vehiclesSheet(w, vehicles, subtitle),
    customersPl: () => customersPlSheet(w, customersPl, customersPlTotal, subtitle),
    months: () => monthsSheet(w, monthly, monthLabel, subtitle),
    customers: () => outstandingSheet(w, customersDue, 'customer', subtitle),
    vendors: () => outstandingSheet(w, vendorsDue, 'vendor', subtitle),
  };

  const vehicleOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of book.sheets) seen.set(s.vehicleId, s.registrationNumber);
    return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [book.sheets]);
  const customerOptions = useMemo(() => parties.filter((p) => p.roles.includes('customer')).map((p) => ({ id: p.id, label: p.name })).sort((a, b) => a.label.localeCompare(b.label)), [parties]);

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
  const customerPlCols: Column<CustomerPlRow>[] = [
    { key: 'name', header: w.col.customer, type: 'id', sticky: true, render: (r) => r.name },
    { key: 'trips', header: w.col.trips, type: 'num', render: (r) => r.trips },
    ...plCols<CustomerPlRow>(),
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

  const showAll = () => {
    setFilter(NO_FILTER);
    setLossesOnly(false);
  };
  const empty = <EmptyState fact={w.noRows} because={w.noneMatchWhy} action={{ label: w.showAll, onClick: showAll }} />;
  // A tap on a vehicle, customer or month opens its trips: the filter narrows, the period stays.
  const lastOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const go: SummaryActions = {
    vehicle: (vehicleId) => {
      setFilter({ ...filter, vehicleId });
      setTab('trips');
    },
    customer: (customerId) => {
      setFilter({ ...filter, customerId });
      setTab('trips');
    },
    month: (month) => {
      setFilter({ ...filter, period: 'custom', from: `${month}-01`, to: lastOf(month) });
      setTab('trips');
    },
    losses: () => {
      setLossesOnly(true);
      setTab('trips');
    },
    tab: (t) => setTab(t),
  };
  const toSheet = (sheetId: string) => void navigate({ to: sheetPath(sheetId) });
  const loss = (net: string) => (net.startsWith('-') ? { status: 'critical' as const } : undefined);

  return (
    <div className="pl-screen">
      <PageHeader
        eyebrow={w.reportsEyebrow}
        title={w.reportsTitle}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => downloadXlsx(`vehicle-pl-reports-${formatDate(NOW)}`, REPORT_TABS.map((t) => all[t]()))}>{w.excel}</Button>
            <Button onClick={() => setPrinting(tab === 'summary' ? [all.vehicles(), all.months()] : [all[tab]()])}>{w.print}</Button>
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
      <FilterBar
        value={filter}
        onChange={setFilter}
        vehicles={tab === 'customers' || tab === 'vendors' ? undefined : vehicleOptions}
        customers={tab === 'summary' || tab === 'trips' || tab === 'customersPl' ? customerOptions : undefined}
        extra={
          tab === 'trips' ? (
            <Chip active={lossesOnly} onClick={() => setLossesOnly(!lossesOnly)} {...(lossesOnly ? { count: shownTrips.rows.length } : {})}>
              {w.lossesOnly}
            </Chip>
          ) : undefined
        }
      />
      <PlTiles total={tab === 'trips' ? shownTrips.total : trips.total} asOf={formatDate(NOW)} previous={tab === 'trips' && lossesOnly ? null : previous} />
      {tab === 'summary' && (
        <PlSummary total={trips.total} previous={previous} vehicles={vehicles.rows} customers={customersPl} months={monthly.rows} attention={worthALook} monthLabel={monthLabel} go={go} />
      )}
      {tab === 'trips' && <DataTable columns={tripCols} rows={shownTrips.rows} rowKey={(r) => `${r.sheetId}:${r.tripId ?? r.kind}`} rail={(r) => loss(r.pl.net)} onRowClick={(r) => toSheet(r.sheetId)} empty={empty} />}
      {tab === 'vehicles' && <DataTable columns={vehicleCols} rows={vehicles.rows} rowKey={(r) => r.vehicleId} rail={(r) => loss(r.net)} onRowClick={(r) => go.vehicle(r.vehicleId)} empty={empty} />}
      {tab === 'customersPl' && <DataTable columns={customerPlCols} rows={customersPl} rowKey={(r) => r.partyId} rail={(r) => loss(r.net)} onRowClick={(r) => go.customer(r.partyId)} empty={empty} />}
      {tab === 'months' && <DataTable columns={monthCols} rows={monthly.rows} rowKey={(r) => r.month} rail={(r) => loss(r.net)} onRowClick={(r) => go.month(r.month)} empty={empty} />}
      {tab === 'customers' && <DataTable columns={dueCols('customer')} rows={customersDue.rows} rowKey={(r) => r.partyId} onRowClick={(r) => go.customer(r.partyId)} empty={empty} />}
      {tab === 'vendors' && <DataTable columns={dueCols('vendor')} rows={vendorsDue.rows} rowKey={(r) => r.partyId} empty={empty} />}
      {printing && <PrintView sheets={printing} printedOn={formatDate(NOW)} onClose={() => setPrinting(null)} />}
    </div>
  );
}
