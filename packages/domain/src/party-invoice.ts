/**
 * PARTY INVOICES (LIN-27): GST tax invoices made from Vehicle P&L trips.
 *
 * The owner's workbook, column AZ: "Invoice should be generated at the click
 * of a button for the party. Provision to generate invoice for each trip or
 * for a set of trips." An invoice bills one customer for the sale lines of
 * one trip or several (vehicle-pl.ts): each line's material, HSN, quantity,
 * rate and transport, at the line's own GST rate.
 *
 * Every rule is here once, as a pure function over decimal strings
 * (decimal.ts). apps/api/app/domain/party_invoice.py is the same rules in
 * Python, and both run over party-invoice.fixtures.json, so neither can drift
 * alone.
 *
 *   amount        = quantity × rate, to the paisa (the workbook's AO × AQ)
 *   taxable       = amount + transport (AV: transport is inside the taxable value)
 *   which tax     = CGST + SGST when the place of supply is the seller's own state
 *                   (intra-state), IGST otherwise (inter-state)
 *   CGST, SGST    = taxable × half the rate, each rounded to the paisa, line by line
 *   IGST          = taxable × the rate, rounded to the paisa, line by line
 *   total         = Σ taxable + Σ tax, rounded to the rupee, half away from zero;
 *                   the round-off is its own line, never more than 50 paise
 *   in words      = the total in Indian English: thousand, lakh, crore, "Only"
 *
 * A line's CGST and SGST are each rounded, so on an odd paisa they can add up
 * to a paisa less than the trip page's one GST figure (vehicle-pl.ts rounds
 * the whole rate once). The invoice is the paper the customer is billed on,
 * so its figures are the ones that count for the money received against it.
 *
 * The place of supply is where the goods are delivered (s.10(1)(a) IGST Act):
 * the state of the customer's delivery location. Until a location has a state,
 * the buyer's GSTIN state stands in, and then the seller's own. The basis is
 * kept with the answer, because the place of supply is the first thing a GST
 * audit checks.
 *
 * Numbers run PREFIX/26-27/0001, consecutive per GSTIN per financial year,
 * never reused, at most 16 characters of letters, digits, "-" and "/"
 * (Rule 46(b) CGST Rules).
 *
 * Money received is matched to an issued invoice from its customer's payments
 * on the invoice's own trips first, then those written on the trips' sheets,
 * oldest first, never past what is still due (`matchReceipts`).
 */
import { add, cmp, dec, mul, percentOf, roundTo, sub, sum, toFixed, toNumber, type Dec, type Decimalish } from './decimal.js';
import { GSTIN_PATTERN } from './gstin.js';

/** The rules' version, kept on each invoice the API writes. */
export const INVOICE_RULES_VERSION = 'invoice-v1';

/** Intra-state (CGST + SGST) or inter-state (IGST). */
export type SupplyType = 'intra' | 'inter';
/** Why the place of supply is what it is. `chosen`: set by hand on the draft. */
export type PosBasis = 'delivery_location' | 'buyer_gstin' | 'seller_state' | 'chosen';
export type InvoiceStatus = 'draft' | 'issued' | 'cancelled';
/** B2B when the buyer has a GSTIN (it is printed); B2C otherwise. */
export type InvoiceKind = 'b2b' | 'b2c';
/** An issued invoice's money: nothing in yet, some, or all of it. */
export type MoneyStatus = 'due' | 'part_paid' | 'paid';

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['draft', 'issued', 'cancelled'];
export const POS_BASES: readonly PosBasis[] = ['delivery_location', 'buyer_gstin', 'seller_state', 'chosen'];

/**
 * The GST state codes, in the names the GST portal uses. 25 (Daman and Diu)
 * merged into 26 in 2020, and 28 is Andhra Pradesh's code before 2014; both
 * are left out of what a place of supply can be.
 */
export const GST_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

const ZERO = dec(0);
const HALF = dec('0.5');
const money = (d: Dec) => toFixed(d, 2);
const positive = (d: Dec) => cmp(d, ZERO) > 0;
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------ the parties */

/** The state a GSTIN is registered in: its first two digits. Null for anything that is not a GSTIN. */
export function stateOfGstin(gstin: string | null | undefined): string | null {
  const v = (gstin ?? '').trim().toUpperCase();
  return GSTIN_PATTERN.test(v) ? v.slice(0, 2) : null;
}

export function invoiceKind(buyerGstin: string | null | undefined): InvoiceKind {
  return stateOfGstin(buyerGstin) ? 'b2b' : 'b2c';
}

/** Inter-state exactly when the place of supply is not the seller's own state. */
export function supplyType(sellerState: string, placeOfSupply: string): SupplyType {
  return sellerState === placeOfSupply ? 'intra' : 'inter';
}

export interface PlaceOfSupplyInput {
  /** The state of each line's delivery location, where the master knows it. */
  deliveryStates: readonly (string | null | undefined)[];
  buyerGstin?: string | null;
  sellerState: string;
}

export type PlaceOfSupply =
  | { stateCode: string; basis: PosBasis }
  /** Lines delivered to two states are two invoices: one invoice has one place of supply. */
  | { problem: 'places-differ'; states: string[] };

/**
 * Where the goods went decides it, not where the buyer is registered: a
 * Chennai builder's site across the border is an inter-state supply. A line
 * whose location has no state yet goes with the others.
 */
export function placeOfSupply(input: PlaceOfSupplyInput): PlaceOfSupply {
  const known = [...new Set(input.deliveryStates.filter((s): s is string => Boolean(s)))].sort(byKey);
  if (known.length > 1) return { problem: 'places-differ', states: known };
  if (known.length === 1) return { stateCode: known[0]!, basis: 'delivery_location' };
  const registered = stateOfGstin(input.buyerGstin);
  if (registered) return { stateCode: registered, basis: 'buyer_gstin' };
  return { stateCode: input.sellerState, basis: 'seller_state' };
}

/* -------------------------------------------------------------- the sums */

/** One sale line of a trip, as the invoice bills it. */
export interface InvoiceLineInput {
  id: string;
  quantity: Decimalish | null;
  rate: Decimalish | null;
  /** The workbook's AR: inside the taxable value, at the line's own rate. */
  transport?: Decimalish | null;
  gstRatePct: Decimalish | null;
  hsnCode?: string | null;
}

export interface InvoiceLineFigures {
  /** Quantity × rate. */
  amount: string;
  transport: string;
  /** Amount + transport: the value tax is charged on. */
  taxable: string;
  gstRatePct: number;
  /** Half the rate each when intra-state, else 0. */
  cgstPct: number;
  sgstPct: number;
  /** The whole rate when inter-state, else 0. */
  igstPct: number;
  cgst: string;
  sgst: string;
  igst: string;
  /** Taxable + its tax. */
  total: string;
}

/** The tax by HSN and rate, as printed under the lines (and as GSTR-1's HSN summary adds it up). */
export interface TaxRow {
  hsnCode: string | null;
  gstRatePct: number;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  tax: string;
}

export interface InvoiceFigures {
  supply: SupplyType;
  lines: Record<string, InvoiceLineFigures>;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  /** CGST + SGST + IGST. */
  tax: string;
  /** Taxable + tax, before rounding to the rupee. */
  beforeRounding: string;
  /** What rounding to the rupee added (or took away): its own line on the invoice. */
  roundOff: string;
  /** Whole rupees. */
  total: string;
  /** The total in words, in English. */
  words: string;
  byHsn: TaxRow[];
}

/** AO × AQ + AR, then the tax the supply type calls for, each rounded to the paisa once. */
export function lineFigures(line: InvoiceLineInput, supply: SupplyType): InvoiceLineFigures {
  const amount = roundTo(mul(dec(line.quantity), dec(line.rate)), 2);
  const transport = roundTo(dec(line.transport), 2);
  const taxable = add(amount, transport);
  const rate = dec(line.gstRatePct);
  const half = mul(rate, HALF);
  const intra = supply === 'intra';
  const cgst = intra ? percentOf(taxable, half) : ZERO;
  const sgst = intra ? percentOf(taxable, half) : ZERO;
  const igst = intra ? ZERO : percentOf(taxable, rate);
  return {
    amount: money(amount),
    transport: money(transport),
    taxable: money(taxable),
    gstRatePct: toNumber(rate),
    cgstPct: intra ? toNumber(half) : 0,
    sgstPct: intra ? toNumber(half) : 0,
    igstPct: intra ? 0 : toNumber(rate),
    cgst: money(cgst),
    sgst: money(sgst),
    igst: money(igst),
    total: money(add(add(taxable, cgst), add(sgst, igst))),
  };
}

/** A total to the rupee, half away from zero, and what that added: +0.50 at most, −0.49 at least. */
export function roundToRupee(amount: Decimalish | Dec): { total: string; roundOff: string } {
  const before = roundTo(typeof amount === 'object' ? amount : dec(amount), 2);
  const total = roundTo(before, 0);
  return { total: money(total), roundOff: money(sub(total, before)) };
}

export function invoiceFigures(lines: readonly InvoiceLineInput[], supply: SupplyType): InvoiceFigures {
  const figures: Record<string, InvoiceLineFigures> = {};
  const rows = new Map<string, { hsnCode: string | null; rate: Dec; taxable: Dec; cgst: Dec; sgst: Dec; igst: Dec }>();
  for (const line of lines) {
    const f = lineFigures(line, supply);
    figures[line.id] = f;
    const hsnCode = line.hsnCode || null;
    const rate = dec(line.gstRatePct);
    const key = `${hsnCode ?? ''}|${toFixed(rate, 2)}`;
    const row = rows.get(key) ?? { hsnCode, rate, taxable: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO };
    row.taxable = add(row.taxable, dec(f.taxable));
    row.cgst = add(row.cgst, dec(f.cgst));
    row.sgst = add(row.sgst, dec(f.sgst));
    row.igst = add(row.igst, dec(f.igst));
    rows.set(key, row);
  }
  const all = Object.values(figures);
  const total = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => sum(all.map((f) => dec(f[k])));
  const taxable = total('taxable');
  const cgst = total('cgst');
  const sgst = total('sgst');
  const igst = total('igst');
  const tax = add(add(cgst, sgst), igst);
  const before = add(taxable, tax);
  const rounded = roundToRupee(before);
  return {
    supply,
    lines: figures,
    taxable: money(taxable),
    cgst: money(cgst),
    sgst: money(sgst),
    igst: money(igst),
    tax: money(tax),
    beforeRounding: money(before),
    roundOff: rounded.roundOff,
    total: rounded.total,
    words: amountInWords(rounded.total),
    byHsn: [...rows.values()]
      .sort((a, b) => byKey(a.hsnCode ?? '', b.hsnCode ?? '') || cmp(a.rate, b.rate))
      .map((r) => ({
        hsnCode: r.hsnCode,
        gstRatePct: toNumber(r.rate),
        taxable: money(r.taxable),
        cgst: money(r.cgst),
        sgst: money(r.sgst),
        igst: money(r.igst),
        tax: money(add(add(r.cgst, r.sgst), r.igst)),
      })),
  };
}

/* ------------------------------------------------------------- in words */

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n]!;
  const ones = n % 10;
  return ones ? `${TENS[Math.floor(n / 10)]!} ${ONES[ones]!}` : TENS[Math.floor(n / 10)]!;
}

function below1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]!} Hundred` : '', rest ? below100(rest) : ''].filter(Boolean).join(' ');
}

/** The Indian way: crore, lakh, thousand, hundred. A count of crores is itself said the same way. */
function indian(n: bigint): string {
  if (n === 0n) return ONES[0]!;
  const parts: string[] = [];
  const crore = n / 10_000_000n;
  let rest = n % 10_000_000n;
  if (crore > 0n) parts.push(`${indian(crore)} Crore`);
  const lakh = Number(rest / 100_000n);
  rest %= 100_000n;
  const thousand = Number(rest / 1_000n);
  const hundreds = Number(rest % 1_000n);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (hundreds) parts.push(below1000(hundreds));
  return parts.join(' ');
}

/**
 * "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only".
 *
 * The one sentence this package returns, against the rule that the domain
 * gives codes and the screen the words: the amount in words is part of the
 * invoice itself, and invoices in this trade say it in English whatever
 * language the clerk reads, so it is worked out here, once, and tested on
 * both sides like any other figure.
 */
export function amountInWords(amount: Decimalish): string {
  const paise = roundTo(dec(amount), 2).units;
  const negative = paise < 0n;
  const whole = negative ? -paise : paise;
  const rupees = whole / 100n;
  const rest = Number(whole % 100n);
  const words = `Rupees ${indian(rupees)}${rest ? ` and ${below100(rest)} Paise` : ''} Only`;
  return negative ? `Minus ${words}` : words;
}

/* -------------------------------------------------------------- numbers */

/** Rule 46(b): at most 16 characters, letters, digits, hyphen and slash only. */
export const INVOICE_NUMBER_PATTERN = /^[A-Za-z0-9/-]{1,16}$/;
/** A series' prefix: up to four capitals or digits, so PREFIX/26-27/99999 still fits in 16. */
export const INVOICE_PREFIX_PATTERN = /^[A-Z0-9]{1,4}$/;

/** "INV/26-27/0007": the prefix, the financial year, the serial to four places at least. */
export function invoiceNumber(prefix: string, financialYear: string, serial: number): string {
  return `${prefix}/${financialYear}/${String(serial).padStart(4, '0')}`;
}

export function isInvoiceNumber(value: string): boolean {
  return INVOICE_NUMBER_PATTERN.test(value);
}

/* --------------------------------------------------------- money received */

/** A customer's payment that could be matched to an invoice, and what of it is not matched yet. */
export interface ReceiptCandidate {
  paymentId: string;
  /** Written on one of the invoice's own trips (true), or on one of their sheets (false). */
  onTrip: boolean;
  /** YYYY-MM-DD. */
  paidOn: string;
  /** What of the payment no invoice has taken yet. */
  free: Decimalish;
}

export interface ReceiptMatch {
  paymentId: string;
  amount: string;
}

/**
 * Match payments to what an invoice still has due: those on its own trips
 * first, then those written on the trips' sheets, each oldest first (then by
 * id), each up to what of it is free, never past what is due.
 */
export function matchReceipts(due: Decimalish, candidates: readonly ReceiptCandidate[]): ReceiptMatch[] {
  let left = roundTo(dec(due), 2);
  const order = [...candidates].sort(
    (a, b) => Number(b.onTrip) - Number(a.onTrip) || byKey(a.paidOn, b.paidOn) || byKey(a.paymentId, b.paymentId),
  );
  const out: ReceiptMatch[] = [];
  for (const c of order) {
    if (!positive(left)) break;
    const free = roundTo(dec(c.free), 2);
    if (!positive(free)) continue;
    const take = cmp(free, left) < 0 ? free : left;
    out.push({ paymentId: c.paymentId, amount: money(take) });
    left = sub(left, take);
  }
  return out;
}

/** What an issued invoice still has due: its total less what was matched to it, never below nothing. */
export function invoiceDue(total: Decimalish, received: Decimalish): string {
  const due = sub(dec(total), dec(received));
  return money(positive(due) ? due : ZERO);
}

export function moneyStatus(total: Decimalish, received: Decimalish): MoneyStatus {
  if (cmp(dec(received), dec(total)) >= 0) return 'paid';
  return positive(dec(received)) ? 'part_paid' : 'due';
}
