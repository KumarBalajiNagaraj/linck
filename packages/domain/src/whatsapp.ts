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
  /** Lines of follow-up messages folded into this one: the caption typed after its photo. */
  mergedLines?: number[];
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

/* ---------------------------------------------------------------- pairing */

/** A photo and its caption, sent as two messages, are one report if they are this close. */
const PAIR_WINDOW_MS = 10 * 60_000;

/**
 * Drivers often send the slip photo and then type the figures as a second
 * message — or the other way round. A photo-only message takes the same
 * sender's next text-only message within ten minutes, or failing that the one
 * just before it, so the figures and their evidence stay together. Nothing
 * else is merged.
 */
export function pairFollowUps(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = messages.map((m) => ({ ...m, attachments: [...m.attachments] }));
  const absorbed = new Set<number>();
  const photoOnly = (m: ChatMessage) => (m.attachments.length > 0 || m.mediaOmitted) && m.text === '';
  const textOnly = (m: ChatMessage) => m.attachments.length === 0 && !m.mediaOmitted && m.text !== '';
  const near = (a: ChatMessage, b: ChatMessage) => Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= PAIR_WINDOW_MS;

  out.forEach((photo, i) => {
    if (absorbed.has(i) || !photoOnly(photo)) return;
    // Nothing else from this sender may sit between the two.
    const next = out.findIndex((m, j) => j > i && m.sender === photo.sender);
    const prev = out.map((m, j) => (j < i && m.sender === photo.sender ? j : -1)).filter((j) => j >= 0).pop() ?? -1;
    const take = next !== -1 && !absorbed.has(next) && textOnly(out[next]!) && near(photo, out[next]!)
      ? next
      : prev !== -1 && !absorbed.has(prev) && textOnly(out[prev]!) && near(photo, out[prev]!)
        ? prev
        : -1;
    if (take === -1) return;
    photo.text = out[take]!.text;
    photo.mergedLines = [...(photo.mergedLines ?? []), out[take]!.line];
    absorbed.add(take);
  });
  return out.filter((_, i) => !absorbed.has(i));
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
  /**
   * How it repeats the earlier one. The same photo is the same bill and is
   * not added twice; the same figures within hours may be a second fill, so
   * it is flagged and kept.
   */
  duplicateReason: 'same_photo' | 'same_figures' | null;
  /**
   * Mentions diesel but reports no fill: no litres, no amount and no photo —
   * "diesel bills before 6pm", "filled?". Nothing here could be paid.
   */
  noFill: boolean;
  /** Lines of follow-up messages folded into this claim. */
  mergedLines: number[];
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
 * The driver who posted. The phone number WhatsApp shows for an unsaved
 * contact first — a number is one person; then an exact saved name; then a
 * saved name that contains every word of exactly one driver's name ("Murugan
 * S Driver" → "Murugan S"). Anything looser is left for a human: paying the
 * wrong driver's batta is worse than one extra click.
 *
 * `notDrivers` are group members who are not reporting fills — the fleet
 * manager importing the chat, whose name may also be on the driver roster.
 */
export function matchDriver(
  sender: string,
  drivers: readonly DriverRef[],
  notDrivers: readonly string[] = [],
): { driverId: string | null; how: DieselClaim['driverMatch'] } {
  const name = normalizeName(sender);
  if (notDrivers.some((n) => normalizeName(n) === name)) return { driverId: null, how: 'none' };
  const phone = digits(sender).slice(-10);
  if (phone.length === 10 && /^[\d\s+()-]+$/.test(sender)) {
    const byPhone = drivers.filter((d) => digits(d.phone).slice(-10) === phone);
    return byPhone.length === 1 ? { driverId: byPhone[0]!.id, how: 'phone' } : { driverId: null, how: 'none' };
  }
  const exact = drivers.filter((d) => normalizeName(d.name) === name);
  if (exact.length === 1) return { driverId: exact[0]!.id, how: 'name' };
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
  context: {
    fleet?: readonly FleetVehicleRef[];
    drivers?: readonly DriverRef[];
    /** Members whose posts are not fill reports: the person importing, say. */
    notDrivers?: readonly string[];
    /** Fold a photo and its separately-sent caption into one message. On by default. */
    pairPhotos?: boolean;
    /**
     * Treat a photo posted with no words as a claim, to be filled from its
     * slip. For an import that reads the slips; off otherwise, since with no
     * slip reading such a claim has nothing in it.
     */
    photoOnly?: boolean;
  } = {},
): DieselClaim[] {
  const fleet = context.fleet ?? [];
  const drivers = context.drivers ?? [];
  const notDrivers = context.notDrivers ?? [];
  const messages = context.pairPhotos === false ? chat.messages : pairFollowUps(chat.messages);
  const claims: DieselClaim[] = [];

  for (const msg of messages) {
    const hasPhoto = msg.attachments.length > 0 || msg.mediaOmitted;
    const litresMatch = LITRES.exec(msg.text);
    const bareSlip = context.photoOnly === true && hasPhoto && msg.text === '';
    if (!DIESEL_WORDS.test(msg.text) && !(hasPhoto && litresMatch) && !bareSlip) continue;

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
    if (bareSlip) issues.unshift('A photo with no message — its figures can only come from the slip.');
    if (msg.mediaOmitted) issues.push('The chat was exported without media — the photo is not in this file.');

    if (!vehicle.vehicleText) issues.push('No vehicle number in the message.');
    else if (!vehicle.vehicleId) issues.push(`"${vehicle.vehicleText}" does not match exactly one vehicle in the fleet.`);

    const driver = matchDriver(msg.sender, drivers, notDrivers);
    if (notDrivers.some((n) => normalizeName(n) === normalizeName(msg.sender))) {
      issues.push(`Posted by ${msg.sender}, who is not reporting a fill of their own.`);
    } else if (!driver.driverId) {
      issues.push(`"${msg.sender}" is not a driver on the roster.`);
    }
    const noFill = litres === null && amount === null && !hasPhoto;
    if (noFill) issues.unshift('Mentions diesel but gives no litres, amount or slip — nothing here could be paid.');

    claims.push({
      // Stable across re-imports, and across phones: the sender's saved name
      // and the photo file names differ on each phone that exports the group,
      // so neither is part of the key.
      key: `${msg.at.slice(0, 16)}|${msg.text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()}|${msg.attachments.length + (msg.mediaOmitted ? 1 : 0)}`,
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
      duplicateReason: null,
      noFill,
      mergedLines: msg.mergedLines ?? [],
    });
  }

  // The same fill posted twice — a resend, or the slip forwarded by someone
  // else — is the commonest way one tank gets paid for twice. Same vehicle,
  // same litres, same amount inside six hours is flagged, never dropped.
  claims.forEach((c, i) => {
    const before = claims.slice(0, i);
    const samePhoto = before.find((e) => c.attachments.length > 0 && e.attachments.some((a) => c.attachments.includes(a)));
    const sameFigures = before.find(
      (e) =>
        e.vehicleId !== null &&
        e.vehicleId === c.vehicleId &&
        e.litres !== null &&
        e.litres === c.litres &&
        e.amount === c.amount &&
        Math.abs(Date.parse(e.at) - Date.parse(c.at)) <= 6 * 3_600_000,
    );
    const earlier = samePhoto ?? sameFigures;
    if (earlier) {
      c.duplicateOf = earlier.key;
      c.duplicateReason = samePhoto ? 'same_photo' : 'same_figures';
      c.issues.unshift(
        samePhoto
          ? `The same photo as the message on line ${earlier.line} — the same bill posted again.`
          : `Looks like a repeat of the message on line ${earlier.line}: same vehicle, litres and amount.`,
      );
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

/**
 * Litres and rupees per driver, per vehicle, or per anything else keyed.
 * Summed in whole paise and hundredths of a litre, so forty fills add up to
 * exactly what the forty bills say.
 */
export function summarizeDiesel<T extends { litres: number | null; amount: number | string | null }>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
): DieselTotal[] {
  const map = new Map<string, { key: string; fills: number; centiLitres: number; paise: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key === null) continue;
    const t = map.get(key) ?? { key, fills: 0, centiLitres: 0, paise: 0 };
    t.fills += 1;
    t.centiLitres += Math.round((r.litres ?? 0) * 100);
    t.paise += Math.round(Number(r.amount ?? 0) * 100);
    map.set(key, t);
  }
  return [...map.values()]
    .map((t) => ({ key: t.key, fills: t.fills, litres: t.centiLitres / 100, amount: t.paise / 100 }))
    .sort((a, b) => b.amount - a.amount);
}

/* ---------------------------------------------------- against the ledger */

/** What an import needs to know about a bill already in Linck. */
export interface LedgerBill {
  id: string;
  /** The claim it was imported from, for a bill that came from WhatsApp. */
  claimKey: string | null;
  attachmentNames: readonly string[];
  vendor: string;
  billNumber: string;
  submittedAt: string;
}

export type ImportOutcome = 'add' | 'needs_details' | 'repeat' | 'already_imported' | 'already_in_linck' | 'no_fill';

export interface PlannedClaim<C extends DieselClaim = DieselClaim> {
  claim: C;
  outcome: ImportOutcome;
  /** Why it is not being added, in a sentence. Null for 'add'. */
  reason: string | null;
}

const billKey = (vendor: string, billNumber: string) =>
  vendor.trim() && billNumber.trim() ? `${normalizeName(vendor)}|${billNumber.replace(/\s+/g, '').toUpperCase()}` : null;

/**
 * What an import will do with each claim, checked against the bills already
 * in Linck as well as against the rest of the import:
 *
 *   - a claim imported before (by its key) is not added again, whatever phone
 *     the export came from;
 *   - the same photo as a bill already in Linck, or as an earlier claim, is
 *     the same bill posted again;
 *   - the same bunk's bill number already in Linck is the same bill, however
 *     it came in — uploaded, keyed or imported;
 *   - a claim with no fill in it is shown, never added;
 *   - a claim without a matched vehicle or an amount waits for those details.
 */
export function planDieselImport<C extends DieselClaim & { billNumber?: string | null; vendor?: string | null }>(
  claims: readonly C[],
  ledger: readonly LedgerBill[],
): PlannedClaim<C>[] {
  const byKey = new Map(ledger.filter((b) => b.claimKey).map((b) => [b.claimKey!, b]));
  const byPhoto = new Map(ledger.flatMap((b) => b.attachmentNames.map((n) => [n, b] as const)));
  const byBill = new Map(ledger.map((b) => [billKey(b.vendor, b.billNumber), b] as const).filter(([k]) => k !== null) as [string, LedgerBill][]);
  const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('-');

  return claims.map((claim) => {
    const plan = (outcome: ImportOutcome, reason: string | null): PlannedClaim<C> => ({ claim, outcome, reason });
    const imported = byKey.get(claim.key);
    if (imported) return plan('already_imported', `Already imported on ${day(imported.submittedAt)}.`);
    const photo = claim.attachments.map((a) => byPhoto.get(a)).find(Boolean);
    if (photo) return plan('repeat', `The same photo as a bill already in Linck (${photo.billNumber || photo.id}).`);
    if (claim.duplicateReason === 'same_photo') return plan('repeat', claim.issues[0] ?? 'The same photo posted again.');
    const key = billKey(claim.vendor ?? '', claim.billNumber ?? '');
    const same = key ? byBill.get(key) : undefined;
    if (same) return plan('already_in_linck', `Bill ${same.billNumber} from ${same.vendor} is already in Linck.`);
    if (claim.noFill) return plan('no_fill', 'No litres, amount or slip — nothing here could be paid.');
    const missing = [claim.vehicleId ? null : 'the vehicle', claim.amount === null ? 'the amount' : null].filter(Boolean);
    if (missing.length > 0) return plan('needs_details', `Needs ${missing.join(' and ')} before it can go for validation.`);
    return plan('add', null);
  });
}
