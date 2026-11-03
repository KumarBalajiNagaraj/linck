import { DRIVERS, VEHICLES, type PlDieselSource, type PlEnRouteKind, type PlMaintenanceKind, type PlSheetInput, type PlSheetRecord } from '@linck/mock';
import { todayIso } from './plStore.js';

/**
 * A trip sheet as its page's form holds it (LIN-22): every field as typed,
 * a string, with each saved trip's and line's id; and the two ways across —
 * from a sheet as stored (`fromRecord`) and to what a save sends
 * (`toInput`, the API's SheetIn). The demo store and, live, the API answer
 * the same shapes, so one form serves both. No React here, so the tests take
 * a sheet from the API through the form and back.
 */

let seq = 0;
export const key = () => `k${(seq += 1)}`;
export const MODES = ['UPI', 'NEFT', 'RTGS', 'IMPS', 'Cheque', 'Cash'] as const;
export const MAINT: PlMaintenanceKind[] = ['tyre_rotation', 'wheel_alignment', 'greasing', 'engine_oil', 'coolant', 'misc'];

export interface DDiesel { key: string; id?: string; source: PlDieselSource; litres: string; rate: string; amount: string; vendorId: string; vendor: string; billNumber: string; expenseBillId: string; fuelEntryId: string; filledAt: string | null; attachmentId: string | null }
export interface DRoad { key: string; id?: string; kind: PlEnRouteKind; maintenanceKind: string; description: string; date: string; location: string; reference: string; amount: string; attachmentId: string | null }
export interface DPurchase { key: string; id?: string; vendorId: string; location: string; materialId: string; hsnCode: string; unit: string; quantity: string; rate: string; gstBilled: boolean; gstRatePct: string; vendorGstin: string; invoiceNumber: string; invoiceDate: string; attachmentIds: string[] }
export interface DSale { key: string; id?: string; customerId: string; location: string; purchaseOrderId: string; poRef: string; materialId: string; hsnCode: string; unit: string; quantity: string; rate: string; transport: string; gstBilled: boolean; gstRatePct: string; partyGstin: string; challanNumber: string; invoiceNumber: string; poAttachmentId: string | null; dcAttachmentId: string | null }
export interface DPayment { key: string; id?: string; direction: 'in' | 'out'; partyId: string; paidOn: string; mode: (typeof MODES)[number]; reference: string; amount: string; note: string }
export interface DTrip { key: string; id?: string; tripNumber?: string; date: string; startKm: string; endKm: string; batta: string; notes: string; diesel: DDiesel[]; enRoute: DRoad[]; purchases: DPurchase[]; sales: DSale[]; payments: DPayment[]; more: boolean }
export interface Draft { siteId: string; vehicleId: string; registrationNumber: string; vehicleModel: string; driverId: string; driverName: string; driverPhone: string; startDate: string; endDate: string; startKm: string; endKm: string; batta: string; notes: string; diesel: DDiesel[]; enRoute: DRoad[]; payments: DPayment[]; trips: DTrip[] }

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
/** A stored value as a form field holds it: blank for nothing. */
export const asText = s;
export const num = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
export const amount = (v: string) => (v.trim() === '' ? null : v.trim());

export const blankDiesel = (): DDiesel => ({ key: key(), source: 'typed', litres: '', rate: '', amount: '', vendorId: '', vendor: '', billNumber: '', expenseBillId: '', fuelEntryId: '', filledAt: null, attachmentId: null });
export const blankRoad = (date: string): DRoad => ({ key: key(), kind: 'toll', maintenanceKind: '', description: '', date, location: '', reference: '', amount: '', attachmentId: null });
export const blankPurchase = (date: string): DPurchase => ({ key: key(), vendorId: '', location: '', materialId: '', hsnCode: '', unit: '', quantity: '', rate: '', gstBilled: true, gstRatePct: '', vendorGstin: '', invoiceNumber: '', invoiceDate: date, attachmentIds: [] });
export const blankSale = (): DSale => ({ key: key(), customerId: '', location: '', purchaseOrderId: '', poRef: '', materialId: '', hsnCode: '', unit: '', quantity: '', rate: '', transport: '', gstBilled: true, gstRatePct: '', partyGstin: '', challanNumber: '', invoiceNumber: '', poAttachmentId: null, dcAttachmentId: null });
export const blankPayment = (direction: 'in' | 'out', date: string): DPayment => ({ key: key(), direction, partyId: '', paidOn: date, mode: 'UPI', reference: '', amount: '', note: '' });
export const blankTrip = (date: string): DTrip => ({ key: key(), date, startKm: '', endKm: '', batta: '', notes: '', diesel: [], enRoute: [], purchases: [blankPurchase(date)], sales: [blankSale()], payments: [], more: false });

export function fromRecord(r: PlSheetRecord): Draft {
  const diesel = (d: PlSheetRecord['diesel'][number]): DDiesel => ({ key: key(), id: d.id, source: d.source, litres: s(d.litres), rate: s(d.rate), amount: s(d.amount), vendorId: d.vendorId ?? '', vendor: d.vendor ?? '', billNumber: d.billNumber ?? '', expenseBillId: d.expenseBillId ?? '', fuelEntryId: d.fuelEntryId ?? '', filledAt: d.filledAt ?? null, attachmentId: d.attachment?.id ?? null });
  const road = (e: PlSheetRecord['enRoute'][number]): DRoad => ({ key: key(), id: e.id, kind: e.kind, maintenanceKind: e.maintenanceKind ?? '', description: e.description ?? '', date: e.date ?? '', location: e.location ?? '', reference: e.reference ?? '', amount: s(e.amount), attachmentId: e.attachment?.id ?? null });
  const pay = (m: PlSheetRecord['payments'][number]): DPayment => ({ key: key(), id: m.id, direction: m.direction, partyId: m.partyId, paidOn: m.paidOn, mode: m.mode, reference: m.reference ?? '', amount: s(m.amount), note: m.note ?? '' });
  return {
    siteId: r.siteId,
    vehicleId: r.vehicleId,
    registrationNumber: r.registrationNumber,
    vehicleModel: r.vehicleModel,
    driverId: r.driverId ?? '',
    driverName: r.driverName,
    driverPhone: r.driverPhone,
    startDate: r.startDate,
    endDate: r.endDate ?? '',
    startKm: s(r.startKm),
    endKm: s(r.endKm),
    batta: s(r.batta),
    notes: r.notes,
    diesel: r.diesel.map(diesel),
    enRoute: r.enRoute.map(road),
    payments: r.payments.map(pay),
    trips: [...r.trips]
      .sort((a, b) => (a.date === b.date ? a.tripNumber.localeCompare(b.tripNumber) : a.date < b.date ? -1 : 1))
      .map((t) => ({
        key: key(),
        id: t.id,
        tripNumber: t.tripNumber,
        date: t.date,
        startKm: s(t.startKm),
        endKm: s(t.endKm),
        batta: s(t.batta),
        notes: t.notes,
        diesel: t.diesel.map(diesel),
        enRoute: t.enRoute.map(road),
        payments: t.payments.map(pay),
        more: t.diesel.length + t.enRoute.length > 0 || t.batta !== null || t.startKm !== null,
        purchases: t.purchases.map((p) => ({ key: key(), id: p.id, vendorId: p.vendorId, location: p.location ?? '', materialId: p.materialId, hsnCode: p.hsnCode ?? '', unit: p.unit, quantity: s(p.quantity), rate: s(p.rate), gstBilled: p.gstBilled, gstRatePct: p.gstBilled ? s(p.gstRatePct) : '', vendorGstin: p.vendorGstin ?? '', invoiceNumber: p.invoiceNumber ?? '', invoiceDate: p.invoiceDate ?? '', attachmentIds: p.attachments.map((a) => a.id) })),
        sales: t.sales.map((x) => ({ key: key(), id: x.id, customerId: x.customerId, location: x.location ?? '', purchaseOrderId: x.purchaseOrderId ?? '', poRef: x.poRef ?? '', materialId: x.materialId, hsnCode: x.hsnCode ?? '', unit: x.unit, quantity: s(x.quantity), rate: s(x.rate), transport: s(x.transport), gstBilled: x.gstBilled, gstRatePct: x.gstBilled ? s(x.gstRatePct) : '', partyGstin: x.partyGstin ?? '', challanNumber: x.challanNumber ?? '', invoiceNumber: x.invoiceNumber ?? '', poAttachmentId: x.poAttachment?.id ?? null, dcAttachmentId: x.dcAttachment?.id ?? null })),
      })),
  };
}

export function blankDraft(grantsSite: (siteId: string) => boolean): Draft {
  const today = todayIso();
  const vehicle = VEHICLES.find((v) => grantsSite(v.siteId));
  const driver = DRIVERS.find((d) => d.id === vehicle?.driverId);
  return {
    siteId: vehicle?.siteId ?? '',
    vehicleId: vehicle?.id ?? '',
    registrationNumber: vehicle?.displayReg ?? '',
    vehicleModel: vehicle?.model ?? '',
    driverId: driver?.id ?? '',
    driverName: driver?.name ?? '',
    driverPhone: driver?.phone ?? '',
    startDate: today,
    endDate: today,
    startKm: '',
    endKm: '',
    batta: '',
    notes: '',
    diesel: [blankDiesel()],
    enRoute: [],
    payments: [],
    trips: [blankTrip(today)],
  };
}

/**
 * A new sheet, live: no fleet list on the API to pick a vehicle or a driver
 * from (expenses/bills.ts), so both are typed; the site is one where the
 * person keeps sheets.
 */
export function typedBlankDraft(siteId: string): Draft {
  const today = todayIso();
  return {
    siteId,
    vehicleId: '',
    registrationNumber: '',
    vehicleModel: '',
    driverId: '',
    driverName: '',
    driverPhone: '',
    startDate: today,
    endDate: today,
    startKm: '',
    endKm: '',
    batta: '',
    notes: '',
    diesel: [blankDiesel()],
    enRoute: [],
    payments: [],
    trips: [blankTrip(today)],
  };
}

export function toInput(d: Draft): PlSheetInput {
  const diesel = (x: DDiesel) => ({
    id: x.id ?? null,
    source: x.source,
    ...(x.source === 'expense_bill'
      ? { expenseBillId: x.expenseBillId || null }
      : x.source === 'fuel_entry'
        ? { fuelEntryId: x.fuelEntryId || null, litres: num(x.litres), amount: amount(x.amount), billNumber: x.billNumber, vendor: x.vendor, filledAt: x.filledAt }
        : { litres: num(x.litres), rate: amount(x.rate), vendorId: x.vendorId || null, billNumber: x.billNumber, attachmentId: x.attachmentId }),
  });
  const road = (x: DRoad) => ({ id: x.id ?? null, kind: x.kind, maintenanceKind: x.kind === 'maintenance' ? (x.maintenanceKind as PlMaintenanceKind) || null : null, description: x.description, date: x.date || null, location: x.location, reference: x.reference, amount: x.amount.trim(), attachmentId: x.attachmentId });
  const pay = (x: DPayment) => ({ id: x.id ?? null, direction: x.direction, partyId: x.partyId, paidOn: x.paidOn, mode: x.mode, reference: x.reference.trim().toUpperCase() || null, amount: x.amount.trim(), note: x.note });
  return {
    siteId: d.siteId,
    vehicleId: d.vehicleId,
    registrationNumber: d.registrationNumber,
    vehicleModel: d.vehicleModel,
    driverId: d.driverId || null,
    driverName: d.driverName,
    driverPhone: d.driverPhone,
    startDate: d.startDate,
    endDate: d.endDate || null,
    startKm: num(d.startKm),
    endKm: num(d.endKm),
    batta: amount(d.batta),
    notes: d.notes,
    diesel: d.diesel.map(diesel),
    enRoute: d.enRoute.map(road),
    payments: d.payments.map(pay),
    trips: d.trips.map((t) => ({
      id: t.id ?? null,
      date: t.date,
      startKm: num(t.startKm),
      endKm: num(t.endKm),
      batta: amount(t.batta),
      notes: t.notes,
      diesel: t.diesel.map(diesel),
      enRoute: t.enRoute.map(road),
      payments: t.payments.map(pay),
      purchases: t.purchases.map((p) => ({ id: p.id ?? null, vendorId: p.vendorId, location: p.location, materialId: p.materialId, hsnCode: p.hsnCode || null, unit: p.unit || null, quantity: num(p.quantity) ?? 0, rate: p.rate.trim(), gstBilled: p.gstBilled, gstRatePct: p.gstBilled ? num(p.gstRatePct) : null, vendorGstin: p.vendorGstin.trim().toUpperCase() || null, invoiceNumber: p.invoiceNumber, invoiceDate: p.invoiceDate || null, attachmentIds: p.attachmentIds })),
      sales: t.sales.map((x) => ({ id: x.id ?? null, customerId: x.customerId, location: x.location, purchaseOrderId: x.purchaseOrderId || null, poRef: x.poRef, materialId: x.materialId, hsnCode: x.hsnCode || null, unit: x.unit || null, quantity: num(x.quantity) ?? 0, rate: x.rate.trim(), transport: amount(x.transport), gstBilled: x.gstBilled, gstRatePct: x.gstBilled ? num(x.gstRatePct) : null, partyGstin: x.partyGstin.trim().toUpperCase() || null, challanNumber: x.challanNumber, invoiceNumber: x.invoiceNumber, poAttachmentId: x.poAttachmentId, dcAttachmentId: x.dcAttachmentId })),
    })),
  };
}
