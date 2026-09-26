/**
 * WHATSAPP GROUP → DIESEL CLAIMS.
 *
 * Drivers already report every fill in the fleet's WhatsApp group: a photo of
 * the bunk slip and a line like "1001 diesel 432 ltr 41277". This module reads
 * the group's own "Export chat" file and turns those messages into diesel
 * claims a fleet manager can validate — it does not invent a fill that was not
 * posted, and it does not guess a number that was not written.
 *
 * Two layers, kept apart:
 *   1. `parseWhatsAppExport` — the chat file into messages. Knows only the
 *      export formats (Android and iOS, 12- and 24-hour, day- or month-first,
 *      with and without media), never anything about diesel.
 *   2. `extractDieselClaims` — messages into claims. Knows how drivers write
 *      about diesel, in English and Tamil, and nothing about file formats.
 *
 * When the WhatsApp Business Cloud API is connected, its webhook payloads
 * become `ChatMessage`s and layer 2 runs unchanged.
 *
 * Pure functions, no DOM.
 */

/* ----------------------------------------------------------------- types */

export interface ChatMessage {
  /** ISO-8601 UTC instant, from the export's local clock (IST by default). */
  at: string;
  /** Exactly as the export names them: a saved contact name or a phone number. */
  sender: string;
  /** The message body, attachment markers removed, continuation lines joined. */
  text: string;
  /** File names the message refers to, as written in the export. */
  attachments: string[];
  /** True when the export was made "without media" and a file was dropped. */
  mediaOmitted: boolean;
  /** 1-based line in the export where the message starts. */
  line: number;
}

export interface ChatExport {
  format: 'android' | 'ios' | 'unknown';
  dateOrder: 'dmy' | 'mdy';
  messages: ChatMessage[];
  /** Group notices with no sender: joins, leaves, encryption banners. */
  systemLines: number;
}

/* ---------------------------------------------------------------- parsing */

// Invisible marks WhatsApp sprinkles through exports: LRM/RLM direction marks,
// and the narrow no-break space newer phones put before "pm".
const INVISIBLE = /[‎‏‪-‮⁦-⁩]/g;
const ODD_SPACE = /[   ]/g;

const ANDROID_HEADER =
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap]\.?\s?m\.?)?\s+-\s+(.*)$/i;
const IOS_HEADER =
  /^\[(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap]\.?\s?m\.?)?\]\s+(.*)$/i;

/** "IMG-20260806-WA0012.jpg (file attached)" — Android, media included. */
const ANDROID_ATTACHED = /(\S+\.[a-z0-9]{2,5})\s+\(file attached\)/gi;
/** "<attached: 00000012-PHOTO-2026-08-06-19-42-10.jpg>" — iOS, media included. */
const IOS_ATTACHED = /<attached:\s*([^>]+)>/gi;
/** Export made without media. Wording differs by app version and platform. */
const MEDIA_OMITTED = /<media omitted>|\b(?:image|photo|video|document|sticker|audio) omitted\b/i;

interface Header {
  a: number;
  b: number;
  y: number;
  h: number;
  mi: number;
  s: number;
  ampm: string | undefined;
  rest: string;
  format: 'android' | 'ios';
}

function readHeader(line: string): Header | null {
  const ios = IOS_HEADER.exec(line);
  const m = ios ?? ANDROID_HEADER.exec(line);
  if (!m) return null;
  return {
    a: Number(m[1]),
    b: Number(m[2]),
    y: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: m[6] ? Number(m[6]) : 0,
    ampm: m[7]?.toLowerCase().replace(/[.\s]/g, ''),
    rest: m[8] ?? '',
    format: ios ? 'ios' : 'android',
  };
}

/**
 * @param utcOffsetMinutes the clock of the phone that made the export; IST
 *   unless the fleet manager's phone says otherwise
 */
export function parseWhatsAppExport(text: string, options: { utcOffsetMinutes?: number } = {}): ChatExport {
  const offset = options.utcOffsetMinutes ?? 330;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(INVISIBLE, '').replace(ODD_SPACE, ' '));

  // Day-first or month-first is a property of the phone, not of a line: decide
  // once from the whole file. Any first number over 12 settles it; so does any
  // second number over 12. An export that never says either way is Indian,
  // which is day-first.
  const headers = lines.map(readHeader);
  const seen = headers.filter((h): h is Header => h !== null);
  const dateOrder: 'dmy' | 'mdy' = seen.some((h) => h.a > 12) ? 'dmy' : seen.some((h) => h.b > 12) ? 'mdy' : 'dmy';

  const messages: ChatMessage[] = [];
  let systemLines = 0;
  let current: ChatMessage | null = null;
  let format: ChatExport['format'] = 'unknown';

  const finish = () => {
    if (current) {
      current.text = current.text.trim();
      messages.push(current);
    }
    current = null;
  };

  lines.forEach((line, i) => {
    const hdr = headers[i];
    if (!hdr) {
      // A continuation of the message above, or preamble before the first one.
      if (current) current.text += `\n${line}`;
      return;
    }
    finish();
    format = format === 'unknown' ? hdr.format : format;
    const [d, mo] = dateOrder === 'dmy' ? [hdr.a, hdr.b] : [hdr.b, hdr.a];
    const y = hdr.y < 100 ? 2000 + hdr.y : hdr.y;
    let h = hdr.h;
    if (hdr.ampm === 'pm' && h < 12) h += 12;
    if (hdr.ampm === 'am' && h === 12) h = 0;
    const utc = Date.UTC(y, mo - 1, d, h, hdr.mi, hdr.s) - offset * 60_000;

    // "Sender: body". A line with no "name:" is a group notice — someone
    // joined, the encryption banner — and carries no claim.
    const colon = /^([^:]{1,60}?):\s(.*)$/s.exec(hdr.rest) ?? /^([^:]{1,60}?):$/.exec(hdr.rest);
    if (!colon) {
      systemLines += 1;
      return;
    }
    current = { at: new Date(utc).toISOString(), sender: colon[1]!.trim(), text: colon[2] ?? '', attachments: [], mediaOmitted: false, line: i + 1 };
  });
  finish();

  for (const msg of messages) {
    const files = [...msg.text.matchAll(ANDROID_ATTACHED), ...msg.text.matchAll(IOS_ATTACHED)].map((m) => m[1]!.trim());
    msg.attachments = files;
    msg.mediaOmitted = MEDIA_OMITTED.test(msg.text);
    msg.text = msg.text
      .replace(ANDROID_ATTACHED, '')
      .replace(IOS_ATTACHED, '')
      .replace(/<media omitted>/gi, '')
      .replace(/\b(?:image|photo|video|document|sticker|audio) omitted\b/gi, '')
      .trim();
  }

  return { format, dateOrder, messages, systemLines };
}

/* ------------------------------------------------------------- extraction */

export interface FleetVehicleRef {
  id: string;
  /** Compact form, e.g. "TN29AB1001". */
  registrationNumber: string;
}

export interface DriverRef {
  id: string;
  name: string;
  phone: string;
}

export interface DieselClaim {
  /** Stable across re-imports of the same export: used to refuse duplicates. */
  key: string;
  line: number;
  at: string;
  sender: string;
  text: string;
  attachments: string[];
  mediaOmitted: boolean;
  litres: number | null;
  amount: number | null;
  /**
   * True when the figure was written without a unit ("432 41277") and was
   * read as litres or rupees only because the pair gives a plausible diesel
   * price. Always flagged for the fleet manager to check.
   */
  litresInferred: boolean;
  amountInferred: boolean;
  /** Only when written, or derivable from two written numbers. */
  ratePerLitre: number | null;
  rateDerived: boolean;
  odometerKm: number | null;
  /** The vehicle as the driver wrote it. */
  vehicleText: string | null;
  /** Matched fleet vehicle, when the match is unambiguous. */
  vehicleId: string | null;
  vehicleMatch: 'registration' | 'last_four' | 'none';
  driverId: string | null;
  driverMatch: 'name' | 'phone' | 'none';
  /** Plain sentences a fleet manager should read before validating. */
  issues: string[];
  /** Key of an earlier claim in the same import this one repeats, if any. */
  duplicateOf: string | null;
}

/** "diesel" and the ways drivers actually write it, including Tamil. */
const DIESEL_WORDS = /\b(?:diesel|deisel|disel|dsl|hsd|fuel|filled|fill(?:ing)?|bunk|topped?\s*up|top\s*up)\b|டீசல்|டிசல்/i;
const LITRES = /(\d+(?:\.\d+)?)\s*(?:l|lt|ltr|ltrs|litre|litres|liter|liters|lit|lts)\b|(\d+(?:\.\d+)?)\s*லி(?:ட்டர்)?/i;
const AMOUNT_BEFORE = /(?:₹|rs\.?|inr|amt\.?|amount|rupees?)\s*[:=-]?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i;
const AMOUNT_AFTER = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:₹|rs\.?|rupees?|\/-|ரூ)/i;
const RATE = /(?:rate|@|per\s*l(?:itre|tr)?)\s*[:=-]?\s*(\d{2,3}(?:\.\d{1,2})?)/i;
const ODOMETER = /(?:odo(?:meter)?|km\s*reading|reading|kms?|கி\.?மீ)\s*[:=-]?\s*(\d{4,7})\b|\b(\d{5,7})\s*kms?\b/i;
const REGISTRATION = /\b([A-Z]{2})[\s.-]*(\d{1,2})[\s.-]*([A-Z]{1,3})[\s.-]*(\d{3,4})\b/i;

/** A plausible Indian retail diesel price. Outside it, a number was misread or mistyped. */
export const DIESEL_RATE_BAND = { min: 80, max: 120 } as const;

const toNumber = (s: string | undefined) => (s === undefined ? null : Number(s.replace(/,/g, '')));

/**
 * Standalone numbers in a message — not part of a time (7:42), a date
 * (06/08), a word (4825TK) or a percentage. Indian digit grouping allowed.
 */
function bareNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![\w.,/:₹-])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\w,/:%]|\.\d)/g)) {
    out.push(Number(m[1]!.replace(/,/g, '')));
  }
  return out;
}
const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9஀-௿]+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * The driver who posted. An exact saved name, or the phone number WhatsApp
 * shows for an unsaved contact, or a saved name that contains every word of
 * exactly one driver's name ("Murugan S Driver" → "Murugan S"). Anything
 * looser is left for a human: paying the wrong driver's batta is worse than
 * one extra click.
 */
export function matchDriver(sender: string, drivers: readonly DriverRef[]): { driverId: string | null; how: DieselClaim['driverMatch'] } {
  const name = normalizeName(sender);
  const exact = drivers.filter((d) => normalizeName(d.name) === name);
  if (exact.length === 1) return { driverId: exact[0]!.id, how: 'name' };
  const phone = digits(sender).slice(-10);
  if (phone.length === 10) {
    const byPhone = drivers.filter((d) => digits(d.phone).slice(-10) === phone);
    if (byPhone.length === 1) return { driverId: byPhone[0]!.id, how: 'phone' };
  }
  const words = new Set(name.split(' '));
  const contained = drivers.filter((d) => normalizeName(d.name).split(' ').every((w) => words.has(w)));
  if (contained.length === 1) return { driverId: contained[0]!.id, how: 'name' };
  return { driverId: null, how: 'none' };
}

/**
 * The vehicle a message is about. A full registration is matched exactly.
 * Drivers mostly write only the last four digits ("1001 diesel 200"), which
 * is matched only when exactly one vehicle in the fleet ends that way and the
 * number is not one of the litres, amount or odometer figures.
 */
export function matchVehicle(
  text: string,
  fleet: readonly FleetVehicleRef[],
  taken: readonly number[] = [],
): { vehicleId: string | null; vehicleText: string | null; how: DieselClaim['vehicleMatch'] } {
  const full = REGISTRATION.exec(text);
  if (full) {
    const reg = `${full[1]!.toUpperCase()}${full[2]!.padStart(2, '0')}${full[3]!.toUpperCase()}${full[4]!.padStart(4, '0')}`;
    const hit = fleet.find((v) => v.registrationNumber === reg);
    return { vehicleId: hit?.id ?? null, vehicleText: full[0], how: hit ? 'registration' : 'none' };
  }
  for (const m of text.matchAll(/(?<![\d.,])(\d{4})(?![\d.,])/g)) {
    const four = m[1]!;
    if (taken.includes(Number(four))) continue;
    const hits = fleet.filter((v) => v.registrationNumber.endsWith(four));
    if (hits.length === 1) return { vehicleId: hits[0]!.id, vehicleText: four, how: 'last_four' };
    if (hits.length > 1) return { vehicleId: null, vehicleText: four, how: 'none' };
  }
  return { vehicleId: null, vehicleText: null, how: 'none' };
}

/**
 * Messages that report a diesel fill, as claims.
 *
 * A message counts when it says diesel (or fuel, bunk, டீசல்…), or when it
 * carries a photo and states a litre figure — the driver who posts the slip
 * and "432 ltr" has reported a fill whatever words they used.
 */
export function extractDieselClaims(
  chat: ChatExport,
  context: { fleet?: readonly FleetVehicleRef[]; drivers?: readonly DriverRef[] } = {},
): DieselClaim[] {
  const fleet = context.fleet ?? [];
  const drivers = context.drivers ?? [];
  const claims: DieselClaim[] = [];

  for (const msg of chat.messages) {
    const hasPhoto = msg.attachments.length > 0 || msg.mediaOmitted;
    const litresMatch = LITRES.exec(msg.text);
    if (!DIESEL_WORDS.test(msg.text) && !(hasPhoto && litresMatch)) continue;

    let litres = toNumber(litresMatch?.[1] ?? litresMatch?.[2]);
    let amount = toNumber((AMOUNT_BEFORE.exec(msg.text) ?? AMOUNT_AFTER.exec(msg.text))?.[1]);
    const statedRate = toNumber(RATE.exec(msg.text)?.[1]);
    const odoMatch = ODOMETER.exec(msg.text);
    const odometerKm = toNumber(odoMatch?.[1] ?? odoMatch?.[2]);
    const labelled = [litres, amount, statedRate, odometerKm].filter((n): n is number => n !== null);

    // The vehicle first: a fleet vehicle's last four digits are the vehicle,
    // never an unlabelled amount that happens to be four digits long.
    const vehicle = matchVehicle(msg.text, fleet, labelled);

    // Then unlabelled numbers, read only in a pair that makes a diesel price.
    let litresInferred = false;
    let amountInferred = false;
    /** Unlabelled numbers left over after inference, reported rather than dropped. */
    let unread: number[] = [];
    if (litres === null || amount === null) {
      const bare = bareNumbers(msg.text.replace(REGISTRATION, ' '));
      const used = [...labelled, ...(vehicle.vehicleText && /^\d{4}$/.test(vehicle.vehicleText) ? [Number(vehicle.vehicleText)] : [])];
      const free = bare.filter((n) => {
        const at = used.indexOf(n);
        if (at === -1) return true;
        used.splice(at, 1);
        return false;
      });
      const plausible = (l: number, a: number) => l > 0 && a / l >= DIESEL_RATE_BAND.min && a / l <= DIESEL_RATE_BAND.max;
      if (litres !== null && amount === null) {
        const a = free.find((n) => plausible(litres!, n));
        if (a !== undefined) [amount, amountInferred] = [a, true];
      } else if (litres === null && amount !== null) {
        const l = free.find((n) => plausible(n, amount!));
        if (l !== undefined) [litres, litresInferred] = [l, true];
      } else if (litres === null && amount === null) {
        outer: for (const l of free) {
          for (const a of free) {
            if (a !== l && plausible(l, a)) {
              [litres, amount, litresInferred, amountInferred] = [l, a, true, true];
              break outer;
            }
          }
        }
      }
      unread = free.filter((n) => n !== litres && n !== amount && n >= 10);
    }

    const issues: string[] = [];
    let ratePerLitre = statedRate;
    let rateDerived = false;
    if (ratePerLitre === null && litres && amount) {
      ratePerLitre = Math.round((amount / litres) * 100) / 100;
      rateDerived = true;
    }
    if (ratePerLitre !== null && (ratePerLitre < DIESEL_RATE_BAND.min || ratePerLitre > DIESEL_RATE_BAND.max)) {
      issues.push(
        `Works out at ₹${ratePerLitre.toFixed(2)} a litre, outside ₹${DIESEL_RATE_BAND.min}–${DIESEL_RATE_BAND.max} — a litre or rupee figure is probably wrong.`,
      );
    }
    if (litresInferred || amountInferred) {
      issues.push(
        `${[litresInferred ? `${litres} as litres` : null, amountInferred ? `${amount} as rupees` : null].filter(Boolean).join(' and ')} — read from unlabelled numbers; check against the slip.`,
      );
    }
    if (litres === null) issues.push('No litres stated.');
    if (amount === null) {
      const near = litres !== null ? unread.find((n) => n > litres!) : undefined;
      issues.push(
        near !== undefined
          ? `No amount stated. ${near} is written but was not read as rupees — with ${litres} litres it would be ₹${(near / litres!).toFixed(2)} a litre.`
          : 'No amount stated.',
      );
    }
    if (!hasPhoto) issues.push('No bill photo posted with it.');
    if (msg.mediaOmitted) issues.push('The chat was exported without media — the photo is not in this file.');

    if (!vehicle.vehicleText) issues.push('No vehicle number in the message.');
    else if (!vehicle.vehicleId) issues.push(`"${vehicle.vehicleText}" does not match exactly one vehicle in the fleet.`);

    const driver = matchDriver(msg.sender, drivers);
    if (!driver.driverId) issues.push(`"${msg.sender}" is not a driver on the roster.`);

    claims.push({
      key: `${msg.at}|${normalizeName(msg.sender)}|${msg.text.replace(/\s+/g, ' ').toLowerCase()}|${msg.attachments.join(',')}`,
      line: msg.line,
      at: msg.at,
      sender: msg.sender,
      text: msg.text,
      attachments: msg.attachments,
      mediaOmitted: msg.mediaOmitted,
      litres,
      amount,
      litresInferred,
      amountInferred,
      ratePerLitre,
      rateDerived,
      odometerKm,
      vehicleText: vehicle.vehicleText,
      vehicleId: vehicle.vehicleId,
      vehicleMatch: vehicle.how,
      driverId: driver.driverId,
      driverMatch: driver.how,
      issues,
      duplicateOf: null,
    });
  }

  // The same fill posted twice — a resend, or the slip forwarded by someone
  // else — is the commonest way one tank gets paid for twice. Same vehicle,
  // same litres, same amount inside six hours is flagged, never dropped.
  claims.forEach((c, i) => {
    const earlier = claims
      .slice(0, i)
      .find(
        (e) =>
          (c.attachments.length > 0 && e.attachments.some((a) => c.attachments.includes(a))) ||
          (e.vehicleId !== null &&
            e.vehicleId === c.vehicleId &&
            e.litres !== null &&
            e.litres === c.litres &&
            e.amount === c.amount &&
            Math.abs(Date.parse(e.at) - Date.parse(c.at)) <= 6 * 3_600_000),
      );
    if (earlier) {
      c.duplicateOf = earlier.key;
      c.issues.unshift(`Looks like a repeat of the message on line ${earlier.line}.`);
    }
  });

  return claims;
}

/* --------------------------------------------------------------- summary */

export interface DieselTotal {
  key: string;
  fills: number;
  litres: number;
  amount: number;
}

/** Litres and rupees per driver, per vehicle, or per anything else keyed. */
export function summarizeDiesel<T extends { litres: number | null; amount: number | null }>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
): DieselTotal[] {
  const map = new Map<string, DieselTotal>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key === null) continue;
    const t = map.get(key) ?? { key, fills: 0, litres: 0, amount: 0 };
    t.fills += 1;
    t.litres = Math.round((t.litres + (r.litres ?? 0)) * 100) / 100;
    t.amount = Math.round((t.amount + (r.amount ?? 0)) * 100) / 100;
    map.set(key, t);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}
