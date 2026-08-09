import type { Provenance, StatusFamily } from '@linck/tokens';

/**
 * Mock shapes.
 *
 * These deliberately mirror the eventual API response shapes, not the raw
 * tables — money is a decimal STRING as FastAPI will serialise it, timestamps
 * are ISO-8601 UTC, and every hand-keyed value carries its provenance. When
 * the real API lands, `@linck/mock` is deleted and only the import path in
 * each hook changes.
 */

export interface Site {
  id: string;
  code: string;
  name: string;
  kind: 'crusher' | 'quarry' | 'workshop' | 'office';
}

export type VehicleStatus = 'ready' | 'on_trip' | 'idle' | 'under_service' | 'breakdown' | 'off_road';

export interface Vehicle {
  id: string;
  registrationNumber: string;
  displayReg: string;
  model: string;
  classTonnes: number;
  siteId: string;
  status: VehicleStatus;
  statusSince: string;
  statusReason?: string;
  odometerKm: number;
  driverId: string | null;
  lastKmpl: number | null;
  benchmarkKmpl: number;
  /** Days until the earliest expiring statutory document. Negative = expired. */
  nextDocExpiryDays: number | null;
  nextDocType: string | null;
  serviceDueInKm: number | null;
  tripsToday: number;
  tonnesToday: number;
}

export interface Driver {
  id: string;
  name: string;
  phone: string;
  licenceNumber: string;
  licenceExpiry: string;
  attendance: 'present' | 'absent' | 'leave' | 'on_trip' | 'rest';
  vehicleId: string | null;
  siteId: string;
}

export interface FuelEntry {
  id: string;
  date: string;
  vehicleId: string;
  driverId: string | null;
  litres: number;
  ratePerLitre: string;
  amount: string;
  odometerKm: number;
  fullTank: boolean;
  source: 'own_bunk' | 'outside_bunk';
  billNumber: string | null;
  impliedKmpl: number | null;
  provenance: Provenance;
}

export interface ComplianceDocument {
  id: string;
  vehicleId: string;
  type: 'insurance' | 'fitness' | 'permit' | 'road_tax' | 'puc' | 'national_permit';
  label: string;
  number: string;
  expiresOn: string;
  daysLeft: number;
  cost: string | null;
  issuer: string;
  /** Whether an expired copy of this document stops the vehicle at the gate. */
  blocksOperation: boolean;
}

export interface Product {
  code: string;
  label: string;
  category: 'sand' | 'aggregate' | 'base' | 'byproduct';
}

export interface StockPosition {
  productCode: string;
  siteId: string;
  /** Trade units (100 CFT each) — what the business counts in. */
  units: number;
  tonnes: number;
  safetyUnits: number;
  producedTodayUnits: number;
  dispatchedTodayUnits: number;
  lastCountedOn: string;
  /** Book vs last physical count, in units. Non-zero means unexplained movement. */
  countVarianceUnits: number;
}

export interface ProductionRun {
  id: string;
  date: string;
  shift: 'day' | 'night';
  siteId: string;
  crusher: string;
  operator: string;
  runHours: number;
  downtimeHours: number;
  downtimeReason: string | null;
  boulderInTonnes: number;
  outputs: { productCode: string; units: number; tonnes: number }[];
  /** input minus outputs, as a percentage. Outside band = something left without paper. */
  massBalancePct: number;
  provenance: Provenance;
}

export type TripStatus = 'planned' | 'loaded' | 'in_transit' | 'delivered' | 'completed' | 'returned' | 'cancelled';

export interface Trip {
  id: string;
  tripNumber: string;
  date: string;
  status: TripStatus;
  vehicleId: string;
  driverId: string | null;
  customerId: string;
  customerSite: string;
  productCode: string;
  /** What was SOLD — the agreed unit count. In this trade this is the primary number. */
  soldUnits: number;
  qtyBasis: 'loader_buckets' | 'plant_weighbridge' | 'customer_weighbridge' | 'agreed_units';
  weighedTonnes: number | null;
  variancePct: number | null;
  distanceKm: number;
  ratePerUnit: string;
  revenue: string;
  /** Cash costs only. Tyre, maintenance and depreciation are month-end absorptions, not per-trip rows. */
  costDiesel: string;
  costBatta: string;
  costToll: string;
  materialCost: string;
  margin: string;
  ewbRequired: boolean;
  ewbNumber: string | null;
  invoiceId: string | null;
  rateOverridden: boolean;
  purpose: 'sale' | 'own_use' | 'sample' | 'internal_transfer';
}

export type InvoiceStatus =
  | 'draft'
  | 'issued'
  | 'part_paid'
  | 'payment_reported'
  | 'payment_verified'
  | 'closed'
  | 'overdue';

export interface Invoice {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  customerId: string;
  customerName: string;
  status: InvoiceStatus;
  taxableValue: string;
  gstAmount: string;
  total: string;
  /** Verified receipts only. Reported-but-unverified money is NOT this number. */
  receivedVerified: string;
  receivedReported: string;
  balanceDue: string;
  daysOverdue: number;
  irn: string | null;
  ewbNumbers: string[];
  tripIds: string[];
}

export interface Receipt {
  id: string;
  date: string;
  customerId: string;
  customerName: string;
  amount: string;
  method: 'cash' | 'neft' | 'rtgs' | 'imps' | 'upi' | 'cheque';
  reference: string | null;
  recordedBy: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  /** Linck's ranked match against a bank line, with its stated reason. */
  suggestedInvoiceId: string | null;
  suggestionReason: string | null;
  allocatedInvoiceIds: string[];
  provenance: Provenance;
}

export interface ExtractionJob {
  id: string;
  documentType: 'diesel_bill' | 'weighbridge_slip' | 'vendor_invoice' | 'insurance_renewal';
  label: string;
  capturedAt: string;
  capturedBy: string;
  siteId: string;
  fields: ExtractedField[];
  /** Plain sentence stating exactly what confirming this will create. */
  postsSummary: string;
  duplicateOf: string | null;
}

export interface ExtractedField {
  key: string;
  label: string;
  value: string;
  confidence: 1 | 2 | 3;
  confirmed: boolean;
  overriddenFrom: string | null;
  unit?: string;
}

export interface Indent {
  id: string;
  number: string;
  raisedOn: string;
  raisedBy: string;
  siteId: string;
  itemName: string;
  itemCode: string;
  quantity: number;
  uom: string;
  forAsset: string | null;
  status: 'submitted' | 'approved' | 'issued' | 'rejected';
  urgency: 'routine' | 'urgent' | 'breakdown';
  stockOnHand: number;
  reorderLevel: number;
  estimatedValue: string;
}

/**
 * E-WAY BILLS.
 *
 * Two facts are kept apart here because the portal keeps them apart:
 *   - PART A is the consignment — invoice, value, HSN, from and to. It stands
 *     alone for 15 days waiting for Part B, and then it silently dies.
 *   - PART B is the vehicle number. Entering it is what starts the validity
 *     clock, and it is NOT required at all for a move under 50 km inside the
 *     same state between consignor and transporter.
 *
 * `stage` records only what the portal knows. Everything time-dependent —
 * expiring, expired, Part A lapsed, blocked — is DERIVED against a clock in
 * `selectors.ts`, because a stored 'expired' flag is wrong the moment the
 * dataset is read a day later.
 */
export type EwayBillStage =
  /** Below the threshold that applies to this movement. No bill exists and none is owed. */
  | 'not_required'
  /** A bill is owed and has not been raised — usually because the GSTIN is blocked. */
  | 'not_generated'
  /** Part A accepted, Part B still blank. The 15-day window is running. */
  | 'part_a_only'
  /** Part B entered (or exempt). The distance-based validity clock is running. */
  | 'active'
  /** Cancelled on the portal — only possible within 24 hours of generation. */
  | 'cancelled';

export interface EwayBill {
  id: string;
  siteId: string;
  /** The 12-digit portal number. Null while nothing has been raised. */
  ewbNumber: string | null;
  stage: EwayBillStage;
  /**
   * Attempt within one trip. A cancel-and-regenerate or a breakdown-and-reload
   * legitimately produces several bills against one trip; at most one is live.
   */
  attempt: number;
  supersedes: string | null;
  tripNumber: string;
  invoiceNumber: string;
  documentDate: string;
  /** When Part A was accepted. Null when nothing has been raised. */
  generatedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  customerId: string;
  customerName: string;
  fromPlace: string;
  /** GST state code — '33' Tamil Nadu, '29' Karnataka, '37' Andhra Pradesh. */
  fromStateCode: string;
  toPlace: string;
  toStateCode: string;
  /**
   * The single most consequential field on the row. Intra-state Tamil Nadu is
   * exempt up to ₹1,00,000; across a border the limit is ₹50,000. The same
   * tipper load is paperwork-free one way and a detention risk the other.
   */
  movement: 'intra_state' | 'inter_state';
  consignmentValue: string;
  productCode: string;
  hsnCode: string;
  distanceKm: number;
  /** Over-dimensional cargo earns 1 day per 20 km instead of 1 day per 200 km. */
  overDimensional: boolean;
  supplierGstin: string;
  /** Differs from the supplier when the vehicle belongs to another legal entity. */
  transporterGstin: string | null;
  transporterName: string | null;
  partBVehicle: string | null;
  partBEnteredAt: string | null;
  /** Rule 138(3) proviso — under 50 km in the same state, Part B is not required. */
  partBExemptUnder50km: boolean;
  /** Why no bill is owed, in the words a check-post officer would accept. */
  exemptReason: string | null;
  provenance: Provenance;
}

/**
 * Rule 138E standing of one GSTIN.
 *
 * Two consecutive unfiled GSTR-3B periods and the portal refuses to generate
 * ANY e-way bill on that GSTIN. It is the most common real answer to "why
 * can't we generate today", and it stops every tipper in the yard at once —
 * so it belongs to the registration, not to a row.
 */
export interface GstinStanding {
  gstin: string;
  legalEntityName: string;
  stateCode: string;
  role: 'supplier' | 'transporter';
  lastFiledPeriod: string;
  /** Consecutive tax periods with GSTR-3B unfiled. Two or more triggers the block. */
  missedReturnPeriods: string[];
  blocked: boolean;
  blockedSince: string | null;
}

export interface Alert {
  id: string;
  kind: 'expiry' | 'breakdown' | 'approval' | 'anomaly' | 'receivable';
  status: StatusFamily;
  title: string;
  detail: string;
  at: string;
  route: string;
}
