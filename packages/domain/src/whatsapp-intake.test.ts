import { describe, expect, it } from 'vitest';
import { DRIVERS, VEHICLES, WHATSAPP_DEMO } from '../../mock/src/index.js';
import { captureExpenseBill } from './bill-capture.js';
import { extractDieselClaims, parseWhatsAppExport, planDieselImport, reconcileWithSlip, slipFromCapture } from './whatsapp.js';

/*
 * The whole intake, end to end, on the demo chat: most drivers send only the
 * slip photo, and every bill below comes from reading it.
 */
const fleet = VEHICLES.map((v) => ({ id: v.id, registrationNumber: v.registrationNumber }));
const roster = DRIVERS.map((d) => ({ id: d.id, name: d.name, phone: d.phone }));

function runDemo() {
  const chat = parseWhatsAppExport(WHATSAPP_DEMO.chatText);
  const claims = extractDieselClaims(chat, { fleet, drivers: roster, notDrivers: [WHATSAPP_DEMO.importer], photoOnly: true });
  const reconciled = claims.map((c) => {
    const file = c.attachments.find((a) => WHATSAPP_DEMO.slips[a] !== undefined);
    const slip = file ? slipFromCapture(file, captureExpenseBill(WHATSAPP_DEMO.slips[file]!), 'demo') : null;
    return reconcileWithSlip(c, slip, fleet);
  });
  return planDieselImport(reconciled, []);
}

describe('diesel slips from WhatsApp, end to end', () => {
  const plan = runDemo();
  const byFile = (file: string) => plan.find((p) => p.claim.attachments.includes(file) && p.outcome !== 'repeat')!;

  it('makes a bill from a photo with no words at all', () => {
    const p = byFile('IMG-20260806-WA0012.jpg');
    expect(p.outcome).toBe('add');
    expect(p.claim).toMatchObject({ litres: 432, amount: 41277.6, vehicleId: VEHICLES[0]!.id, driverId: DRIVERS[0]!.id, billNumber: 'BK/48213' });
    expect(p.claim.vendor).toBe('SAKTHI FUELS');
    expect(p.claim.filledFromSlip).toEqual(['litres', 'amount', 'vehicle']);
  });

  it('knows an unsaved number by the driver\'s phone', () => {
    expect(byFile('IMG-20260806-WA0021.jpg').claim.driverId).toBe(DRIVERS[2]!.id);
  });

  it('puts a message that disagrees with its slip in front of the fleet manager', () => {
    const p = byFile('IMG-20260806-WA0033.jpg');
    expect(p.claim.issues[0]).toMatch(/message says ₹25440 but the slip reads ₹23887.5 — the slip's figure is used/);
    expect(p.claim.amount).toBe(23887.5);
  });

  it('drops the "check the unlabelled numbers" note once the slip bears them out', () => {
    const p = byFile('IMG-20260806-WA0027.jpg');
    expect(p.claim).toMatchObject({ amount: 17199, amountInferred: false });
    expect(p.claim.issues).toEqual([]);
  });

  it('adds the same photo once', () => {
    expect(plan.filter((p) => p.claim.attachments.includes('IMG-20260806-WA0012.jpg')).map((p) => p.outcome)).toEqual(['add', 'repeat']);
  });

  it('holds a slip it cannot read, and says so', () => {
    const p = byFile('IMG-20260807-WA0040.jpg');
    expect(p.outcome).toBe('needs_details');
    expect(p.claim.issues.join(' ')).toMatch(/could not be read/);
    expect(p.claim.vendor).toBeNull();
  });

  it('never makes a bill of a reminder or a chat line', () => {
    const texts = plan.filter((p) => p.claim.attachments.length === 0).map((p) => [p.claim.text, p.outcome]);
    expect(texts).toEqual([
      ['Diesel bills without photo will not be paid. Send the slip photo every time.', 'no_fill'],
      ['Sir diesel filled', 'no_fill'],
    ]);
  });

  it('adds eight bills from ten photos: one is a repeat, one cannot be read', () => {
    expect(plan.filter((p) => p.outcome === 'add')).toHaveLength(8);
    // The number not on the roster still gets its bill; who sent it is for the fleet manager to settle.
    expect(byFile('IMG-20260807-WA0047.jpg')).toMatchObject({ outcome: 'add' });
    expect(byFile('IMG-20260807-WA0047.jpg').claim.issues.join(' ')).toMatch(/not a driver on the roster/);
    expect(plan.filter((p) => p.claim.attachments.length > 0)).toHaveLength(10);
  });
});
