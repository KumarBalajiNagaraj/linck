/**
 * Units of measure.
 *
 * This module exists because two independent domain models disagreed about
 * how many cubic feet are in a tonne of M-sand — 22–24 vs 20 — and on a
 * 35-tonne load that gap is 15% of the billed quantity on EVERY load. There
 * is now exactly one conversion mechanism in the system, and it is this one.
 *
 * THE TRADE UNIT IS `unit` = 100 CFT. Customers order "3 units of M-sand",
 * quote in ₹/unit and argue in units. CFT is derived from it, not the other
 * way round.
 *
 * Three quantities are frozen on every invoice line, never one:
 *   1. trade quantity + trade UOM       — what the customer agreed to pay for
 *   2. statutory quantity + UQC         — what GSTR-1 and the IRP will accept
 *   3. weighed quantity                 — the control
 * CFT IS NOT A VALID GST UNIT QUANTITY CODE. The statutory quantity must be
 * CBM or MTS or the e-invoice fails at the IRP. That is why this is not a
 * one-line helper.
 */

export const TRADE_UOMS = ['unit', 'cft', 'tonne', 'cum', 'nos', 'load'] as const;
export type TradeUom = (typeof TRADE_UOMS)[number];

/** GST Unit Quantity Codes. Note the absence of any cubic-feet code. */
export const UQCS = ['CBM', 'MTS', 'TON', 'NOS', 'UNT', 'OTH'] as const;
export type Uqc = (typeof UQCS)[number];

export const CFT_PER_UNIT = 100;
export const CUM_PER_CFT = 0.0283168466;

export interface ProductDensity {
  productCode: string;
  label: string;
  /**
   * As-loaded TRADE density in tonnes per 100 CFT, i.e. per unit.
   * This is the figure the trade settles on, NOT the loose stockpile density.
   * Chennai convention for M-sand is 100 CFT ≈ 4.95–5.00 t.
   */
  tonnesPerUnit: number;
  /** The statutory unit this product's e-invoice lines are reported in. */
  statutoryUqc: Uqc;
  hsnCode: string;
  gstRatePct: number;
}

/**
 * Seeded densities. Effective-dated and per-organization in the real schema
 * (`master.uom_conversions`); this constant is the mock/dev fallback and the
 * documented default a new tenant starts from.
 */
export const PRODUCT_DENSITIES: Record<string, ProductDensity> = {
  MSAND: { productCode: 'MSAND', label: 'M-Sand', tonnesPerUnit: 4.95, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  PSAND: { productCode: 'PSAND', label: 'P-Sand', tonnesPerUnit: 4.9, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  AGG6: { productCode: 'AGG6', label: '6mm Aggregate', tonnesPerUnit: 4.45, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  AGG10: { productCode: 'AGG10', label: '10mm Aggregate', tonnesPerUnit: 4.4, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  AGG20: { productCode: 'AGG20', label: '20mm Aggregate', tonnesPerUnit: 4.3, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  AGG40: { productCode: 'AGG40', label: '40mm Aggregate', tonnesPerUnit: 4.25, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  GSB: { productCode: 'GSB', label: 'GSB', tonnesPerUnit: 4.6, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  WMM: { productCode: 'WMM', label: 'WMM', tonnesPerUnit: 4.65, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  DUST: { productCode: 'DUST', label: 'Crusher Dust', tonnesPerUnit: 5.05, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
  RUBBLE: { productCode: 'RUBBLE', label: 'Rubble', tonnesPerUnit: 4.2, statutoryUqc: 'MTS', hsnCode: '25171010', gstRatePct: 5 },
};

/**
 * A quantity frozen at the moment of sale. Every field is persisted — the
 * factor especially, because a density revised next March must not silently
 * restate last year's invoices.
 */
export interface FrozenQuantity {
  tradeQty: number;
  tradeUom: TradeUom;
  statutoryQty: number;
  statutoryUqc: Uqc;
  conversionFactorUsed: number;
  productCode: string;
}

export function unitsToCft(units: number): number {
  return units * CFT_PER_UNIT;
}

export function cftToUnits(cft: number): number {
  return cft / CFT_PER_UNIT;
}

export function unitsToTonnes(units: number, productCode: string): number {
  const d = PRODUCT_DENSITIES[productCode];
  if (!d) throw new Error(`No density configured for product ${productCode}`);
  return units * d.tonnesPerUnit;
}

export function tonnesToUnits(tonnes: number, productCode: string): number {
  const d = PRODUCT_DENSITIES[productCode];
  if (!d) throw new Error(`No density configured for product ${productCode}`);
  return tonnes / d.tonnesPerUnit;
}

export function cftToCum(cft: number): number {
  return cft * CUM_PER_CFT;
}

/** Freeze a sale quantity into its trade, statutory and conversion parts. */
export function freezeQuantity(tradeQty: number, tradeUom: TradeUom, productCode: string): FrozenQuantity {
  const d = PRODUCT_DENSITIES[productCode];
  if (!d) throw new Error(`No density configured for product ${productCode}`);

  const units = tradeUom === 'unit' ? tradeQty : tradeUom === 'cft' ? cftToUnits(tradeQty) : tonnesToUnits(tradeQty, productCode);

  const statutoryQty = d.statutoryUqc === 'MTS' || d.statutoryUqc === 'TON' ? unitsToTonnes(units, productCode) : cftToCum(unitsToCft(units));

  return {
    tradeQty,
    tradeUom,
    statutoryQty: round(statutoryQty, 3),
    statutoryUqc: d.statutoryUqc,
    conversionFactorUsed: d.tonnesPerUnit,
    productCode,
  };
}

/**
 * Weighbridge-vs-trade variance.
 *
 * Deliberately NOT a hard invoice block. M-sand moisture swings between a dry
 * March morning and a wet October afternoon move apparent density 8–15%, and
 * pile segregation moves it another 3–5%. A 2% block would fire on most loads,
 * an operator would pick the first dropdown reason 300 times a day, and the
 * control would be dead inside a fortnight.
 *
 * The signal worth having is the TREND per driver, per lane, per loader
 * operator, per shift. The per-load flag is only how a trend gets its data.
 */
export const DEFAULT_VARIANCE_TOLERANCE_PCT = 7;

export function weighbridgeVariancePct(weighedTonnes: number, tradeUnits: number, productCode: string): number {
  const expected = unitsToTonnes(tradeUnits, productCode);
  if (expected === 0) return 0;
  return ((weighedTonnes - expected) / expected) * 100;
}

export function isVarianceExceptional(variancePct: number, tolerancePct = DEFAULT_VARIANCE_TOLERANCE_PCT): boolean {
  return Math.abs(variancePct) > tolerancePct;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Fixed decimals per column type. Variable decimals destroy point alignment even with tnum. */
export const DECIMALS = {
  money: 2,
  tonnes: 3,
  cft: 0,
  units: 2,
  kmpl: 2,
  percent: 1,
  litres: 2,
} as const;

export function formatQty(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}
