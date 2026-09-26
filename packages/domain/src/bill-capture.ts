/**
 * EXPENSE BILL CAPTURE.
 *
 * Turns the text read off an expense bill — a diesel bunk slip, a repair
 * invoice, a tyre bill — into PROPOSED ledger fields. Proposed, never posted:
 * each value carries how it was found and a confidence, and a human confirms
 * or corrects it. The correction is kept beside the original so capture
 * quality can be measured per vendor over time.
 *
 * Found by printed labels and by the shapes of Indian values (GSTIN, vehicle
 * registration, ₹ amounts, dd/mm/yy dates), never by position — bills from
 * any vendor, any layout. A value that is not on the bill stays null.
 *
 * Pure functions, no DOM.
 */

export type BillFieldKey = 'kind' | 'billNumber' | 'billDate' | 'vendor' | 'gstin' | 'vehicle' | 'litres' | 'rate' | 'amount';

export type BillKind = 'diesel' | 'repair' | 'tyre' | 'spares' | 'toll' | 'other';

export interface CapturedField {
  key: BillFieldKey;
  /** The value in the form the ledger stores: ISO date, compact reg, plain decimal. */
  value: string;
  /** The text it was read from, verbatim. */
  source: string;
  /** 3 = labelled and well-formed, 2 = found by shape alone, 1 = a guess worth checking. */
  confidence: 1 | 2 | 3;
  note?: string;
}

export interface BillCapture {
  fields: Partial<Record<BillFieldKey, CapturedField>>;
  /** Plain-sentence problems a reviewer should look at first. */
  warnings: string[];
}

/* ------------------------------------------------------------ primitives */

const GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/;
const REG = /\b([A-Z]{2})[\s.-]*(\d{1,2})[\s.-]*([A-Z]{1,3})[\s.-]*(\d{3,4})\b/;

export function parseRupees(text: string): number | null {
  const m = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseBillDate(text: string): string | null {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const dmy = /(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})/.exec(text);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /(\d{1,2})[\s-]*([a-z]{3})[a-z]*[\s,-]*(\d{2,4})/i.exec(text);
  let y: number;
  let mo: number;
  let d: number;
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, mo, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (named && months.includes(named[2]!.toLowerCase()))
    [d, mo, y] = [Number(named[1]), months.indexOf(named[2]!.toLowerCase()) + 1, Number(named[3])];
  else return null;
  if (y < 100) y += 2000;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseRegistration(text: string): string | null {
  const m = REG.exec(text.toUpperCase());
  return m ? `${m[1]}${m[2]!.padStart(2, '0')}${m[3]}${m[4]!.padStart(4, '0')}` : null;
}

/* ----------------------------------------------------------------- labels */

/**
 * Labels as printed, most specific first. "Grand Total" outranks "Total",
 * which outranks a bare "Amount" — the last number on a bill is not always
 * the one owed, but the most emphatic label usually is.
 */
const LABELS: { key: Exclude<BillFieldKey, 'kind' | 'vendor' | 'gstin'>; labels: string[] }[] = [
  { key: 'amount', labels: ['grand total', 'net amount', 'net amt', 'amount payable', 'total amount', 'bill amount', 'total', 'sale amt', 'amount', 'amt'] },
  { key: 'billNumber', labels: ['invoice no', 'invoice number', 'inv no', 'bill no', 'bill number', 'receipt no', 'txn no', 'transaction id', 'memo no', 'invoice #', 'bill #', 'receipt #'] },
  { key: 'billDate', labels: ['invoice date', 'bill date', 'date', 'dt'] },
  { key: 'vehicle', labels: ['vehicle no', 'vehicle number', 'veh no', 'vehicle', 'lorry no', 'truck no', 'reg no'] },
  { key: 'litres', labels: ['volume', 'quantity', 'qty', 'litres', 'liters', 'ltrs', 'ltr', 'vol'] },
  { key: 'rate', labels: ['rate/ltr', 'rate per litre', 'rate', 'price', 'unit price', 'rs/ltr'] },
];

/** Rank of each amount label: lower is more authoritative. */
const AMOUNT_RANK = new Map(LABELS[0]!.labels.map((l, i) => [l, i]));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelRe = (l: string) => new RegExp(`(?<![a-z])${escape(l).replace(/\s+/g, '[\\s.]*')}\\.?(?![a-z])\\s*[:#=-]?\\s*(.*)$`, 'i');

/* ------------------------------------------------------------------ kinds */

const KIND_SIGNALS: { kind: BillKind; pattern: RegExp }[] = [
  { kind: 'diesel', pattern: /\bdiesel\b|\bhsd\b|high\s+speed\s+diesel|\bfuel\b|\bbunk\b|\bpetroleum\b/i },
  { kind: 'toll', pattern: /\btoll\b|\bfastag\b|\bnhai\b|\bplaza\b/i },
  { kind: 'tyre', pattern: /\btyres?\b|\btires?\b|\bretread/i },
  { kind: 'repair', pattern: /\brepairs?\b|\blabou?r\b|\bservice\s+charge|\boverhaul|\bwelding\b|\bworkshop\b/i },
  { kind: 'spares', pattern: /\bspares?\b|\bfilter\b|\bhose\b|\bbearing\b|\bgasket\b|\bparts?\b/i },
];

/* ------------------------------------------------------------------ parse */

/**
 * @param text  what the OCR read, one printed line per line
 * @param lineConfidence  optional 0–100 per line from the OCR engine; a field
 *   read from a line the engine itself doubted can never score 3
 */
export function captureExpenseBill(text: string, lineConfidence: number[] = []): BillCapture {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l, i, all) => l !== '' || i < all.length);
  const fields: Partial<Record<BillFieldKey, CapturedField>> = {};
  const warnings: string[] = [];
  /** A label that is on the bill with a value that would not parse: said out loud, never guessed. */
  const unreadable = new Map<BillFieldKey, string>();
  const cap = (i: number, c: 1 | 2 | 3): 1 | 2 | 3 => {
    const ocr = lineConfidence[i];
    if (ocr === undefined) return c;
    return (ocr < 60 ? 1 : ocr < 80 ? Math.min(c, 2) : c) as 1 | 2 | 3;
  };

  let amountRank = Number.POSITIVE_INFINITY;
  lines.forEach((line, i) => {
    // Every label on the line, earliest first and longest first at the same
    // spot, each claiming its span — so "Rate/Ltr" is a rate, never litres
    // because "Ltr" also appears in it.
    const hits: { key: (typeof LABELS)[number]['key']; label: string; start: number; end: number; rest: string }[] = [];
    for (const { key, labels } of LABELS) {
      for (const label of labels) {
        const m = labelRe(label).exec(line);
        if (!m) continue;
        const restStart = line.length - (m[1] ?? '').length;
        hits.push({ key, label, start: m.index, end: restStart, rest: (m[1] ?? '').trim() });
      }
    }
    hits.sort((a, b) => a.start - b.start || b.label.length - a.label.length);
    const claimed: { start: number; end: number }[] = [];
    for (const hit of hits) {
      const labelEnd = hit.start + hit.label.length;
      if (claimed.some((c) => hit.start < c.end && labelEnd > c.start)) continue;
      claimed.push({ start: hit.start, end: labelEnd });
      const { key, label } = hit;
      const rest = hit.rest || (lines[i + 1] ?? '');
      if (key === 'amount') {
        // A subtotal is never what is owed; a later "Total" of the same
        // rank is the running one, so it replaces the earlier.
        if (/sub[\s-]*total/i.test(line)) continue;
        const n = parseRupees(rest);
        const rank = AMOUNT_RANK.get(label) ?? 99;
        if (n !== null && rank <= amountRank) {
          amountRank = rank;
          fields.amount = { key, value: n.toFixed(2), source: line, confidence: cap(i, rank <= 5 ? 3 : 2) };
        }
      } else if (!fields[key]) {
        const value =
          key === 'billDate'
            ? parseBillDate(rest)
            : key === 'vehicle'
              ? parseRegistration(rest)
              : key === 'litres' || key === 'rate'
                ? (() => {
                    const n = parseRupees(rest);
                    return n === null ? null : String(n);
                  })()
                : (/[A-Z0-9][A-Z0-9/-]*/i.exec(rest)?.[0] ?? null);
        if (value) fields[key] = { key, value, source: line, confidence: cap(i, 3) };
        else if (rest.trim() && !unreadable.has(key)) unreadable.set(key, rest.trim());
      }
    }
  });

  // By shape, where no label claimed them.
  const all = lines.join('\n');
  const gst = GSTIN.exec(all.toUpperCase());
  if (gst) {
    const i = lines.findIndex((l) => l.toUpperCase().includes(gst[1]!));
    fields.gstin = { key: 'gstin', value: gst[1]!, source: lines[i] ?? gst[1]!, confidence: cap(i, 3) };
  }
  if (!fields.vehicle) {
    const i = lines.findIndex((l) => parseRegistration(l) !== null && !GSTIN.test(l.toUpperCase()));
    if (i >= 0) {
      fields.vehicle = { key: 'vehicle', value: parseRegistration(lines[i]!)!, source: lines[i]!, confidence: cap(i, 2) };
    }
  }
  if (!fields.billDate) {
    const i = lines.findIndex((l) => parseBillDate(l) !== null);
    if (i >= 0) fields.billDate = { key: 'billDate', value: parseBillDate(lines[i]!)!, source: lines[i]!, confidence: cap(i, 2) };
  }

  // The vendor is the letterhead: the first line of words near the top that
  // is not a label, a number or a registration. A guess, and scored as one.
  const head = lines.slice(0, 4).findIndex(
    (l) => /[a-z]{3,}/i.test(l) && (l.match(/\d/g)?.length ?? 0) < 4 && !LABELS.some((g) => g.labels.some((lb) => labelRe(lb).test(l))) && !/tax\s+invoice|cash\s+bill|receipt|welcome/i.test(l),
  );
  if (head >= 0) fields.vendor = { key: 'vendor', value: lines[head]!.replace(/\s{2,}/g, ' '), source: lines[head]!, confidence: cap(head, 2) };

  const kind = KIND_SIGNALS.find((k) => k.pattern.test(all));
  fields.kind = kind
    ? { key: 'kind', value: kind.kind, source: kind.pattern.exec(all)![0], confidence: 2 }
    : { key: 'kind', value: 'other', source: '', confidence: 1, note: 'No word on the bill says what it is for' };

  // Quantity and rate only mean litres and ₹/L on a fuel bill. On a tyre bill
  // "Qty 2" is two tyres, and reading it as litres would post nonsense.
  if (fields.kind.value !== 'diesel') {
    delete fields.litres;
    delete fields.rate;
  }

  // Litres × rate is the one arithmetic a fuel bill must satisfy.
  if (fields.litres && fields.rate && fields.amount) {
    const expected = Number(fields.litres.value) * Number(fields.rate.value);
    const stated = Number(fields.amount.value);
    if (expected > 0 && Math.abs(expected - stated) / expected > 0.01) {
      fields.amount = { ...fields.amount, confidence: 1, note: `Litres × rate = ₹${expected.toFixed(2)}, not ₹${stated.toFixed(2)}` };
      warnings.push(`Litres × rate comes to ₹${expected.toFixed(2)} but the bill total reads ₹${stated.toFixed(2)}.`);
    }
  }
  const FIELD_WORD: Partial<Record<BillFieldKey, string>> = {
    billDate: 'The date',
    vehicle: 'The vehicle number',
    litres: 'The quantity',
    rate: 'The rate',
    billNumber: 'The bill number',
  };
  for (const [key, text] of unreadable) {
    if (fields[key] || !FIELD_WORD[key]) continue;
    // Litres and rate were dropped above for a non-fuel bill; not a problem then.
    if ((key === 'litres' || key === 'rate') && fields.kind.value !== 'diesel') continue;
    warnings.push(`${FIELD_WORD[key]} is on the bill but could not be read (read as "${text}") — key it from the paper.`);
  }
  if (!fields.amount) warnings.push('No total could be read — key the amount from the paper.');
  if (!fields.billNumber) warnings.push('No bill number could be read.');

  return { fields, warnings };
}
