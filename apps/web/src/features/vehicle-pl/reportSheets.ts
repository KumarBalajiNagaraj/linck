import type { PlTotals } from '@linck/domain';
import type { PlMonthRow, PlOutstandingRow, PlOutstandingTotal, PlReport, PlSheetRow, PlTripReportRow, PlVehicleRow } from '@linck/mock';
import type { Cell, ReportSheet } from './exporters.js';
import type { CustomerPlRow } from './insights.js';
import type { plWords } from './words.js';

/**
 * The reports as sheets (exporters.tsx): one column list per report, money as
 * the rules' decimal strings, so the .xlsx and the printed page carry the
 * figures the screen shows, to the paisa.
 */

type W = (typeof plWords)['en'];
const pct = (p: number | null): Cell => (p === null ? null : p);

function money(w: W) {
  return [
    { header: `${w.col.sales} ₹`, kind: 'money' as const },
    { header: `${w.col.purchase} ₹`, kind: 'money' as const },
    { header: `${w.col.diesel} ₹`, kind: 'money' as const },
    { header: `${w.col.batta} ₹`, kind: 'money' as const },
    { header: `${w.col.enRoute} ₹`, kind: 'money' as const },
    { header: `${w.col.profit} ₹`, kind: 'money' as const },
    { header: w.col.pct, kind: 'pct' as const },
    { header: `${w.col.gstToPay} ₹`, kind: 'money' as const },
  ];
}

function moneyCells(p: Pick<PlTotals, 'sales' | 'materialCost' | 'diesel' | 'batta' | 'enRoute' | 'net' | 'profitPct' | 'gstToPay'>): Cell[] {
  return [p.sales, p.materialCost, p.diesel, p.batta, p.enRoute, p.net, pct(p.profitPct), p.gstToPay];
}

export function sheetsSheet(w: W, rows: PlSheetRow[], total: PlTotals, subtitle: string): ReportSheet {
  return {
    name: w.sheets.sheets,
    title: `${w.title} — ${w.sheets.sheets}`,
    subtitle,
    columns: [
      { header: w.col.sheet, kind: 'text' },
      { header: w.col.dates, kind: 'date' },
      { header: '', kind: 'date' },
      { header: w.col.vehicle, kind: 'text' },
      { header: w.col.driver, kind: 'text' },
      { header: w.col.trips, kind: 'number' },
      { header: w.col.customer, kind: 'text' },
      { header: w.col.km, kind: 'number' },
      ...money(w),
    ],
    rows: rows.map((r) => [
      r.sheetNumber,
      r.startDate,
      r.endDate,
      r.registrationNumber,
      r.driverName,
      r.tripNumbers.length,
      r.customers.join(', '),
      r.pl.distanceKm,
      ...moneyCells(r.pl),
    ]),
    total: [w.total, null, null, null, null, rows.reduce((n, r) => n + r.tripNumbers.length, 0), null, total.distanceKm, ...moneyCells(total)],
  };
}

export function tripsSheet(w: W, report: PlReport<PlTripReportRow>, subtitle: string): ReportSheet {
  return {
    name: w.sheets.trips,
    title: `${w.title} — ${w.sheets.trips}`,
    subtitle,
    columns: [
      { header: w.col.date, kind: 'date' },
      { header: w.col.sheet, kind: 'text' },
      { header: w.col.trip, kind: 'text' },
      { header: w.col.vehicle, kind: 'text' },
      { header: w.col.customer, kind: 'text' },
      { header: w.col.vendor, kind: 'text' },
      { header: w.col.material, kind: 'text' },
      { header: w.col.km, kind: 'number' },
      ...money(w),
    ],
    rows: report.rows.map((r) => [
      r.date,
      r.sheetNumber,
      r.tripNumber ?? (r.kind === 'payment' ? w.sheetPayment : w.noTripYet),
      r.registrationNumber,
      r.customers.join(', '),
      r.vendors.join(', '),
      r.materials.join(', '),
      r.pl.distanceKm,
      ...moneyCells(r.pl),
    ]),
    total: [w.total, null, String(report.total.trips), null, null, null, null, report.total.distanceKm, ...moneyCells(report.total)],
  };
}

export function vehiclesSheet(w: W, report: PlReport<PlVehicleRow>, subtitle: string): ReportSheet {
  return {
    name: w.sheets.vehicles,
    title: `${w.title} — ${w.sheets.vehicles}`,
    subtitle,
    columns: [
      { header: w.col.vehicle, kind: 'text' },
      { header: w.col.trips, kind: 'number' },
      { header: w.col.km, kind: 'number' },
      { header: w.col.litres, kind: 'number' },
      { header: w.col.mileage, kind: 'number' },
      ...money(w),
    ],
    rows: report.rows.map((r) => [`${r.registrationNumber} · ${r.vehicleModel}`, r.trips, r.distanceKm, r.dieselLitres, r.mileageKmpl, ...moneyCells(r)]),
    total: [w.total, report.total.trips, report.total.distanceKm, report.total.dieselLitres, report.total.mileageKmpl, ...moneyCells(report.total)],
  };
}

export function monthsSheet(w: W, report: PlReport<PlMonthRow>, monthLabel: (m: string) => string, subtitle: string): ReportSheet {
  return {
    name: w.sheets.months,
    title: `${w.title} — ${w.sheets.months}`,
    subtitle,
    columns: [
      { header: w.col.month, kind: 'text' },
      { header: w.col.trips, kind: 'number' },
      { header: w.col.km, kind: 'number' },
      ...money(w),
    ],
    rows: report.rows.map((r) => [monthLabel(r.month), r.trips, r.distanceKm, ...moneyCells(r)]),
    total: [w.total, report.total.trips, report.total.distanceKm, ...moneyCells(report.total)],
  };
}

export function outstandingSheet(
  w: W,
  report: PlReport<PlOutstandingRow, PlOutstandingTotal>,
  role: 'customer' | 'vendor',
  subtitle: string,
): ReportSheet {
  const key = role === 'customer' ? 'customers' : 'vendors';
  return {
    name: w.sheets[key],
    title: `${w.title} — ${w.sheets[key]}`,
    subtitle,
    columns: [
      { header: w.col.name, kind: 'text' },
      { header: w.col.gstin, kind: 'text' },
      { header: w.col.trips, kind: 'number' },
      { header: `${w.col.billed} ₹`, kind: 'money' },
      {
        header: `${role === 'customer' ? w.col.received : w.col.paid} ₹`,
        kind: 'money',
      },
      { header: `${w.col.due} ₹`, kind: 'money' },
      { header: w.col.status, kind: 'text' },
      { header: w.col.since, kind: 'date' },
      { header: w.col.last, kind: 'date' },
    ],
    rows: report.rows.map((r) => [r.name, r.gstin, r.trips, r.billed, r.settled, r.due, w.status[r.status], r.firstDate, r.lastDate]),
    total: [w.total, null, null, report.total.billed, report.total.settled, report.total.due, null, null, null],
  };
}

export function customersPlSheet(w: W, rows: CustomerPlRow[], total: PlTotals, subtitle: string): ReportSheet {
  return {
    name: w.sheets.customersPl,
    title: `${w.title} — ${w.sheets.customersPl}`,
    subtitle,
    columns: [{ header: w.col.customer, kind: 'text' }, { header: w.col.trips, kind: 'number' }, ...money(w)],
    rows: rows.map((r) => [r.name, r.trips, ...moneyCells(r)]),
    total: [w.total, rows.reduce((n, r) => n + r.trips, 0), ...moneyCells(total)],
  };
}
