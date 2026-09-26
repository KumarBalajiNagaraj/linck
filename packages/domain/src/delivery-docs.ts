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
 *
 * Pure functions, no DOM — the React Native app uses them unchanged.
 */

import { unitsToCft } from './uom.js';

/* ------------------------------------------------------------------ types */

export type DeliveryDocType = 'delivery_challan' | 'delivery_memo' | 'material_received' | 'unknown';
export type DeliveryPaperType = Exclude<DeliveryDocType, 'unknown'>;

/** The three papers of one load, in the order the issue's comparison table has them. */
export const DELIVERY_PAPER_TYPES: readonly DeliveryPaperType[] = ['delivery_challan', 'delivery_memo', 'material_received'];

export const DELIVERY_DOC_LABEL: Record<DeliveryDocType, string> = {
  delivery_challan: 'Delivery Challan/DC',
  delivery_memo: 'Delivery Memo',
  material_received: 'Material Received',
  unknown: 'Unrecognised paper',
};

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

/** Every extracted field, named as the issue lists them. */
export const DELIVERY_FIELD_LABEL: Record<DeliveryFieldKey, string> = {
  documentNumber: 'Document number',
  date: 'Date',
  issuer: 'Issued by (letterhead)',
  party: 'Supplier/Party',
  vehicle: 'Vehicle number',
  material: 'Material',
  quantity: 'Quantity',
  grossWeight: 'Gross weight',
  tareWeight: 'Empty/Tare weight',
  netWeight: 'Net weight',
  loadingLocation: 'Loading location',
  unloadingLocation: 'Unloading location',
};

export type ComparedField = 'vehicle' | 'date' | 'material' | 'quantity' | 'netWeight' | 'party';

/** The rows of the cross-check table, in the issue's order. */
export const COMPARED_FIELDS: readonly ComparedField[] = ['vehicle', 'date', 'material', 'quantity', 'netWeight', 'party'];

/** The rows' names, exactly as the issue's table has them. */
export const COMPARED_FIELD_LABEL: Record<ComparedField, string> = {
  vehicle: 'Vehicle No',
  date: 'Date',
  material: 'Material',
  quantity: 'Quantity',
  netWeight: 'Net Weight',
  party: 'Supplier/Party',
};

/** Marks a value that was on the paper but could not be read. */
export const UNCLEAR = 'UNCLEAR';

export type AmountUnit = 'MT' | 'CFT' | 'UNIT';

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
  /** Why a value is UNCLEAR, or what was assumed in reading it, in one line. */
  note?: string;
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
  /** The phrases that decided the type — shown so a human can disagree. */
  typeEvidence: string[];
  /** Why a paper was left unrecognised. */
  typeNote: string | null;
  /** No text was given: a photo still waiting to be read or typed in. */
  unread: boolean;
  fields: Partial<Record<DeliveryFieldKey, ExtractedValue>>;
  /** Net = gross − tare, worked out on this paper's own numbers. */
  netCheck: NetWeightCheck;
}

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
   * the gross, a tare heavier than the gross.
   */
  implausible: boolean;
  explanation: string;
}

export type FieldStatus = 'MATCH' | 'MISMATCH' | 'MISSING' | 'UNCLEAR';

export interface FieldComparison {
  field: ComparedField;
  /** One entry per paper, in the order the papers were given. */
  values: { docId: string; docType: DeliveryDocType; value: ExtractedValue | null }[];
  status: FieldStatus;
  /** Papers that were read and do not carry this field. */
  missingOn: string[];
  /** What was found, in a sentence. Null only for a plain match. */
  explanation: string | null;
  /** On a MISMATCH, how many papers are out of line with the largest group that agrees; else 0. */
  disagreements: number;
}

export type OverallResult = 'MATCHED' | 'PARTIALLY MATCHED' | 'MISMATCHED';

export interface CrossCheckResult {
  documents: ExtractedDocument[];
  comparisons: FieldComparison[];
  overall: OverallResult;
  /** Disagreements: mismatched fields and papers whose own arithmetic fails. */
  mismatchCount: number;
  /** Paper types a load has that were not among the papers given. */
  missingTypes: DeliveryPaperType[];
  /** One sentence per problem, worst first. Empty only when MATCHED. */
  explanations: string[];
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
const OTHER_PAPERS: { pattern: RegExp; label: string }[] = [
  { pattern: /\btax\s+invoice\b/i, label: 'tax invoice' },
  { pattern: /\bweigh(?:ment|ing)\s+(?:slip|ticket|receipt)\b|\bweigh\s*bridge\s+(?:slip|ticket|receipt)\b/i, label: 'weighbridge slip' },
  { pattern: /\bcash\s+(?:memo|bill|receipt)\b/i, label: 'cash memo' },
  { pattern: /\b(?:diesel|petrol|hsd)\b/i, label: 'fuel bill' },
  { pattern: /\bquotation\b|\bpro[\s-]?forma\b/i, label: 'quotation' },
];

export interface Classification {
  type: DeliveryDocType;
  /** 0 when unknown; 1 weak, 2 fair, 3 its own title and nothing competing. */
  confidence: 0 | 1 | 2 | 3;
  evidence: string[];
  /** Why the paper was left unrecognised. Null when it was recognised. */
  note: string | null;
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
  const unknown = (note: string, evidence = best.evidence): Classification => ({ type: 'unknown', confidence: 0, evidence, note });

  if (best.score === 0) return unknown('Nothing on it names a delivery challan, delivery memo or material-received paper.', []);
  const other = OTHER_PAPERS.find((o) => o.pattern.test(text));
  if (!best.titled && other) return unknown(`It reads as a ${other.label}, not a delivery paper.`);
  if (second.score === best.score) {
    return unknown(
      `It reads equally as a ${DELIVERY_DOC_LABEL[best.type]} and a ${DELIVERY_DOC_LABEL[second.type]}.`,
      [...best.evidence, ...second.evidence],
    );
  }
  // Without the title, it takes two independent signs that add up.
  if (!best.titled && (best.evidence.length < 2 || best.score < 4)) {
    return unknown(`Only "${best.evidence.join('", "')}" points to a ${DELIVERY_DOC_LABEL[best.type]} — not enough to say.`);
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

/** A unit as written, before kg is brought to tonnes. */
type WrittenUnit = 'kg' | 'MT' | 'CFT' | 'UNIT';

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
  problem: string | null;
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
          problem: cells ? null : 'The line under these headings could not be lined up with them',
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

function unclear(raw: string, note: string): ExtractedValue {
  return { raw, normalized: UNCLEAR, note };
}

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
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const found = registrations(raw);
  if (found.length === 0) return unclear(raw, 'Does not read as a registration number');
  if (found.length > 1) return unclear(raw, `Two registrations written: ${found.join(', ')}`);
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
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
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
  if (!ymd) return unclear(raw, 'Not a readable date');
  let [y, mo, d] = ymd;
  if (y < 100) y += 2000;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return unclear(raw, 'Not a real calendar date');
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
const UNIT_NAME: Record<WrittenUnit, string> = { kg: 'kg', MT: 'tonnes', CFT: 'CFT', UNIT: 'units' };

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
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  // A bracketed unit counts; any other bracketed aside does not.
  let bracketUnit = null as WrittenUnit | null;
  const text = raw.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    bracketUnit ??= unitOf(inner);
    return ' ';
  });
  if (/%/.test(text)) return unclear(raw, 'A percentage, not an amount');
  const tokens = text.match(/\d[\d,.]*/g) ?? [];
  if (tokens.length === 0) return unclear(raw, 'No number found');
  if (tokens.length > 1) return unclear(raw, 'More than one number where one amount belongs');
  const token = tokens[0]!;
  const figure = parseFigure(token);
  if (figure === null) return unclear(raw, `"${token}" is not a readable number`);
  const after = text.slice(text.indexOf(token) + token.length);
  const unitMatch = UNIT_AFTER.exec(after);
  if (!unitMatch && /^\s*[a-z]/i.test(after)) {
    return unclear(raw, `"${after.trim().split(/\s+/)[0]}" is not a unit of weight or volume`);
  }

  let unit: WrittenUnit | null = (unitMatch ? unitOf(unitMatch[1]!) : null) ?? bracketUnit ?? context.labelUnit ?? null;
  let note: string | undefined;
  if (!unit && context.paperUnit) {
    unit = context.paperUnit;
    note = `No unit written; read in ${UNIT_NAME[unit]}, as the paper's other weights are`;
  }
  if (!unit) {
    if (figure >= 1000) {
      unit = 'kg';
      note = `No unit written; read as kg — ${figure} tonnes is not a truckload`;
    } else {
      unit = 'MT';
      note = 'No unit written; read as tonnes';
    }
  }

  if (unit === 'CFT' || unit === 'UNIT') {
    return { raw, normalized: `${trim(figure)} ${unit}`, amount: Math.round(figure * 1000) / 1000, unit, ...(note ? { note } : {}) };
  }
  const tonnes = unit === 'kg' ? figure / 1000 : figure;
  if (tonnes < PLAUSIBLE_LOAD_T.min || tonnes > PLAUSIBLE_LOAD_T.max) {
    return unclear(raw, `${trim(tonnes)} t is not a plausible truckload — the unit or the decimal point may be misread`);
  }
  if (unit === 'kg' && !note) note = 'Written in kg';
  const amount = Math.round(tonnes * 1000) / 1000;
  return { raw, normalized: `${trim(amount)} MT`, amount, unit: 'MT', ...(note ? { note } : {}) };
}

/**
 * Material, reduced to what it is rather than what this yard calls it.
 *
 * The size in mm is the part everyone agrees on; the name is where they
 * differ — "12 MM Jelly", "12mm blue metal" and "VSI 12 MM" are one product.
 * A size alone does not make aggregate: a 12 mm steel bar is not 12 mm jelly.
 */
const MATERIAL_CLASSES: { key: string; pattern: RegExp }[] = [
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
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const sizeMatch = SIZE.exec(raw);
  const size = sizeMatch ? `${Number(sizeMatch[1])}MM` : null;
  let cls = MATERIAL_CLASSES.find((c) => c.pattern.test(raw))?.key ?? null;
  // "VSI 12 MM" names the crusher it came off, then the size.
  if (!cls && size && /\bvsi\b/i.test(raw)) cls = 'AGGREGATE';
  if (cls) return { raw, normalized: [cls, size].filter(Boolean).join(' ') };
  const words = raw
    .replace(new RegExp(SIZE.source, 'gi'), ' ')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words && !size) return unclear(raw, 'Empty');
  if (!words) return { raw, normalized: size!, note: 'Only a size is written' };
  return { raw, normalized: [words, size].filter(Boolean).join(' '), note: 'Material not recognised; compared as written' };
}

const PARTY_NOISE = /\b(?:m\/s|messrs|pvt|private|ltd|limited|llp|co|company|and|the|india|i)\b/gi;

export function normalizeParty(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const text = raw
    .replace(/\([^)]*\)/g, ' ')
    .replace(PARTY_NOISE, ' ')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? { raw, normalized: text } : unclear(raw, 'Empty');
}

function normalizeText(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  return { raw, normalized: raw.toUpperCase().replace(/\s+/g, ' ').trim() };
}

function normalizeDocNumber(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const token = /[A-Z0-9][A-Z0-9/-]*/i.exec(raw)?.[0];
  return token ? { raw, normalized: token.toUpperCase() } : unclear(raw, 'No number found');
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
  explanation: 'No weights on this paper.',
};

export function extractDeliveryDocument(id: string, text: string, options: { name?: string } = {}): ExtractedDocument {
  const name = options.name ?? id;
  if (text.trim() === '') {
    return { id, name, type: 'unknown', typeConfidence: 0, typeEvidence: [], typeNote: 'No text yet.', unread: true, fields: {}, netCheck: NO_WEIGHTS };
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

const tonnesText = (kg: number) => `${trim(kg / 1000)} MT`;

function netCheck(fields: Partial<Record<DeliveryFieldKey, ExtractedValue>>): NetWeightCheck {
  const { grossWeight: g, tareWeight: t, netWeight: n } = fields;
  const stated = kgOf(n);
  if (!g && !t) {
    return n
      ? {
          ...NO_WEIGHTS,
          stated: stated === null ? null : stated / 1000,
          explanation: 'Only the net weight is written; there is no gross or tare to check it against.',
        }
      : NO_WEIGHTS;
  }
  const gross = kgOf(g);
  const tare = kgOf(t);
  const impossible = [
    gross !== null && tare !== null && tare >= gross ? `the tare (${tonnesText(tare)}) is not less than the gross (${tonnesText(gross)})` : null,
    gross !== null && stated !== null && stated > gross ? `the net (${tonnesText(stated)}) is more than the gross (${tonnesText(gross)})` : null,
  ].filter((p): p is string => p !== null);
  const implausible = impossible.length > 0;
  const cannotBe = implausible ? ` Besides, ${impossible.join(' and ')}, which cannot both be right.` : '';

  if (gross === null || tare === null) {
    const why = (label: string, v: ExtractedValue | undefined) => (v ? `the ${label} cannot be read` : `no ${label} is written`);
    const missing = [gross === null ? why('gross', g) : null, tare === null ? why('tare', t) : null].filter(Boolean).join(' and ');
    return {
      status: 'NOT_POSSIBLE',
      calculated: null,
      stated: stated === null ? null : stated / 1000,
      differenceKg: null,
      implausible,
      explanation: `Net = gross − tare cannot be worked out: ${missing}.${cannotBe}`,
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
      explanation: `Gross − tare = ${tonnesText(calculated)}, but ${n ? 'the net weight written cannot be read' : 'no net weight is written'} to check it against.${cannotBe}`,
    };
  }
  const difference = stated - calculated;
  const sum = `Gross ${tonnesText(gross)} − tare ${tonnesText(tare)} = ${tonnesText(calculated)}`;
  return difference === 0
    ? { status: 'OK', calculated: calculated / 1000, stated: stated / 1000, differenceKg: 0, implausible, explanation: `${sum}, as written.${cannotBe}` }
    : {
        status: 'MISMATCH',
        calculated: calculated / 1000,
        stated: stated / 1000,
        differenceKg: difference,
        implausible,
        explanation: `${sum}, but the paper says ${tonnesText(stated)} — ${Math.abs(difference)} kg ${difference > 0 ? 'more' : 'less'}.${cannotBe}`,
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
  note?: string;
}

const DAY_MS = 86_400_000;

function judge(field: ComparedField, a: ExtractedValue, b: ExtractedValue, toleranceKg: number, dateWindow: number): Verdict {
  if (field === 'quantity' || field === 'netWeight') {
    if (a.unit === 'MT' && b.unit === 'MT') {
      const apart = Math.abs(Math.round(a.amount! * 1000) - Math.round(b.amount! * 1000));
      if (apart === 0) return { verdict: 'same' };
      return apart <= toleranceKg ? { verdict: 'within', note: `${apart} kg apart` } : { verdict: 'differ' };
    }
    const cft = (v: ExtractedValue) => (v.unit === 'CFT' ? v.amount! : v.unit === 'UNIT' ? unitsToCft(v.amount!) : null);
    const [ca, cb] = [cft(a), cft(b)];
    if (ca !== null && cb !== null) {
      if (Math.abs(ca - cb) >= 0.5) return { verdict: 'differ' };
      return a.unit === b.unit ? { verdict: 'same' } : { verdict: 'same', note: `${trim(ca)} CFT either way, at 100 CFT a unit` };
    }
    return { verdict: 'incomparable' };
  }
  if (field === 'date') {
    const days = Math.round(Math.abs(Date.parse(a.normalized) - Date.parse(b.normalized)) / DAY_MS);
    if (days === 0) return { verdict: 'same' };
    return days <= dateWindow ? { verdict: 'within', note: `${days === 1 ? 'a day' : `${days} days`} apart` } : { verdict: 'differ' };
  }
  if (field === 'material') {
    const [an, as] = splitMaterial(a.normalized);
    const [bn, bs] = splitMaterial(b.normalized);
    if ((as && bs && as !== bs) || (an && bn && an !== bn)) return { verdict: 'differ' };
    if (as !== bs) return { verdict: 'partial', note: `the size (${as ?? bs}) is written on one paper and not the other` };
    return an !== bn ? { verdict: 'same', note: `one paper gives only the size, ${as}` } : { verdict: 'same' };
  }
  return a.normalized === b.normalized ? { verdict: 'same' } : { verdict: 'differ' };
}

function splitMaterial(normalized: string): [string, string | null] {
  const m = /^(.*?)\s*(\d+(?:\.\d+)?MM)?$/.exec(normalized);
  return [m?.[1]?.trim() ?? normalized, m?.[2] ?? null];
}

function describe(v: ExtractedValue): string {
  const from = v.derivedFrom ? `, from "${v.label ?? DELIVERY_FIELD_LABEL[v.derivedFrom]}"` : '';
  return v.raw === v.normalized && !from ? `"${v.raw}"` : `"${v.raw}" (${v.normalized}${from})`;
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

type Named = (d: ExtractedDocument) => string;

interface Reading {
  doc: ExtractedDocument;
  value: ExtractedValue;
}

function compareField(
  field: Exclude<ComparedField, 'party'>,
  documents: ExtractedDocument[],
  nameOf: Named,
  toleranceKg: number,
  dateWindow: number,
): FieldComparison {
  const label = COMPARED_FIELD_LABEL[field];
  const values = documents.map((d) => ({ docId: d.id, docType: d.type, value: d.unread ? null : comparedValue(d, field) }));
  const rows = documents.map((d, i) => ({ doc: d, value: values[i]!.value })).filter((r) => !r.doc.unread);
  const present = rows.filter((r): r is Reading => r.value !== null);
  const readable = present.filter((r) => r.value.normalized !== UNCLEAR);
  const unreadable = present.filter((r) => r.value.normalized === UNCLEAR);
  const missing = rows.filter((r) => r.value === null).map((r) => r.doc);
  const missingOn = missing.map((d) => d.id);
  const says = (rs: Reading[]) => rs.map((r) => `${nameOf(r.doc)} says ${describe(r.value)}`).join('; ');

  const verdicts: (Verdict & { a: Reading; b: Reading })[] = [];
  for (let i = 0; i < readable.length; i++) {
    for (let j = i + 1; j < readable.length; j++) {
      verdicts.push({ ...judge(field, readable[i]!.value, readable[j]!.value, toleranceKg, dateWindow), a: readable[i]!, b: readable[j]! });
    }
  }
  const result = (status: FieldStatus, explanation: string | null, disagreements = 0): FieldComparison => ({
    field,
    values,
    status,
    missingOn,
    explanation,
    disagreements,
  });

  if (verdicts.some((v) => v.verdict === 'differ')) {
    const agreeing = (r: Reading) => verdicts.filter((v) => (v.a === r || v.b === r) && v.verdict !== 'differ').length + 1;
    return result('MISMATCH', `${label} differs: ${says(readable)}.`, readable.length - Math.max(...readable.map(agreeing)));
  }
  if (verdicts.some((v) => v.verdict === 'incomparable')) {
    return result(
      'UNCLEAR',
      `${label} cannot be compared: ${says(readable)} — a weight and a volume, which only an agreed density could turn into one another.`,
    );
  }
  if (unreadable.length > 0) {
    const why = unreadable[0]!.value.note;
    return result('UNCLEAR', `${label} cannot be read on ${list(unreadable.map((r) => nameOf(r.doc)))}${why ? ` (${why.charAt(0).toLowerCase()}${why.slice(1)})` : ''}.`);
  }
  if (readable.length < 2) {
    return result(
      'MISSING',
      readable.length === 0 ? `${label} is not on any paper.` : `${label} is only on ${nameOf(readable[0]!.doc)}, so there is nothing to check it against.`,
    );
  }
  const partial = verdicts.find((v) => v.verdict === 'partial');
  if (partial) return result('MISSING', `${label} agrees, but ${partial.note}: ${says(readable)}.`);
  if (missing.length > 0) {
    return result('MISSING', `${label} agrees on ${list(readable.map((r) => nameOf(r.doc)))}, but is not on ${list(missing.map(nameOf))}.`);
  }
  const notes = verdicts.filter((v) => v.note).map((v) => `${nameOf(v.a.doc)} and ${nameOf(v.b.doc)}: ${v.note}`);
  if (notes.length === 0) return result('MATCH', null);
  const allowance =
    field === 'date'
      ? ` — within the ${dateWindow}-day window for a load that crosses midnight`
      : verdicts.some((v) => v.verdict === 'within')
        ? ` — within the ${toleranceKg} kg two weighbridges may differ by`
        : '';
  return result('MATCH', `${label} agrees (${notes.join('; ')})${allowance}.`);
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
function compareParties(documents: ExtractedDocument[], nameOf: Named): FieldComparison {
  const label = COMPARED_FIELD_LABEL.party;
  const values = documents.map((d) => ({ docId: d.id, docType: d.type, value: d.unread ? null : (d.fields.party ?? null) }));
  const read = documents.filter((d) => !d.unread);
  const missing = read.filter((d) => !d.fields.party);
  const missingOn = missing.map((d) => d.id);
  const unreadable = read.filter((d) => d.fields.party?.normalized === UNCLEAR);
  const agreed: string[] = [];
  const failed: string[] = [];

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
      agreed.push(`${nameOf(d)} names "${party.raw}", who issued the ${nameOf(match.o)}${match.on.length ? ` (the names share ${match.on.join(', ')})` : ''}`);
    } else {
      failed.push(`${nameOf(d)} names "${party.raw}", but the other papers were issued by ${list(issuers.map((o) => `"${o.fields.issuer!.raw}" (${nameOf(o)})`))}`);
    }
  }
  const result = (status: FieldStatus, explanation: string): FieldComparison => ({
    field: 'party',
    values,
    status,
    missingOn,
    explanation,
    disagreements: status === 'MISMATCH' ? failed.length : 0,
  });
  const context = agreed.length > 0 ? ` Otherwise, ${agreed.join('; ')}.` : '';

  if (failed.length > 0) return result('MISMATCH', `${label}: ${failed.join('; ')}.${context}`);
  if (unreadable.length > 0) return result('UNCLEAR', `${label} cannot be read on ${list(unreadable.map(nameOf))}.${context}`);
  if (agreed.length === 0) return result('MISSING', `${label} could not be checked: no paper names a party whose letterhead is on another paper.`);
  if (missing.length > 0) return result('MISSING', `${label}: ${agreed.join('; ')}; but ${list(missing.map(nameOf))} names no party.`);
  return result('MATCH', `${label}: ${agreed.join('; ')}.`);
}

/** Whether a quantity row only repeats the net-weight row — one figure per paper, the same in both. */
function mirrors(quantity: FieldComparison, net: FieldComparison): boolean {
  return quantity.values.every((q, i) => (q.value?.normalized ?? null) === (net.values[i]!.value?.normalized ?? null));
}

export function crossCheckDeliveryDocuments(inputs: { id: string; text: string; name?: string }[], options: CrossCheckOptions = {}): CrossCheckResult {
  const toleranceKg = options.weightToleranceKg ?? DEFAULT_WEIGHT_TOLERANCE_KG;
  const dateWindow = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  const documents = inputs.map((d) => extractDeliveryDocument(d.id, d.text, d.name === undefined ? {} : { name: d.name }));
  const read = documents.filter((d) => !d.unread);
  const ofType = (t: DeliveryDocType) => read.filter((d) => d.type === t);
  // A paper is called by its type; by its name as well where the type does not pick it out.
  const nameOf: Named = (d) =>
    d.type === 'unknown' ? `"${d.name}"` : ofType(d.type).length > 1 ? `${DELIVERY_DOC_LABEL[d.type]} "${d.name}"` : DELIVERY_DOC_LABEL[d.type];

  const comparisons = COMPARED_FIELDS.map((field) =>
    field === 'party' ? compareParties(documents, nameOf) : compareField(field, documents, nameOf, toleranceKg, dateWindow),
  );
  const row = (f: ComparedField) => comparisons.find((c) => c.field === f)!;

  const explanations: string[] = [];
  let mismatchCount = 0;
  const coreMismatch = comparisons.filter((c) => c.status === 'MISMATCH' && CORE_FIELDS.includes(c.field));
  for (const c of coreMismatch) {
    // A short delivery shows in both the quantity and the net-weight rows; say it once.
    if (c.field === 'quantity' && row('netWeight').status === 'MISMATCH' && mirrors(c, row('netWeight'))) continue;
    explanations.push(c.explanation!);
    mismatchCount += 1;
  }
  const arithmetic = read.filter((d) => d.netCheck.status === 'MISMATCH');
  for (const d of arithmetic) explanations.push(`${nameOf(d)}: ${d.netCheck.explanation}`);
  mismatchCount += arithmetic.length;
  if (row('party').status === 'MISMATCH') {
    explanations.push(row('party').explanation!);
    mismatchCount += 1;
  }
  for (const d of read.filter((x) => x.netCheck.implausible && x.netCheck.status !== 'MISMATCH')) explanations.push(`${nameOf(d)}: ${d.netCheck.explanation}`);
  for (const c of comparisons.filter((x) => x.status === 'UNCLEAR')) explanations.push(c.explanation!);
  for (const c of comparisons.filter((x) => x.status === 'MISSING')) explanations.push(c.explanation!);
  for (const d of read.filter((x) => x.netCheck.status === 'NOT_POSSIBLE' && !x.netCheck.implausible)) explanations.push(`${nameOf(d)}: ${d.netCheck.explanation}`);
  if (read.length > 0 && read.every((d) => d.netCheck.status === 'NOT_APPLICABLE')) {
    explanations.push('Net = gross − tare was not checked: no paper shows a gross and a tare weight.');
  }
  for (const d of documents.filter((x) => x.unread)) explanations.push(`"${d.name}" has no text yet, so nothing on it was read or checked.`);
  for (const d of ofType('unknown')) explanations.push(`"${d.name}": could not tell which paper this is. ${d.typeNote ?? ''}`.trim());
  for (const t of DELIVERY_PAPER_TYPES) {
    const same = ofType(t);
    if (same.length > 1) explanations.push(`${same.length} papers read as ${DELIVERY_DOC_LABEL[t]} (${list(same.map((d) => `"${d.name}"`))}) — a load has one.`);
  }
  const missingTypes = DELIVERY_PAPER_TYPES.filter((t) => ofType(t).length === 0);
  if (read.length > 0 && missingTypes.length > 0) {
    explanations.push(`No ${list(missingTypes.map((t) => DELIVERY_DOC_LABEL[t]))} paper among these, so that part of the load went unchecked.`);
  }
  if (documents.length < 2) explanations.push('At least two papers are needed to cross-check a load.');

  const compared = comparisons.some((c) => CORE_FIELDS.includes(c.field) && c.status === 'MATCH');
  const overall: OverallResult =
    coreMismatch.length > 0 || arithmetic.length > 0 ? 'MISMATCHED' : explanations.length === 0 && compared ? 'MATCHED' : 'PARTIALLY MATCHED';

  return { documents, comparisons, overall, mismatchCount, missingTypes, explanations };
}
