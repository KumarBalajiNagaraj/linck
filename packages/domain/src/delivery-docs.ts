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
 * out which document it is, pulls the fields out, and compares them.
 *
 * Nothing here knows any company, vehicle, material or layout. It knows:
 *   - the WORDS these documents use for each field ("Lorry No", "Truck #",
 *     "Vehicle No" are all the vehicle),
 *   - the SHAPES of Indian values (registration numbers, dd.mm.yy dates,
 *     "50.75 MT"), and
 *   - the trade's own synonyms for materials ("jelly" and "blue metal" are
 *     both aggregate).
 *
 * Rules it keeps:
 *   - The raw value is always kept beside the normalized one used for
 *     comparison.
 *   - A value that cannot be read or normalized is UNCLEAR, never a guess.
 *   - A field that is not on the paper is MISSING. It is never filled in from
 *     another document.
 *
 * Pure functions, no DOM — the React Native app uses them unchanged.
 */

/* ------------------------------------------------------------------ types */

export type DeliveryDocType = 'delivery_challan' | 'delivery_memo' | 'material_received' | 'unknown';

export const DELIVERY_DOC_LABEL: Record<DeliveryDocType, string> = {
  delivery_challan: 'Delivery Challan / DC',
  delivery_memo: 'Delivery Memo',
  material_received: 'Material Received',
  unknown: 'Unrecognised document',
};

export type DeliveryFieldKey =
  | 'documentNumber'
  | 'date'
  | 'party'
  | 'vehicle'
  | 'material'
  | 'quantity'
  | 'grossWeight'
  | 'tareWeight'
  | 'netWeight'
  | 'loadingLocation'
  | 'unloadingLocation';

export const DELIVERY_FIELD_LABEL: Record<DeliveryFieldKey, string> = {
  documentNumber: 'Document number',
  date: 'Date',
  party: 'Supplier / Party',
  vehicle: 'Vehicle number',
  material: 'Material',
  quantity: 'Quantity',
  grossWeight: 'Gross weight',
  tareWeight: 'Empty / Tare weight',
  netWeight: 'Net weight',
  loadingLocation: 'Loading location',
  unloadingLocation: 'Unloading location',
};

/** Marks a value that was on the paper but could not be read. */
export const UNCLEAR = 'UNCLEAR';

export interface ExtractedValue {
  /** Exactly as read off the paper. */
  raw: string;
  /**
   * The comparison form: ISO date, compact registration, tonnes as a number
   * string, a material key. `UNCLEAR` when the raw text could not be
   * normalized. Never invented.
   */
  normalized: string;
  /** For weights and quantities: the parsed number, in `unit`. */
  amount?: number;
  unit?: 'MT' | 'CFT' | 'UNIT';
  /** Why a value is UNCLEAR, or what an assumption was, in one line. */
  note?: string;
}

export interface ExtractedDocument {
  /** Caller's handle for the document, e.g. the file name. */
  id: string;
  type: DeliveryDocType;
  /** 0–1: how clearly the text said which document it is. */
  typeConfidence: number;
  /** The phrases that decided the type — shown so a human can disagree. */
  typeEvidence: string[];
  fields: Partial<Record<DeliveryFieldKey, ExtractedValue>>;
  /** Net = gross − tare, worked out on this document's own numbers. */
  netCheck: NetWeightCheck;
}

export interface NetWeightCheck {
  status: 'OK' | 'MISMATCH' | 'NOT_POSSIBLE';
  calculated: number | null;
  stated: number | null;
  explanation: string;
  /**
   * The numbers that ARE on the paper cannot all be true — a net heavier than
   * the gross. Not a calculation failure, but it goes in front of a human.
   */
  implausible: boolean;
}

export type FieldStatus = 'MATCH' | 'MISMATCH' | 'MISSING' | 'UNCLEAR';

export interface FieldComparison {
  field: DeliveryFieldKey;
  /** One entry per document, in the order the documents were given. */
  values: { docId: string; docType: DeliveryDocType; value: ExtractedValue | null }[];
  status: FieldStatus;
  /** Documents that do not carry this field at all. */
  missingOn: string[];
  explanation: string | null;
}

export type OverallResult = 'MATCHED' | 'PARTIALLY MATCHED' | 'MISMATCHED';

export interface CrossCheckResult {
  documents: ExtractedDocument[];
  comparisons: FieldComparison[];
  overall: OverallResult;
  /** One sentence per problem, worst first. Empty only when MATCHED. */
  explanations: string[];
}

/* -------------------------------------------------------- classification */

/**
 * Words that say which document this is, with weights. The full phrase
 * outweighs any single word: "Material Received Challan" contains the word
 * "challan", and still is not a DC.
 */
const TYPE_SIGNALS: Record<Exclude<DeliveryDocType, 'unknown'>, { pattern: RegExp; weight: number; label: string }[]> = {
  delivery_challan: [
    { pattern: /\bdelivery\s+challan\b/i, weight: 6, label: 'delivery challan' },
    { pattern: /\bdc\s*(?:no|number|\/\s*ref|#)/i, weight: 4, label: 'DC no' },
    { pattern: /\boutgoing\s+trip\b/i, weight: 2, label: 'outgoing trip' },
    { pattern: /\bgstin\b/i, weight: 1, label: 'GSTIN' },
    { pattern: /\bhsn\b/i, weight: 1, label: 'HSN' },
    { pattern: /\b(?:full|gross)\s+(?:qty|wt|weight)\b/i, weight: 1, label: 'gross/full weight' },
  ],
  delivery_memo: [
    { pattern: /\bdelivery\s+memo\b/i, weight: 6, label: 'delivery memo' },
    { pattern: /\bmemo\b/i, weight: 2, label: 'memo' },
    { pattern: /\bproject\s+site\b/i, weight: 2, label: 'project site' },
    { pattern: /\bquantity\s+rec(?:ei)?v?e?d\b|\bqty\s+rec(?:ei)?v?e?d\b|\bquantity\s+recd\b/i, weight: 2, label: 'quantity received' },
    { pattern: /\bp\.?\s*o\.?\s*no\b/i, weight: 1, label: 'P.O. no' },
    { pattern: /\bsite[\s-]*in[\s-]*charge\b/i, weight: 1, label: 'site-in-charge' },
  ],
  material_received: [
    { pattern: /\bmaterials?\s+rec(?:ei|ie)ved\b/i, weight: 6, label: 'material received' },
    { pattern: /\bgoods\s+rec(?:ei|ie)ved\b|\bgrn\b/i, weight: 5, label: 'goods received' },
    { pattern: /\breceived\s+challan\b/i, weight: 3, label: 'received challan' },
    { pattern: /\btransport(?:er|ers)?\b/i, weight: 1, label: 'transporter' },
    { pattern: /\bdriver\s+signature\b/i, weight: 1, label: 'driver signature' },
  ],
};

export function classifyDeliveryDocument(text: string): {
  type: DeliveryDocType;
  confidence: number;
  evidence: string[];
} {
  const scores = (Object.keys(TYPE_SIGNALS) as Exclude<DeliveryDocType, 'unknown'>[]).map((type) => {
    const hits = TYPE_SIGNALS[type].filter((s) => s.pattern.test(text));
    return { type, score: hits.reduce((s, h) => s + h.weight, 0), evidence: hits.map((h) => h.label) };
  });
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (!best || best.score === 0 || (second && second.score === best.score)) {
    return { type: 'unknown', confidence: 0, evidence: best?.evidence ?? [] };
  }
  const total = scores.reduce((s, x) => s + x.score, 0);
  return { type: best.type, confidence: Math.round((best.score / total) * 100) / 100, evidence: best.evidence };
}

/* -------------------------------------------------------------- labels */

/**
 * Field labels as they are actually printed. Order matters only for overlap:
 * the longest label that fits a span of text wins, so "Net Qty" is never read
 * as "Qty", and "Location of Unloading" is never read as "Loading".
 */
const FIELD_LABELS: Record<DeliveryFieldKey, string[]> = {
  documentNumber: [
    'dc/ref #', 'dc/ref no', 'dc / ref', 'dc/ref', 'dc no', 'challan no', 'memo no', 'bill no', 'receipt no', 'ref no',
    'document no', 'doc no', 'no',
  ],
  date: ['date', 'dated', 'dt'],
  party: [
    'supplier name', 'supplier', 'party name', 'party', 'consignor', 'consignee', 'customer name', 'customer', 'sold to',
    'billed to', 'bill to', 'vendor',
  ],
  vehicle: [
    'vehicle no', 'vehicle number', 'vehicle', 'veh no', 'lorry no', 'lorry number', 'lorry', 'truck no', 'truck #',
    'truck', 'tipper no', 'reg no', 'registration no',
  ],
  material: ['material', 'item name', 'item', 'description', 'product', 'goods'],
  quantity: ['quantity recd', 'quantity received', 'qty recd', 'qty received', 'quantity', 'qty'],
  grossWeight: ['gross weight', 'gross wt', 'gross qty', 'gross', 'load wt', 'loaded wt', 'load weight', 'full qty', 'full wt', 'full weight'],
  tareWeight: ['tare weight', 'tare wt', 'tare', 'empty wt', 'empty weight', 'empty qty', 'unladen wt'],
  netWeight: ['net weight', 'net wt', 'net qty', 'net'],
  loadingLocation: ['loading point', 'loading place', 'loading at', 'loading', 'from place', 'source', 'quarry'],
  unloadingLocation: [
    'location of unloading', 'unloading point', 'unloading place', 'unloading', 'delivery at', 'deliver to', 'place of delivery',
    'place', 'project site', 'destination', 'site',
  ],
};

/**
 * Printed words that look like a field label but are not one. They are
 * matched so they stop the value before them and never lend their text to a
 * real field: "Customer Signature" is not a customer called "Signature", and
 * "Sl. No." is a line-item serial, not the document number.
 */
const NOT_FIELDS = [
  'customer signature', 'driver signature', 'receiver signature', 'signature', 'sl no', 'si no', 's no', 'item code',
  'p.o. no', 'po no', 'site-in-charge', 'site in charge', 'store-in-charge', 'store in charge', 'distance from quarry',
  'in time', 'out time', 'payment mode', 'measured by', 'hsn/sac', 'hsn',
  // Titles: the heading names the document, it does not carry a value.
  'material received', 'materials received', 'goods received', 'received challan', 'delivery challan', 'delivery memo',
];

interface LabelHit {
  /** Null for a NOT_FIELDS phrase: it bounds values but carries none. */
  field: DeliveryFieldKey | null;
  start: number;
  end: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every label, longest first, each compiled once with word-ish boundaries. */
const LABEL_MATCHERS: { field: DeliveryFieldKey | null; label: string; re: RegExp }[] = [
  ...(Object.entries(FIELD_LABELS) as [DeliveryFieldKey | null, string[]][]),
  [null, NOT_FIELDS] as [DeliveryFieldKey | null, string[]],
]
  .flatMap(([field, labels]) =>
    labels.map((label) => ({
      field,
      label,
      // Spaces in a label match any run of spaces or dots ("Lorry. No",
      // "Veh.No"); the label must not sit inside a longer word.
      re: new RegExp(`(?<![a-z0-9])${escape(label).replace(/\\?\s+/g, '[\\s.]*')}\\.?(?![a-z])`, 'gi'),
    })),
  )
  .sort((a, b) => b.label.length - a.label.length);

/** Non-overlapping label hits on one line, left to right. */
function labelsOn(raw: string): LabelHit[] {
  // Bracketed asides are never labels — "(Building Material Suppliers)" under
  // a letterhead is not a material. Blanked, not removed, so every position
  // still points into the real line.
  const line = raw.replace(/\([^)]*\)/g, (m) => ' '.repeat(m.length));
  const taken: LabelHit[] = [];
  for (const m of LABEL_MATCHERS) {
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
      taken.push({ field: m.field, start, end });
    }
  }
  // The first label on a line is always a label. A later one must look like
  // a label — a separator straight after it, or a form gap before it — or it
  // is just a word inside the previous value: "Unloading: PARTY SITE" holds
  // neither a party nor a site.
  return taken
    .sort((a, b) => a.start - b.start)
    .filter(
      (hit, i) =>
        i === 0 || /^\s*[:#.]/.test(line.slice(hit.end)) || /(?:\s{2,}|\.{2,}|\t)$/.test(line.slice(0, hit.start)) || line.slice(hit.end).trim() === '' && /\d\s*$/.test(line.slice(0, hit.start)),
    );
}

/** Strips the separators a form puts between a label and its value. */
function clean(value: string): string {
  return value
    .replace(/^[\s:;.,#=\-–—_|]+/, '')
    .replace(/[\s:;,=\-–—_|]+$/, '')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The first readable value for each field. A value is what sits between its
 * label and the next label on the same line; a label alone at the end of its
 * line takes the next line, if that line carries no label of its own.
 */
function rawFields(text: string): Partial<Record<DeliveryFieldKey, string>> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: Partial<Record<DeliveryFieldKey, string>> = {};
  /** Length of the label each value came from: a more specific label wins. */
  const strength: Partial<Record<DeliveryFieldKey, number>> = {};
  lines.forEach((line, i) => {
    const hits = labelsOn(line);
    hits.forEach((hit, h) => {
      // "Location of Unloading: RMC Plant" beats "Project Site: MCC" for the
      // unloading point, wherever each sits on the page.
      if (hit.field === null || (strength[hit.field] ?? -1) >= hit.end - hit.start) return;
      const next = hits[h + 1];
      let value = clean(line.slice(hit.end, next ? next.start : undefined));
      if (!value && !next) {
        const following = lines[i + 1];
        if (following && labelsOn(following).length === 0) value = clean(following);
      }
      if (value) {
        out[hit.field] = value;
        strength[hit.field] = hit.end - hit.start;
      }
    });
  });
  return out;
}

/* --------------------------------------------------------- normalization */

/** OCR engines mark what they could not read; so do people transcribing. */
const UNREADABLE = /\?|�|\[(?:unclear|illegible|\?)\]|\billegible\b|\bunclear\b/i;

function unclear(raw: string, note: string): ExtractedValue {
  return { raw, normalized: UNCLEAR, note };
}

/**
 * Indian registration: state code, district number, series letters, number.
 * "TN 22 EH 9857", "TN22EH9857", "tn-22-eh-9857" all normalize the same.
 */
const REG_PATTERN = /\b([A-Z]{2})[\s.-]*(\d{1,2})[\s.-]*([A-Z]{0,3})[\s.-]*(\d{1,4})\b/;

export function normalizeVehicle(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const m = REG_PATTERN.exec(raw.toUpperCase());
  if (!m) return unclear(raw, 'Does not read as a registration number');
  const [, state, district, series, num] = m;
  return { raw, normalized: `${state}${district!.padStart(2, '0')}${series}${num!.padStart(4, '0')}` };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Day-first, as every Indian form is written. Two-digit years are 20xx. */
export function normalizeDate(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  const dmy = /(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})/.exec(raw);
  const named = /(\d{1,2})[\s-]*([a-z]{3,4})[a-z]*[\s,-]*(\d{2,4})/i.exec(raw);
  let y: number | undefined;
  let mo: number | undefined;
  let d: number | undefined;
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, mo, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (named && MONTHS[named[2]!.toLowerCase()]) [d, mo, y] = [Number(named[1]), MONTHS[named[2]!.toLowerCase()], Number(named[3])];
  if (y === undefined || mo === undefined || d === undefined) return unclear(raw, 'Not a readable date');
  if (y < 100) y += 2000;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return unclear(raw, 'Not a real calendar date');
  }
  return { raw, normalized: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/**
 * A weight or quantity. Tonnes are the comparison unit: kg is divided down,
 * "MT", "T", "tons" and "tonnes" are the same thing. CFT and trade units are
 * kept as they are — converting them needs a density, which is a judgement
 * the reviewer must make, not this parser.
 *
 * A bare number gets the unit written elsewhere on the same document, or no
 * unit at all. Its note says which.
 */
export function normalizeAmount(raw: string, documentUnit: ExtractedValue['unit'] | null = null): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const m = /(-?\d+(?:,\d{2,3})*(?:[.,]\d+)?)\s*(m\.?\s*t\.?|tonnes?|tons?|t\b|kgs?|kilograms?|cft|cu\.?\s*ft|units?)?/i.exec(raw);
  if (!m) return unclear(raw, 'No number found');
  // "50,750" is Indian digit grouping; "50,75" is a decimal comma.
  const digits = m[1]!;
  let amount = Number(/\d,\d{2,3}(?:,|$)/.test(digits) && /,\d{3}$/.test(digits) ? digits.replace(/,/g, '') : digits.replace(',', '.'));
  const u = (m[2] ?? '').toLowerCase().replace(/[\s.]/g, '');
  let unit: ExtractedValue['unit'] | undefined;
  let note: string | undefined;
  if (u.startsWith('kg') || u.startsWith('kilogram')) {
    amount = amount / 1000;
    unit = 'MT';
  } else if (u === 'mt' || u === 't' || u.startsWith('ton')) unit = 'MT';
  else if (u === 'cft' || u === 'cuft') unit = 'CFT';
  else if (u.startsWith('unit')) unit = 'UNIT';
  else if (documentUnit) {
    unit = documentUnit;
    note = `No unit written; read in ${documentUnit} as used elsewhere on this document`;
  } else {
    note = 'No unit written on this document';
  }
  if (!Number.isFinite(amount)) return unclear(raw, 'Not a readable number');
  const rounded = Math.round(amount * 1000) / 1000;
  return {
    raw,
    normalized: unit ? `${rounded} ${unit}` : String(rounded),
    amount: rounded,
    ...(unit ? { unit } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Material, reduced to what it is rather than what this yard calls it.
 *
 * The size in mm is the part everyone agrees on; the name is where they
 * differ — "12 MM Jelly", "12mm blue metal" and "VSI 12 MM" are one product.
 */
const MATERIAL_CLASSES: { key: string; pattern: RegExp }[] = [
  { key: 'M-SAND', pattern: /\bm[\s.-]?sand\b|manufactured\s+sand|\bvsi\s+sand\b/i },
  { key: 'P-SAND', pattern: /\bp[\s.-]?sand\b|plaster(?:ing)?\s+sand/i },
  { key: 'RIVER SAND', pattern: /\briver\s+sand\b/i },
  { key: 'DUST', pattern: /\b(?:crusher|quarry|stone)?\s*dust\b/i },
  { key: 'GSB', pattern: /\bgsb\b|granular\s+sub[\s-]?base/i },
  { key: 'WMM', pattern: /\bwmm\b|wet\s+mix/i },
  { key: 'BOULDER', pattern: /\bboulders?\b|\brubble\b/i },
  { key: 'AGGREGATE', pattern: /\bjell?[iy]\b|\bjall[iy]\b|blue\s+metal|\bmetal\b|aggregate|\bchips?\b|\bstone\b|\bbm\b/i },
];

export function normalizeMaterial(raw: string): ExtractedValue {
  if (UNREADABLE.test(raw)) return unclear(raw, 'Marked unreadable');
  const size = /(\d+(?:\.\d+)?)\s*mm\b/i.exec(raw)?.[1];
  let cls = MATERIAL_CLASSES.find((c) => c.pattern.test(raw))?.key;
  // A size in mm with no sand, dust or base word is graded aggregate —
  // "VSI 12 MM" names the crusher it came off, then the size.
  if (!cls && size) cls = 'AGGREGATE';
  if (!cls && !size) {
    const text = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? { raw, normalized: text, note: 'Material not recognised; compared as written' } : unclear(raw, 'Empty');
  }
  return { raw, normalized: [cls, size ? `${Number(size)}MM` : null].filter(Boolean).join(' ') };
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

const WEIGHT_FIELDS: DeliveryFieldKey[] = ['quantity', 'grossWeight', 'tareWeight', 'netWeight'];

/** Weights may agree within this many tonnes — the width of a bridge's display step. */
export const DEFAULT_WEIGHT_TOLERANCE_T = 0.05;

export function extractDeliveryDocument(
  id: string,
  text: string,
  options: { weightToleranceT?: number } = {},
): ExtractedDocument {
  const tolerance = options.weightToleranceT ?? DEFAULT_WEIGHT_TOLERANCE_T;
  const { type, confidence, evidence } = classifyDeliveryDocument(text);
  const raw = rawFields(text);

  // The document's own weight unit, for bare numbers on it.
  const stated = WEIGHT_FIELDS.map((f) => (raw[f] ? normalizeAmount(raw[f]!).unit : undefined)).find(Boolean) ?? null;

  const fields: Partial<Record<DeliveryFieldKey, ExtractedValue>> = {};
  for (const [key, value] of Object.entries(raw) as [DeliveryFieldKey, string][]) {
    fields[key] =
      key === 'vehicle'
        ? normalizeVehicle(value)
        : key === 'date'
          ? normalizeDate(value)
          : key === 'material'
            ? normalizeMaterial(value)
            : key === 'party'
              ? normalizeParty(value)
              : key === 'documentNumber'
                ? normalizeDocNumber(value)
                : WEIGHT_FIELDS.includes(key)
                  ? normalizeAmount(value, stated)
                  : normalizeText(value);
  }

  return { id, type, typeConfidence: confidence, typeEvidence: evidence, fields, netCheck: netCheck(fields, tolerance) };
}

function tonnes(v: ExtractedValue | undefined): number | null {
  if (!v || v.normalized === UNCLEAR || v.amount === undefined) return null;
  return v.unit === 'MT' || v.unit === undefined ? v.amount : null;
}

function netCheck(fields: Partial<Record<DeliveryFieldKey, ExtractedValue>>, tolerance: number): NetWeightCheck {
  const gross = tonnes(fields.grossWeight);
  const tare = tonnes(fields.tareWeight);
  const stated = tonnes(fields.netWeight);
  if (gross === null || tare === null) {
    const missing = [gross === null ? 'gross' : null, tare === null ? 'tare' : null].filter(Boolean).join(' and ');
    const implausible = gross !== null && stated !== null && stated > gross + tolerance;
    return {
      status: 'NOT_POSSIBLE',
      calculated: null,
      stated,
      implausible,
      explanation: implausible
        ? `Cannot calculate net weight (${missing} weight missing or unclear), and the net written (${stated} MT) is more than the gross (${gross} MT), which cannot both be right.`
        : `Cannot calculate net weight: ${missing} weight is missing or unclear on this document.`,
    };
  }
  const calculated = Math.round((gross - tare) * 1000) / 1000;
  if (stated === null) {
    return {
      status: 'NOT_POSSIBLE',
      calculated,
      stated: null,
      implausible: false,
      explanation: `Gross − tare = ${calculated} MT, but no readable net weight is written to check it against.`,
    };
  }
  const ok = Math.abs(calculated - stated) <= tolerance;
  return {
    status: ok ? 'OK' : 'MISMATCH',
    calculated,
    stated,
    implausible: false,
    explanation: ok
      ? `Gross ${gross} − tare ${tare} = ${calculated} MT, as written.`
      : `Gross ${gross} − tare ${tare} = ${calculated} MT, but the document says ${stated} MT — ${Math.round(Math.abs(calculated - stated) * 1000) / 1000} MT apart.`,
  };
}

/* ------------------------------------------------------------ comparison */

/** The six fields the cross-check table compares, in the order it shows them. */
export const COMPARED_FIELDS: DeliveryFieldKey[] = ['vehicle', 'date', 'material', 'quantity', 'netWeight', 'party'];

/**
 * A disagreement on these fields means the papers may not describe the same
 * load, or describe different amounts of it. Date and party routinely differ
 * for honest reasons — a load crossing midnight, three parties in one chain —
 * so on their own they make a result partial, not a mismatch.
 */
const CORE_FIELDS: DeliveryFieldKey[] = ['vehicle', 'material', 'quantity', 'netWeight'];

function agree(field: DeliveryFieldKey, a: ExtractedValue, b: ExtractedValue, tolerance: number): boolean {
  if (WEIGHT_FIELDS.includes(field)) {
    if (a.amount === undefined || b.amount === undefined) return a.normalized === b.normalized;
    // A missing unit on one side is not a disagreement; two different stated
    // units are, because converting CFT to tonnes needs a density.
    if (a.unit && b.unit && a.unit !== b.unit) return false;
    return Math.abs(a.amount - b.amount) <= tolerance;
  }
  if (field === 'party') {
    return a.normalized === b.normalized || a.normalized.includes(b.normalized) || b.normalized.includes(a.normalized);
  }
  if (field === 'material') {
    const [ac, as] = splitMaterial(a.normalized);
    const [bc, bs] = splitMaterial(b.normalized);
    if (as && bs && as !== bs) return false;
    return ac === bc || (as !== null && as === bs && (ac === '' || bc === ''));
  }
  return a.normalized === b.normalized;
}

function splitMaterial(n: string): [string, string | null] {
  const m = /^(.*?)\s*(\d+(?:\.\d+)?MM)?$/.exec(n);
  return [m?.[1]?.trim() ?? n, m?.[2] ?? null];
}

function describe(v: ExtractedValue): string {
  return v.raw === v.normalized ? `"${v.raw}"` : `"${v.raw}" (${v.normalized})`;
}

export function crossCheckDeliveryDocuments(
  inputs: { id: string; text: string }[],
  options: { weightToleranceT?: number } = {},
): CrossCheckResult {
  const tolerance = options.weightToleranceT ?? DEFAULT_WEIGHT_TOLERANCE_T;
  const documents = inputs.map((d) => extractDeliveryDocument(d.id, d.text, { weightToleranceT: tolerance }));
  const name = (d: ExtractedDocument) => (d.type === 'unknown' ? d.id : DELIVERY_DOC_LABEL[d.type]);

  const comparisons: FieldComparison[] = COMPARED_FIELDS.map((field) => {
    const values = documents.map((d) => ({ docId: d.id, docType: d.type, value: d.fields[field] ?? null }));
    const present = values.filter((v) => v.value !== null) as { docId: string; docType: DeliveryDocType; value: ExtractedValue }[];
    const readable = present.filter((v) => v.value.normalized !== UNCLEAR);
    const missingOn = values.filter((v) => v.value === null).map((v) => v.docId);
    const label = DELIVERY_FIELD_LABEL[field];
    const docName = (id: string) => name(documents.find((d) => d.id === id)!);

    // Any pair that disagrees is a mismatch, whatever else is unclear.
    for (let i = 0; i < readable.length; i++) {
      for (let j = i + 1; j < readable.length; j++) {
        const a = readable[i]!;
        const b = readable[j]!;
        if (!agree(field, a.value, b.value, tolerance)) {
          const units = a.value.unit && b.value.unit && a.value.unit !== b.value.unit;
          return {
            field,
            values,
            status: 'MISMATCH' as const,
            missingOn,
            explanation: units
              ? `${label}: ${docName(a.docId)} states ${describe(a.value)} and ${docName(b.docId)} states ${describe(b.value)} — different units, which cannot be compared without an agreed density.`
              : `${label} differs: ${readable.map((v) => `${docName(v.docId)} says ${describe(v.value)}`).join('; ')}.`,
          };
        }
      }
    }
    if (present.length > readable.length) {
      const which = present.filter((v) => v.value.normalized === UNCLEAR).map((v) => docName(v.docId));
      return { field, values, status: 'UNCLEAR' as const, missingOn, explanation: `${label} cannot be read on ${which.join(', ')}.` };
    }
    if (readable.length < 2) {
      return {
        field,
        values,
        status: 'MISSING' as const,
        missingOn,
        explanation:
          readable.length === 0
            ? `${label} is not on any document.`
            : `${label} is only on ${docName(readable[0]!.docId)}; there is nothing to check it against.`,
      };
    }
    return {
      field,
      values,
      status: 'MATCH' as const,
      missingOn,
      explanation: missingOn.length > 0 ? `${label} agrees where written, but is missing on ${missingOn.map(docName).join(', ')}.` : null,
    };
  });

  const explanations: string[] = [];
  const coreMismatch = comparisons.filter((c) => c.status === 'MISMATCH' && CORE_FIELDS.includes(c.field));
  const otherMismatch = comparisons.filter((c) => c.status === 'MISMATCH' && !CORE_FIELDS.includes(c.field));
  const arithmetic = documents.filter((d) => d.netCheck.status === 'MISMATCH');
  // A field on no document at all cannot disagree with anything; it shows in
  // the table as MISSING, but only a field some paper does carry — and others
  // leave off or smudge — makes the result partial.
  const unreadable = comparisons.filter(
    (c) => c.status === 'UNCLEAR' || (c.status === 'MISSING' && c.missingOn.length < documents.length),
  );
  const gaps = comparisons.filter((c) => c.status === 'MATCH' && c.missingOn.length > 0);
  const unknownTypes = documents.filter((d) => d.type === 'unknown');

  for (const c of coreMismatch) explanations.push(c.explanation!);
  for (const d of arithmetic) explanations.push(`${name(d)}: ${d.netCheck.explanation}`);
  for (const c of otherMismatch) explanations.push(c.explanation!);
  for (const d of documents.filter((x) => x.netCheck.implausible)) explanations.push(`${name(d)}: ${d.netCheck.explanation}`);
  for (const c of unreadable) explanations.push(c.explanation!);
  for (const c of gaps) explanations.push(c.explanation!);
  for (const d of unknownTypes) explanations.push(`${d.id}: could not tell which document this is from its text.`);
  if (documents.length < 2) explanations.push('At least two documents are needed to cross-check a load.');

  const overall: OverallResult =
    coreMismatch.length > 0 || arithmetic.length > 0
      ? 'MISMATCHED'
      : explanations.length > 0
        ? 'PARTIALLY MATCHED'
        : 'MATCHED';

  return { documents, comparisons, overall, explanations };
}
