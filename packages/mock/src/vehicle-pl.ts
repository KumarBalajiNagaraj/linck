import { buildGstin, businessDate, purchaseFigures, saleFigures } from '@linck/domain';
import { CUSTOMERS_MASTER, DRIVERS, EXPENSE_BILLS, FUEL_ENTRIES, PURCHASE_ORDERS, VEHICLES } from './data.js';
import { between, makeRng, money, NOW, pick } from './seed.js';
import type {
  PlAttachment,
  PlDieselInput,
  PlEnRouteInput,
  PlGstRate,
  PlMaintenanceKind,
  PlMaterial,
  PlParty,
  PlPaymentInput,
  PlPurchaseInput,
  PlSaleInput,
} from './types.js';

/**
 * The vehicle P&L's demo data (LIN-22), shaped on the owner's workbook: four
 * tippers' trip sheets from mid-May to the mock's today, as the API stores
 * them — what was typed and picked, with every derived figure left for
 * packages/domain/src/vehicle-pl.ts to work out.
 *
 * A sheet is one vehicle and driver for one to three days; its trips are the
 * loads. Mixed on purpose: diesel, batta and en-route costs written on the
 * sheet (shared out by km where every trip has a reading, else evenly) or on a
 * trip; GST and non-GST purchases; transport on some sales; customers and
 * vendors paid in full, in part or not yet, on a trip or in one sum on the
 * sheet; and, where they fall, real diesel bills from Expenses and fuel
 * entries from the register, linked rather than typed again.
 */

type WithId<T> = Omit<T, 'id'> & { id: string };

export interface PlDieselRecord extends WithId<Omit<PlDieselInput, 'attachmentId'>> {
  attachment: PlAttachment | null;
}

export interface PlEnRouteRecord extends WithId<Omit<PlEnRouteInput, 'attachmentId'>> {
  attachment: PlAttachment | null;
}

export interface PlPurchaseRecord extends WithId<Omit<PlPurchaseInput, 'attachmentIds'>> {
  hsnCode: string | null;
  unit: string;
  gstRatePct: number;
  vendorGstin: string | null;
  attachments: PlAttachment[];
}

export interface PlSaleRecord extends WithId<Omit<PlSaleInput, 'poAttachmentId' | 'dcAttachmentId'>> {
  hsnCode: string | null;
  unit: string;
  gstRatePct: number;
  partyGstin: string | null;
  poAttachment: PlAttachment | null;
  dcAttachment: PlAttachment | null;
}

export type PlPaymentRecord = WithId<PlPaymentInput>;

export interface PlClosureRecord {
  partyId: string;
  billed: string;
  closedBy: string;
  closedAt: string;
}

/** A trip as stored: its lines with their ids, and accounts' closures. */
export interface PlTripRecord {
  id: string;
  tripNumber: string;
  date: string;
  startKm: number | null;
  endKm: number | null;
  batta: string | null;
  notes: string;
  diesel: PlDieselRecord[];
  enRoute: PlEnRouteRecord[];
  purchases: PlPurchaseRecord[];
  sales: PlSaleRecord[];
  payments: PlPaymentRecord[];
  closures: PlClosureRecord[];
}

/** A trip sheet as stored. */
export interface PlSheetRecord {
  id: string;
  sheetNumber: string;
  siteId: string;
  vehicleId: string;
  registrationNumber: string;
  vehicleModel: string;
  driverId: string | null;
  driverName: string;
  driverPhone: string;
  startDate: string;
  endDate: string | null;
  startKm: number | null;
  endKm: number | null;
  batta: string | null;
  notes: string;
  diesel: PlDieselRecord[];
  enRoute: PlEnRouteRecord[];
  payments: PlPaymentRecord[];
  trips: PlTripRecord[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const rng = makeRng(20261101);

/** The Material DB: name, HSN, unit and the GST rate a new line starts at. */
export const PL_MATERIALS: PlMaterial[] = [
  { id: 'mat-msand', code: 'MSAND', name: 'M-Sand', hsnCode: '2517', gstRatePct: 5, unit: 'unit', active: true },
  { id: 'mat-psand', code: 'PSAND', name: 'P-Sand', hsnCode: '2517', gstRatePct: 5, unit: 'unit', active: true },
  { id: 'mat-agg20', code: 'AGG20', name: '20mm Aggregate', hsnCode: '2517', gstRatePct: 5, unit: 'tonne', active: true },
  { id: 'mat-agg40', code: 'AGG40', name: '40mm Aggregate', hsnCode: '2517', gstRatePct: 5, unit: 'tonne', active: true },
  { id: 'mat-gsb', code: 'GSB', name: 'GSB', hsnCode: '2517', gstRatePct: 5, unit: 'tonne', active: true },
  { id: 'mat-boulder', code: null, name: 'Rough stone', hsnCode: '2516', gstRatePct: 5, unit: 'load', active: false },
];

/** The tenant's GST rates, as master.gst_rates holds them: a list to edit, not a constant. */
export const PL_GST_RATES: PlGstRate[] = [0, 5, 12, 18, 28].map((ratePct) => ({ id: `gst-${ratePct}`, ratePct, active: true }));

/** What a load costs at the quarry or crusher, per unit of the material, before ±8%. */
const BUY_RATE: Record<string, number> = {
  'mat-msand': 2950,
  'mat-psand': 3350,
  'mat-agg20': 780,
  'mat-agg40': 720,
  'mat-gsb': 560,
};

const loc = (partyId: string, names: string[]) => names.map((name, i) => ({ id: `${partyId}-l${i + 1}`, name }));

/** Quarries, crushers, a sand depot that bills without GST, and the bunks diesel is bought at. */
export const PL_VENDORS: PlParty[] = [
  { id: 'ven-pallur', name: 'Pallur Blue Metals', gstin: buildGstin('33', 'AAKFP4417M'), phone: '9444017722', contactName: 'Ramesh P', roles: ['vendor'], locations: loc('ven-pallur', ['Pallur quarry', 'Walajabad yard']) },
  { id: 'ven-padappai', name: 'Sri Balaji Crusher, Padappai', gstin: buildGstin('33', 'ABJFS2208Q'), phone: '9841166530', contactName: 'Balaji S', roles: ['vendor'], locations: loc('ven-padappai', ['Padappai crusher']) },
  { id: 'ven-vengadam', name: 'Vengadamangalam Stone Crusher', gstin: buildGstin('33', 'AAHFV7761C'), phone: '9790033118', contactName: 'Kumaresan V', roles: ['vendor'], locations: loc('ven-vengadam', ['Vengadamangalam', 'Kandigai stock yard']) },
  { id: 'ven-oragadam', name: 'Oragadam Sand Depot', gstin: null, phone: '9003147788', contactName: 'Mani', roles: ['vendor'], locations: loc('ven-oragadam', ['Oragadam depot']) },
  { id: 'ven-sakthi', name: 'Sakthi Fuels, Karapakkam', gstin: buildGstin('33', 'AASFS3120K'), phone: '9444120034', contactName: 'Senthil', roles: ['vendor'], locations: [] },
  { id: 'ven-iocl', name: 'IOCL — Sri Murugan Agencies', gstin: buildGstin('33', 'AAIFS9081L'), phone: '9840221190', contactName: 'Murugan', roles: ['vendor'], locations: [] },
];
const QUARRIES = PL_VENDORS.slice(0, 4);
const BUNKS = PL_VENDORS.slice(4);

/** The customer database the sales desk keeps, with where each takes delivery. */
export const PL_CUSTOMERS: PlParty[] = CUSTOMERS_MASTER.map((c) => ({
  id: c.id,
  name: c.name,
  gstin: c.gstin,
  phone: c.phone === '–' ? '' : c.phone,
  contactName: c.contactName,
  roles: ['customer'],
  locations: loc(c.id, [c.name.length % 2 ? 'Site office' : 'Main site', 'Second block']),
}));

const MODES = ['UPI', 'NEFT', 'Cash', 'Cheque', 'NEFT', 'UPI'] as const;
const MAINTENANCE: { kind: PlMaintenanceKind; amount: [number, number]; description?: string }[] = [
  { kind: 'greasing', amount: [250, 450] },
  { kind: 'tyre_rotation', amount: [400, 800] },
  { kind: 'wheel_alignment', amount: [600, 900] },
  { kind: 'engine_oil', amount: [700, 1400] },
  { kind: 'coolant', amount: [200, 400] },
  { kind: 'misc', amount: [150, 600], description: 'Horn repair' },
];

/** The four tippers whose sheets are kept: two 35-tonners and a 48 on Karapakkam, one 35 at Thiruvallur. */
const FLEET = ['veh-001', 'veh-002', 'veh-003', 'veh-004'].map((id) => VEHICLES.find((v) => v.id === id)!);

const DAY = 86_400_000;
const today = businessDate(NOW);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(Date.parse(`${day}T00:00:00Z`) + n * DAY);
const ageOf = (day: string) => (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY;
const start = addDays(today, -89);
const round50 = (n: number) => money(Math.round(n / 50) * 50);

/** Real fills in Linck, per vehicle: an expense bill and a fuel entry, each linked once. */
const FILLS = FLEET.flatMap((v) => {
  const bill = EXPENSE_BILLS.find((b) => b.kind === 'diesel' && b.vehicleId === v.id && b.status !== 'rejected' && b.status !== 'deleted');
  const entry = FUEL_ENTRIES.find((e) => e.vehicleId === v.id);
  return [
    bill ? { vehicleId: v.id, day: businessDate(bill.billDate), source: 'expense_bill' as const, id: bill.id, litres: bill.litres ?? 0 } : null,
    entry ? { vehicleId: v.id, day: businessDate(entry.date), source: 'fuel_entry' as const, id: entry.id, litres: entry.litres } : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null && f.day <= today);
});
const usedFills = new Set<string>();

let sheetSerial = 0;
let tripSerial = 0;
let billSeq = 4100;
let paperSeq = 2200;
const odometer = new Map(FLEET.map((v) => [v.id, v.odometerKm - 9000]));

function paidOn(day: string, after: number): string {
  const d = addDays(day, after);
  return d > today ? today : d;
}

function reference(mode: (typeof MODES)[number]): string | null {
  if (mode === 'Cash') return null;
  if (mode === 'Cheque') return String(Math.floor(between(rng, 100000, 999999)));
  return `${mode === 'UPI' ? 'UPI' : 'UTIB'}${Math.floor(between(rng, 1e9, 9e9))}`;
}

function linkedLine(id: string, fill: (typeof FILLS)[number]): PlDieselRecord {
  if (fill.source === 'expense_bill') return { id, source: 'expense_bill', expenseBillId: fill.id, attachment: null };
  const e = FUEL_ENTRIES.find((x) => x.id === fill.id)!;
  return {
    id,
    source: 'fuel_entry',
    fuelEntryId: e.id,
    litres: e.litres,
    amount: e.amount,
    billNumber: e.billNumber ?? '',
    vendor: e.source === 'own_bunk' ? 'Own bunk' : 'Outside bunk',
    filledAt: e.date,
    attachment: null,
  };
}

function typedLine(id: string, km: number, big: boolean): PlDieselRecord {
  billSeq += 1;
  const kmpl = big ? between(rng, 2.6, 3.2, 2) : between(rng, 3.2, 4.0, 2);
  return {
    id,
    source: 'typed',
    litres: Math.max(8, Math.round((km / kmpl) * 10) / 10),
    rate: money(between(rng, 92.8, 95.6, 2)),
    vendorId: pick(rng, BUNKS).id,
    billNumber: `HP/${billSeq}`,
    attachment: null,
  };
}

function enRoute(id: string, day: string, kind: 'toll' | 'police' | 'maintenance'): PlEnRouteRecord {
  if (kind === 'toll') {
    return { id, kind, date: day, location: pick(rng, ['Sriperumbudur', 'Paranur', 'Vanagaram', 'Chennasamudram']), reference: `FT${Math.floor(between(rng, 1e8, 9e8))}`, amount: money(pick(rng, [85, 120, 175, 240, 315])), attachment: null };
  }
  if (kind === 'police') {
    return { id, kind, date: day, location: pick(rng, ['Tambaram', 'Oragadam check post']), reference: '', amount: round50(between(rng, 100, 400)), attachment: null };
  }
  const m = pick(rng, MAINTENANCE);
  return { id, kind, maintenanceKind: m.kind, description: m.description ?? '', date: day, location: 'Karapakkam workshop', reference: '', amount: round50(between(rng, ...m.amount)), attachment: null };
}

function trip(vehicle: (typeof FLEET)[number], day: string, km: number | null): PlTripRecord {
  tripSerial += 1;
  const id = `tp-${String(tripSerial).padStart(4, '0')}`;
  const big = vehicle.classTonnes >= 48;
  const material = pick(rng, PL_MATERIALS.filter((m) => m.active));
  const qty = material.unit === 'unit' ? between(rng, big ? 7 : 5, big ? 10 : 7, 1) : between(rng, big ? 30 : 20, big ? 42 : 32, 1);
  const buyRate = BUY_RATE[material.id]! * between(rng, 0.92, 1.08, 3);
  const vendor = pick(rng, QUARRIES);
  const gstBuy = vendor.gstin !== null;
  const purchases: PlPurchaseRecord[] = [
    {
      id: `${id}-p1`,
      vendorId: vendor.id,
      location: vendor.locations[0]?.name ?? '',
      materialId: material.id,
      hsnCode: material.hsnCode,
      unit: material.unit,
      quantity: qty,
      rate: money(buyRate),
      gstBilled: gstBuy,
      gstRatePct: gstBuy ? material.gstRatePct : 0,
      vendorGstin: vendor.gstin,
      invoiceNumber: gstBuy ? `${vendor.name.slice(0, 3).toUpperCase()}/${(billSeq += 1)}` : `CASH-${(billSeq += 1)}`,
      invoiceDate: day,
      attachments: [],
    },
  ];
  // Usually one customer takes the load; now and then it is split between two.
  const split = rng() < 0.12;
  const customers = split ? [pick(rng, PL_CUSTOMERS), pick(rng, PL_CUSTOMERS)] : [pick(rng, PL_CUSTOMERS)];
  const sales: PlSaleRecord[] = customers.map((c, i) => {
    const part = split ? (i === 0 ? 0.6 : 0.4) : 1;
    const order = PURCHASE_ORDERS.find((o) => o.customerId === c.id && o.status !== 'rejected');
    const counter = c.gstin === null;
    const gst = !(counter && rng() < 0.5);
    paperSeq += 1;
    return {
      id: `${id}-s${i + 1}`,
      customerId: c.id,
      location: c.locations[0]?.name ?? '',
      purchaseOrderId: order && !counter ? order.id : null,
      poRef: order && !counter ? order.customerPoRef : '',
      materialId: material.id,
      hsnCode: material.hsnCode,
      unit: material.unit,
      quantity: Math.round(qty * part * 10) / 10,
      rate: money(buyRate * between(rng, 1.22, 1.45, 3)),
      transport: rng() < 0.4 ? round50(between(rng, 1500, 4500)) : null,
      gstBilled: gst,
      gstRatePct: gst ? material.gstRatePct : 0,
      partyGstin: c.gstin,
      challanNumber: `DC/${paperSeq}`,
      invoiceNumber: counter ? '' : `LNK/26-27/${paperSeq}`,
      poAttachment: null,
      dcAttachment: null,
    };
  });
  const startKm = km === null ? null : odometer.get(vehicle.id)!;
  return {
    id,
    tripNumber: `TRP/26-27/${String(tripSerial).padStart(4, '0')}`,
    date: day,
    startKm,
    endKm: startKm === null || km === null ? null : startKm + km,
    batta: null,
    notes: '',
    diesel: [],
    enRoute: rng() < 0.15 ? [enRoute(`${id}-e1`, day, 'toll')] : [],
    purchases,
    sales,
    payments: [],
    closures: [],
  };
}

/** Older trips are mostly settled; recent ones partly paid, or not yet. */
function share(old: boolean): number {
  const roll = rng();
  if (old) return roll < 0.7 ? 1 : roll < 0.9 ? between(rng, 0.4, 0.8, 2) : 0;
  return roll < 0.3 ? between(rng, 0.3, 0.6, 2) : 0;
}

/** A full payment is the bill to the paisa; a part payment a round figure. */
function payment(id: string, direction: 'in' | 'out', partyId: string, total: string, part: number, day: string): PlPaymentRecord {
  const mode = pick(rng, MODES);
  return {
    id,
    direction,
    partyId,
    paidOn: paidOn(day, Math.floor(between(rng, 1, 20))),
    mode,
    reference: reference(mode),
    amount: part === 1 ? total : money(Math.max(100, Math.floor((Number(total) * part) / 100) * 100)),
    note: '',
  };
}

function sheet(vehicle: (typeof FLEET)[number], first: string, days: number): PlSheetRecord {
  sheetSerial += 1;
  const id = `ts-${String(sheetSerial).padStart(4, '0')}`;
  const last = addDays(first, days - 1);
  const big = vehicle.classTonnes >= 48;
  const driver = DRIVERS.find((d) => d.id === vehicle.driverId) ?? DRIVERS[0]!;
  const old = ageOf(last) > 25;
  const open = last >= today && rng() < 0.5;
  // On about a third of the sheets every trip carries its own km reading.
  const perTripKm = rng() < 0.35;
  const sheetStartKm = odometer.get(vehicle.id)!;
  const trips: PlTripRecord[] = [];
  let totalKm = 0;
  for (let d = 0; d < days; d++) {
    const day = addDays(first, d);
    const loads = 1 + Math.floor(between(rng, 0, big ? 2.4 : 3));
    for (let i = 0; i < loads; i++) {
      const km = Math.round(between(rng, 24, 120));
      const t = trip(vehicle, day, perTripKm ? km : null);
      odometer.set(vehicle.id, odometer.get(vehicle.id)! + km + Math.floor(between(rng, 2, 12)));
      totalKm += km;
      trips.push(t);
    }
  }
  const endKm = odometer.get(vehicle.id)!;

  // Diesel on the sheet: a real fill in Linck when one falls in its days, else the bunk's bill typed.
  const fill = FILLS.find((f) => f.vehicleId === vehicle.id && f.day >= first && f.day <= last && !usedFills.has(f.id));
  const diesel: PlDieselRecord[] = [];
  if (fill) {
    usedFills.add(fill.id);
    diesel.push(linkedLine(`${id}-d1`, fill));
  } else {
    diesel.push(typedLine(`${id}-d1`, totalKm * (days > 1 ? 0.7 : 1), big));
    if (days > 1) diesel.push(typedLine(`${id}-d2`, totalKm * 0.3, big));
  }
  const en: PlEnRouteRecord[] = [];
  const tolls = Math.floor(between(rng, 0, 3));
  for (let i = 0; i < tolls; i++) en.push(enRoute(`${id}-e${en.length + 1}`, addDays(first, i % days), 'toll'));
  if (rng() < 0.25) en.push(enRoute(`${id}-e${en.length + 1}`, first, 'police'));
  if (rng() < 0.2) en.push(enRoute(`${id}-e${en.length + 1}`, last, 'maintenance'));

  // Money: on a trip, or one sum on the sheet from a customer who took several loads.
  const payments: PlPaymentRecord[] = [];
  const byCustomer = new Map<string, number>();
  for (const t of trips) {
    for (const s of t.sales) {
      const total = saleFigures(s).total;
      if (trips.length > 1 && rng() < 0.35) {
        byCustomer.set(s.customerId, (byCustomer.get(s.customerId) ?? 0) + Number(total));
        continue;
      }
      const part = share(old);
      if (part > 0) t.payments.push(payment(`${t.id}-m${t.payments.length + 1}`, 'in', s.customerId, total, part, t.date));
    }
    const p = t.purchases[0]!;
    const part = share(old);
    if (part > 0) t.payments.push(payment(`${t.id}-m${t.payments.length + 1}`, 'out', p.vendorId, purchaseFigures(p).total, part, t.date));
  }
  for (const [customerId, total] of byCustomer) {
    const part = share(old);
    if (part > 0) payments.push(payment(`${id}-m${payments.length + 1}`, 'in', customerId, money(total), part, last));
  }
  // Accounts closed most of the old trips a customer paid in full on the trip itself.
  for (const t of trips) {
    if (!old || t.sales.length !== 1 || rng() < 0.4) continue;
    const s = t.sales[0]!;
    const total = saleFigures(s).total;
    const paid = t.payments.filter((m) => m.direction === 'in' && m.partyId === s.customerId).reduce((a, m) => a + Number(m.amount), 0);
    if (paid >= Number(total)) t.closures.push({ partyId: s.customerId, billed: total, closedBy: 'Lakshmi N', closedAt: `${paidOn(t.date, 22)}T11:30:00+05:30` });
  }

  const at = new Date(`${first}T${String(8 + (sheetSerial % 9)).padStart(2, '0')}:${String((sheetSerial * 7) % 60).padStart(2, '0')}:00+05:30`).toISOString();
  return {
    id,
    sheetNumber: `TS/26-27/${String(sheetSerial).padStart(4, '0')}`,
    siteId: vehicle.siteId,
    vehicleId: vehicle.id,
    registrationNumber: vehicle.displayReg,
    vehicleModel: vehicle.model,
    driverId: driver.id,
    driverName: driver.name,
    driverPhone: driver.phone,
    startDate: first,
    endDate: open ? null : last,
    startKm: sheetStartKm,
    // A vehicle still out has no end reading yet.
    endKm: open ? null : endKm,
    batta: money(Math.round(between(rng, 500, 900) / 50) * 50 * days),
    notes: '',
    diesel,
    enRoute: en,
    payments,
    trips,
    createdBy: 'Anbu Selvan M',
    createdAt: at,
    updatedAt: at,
  };
}

function seedSheets(): PlSheetRecord[] {
  const out: PlSheetRecord[] = [];
  for (const vehicle of FLEET) {
    let day = addDays(start, Math.floor(between(rng, 0, 3)));
    while (day <= today) {
      const days = Math.min(1 + Math.floor(between(rng, 0, 3)), ageOf(day) + 1);
      out.push(sheet(vehicle, day, days));
      day = addDays(day, days + Math.floor(between(rng, 0, 3)));
    }
  }
  return out;
}

export const PL_SHEET_RECORDS: PlSheetRecord[] = seedSheets();
