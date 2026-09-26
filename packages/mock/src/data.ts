import { buildGstin, PRODUCT_DENSITIES, unitsToTonnes, weighbridgeVariancePct } from '@linck/domain';
import type {
  Alert,
  BreakdownRecord,
  ExpenseBill,
  ComplianceDocument,
  Customer,
  Driver,
  EwayBill,
  ExtractionJob,
  FuelEntry,
  GstinStanding,
  Indent,
  Invoice,
  Product,
  ProductionRun,
  PurchaseOrder,
  Receipt,
  Site,
  StockPosition,
  Trip,
  Vehicle,
  VehicleStatus,
} from './types.js';
import { between, daysFromNow, hoursFromNow, makeRng, money, NOW, pick } from './seed.js';

const rng = makeRng(20260808);

export const SITES: Site[] = [
  { id: 'site-krp', code: 'KRP-CRUSHER-01', name: 'Karapakkam Crusher', kind: 'crusher' },
  { id: 'site-tvl', code: 'TVL-CRUSHER-02', name: 'Thiruvallur Crusher', kind: 'crusher' },
  { id: 'site-qry', code: 'PLR-QUARRY-01', name: 'Pallur Quarry', kind: 'quarry' },
  { id: 'site-wsp', code: 'KRP-WORKSHOP', name: 'Karapakkam Workshop', kind: 'workshop' },
];

export const PRODUCTS: Product[] = [
  { code: 'MSAND', label: 'M-Sand', category: 'sand' },
  { code: 'PSAND', label: 'P-Sand', category: 'sand' },
  { code: 'AGG6', label: '6mm Aggregate', category: 'aggregate' },
  { code: 'AGG10', label: '10mm Aggregate', category: 'aggregate' },
  { code: 'AGG20', label: '20mm Aggregate', category: 'aggregate' },
  { code: 'AGG40', label: '40mm Aggregate', category: 'aggregate' },
  { code: 'GSB', label: 'GSB', category: 'base' },
  { code: 'WMM', label: 'WMM', category: 'base' },
  { code: 'DUST', label: 'Crusher Dust', category: 'byproduct' },
];

const DRIVER_NAMES = [
  'Murugan S', 'Ravi Kumar A', 'Selvam P', 'Karthik R', 'Anbu Selvan M', 'Dhanapal K',
  'Vetrivel S', 'Manikandan T', 'Saravanan G', 'Prabhu D', 'Ilango V', 'Gopinath N',
  'Rajendran C', 'Sathish Kumar B', 'Elumalai R', 'Thangaraj P', 'Balamurugan S',
  'Chandran K', 'Ganesan M', 'Arumugam L', 'Sekar V', 'Palani S', 'Mohan Raj T',
  'Vijayakumar N', 'Ashok Kumar P', 'Suresh Babu R', 'Kannan D', 'Ramesh S',
  'Jeyaseelan A', 'Muthukumar V', 'Sivakumar R', 'Natarajan P', 'Perumal K',
  'Velmurugan S', 'Ashwin Kumar', 'Bharathi R', 'Deepak M', 'Lokesh V', 'Sundar T',
  'Aravind K', 'Vignesh S', 'Hariharan P', 'Kalaiselvan M', 'Nithyanandam R',
  'Ponnusamy G', 'Rajesh Kanna', 'Senthil Kumar N', 'Tamilarasan V', 'Udhayakumar S',
  'Yuvaraj M', 'Bhaskar R', 'Chinnadurai P', 'Ezhilarasan K', 'Gunasekaran V', 'Jagadeesan A',
];

const MODELS = [
  { name: 'Tata Signa 3525.TK', tonnes: 35 },
  { name: 'Ashok Leyland 3525 8x4', tonnes: 35 },
  { name: 'BharatBenz 3532R', tonnes: 35 },
  { name: 'Tata Signa 4825.TK', tonnes: 48 },
  { name: 'Ashok Leyland 4825 10x2', tonnes: 48 },
];

const CUSTOMERS = [
  { id: 'cus-01', name: 'Casagrand Builder Pvt Ltd', site: 'Sholinganallur Phase 2' },
  { id: 'cus-02', name: 'Sri Venkateswara Constructions', site: 'Perumbakkam Site' },
  { id: 'cus-03', name: 'Radiance Realty', site: 'Navalur Block C' },
  { id: 'cus-04', name: 'TN Highways Contractor — Kancheepuram', site: 'NH-48 Package 3' },
  { id: 'cus-05', name: 'Alliance Infra', site: 'Thalambur Layout' },
  { id: 'cus-06', name: 'Counter Cash Sale', site: 'Ex-plant' },
  { id: 'cus-07', name: 'Purva Developers', site: 'Padur Site 1' },
];

/* ---------------------------------------------------------------- vehicles */

const STATUS_PLAN: VehicleStatus[] = [
  ...Array<VehicleStatus>(26).fill('on_trip'),
  ...Array<VehicleStatus>(12).fill('ready'),
  ...Array<VehicleStatus>(8).fill('idle'),
  ...Array<VehicleStatus>(6).fill('under_service'),
  ...Array<VehicleStatus>(4).fill('breakdown'),
  ...Array<VehicleStatus>(2).fill('off_road'),
];

const BREAKDOWN_REASONS = ['Gearbox oil leak', 'Tyre burst — rear left', 'Alternator failure', 'Clutch plate worn'];
const SERVICE_REASONS = ['Scheduled 40,000 km service', 'Brake reline', 'Hydraulic hose replacement', 'FC preparation'];
const IDLE_REASONS = ['No load allotted', 'Driver on leave', 'Awaiting permit renewal', 'Awaiting loading slot'];

export const VEHICLES: Vehicle[] = STATUS_PLAN.map((status, i) => {
  const model = MODELS[i % MODELS.length]!;
  const seriesLetters = ['AB', 'AL', 'BX', 'CQ', 'DK'][Math.floor(i / 12) % 5]!;
  const num = 1001 + i * 7;
  const district = [29, 38, 20, 12][i % 4]!;
  const reg = `TN${district}${seriesLetters}${num}`;
  const display = `TN ${district} ${seriesLetters} ${num}`;
  const siteId = i % 3 === 2 ? 'site-tvl' : 'site-krp';

  const docDays = i % 11 === 0 ? -Math.floor(between(rng, 1, 20)) : i % 5 === 0 ? Math.floor(between(rng, 2, 28)) : Math.floor(between(rng, 40, 300));
  const docType = pick(rng, ['Insurance', 'Fitness certificate', 'National permit', 'Road tax', 'PUC']);

  const benchmark = model.tonnes === 48 ? 2.9 : 3.6;
  const lastKmpl = status === 'off_road' ? null : Math.round((benchmark + between(rng, -0.9, 0.45, 2)) * 100) / 100;

  const statusReason =
    status === 'breakdown'
      ? pick(rng, BREAKDOWN_REASONS)
      : status === 'under_service'
        ? pick(rng, SERVICE_REASONS)
        : status === 'idle'
          ? pick(rng, IDLE_REASONS)
          : status === 'off_road'
            ? 'Fitness certificate expired'
            : undefined;

  const onTrip = status === 'on_trip';

  return {
    id: `veh-${String(i + 1).padStart(3, '0')}`,
    registrationNumber: reg,
    displayReg: display,
    model: model.name,
    classTonnes: model.tonnes,
    siteId,
    status,
    statusSince: hoursFromNow(-between(rng, 1, 96, 1)),
    ...(statusReason ? { statusReason } : {}),
    odometerKm: Math.floor(between(rng, 84_000, 412_000)),
    driverId: status === 'off_road' || status === 'under_service' ? null : `drv-${String((i % DRIVER_NAMES.length) + 1).padStart(3, '0')}`,
    lastKmpl,
    benchmarkKmpl: benchmark,
    nextDocExpiryDays: docDays,
    nextDocType: docType,
    serviceDueInKm: i % 7 === 0 ? Math.floor(between(rng, -800, 600)) : Math.floor(between(rng, 900, 9000)),
    tripsToday: onTrip ? Math.floor(between(rng, 1, 5)) : status === 'ready' ? Math.floor(between(rng, 0, 3)) : 0,
    tonnesToday: onTrip ? between(rng, 35, 190, 1) : status === 'ready' ? between(rng, 0, 110, 1) : 0,
  };
});

/* ---------------------------------------------------------------- drivers */

export const DRIVERS: Driver[] = DRIVER_NAMES.map((name, i) => {
  const vehicle = VEHICLES.find((v) => v.driverId === `drv-${String(i + 1).padStart(3, '0')}`);
  const attendance: Driver['attendance'] = vehicle?.status === 'on_trip' ? 'on_trip' : i % 13 === 0 ? 'absent' : i % 17 === 0 ? 'leave' : i % 11 === 0 ? 'rest' : 'present';
  return {
    id: `drv-${String(i + 1).padStart(3, '0')}`,
    name,
    phone: `9${Math.floor(between(rng, 100000000, 999999999))}`,
    licenceNumber: `TN${Math.floor(between(rng, 10, 99))}${Math.floor(between(rng, 20100000000, 20239999999))}`,
    licenceExpiry: daysFromNow(Math.floor(between(rng, -30, 1400))),
    attendance,
    vehicleId: vehicle?.id ?? null,
    siteId: i % 3 === 2 ? 'site-tvl' : 'site-krp',
  };
});

/* ------------------------------------------------------------ fuel entries */

export const FUEL_ENTRIES: FuelEntry[] = Array.from({ length: 42 }, (_, i) => {
  const vehicle = VEHICLES[i % VEHICLES.length]!;
  const litres = between(rng, 120, 320, 1);
  const rate = between(rng, 92.4, 97.8, 2);
  const fullTank = i % 4 !== 3;
  const implied = fullTank ? Math.round((vehicle.benchmarkKmpl + between(rng, -1.1, 0.4, 2)) * 100) / 100 : null;
  return {
    id: `fuel-${String(i + 1).padStart(3, '0')}`,
    date: hoursFromNow(-between(rng, 1, 220, 1)),
    vehicleId: vehicle.id,
    driverId: vehicle.driverId,
    litres,
    ratePerLitre: money(rate),
    amount: money(litres * rate),
    odometerKm: vehicle.odometerKm - Math.floor(between(rng, 0, 900)),
    fullTank,
    source: i % 5 === 0 ? 'outside_bunk' : 'own_bunk',
    billNumber: i % 5 === 0 ? `BK/${Math.floor(between(rng, 10000, 99999))}` : null,
    impliedKmpl: implied,
    provenance: i % 6 === 0 ? 'proposed' : i % 6 === 1 ? 'confirmed' : i % 11 === 0 ? 'overridden' : 'human',
  };
});

/* ------------------------------------------------------------- documents */

const DOC_TYPES: { type: ComplianceDocument['type']; label: string; issuer: string; blocks: boolean }[] = [
  { type: 'insurance', label: 'Insurance', issuer: 'United India Insurance', blocks: true },
  { type: 'fitness', label: 'Fitness certificate', issuer: 'RTO Chennai (South)', blocks: true },
  { type: 'permit', label: 'State permit', issuer: 'TN Transport Dept', blocks: true },
  { type: 'national_permit', label: 'National permit', issuer: 'TN Transport Dept', blocks: false },
  { type: 'road_tax', label: 'Road tax', issuer: 'TN Transport Dept', blocks: true },
  { type: 'puc', label: 'PUC', issuer: 'Authorised centre', blocks: false },
];

export const DOCUMENTS: ComplianceDocument[] = VEHICLES.flatMap((vehicle, vi) =>
  DOC_TYPES.map((doc, di) => {
    const isNext = di === vi % DOC_TYPES.length;
    const daysLeft = isNext && vehicle.nextDocExpiryDays !== null ? vehicle.nextDocExpiryDays : Math.floor(between(rng, 35, 640));
    return {
      id: `doc-${vehicle.id}-${doc.type}`,
      vehicleId: vehicle.id,
      type: doc.type,
      label: doc.label,
      number: `${doc.type.slice(0, 3).toUpperCase()}/${Math.floor(between(rng, 100000, 999999))}`,
      expiresOn: daysFromNow(daysLeft),
      daysLeft,
      cost: money(between(rng, 1200, 48000, 2)),
      issuer: doc.issuer,
      blocksOperation: doc.blocks,
    };
  }),
);

/*
 * One truth per vehicle about its papers. The vehicle's "next document" is
 * derived from its actual documents rather than seeded beside them, and an
 * off-road tipper whose recorded reason is an expired fitness certificate has
 * one on file. Runs after every random draw above, so no seeded number moves.
 */
for (const vehicle of VEHICLES) {
  if (vehicle.status === 'off_road') {
    const fitness = DOCUMENTS.find((d) => d.vehicleId === vehicle.id && d.type === 'fitness');
    if (fitness && fitness.daysLeft >= 0) {
      fitness.daysLeft = -14;
      fitness.expiresOn = daysFromNow(-14);
    }
  }
  const soonest = DOCUMENTS.filter((d) => d.vehicleId === vehicle.id).sort((a, b) => a.daysLeft - b.daysLeft)[0];
  if (soonest) {
    vehicle.nextDocExpiryDays = soonest.daysLeft;
    vehicle.nextDocType = soonest.label;
  }
}

/* ------------------------------------------------------------------ stock */

export const STOCK: StockPosition[] = PRODUCTS.flatMap((product) =>
  ['site-krp', 'site-tvl'].map((siteId, si) => {
    const units = between(rng, si === 0 ? 40 : 12, si === 0 ? 900 : 420, 1);
    const safety = product.category === 'sand' ? 200 : 120;
    return {
      productCode: product.code,
      siteId,
      units,
      tonnes: Math.round(unitsToTonnes(units, product.code) * 10) / 10,
      safetyUnits: safety,
      producedTodayUnits: between(rng, 0, 160, 1),
      dispatchedTodayUnits: between(rng, 0, 140, 1),
      lastCountedOn: daysFromNow(-Math.floor(between(rng, 1, 26))),
      countVarianceUnits: between(rng, -14, 9, 1),
    };
  }),
);

/* ------------------------------------------------------------- production */

export const PRODUCTION_RUNS: ProductionRun[] = Array.from({ length: 14 }, (_, i) => {
  const boulderIn = between(rng, 320, 940, 1);
  const yields: { code: string; pct: number }[] = [
    { code: 'MSAND', pct: 0.28 },
    { code: 'PSAND', pct: 0.11 },
    { code: 'AGG20', pct: 0.19 },
    { code: 'AGG12', pct: 0.0 },
    { code: 'AGG10', pct: 0.14 },
    { code: 'AGG6', pct: 0.08 },
    { code: 'DUST', pct: 0.16 },
  ].filter((y) => y.pct > 0);

  const outputs = yields.map((y) => {
    const tonnes = Math.round(boulderIn * y.pct * (1 + between(rng, -0.06, 0.06, 3)) * 10) / 10;
    const density = PRODUCT_DENSITIES[y.code]?.tonnesPerUnit ?? 4.6;
    return { productCode: y.code, units: Math.round((tonnes / density) * 10) / 10, tonnes };
  });

  const outTotal = outputs.reduce((s, o) => s + o.tonnes, 0);
  const massBalance = Math.round(((boulderIn - outTotal) / boulderIn) * 1000) / 10;
  const downtime = between(rng, 0, 3.5, 1);

  return {
    id: `run-${String(i + 1).padStart(3, '0')}`,
    date: daysFromNow(-Math.floor(i / 2)),
    shift: i % 2 === 0 ? 'day' : 'night',
    siteId: i % 3 === 2 ? 'site-tvl' : 'site-krp',
    crusher: i % 3 === 2 ? 'Cone — TVL 200TPH' : 'Jaw + VSI — KRP 250TPH',
    operator: pick(rng, ['Kaliyaperumal R', 'Sekar M', 'Arivazhagan T', 'Muthu S']),
    runHours: Math.round((10 - downtime) * 10) / 10,
    downtimeHours: downtime,
    downtimeReason: downtime > 1.5 ? pick(rng, ['Belt slip', 'Power outage — TNEB', 'Jaw plate change', 'Feeder jam']) : null,
    boulderInTonnes: boulderIn,
    outputs,
    massBalancePct: massBalance,
    provenance: i % 5 === 0 ? 'proposed' : 'human',
  };
});

/* ------------------------------------------------------------------ trips */

const TRIP_STATUS_PLAN: Trip['status'][] = [
  ...Array<Trip['status']>(9).fill('in_transit'),
  ...Array<Trip['status']>(6).fill('loaded'),
  ...Array<Trip['status']>(5).fill('delivered'),
  ...Array<Trip['status']>(7).fill('completed'),
  ...Array<Trip['status']>(3).fill('planned'),
  ...Array<Trip['status']>(2).fill('returned'),
];

export const TRIPS: Trip[] = TRIP_STATUS_PLAN.map((status, i) => {
  const vehicle = VEHICLES[(i * 3) % VEHICLES.length]!;
  const customer = CUSTOMERS[i % CUSTOMERS.length]!;
  const product = PRODUCTS[i % PRODUCTS.length]!;
  const soldUnits = between(rng, 4, 11, 1);
  const rate = between(rng, 3800, 7200, 0);
  const revenue = soldUnits * rate;
  const distance = between(rng, 12, 74, 1);
  const diesel = (distance * 2 * between(rng, 0.28, 0.36, 3)) * 95;
  const batta = between(rng, 500, 1400, 0);
  const toll = between(rng, 0, 720, 0);
  const materialCost = soldUnits * between(rng, 2100, 3400, 0);
  const isCounterCash = customer.id === 'cus-06';
  const returned = status === 'returned';

  const weighed = i % 3 === 0 ? Math.round(unitsToTonnes(soldUnits, product.code) * (1 + between(rng, -0.09, 0.06, 3)) * 10) / 10 : null;
  const variance = weighed !== null ? Math.round(weighbridgeVariancePct(weighed, soldUnits, product.code) * 10) / 10 : null;

  return {
    id: `trip-${String(i + 1).padStart(3, '0')}`,
    tripNumber: `TRP/26-27/${String(4820 + i)}`,
    date: hoursFromNow(-between(rng, 0.5, 60, 1)),
    status,
    vehicleId: vehicle.id,
    driverId: vehicle.driverId,
    customerId: customer.id,
    customerSite: customer.site,
    productCode: product.code,
    soldUnits,
    qtyBasis: i % 4 === 0 ? 'plant_weighbridge' : i % 4 === 1 ? 'loader_buckets' : i % 4 === 2 ? 'agreed_units' : 'customer_weighbridge',
    weighedTonnes: weighed,
    variancePct: variance,
    distanceKm: distance,
    ratePerUnit: money(rate),
    // A returned load produces ZERO revenue and full cost. That is the point.
    revenue: money(returned ? 0 : revenue),
    costDiesel: money(diesel),
    costBatta: money(batta),
    costToll: money(toll),
    materialCost: money(returned ? 0 : materialCost),
    margin: money((returned ? 0 : revenue - materialCost) - diesel - batta - toll),
    // Most intra-TN tipper loads sit under the ₹1,00,000 consignment threshold,
    // so "not required" is the normal path, not an exception.
    ewbRequired: revenue > 100_000,
    ewbNumber: revenue > 100_000 ? `${Math.floor(between(rng, 141000000000, 191999999999))}` : null,
    invoiceId: status === 'completed' && !isCounterCash ? `inv-${String((i % 12) + 1).padStart(3, '0')}` : null,
    rateOverridden: i % 9 === 0,
    purpose: i % 17 === 0 ? 'own_use' : 'sale',
  };
});

/* --------------------------------------------------------------- invoices */

const INV_STATUS: Invoice['status'][] = [
  'payment_reported', 'part_paid', 'issued', 'overdue', 'payment_verified',
  'issued', 'part_paid', 'overdue', 'payment_reported', 'closed', 'issued', 'draft',
];

export const INVOICES: Invoice[] = INV_STATUS.map((status, i) => {
  const customer = CUSTOMERS[i % (CUSTOMERS.length - 1)]!;
  const taxable = between(rng, 84_000, 1_240_000, 0);
  const gst = taxable * 0.05;
  const total = taxable + gst;
  const verified = status === 'closed' || status === 'payment_verified' ? total : status === 'part_paid' ? total * between(rng, 0.3, 0.75, 3) : 0;
  const reported = status === 'payment_reported' ? total * between(rng, 0.6, 1, 3) : 0;
  const overdueDays = status === 'overdue' ? Math.floor(between(rng, 3, 68)) : 0;

  return {
    id: `inv-${String(i + 1).padStart(3, '0')}`,
    number: `LNK/26-27/${String(1180 + i)}`,
    date: daysFromNow(-Math.floor(between(rng, 2, 78))),
    dueDate: daysFromNow(overdueDays > 0 ? -overdueDays : Math.floor(between(rng, 2, 30))),
    customerId: customer.id,
    customerName: customer.name,
    status,
    taxableValue: money(taxable),
    gstAmount: money(gst),
    total: money(total),
    receivedVerified: money(verified),
    receivedReported: money(reported),
    balanceDue: money(total - verified),
    daysOverdue: overdueDays,
    irn: taxable > 500_000 ? `${Math.floor(between(rng, 10, 99))}f4a...${Math.floor(between(rng, 1000, 9999))}` : null,
    ewbNumbers: taxable > 400_000 ? [`${Math.floor(between(rng, 141000000000, 191999999999))}`] : [],
    tripIds: TRIPS.filter((t) => t.invoiceId === `inv-${String(i + 1).padStart(3, '0')}`).map((t) => t.id),
  };
});

/* --------------------------------------------------------------- receipts */

export const RECEIPTS: Receipt[] = Array.from({ length: 11 }, (_, i) => {
  const invoice = INVOICES[i % INVOICES.length]!;
  const amount = between(rng, 40_000, 720_000, 0);
  const verified = i % 3 === 0;
  const method = pick(rng, ['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash'] as const);
  const exactUtr = i % 4 === 0;

  return {
    id: `rcp-${String(i + 1).padStart(3, '0')}`,
    date: daysFromNow(-Math.floor(between(rng, 0, 12))),
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    amount: money(amount),
    method,
    reference: method === 'cash' ? null : `${method === 'cheque' ? 'CHQ' : 'UTR'}${Math.floor(between(rng, 100000000, 999999999))}`,
    recordedBy: pick(rng, ['Lakshmi N', 'Priya R', 'Ganesh K']),
    verifiedBy: verified ? 'Ganesh K' : null,
    verifiedAt: verified ? daysFromNow(-Math.floor(between(rng, 0, 4))) : null,
    suggestedInvoiceId: invoice.id,
    suggestionReason: exactUtr
      ? 'UTR exact, amount exact, date +1d'
      : i % 3 === 1
        ? 'Amount exact, customer match, no UTR on bank line'
        : 'Oldest open invoice for this customer, amount within ₹500',
    allocatedInvoiceIds: verified ? [invoice.id] : [],
    provenance: exactUtr ? 'device' : 'human',
  };
});

/* ------------------------------------------------------------- extraction */

export const EXTRACTION_JOBS: ExtractionJob[] = [
  {
    id: 'ext-001',
    documentType: 'diesel_bill',
    label: 'Diesel bill — Sakthi Fuels, Karapakkam',
    capturedAt: hoursFromNow(-1.4),
    capturedBy: 'Murugan S (driver)',
    siteId: 'site-krp',
    postsSummary:
      'Posts 1 diesel entry against TN 29 AB 1001, 1 purchase invoice line to Diesel Expense, and 1 vendor payable of ₹41,280.',
    duplicateOf: null,
    fields: [
      { key: 'vehicle', label: 'Vehicle', value: 'TN 29 AB 1001', confidence: 3, confirmed: false, overriddenFrom: null },
      { key: 'litres', label: 'Litres', value: '432.00', confidence: 2, confirmed: false, overriddenFrom: null, unit: 'L' },
      { key: 'rate', label: 'Rate', value: '95.55', confidence: 3, confirmed: false, overriddenFrom: null, unit: '₹/L' },
      { key: 'amount', label: 'Amount', value: '41280.00', confidence: 3, confirmed: false, overriddenFrom: null, unit: '₹' },
      { key: 'odometer', label: 'Odometer', value: '218460', confidence: 1, confirmed: false, overriddenFrom: null, unit: 'km' },
      { key: 'bill_no', label: 'Bill number', value: 'BK/48213', confidence: 2, confirmed: false, overriddenFrom: null },
    ],
  },
  {
    id: 'ext-002',
    documentType: 'weighbridge_slip',
    label: 'Weighbridge slip — KRP bridge, ticket 88214',
    capturedAt: hoursFromNow(-3.1),
    capturedBy: 'Sekar M (weighbridge)',
    siteId: 'site-krp',
    postsSummary: 'Posts 1 weighbridge ticket against trip TRP/26-27/4823 and updates the trip net weight to 34.20 MT.',
    duplicateOf: null,
    fields: [
      { key: 'ticket', label: 'Ticket number', value: '88214', confidence: 3, confirmed: false, overriddenFrom: null },
      { key: 'vehicle', label: 'Vehicle', value: 'TN 38 AL 1050', confidence: 2, confirmed: false, overriddenFrom: null },
      { key: 'gross', label: 'Gross', value: '48.60', confidence: 3, confirmed: false, overriddenFrom: null, unit: 'MT' },
      { key: 'tare', label: 'Tare', value: '14.40', confidence: 2, confirmed: false, overriddenFrom: null, unit: 'MT' },
      { key: 'net', label: 'Net', value: '34.20', confidence: 3, confirmed: false, overriddenFrom: null, unit: 'MT' },
    ],
  },
  {
    id: 'ext-003',
    documentType: 'insurance_renewal',
    label: 'Insurance renewal — United India, TN 20 BX 1120',
    capturedAt: hoursFromNow(-19),
    capturedBy: 'Priya R (accounts)',
    siteId: 'site-krp',
    postsSummary: 'Updates the insurance expiry for TN 20 BX 1120 to 14-08-2027 and posts a ₹38,420 premium to Vehicle Insurance.',
    duplicateOf: null,
    fields: [
      { key: 'vehicle', label: 'Vehicle', value: 'TN 20 BX 1120', confidence: 3, confirmed: false, overriddenFrom: null },
      { key: 'policy', label: 'Policy number', value: 'UII/2026/8841203', confidence: 2, confirmed: false, overriddenFrom: null },
      { key: 'expiry', label: 'Valid until', value: '14-08-2027', confidence: 3, confirmed: false, overriddenFrom: null },
      { key: 'premium', label: 'Premium', value: '38420.00', confidence: 1, confirmed: false, overriddenFrom: null, unit: '₹' },
    ],
  },
  {
    id: 'ext-004',
    documentType: 'vendor_invoice',
    label: 'Vendor invoice — Annai Tyres, 4 × 295/90 R20',
    capturedAt: hoursFromNow(-26),
    capturedBy: 'Ganesh K (stores)',
    siteId: 'site-wsp',
    postsSummary: 'Posts a GRN for 4 tyres into Karapakkam Workshop stores and a ₹1,04,800 payable to Annai Tyres.',
    duplicateOf: 'Vendor invoice AT/2026/1188 captured 2 days ago',
    fields: [
      { key: 'vendor', label: 'Vendor', value: 'Annai Tyres', confidence: 3, confirmed: false, overriddenFrom: null },
      { key: 'invoice_no', label: 'Invoice number', value: 'AT/2026/1188', confidence: 3, confirmed: false, overriddenFrom: null },
      { key: 'qty', label: 'Quantity', value: '4', confidence: 3, confirmed: false, overriddenFrom: null, unit: 'nos' },
      { key: 'amount', label: 'Amount', value: '104800.00', confidence: 2, confirmed: false, overriddenFrom: null, unit: '₹' },
      { key: 'gstin', label: 'Vendor GSTIN', value: '33AAECA1234F1ZP', confidence: 1, confirmed: false, overriddenFrom: null },
    ],
  },
];

/* ---------------------------------------------------------------- indents */

export const INDENTS: Indent[] = [
  { id: 'ind-001', number: 'IND/26-27/0412', raisedOn: hoursFromNow(-2), raisedBy: 'Kaliyaperumal R', siteId: 'site-krp', itemName: 'Jaw plate — fixed, Mn18', itemCode: 'SP-JAW-F18', quantity: 2, uom: 'nos', forAsset: 'Jaw + VSI — KRP 250TPH', requestedFor: 'plant', status: 'submitted', urgency: 'urgent', stockOnHand: 0, reorderLevel: 2, estimatedValue: '184000.00' },
  { id: 'ind-002', number: 'IND/26-27/0411', raisedOn: hoursFromNow(-6), raisedBy: 'Anbu Selvan M', siteId: 'site-wsp', itemName: 'Engine oil 15W-40', itemCode: 'CN-OIL-1540', quantity: 200, uom: 'L', forAsset: 'TN 29 AB 1001', requestedFor: 'fleet', status: 'approved', urgency: 'routine', stockOnHand: 60, reorderLevel: 150, estimatedValue: '38000.00' },
  { id: 'ind-003', number: 'IND/26-27/0410', raisedOn: hoursFromNow(-9), raisedBy: 'Sekar M', siteId: 'site-krp', itemName: 'Conveyor belt 800mm EP400', itemCode: 'SP-BELT-800', quantity: 24, uom: 'm', forAsset: 'Jaw + VSI — KRP 250TPH', requestedFor: 'plant', status: 'submitted', urgency: 'breakdown', stockOnHand: 0, reorderLevel: 12, estimatedValue: '96000.00' },
  { id: 'ind-004', number: 'IND/26-27/0409', raisedOn: hoursFromNow(-27), raisedBy: 'Ganesh K', siteId: 'site-wsp', itemName: 'Tyre 295/90 R20', itemCode: 'TY-29590-20', quantity: 4, uom: 'nos', forAsset: 'TN 38 AB 1008', requestedFor: 'fleet', status: 'issued', urgency: 'routine', stockOnHand: 6, reorderLevel: 8, estimatedValue: '104800.00' },
  { id: 'ind-005', number: 'IND/26-27/0408', raisedOn: hoursFromNow(-34), raisedBy: 'Arivazhagan T', siteId: 'site-tvl', itemName: 'Cone liner — mantle', itemCode: 'SP-CON-MNT', quantity: 1, uom: 'nos', forAsset: 'Cone — TVL 200TPH', requestedFor: 'plant', status: 'approved', urgency: 'urgent', stockOnHand: 1, reorderLevel: 1, estimatedValue: '212000.00' },
  { id: 'ind-006', number: 'IND/26-27/0407', raisedOn: hoursFromNow(-48), raisedBy: 'Muthu S', siteId: 'site-krp', itemName: 'DEF / AdBlue 20L', itemCode: 'CN-DEF-20', quantity: 30, uom: 'nos', forAsset: null, requestedFor: 'fleet', status: 'rejected', urgency: 'routine', stockOnHand: 22, reorderLevel: 10, estimatedValue: '21000.00' },
];

/* ----------------------------------------------------------------- alerts */

export const ALERTS: Alert[] = [
  { id: 'alr-1', kind: 'breakdown', status: 'critical', title: '4 vehicles under breakdown', detail: 'TN 29 AB 1015 down 11h — gearbox oil leak. Longest standing.', at: hoursFromNow(-11), route: '/fleet/vehicles' },
  { id: 'alr-2', kind: 'expiry', status: 'critical', title: '5 documents already expired', detail: 'Includes 2 fitness certificates, which stop the vehicle at the gate.', at: hoursFromNow(-30), route: '/compliance/documents' },
  { id: 'alr-3', kind: 'expiry', status: 'attention', title: '11 documents expire within 30 days', detail: 'Insurance on 4 tippers, national permit on 2.', at: hoursFromNow(-30), route: '/compliance/documents' },
  { id: 'alr-4', kind: 'receivable', status: 'attention', title: '₹18.4 L reported but not verified', detail: '4 receipts await a second pair of eyes. Invoices stay open until then.', at: hoursFromNow(-5), route: '/finance/receipts/verification' },
  { id: 'alr-5', kind: 'anomaly', status: 'attention', title: 'Mileage dropped 18% on TN 12 CQ 1085', detail: 'Three consecutive full-tank fills below 2.6 km/l against a 3.6 benchmark.', at: hoursFromNow(-8), route: '/fleet/vehicles' },
  { id: 'alr-6', kind: 'approval', status: 'pending', title: '2 breakdown indents await approval', detail: 'Conveyor belt for KRP crusher — plant is down.', at: hoursFromNow(-9), route: '/stores/indents' },
];

/* ------------------------------------------------------------ e-way bills */

/** GST state codes that appear in this dataset. */
export const GST_STATE_NAMES: Record<string, string> = {
  '29': 'Karnataka',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '37': 'Andhra Pradesh',
};

export const GST_STATE_ABBR: Record<string, string> = {
  '29': 'KA',
  '32': 'KL',
  '33': 'TN',
  '34': 'PY',
  '37': 'AP',
};

/**
 * The group's registrations.
 *
 * Two supplying entities and a separate transporter entity — the ordinary
 * shape once a client has both a crusher and a fleet. The Thiruvallur LLP has
 * missed two consecutive GSTR-3B periods, so as of this morning the portal
 * refuses to raise anything on it.
 */
export const GSTIN_STANDINGS: GstinStanding[] = [
  {
    gstin: '33AABCK4521P1ZR',
    legalEntityName: 'Karapakkam Blue Metals Pvt Ltd',
    stateCode: '33',
    role: 'supplier',
    lastFiledPeriod: 'June 2026',
    missedReturnPeriods: [],
    blocked: false,
    blockedSince: null,
  },
  {
    gstin: '33AAGCT9182M1Z8',
    legalEntityName: 'Thiruvallur Aggregates LLP',
    stateCode: '33',
    role: 'supplier',
    lastFiledPeriod: 'April 2026',
    missedReturnPeriods: ['May 2026', 'June 2026'],
    blocked: true,
    blockedSince: '2026-08-08T01:45:00Z',
  },
  {
    gstin: '33AAJCK7745Q1ZM',
    legalEntityName: 'Karapakkam Carriers',
    stateCode: '33',
    role: 'transporter',
    lastFiledPeriod: 'June 2026',
    missedReturnPeriods: [],
    blocked: false,
    blockedSince: null,
  },
];

const KBM = '33AABCK4521P1ZR';
const TAL = '33AAGCT9182M1Z8';
const CARRIERS = '33AAJCK7745Q1ZM';

/**
 * Written out by hand rather than generated, because every row here exists to
 * carry one rule: the threshold asymmetry, the 15-day Part A window, the
 * 200 km validity slab, the 20 km ODC slab, the under-50 km Part B exemption,
 * the 24-hour cancellation window, the 138E block, and one trip carrying two
 * bills after a cancel-and-regenerate.
 */
export const EWAY_BILLS: EwayBill[] = [
  {
    id: 'ewb-2601', siteId: 'site-krp', ewbNumber: '181432790614', stage: 'active', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4901', invoiceNumber: 'KBM/26-27/1188', documentDate: '2026-08-08T03:20:00Z',
    generatedAt: '2026-08-08T03:34:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-08', customerName: 'Sri Sai Ready Mix, Kolar',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Kolar', toStateCode: '29', movement: 'inter_state',
    consignmentValue: '486000.00', productCode: 'AGG20', hsnCode: '25171010', distanceKm: 312, overDimensional: false,
    supplierGstin: KBM, transporterGstin: KBM, transporterName: 'Karapakkam Blue Metals Pvt Ltd',
    partBVehicle: 'TN29AB1015', partBEnteredAt: '2026-08-08T03:50:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2602', siteId: 'site-krp', ewbNumber: '181432712208', stage: 'active', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4874', invoiceNumber: 'KBM/26-27/1171', documentDate: '2026-08-06T08:40:00Z',
    generatedAt: '2026-08-06T09:05:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-09', customerName: 'Vaishnavi Infra, Chittoor',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Chittoor', toStateCode: '37', movement: 'inter_state',
    consignmentValue: '274500.00', productCode: 'AGG10', hsnCode: '25171010', distanceKm: 186, overDimensional: false,
    supplierGstin: KBM, transporterGstin: KBM, transporterName: 'Karapakkam Blue Metals Pvt Ltd',
    partBVehicle: 'TN38AL1050', partBEnteredAt: '2026-08-06T12:40:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2603', siteId: 'site-krp', ewbNumber: '181432755417', stage: 'active', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4889', invoiceNumber: 'KBM/26-27/1179', documentDate: '2026-08-07T13:40:00Z',
    generatedAt: '2026-08-07T14:05:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-10', customerName: 'Hosur Precast Solutions',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Hosur', toStateCode: '29', movement: 'inter_state',
    consignmentValue: '192000.00', productCode: 'MSAND', hsnCode: '25171010', distanceKm: 148, overDimensional: false,
    supplierGstin: KBM, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: 'TN29BQ2210', partBEnteredAt: '2026-08-07T14:40:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2604', siteId: 'site-krp', ewbNumber: '181432791102', stage: 'active', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4903', invoiceNumber: 'KBM/26-27/1190', documentDate: '2026-08-08T05:20:00Z',
    generatedAt: '2026-08-08T05:35:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-01', customerName: 'Casagrand Builder Pvt Ltd',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Sholinganallur', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '146800.00', productCode: 'AGG20', hsnCode: '25171010', distanceKm: 42, overDimensional: false,
    supplierGstin: KBM, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: true,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2605', siteId: 'site-krp', ewbNumber: null, stage: 'not_required', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4904', invoiceNumber: 'KBM/26-27/1191', documentDate: '2026-08-08T04:10:00Z',
    generatedAt: null, cancelledAt: null, cancelReason: null,
    customerId: 'cus-02', customerName: 'Sri Venkateswara Constructions',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Perumbakkam', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '78400.00', productCode: 'MSAND', hsnCode: '25171010', distanceKm: 31, overDimensional: false,
    supplierGstin: KBM, transporterGstin: null, transporterName: null,
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: 'Intra-Tamil Nadu and below the ₹1,00,000 consignment limit', provenance: 'human',
  },
  {
    id: 'ewb-2606', siteId: 'site-krp', ewbNumber: null, stage: 'not_required', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4905', invoiceNumber: 'KBM/26-27/1192', documentDate: '2026-08-08T04:35:00Z',
    generatedAt: null, cancelledAt: null, cancelReason: null,
    customerId: 'cus-03', customerName: 'Radiance Realty',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Navalur', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '62300.00', productCode: 'PSAND', hsnCode: '25171010', distanceKm: 26, overDimensional: false,
    supplierGstin: KBM, transporterGstin: null, transporterName: null,
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: 'Intra-Tamil Nadu and below the ₹1,00,000 consignment limit', provenance: 'human',
  },
  {
    id: 'ewb-2607', siteId: 'site-krp', ewbNumber: null, stage: 'not_required', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4906', invoiceNumber: 'KBM/26-27/1193', documentDate: '2026-08-08T06:05:00Z',
    generatedAt: null, cancelledAt: null, cancelReason: null,
    customerId: 'cus-05', customerName: 'Alliance Infra',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Thalambur', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '94750.00', productCode: 'GSB', hsnCode: '25171010', distanceKm: 38, overDimensional: false,
    supplierGstin: KBM, transporterGstin: null, transporterName: null,
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: 'Intra-Tamil Nadu and below the ₹1,00,000 consignment limit', provenance: 'human',
  },
  {
    id: 'ewb-2608', siteId: 'site-krp', ewbNumber: '181432688051', stage: 'part_a_only', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4851', invoiceNumber: 'KBM/26-27/1160', documentDate: '2026-08-05T04:05:00Z',
    generatedAt: '2026-08-05T04:20:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-11', customerName: 'Malabar Constructions, Palakkad',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Palakkad', toStateCode: '32', movement: 'inter_state',
    consignmentValue: '315000.00', productCode: 'AGG40', hsnCode: '25171010', distanceKm: 268, overDimensional: false,
    supplierGstin: KBM, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2609', siteId: 'site-krp', ewbNumber: '181431944770', stage: 'part_a_only', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4702', invoiceNumber: 'KBM/26-27/1094', documentDate: '2026-07-22T06:00:00Z',
    generatedAt: '2026-07-22T06:15:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-12', customerName: 'Prestige Projects, Bengaluru',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Bengaluru', toStateCode: '29', movement: 'inter_state',
    consignmentValue: '542000.00', productCode: 'AGG20', hsnCode: '25171010', distanceKm: 348, overDimensional: false,
    supplierGstin: KBM, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2610', siteId: 'site-krp', ewbNumber: '181432601339', stage: 'cancelled', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4898', invoiceNumber: 'KBM/26-27/1185', documentDate: '2026-08-08T00:25:00Z',
    generatedAt: '2026-08-08T00:40:00Z', cancelledAt: '2026-08-08T03:10:00Z',
    cancelReason: 'Tipper broke down at the weighbridge before the load left the gate',
    customerId: 'cus-08', customerName: 'Sri Sai Ready Mix, Kolar',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Kolar', toStateCode: '29', movement: 'inter_state',
    consignmentValue: '210000.00', productCode: 'AGG10', hsnCode: '25171010', distanceKm: 312, overDimensional: false,
    supplierGstin: KBM, transporterGstin: KBM, transporterName: 'Karapakkam Blue Metals Pvt Ltd',
    partBVehicle: 'TN29AB1015', partBEnteredAt: '2026-08-08T00:55:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2611', siteId: 'site-krp', ewbNumber: '181432786620', stage: 'active', attempt: 2, supersedes: 'ewb-2610',
    tripNumber: 'TRP/26-27/4898', invoiceNumber: 'KBM/26-27/1185', documentDate: '2026-08-08T00:25:00Z',
    generatedAt: '2026-08-08T03:20:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-08', customerName: 'Sri Sai Ready Mix, Kolar',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Kolar', toStateCode: '29', movement: 'inter_state',
    consignmentValue: '210000.00', productCode: 'AGG10', hsnCode: '25171010', distanceKm: 312, overDimensional: false,
    supplierGstin: KBM, transporterGstin: KBM, transporterName: 'Karapakkam Blue Metals Pvt Ltd',
    partBVehicle: 'TN23CJ1040', partBEnteredAt: '2026-08-08T03:35:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2612', siteId: 'site-krp', ewbNumber: '181432699840', stage: 'active', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4860', invoiceNumber: 'KBM/DC/26-27/0042', documentDate: '2026-08-06T05:10:00Z',
    generatedAt: '2026-08-06T05:15:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'internal', customerName: 'Internal transfer — Thiruvallur Crusher',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Thiruvallur', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '860000.00', productCode: 'PLANT', hsnCode: '84742010', distanceKm: 168, overDimensional: true,
    supplierGstin: KBM, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: 'TN29CZ7788', partBEnteredAt: '2026-08-06T05:30:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2613', siteId: 'site-krp', ewbNumber: '181432211906', stage: 'part_a_only', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4766', invoiceNumber: 'KBM/26-27/1121', documentDate: '2026-07-26T09:20:00Z',
    generatedAt: '2026-07-26T09:40:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-04', customerName: 'TN Highways Contractor — Kancheepuram',
    fromPlace: 'Karapakkam', fromStateCode: '33', toPlace: 'Kancheepuram', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '128900.00', productCode: 'WMM', hsnCode: '25171010', distanceKm: 62, overDimensional: false,
    supplierGstin: KBM, transporterGstin: KBM, transporterName: 'Karapakkam Blue Metals Pvt Ltd',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2614', siteId: 'site-tvl', ewbNumber: null, stage: 'not_generated', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4907', invoiceNumber: 'TAL/26-27/0614', documentDate: '2026-08-08T02:40:00Z',
    generatedAt: null, cancelledAt: null, cancelReason: null,
    customerId: 'cus-12', customerName: 'Prestige Projects, Bengaluru',
    fromPlace: 'Thiruvallur', fromStateCode: '33', toPlace: 'Bengaluru', toStateCode: '29', movement: 'inter_state',
    consignmentValue: '396000.00', productCode: 'AGG20', hsnCode: '25171010', distanceKm: 302, overDimensional: false,
    supplierGstin: TAL, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2615', siteId: 'site-tvl', ewbNumber: null, stage: 'not_generated', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4908', invoiceNumber: 'TAL/26-27/0615', documentDate: '2026-08-08T03:05:00Z',
    generatedAt: null, cancelledAt: null, cancelReason: null,
    customerId: 'cus-13', customerName: 'Sree Balaji Constructions, Tirupati',
    fromPlace: 'Thiruvallur', fromStateCode: '33', toPlace: 'Tirupati', toStateCode: '37', movement: 'inter_state',
    consignmentValue: '288000.00', productCode: 'AGG10', hsnCode: '25171010', distanceKm: 214, overDimensional: false,
    supplierGstin: TAL, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2616', siteId: 'site-tvl', ewbNumber: null, stage: 'not_generated', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4909', invoiceNumber: 'TAL/26-27/0616', documentDate: '2026-08-08T03:30:00Z',
    generatedAt: null, cancelledAt: null, cancelReason: null,
    customerId: 'cus-14', customerName: 'Ramco Ready Mix, Avadi',
    fromPlace: 'Thiruvallur', fromStateCode: '33', toPlace: 'Avadi', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '172000.00', productCode: 'MSAND', hsnCode: '25171010', distanceKm: 34, overDimensional: false,
    supplierGstin: TAL, transporterGstin: TAL, transporterName: 'Thiruvallur Aggregates LLP',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: true,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2617', siteId: 'site-tvl', ewbNumber: null, stage: 'not_required', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4910', invoiceNumber: 'TAL/26-27/0617', documentDate: '2026-08-08T05:15:00Z',
    generatedAt: null, cancelledAt: null, cancelReason: null,
    customerId: 'cus-14', customerName: 'Ramco Ready Mix, Avadi',
    fromPlace: 'Thiruvallur', fromStateCode: '33', toPlace: 'Poonamallee', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '88000.00', productCode: 'DUST', hsnCode: '25171010', distanceKm: 28, overDimensional: false,
    supplierGstin: TAL, transporterGstin: TAL, transporterName: 'Thiruvallur Aggregates LLP',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: 'Intra-Tamil Nadu and below the ₹1,00,000 consignment limit — the 138E block does not touch it',
    provenance: 'human',
  },
  {
    id: 'ewb-2618', siteId: 'site-tvl', ewbNumber: '181432741188', stage: 'active', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4881', invoiceNumber: 'TAL/26-27/0603', documentDate: '2026-08-07T02:15:00Z',
    generatedAt: '2026-08-07T02:30:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-08', customerName: 'Sri Sai Ready Mix, Kolar',
    fromPlace: 'Thiruvallur', fromStateCode: '33', toPlace: 'Kolar', toStateCode: '29', movement: 'inter_state',
    consignmentValue: '342000.00', productCode: 'AGG20', hsnCode: '25171010', distanceKm: 240, overDimensional: false,
    supplierGstin: TAL, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: 'TN20BX4415', partBEnteredAt: '2026-08-07T03:10:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2619', siteId: 'site-tvl', ewbNumber: '181432780044', stage: 'active', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4895', invoiceNumber: 'TAL/26-27/0611', documentDate: '2026-08-08T00:50:00Z',
    generatedAt: '2026-08-08T01:00:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-14', customerName: 'Ramco Ready Mix, Avadi',
    fromPlace: 'Thiruvallur', fromStateCode: '33', toPlace: 'Ambattur', toStateCode: '33', movement: 'intra_state',
    consignmentValue: '240000.00', productCode: 'AGG10', hsnCode: '25171010', distanceKm: 88, overDimensional: false,
    supplierGstin: TAL, transporterGstin: TAL, transporterName: 'Thiruvallur Aggregates LLP',
    partBVehicle: 'TN20AC9033', partBEnteredAt: '2026-08-08T01:20:00Z', partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
  {
    id: 'ewb-2620', siteId: 'site-tvl', ewbNumber: '181432520071', stage: 'part_a_only', attempt: 1, supersedes: null,
    tripNumber: 'TRP/26-27/4823', invoiceNumber: 'TAL/26-27/0588', documentDate: '2026-08-02T04:45:00Z',
    generatedAt: '2026-08-02T05:00:00Z', cancelledAt: null, cancelReason: null,
    customerId: 'cus-15', customerName: 'ECR Builders, Puducherry',
    fromPlace: 'Thiruvallur', fromStateCode: '33', toPlace: 'Puducherry', toStateCode: '34', movement: 'inter_state',
    consignmentValue: '110000.00', productCode: 'PSAND', hsnCode: '25171010', distanceKm: 96, overDimensional: false,
    supplierGstin: TAL, transporterGstin: CARRIERS, transporterName: 'Karapakkam Carriers',
    partBVehicle: null, partBEnteredAt: null, partBExemptUnder50km: false,
    exemptReason: null, provenance: 'human',
  },
];

export const CUSTOMERS_LIST = CUSTOMERS;

/* ------------------------------------------------ customers and sales orders */

/*
 * A separate generator, so adding these rows cannot shift a single number in
 * the fleet, stock or invoice data seeded above them.
 */
const salesRng = makeRng(20260925);

const CONTACTS = ['Arun Prakash', 'Senthil V', 'Meena R', 'K. Rajasekar', 'Dinesh Babu', 'Walk-in', 'Prakash N'];

export const CUSTOMERS_MASTER: Customer[] = CUSTOMERS.map((c, i) => {
  const counter = c.id === 'cus-06';
  return {
    id: c.id,
    name: c.name,
    site: c.site,
    // A real PAN shape (5 letters, 4 digits, 1 letter; 4th letter C = company,
    // 5th = the name's initial) and a computed check character, so the seed
    // passes the same validation the e-invoice console will apply.
    gstin: counter
      ? null
      : buildGstin('33', `AA${String.fromCharCode(65 + i)}C${c.name[0]!.toUpperCase()}${Math.floor(between(salesRng, 1000, 9999))}K`),
    contactName: CONTACTS[i % CONTACTS.length]!,
    phone: counter ? '–' : `9${Math.floor(between(salesRng, 100000000, 999999999))}`,
    creditLimit: money(counter ? 0 : between(salesRng, 5, 40, 0) * 100_000),
    paymentTermsDays: counter ? 0 : [15, 30, 30, 45, 30, 0, 21][i % 7]!,
    servedFromSiteId: i % 3 === 2 ? 'site-tvl' : 'site-krp',
  };
});

const PO_STATUS_PLAN: PurchaseOrder['status'][] = [
  'pending_approval', 'approved', 'part_dispatched', 'pending_approval', 'fulfilled', 'approved',
  'pending_approval', 'part_dispatched', 'rejected', 'fulfilled', 'pending_approval', 'approved',
];

export const PURCHASE_ORDERS: PurchaseOrder[] = PO_STATUS_PLAN.map((status, i) => {
  const customer = CUSTOMERS[i % CUSTOMERS.length]!;
  const product = PRODUCTS[(i * 2) % PRODUCTS.length]!;
  const ordered = between(salesRng, 20, 160, 0);
  const rate = between(salesRng, 3800, 7200, 0);
  const dispatched =
    status === 'fulfilled' ? ordered : status === 'part_dispatched' ? Math.round(ordered * between(salesRng, 0.2, 0.8, 2)) : 0;
  return {
    id: `po-${String(i + 1).padStart(3, '0')}`,
    number: `SO/26-27/${String(640 + i)}`,
    customerPoRef: `PO-${customer.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}-${Math.floor(between(salesRng, 1000, 9999))}`,
    receivedOn: hoursFromNow(-between(salesRng, 2, 240, 1)),
    deliverBy: daysFromNow(Math.floor(between(salesRng, -3, 21))),
    customerId: customer.id,
    customerName: customer.name,
    deliverySite: customer.site,
    siteId: i % 3 === 2 ? 'site-tvl' : 'site-krp',
    productCode: product.code,
    orderedUnits: ordered,
    dispatchedUnits: dispatched,
    ratePerUnit: money(rate),
    value: money(ordered * rate),
    status,
    takenBy: pick(salesRng, ['Vetrivel S', 'Priya R', 'Vetrivel S']),
  };
});

/* ------------------------------------------- breakdown register and expenses */

/* Own generator again, for the same reason as the sales rows above. */
const fleetRng = makeRng(20260926);

const BREAKDOWN_LOCATIONS = ['GST Road, Chengalpattu', 'OMR near Navalur', 'Karapakkam yard', 'Poonamallee bypass', 'NH-48 Sriperumbudur'];
const REPORTERS = ['Anbu Selvan M', 'Driver (WhatsApp)', 'Sekar M'];

export const BREAKDOWNS: BreakdownRecord[] = [
  // Every vehicle down right now has an open entry — the register and the
  // board must never disagree about who is on the hard shoulder.
  ...VEHICLES.filter((v) => v.status === 'breakdown').map((v, i) => ({
    id: `bd-open-${v.id}`,
    number: `BD/26-27/${String(210 + i)}`,
    vehicleId: v.id,
    driverId: v.driverId,
    reportedAt: v.statusSince,
    reportedBy: pick(fleetRng, REPORTERS),
    location: pick(fleetRng, BREAKDOWN_LOCATIONS),
    cause: v.statusReason ?? 'Not recorded',
    status: (i % 2 === 0 ? 'open' : 'in_workshop') as BreakdownRecord['status'],
    resolvedAt: null,
    downtimeHours: Math.round((NOW.getTime() - Date.parse(v.statusSince)) / 360_000) / 10,
    repairCost: null,
  })),
  ...Array.from({ length: 8 }, (_, i): BreakdownRecord => {
    const v = VEHICLES[(i * 5 + 3) % VEHICLES.length]!;
    const hours = between(fleetRng, 3, 60, 1);
    const reported = hoursFromNow(-between(fleetRng, 80, 700, 1));
    return {
      id: `bd-${String(i + 1).padStart(3, '0')}`,
      number: `BD/26-27/${String(200 + i)}`,
      vehicleId: v.id,
      driverId: v.driverId,
      reportedAt: reported,
      reportedBy: pick(fleetRng, REPORTERS),
      location: pick(fleetRng, BREAKDOWN_LOCATIONS),
      cause: pick(fleetRng, BREAKDOWN_REASONS),
      status: 'resolved',
      resolvedAt: new Date(Date.parse(reported) + hours * 3_600_000).toISOString(),
      downtimeHours: hours,
      repairCost: money(between(fleetRng, 2500, 68000, 0)),
    };
  }),
];

const EXPENSE_STATUS_PLAN: ExpenseBill['status'][] = [
  'submitted', 'submitted', 'validated', 'submitted', 'approved', 'paid', 'submitted', 'validated',
  'paid', 'submitted', 'rejected', 'approved', 'submitted', 'validated', 'paid', 'submitted',
];
const EXPENSE_KINDS: ExpenseBill['kind'][] = ['diesel', 'diesel', 'repair', 'diesel', 'tyre', 'spares', 'diesel', 'toll'];
const VENDORS: Record<ExpenseBill['kind'], string[]> = {
  diesel: ['Sakthi Fuels, Karapakkam', 'IOCL — Sri Murugan Agencies', 'HP — Balaji Fuel Point'],
  repair: ['Sri Ganesh Auto Works', 'Tata Authorised Service — Guindy'],
  tyre: ['Annai Tyres'],
  spares: ['Ashok Leyland Genuine Parts', 'Chennai Hydraulics'],
  toll: ['FASTag — NHAI'],
  other: ['Petty cash'],
};
const DESCRIPTIONS: Record<ExpenseBill['kind'], string> = {
  diesel: 'HSD fill',
  repair: 'Clutch overhaul and labour',
  tyre: 'Tyre 295/90 R20 × 2',
  spares: 'Hydraulic hose and fittings',
  toll: 'Toll recharge',
  other: 'Miscellaneous',
};

export const EXPENSE_BILLS: ExpenseBill[] = EXPENSE_STATUS_PLAN.map((status, i) => {
  const kind = EXPENSE_KINDS[i % EXPENSE_KINDS.length]!;
  const v = VEHICLES[(i * 7 + 2) % VEHICLES.length]!;
  const litres = kind === 'diesel' ? between(fleetRng, 140, 420, 1) : null;
  const amount =
    litres !== null ? litres * between(fleetRng, 92.4, 97.8, 2) : kind === 'toll' ? between(fleetRng, 2000, 10000, 0) : between(fleetRng, 3500, 92000, 0);
  const submittedAt = hoursFromNow(-between(fleetRng, 1, 190, 1));
  return {
    id: `exp-${String(i + 1).padStart(3, '0')}`,
    desk: 'fleet' as const,
    billNumber: `${kind === 'diesel' ? 'BK' : 'INV'}/${Math.floor(between(fleetRng, 10000, 99999))}`,
    kind,
    billDate: submittedAt,
    vehicleId: kind === 'toll' && i % 2 === 0 ? null : v.id,
    driverId: kind === 'diesel' ? v.driverId : null,
    vendor: pick(fleetRng, VENDORS[kind]),
    description: DESCRIPTIONS[kind],
    litres,
    amount: money(amount),
    status,
    submittedBy: kind === 'diesel' ? 'Driver (WhatsApp)' : pick(fleetRng, ['Anbu Selvan M', 'Ganesh K']),
    submittedAt,
    siteId: v.siteId,
    // Read by Linck off a WhatsApp photo, so proposed until the fleet manager
    // validates it; once anyone has signed it off it is confirmed.
    provenance: kind === 'diesel' ? (status === 'submitted' ? ('proposed' as const) : ('confirmed' as const)) : ('human' as const),
    attachment: null,
  };
});

/* The store manager's own bills: consumables and spares bought for the yard. */
const STORES_BILLS: { vendor: string; description: string; kind: ExpenseBill['kind']; status: ExpenseBill['status'] }[] = [
  { vendor: 'Chennai Hydraulics', description: 'Hydraulic oil 68 — 210 L barrel', kind: 'spares', status: 'submitted' },
  { vendor: 'Sri Murugan Hardwares', description: 'Welding rods and grinding discs', kind: 'other', status: 'submitted' },
  { vendor: 'Ashok Leyland Genuine Parts', description: 'Air filter elements × 6', kind: 'spares', status: 'validated' },
  { vendor: 'Annai Tyres', description: 'Tube and flap set × 4', kind: 'tyre', status: 'paid' },
];

EXPENSE_BILLS.push(
  ...STORES_BILLS.map((b, i): ExpenseBill => {
    const submittedAt = hoursFromNow(-between(fleetRng, 2, 120, 1));
    return {
      id: `exp-st-${String(i + 1).padStart(3, '0')}`,
      desk: 'stores',
      billNumber: `INV/${Math.floor(between(fleetRng, 10000, 99999))}`,
      kind: b.kind,
      billDate: submittedAt,
      vehicleId: null,
      driverId: null,
      vendor: b.vendor,
      description: b.description,
      litres: null,
      amount: money(between(fleetRng, 1800, 46000, 0)),
      status: b.status,
      submittedBy: 'Ganesh K',
      submittedAt,
      siteId: 'site-wsp',
      provenance: 'human',
      attachment: null,
    };
  }),
);

export { NOW };
