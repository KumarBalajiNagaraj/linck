import { describe, expect, it } from 'vitest';
import { VEHICLES, type ExpenseBill } from '@linck/mock';
import { spacedRegistration, vehicleRef } from './bills.js';
import { billFromClaim, importClaimBody, liveRosters, planIntake, readIntake, type IntakeSource } from './whatsappImport.js';

/*
 * Live, a WhatsApp slip is matched against this company's own vehicles —
 * the registrations its bills name, or the slip itself gives — and never
 * against the demo's sample fleet. (No OCR runs here: `slipTexts` stands in
 * for what a photo reads as, as the demo's own slips do.)
 */

const slip = (vehicle: string, litres: number, amount: string) =>
  [
    'SAKTHI FUELS',
    'IOCL Dealer, GST Road, Karapakkam',
    'CASH BILL',
    'Bill No: BK/50110        Date: 29/10/2026',
    `Vehicle No: ${vehicle}`,
    'Product: HSD (Diesel)',
    'Rate/Ltr: 95.55',
    `Volume: ${litres.toFixed(2)} L`,
    `Amount: Rs. ${amount}`,
  ].join('\n');

const source = (messages: { text: string; photo?: string }[], slips: Record<string, string> = {}): IntakeSource => ({
  kind: 'export',
  via: 'Drivers group',
  messages: messages.map((m, i) => ({
    at: `2026-10-30T0${4 + i}:10:00.000Z`,
    sender: `+9198765432${10 + i}`,
    text: m.text,
    attachments: m.photo ? [m.photo] : [],
    mediaOmitted: false,
    line: i + 1,
  })),
  media: new Map(),
  slipTexts: slips,
});

const bill = (vehicleId: string | null): ExpenseBill =>
  ({ id: `b-${vehicleId}`, vehicleId, desk: 'fleet', vendor: 'X', billNumber: '1', submittedAt: '2026-10-01T00:00:00Z', attachment: null }) as ExpenseBill;

describe('live WhatsApp slips', () => {
  it('knows the vehicles a company has billed, by registration only', () => {
    expect(liveRosters([bill('TN38AL1050'), bill('veh-001'), bill(null), bill('TN38AL1050')])).toEqual({
      fleet: [{ id: 'TN38AL1050', registrationNumber: 'TN38AL1050' }],
      drivers: [],
    });
  });

  it('takes a registration written in full as the vehicle, and is raised by the number that sent it', async () => {
    const src = source([{ text: 'TN 45 BX 2210 diesel 120 L Rs 11,466' }]);
    const [claim] = await readIntake(src, { notDrivers: ['Meena S'], rosters: liveRosters([]) });
    expect(claim).toMatchObject({ vehicleId: 'TN45BX2210', driverId: null, litres: 120, amount: 11466 });
    // There is no driver list on the API to be on.
    expect(claim!.issues.map((i) => i.code)).not.toContain('not-a-driver');
    expect(claim!.issues.map((i) => i.code)).not.toContain('vehicle-unmatched');
    expect(planIntake([claim!], [])[0]!.outcome).toBe('add');
  });

  it('reads the vehicle off a slip that came with no words', async () => {
    const src = source([{ text: '', photo: 'IMG-1.jpg' }], { 'IMG-1.jpg': slip('TN 29 AB 1001', 432, '41,277.60') });
    const [claim] = await readIntake(src, { notDrivers: [], rosters: liveRosters([]) });
    expect(claim).toMatchObject({ vehicleId: 'TN29AB1001', litres: 432, amount: 41277.6, billNumber: 'BK/50110' });
    expect(claim!.issues.map((i) => i.code)).not.toContain('slip-vehicle-unknown');
  });

  it('matches a vehicle written as its last four digits against the company\'s own, never the sample fleet', async () => {
    const sample = VEHICLES[0]!.registrationNumber;
    const four = sample.slice(-4);
    const fromSample = await readIntake(source([{ text: `${four} diesel 100 L Rs 9,555` }]), { notDrivers: [], rosters: liveRosters([]) });
    expect(fromSample[0]!.vehicleId).toBeNull();
    const own = await readIntake(source([{ text: '2210 diesel 100 L Rs 9,555' }]), { notDrivers: [], rosters: liveRosters([bill('TN45BX2210')]) });
    expect(own[0]!.vehicleId).toBe('TN45BX2210');
  });

  it('still matches the demo against its sample fleet and drivers, as before', async () => {
    const reg = VEHICLES[0]!.displayReg;
    const [claim] = await readIntake(source([{ text: `${reg} diesel 100 L Rs 9,555` }]), { notDrivers: [] });
    expect(claim!.vehicleId).toBe(VEHICLES[0]!.id);
  });

  it('sends a slip to the API booked to the site, raised by the sender, with what was read', async () => {
    const src = source([{ text: '', photo: 'IMG-1.jpg' }], { 'IMG-1.jpg': slip('TN 29 AB 1001', 432, '41,277.60') });
    const [claim] = await readIntake(src, { notDrivers: [], rosters: liveRosters([]) });
    const made = billFromClaim(claim!, src, { siteId: 'site-uuid', at: '2026-10-30T06:00:00.000Z' });
    const body = importClaimBody(claim!, made, 'scan-1');
    expect(body).toMatchObject({ claimKey: claim!.key, sender: '+919876543210', message: '', attachments: ['IMG-1.jpg'] });
    expect(body.bill).toMatchObject({
      siteId: 'site-uuid',
      vehicleId: 'TN29AB1001',
      driverId: null,
      billNumber: 'BK/50110',
      billDate: '2026-10-29',
      litres: 432,
      amount: '41277.60',
      submittedBy: '+919876543210',
      submittedById: 'wa:+919876543210',
      attachmentId: 'scan-1',
    });
    // The API credits corrections itself, and none has been made: the record is what was read.
    for (const f of body.bill.capture!.fields) expect(Object.keys(f).sort()).toEqual(['captured', 'confidence', 'key', 'label', 'value']);
    expect(body.bill.capture!.capturedAt).toBe('2026-10-30T06:00:00.000Z');
  });
});

describe('a vehicle typed in live mode', () => {
  it('is kept as its registration, and printed with its spaces', () => {
    expect(vehicleRef('tn 38 al 1050')).toBe('TN38AL1050');
    expect(vehicleRef('TN-38-AL-1050')).toBe('TN38AL1050');
    expect(spacedRegistration('TN38AL1050')).toBe('TN 38 AL 1050');
  });

  it('keeps a machine with no registration as typed, and a blank as none', () => {
    expect(vehicleRef('JCB 3DX-2')).toBe('JCB3DX2');
    expect(spacedRegistration('JCB3DX2')).toBe('JCB3DX2');
    expect(vehicleRef('   ')).toBeNull();
  });
});
