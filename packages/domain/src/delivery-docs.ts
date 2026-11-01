/**
 * DELIVERY DOCUMENT CROSS-CHECK.
 *
 * One load of material usually leaves three pieces of paper behind, each
 * written by a different party:
 *
 *   - the DELIVERY CHALLAN (DC) printed by the crusher or quarry that loaded it,
 *   - the TRANSPORTER'S MATERIAL RECEIVED challan, and
 *   - the customer's DELIVERY MEMO, written at the site that received it.
 *
 * They are meant to describe the same truck, the same material and the same
 * weight. This module reads the text off each (from OCR or typed in), works
 * out which paper it is, pulls the fields out, and compares them.
 *
 * Nothing here knows any company, vehicle, material or layout. It knows:
 *   - the WORDS these papers use for each field ("Lorry No", "Truck #" and
 *     "Vehicle No" are all the vehicle),
 *   - the SHAPES of Indian values (registration numbers, dd.mm.yy dates,
 *     "50.75 MT", "50,750 kg"), and
 *   - the trade's own synonyms for materials ("jelly" and "blue metal" are
 *     both aggregate).
 *
 * Rules it keeps:
 *   - The raw value is kept exactly as it stands on the paper, beside the
 *     normalized form used for comparison.
 *   - A value that cannot be read or normalized is UNCLEAR, never a guess.
 *   - A field that is not on a paper is MISSING. It is never filled in from
 *     another paper. A paper's own figure may stand in for a field it names
 *     differently — a memo's "Quantity Recd: 50.75 MT" is the net weight it
 *     received — and is then marked with the label it was read from.
 *   - Nothing is MATCHED that was not actually compared.
 *   - It never writes a sentence. Everything a person reads — why a paper
 *     was not recognised, why a value is UNCLEAR, what a comparison found,
 *     the problems with the load — is a CODE WITH VALUES (`TypeNote`,
 *     `ValueNote`, `NetFinding`, `FieldFinding`, `CrossCheckIssue`), and
 *     the screen words it in the reader's language (docs/WRITING.md).
 *     Papers are referred to by their id; `paperName` says how to call one.
 *
 * Pure functions, no DOM — the React Native app uses them unchanged.
 */

import { unitsToCft } from './uom.js';

/* ------------------------------------------------------------------ types */

export type DeliveryDocType = 'delivery_challan' | 'delivery_memo' | 'material_received' | 'unknown';
export type DeliveryPaperType = Exclude<DeliveryDocType, 'unknown'>;

/** The three papers of one load, in the order the issue's comparison table has them. */
export const DELIVERY_PAPER_TYPES: readonly DeliveryPaperType[] = ['delivery_challan', 'delivery_memo', 'material_received'];

export type DeliveryFieldKey =
  | 'documentNumber'
  | 'date'
  | 'issuer'
  | 'party'
  | 'vehicle'
  | 'material'
  | 'quantity'
  | 'grossWeight'
  | 'tareWeight'
  | 'netWeight'
  | 'loadingLocation'
  | 'unloadingLocation';

export type ComparedField = 'vehicle' | 'date' | 'material' | 'quantity' | 'netWeight' | 'party';

/** The rows of the cross-check table, in the issue's order. */
export const COMPARED_FIELDS: readonly ComparedField[] = ['vehicle', 'date', 'material', 'quantity', 'netWeight', 'party'];

/** Marks a value that was on the paper but could not be read. */
export const UNCLEAR = 'UNCLEAR';

export type AmountUnit = 'MT' | 'CFT' | 'UNIT';

/** A unit as written, before kg is brought to tonnes. */
export type WrittenUnit = 'kg' | 'MT' | 'CFT' | 'UNIT';

/** Papers that turn up in the same pile as delivery papers, and are not one. */
export type OtherPaper = 'tax-invoice' | 'weighbridge-slip' | 'cash-memo' | 'fuel-bill' | 'quotation';

/** Why a paper was left unrecognised. */
export type TypeNote =
  /** No text was given: a photo still waiting to be typed in. */
  | { code: 'no-text' }
  /** Nothing on it names a delivery challan, a delivery memo or a material-received paper. */
  | { code: 'no-delivery-words' }
  /** It reads as another kind of paper, and has no delivery paper's title. */
  | { code: 'other-paper'; paper: OtherPaper }
  /** It reads equally as two delivery papers. */
  | { code: 'tie'; types: [DeliveryPaperType, DeliveryPaperType] }
  /** Only these words point to the type, without its title: not enough to say. */
  | { code: 'weak'; type: DeliveryPaperType; evidence: string[] };

/** Why a value is UNCLEAR, or what was assumed in reading it. */
export type ValueNote =
  /** The text says it could not be read: "?", "[illegible]". */
  | { code: 'marked-unreadable' }
  | { code: 'not-a-registration' }
  /** Registrations, compacted. */
  | { code: 'two-registrations'; found: string[] }
  | { code: 'not-a-date' }
  /** Reads as a date that is not on the calendar: 31.02.26. */
  | { code: 'no-such-date' }
  | { code: 'percentage' }
  | { code: 'no-number' }
  | { code: 'many-numbers' }
  /** A run of digits that is not a number: "50..75". */
  | { code: 'bad-number'; token: string }
  /** A word after the figure that is not a unit of weight or volume. */
  | { code: 'not-a-unit'; word: string }
  /** No unit written; read in the unit the paper's other weights are written in. */
  | { code: 'unit-from-paper'; unit: WrittenUnit }
  /** No unit written, and `figure` tonnes is not a truckload: read as kg. */
  | { code: 'read-as-kg'; figure: number }
  /** No unit written: read as tonnes. */
  | { code: 'read-as-tonnes' }
  /** Not a plausible truckload: the unit or the decimal point may be misread. */
  | { code: 'not-a-load'; tonnes: number }
  | { code: 'written-in-kg' }
  | { code: 'empty' }
  /** A size and nothing else: "20 MM". */
  | { code: 'size-only' }
  /** Not a material the trade's names are known for; compared as written. */
  | { code: 'material-unknown' }
  /** The line under a row of headings could not be lined up with them. */
  | { code: 'columns-misaligned' };

export interface ExtractedValue {
  /** Exactly as it stands on the paper. Only the label and the separators around it are left off. */
  raw: string;
  /**
   * The comparison form: ISO date, compact registration, tonnes, a material
   * key. `UNCLEAR` when the raw text could not be normalized. Never invented.
   */
  normalized: string;
  /** Weights in tonnes; volumes in their own unit. */
  amount?: number;
  unit?: AmountUnit;
  /** Why a value is UNCLEAR, or what was assumed in reading it. */
  note?: ValueNote;
  /** The label it was read under, as printed. */
  label?: string;
  /** Set when a paper's own figure stands in for a field it names differently. */
  derivedFrom?: DeliveryFieldKey;
}

export interface ExtractedDocument {
  /** The caller's handle for the paper. Unique in one cross-check. */
  id: string;
  /** What to call the paper when its type does not say enough — a file name, say. */
  name: string;
  type: DeliveryDocType;
  /** 0 when the type is unknown; else 1 (weak) to 3 (its own title, nothing competing). */
  typeConfidence: 0 | 1 | 2 | 3;
  /**
   * The phrases that decided the type — shown so a human can disagree. They
   * are the trade's printed words ("DC no", "quantity received"), so a screen
   * quotes them rather than translating them.
   */
  typeEvidence: string[];
  /** Why a paper was left unrecognised. */
  typeNote: TypeNote | null;
  /** No text was given: a photo still waiting to be read or typed in. */
  unread: boolean;
  fields: Partial<Record<DeliveryFieldKey, ExtractedValue>>;
  /** Net = gross − tare, worked out on this paper's own numbers. */
  netCheck: NetWeightCheck;
}

/** Whether a weight the net check needs is on the paper. */
export type WeightPresence = 'read' | 'unreadable' | 'absent';

/** What a paper's own net = gross − tare came to. Weights in kg. */
export type NetFinding =
  /** No weights at all — normal for a memo. */
  | { code: 'no-weights' }
  /** Only the net is written: there is no gross or tare to check it against. */
  | { code: 'net-only' }
  /** Gross − tare cannot be worked out: one of them, at least, is not `read`. */
  | { code: 'no-gross-or-tare'; gross: WeightPresence; tare: WeightPresence }
  /** Gross − tare is worked out, but there is no readable net to check it against. */
  | { code: 'no-net'; calculatedKg: number; net: Exclude<WeightPresence, 'read'> }
  | { code: 'adds-up'; grossKg: number; tareKg: number; netKg: number }
  /** `differenceKg` is the written net minus gross − tare: above 0 when the paper says more. */
  | { code: 'does-not-add-up'; grossKg: number; tareKg: number; calculatedKg: number; statedKg: number; differenceKg: number };

/** Weights on one paper that cannot all be true. */
export type WeightConflict =
  | { code: 'tare-not-below-gross'; tareKg: number; grossKg: number }
  | { code: 'net-above-gross'; netKg: number; grossKg: number };

export interface NetWeightCheck {
  /**
   * OK and MISMATCH compare the written net with gross − tare, to the
   * kilogram. NOT_POSSIBLE: the paper shows some of the three weights but not
   * enough readable ones to check. NOT_APPLICABLE: it shows no gross or tare
   * at all, which is normal for a memo.
   */
  status: 'OK' | 'MISMATCH' | 'NOT_POSSIBLE' | 'NOT_APPLICABLE';
  /** Tonnes. */
  calculated: number | null;
  /** Tonnes. */
  stated: number | null;
  /** Written net minus gross − tare, in kg. */
  differenceKg: number | null;
  /**
   * The numbers that ARE on the paper cannot all be true — a net heavier than
   * the gross, a tare heavier than the gross. True exactly when `conflicts`
   * is not empty.
   */
  implausible: boolean;
  conflicts: WeightConflict[];
  finding: NetFinding;
}

export type FieldStatus = 'MATCH' | 'MISMATCH' | 'MISSING' | 'UNCLEAR';

/** One paper's value in a comparison. */
export interface PaperValue {
  docId: string;
  value: ExtractedValue;
}

/** Why two papers agree although their values are not the same. */
export type AgreementNote =
  | { code: 'kg-apart'; kg: number }
  | { code: 'days-apart'; days: number }
  /** A volume and trade units that come to the same, at 100 CFT a unit. */
  | { code: 'same-volume'; cft: number }
  /** One paper gives only the size; the other names the material as well. */
  | { code: 'size-only'; size: string };

export interface PairAgreement {
  docIds: [string, string];
  note: AgreementNote;
}

/** How far apart papers may be and still agree: two weighbridges, or a load that crosses midnight. */
export type Allowance = { code: 'kg'; kg: number } | { code: 'days'; days: number };

/** A paper's party who issued another paper in the load: that link of the chain holds. */
export interface PartyLink {
  docId: string;
  /** As written on the paper. */
  party: string;
  /** The paper whose letterhead names the same party. */
  issuerDocId: string;
  /** The distinctive words the two names share; empty when the whole name matches. */
  sharedWords: string[];
}

/** A paper's party who issued none of the other papers: that link is broken. */
export interface PartyBreak {
  docId: string;
  /** As written on the paper. */
  party: string;
  /** The other papers' letterheads, as written. */
  issuers: { docId: string; issuer: string }[];
}

/** What comparing one field across the papers found. */
export type FieldFinding =
  /** MISMATCH: the readable values, which do not all agree. */
  | { code: 'differs'; values: PaperValue[] }
  /** UNCLEAR: a weight and a volume, which only an agreed density could turn into one another. */
  | { code: 'weight-and-volume'; values: PaperValue[] }
  /** UNCLEAR: these papers carry it, unreadably. `note` is why, on the first of them. */
  | { code: 'unreadable'; docIds: string[]; note: ValueNote | null }
  /** MISSING: no paper carries it. */
  | { code: 'on-no-paper' }
  /** MISSING: one paper carries it, so there is nothing to check it against. */
  | { code: 'on-one-paper'; docId: string }
  /** MISSING: the material agrees, but its size is written on one paper and not the other. */
  | { code: 'size-on-one-paper'; size: string; values: PaperValue[] }
  /** MISSING: the papers that carry it agree; the `missing` ones do not carry it. */
  | { code: 'not-on-every-paper'; agreeing: string[]; missing: string[] }
  /** MATCH, but not to the letter: why each pair still agrees, and the allowance used, if any. */
  | { code: 'close-enough'; pairs: PairAgreement[]; allowance: Allowance | null }
  /** Supplier/Party MISMATCH: a party issued none of the other papers. `links` are the links that hold. */
  | { code: 'party-not-issuer'; breaks: PartyBreak[]; links: PartyLink[] }
  /** Supplier/Party UNCLEAR. */
  | { code: 'party-unreadable'; docIds: string[]; links: PartyLink[] }
  /** Supplier/Party MISSING: no paper names a party whose letterhead is on another paper. */
  | { code: 'party-unlinked' }
  /** Supplier/Party MISSING: the links hold, but the `missing` papers name no party. */
  | { code: 'party-missing'; links: PartyLink[]; missing: string[] }
  /** Supplier/Party MATCH: every party named issued another paper. */
  | { code: 'party-linked'; links: PartyLink[] };

export interface FieldComparison {
  field: ComparedField;
  /** One entry per paper, in the order the papers were given. */
  values: { docId: string; docType: DeliveryDocType; value: ExtractedValue | null }[];
  status: FieldStatus;
  /** Papers that were read and do not carry this field. */
  missingOn: string[];
  /** What was found. Null only for a plain match. */
  finding: FieldFinding | null;
  /** On a MISMATCH, how many papers are out of line with the largest group that agrees; else 0. */
  disagreements: number;
}

export type OverallResult = 'MATCHED' | 'PARTIALLY MATCHED' | 'MISMATCHED';

/** One problem with the load. */
export type CrossCheckIssue =
  /** A compared field that is not a plain match; its comparison holds the values. */
  | { code: 'field'; field: ComparedField; status: FieldStatus; finding: FieldFinding }
  /** A paper whose own net = gross − tare fails, cannot be worked out, or holds weights that cannot all be true. */
  | { code: 'net'; docId: string; status: NetWeightCheck['status']; finding: NetFinding; conflicts: WeightConflict[] }
  /** No paper shows a gross and a tare weight, so no net was checked. */
  | { code: 'no-weights-anywhere' }
  /** A paper with no text: nothing on it was read or checked. */
  | { code: 'no-text'; docId: string }
  | { code: 'unknown-paper'; docId: string; note: TypeNote | null }
  /** More than one paper reads as one type; a load has one of each. */
  | { code: 'same-type-twice'; type: DeliveryPaperType; docIds: string[] }
  /** Paper types the load has that were not among these, so that part of it went unchecked. */
  | { code: 'papers-missing'; types: DeliveryPaperType[] }
  | { code: 'too-few-papers' };

export interface CrossCheckResult {
  documents: ExtractedDocument[];
  comparisons: FieldComparison[];
  overall: OverallResult;
  /** Disagreements: mismatched fields and papers whose own arithmetic fails. */
  mismatchCount: number;
  /** Paper types a load has that were not among the papers given. */
  missingTypes: DeliveryPaperType[];
  /** One per problem, worst first. Empty only when MATCHED. */
  issues: CrossCheckIssue[];
}

export interface CrossCheckOptions {
  /** Two weighbridges may differ by this much and still agree. */
  weightToleranceKg?: number;
  /** Papers dated this many days apart still agree — a load that crosses midnight. */
  dateWindowDays?: number;
}

/** Two weighbridges' display steps. Within one paper, the arithmetic must be exact. */
export const DEFAULT_WEIGHT_TOLERANCE_KG = 50;
export const DEFAULT_DATE_WINDOW_DAYS = 1;

/* -------------------------------------------------------- classification */

interface Signal {
  pattern: RegExp;
  weight: number;
  label: string;
  /** The paper's own title. One is enough to name the paper. */
  title?: true;
}

/**
 * Words that say which paper this is, with weights. The full title outweighs
 * any single word: "Material Received Challan" contains "challan" and still
 * is not a DC.
 */
const TYPE_SIGNALS: Record<DeliveryPaperType, Signal[]> = {
  delivery_challan: [
    { pattern: /\bdelivery\s+challan\b/i, weight: 6, label: 'delivery challan', title: true },
    { pattern: /\bdc\s*(?:no\b|number\b|\/\s*ref|#)/i, weight: 4, label: 'DC no' },
    { pattern: /\b(?:outgoing|dispatch|despatch)\s+(?:trip|slip)\b/i, weight: 2, label: 'outgoing trip' },
    { pattern: /\bgstin\b/i, weight: 1, label: 'GSTIN' },
    { pattern: /\bhsn\b/i, weight: 1, label: 'HSN' },
    { pattern: /\b(?:full|gross)\s+(?:qty|wt|weight)\b/i, weight: 1, label: 'gross/full weight' },
  ],
  delivery_memo: [
    { pattern: /\bdelivery\s+memo\b/i, weight: 6, label: 'delivery memo', title: true },
    // A fuel pump's "cash memo" is not a delivery memo.
    { pattern: /(?<!\bcash\s{0,3})\bmemo\b/i, weight: 2, label: 'memo' },
    { pattern: /\bproject\s+site\b/i, weight: 2, label: 'project site' },
    { pattern: /\b(?:quantity|qty)\s+(?:rec(?:ei|ie)?ve?d|recd|rcvd)\b/i, weight: 2, label: 'quantity received' },
    { pattern: /\bp\.?\s*o\.?\s*no\b/i, weight: 1, label: 'P.O. no' },
    { pattern: /\bsite[\s-]*in[\s-]*charge\b/i, weight: 1, label: 'site-in-charge' },
  ],
  material_received: [
    { pattern: /\bmaterials?\s+rec(?:ei|ie)ved\b/i, weight: 6, label: 'material received', title: true },
    { pattern: /\bgoods\s+rec(?:ei|ie)ved\b|\bgrn\b/i, weight: 5, label: 'goods received', title: true },
    { pattern: /\breceived\s+challan\b/i, weight: 3, label: 'received challan' },
    { pattern: /\btransport(?:er|ers)?\b/i, weight: 1, label: 'transporter' },
    { pattern: /\bdriver\s+signature\b/i, weight: 1, label: 'driver signature' },
  ],
};

/**
 * Other papers that turn up in the same pile. Without a delivery paper's own
 * title, a word like GSTIN or "Gross Wt" does not make a tax invoice or a
 * weighbridge slip into a DC.
 */
const OTHER_PAPERS: { pattern: RegExp; paper: OtherPaper }[] = [
  { pattern: /\btax\s+invoice\b/i, paper: 'tax-invoice' },
  { pattern: /\bweigh(?:ment|ing)\s+(?:slip|ticket|receipt)\b|\bweigh\s*bridge\s+(?:slip|ticket|receipt)\b/i, paper: 'weighbridge-slip' },
  { pattern: /\bcash\s+(?:memo|bill|receipt)\b/i, paper: 'cash-memo' },
  { pattern: /\b(?:diesel|petrol|hsd)\b/i, paper: 'fuel-bill' },
  { pattern: /\bquotation\b|\bpro[\s-]?forma\b/i, paper: 'quotation' },
];

export interface Classification {
  type: DeliveryDocType;
  /** 0 when unknown; 1 weak, 2 fair, 3 its own title and nothing competing. */
  confidence: 0 | 1 | 2 | 3;
  evidence: string[];
  /** Why the paper was left unrecognised. Null when it was recognised. */
  note: TypeNote | null;
}

export function classifyDeliveryDocument(text: string): Classification {
  const scored = DELIVERY_PAPER_TYPES.map((type) => {
    const hits = TYPE_SIGNALS[type].filter((s) => s.pattern.test(text));
    return {
      type,
      score: hits.reduce((sum, h) => sum + h.weight, 0),
      titled: hits.some((h) => h.title),
      evidence: hits.map((h) => h.label),
    };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const second = scored[1]!;
  const unknown = (note: TypeNote, evidence = best.evidence): Classification => ({ type: 'unknown', confidence: 0, evidence, note });

  if (best.score === 0) return unknown({ code: 'no-delivery-words' }, []);
  const other = OTHER_PAPERS.find((o) => o.pattern.test(text));
  if (!best.titled && other) return unknown({ code: 'other-paper', paper: other.paper });
  if (second.score === best.score) {
    return unknown({ code: 'tie', types: [best.type, second.type] }, [...best.evidence, ...second.evidence]);
  }
  // Without the title, it takes two independent signs that add up.
  if (!best.titled && (best.evidence.length < 2 || best.score < 4)) {
    return unknown({ code: 'weak', type: best.type, evidence: best.evidence });
  }
  const margin = best.score - second.score;
  const confidence = best.titled && !second.titled && margin >= 4 ? 3 : best.titled || margin >= 4 ? 2 : 1;
  return { type: best.type, confidence, evidence: best.evidence, note: null };
}

/* -------------------------------------------------------------- labels */

type LabelField = Exclude<DeliveryFieldKey, 'issuer'>;

/**
 * Field labels as they are printed, MOST SPECIFIC FIRST: when a paper carries
 * two labels for one field, the one earlier in its list wins — "DC No" over a
 * bare "No.", "Date" over "Invoice Date", "Location of Unloading" over
 * "Project Site", wherever each sits on the page.
 *
 * Which label a stretch of text is read as is a separate question: the
 * longest label that fits wins, so "Net Qty" is never read as "Qty".
 */
const FIELD_LABELS: Record<LabelField, string[]> = {
  documentNumber: [
    'dc/ref #', 'dc/ref no', 'dc/ref', 'dc no', 'dc number', 'challan no', 'challan number', 'memo no', 'receipt no', 'grn no',
    'bill no', 'ref no', 'document no', 'doc no', 'serial no', 'invoice no', 'no',
  ],
  date: ['date', 'dated', 'dt', 'date of delivery', 'delivery date', 'date of receipt', 'invoice date', 'dc date', 'trip date'],
  party: [
    'supplier name', 'supplier', 'party name', 'party', 'consignee', 'consignor', 'customer name', 'customer', 'sold to',
    'billed to', 'bill to', 'buyer', 'vendor',
  ],
  vehicle: [
    'vehicle no', 'vehicle number', 'vehicle reg no', 'veh no', 'lorry no', 'lorry number', 'truck no', 'truck number', 'truck #',
    'tipper no', 'tractor no', 'registration no', 'reg no', 'vehicle', 'lorry', 'truck', 'tipper',
  ],
  material: [
    'material name', 'name of material', 'description of goods', 'description of material', 'material description', 'material',
    'item name', 'item description', 'item', 'product', 'description', 'particulars',
  ],
  quantity: ['quantity received', 'quantity recd', 'qty received', 'qty recd', 'quantity', 'qty'],
  grossWeight: [
    'gross weight', 'gross wt', 'gross qty', 'loaded weight', 'load weight', 'loaded wt', 'load wt', 'full weight', 'full wt',
    'full qty', 'gross',
  ],
  tareWeight: ['tare weight', 'tare wt', 'empty weight', 'empty wt', 'empty qty', 'unladen weight', 'unladen wt', 'tare'],
  netWeight: ['net weight', 'net wt', 'net qty', 'net quantity', 'net'],
  loadingLocation: ['loading point', 'loading place', 'place of loading', 'loading at', 'loaded at', 'loading', 'from place', 'source', 'quarry'],
  unloadingLocation: [
    'location of unloading', 'place of unloading', 'unloading point', 'unloading place', 'place of delivery', 'delivery at',
    'deliver to', 'delivered at', 'unloading', 'destination', 'project site', 'site name', 'site', 'place',
  ],
};

/**
 * Printed words that look like a field label but are not one. They are
 * matched so they stop the value before them and never lend their text to a
 * real field: "Customer Signature" is not a customer called "Signature",
 * "Sl. No." is a line-item serial, and "Plot No.7" in a letterhead is an
 * address, not the challan number.
 */
const NOT_FIELDS = [
  // Signature and office boxes.
  'customer signature', 'driver signature', 'receiver signature', 'authorised signatory', 'authorized signatory', 'signature',
  'measured by', 'checked by', 'prepared by', 'received by',
  // Numbers and dates that are not this paper's own.
  'sl no', 'si no', 's no', 'item code', 'p.o. no', 'po no', 'p.o. date', 'po date', 'order no', 'order date', 'e-way bill no',
  'eway bill no', 'lr no', 'hsn/sac', 'hsn', 'sac',
  // Letterhead numbers.
  'plot no', 'door no', 'shop no', 'old no', 'new no', 's.f. no', 'survey no', 'cell no', 'ph no', 'phone no', 'mobile no', 'mob no',
  'fax no', 'gst no', 'gstin no', 'gstin/uin', 'gstin', 'pan no', 'tin no', 'cin no', 'pincode', 'pin',
  // Other boxes on the form.
  'site-in-charge', 'store-in-charge', 'distance from quarry', 'in time', 'out time', 'payment mode', 'rate', 'amount',
  // Titles: the heading names the paper, it carries no value.
  'material received', 'materials received', 'goods received', 'received challan', 'delivery challan', 'delivery memo',
];

/** Titles among the markers: a bare "No." straight after one is the paper's own number. */
const TITLES = new Set(['material received', 'materials received', 'goods received', 'received challan', 'delivery challan', 'delivery memo']);

/** "UOM MT": the unit the paper counts in. */
const UOM_LABELS = ['unit of measurement', 'unit of measure', 'uom'];

interface LabelHit {
  /** Null for a marker; 'uom' for a unit-of-measure box. */
  field: LabelField | 'uom' | null;
  /** Position in its field's list: lower is more specific. */
  rank: number;
  label: string;
  /** As matched on the line. */
  text: string;
  start: number;
  end: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Spaces, dots and hyphens between a label's words match any run of them, or
 * none ("Lorry. No", "Veh.No", "P O No", "site-in-charge"); a slash may have
 * spaces round it. The label must not sit inside a longer word.
 */
function labelPattern(label: string): RegExp {
  const words = label
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((w) => escape(w).replace(/\//g, '\\s*\\/\\s*'));
  return new RegExp(`(?<![a-z0-9])${words.join('[\\s.\\-]*')}\\.?(?![a-z])`, 'gi');
}

interface Matcher {
  field: LabelHit['field'];
  rank: number;
  label: string;
  re: RegExp;
  /** Longest first. */
  order: number;
}

const MATCHERS: Matcher[] = [
  ...(Object.entries(FIELD_LABELS) as [LabelField, string[]][]).flatMap(([field, labels]) =>
    labels.map((label, rank): Matcher => ({ field, rank, label, re: labelPattern(label), order: label.length })),
  ),
  ...NOT_FIELDS.map((label): Matcher => ({ field: null, rank: 0, label, re: labelPattern(label), order: label.length })),
  ...UOM_LABELS.map((label): Matcher => ({ field: 'uom', rank: 0, label, re: labelPattern(label), order: label.length })),
  // Any other "<word> No." — "Book No.", "Token No.", "Survey No." — is a
  // number, but not this paper's. It bounds the value before it and gives
  // none. Tried after every real label and before a bare "No.".
  { field: null, rank: 0, label: '<word> no', re: /(?<![a-z0-9])[a-z]{2,}(?:\.\s*|[\s-]+)no\.?(?![a-z])/gi, order: 2.5 },
].sort((a, b) => b.order - a.order);

/** Labels that end in an abbreviation, whose own full stop is their separator: "Lorry No. TN 22…". */
const ABBREVIATED = /(?:\bno|\bwt|\bqty|\bdt|\bveh|\brecd|#)$/;
const UNIT_WORD = String.raw`(?:m\.?\s*t\.?s?|tonnes?|tons?|t|kgs?|kilograms?|cft|units?|am|pm)`;
const AFTER_FIGURE = new RegExp(String.raw`\d\s*${UNIT_WORD}?\.?\s*$`, 'i');
/** A run of spaces, fill dots or underscores, a tab or a rule: the gap a printed form leaves between boxes. */
const FORM_GAP = /(?:\s{2,}|\.{2,}|_{2,}|\t|\|)\s*$/;

/**
 * Whether a label found mid-line is a label, or a word inside the value
 * before it. "Unloading: PARTY SITE" holds neither a party nor a site;
 * "Load Wt 68.10 Empty Wt 17.35" holds two weights; "Goods once sold will not
 * be taken back" holds no field at all.
 */
function isLabel(line: string, hit: LabelHit, prev: LabelHit | undefined): boolean {
  if (hit.field === null || hit.field === 'uom') return true;
  const before = line.slice(0, hit.start);
  const atStart = /^[^a-z0-9]*$/i.test(before);
  const gap = FORM_GAP.test(before);
  const afterTitle = prev !== undefined && prev.field === null && TITLES.has(prev.label) && line.slice(prev.end, hit.start).trim() === '';
  // A bare "No." is this paper's number only where a form prints it: at the
  // start of a line, in its own box, or straight after the title.
  if (hit.label === 'no') return atStart || gap || afterTitle;
  const separated = /^\s*[:#=]/.test(line.slice(hit.end)) || (hit.text.endsWith('.') && ABBREVIATED.test(hit.label));
  // Two-word labels ("Vehicle No", "Net Wt") do not turn up inside values.
  const specific = /[\s./#-]/.test(hit.label);
  return atStart || gap || afterTitle || separated || specific || AFTER_FIGURE.test(before);
}

/** The labels on one line, left to right. */
function labelsOn(raw: string): LabelHit[] {
  // Bracketed asides are never labels — "(Building Material Suppliers)" under
  // a letterhead is not a material. Blanked, not removed, so every position
  // still points into the real line.
  const line = raw.replace(/\([^)]*\)/g, (m) => ' '.repeat(m.length));
  const taken: LabelHit[] = [];
  for (const m of MATCHERS) {
    m.re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = m.re.exec(line)) !== null) {
      const start = hit.index;
      const end = start + hit[0].length;
      if (hit[0].length === 0) {
        m.re.lastIndex += 1;
        continue;
      }
      if (taken.some((t) => start < t.end && end > t.start)) continue;
      taken.push({ field: m.field, rank: m.rank, label: m.label, text: raw.slice(start, end), start, end });
    }
  }
  taken.sort((a, b) => a.start - b.start);
  return taken.filter((hit, i) => isLabel(line, hit, taken[i - 1]));
}

/** Lines that head a block and are nobody's value: "OUTGOING TRIP", "Transport:". */
const HEADING =
  /^(?:(?:outgoing|incoming|return)\s+trip|(?:original|duplicate|triplicate)(?:\s+(?:copy|for\s+[a-z]+))?|measurements?|particulars|(?:office|customer|transporter|driver)\s+copy|for\s+office\s+use(?:\s+only)?|cash|credit|cash\s*\/\s*credit)$|:\s*$/i;

/** Strips the separators a form puts round a value. Nothing inside the value changes. */
function tidy(value: string): string {
  return value.replace(/^[\s:;.,#=\-–—_|]+/, '').replace(/[\s:;,=\-–—_|.]+$/, '');
}

/* ------------------------------------------------------- reading a paper */

function unitOf(text: string): WrittenUnit | null {
  const u = text.toLowerCase().replace(/[\s.]/g, '').replace(/^in/, '');
  if (/^(?:kgs?|kilograms?)$/.test(u)) return 'kg';
  if (/^(?:mts?|t|tonnes?|tons?|metrictons?)$/.test(u)) return 'MT';
  if (/^(?:cft|cuft|cubicf(?:ee|oo)?t)$/.test(u)) return 'CFT';
  if (/^(?:units?|brass)$/.test(u)) return 'UNIT';
  return null;
}

interface Candidate {
  field: LabelField;
  rank: number;
  /** The label, as printed. */
  label: string;
  raw: string;
  /** A unit printed beside the label: "Net Wt (Kg)". */
  labelUnit: WrittenUnit | null;
  /** Why the value could not be taken cleanly, when it could not. */
  problem: ValueNote | null;
}

interface PaperText {
  lines: string[];
  candidates: Partial<Record<LabelField, Candidate>>;
  /** The paper's own "UOM" box. */
  uom: WrittenUnit | null;
  /** The first line that carries a field label; the letterhead sits above it. */
  firstFieldLine: number;
}

/** OCR engines mark what they could not read; so do people transcribing. */
const UNREADABLE = /\?|�|\[(?:unclear|illegible|\?)\]|\billegible\b|\bunclear\b/i;

const AMOUNT_SHAPE = new RegExp(String.raw`^\d[\d,.]*\s*(?:${UNIT_WORD}|cu\.?\s*ft|brass)?\.?$`, 'i');

/**
 * Whether a value looks like its field at all. A footer's "Net weight subject
 * to 2% variation" is found under a net-weight label, but it is not the net
 * weight; the labelled "50.75 MT" further up is, whatever its label's rank.
 */
function shaped(c: Candidate): boolean {
  if (c.problem !== null || UNREADABLE.test(c.raw)) return true;
  switch (c.field) {
    case 'grossWeight':
    case 'tareWeight':
    case 'netWeight':
    case 'quantity':
      return AMOUNT_SHAPE.test(c.raw.replace(/\([^)]*\)/g, ' ').trim());
    case 'vehicle':
      return registrations(c.raw).length > 0;
    case 'date':
    case 'documentNumber':
      return /\d/.test(c.raw);
    default:
      return true;
  }
}

const FIGURE = new RegExp(String.raw`\d[\d,.]*\s*(?:${UNIT_WORD})?\.?`, 'gi');

/** Values under a row of headings, one per heading — or null when they cannot be lined up. */
function columnCells(line: string, count: number): string[] | null {
  const bySpacing = line
    .split(/\s{2,}|\t|\s*\|\s*/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (bySpacing.length === count) return bySpacing;
  // "68.10 17.35 50.75" — nothing but figures, one per heading.
  const figures = [...line.matchAll(FIGURE)].map((m) => m[0].trim());
  if (figures.length === count && line.replace(FIGURE, '').replace(/[|,;]/g, '').trim() === '') return figures;
  return null;
}

function readPaper(text: string): PaperText {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const candidates: Partial<Record<LabelField, Candidate>> = {};
  let uom: WrittenUnit | null = null;
  let firstFieldLine = lines.length;

  const offer = (c: Candidate) => {
    const current = candidates[c.field];
    if (!current) {
      candidates[c.field] = c;
      return;
    }
    // A value shaped like its field beats one that is not; then the more
    // specific label; then whichever came first on the page.
    const [mine, theirs] = [shaped(c), shaped(current)];
    if ((mine && !theirs) || (mine === theirs && c.rank < current.rank)) candidates[c.field] = c;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const hits = labelsOn(line);
    if (hits.some((h) => h.field !== null && h.field !== 'uom')) firstFieldLine = Math.min(firstFieldLine, i);
    const slots = hits.map((hit, k) => {
      const slice = line.slice(hit.end, hits[k + 1]?.start ?? line.length);
      // "Net Wt (Kg): 50750" — the bracket belongs to the label.
      const lead = /^\s*\(([^)]*)\)/.exec(slice);
      return { hit, value: tidy(lead ? slice.slice(lead[0].length) : slice), labelUnit: lead ? unitOf(lead[1]!) : null };
    });
    for (const s of slots) if (s.hit.field === 'uom' && uom === null) uom = unitOf(s.value);
    const valued = slots.filter((s) => s.hit.field !== null && s.hit.field !== 'uom');
    const next = lines[i + 1];
    const borrowable = next !== undefined && next !== '' && labelsOn(next).length === 0 && !HEADING.test(next);

    // A row of headings with the values on the line below:
    //   Gross Wt    Tare Wt    Net Wt
    //   68.10       17.35      50.75
    if (valued.length >= 2 && slots.every((s) => s.value === '') && borrowable) {
      const cells = columnCells(next!, slots.length);
      slots.forEach((s, k) => {
        if (s.hit.field === null || s.hit.field === 'uom') return;
        offer({
          field: s.hit.field,
          rank: s.hit.rank,
          label: s.hit.text.trim(),
          raw: cells ? cells[k]! : next!,
          labelUnit: s.labelUnit,
          problem: cells ? null : { code: 'columns-misaligned' },
        });
      });
      i += 1;
      continue;
    }

    for (const s of valued) {
      let raw = s.value;
      // A label alone at the end of its line takes the line below, if that
      // line is a bare value and not a heading.
      if (raw === '' && s.hit === hits[hits.length - 1] && borrowable) raw = tidy(next!);
      if (raw !== '') {
        offer({ field: s.hit.field as LabelField, rank: s.hit.rank, label: s.hit.text.trim(), raw, labelUnit: s.labelUnit, problem: null });
      }
    }
  }
  return { lines, candidates, uom, firstFieldLine };
}

/* --------------------------------------------------------- normalization */

function unclear(raw: string, note: ValueNote): ExtractedValue {
  return { raw, normalized: UNCLEAR, note };
}

const MARKED: ValueNote = { code: 'marked-unreadable' };

const STATE_CODES = new Set(
  'AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UA UK UP WB'.split(' '),
);

/** Every Indian registration in a string, compacted. */
function registrations(raw: string): string[] {
  const found = new Set<string>();
  for (const m of raw.toUpperCase().matchAll(/(?<![A-Z0-9])([A-Z]{2})[\s.-]*(\d{1,2})[\s.-]*([A-Z]{0,3})[\s.-]*(\d{1,4})(?![0-9])/g)) {
    const [, state, district, series, num] = m;
    if (STATE_CODES.has(state!)) found.add(`${state}${district!.padStart(2, '0')}${series}${num!.padStart(4, '0')}`);
  }
  return [...found];
}

/**
 * Indian registration: state code, district number, series letters, number.
 * "TN 22 EH 9857", "TN22EH9857" and "tn-22-eh-9857" all normalize the same.
 */
export function normalizeVehicle(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, MARKED);
  const found = registrations(raw);
  if (found.length === 0) return unclear(raw, { code: 'not-a-registration' });
  if (found.length > 1) return unclear(raw, { code: 'two-registrations', found });
  return { raw, normalized: found[0]! };
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "Mar", "March", "Sept" — at least three letters of one month's name. */
function monthOf(word: string): number | null {
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(w));
  return i >= 0 ? i + 1 : null;
}

/** Day-first, as every Indian form is written. Two-digit years are 20xx; any other length is unreadable. */
export function normalizeDate(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, MARKED);
  const text = raw.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1');
  let ymd: [number, number, number] | null = null;
  const iso = /(?<!\d)(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/.exec(text);
  const dmy = /(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?!\d)/.exec(text);
  const named = /(?<!\d)(\d{1,2})[\s.\-/,]*([a-z]{3,9})\.?[\s.\-/,]*(\d{4}|\d{2})(?!\d)/i.exec(text);
  const monthFirst = /\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}|\d{2})(?!\d)/i.exec(text);
  if (iso) ymd = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) ymd = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];
  else if (named && monthOf(named[2]!)) ymd = [Number(named[3]), monthOf(named[2]!)!, Number(named[1])];
  else if (monthFirst && monthOf(monthFirst[1]!)) ymd = [Number(monthFirst[3]), monthOf(monthFirst[1]!)!, Number(monthFirst[2])];
  if (!ymd) return unclear(raw, { code: 'not-a-date' });
  let [y, mo, d] = ymd;
  if (y < 100) y += 2000;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return unclear(raw, { code: 'no-such-date' });
  }
  return { raw, normalized: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** "50,750" and "1,50,750" are digit grouping; "50,75" is a decimal comma; "50..75" is nothing. */
function parseFigure(token: string): number | null {
  const t = token.replace(/[.,]$/, '');
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (/^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?$/.test(t) || /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
  if (/^\d+,\d{1,2}$/.test(t)) return Number(t.replace(',', '.'));
  return null;
}

const UNIT_AFTER = /^\s*\(?\s*(m\.?\s*t\.?s?|tonnes?|tons?|t|kgs?|kilograms?|cft|c\.?\s*f\.?\s*t|cu\.?\s*ft|cubic\s+f(?:ee|oo)?t|units?|brass)\.?(?![a-z])/i;

/** A truckload in tonnes. Outside this, a unit or a decimal point was misread. */
const PLAUSIBLE_LOAD_T = { min: 0.1, max: 150 };

const trim = (n: number) => String(Math.round(n * 1000) / 1000);

export interface AmountContext {
  /** A unit printed beside the label: "Net Wt (Kg)". */
  labelUnit?: WrittenUnit | null;
  /**
   * The unit this paper writes its gross, tare and net in, for a bare number
   * beside them. Never taken from a quantity's trade unit.
   */
  paperUnit?: WrittenUnit | null;
}

/**
 * A weight or a volume. Tonnes are the unit weights are compared in: kg is
 * divided down, and "MT", "T", "tons" and "tonnes" are the same thing. CFT
 * and trade units (100 CFT) are volumes, kept as volumes — turning a volume
 * into a weight needs a density, which is a judgement for the reviewer.
 */
export function normalizeAmount(raw: string, context: AmountContext = {}): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, MARKED);
  // A bracketed unit counts; any other bracketed aside does not.
  let bracketUnit = null as WrittenUnit | null;
  const text = raw.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    bracketUnit ??= unitOf(inner);
    return ' ';
  });
  if (/%/.test(text)) return unclear(raw, { code: 'percentage' });
  const tokens = text.match(/\d[\d,.]*/g) ?? [];
  if (tokens.length === 0) return unclear(raw, { code: 'no-number' });
  if (tokens.length > 1) return unclear(raw, { code: 'many-numbers' });
  const token = tokens[0]!;
  const figure = parseFigure(token);
  if (figure === null) return unclear(raw, { code: 'bad-number', token });
  const after = text.slice(text.indexOf(token) + token.length);
  const unitMatch = UNIT_AFTER.exec(after);
  if (!unitMatch && /^\s*[a-z]/i.test(after)) {
    return unclear(raw, { code: 'not-a-unit', word: after.trim().split(/\s+/)[0]! });
  }

  let unit: WrittenUnit | null = (unitMatch ? unitOf(unitMatch[1]!) : null) ?? bracketUnit ?? context.labelUnit ?? null;
  let note: ValueNote | undefined;
  if (!unit && context.paperUnit) {
    unit = context.paperUnit;
    note = { code: 'unit-from-paper', unit };
  }
  if (!unit) {
    // A bare figure of 1000 or more is not a truckload in tonnes, so it is kg.
    if (figure >= 1000) {
      unit = 'kg';
      note = { code: 'read-as-kg', figure };
    } else {
      unit = 'MT';
      note = { code: 'read-as-tonnes' };
    }
  }

  if (unit === 'CFT' || unit === 'UNIT') {
    return { raw, normalized: `${trim(figure)} ${unit}`, amount: Math.round(figure * 1000) / 1000, unit, ...(note ? { note } : {}) };
  }
  const tonnes = unit === 'kg' ? figure / 1000 : figure;
  if (tonnes < PLAUSIBLE_LOAD_T.min || tonnes > PLAUSIBLE_LOAD_T.max) {
    return unclear(raw, { code: 'not-a-load', tonnes: Math.round(tonnes * 1000) / 1000 });
  }
  if (unit === 'kg' && !note) note = { code: 'written-in-kg' };
  const amount = Math.round(tonnes * 1000) / 1000;
  return { raw, normalized: `${trim(amount)} MT`, amount, unit: 'MT', ...(note ? { note } : {}) };
}

/**
 * Material, reduced to what it is rather than what this yard calls it.
 *
 * The size in mm is the part everyone agrees on; the name is where they
 * differ — "12 MM Jelly", "12mm blue metal" and "VSI 12 MM" are one product.
 * A size alone does not make aggregate: a 12 mm steel bar is not 12 mm jelly.
 *
 * The keys are codes: a normalized material starts with one, and the screen
 * words it ("AGGREGATE" is jelly to the yard). `materialParts` takes one apart.
 */
export type MaterialKind = 'M-SAND' | 'P-SAND' | 'RIVER SAND' | 'DUST' | 'GSB' | 'WMM' | 'BOULDER' | 'AGGREGATE';

const MATERIAL_CLASSES: { key: MaterialKind; pattern: RegExp }[] = [
  { key: 'M-SAND', pattern: /\bm[\s.-]?sand\b|manufactured\s+sand|\bvsi\s+sand\b/i },
  { key: 'P-SAND', pattern: /\bp[\s.-]?sand\b|plaster(?:ing)?\s+sand/i },
  { key: 'RIVER SAND', pattern: /\briver\s+sand\b/i },
  { key: 'DUST', pattern: /\b(?:crusher|quarry|stone)?\s*dust\b/i },
  { key: 'GSB', pattern: /\bgsb\b|granular\s+sub[\s-]?base/i },
  { key: 'WMM', pattern: /\bwmm\b|wet\s+mix/i },
  { key: 'BOULDER', pattern: /\bboulders?\b|\brubble\b/i },
  { key: 'AGGREGATE', pattern: /\bjell?[iy]\b|\bjall[iy]\b|blue\s+metal|\bmetal\b|\baggregates?\b|\bchips?\b|\bstone\b|\bbm\b/i },
];

const SIZE = /(\d+(?:\.\d+)?)\s*mm\b/i;

export function normalizeMaterial(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, MARKED);
  const sizeMatch = SIZE.exec(raw);
  const size = sizeMatch ? `${Number(sizeMatch[1])}MM` : null;
  let cls: MaterialKind | null = MATERIAL_CLASSES.find((c) => c.pattern.test(raw))?.key ?? null;
  // "VSI 12 MM" names the crusher it came off, then the size.
  if (!cls && size && /\bvsi\b/i.test(raw)) cls = 'AGGREGATE';
  if (cls) return { raw, normalized: [cls, size].filter(Boolean).join(' ') };
  const words = raw
    .replace(new RegExp(SIZE.source, 'gi'), ' ')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words && !size) return unclear(raw, { code: 'empty' });
  if (!words) return { raw, normalized: size!, note: { code: 'size-only' } };
  return { raw, normalized: [words, size].filter(Boolean).join(' '), note: { code: 'material-unknown' } };
}

/**
 * A normalized material in its parts: the kind the trade's names reduce to
 * (null when it was compared as written), the words before the size — the
 * kind's own key, or the paper's words — and the size, "12MM".
 */
export function materialParts(normalized: string): { kind: MaterialKind | null; name: string; size: string | null } {
  const [name, size] = splitMaterial(normalized);
  return { kind: MATERIAL_CLASSES.find((c) => c.key === name)?.key ?? null, name, size };
}

const PARTY_NOISE = /\b(?:m\/s|messrs|pvt|private|ltd|limited|llp|co|company|and|the|india|i)\b/gi;

export function normalizeParty(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, MARKED);
  const text = raw
    .replace(/\([^)]*\)/g, ' ')
    .replace(PARTY_NOISE, ' ')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? { raw, normalized: text } : unclear(raw, { code: 'empty' });
}

function normalizeText(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, MARKED);
  return { raw, normalized: raw.toUpperCase().replace(/\s+/g, ' ').trim() };
}

function normalizeDocNumber(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, MARKED);
  const token = /[A-Z0-9][A-Z0-9/-]*/i.exec(raw)?.[0];
  return token ? { raw, normalized: token.toUpperCase() } : unclear(raw, { code: 'no-number' });
}

/* ------------------------------------------------------------- extraction */

const WEIGHT_FIELDS = ['grossWeight', 'tareWeight', 'netWeight'] as const;
const AMOUNT_FIELDS: readonly LabelField[] = ['quantity', ...WEIGHT_FIELDS];

/** Words that make a line an address, a contact, a court clause or a title rather than a name. */
const NOT_A_NAME =
  /\b(?:road|rd|street|st|salai|nagar|colony|layout|post|dist|district|taluk|village|main|cross|near|opp|behind|via|jurisdiction|challan|memo|invoice|receipt|bill|slip|quotation|original|duplicate|triplicate)\b|\b\d{6}\b|@|\bwww\.|\.com\b/i;

/**
 * Who issued the paper: the name at the head of it, above the first field.
 * Taglines in brackets, addresses, phone and GST lines and the paper's own
 * title are passed over.
 */
function letterhead(paper: PaperText): string | null {
  const top = Math.min(paper.firstFieldLine, 6);
  for (let i = 0; i < top; i++) {
    const line = paper.lines[i]!;
    const bare = line.replace(/\([^)]*\)/g, ' ').trim();
    if (!/[a-z]{3}/i.test(bare)) continue;
    if ((bare.match(/\d/g) ?? []).length >= 5) continue;
    if (labelsOn(line).length > 0 || HEADING.test(bare) || NOT_A_NAME.test(bare)) continue;
    if (OTHER_PAPERS.some((o) => o.pattern.test(bare))) continue;
    return line;
  }
  return null;
}

/** The unit written with a figure: after the number, in brackets, or beside the label. */
function writtenUnit(c: Candidate | undefined): WrittenUnit | null {
  if (!c) return null;
  const after = /\d[\d,.]*(.*)$/.exec(c.raw)?.[1] ?? '';
  const unit = UNIT_AFTER.exec(after);
  const bracket = /\(([^)]*)\)/.exec(c.raw);
  return (unit ? unitOf(unit[1]!) : null) ?? (bracket ? unitOf(bracket[1]!) : null) ?? c.labelUnit;
}

const NO_WEIGHTS: NetWeightCheck = {
  status: 'NOT_APPLICABLE',
  calculated: null,
  stated: null,
  differenceKg: null,
  implausible: false,
  conflicts: [],
  finding: { code: 'no-weights' },
};

export function extractDeliveryDocument(id: string, text: string, options: { name?: string } = {}): ExtractedDocument {
  const name = options.name ?? id;
  if (text.trim() === '') {
    return {
      id,
      name,
      type: 'unknown',
      typeConfidence: 0,
      typeEvidence: [],
      typeNote: { code: 'no-text' },
      unread: true,
      fields: {},
      netCheck: NO_WEIGHTS,
    };
  }
  const kind = classifyDeliveryDocument(text);
  const paper = readPaper(text);
  const found = paper.candidates;

  // The unit this paper weighs in: from its own gross, tare and net only —
  // never from a quantity counted in trade units — then its UOM box.
  const weighed = WEIGHT_FIELDS.map((f) => writtenUnit(found[f])).find((u) => u === 'kg' || u === 'MT');
  const paperUnit: WrittenUnit | null = weighed ?? (paper.uom === 'kg' || paper.uom === 'MT' ? paper.uom : null);

  const fields: Partial<Record<DeliveryFieldKey, ExtractedValue>> = {};
  for (const [key, c] of Object.entries(found) as [LabelField, Candidate][]) {
    let value: ExtractedValue;
    if (c.problem) value = unclear(c.raw, c.problem);
    else if (key === 'vehicle') value = normalizeVehicle(c.raw);
    else if (key === 'date') value = normalizeDate(c.raw);
    else if (key === 'material') value = normalizeMaterial(c.raw);
    else if (key === 'party') value = normalizeParty(c.raw);
    else if (key === 'documentNumber') value = normalizeDocNumber(c.raw);
    else if (AMOUNT_FIELDS.includes(key)) {
      value = normalizeAmount(c.raw, { labelUnit: c.labelUnit, paperUnit: key === 'quantity' ? (paper.uom ?? paperUnit) : paperUnit });
    } else value = normalizeText(c.raw);
    fields[key] = { ...value, label: c.label };
  }
  const issuer = letterhead(paper);
  if (issuer) fields.issuer = normalizeParty(issuer);

  return {
    id,
    name,
    type: kind.type,
    typeConfidence: kind.confidence,
    typeEvidence: kind.evidence,
    typeNote: kind.note,
    unread: false,
    fields,
    netCheck: netCheck(fields),
  };
}

/** A readable weight, in whole kilograms. */
function kgOf(v: ExtractedValue | undefined): number | null {
  if (!v || v.normalized === UNCLEAR || v.amount === undefined || v.unit !== 'MT') return null;
  return Math.round(v.amount * 1000);
}

/** Whether a weight is on the paper: readable, written but unreadable, or not written at all. */
function presence(v: ExtractedValue | undefined, kg: number | null): WeightPresence {
  return kg !== null ? 'read' : v ? 'unreadable' : 'absent';
}

function netCheck(fields: Partial<Record<DeliveryFieldKey, ExtractedValue>>): NetWeightCheck {
  const { grossWeight: g, tareWeight: t, netWeight: n } = fields;
  const stated = kgOf(n);
  if (!g && !t) {
    return n ? { ...NO_WEIGHTS, stated: stated === null ? null : stated / 1000, finding: { code: 'net-only' } } : NO_WEIGHTS;
  }
  const gross = kgOf(g);
  const tare = kgOf(t);
  // Weights that cannot all be true are reported whatever else is found.
  const conflicts: WeightConflict[] = [];
  if (gross !== null && tare !== null && tare >= gross) conflicts.push({ code: 'tare-not-below-gross', tareKg: tare, grossKg: gross });
  if (gross !== null && stated !== null && stated > gross) conflicts.push({ code: 'net-above-gross', netKg: stated, grossKg: gross });
  const implausible = conflicts.length > 0;

  if (gross === null || tare === null) {
    return {
      status: 'NOT_POSSIBLE',
      calculated: null,
      stated: stated === null ? null : stated / 1000,
      differenceKg: null,
      implausible,
      conflicts,
      finding: { code: 'no-gross-or-tare', gross: presence(g, gross), tare: presence(t, tare) },
    };
  }
  const calculated = gross - tare;
  if (stated === null) {
    return {
      status: 'NOT_POSSIBLE',
      calculated: calculated / 1000,
      stated: null,
      differenceKg: null,
      implausible,
      conflicts,
      finding: { code: 'no-net', calculatedKg: calculated, net: n ? 'unreadable' : 'absent' },
    };
  }
  const difference = stated - calculated;
  return difference === 0
    ? {
        status: 'OK',
        calculated: calculated / 1000,
        stated: stated / 1000,
        differenceKg: 0,
        implausible,
        conflicts,
        finding: { code: 'adds-up', grossKg: gross, tareKg: tare, netKg: stated },
      }
    : {
        status: 'MISMATCH',
        calculated: calculated / 1000,
        stated: stated / 1000,
        differenceKg: difference,
        implausible,
        conflicts,
        finding: { code: 'does-not-add-up', grossKg: gross, tareKg: tare, calculatedKg: calculated, statedKg: stated, differenceKg: difference },
      };
}

/* ------------------------------------------------------------ comparison */

/**
 * A disagreement on these means the papers may not describe the same load,
 * or describe different amounts of it. Supplier/Party routinely differs for
 * honest reasons — three parties in one chain — so on its own it makes the
 * result partial, not a mismatch.
 */
const CORE_FIELDS: readonly ComparedField[] = ['vehicle', 'date', 'material', 'quantity', 'netWeight'];

/** A weight, or an unreadable figure that is not written as a volume. */
function weighs(v: ExtractedValue): boolean {
  return v.unit === 'MT' || (v.normalized === UNCLEAR && !/\b(?:cft|cu\.?\s*ft|units?|brass|loads?|nos)\b/i.test(v.raw));
}

/**
 * The value a paper gives for a compared row. A memo writes the weight it
 * received as "Quantity Recd"; a DC writes its quantity as "Net Qty". Each
 * row takes the paper's own figure under its other name when the paper has
 * no figure under this one — never another paper's.
 */
function comparedValue(d: ExtractedDocument, field: ComparedField): ExtractedValue | null {
  const f = d.fields;
  if (field === 'netWeight') {
    if (f.netWeight) return f.netWeight;
    return f.quantity && weighs(f.quantity) ? { ...f.quantity, derivedFrom: 'quantity' } : null;
  }
  if (field === 'quantity') {
    if (f.quantity) return f.quantity;
    return f.netWeight ? { ...f.netWeight, derivedFrom: 'netWeight' } : null;
  }
  return f[field] ?? null;
}

interface Verdict {
  verdict: 'same' | 'within' | 'differ' | 'partial' | 'incomparable';
  /** Why a 'same' or 'within' pair agrees although the values are not the same. */
  note?: AgreementNote;
  /** On 'partial': the size one paper writes and the other leaves out. */
  size?: string;
}

const DAY_MS = 86_400_000;

function judge(field: ComparedField, a: ExtractedValue, b: ExtractedValue, toleranceKg: number, dateWindow: number): Verdict {
  if (field === 'quantity' || field === 'netWeight') {
    if (a.unit === 'MT' && b.unit === 'MT') {
      const apart = Math.abs(Math.round(a.amount! * 1000) - Math.round(b.amount! * 1000));
      if (apart === 0) return { verdict: 'same' };
      return apart <= toleranceKg ? { verdict: 'within', note: { code: 'kg-apart', kg: apart } } : { verdict: 'differ' };
    }
    const cft = (v: ExtractedValue) => (v.unit === 'CFT' ? v.amount! : v.unit === 'UNIT' ? unitsToCft(v.amount!) : null);
    const [ca, cb] = [cft(a), cft(b)];
    if (ca !== null && cb !== null) {
      if (Math.abs(ca - cb) >= 0.5) return { verdict: 'differ' };
      // Trade units and CFT that come to the same, at 100 CFT a unit, are the same.
      return a.unit === b.unit ? { verdict: 'same' } : { verdict: 'same', note: { code: 'same-volume', cft: Number(trim(ca)) } };
    }
    return { verdict: 'incomparable' };
  }
  if (field === 'date') {
    const days = Math.round(Math.abs(Date.parse(a.normalized) - Date.parse(b.normalized)) / DAY_MS);
    if (days === 0) return { verdict: 'same' };
    return days <= dateWindow ? { verdict: 'within', note: { code: 'days-apart', days } } : { verdict: 'differ' };
  }
  if (field === 'material') {
    const [an, as] = splitMaterial(a.normalized);
    const [bn, bs] = splitMaterial(b.normalized);
    if ((as && bs && as !== bs) || (an && bn && an !== bn)) return { verdict: 'differ' };
    // One size is null here: two different sizes were a difference above.
    if (as !== bs) return { verdict: 'partial', size: (as ?? bs)! };
    return an !== bn ? { verdict: 'same', note: { code: 'size-only', size: as ?? '' } } : { verdict: 'same' };
  }
  return a.normalized === b.normalized ? { verdict: 'same' } : { verdict: 'differ' };
}

function splitMaterial(normalized: string): [string, string | null] {
  const m = /^(.*?)\s*(\d+(?:\.\d+)?MM)?$/.exec(normalized);
  return [m?.[1]?.trim() ?? normalized, m?.[2] ?? null];
}

interface Reading {
  doc: ExtractedDocument;
  value: ExtractedValue;
}

const ids = (docs: readonly ExtractedDocument[]) => docs.map((d) => d.id);
const paperValues = (rs: readonly Reading[]): PaperValue[] => rs.map((r) => ({ docId: r.doc.id, value: r.value }));

function compareField(field: Exclude<ComparedField, 'party'>, documents: ExtractedDocument[], toleranceKg: number, dateWindow: number): FieldComparison {
  const values = documents.map((d) => ({ docId: d.id, docType: d.type, value: d.unread ? null : comparedValue(d, field) }));
  const rows = documents.map((d, i) => ({ doc: d, value: values[i]!.value })).filter((r) => !r.doc.unread);
  const present = rows.filter((r): r is Reading => r.value !== null);
  const readable = present.filter((r) => r.value.normalized !== UNCLEAR);
  const unreadable = present.filter((r) => r.value.normalized === UNCLEAR);
  const missing = rows.filter((r) => r.value === null).map((r) => r.doc);
  const missingOn = ids(missing);

  const verdicts: (Verdict & { a: Reading; b: Reading })[] = [];
  for (let i = 0; i < readable.length; i++) {
    for (let j = i + 1; j < readable.length; j++) {
      verdicts.push({ ...judge(field, readable[i]!.value, readable[j]!.value, toleranceKg, dateWindow), a: readable[i]!, b: readable[j]! });
    }
  }
  const result = (status: FieldStatus, finding: FieldFinding | null, disagreements = 0): FieldComparison => ({
    field,
    values,
    status,
    missingOn,
    finding,
    disagreements,
  });

  if (verdicts.some((v) => v.verdict === 'differ')) {
    const agreeing = (r: Reading) => verdicts.filter((v) => (v.a === r || v.b === r) && v.verdict !== 'differ').length + 1;
    return result('MISMATCH', { code: 'differs', values: paperValues(readable) }, readable.length - Math.max(...readable.map(agreeing)));
  }
  if (verdicts.some((v) => v.verdict === 'incomparable')) {
    // A weight and a volume: only an agreed density could turn one into the
    // other, and that is a judgement for the reviewer, not for this module.
    return result('UNCLEAR', { code: 'weight-and-volume', values: paperValues(readable) });
  }
  if (unreadable.length > 0) {
    return result('UNCLEAR', { code: 'unreadable', docIds: ids(unreadable.map((r) => r.doc)), note: unreadable[0]!.value.note ?? null });
  }
  if (readable.length < 2) {
    return result('MISSING', readable.length === 0 ? { code: 'on-no-paper' } : { code: 'on-one-paper', docId: readable[0]!.doc.id });
  }
  const partial = verdicts.find((v) => v.verdict === 'partial');
  if (partial) return result('MISSING', { code: 'size-on-one-paper', size: partial.size!, values: paperValues(readable) });
  if (missing.length > 0) {
    return result('MISSING', { code: 'not-on-every-paper', agreeing: ids(readable.map((r) => r.doc)), missing: missingOn });
  }
  const pairs = verdicts.flatMap((v): PairAgreement[] => (v.note ? [{ docIds: [v.a.doc.id, v.b.doc.id], note: v.note }] : []));
  if (pairs.length === 0) return result('MATCH', null);
  // Dates a day apart are within the window for a load that crosses
  // midnight; weights a few kg apart are within what two weighbridges differ by.
  const allowance: Allowance | null =
    field === 'date' ? { code: 'days', days: dateWindow } : verdicts.some((v) => v.verdict === 'within') ? { code: 'kg', kg: toleranceKg } : null;
  return result('MATCH', { code: 'close-enough', pairs, allowance });
}

/** Words every trading name uses; two names sharing only these are not one party. */
const NAME_NOISE = new Set(
  (
    'SRI SREE SHRI SHREE NEW THE M S MS MESSRS AND CO COMPANY PVT PRIVATE LTD LIMITED LLP INDIA INDIAN ENTERPRISES ENTERPRISE ' +
    'TRADERS TRADING AGENCIES AGENCY BUILDERS BUILDER CONSTRUCTIONS CONSTRUCTION INFRA INFRASTRUCTURE PROJECTS PROJECT BLUE METAL ' +
    'METALS CRUSHER CRUSHERS QUARRY QUARRIES SAND SUPPLIERS SUPPLIER TRANSPORT TRANSPORTS LOGISTICS GROUP SONS BROTHERS BROS SITE ' +
    'INDUSTRIES MINES MINERALS'
  ).split(' '),
);

/**
 * The distinctive words of a trading name — before any comma or dash, which
 * is where a branch or a town starts: "GMS - Muthukadu" is GMS at its
 * Muthukadu site, and "GMS ELEGANT BUILDERS (I) PVT LTD, ERODE" is GMS too.
 */
function nameTokens(raw: string): string[] {
  const head = raw.replace(/\([^)]*\)/g, ' ').split(/,|\s[-–—]|[-–—]\s/)[0] ?? raw;
  return head
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !NAME_NOISE.has(t));
}

/** Whether two names are one party; `on` holds the words they share, empty when the whole name matches. */
function sameParty(a: ExtractedValue, b: ExtractedValue): { on: string[] } | null {
  if (a.normalized === b.normalized) return { on: [] };
  const theirs = nameTokens(b.raw);
  const shared = nameTokens(a.raw).filter((t) => theirs.includes(t));
  return shared.length > 0 ? { on: shared } : null;
}

/**
 * Supplier/Party is a chain, not one value. Each paper names the party on
 * the other side of it — the DC its buyer, the transporter's paper its
 * customer, the memo its supplier — and that party should be the one whose
 * letterhead another paper in the load carries. Comparing the three
 * "Party:" boxes with each other would compare three different roles.
 */
function compareParties(documents: ExtractedDocument[]): FieldComparison {
  const values = documents.map((d) => ({ docId: d.id, docType: d.type, value: d.unread ? null : (d.fields.party ?? null) }));
  const read = documents.filter((d) => !d.unread);
  const missing = read.filter((d) => !d.fields.party);
  const missingOn = ids(missing);
  const unreadable = read.filter((d) => d.fields.party?.normalized === UNCLEAR);
  const links: PartyLink[] = [];
  const breaks: PartyBreak[] = [];

  for (const d of read) {
    const party = d.fields.party;
    if (!party || party.normalized === UNCLEAR) continue;
    const issuers = read.filter((o) => o !== d && o.fields.issuer && o.fields.issuer.normalized !== UNCLEAR);
    if (issuers.length === 0) continue;
    let match: { o: ExtractedDocument; on: string[] } | null = null;
    for (const o of issuers) {
      const same = sameParty(party, o.fields.issuer!);
      if (same) {
        match = { o, on: same.on };
        break;
      }
    }
    if (match) {
      links.push({ docId: d.id, party: party.raw, issuerDocId: match.o.id, sharedWords: match.on });
    } else {
      breaks.push({ docId: d.id, party: party.raw, issuers: issuers.map((o) => ({ docId: o.id, issuer: o.fields.issuer!.raw })) });
    }
  }
  const result = (status: FieldStatus, finding: FieldFinding): FieldComparison => ({
    field: 'party',
    values,
    status,
    missingOn,
    finding,
    disagreements: status === 'MISMATCH' ? breaks.length : 0,
  });

  if (breaks.length > 0) return result('MISMATCH', { code: 'party-not-issuer', breaks, links });
  if (unreadable.length > 0) return result('UNCLEAR', { code: 'party-unreadable', docIds: ids(unreadable), links });
  if (links.length === 0) return result('MISSING', { code: 'party-unlinked' });
  if (missing.length > 0) return result('MISSING', { code: 'party-missing', links, missing: missingOn });
  return result('MATCH', { code: 'party-linked', links });
}

/** Whether a quantity row only repeats the net-weight row — one figure per paper, the same in both. */
function mirrors(quantity: FieldComparison, net: FieldComparison): boolean {
  return quantity.values.every((q, i) => (q.value?.normalized ?? null) === (net.values[i]!.value?.normalized ?? null));
}

/**
 * How to call a paper: by its type; by its type and its name where more than
 * one paper reads as that type; by its name alone where the type is unknown
 * or the paper was not read.
 */
export type PaperName =
  | { code: 'type'; type: DeliveryPaperType }
  | { code: 'type-and-name'; type: DeliveryPaperType; name: string }
  | { code: 'name'; name: string };

export function paperName(doc: ExtractedDocument, documents: readonly ExtractedDocument[]): PaperName {
  if (doc.type === 'unknown') return { code: 'name', name: doc.name };
  const sameType = documents.filter((d) => !d.unread && d.type === doc.type).length;
  return sameType > 1 ? { code: 'type-and-name', type: doc.type, name: doc.name } : { code: 'type', type: doc.type };
}

export function crossCheckDeliveryDocuments(inputs: { id: string; text: string; name?: string }[], options: CrossCheckOptions = {}): CrossCheckResult {
  const toleranceKg = options.weightToleranceKg ?? DEFAULT_WEIGHT_TOLERANCE_KG;
  const dateWindow = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  const documents = inputs.map((d) => extractDeliveryDocument(d.id, d.text, d.name === undefined ? {} : { name: d.name }));
  const read = documents.filter((d) => !d.unread);
  const ofType = (t: DeliveryDocType) => read.filter((d) => d.type === t);

  const comparisons = COMPARED_FIELDS.map((field) =>
    field === 'party' ? compareParties(documents) : compareField(field, documents, toleranceKg, dateWindow),
  );
  const row = (f: ComparedField) => comparisons.find((c) => c.field === f)!;
  // Every comparison that is not a plain match carries a finding.
  const fieldIssue = (c: FieldComparison): CrossCheckIssue => ({ code: 'field', field: c.field, status: c.status, finding: c.finding! });
  const netIssue = (d: ExtractedDocument): CrossCheckIssue => ({
    code: 'net',
    docId: d.id,
    status: d.netCheck.status,
    finding: d.netCheck.finding,
    conflicts: d.netCheck.conflicts,
  });

  // Worst first: what says these may not be one load, then what could not be settled.
  const issues: CrossCheckIssue[] = [];
  let mismatchCount = 0;
  const coreMismatch = comparisons.filter((c) => c.status === 'MISMATCH' && CORE_FIELDS.includes(c.field));
  for (const c of coreMismatch) {
    // A short delivery shows in both the quantity and the net-weight rows; say it once.
    if (c.field === 'quantity' && row('netWeight').status === 'MISMATCH' && mirrors(c, row('netWeight'))) continue;
    issues.push(fieldIssue(c));
    mismatchCount += 1;
  }
  const arithmetic = read.filter((d) => d.netCheck.status === 'MISMATCH');
  for (const d of arithmetic) issues.push(netIssue(d));
  mismatchCount += arithmetic.length;
  if (row('party').status === 'MISMATCH') {
    issues.push(fieldIssue(row('party')));
    mismatchCount += 1;
  }
  for (const d of read.filter((x) => x.netCheck.implausible && x.netCheck.status !== 'MISMATCH')) issues.push(netIssue(d));
  for (const c of comparisons.filter((x) => x.status === 'UNCLEAR')) issues.push(fieldIssue(c));
  for (const c of comparisons.filter((x) => x.status === 'MISSING')) issues.push(fieldIssue(c));
  for (const d of read.filter((x) => x.netCheck.status === 'NOT_POSSIBLE' && !x.netCheck.implausible)) issues.push(netIssue(d));
  if (read.length > 0 && read.every((d) => d.netCheck.status === 'NOT_APPLICABLE')) issues.push({ code: 'no-weights-anywhere' });
  for (const d of documents.filter((x) => x.unread)) issues.push({ code: 'no-text', docId: d.id });
  for (const d of ofType('unknown')) issues.push({ code: 'unknown-paper', docId: d.id, note: d.typeNote });
  for (const t of DELIVERY_PAPER_TYPES) {
    const same = ofType(t);
    if (same.length > 1) issues.push({ code: 'same-type-twice', type: t, docIds: ids(same) });
  }
  const missingTypes = DELIVERY_PAPER_TYPES.filter((t) => ofType(t).length === 0);
  if (read.length > 0 && missingTypes.length > 0) issues.push({ code: 'papers-missing', types: missingTypes });
  if (documents.length < 2) issues.push({ code: 'too-few-papers' });

  const compared = comparisons.some((c) => CORE_FIELDS.includes(c.field) && c.status === 'MATCH');
  const overall: OverallResult =
    coreMismatch.length > 0 || arithmetic.length > 0 ? 'MISMATCHED' : issues.length === 0 && compared ? 'MATCHED' : 'PARTIALLY MATCHED';

  return { documents, comparisons, overall, mismatchCount, missingTypes, issues };
}
