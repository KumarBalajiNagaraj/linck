import type { StatusFamily } from '@linck/tokens';
import {
  DOCUMENTS,
  DRIVERS,
  EWAY_BILLS,
  GSTIN_STANDINGS,
  INVOICES,
  PURCHASE_ORDERS,
  RECEIPTS,
  STOCK,
  TRIPS,
  VEHICLES,
} from './data.js';
import { NOW } from './seed.js';
import type { EwayBill, GstinStanding, Invoice, PurchaseOrder, Trip, Vehicle, VehicleStatus } from './types.js';

/**
 * Derived figures.
 *
 * Every number an executive sees has to be traceable to the rows it came from,
 * so the derivations live here in one place rather than being inlined per
 * screen. In the real system these become SQL views, and the KPI tile's as-of
 * stamp names the view.
 */

/** Vehicle status → status family. The mapping is a product decision, not a colour choice. */
export const VEHICLE_STATUS_FAMILY: Record<VehicleStatus, StatusFamily> = {
  ready: 'ready',
  on_trip: 'active',
  // "Ready but unassigned" IS the productivity leak the fleet team is measured
  // on, so it gets ATTENTION, not a neutral grey.
  idle: 'attention',
  under_service: 'planned',
  breakdown: 'critical',
  off_road: 'dormant',
};

export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = {
  ready: 'Ready',
  on_trip: 'On trip',
  idle: 'Idle',
  under_service: 'Service',
  breakdown: 'Breakdown',
  off_road: 'Off road',
};

export const INVOICE_STATUS_FAMILY: Record<Invoice['status'], StatusFamily> = {
  draft: 'dormant',
  issued: 'active',
  part_paid: 'attention',
  // Reported but not verified is the owner's hard rule made visible: money
  // claimed is not money confirmed.
  payment_reported: 'attention',
  payment_verified: 'ready',
  closed: 'dormant',
  overdue: 'critical',
};

export const INVOICE_STATUS_LABEL: Record<Invoice['status'], string> = {
  draft: 'Draft',
  issued: 'Issued',
  part_paid: 'Part-paid',
  payment_reported: 'Reported',
  payment_verified: 'Verified',
  closed: 'Closed',
  overdue: 'Overdue',
};

export const TRIP_STATUS_FAMILY: Record<Trip['status'], StatusFamily> = {
  planned: 'pending',
  loaded: 'active',
  in_transit: 'active',
  delivered: 'ready',
  completed: 'ready',
  returned: 'critical',
  cancelled: 'dormant',
};

export const TRIP_STATUS_LABEL: Record<Trip['status'], string> = {
  planned: 'Planned',
  loaded: 'Loaded',
  in_transit: 'In transit',
  delivered: 'Delivered',
  completed: 'Completed',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

export function vehiclesForSite(siteId: string | null): Vehicle[] {
  return siteId ? VEHICLES.filter((v) => v.siteId === siteId) : VEHICLES;
}

export function fleetCounts(siteId: string | null) {
  const list = vehiclesForSite(siteId);
  const by = (s: VehicleStatus) => list.filter((v) => v.status === s).length;
  const productive = by('on_trip') + by('ready');
  return {
    total: list.length,
    onTrip: by('on_trip'),
    ready: by('ready'),
    idle: by('idle'),
    underService: by('under_service'),
    breakdown: by('breakdown'),
    offRoad: by('off_road'),
    /**
     * Uptime = share of the fleet that is either working or able to work.
     * Under-service is EXCLUDED from downtime deliberately — a planned service
     * is not a failure, and counting it as one teaches the fleet team to skip
     * services to protect the number.
     */
    uptimePct: Math.round((productive / list.length) * 1000) / 10,
  };
}

export function driversForSite(siteId: string | null) {
  const list = siteId ? DRIVERS.filter((d) => d.siteId === siteId) : DRIVERS;
  return {
    total: list.length,
    available: list.filter((d) => d.attendance === 'present').length,
    onTrip: list.filter((d) => d.attendance === 'on_trip').length,
    absent: list.filter((d) => d.attendance === 'absent' || d.attendance === 'leave').length,
  };
}

export function documentExposure(siteId: string | null) {
  const vehicleIds = new Set(vehiclesForSite(siteId).map((v) => v.id));
  const docs = DOCUMENTS.filter((d) => vehicleIds.has(d.vehicleId));
  return {
    expired: docs.filter((d) => d.daysLeft < 0).length,
    expiringSoon: docs.filter((d) => d.daysLeft >= 0 && d.daysLeft <= 30).length,
    blocking: docs.filter((d) => d.daysLeft < 0 && d.blocksOperation).length,
    all: docs,
  };
}

export function receivables() {
  const open = INVOICES.filter((i) => i.status !== 'closed' && i.status !== 'draft');
  const sum = (list: Invoice[], key: 'balanceDue' | 'total' | 'receivedReported') =>
    list.reduce((s, i) => s + Number.parseFloat(i[key] as string), 0);

  const overdue = open.filter((i) => i.daysOverdue > 0);
  const reportedUnverified = INVOICES.filter((i) => i.status === 'payment_reported');

  return {
    openCount: open.length,
    outstanding: sum(open, 'balanceDue'),
    overdueCount: overdue.length,
    overdueAmount: sum(overdue, 'balanceDue'),
    /**
     * The owner's rule, as a number: money someone says arrived, that a second
     * person has not confirmed. It is NOT counted as collected anywhere.
     */
    reportedUnverified: sum(reportedUnverified, 'receivedReported'),
    reportedUnverifiedCount: reportedUnverified.length,
    /** Ageing buckets, in days past due. */
    ageing: [
      { bucket: '0–30', amount: sum(overdue.filter((i) => i.daysOverdue <= 30), 'balanceDue') },
      { bucket: '31–60', amount: sum(overdue.filter((i) => i.daysOverdue > 30 && i.daysOverdue <= 60), 'balanceDue') },
      { bucket: '60+', amount: sum(overdue.filter((i) => i.daysOverdue > 60), 'balanceDue') },
    ],
  };
}

export function pendingVerification() {
  return RECEIPTS.filter((r) => r.verifiedBy === null);
}

export function todayTrade(siteId: string | null) {
  const stock = siteId ? STOCK.filter((s) => s.siteId === siteId) : STOCK;
  const produced = stock.reduce((s, x) => s + x.producedTodayUnits, 0);
  const dispatched = stock.reduce((s, x) => s + x.dispatchedTodayUnits, 0);
  const activeTrips = TRIPS.filter((t) => t.status === 'in_transit' || t.status === 'loaded');
  const revenueToday = TRIPS.reduce((s, t) => s + Number.parseFloat(t.revenue), 0);
  const marginToday = TRIPS.reduce((s, t) => s + Number.parseFloat(t.margin), 0);

  return {
    producedUnits: Math.round(produced * 10) / 10,
    dispatchedUnits: Math.round(dispatched * 10) / 10,
    /**
     * The reconciling gap. Produced minus dispatched is not a rounding error —
     * it is the number that tells the MD whether material left without paper.
     */
    gapUnits: Math.round((produced - dispatched) * 10) / 10,
    activeTrips: activeTrips.length,
    revenueToday,
    marginToday,
    marginPct: revenueToday > 0 ? Math.round((marginToday / revenueToday) * 1000) / 10 : 0,
  };
}

export function stockAlerts(siteId: string | null) {
  const list = siteId ? STOCK.filter((s) => s.siteId === siteId) : STOCK;
  return {
    low: list.filter((s) => s.units < s.safetyUnits).length,
    varianceFlags: list.filter((s) => Math.abs(s.countVarianceUnits) > 5).length,
  };
}

export function fuelAnomalies() {
  return VEHICLES.filter((v) => v.lastKmpl !== null && v.lastKmpl < v.benchmarkKmpl * 0.82);
}

/* ------------------------------------------------------------ e-way bills */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const IST_OFFSET_MS = 330 * 60_000;

/** Intra-Tamil Nadu exemption. Most tipper loads inside the state sit under it. */
export const EWB_INTRA_STATE_THRESHOLD = 100_000;
/** Across a border the limit is half that, so a TN→KA load almost always needs a bill. */
export const EWB_INTER_STATE_THRESHOLD = 50_000;
/** Part A stands alone for 15 days waiting for Part B, then it is dead. */
export const EWB_PART_A_WINDOW_DAYS = 15;
/** Under this distance in the same state, consignor to transporter, Part B is not required. */
export const EWB_PART_B_EXEMPT_KM = 50;
/** One day of validity per this many km. Over-dimensional cargo gets a day per 20 km. */
export const EWB_KM_PER_DAY = 200;
export const EWB_ODC_KM_PER_DAY = 20;
/** A generated bill can only be cancelled inside this window. */
export const EWB_CANCEL_WINDOW_HOURS = 24;

/**
 * The derived standing of a bill against a clock.
 *
 * None of this is stored. A row that reads "expiring" at 14:42 reads "expired"
 * at 00:01, and a flag written into the dataset would lie about exactly the
 * thing this screen exists to tell the truth about.
 */
export type EwbStanding =
  | 'not_required'
  | 'blocked'
  | 'to_generate'
  | 'part_b_pending'
  | 'part_a_lapsed'
  | 'active'
  | 'expiring'
  | 'expired'
  | 'cancelled';

export const EWB_STANDING_FAMILY: Record<EwbStanding, StatusFamily> = {
  // No bill is owed. Nothing to chase, and it must not read as a failure.
  not_required: 'dormant',
  blocked: 'critical',
  to_generate: 'pending',
  part_b_pending: 'pending',
  part_a_lapsed: 'critical',
  active: 'active',
  expiring: 'attention',
  expired: 'critical',
  cancelled: 'dormant',
};

export const EWB_STANDING_LABEL: Record<EwbStanding, string> = {
  not_required: 'not required',
  blocked: 'blocked 138E',
  to_generate: 'to raise',
  part_b_pending: 'part b pending',
  part_a_lapsed: 'part a lapsed',
  active: 'in force',
  expiring: 'expiring',
  expired: 'expired',
  cancelled: 'cancelled',
};

/** The limit that applies to THIS movement — the asymmetry, as one number. */
export function ewbThreshold(bill: EwayBill): number {
  return bill.movement === 'inter_state' ? EWB_INTER_STATE_THRESHOLD : EWB_INTRA_STATE_THRESHOLD;
}

export function ewbIsRequired(bill: EwayBill): boolean {
  return Number.parseFloat(bill.consignmentValue) > ewbThreshold(bill);
}

/** One day per 200 km or part thereof; one day per 20 km for over-dimensional cargo. */
export function ewbValidityDays(distanceKm: number, overDimensional: boolean): number {
  return Math.max(1, Math.ceil(distanceKm / (overDimensional ? EWB_ODC_KM_PER_DAY : EWB_KM_PER_DAY)));
}

/**
 * Validity does NOT run out 24 hours after Part B.
 *
 * Each day expires at midnight of the day immediately following the day it
 * was counted from, so a bill entered at 23:50 gets almost the same runway as
 * one entered at 00:10. Computed on the IST calendar day, never on UTC.
 */
export function ewbValidUntil(from: string, distanceKm: number, overDimensional: boolean): string {
  const days = ewbValidityDays(distanceKm, overDimensional);
  const startOfIstDay = Math.floor((Date.parse(from) + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return new Date(startOfIstDay + (days + 1) * DAY_MS).toISOString();
}

/** `2d 6h`, `9h 18m`, `40m`. Magnitude only — the caller says "left" or "ago". */
export function ewbTimeLeftLabel(ms: number): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY_MS);
  const h = Math.floor((abs % DAY_MS) / HOUR_MS);
  const m = Math.floor((abs % HOUR_MS) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** 12 digits are unreadable in one run. Portal-style groups of four. */
export function formatEwbNumber(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/(\d{4})(?=\d)/g, '$1 ');
}

export function gstinStanding(gstin: string): GstinStanding | undefined {
  return GSTIN_STANDINGS.find((g) => g.gstin === gstin);
}

export interface EwbClock {
  standing: EwbStanding;
  family: StatusFamily;
  label: string;
  /** The integer beside the word. Severity is never a shade. */
  severity: string | null;
  validUntil: string | null;
  validityDays: number | null;
  /** Positive = time remaining, negative = time since it died. */
  msLeft: number | null;
  /** Deadline for Part B against Part A's 15-day window. */
  partADeadline: string | null;
  partBDaysLeft: number | null;
  /** 0–1 of the clock still unspent, for the row rail. */
  fillRatio: number | null;
}

/**
 * The whole rulebook, applied to one row.
 *
 * Takes the bill by value rather than by id so a Part B keyed into the screen
 * but not yet acknowledged by the portal can be run through the identical
 * derivation — no second code path for the optimistic case.
 */
export function ewbClock(bill: EwayBill, now: Date = NOW): EwbClock {
  const at = now.getTime();
  const blank: Omit<EwbClock, 'standing' | 'family' | 'label' | 'severity'> = {
    validUntil: null,
    validityDays: null,
    msLeft: null,
    partADeadline: null,
    partBDaysLeft: null,
    fillRatio: null,
  };
  const of = (standing: EwbStanding, severity: string | null, rest: Partial<EwbClock> = {}): EwbClock => ({
    ...blank,
    standing,
    family: EWB_STANDING_FAMILY[standing],
    label: EWB_STANDING_LABEL[standing],
    severity,
    ...rest,
  });

  if (bill.stage === 'not_required') return of('not_required', null);

  if (bill.stage === 'cancelled') {
    const hours =
      bill.cancelledAt && bill.generatedAt
        ? Math.round((Date.parse(bill.cancelledAt) - Date.parse(bill.generatedAt)) / HOUR_MS)
        : null;
    return of('cancelled', hours === null ? null : `${hours}h`);
  }

  if (bill.stage === 'not_generated') {
    const blocked = gstinStanding(bill.supplierGstin)?.blocked ?? false;
    return of(blocked ? 'blocked' : 'to_generate', null);
  }

  if (bill.stage === 'part_a_only') {
    const deadline = bill.generatedAt
      ? Date.parse(bill.generatedAt) + EWB_PART_A_WINDOW_DAYS * DAY_MS
      : at;
    const left = deadline - at;
    // Truncated, not floored: 2.1 days past the deadline is "2d ago", and
    // Math.floor would round that away from zero into a wrong "3d".
    const daysLeft = Math.trunc(left / DAY_MS);
    return of(left <= 0 ? 'part_a_lapsed' : 'part_b_pending', `${Math.abs(daysLeft)}d`, {
      partADeadline: new Date(deadline).toISOString(),
      partBDaysLeft: daysLeft,
      fillRatio: Math.max(0, Math.min(1, left / (EWB_PART_A_WINDOW_DAYS * DAY_MS))),
    });
  }

  // Active. The clock runs from Part B, or from Part A where Part B is exempt.
  const from = bill.partBEnteredAt ?? bill.generatedAt;
  if (!from) return of('active', null);
  const validUntil = ewbValidUntil(from, bill.distanceKm, bill.overDimensional);
  const left = Date.parse(validUntil) - at;
  const span = Date.parse(validUntil) - Date.parse(from);
  const standing: EwbStanding = left <= 0 ? 'expired' : left <= 24 * HOUR_MS ? 'expiring' : 'active';

  return of(standing, ewbTimeLeftLabel(left), {
    validUntil,
    validityDays: ewbValidityDays(bill.distanceKm, bill.overDimensional),
    msLeft: left,
    fillRatio: span > 0 ? Math.max(0, Math.min(1, left / span)) : null,
  });
}

export function ewayBillsForSite(siteId: string | null): EwayBill[] {
  return siteId ? EWAY_BILLS.filter((b) => b.siteId === siteId) : EWAY_BILLS;
}

/**
 * The four numbers the console leads with, computed off the SAME list the
 * table renders — so keying a Part B moves the tile and the row together.
 */
export function ewayBillSummary(bills: EwayBill[], now: Date = NOW) {
  const clocks = bills.map((b) => ({ bill: b, clock: ewbClock(b, now) }));
  const standing = (s: EwbStanding) => clocks.filter((c) => c.clock.standing === s);
  const pending = standing('part_b_pending');
  const oldest = pending.reduce<number | null>(
    (min, c) => (c.clock.partBDaysLeft === null ? min : min === null ? c.clock.partBDaysLeft : Math.min(min, c.clock.partBDaysLeft)),
    null,
  );

  return {
    total: bills.length,
    inForce: standing('active').length + standing('expiring').length,
    interStateInForce: clocks.filter(
      (c) => c.bill.movement === 'inter_state' && (c.clock.standing === 'active' || c.clock.standing === 'expiring'),
    ).length,
    partBPending: pending.length,
    /** Days left on the 15-day Part A window of the nearest-to-death pending bill. */
    partBTightestDaysLeft: oldest,
    partALapsed: standing('part_a_lapsed').length,
    expiring: standing('expiring').length,
    expired: standing('expired').length,
    cancelled: standing('cancelled').length,
    notRequired: standing('not_required').length,
    blocked: standing('blocked').length,
    interState: bills.filter((b) => b.movement === 'inter_state').length,
    intraState: bills.filter((b) => b.movement === 'intra_state').length,
  };
}

/** Blocked registrations that actually touch the rows on screen, worst first. */
export function blockedGstinsFor(bills: EwayBill[]): GstinStanding[] {
  const used = new Set(bills.map((b) => b.supplierGstin));
  return GSTIN_STANDINGS.filter((g) => g.blocked && used.has(g.gstin));
}

/** Consignments held by one blocked registration — the count that makes it urgent. */
export function ewbHeldByGstin(bills: EwayBill[], gstin: string): EwayBill[] {
  return bills.filter((b) => b.supplierGstin === gstin && b.stage === 'not_generated');
}

/* ------------------------------------------------------------ sales desk */

/** The walk-in customer. Paid at the gate, so a load to it is never unbilled. */
export const COUNTER_CASH_CUSTOMER_ID = 'cus-06';

/**
 * A planned load older than this has missed its slot. Six hours is one loading
 * shift: an order taken at 06:30 that still has not reached the chute by
 * lunch is a customer about to ring.
 */
export const DISPATCH_DELAY_HOURS = 6;

export const PO_STATUS_FAMILY: Record<PurchaseOrder['status'], StatusFamily> = {
  pending_approval: 'pending',
  approved: 'active',
  part_dispatched: 'attention',
  fulfilled: 'ready',
  rejected: 'dormant',
};

export const PO_STATUS_LABEL: Record<PurchaseOrder['status'], string> = {
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  part_dispatched: 'Part dispatched',
  fulfilled: 'Fulfilled',
  rejected: 'Rejected',
};

/** A trip belongs to the site of the vehicle carrying it. */
export function tripsForSite(siteId: string | null): Trip[] {
  if (!siteId) return TRIPS;
  const vehicleIds = new Set(vehiclesForSite(siteId).map((v) => v.id));
  return TRIPS.filter((t) => vehicleIds.has(t.vehicleId));
}

/**
 * An invoice carries no site of its own — its site is the site of the trips it
 * bills. One with no trips (advance, counter sale) is org-level and stays
 * visible at every scope rather than silently vanishing.
 */
export function invoicesForSite(siteId: string | null): Invoice[] {
  if (!siteId) return INVOICES;
  const tripIds = new Set(tripsForSite(siteId).map((t) => t.id));
  return INVOICES.filter((i) => i.tripIds.length === 0 || i.tripIds.some((id) => tripIds.has(id)));
}

export function purchaseOrdersForSite(siteId: string | null): PurchaseOrder[] {
  return siteId ? PURCHASE_ORDERS.filter((p) => p.siteId === siteId) : PURCHASE_ORDERS;
}

/**
 * Loaded but not yet confirmed out of the gate, or planned and past its slot.
 * Either way the customer has been promised a lorry that is not on the road.
 */
export function isDispatchUnconfirmed(trip: Trip, now: Date = NOW): boolean {
  if (trip.status === 'loaded') return true;
  return trip.status === 'planned' && now.getTime() - Date.parse(trip.date) > DISPATCH_DELAY_HOURS * 3_600_000;
}

/**
 * Material that left the yard for a paying customer with no invoice behind it.
 * Own-use and cancelled loads are never sales; the counter customer paid at
 * the gate. What remains is revenue that exists only in a driver's memory.
 */
export function isUnbilledDispatch(trip: Trip): boolean {
  return (
    trip.purpose === 'sale' &&
    trip.customerId !== COUNTER_CASH_CUSTOMER_ID &&
    (trip.status === 'delivered' || trip.status === 'completed') &&
    trip.invoiceId === null
  );
}

/** Past due with money still owed. Drafts and closed files are not receivables. */
export function isInvoiceOverdue(invoice: Invoice): boolean {
  return (
    invoice.status !== 'draft' &&
    invoice.status !== 'closed' &&
    invoice.daysOverdue > 0 &&
    Number.parseFloat(invoice.balanceDue) > 0
  );
}

/**
 * The five counts the sales coordinator's command board leads with. Each one
 * uses the same predicate as the pre-filtered list it links to, so the number
 * on the card is the number of rows on the other side of the click.
 */
export function salesAttention(siteId: string | null, now: Date = NOW) {
  const trips = tripsForSite(siteId);
  const stock = siteId ? STOCK.filter((s) => s.siteId === siteId) : STOCK;
  return {
    ordersPendingApproval: purchaseOrdersForSite(siteId).filter((p) => p.status === 'pending_approval').length,
    dispatchUnconfirmed: trips.filter((t) => isDispatchUnconfirmed(t, now)).length,
    unbilledDispatch: trips.filter(isUnbilledDispatch).length,
    invoicesOverdue: invoicesForSite(siteId).filter(isInvoiceOverdue).length,
    stockBelowSafety: stock.filter((s) => s.units < s.safetyUnits).length,
  };
}
