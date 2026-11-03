import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { formatDate } from '@linck/domain';
import type { PlSheetRow, PlTripReportRow } from '@linck/mock';
import { Button, Chip, DataTable, EmptyState, IdCell, MoneyCell, PageHeader, QuantityCell, Stacked, type Column } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { now } from '../expenses/bills.js';
import { downloadXlsx, PrintView, type ReportSheet } from './exporters.js';
import { FilterBar, NO_FILTER, NotRead, PlTiles, type FilterState } from './PlParts.js';
import { NEW_PATH, sheetPath, type SheetFilter } from './plStore.js';
import { useMayWriteSheets, useSheetList, useSheetOptions, useTripReport } from './sheets.js';
import { sheetsSheet, tripsSheet } from './reportSheets.js';
import { plWords } from './words.js';

const VIEWS = ['sheets', 'trips'] as const;

/**
 * Fleet → Vehicle P&L (LIN-22): every trip sheet the person may read, with its
 * profit, or every trip with its own — the workbook's two levels — searched,
 * filtered by dates, vehicle and customer, and exported or printed.
 */
export function SheetList() {
  const w = useWords(plWords);
  const navigate = useNavigate();
  const [view, setView] = useViewParam(VIEWS, 'sheets');
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [printing, setPrinting] = useState<ReportSheet[] | null>(null);
  const f: SheetFilter = { from: filter.from || null, to: filter.to || null, q: filter.q, vehicleId: filter.vehicleId || null, customerId: filter.customerId || null };

  const list = useSheetList(f);
  const report = useTripReport(f);
  const rows = list.data.rows;
  const trips = report.data;
  const total = view === 'sheets' ? list.data.total : trips.total;
  const writable = useMayWriteSheets();
  const { vehicles, customers, none } = useSheetOptions();
  // Live, until the API has answered there is nothing to say "none" of.
  const shown = view === 'sheets' ? list : report;

  const subtitle = filter.from || filter.to ? w.periodLine(filter.from ? formatDate(filter.from) : '…', filter.to ? formatDate(filter.to) : '…') : w.allDates;
  const sheetsForExport = (): ReportSheet[] => [view === 'sheets' ? sheetsSheet(w, rows, list.data.total, subtitle) : tripsSheet(w, trips, subtitle)];
  const dates = (r: PlSheetRow) => (r.endDate && r.endDate !== r.startDate ? `${formatDate(r.startDate)} – ${formatDate(r.endDate)}` : formatDate(r.startDate));

  const sheetColumns: Column<PlSheetRow>[] = [
    { key: 'sheet', header: w.col.sheet, type: 'id', sticky: true, render: (r) => <Stacked primary={<IdCell>{r.sheetNumber}</IdCell>} secondary={r.endDate ? dates(r) : `${dates(r)} · ${w.open}`} /> },
    { key: 'vehicle', header: w.col.vehicle, render: (r) => <Stacked primary={r.registrationNumber} secondary={r.driverName} /> },
    { key: 'trips', header: w.col.trips, type: 'num', render: (r) => r.tripNumbers.length },
    { key: 'customers', header: w.col.customer, render: (r) => (r.customers.length ? r.customers.slice(0, 2).join(', ') + (r.customers.length > 2 ? ` +${r.customers.length - 2}` : '') : w.noTripYet) },
    { key: 'km', header: w.col.km, type: 'num', render: (r) => <QuantityCell value={r.pl.distanceKm} decimals={0} /> },
    { key: 'sales', header: w.col.sales, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.sales} /> },
    { key: 'purchase', header: w.col.purchase, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.materialCost} /> },
    { key: 'road', header: w.col.enRoute, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.totalEnRoute} /> },
    { key: 'profit', header: w.col.profit, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.net} /> },
    { key: 'pct', header: w.col.pct, type: 'num', render: (r) => (r.pl.profitPct === null ? '—' : r.pl.profitPct.toFixed(2)) },
  ];
  const tripColumns: Column<PlTripReportRow>[] = [
    {
      key: 'trip',
      header: w.col.trip,
      type: 'id',
      sticky: true,
      render: (r) => <Stacked primary={<IdCell>{r.tripNumber ?? (r.kind === 'payment' ? w.sheetPayment : w.noTripYet)}</IdCell>} secondary={`${formatDate(r.date)} · ${r.sheetNumber}`} />,
    },
    { key: 'vehicle', header: w.col.vehicle, render: (r) => <Stacked primary={r.registrationNumber} secondary={r.driverName} /> },
    { key: 'customers', header: w.col.customer, render: (r) => <Stacked primary={r.customers.join(', ') || '—'} secondary={r.materials.join(', ')} /> },
    { key: 'km', header: w.col.km, type: 'num', render: (r) => <QuantityCell value={r.pl.distanceKm} decimals={0} /> },
    { key: 'sales', header: w.col.sales, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.sales} /> },
    { key: 'purchase', header: w.col.purchase, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.materialCost} /> },
    { key: 'road', header: w.col.enRoute, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.totalEnRoute} /> },
    { key: 'profit', header: w.col.profit, group: w.col.groupMoney, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.pl.net} /> },
    { key: 'pct', header: w.col.pct, type: 'num', render: (r) => (r.pl.profitPct === null ? '—' : r.pl.profitPct.toFixed(2)) },
  ];

  const empty =
    shown.state !== 'ready' ? (
      <NotRead read={shown} />
    ) : none ? (
      <EmptyState fact={w.noSheets} />
    ) : (
      <EmptyState fact={w.noneMatch} because={w.noneMatchWhy} action={{ label: w.showAll, onClick: () => setFilter(NO_FILTER) }} />
    );

  return (
    <div className="pl-screen">
      <PageHeader
        eyebrow={w.eyebrow}
        title={w.title}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => downloadXlsx(`vehicle-pl-${view}-${formatDate(now()).replace(/\//g, '-')}`, sheetsForExport())}>{w.excel}</Button>
            <Button onClick={() => setPrinting(sheetsForExport())}>{w.print}</Button>
            {writable && (
              <Button variant="primary" onClick={() => void navigate({ to: NEW_PATH })}>
                {w.addSheet}
              </Button>
            )}
          </div>
        }
      />
      <div className="flex gap-1.5 px-4 pt-3 md:px-6">
        {VIEWS.map((v) => (
          <Chip key={v} active={view === v} onClick={() => setView(v)} count={v === 'sheets' ? rows.length : trips.rows.filter((r) => r.kind === 'trip').length}>
            {w.views[v]}
          </Chip>
        ))}
      </div>
      <FilterBar value={filter} onChange={setFilter} vehicles={vehicles} customers={customers} />
      <PlTiles total={total} asOf={formatDate(now())} />
      {view === 'sheets' ? (
        <DataTable
          columns={sheetColumns}
          rows={rows}
          rowKey={(r) => r.id}
          rail={(r) => (r.pl.net.startsWith('-') ? { status: 'critical' } : undefined)}
          onRowClick={(r) => void navigate({ to: sheetPath(r.id) })}
          empty={empty}
        />
      ) : (
        <DataTable
          columns={tripColumns}
          rows={trips.rows}
          rowKey={(r) => `${r.sheetId}:${r.tripId ?? r.kind}`}
          rail={(r) => (r.pl.net.startsWith('-') ? { status: 'critical' } : undefined)}
          onRowClick={(r) => void navigate({ to: sheetPath(r.sheetId) })}
          empty={empty}
        />
      )}
      {printing && <PrintView sheets={printing} printedOn={formatDate(now())} onClose={() => setPrinting(null)} />}
    </div>
  );
}
