import {
  businessDate,
  captureExpenseBill,
  extractDieselClaims,
  parseRegistration,
  parseWhatsAppExport,
  planDieselImport,
  reconcileWithSlip,
  slipFromCapture,
  type ChatMessage,
  type DriverRef,
  type FleetVehicleRef,
  type LedgerBill,
  type PlannedClaim,
  type ReconciledClaim,
} from '@linck/domain';
import { DRIVERS, NOW, VEHICLES, WHATSAPP_DEMO, type ExpenseBill } from '@linck/mock';
import { apiFetch } from '../../auth/api.js';
import { captureBody, type ImportClaimBody } from './expenseApi.js';
import { openBillReader } from './ocr.js';
import type { ChatArchive } from './whatsappArchive.js';

/**
 * DIESEL SLIPS FROM WHATSAPP → BILLS.
 *
 * Most drivers cannot read or write, so the bill is the photo. A driver fills
 * diesel, photographs the bunk's slip and sends it on WhatsApp; that is all.
 * Everything else — litres, rupees, the bunk's bill number, the vehicle — is
 * read off the slip here, checked against whatever the driver did type, and
 * checked against the bills already in Linck.
 *
 * Three ways in, one pipeline:
 *   - the live inbox: photos sent to the WhatsApp Business number, which the
 *     API's webhook has already stored (`/whatsapp/inbox`);
 *   - a group's "Export chat" file, for a fleet still using a group;
 *   - the demo slips, to try it without a phone.
 */

export interface IntakeSource {
  kind: 'inbox' | 'export' | 'demo';
  /** Shown on bills as where they came from. */
  via: string;
  messages: ChatMessage[];
  /** Photos by the file name the messages refer to. */
  media: Map<string, File>;
  /** Stand-in OCR text for photos the demo does not have. */
  slipTexts?: Record<string, string>;
  /** Inbox message id for each message line, so imported messages can be marked. */
  inboxIds?: Map<number, string>;
}

export type IntakeClaim = ReconciledClaim & { photo: File | null };

/** The vehicles and drivers a claim is matched against. */
export interface Rosters {
  fleet: FleetVehicleRef[];
  drivers: DriverRef[];
}

/** The demo's: its sample fleet and driver roster. */
export const DEMO_ROSTERS: Rosters = {
  fleet: VEHICLES.map((v) => ({ id: v.id, registrationNumber: v.registrationNumber })),
  drivers: DRIVERS.map((d) => ({ id: d.id, name: d.name, phone: d.phone })),
};

/**
 * Live, there is no fleet list or driver roster on the API yet
 * (fleet.vehicles is not migrated), and nothing is ever matched against the
 * demo's sample fleet. A bill names its vehicle by registration, so the
 * vehicles this company's own bills name are the fleet a slip is matched
 * against, last four digits included; `readIntake` adds every full
 * registration the import itself writes or reads off a slip. There are no
 * drivers to match: a slip is raised by the number that sent it.
 */
export function liveRosters(bills: readonly ExpenseBill[]): Rosters {
  return { fleet: fleetOf(bills.map((b) => b.vehicleId)), drivers: [] };
}

/** A registration written in full, as bill-capture.ts reads one: TN 38 AL 1050, TN38AL1050. */
const REGISTRATION = /\b[A-Z]{2}[\s.-]*\d{1,2}[\s.-]*[A-Z]{1,3}[\s.-]*\d{3,4}\b/gi;
const WHOLE_REGISTRATION = /^[A-Z]{2}[\s.-]*\d{1,2}[\s.-]*[A-Z]{1,3}[\s.-]*\d{3,4}$/i;

/**
 * Whole registrations, each once, as fleet entries named by themselves. A
 * vehicle written as its last four digits is one to match against these,
 * never one to add.
 */
function fleetOf(names: readonly (string | null | undefined)[], known: readonly FleetVehicleRef[] = []): FleetVehicleRef[] {
  const regs = new Set(known.map((v) => v.registrationNumber));
  for (const name of names) {
    const reg = name && WHOLE_REGISTRATION.test(name.trim()) ? parseRegistration(name) : null;
    if (reg) regs.add(reg);
  }
  return [...regs].map((r) => ({ id: r, registrationNumber: r }));
}

/** Every whole registration written in these messages. */
function registrationsIn(texts: readonly string[]): string[] {
  return texts.flatMap((text) => [...text.matchAll(REGISTRATION)].map((m) => m[0]));
}

/* ---------------------------------------------------------------- sources */

export function sourceFromArchive(archive: ChatArchive): IntakeSource {
  return {
    kind: 'export',
    via: archive.chatFileName.replace(/^WhatsApp Chat with /i, '').replace(/\.txt$/i, ''),
    messages: parseWhatsAppExport(archive.chatText).messages,
    media: archive.media,
  };
}

export function demoSource(): IntakeSource {
  return {
    kind: 'demo',
    via: WHATSAPP_DEMO.group,
    messages: parseWhatsAppExport(WHATSAPP_DEMO.chatText).messages,
    media: new Map(),
    slipTexts: WHATSAPP_DEMO.slips,
  };
}

/** Why the inbox could not be read. Worded by the screen. */
export class InboxUnavailable extends Error {
  constructor(
    readonly reason: 'sign-in' | 'status' | 'unreachable',
    readonly status: number | null = null,
  ) {
    super(reason);
  }
}

interface InboxRow {
  id: string;
  from_phone: string;
  sender_name: string | null;
  sent_at: string;
  kind: string;
  caption: string;
  media_url: string | null;
  media_mime: string | null;
  media_error: string | null;
}

/**
 * Photos sent to the WhatsApp Business number since the last import.
 *
 * The sender is the phone number, not the name a driver typed into their own
 * WhatsApp profile: the number is who they are, and matching by it is what
 * the claim reader trusts first.
 */
export async function fetchInboxSource(): Promise<IntakeSource> {
  let rows: InboxRow[];
  try {
    const res = await apiFetch('/whatsapp/inbox');
    if (!res.ok) throw res.status === 401 ? new InboxUnavailable('sign-in') : new InboxUnavailable('status', res.status);
    rows = (await res.json()) as InboxRow[];
  } catch (err) {
    if (err instanceof InboxUnavailable) throw err;
    throw new InboxUnavailable('unreachable');
  }
  const media = new Map<string, File>();
  const inboxIds = new Map<number, string>();
  const messages: ChatMessage[] = [];
  for (const [i, r] of rows.entries()) {
    const name = r.media_url ? `wa-${r.id}${r.media_mime === 'application/pdf' ? '.pdf' : '.jpg'}` : null;
    if (name && r.media_url) {
      const blob = await apiFetch(r.media_url).then((x) => (x.ok ? x.blob() : null));
      if (blob) media.set(name, new File([blob], name, { type: r.media_mime ?? blob.type }));
    }
    inboxIds.set(i + 1, r.id);
    messages.push({
      at: r.sent_at,
      sender: `+${r.from_phone}`,
      text: r.caption,
      attachments: name ? [name] : [],
      // A photo whose download failed at the webhook: it existed, but it is not here.
      mediaOmitted: !name && (r.kind === 'image' || r.kind === 'document'),
      line: i + 1,
    });
  }
  // The screen names the business number in the reader's language.
  return { kind: 'inbox', via: '', messages, media, inboxIds };
}

export async function markInboxImported(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await apiFetch('/whatsapp/inbox/imported', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

/* ---------------------------------------------------------------- reading */

/**
 * Every claim in the source, with its slip read. `notDrivers` are members who
 * are not reporting fills — the fleet manager, whose own reminders sit in the
 * same chat and whose name is also on the driver roster.
 */
export async function readIntake(
  source: IntakeSource,
  options: { notDrivers: string[]; rosters?: Rosters; onProgress?: (done: number, total: number) => void },
): Promise<IntakeClaim[]> {
  const live = options.rosters !== undefined;
  const rosters = options.rosters ?? DEMO_ROSTERS;
  // Live, a registration written in full is a vehicle, whether or not a bill has named it yet.
  const fleet = live ? fleetOf(registrationsIn(source.messages.map((m) => m.text)), rosters.fleet) : rosters.fleet;
  const claims = extractDieselClaims(
    { format: 'unknown', dateOrder: 'dmy', messages: source.messages, systemLines: 0 },
    { fleet, drivers: rosters.drivers, notDrivers: options.notDrivers, photoOnly: true },
  );
  const photoOf = (attachments: string[]) => attachments.map((a) => source.media.get(a)).find((f): f is File => f !== undefined) ?? null;
  const toRead = claims.filter((c) => {
    const photo = photoOf(c.attachments);
    return (photo && photo.type.startsWith('image/')) || c.attachments.some((a) => source.slipTexts?.[a] !== undefined);
  });

  const read = new Map<string, ReturnType<typeof slipFromCapture>>();
  let reader: Awaited<ReturnType<typeof openBillReader>> | null = null;
  try {
    for (const [i, c] of toRead.entries()) {
      options.onProgress?.(i, toRead.length);
      const stand = c.attachments.find((a) => source.slipTexts?.[a] !== undefined);
      if (stand) {
        read.set(c.key, slipFromCapture(stand, captureExpenseBill(source.slipTexts![stand]!), 'demo slip text'));
        continue;
      }
      const photo = photoOf(c.attachments)!;
      reader ??= await openBillReader();
      const ocr = await reader.read(photo);
      read.set(c.key, slipFromCapture(photo.name, captureExpenseBill(ocr.text, ocr.lineConfidence), ocr.engine));
    }
    options.onProgress?.(toRead.length, toRead.length);
  } finally {
    await reader?.close();
  }
  // And so is one read off a slip.
  const slipFleet = live ? fleetOf([...read.values()].map((r) => r.vehicle), fleet) : fleet;
  return claims.map((c) => {
    const claim = { ...reconcileWithSlip(c, read.get(c.key) ?? null, slipFleet), photo: photoOf(c.attachments) };
    // With no driver roster on the API, "not on the driver list" would be said of every slip.
    return live ? { ...claim, issues: claim.issues.filter((i) => i.code !== 'not-a-driver') } : claim;
  });
}

/** The bills already in Linck, as the import's duplicate checks need them. */
export function ledgerOf(bills: readonly ExpenseBill[]): LedgerBill[] {
  return bills.map((b) => ({
    id: b.id,
    claimKey: b.source?.claimKey ?? null,
    attachmentNames: b.source?.attachments ?? (b.attachment ? [b.attachment.fileName] : []),
    vendor: b.vendor,
    billNumber: b.billNumber,
    submittedAt: b.submittedAt,
  }));
}

export function planIntake(claims: IntakeClaim[], bills: readonly ExpenseBill[]): PlannedClaim<IntakeClaim>[] {
  return planDieselImport(claims, ledgerOf(bills));
}

/* ------------------------------------------------------------------ bills */

/** FNV-1a: a stable id from the claim key, so the same message always makes the same bill id. */
function stableId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Live, where the bill is booked and when it was read. There is no sample
 * vehicle to take either from: the vehicle is the registration the slip or
 * the message gave, and the scan goes up to the API on its own.
 */
export interface Booking {
  siteId: string;
  at: string;
}

export function billFromClaim(claim: IntakeClaim, source: IntakeSource, booking?: Booking): ExpenseBill {
  const vehicle = booking
    ? { id: claim.vehicleId!, registrationNumber: claim.vehicleId!, siteId: booking.siteId }
    : VEHICLES.find((v) => v.id === claim.vehicleId)!;
  const driver = booking ? undefined : DRIVERS.find((d) => d.id === claim.driverId);
  const date = claim.billDate ?? businessDate(claim.at);
  const slip = claim.slip;
  const field = (key: string, label: string, captured: string | null, value: string, confidence: 1 | 2 | 3 | null) => ({
    key,
    label,
    captured,
    confidence: captured === null ? null : confidence,
    value,
    overridden: false,
    overriddenBy: null,
  });
  return {
    id: `exp-wa-${stableId(claim.key)}`,
    desk: 'fleet',
    kind: 'diesel',
    billNumber: claim.billNumber ?? '',
    billDate: new Date(`${date}T00:00:00+05:30`).toISOString(),
    vehicleId: vehicle.id,
    // Who filled: the driver who sent it, when the number or name is on the
    // roster. Never the vehicle's rostered driver — that would be a guess.
    driverId: claim.driverId,
    vendor: claim.vendor ?? '',
    // Left blank: the screens show the type ("Diesel") in the reader's language.
    description: '',
    litres: claim.litres,
    amount: claim.amount!.toFixed(2),
    status: 'submitted',
    submittedBy: driver?.name ?? claim.sender,
    submittedById: driver ? `driver:${driver.id}` : `wa:${claim.sender}`,
    submittedAt: claim.at,
    siteId: vehicle.siteId,
    // Machine-read and not yet looked at by a person: validation confirms it.
    provenance: 'proposed',
    attachment:
      claim.photo && !booking
        ? { fileName: claim.photo.name, mimeType: claim.photo.type, sizeKb: Math.round(claim.photo.size / 1024), url: URL.createObjectURL(claim.photo) }
        : null,
    capture: {
      engine: slip ? `WhatsApp message + slip (${slip.engine})` : 'WhatsApp message',
      capturedAt: booking?.at ?? NOW.toISOString(),
      warnings: claim.issues,
      fields: [
        field('billNumber', 'Bill number', slip?.billNumber ?? null, claim.billNumber ?? '', 2),
        field('billDate', 'Bill date', slip?.billDate ?? null, date, 2),
        field('vendor', 'Vendor', slip?.vendor ?? null, claim.vendor ?? '', 2),
        field('vehicle', 'Vehicle', slip?.vehicle ?? claim.vehicleText, vehicle.registrationNumber, claim.vehicleMatch === 'registration' ? 3 : 2),
        field('litres', 'Litres', claim.litres === null ? null : String(claim.litres), claim.litres === null ? '' : String(claim.litres), claim.litresInferred ? 1 : 3),
        field('amount', 'Amount', String(claim.amount), claim.amount!.toFixed(2), claim.amountInferred ? 1 : claim.slip?.amount === claim.amount ? 3 : 2),
      ],
    },
    source: {
      channel: 'whatsapp',
      claimKey: claim.key,
      via: source.via,
      sender: claim.sender,
      postedAt: claim.at,
      message: claim.text,
      attachments: claim.attachments,
    },
  };
}

/** ClaimIn's limits (apps/api/app/schemas/whatsapp_imports.py), so one long message cannot stop an import. */
const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/**
 * Live: one claim as `POST /whatsapp/imports` takes it, from the bill
 * `billFromClaim` made of it and the id of its stored photo. The API raises
 * the bill as the number that sent it, and works out nothing else from it.
 */
export function importClaimBody(claim: IntakeClaim, bill: ExpenseBill, attachmentId: string | null): ImportClaimBody {
  return {
    claimKey: cut(claim.key, 1000),
    sender: cut(claim.sender, 120),
    postedAt: claim.at,
    message: cut(claim.text, 4000),
    attachments: claim.attachments.slice(0, 10).map((a) => cut(a, 200)),
    bill: {
      siteId: bill.siteId,
      vehicleId: bill.vehicleId!,
      driverId: bill.driverId,
      billNumber: cut(bill.billNumber, 60),
      billDate: businessDate(bill.billDate),
      vendor: cut(bill.vendor, 200),
      litres: bill.litres,
      amount: bill.amount,
      submittedBy: cut(bill.submittedBy, 120),
      submittedById: `wa:${cut(claim.sender, 120)}`,
      attachmentId,
      capture: bill.capture ? captureBody(bill.capture) : null,
    },
  };
}

/** Inbox ids of the messages behind a claim: its own and any caption folded into it. */
export function inboxIdsOf(claim: IntakeClaim, source: IntakeSource): string[] {
  if (!source.inboxIds) return [];
  return [claim.line, ...claim.mergedLines].map((l) => source.inboxIds!.get(l)).filter((id): id is string => id !== undefined);
}
