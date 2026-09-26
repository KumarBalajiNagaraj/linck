import {
  captureExpenseBill,
  DIESEL_RATE_BAND,
  extractDieselClaims,
  parseWhatsAppExport,
  type ChatExport,
  type DieselClaim,
} from '@linck/domain';
import { DRIVERS, VEHICLES } from '@linck/mock';
import { openBillReader } from './ocr.js';
import type { ChatArchive } from './whatsappArchive.js';

/**
 * WhatsApp export → diesel claims, with the slip photos read.
 *
 * The driver's message is the claim; the bunk slip in the photo is the
 * evidence. Where both give a figure they are compared, and a disagreement is
 * put in front of the fleet manager — that comparison is the whole point of
 * reading the photo. Where the message is silent the slip fills the gap, and
 * says it did.
 */

export interface SlipReading {
  fileName: string;
  litres: number | null;
  amount: number | null;
  billNumber: string | null;
  /** Compact registration, as read. */
  vehicle: string | null;
  warnings: string[];
  engine: string;
}

export interface ImportedClaim extends DieselClaim {
  /** The first attached photo found in the archive, if any. */
  photo: File | null;
  slip: SlipReading | null;
  /** Figures the message did not state and the slip supplied. */
  filledFromSlip: ('litres' | 'amount' | 'vehicle')[];
}

export interface ImportResult {
  chat: ChatExport;
  claims: ImportedClaim[];
  /** Photos the chat refers to that were not in the files given. */
  missingPhotos: number;
}

const FLEET = VEHICLES.map((v) => ({ id: v.id, registrationNumber: v.registrationNumber }));
const ROSTER = DRIVERS.map((d) => ({ id: d.id, name: d.name, phone: d.phone }));

/** Figures within this of each other are the same reading. */
const LITRE_SLACK = 0.5;
const RUPEE_SLACK = 1;

export async function importDieselClaims(
  archive: ChatArchive,
  options: { readSlips?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ImportResult> {
  const chat = parseWhatsAppExport(archive.chatText);
  const claims: ImportedClaim[] = extractDieselClaims(chat, { fleet: FLEET, drivers: ROSTER }).map((c) => ({
    ...c,
    photo: c.attachments.map((a) => archive.media.get(a)).find((f): f is File => f !== undefined) ?? null,
    slip: null,
    filledFromSlip: [],
  }));
  const missingPhotos = claims.filter((c) => c.attachments.length > 0 && c.photo === null).length;

  const withPhotos = claims.filter((c) => c.photo && c.photo.type.startsWith('image/'));
  if (options.readSlips !== false && withPhotos.length > 0) {
    const reader = await openBillReader();
    try {
      let done = 0;
      for (const claim of withPhotos) {
        options.onProgress?.(done, withPhotos.length);
        const ocr = await reader.read(claim.photo!);
        const cap = captureExpenseBill(ocr.text, ocr.lineConfidence);
        claim.slip = {
          fileName: claim.photo!.name,
          litres: cap.fields.litres ? Number(cap.fields.litres.value) : null,
          amount: cap.fields.amount ? Number(cap.fields.amount.value) : null,
          billNumber: cap.fields.billNumber?.value ?? null,
          vehicle: cap.fields.vehicle?.value ?? null,
          warnings: cap.warnings,
          engine: ocr.engine,
        };
        reconcile(claim);
        done += 1;
      }
      options.onProgress?.(done, withPhotos.length);
    } finally {
      await reader.close();
    }
  }
  return { chat, claims, missingPhotos };
}

/** Message against slip: compare where both speak, fill where only the slip does. */
export function reconcile(claim: ImportedClaim): void {
  const slip = claim.slip;
  if (!slip) return;
  if (slip.litres !== null) {
    if (claim.litres === null) {
      claim.litres = slip.litres;
      claim.filledFromSlip.push('litres');
    } else if (Math.abs(claim.litres - slip.litres) > LITRE_SLACK) {
      claim.issues.unshift(`The message says ${claim.litres} L but the slip reads ${slip.litres} L.`);
    }
  }
  if (slip.amount !== null) {
    if (claim.amount === null) {
      claim.amount = slip.amount;
      claim.filledFromSlip.push('amount');
    } else if (Math.abs(claim.amount - slip.amount) > RUPEE_SLACK) {
      claim.issues.unshift(`The message says ₹${claim.amount} but the slip reads ₹${slip.amount}.`);
    }
  }
  if (slip.vehicle !== null) {
    const onSlip = FLEET.find((v) => v.registrationNumber === slip.vehicle);
    if (claim.vehicleId === null && onSlip) {
      claim.vehicleId = onSlip.id;
      claim.vehicleMatch = 'registration';
      claim.filledFromSlip.push('vehicle');
    } else if (claim.vehicleId !== null && onSlip && onSlip.id !== claim.vehicleId) {
      claim.issues.unshift(`The message is about one vehicle but the slip names ${slip.vehicle}.`);
    }
  }
  if (claim.filledFromSlip.length > 0) {
    // What was missing is now filled — drop the "not stated" notes it answers,
    // and say where the figure came from instead.
    claim.issues = claim.issues.filter(
      (i) =>
        !(claim.filledFromSlip.includes('litres') && i.startsWith('No litres')) &&
        !(claim.filledFromSlip.includes('amount') && i.startsWith('No amount')) &&
        !(claim.filledFromSlip.includes('vehicle') && (i.startsWith('No vehicle') || i.includes('does not match exactly one vehicle'))),
    );
    claim.issues.push(`${claim.filledFromSlip.join(' and ')} read from the slip photo — check against it.`);
  }
  // A stated rate stands; a derived one is re-derived from the reconciled figures.
  if (claim.litres && claim.amount && (claim.ratePerLitre === null || claim.rateDerived)) {
    claim.ratePerLitre = Math.round((claim.amount / claim.litres) * 100) / 100;
    claim.rateDerived = true;
    const outOfBand = claim.ratePerLitre < DIESEL_RATE_BAND.min || claim.ratePerLitre > DIESEL_RATE_BAND.max;
    if (outOfBand && !claim.issues.some((i) => i.startsWith('Works out at'))) {
      claim.issues.unshift(
        `Works out at ₹${claim.ratePerLitre.toFixed(2)} a litre, outside ₹${DIESEL_RATE_BAND.min}–${DIESEL_RATE_BAND.max} — a litre or rupee figure is probably wrong.`,
      );
    }
  }
}
