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
}

/**
 * What a reviewer should look at first, as a code and its values. The screen
 * words it in the reader's language (docs/WRITING.md).
 */
export type CaptureWarning =
  /** Litres × rate does not come to the total on the bill. */
  | { code: 'litres-rate-mismatch'; expected: number; stated: number }
  /** A labelled field whose value could not be read — said, never guessed. */
  | { code: 'unreadable'; field: 'billDate' | 'vehicle' | 'litres' | 'rate' | 'billNumber'; text: string }
  | { code: 'no-total' }
  | { code: 'no-bill-number' };

export interface BillCapture {
  fields: Partial<Record<BillFieldKey, CapturedField>>;
  warnings: CaptureWarning[];
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

/**
 * A printed quantity or rate: litres, ₹ per litre. Unlike rupees it keeps a
 * third decimal — pumps print 120.455 L, and reading it as 120.45 loses
 * diesel on every slip.
 */
export function parseQuantity(text: string): number | null {
  const m = /(\d{1,3}(?:,\d{3})+(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseBillDate(text: string): string | null {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  // Two- or four-digit years only: "07/08/202" is a misread, not the year 202.
  const dmy = /(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?!\d)/.exec(text);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /(\d{1,2})[\s-]*([a-z]{3})[a-z]*[\s,-]*(\d{4}|\d{2})(?!\d)/i.exec(text);
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

/**
 * A unit printed straight after a label — "Volume(Ltr.)", "Rate(Rs/Ltr)",
 * "Total (incl. GST 18%)" — belongs to the label, not the value. A bracket
 * holding what looks like a value (three digits running, or a date) is left
 * for the value.
 */
const UNIT = String.raw`(?:\s*\((?![^)]*(?:\d{3}|\d[./-]\d))[^)]{0,30}\))?`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelRe = (l: string) => new RegExp(`(?<![a-z])${escape(l).replace(/\s+/g, '[\\s.]*')}\\.?${UNIT}(?![a-z])\\s*[:#=-]?\\s*(.*)$`, 'i');
const startsWithLabel = (line: string) => LABELS.some((g) => g.labels.some((l) => labelRe(l).exec(line)?.index === 0));

/**
 * Totals that are not what is owed. "Total Qty: 2" is two tyres and "Total
 * Tax: 1,800.00" is the GST — read as the bill total, either would be paid.
 */
const NOT_MONEY_AFTER = /^(?:qty|quantity|items?|nos?\b|pcs|pieces|units?|volume|vol\b|litres?|liters?|ltrs?|kgs?|weight|tax|gst|cgst|sgst|igst|cess|vat|discount|disc\b|savings?|tds)/i;
const NOT_THE_TOTAL_BEFORE = /(?:taxable|tax|gst|cgst|sgst|igst|cess|vat|discount|disc\.?|round(?:ing)?[\s-]*off|tds)[\s.]*$/i;

/* ------------------------------------------------------------------ kinds */

/** "Fuel filter" and "diesel injector" are parts, not fuel. */
const NOT_FUEL_AFTER = String.raw`(?![\s-]+(?:filters?|injectors?|injection|pumps?|tanks?|lines?|pipes?|hoses?|caps?|gauges?|sensors?|system|engine))`;

const KIND_SIGNALS: { kind: BillKind; pattern: RegExp }[] = [
  {
    kind: 'diesel',
    pattern: new RegExp(
      String.raw`\b(?:diesel|fuels?)\b${NOT_FUEL_AFTER}|\bhsd\b|\bbunk\b|\bpetroleum\b|indian\s*oil|\b(?:iocl|bpcl|hpcl)\b|filling\s+station`,
      'i',
    ),
  },
  { kind: 'toll', pattern: /\btoll\b|\bfastag\b|\bnhai\b|\bplaza\b/i },
  { kind: 'tyre', pattern: /\btyres?\b|\btires?\b|\bretread/i },
  { kind: 'repair', pattern: /\brepairs?\b|\blabou?r\b|\bservice\s+charge|\boverhaul|\bwelding\b|\bworkshop\b/i },
  { kind: 'spares', pattern: /\bspares?\b|\bfilter\b|\bhose\b|\bbearing\b|\bgasket\b|\bparts?\b/i },
];

/**
 * An oil company's name printed alone over the dealer's: "INDIAN OIL" above
 * "SAKTHI FUELS". The bill is the dealer's, and the dealer is who is paid.
 */
const BRAND_ONLY = /^(?:indian\s*oil(?:\s+corporation(?:\s+ltd\.?)?)?|iocl|bharat\s+petroleum|bpcl|hp|hpcl|hindustan\s+petroleum|reliance|jio[\s-]*bp|nayara(?:\s+energy)?|shell)$/i;

/* ------------------------------------------------------------------ parse */

/**
 * @param text  what the OCR read, one printed line per line
 * @param lineConfidence  optional 0–100 per line from the OCR engine; a field
 *   read from a line the engine itself doubted can never score 3
 */
export function captureExpenseBill(text: string, lineConfidence: number[] = []): BillCapture {
  // Blank lines are kept: line i must stay line i of `lineConfidence`.
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const fields: Partial<Record<BillFieldKey, CapturedField>> = {};
  const warnings: CaptureWarning[] = [];
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
    // spot. Each claims itself, its unit and its separator — so "Rate/Ltr"
    // is a rate, never litres because "Ltr" also appears in it.
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
    const claimed: typeof hits = [];
    for (const hit of hits) {
      if (!claimed.some((c) => hit.start < c.end && hit.end > c.start)) claimed.push(hit);
    }
    // A row of labels with no values — "Bill No:   Date:" — is a table
    // header, and its values are on the line below.
    const headerRow = claimed.length > 0 && claimed[claimed.length - 1]!.rest === '';
    const below = lines[i + 1] ?? '';
    claimed.forEach((hit, n) => {
      const { key, label } = hit;
      // Nothing after the label, or only the next label: the value is blank
      // here. It may be printed below — but never when the line below is a
      // label itself, as with "Bill No:" over "Date: 06/08/2026", and never
      // for "Bill No:   Date: 06/08/2026", where the bill number is missing.
      const next = claimed[n + 1];
      const emptyHere = !hit.rest || (next !== undefined && line.slice(hit.end, next.start).trim() === '');
      const rest = !emptyHere ? hit.rest : (!hit.rest || headerRow) && !startsWithLabel(below) ? below : '';
      if (key === 'amount') {
        // A subtotal, a tax, a discount or a "Total Qty" is never what is
        // owed. A later "Total" of the same rank is the running one, so it
        // replaces the earlier.
        if (/sub[\s-]*total/i.test(line) || NOT_MONEY_AFTER.test(rest) || NOT_THE_TOTAL_BEFORE.test(line.slice(0, hit.start))) return;
        // "Total incl. GST 18% 11,800.00": the rate is not the total.
        const amount = parseRupees(rest.replace(/\d+(?:\.\d+)?\s*%/g, ' '));
        const rank = AMOUNT_RANK.get(label) ?? 99;
        if (amount !== null && rank <= amountRank) {
          amountRank = rank;
          fields.amount = { key, value: amount.toFixed(2), source: line, confidence: cap(i, rank <= 5 ? 3 : 2) };
        }
      } else if (!fields[key]) {
        const quantity = key === 'litres' || key === 'rate' ? parseQuantity(rest) : null;
        const value =
          key === 'billDate'
            ? parseBillDate(rest)
            : key === 'vehicle'
              ? parseRegistration(rest)
              : key === 'litres' || key === 'rate'
                ? quantity === null
                  ? null
                  : String(quantity)
                : (/[A-Z0-9][A-Z0-9/-]*/i.exec(rest)?.[0] ?? null);
        if (value) fields[key] = { key, value, source: line, confidence: cap(i, 3) };
        else if (rest.trim() && !unreadable.has(key)) unreadable.set(key, rest.trim());
      }
    });
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
  // is not a label, a number, a registration or an oil company's logo line.
  // Found by position alone, so scored 2 at best.
  const head = lines.slice(0, 4).findIndex(
    (l) =>
      /[a-z]{3,}/i.test(l) &&
      (l.match(/\d/g)?.length ?? 0) < 4 &&
      !LABELS.some((g) => g.labels.some((lb) => labelRe(lb).test(l))) &&
      !/tax\s+invoice|cash\s+bill|receipt|welcome/i.test(l) &&
      !BRAND_ONLY.test(l),
  );
  if (head >= 0) fields.vendor = { key: 'vendor', value: lines[head]!.replace(/\s{2,}/g, ' '), source: lines[head]!, confidence: cap(head, 2) };

  const kind = KIND_SIGNALS.find((k) => k.pattern.test(all));
  // No word on the bill says what it is for: "other", with nothing read.
  fields.kind = kind
    ? { key: 'kind', value: kind.kind, source: kind.pattern.exec(all)![0], confidence: 2 }
    : { key: 'kind', value: 'other', source: '', confidence: 1 };

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
      fields.amount = { ...fields.amount, confidence: 1 };
      warnings.push({ code: 'litres-rate-mismatch', expected: Math.round(expected * 100) / 100, stated });
    }
  }
  const SAID_WHEN_UNREADABLE = ['billDate', 'vehicle', 'litres', 'rate', 'billNumber'] as const;
  for (const [key, text] of unreadable) {
    const field = SAID_WHEN_UNREADABLE.find((k) => k === key);
    if (fields[key] || !field) continue;
    // Litres and rate were dropped above for a non-fuel bill; not a problem then.
    if ((field === 'litres' || field === 'rate') && fields.kind.value !== 'diesel') continue;
    warnings.push({ code: 'unreadable', field, text });
  }
  if (!fields.amount) warnings.push({ code: 'no-total' });
  if (!fields.billNumber) warnings.push({ code: 'no-bill-number' });

  return { fields, warnings };
}
