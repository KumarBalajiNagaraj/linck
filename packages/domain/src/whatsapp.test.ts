import { describe, expect, it } from 'vitest';
import { extractDieselClaims, matchDriver, matchVehicle, parseWhatsAppExport, summarizeDiesel } from './whatsapp.js';

const FLEET = [
  { id: 'veh-001', registrationNumber: 'TN29AB1001' },
  { id: 'veh-002', registrationNumber: 'TN38AB1008' },
  { id: 'veh-003', registrationNumber: 'TN20AB1015' },
  { id: 'veh-004', registrationNumber: 'TN12AB1022' },
  // Two vehicles ending 1050: a bare "1050" must not pick either.
  { id: 'veh-005', registrationNumber: 'TN38AL1050' },
  { id: 'veh-006', registrationNumber: 'TN29BX1050' },
];

const DRIVERS = [
  { id: 'drv-001', name: 'Murugan S', phone: '9840012345' },
  { id: 'drv-002', name: 'Ravi Kumar A', phone: '9790054321' },
  { id: 'drv-003', name: 'Selvam P', phone: '9003311223' },
];

/* An Android export, 12-hour clock, media included, Indian day-first dates. */
const ANDROID = `06/08/26, 6:58 am - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
06/08/26, 7:02 am - Anbu Selvan M added Selvam P
06/08/26, 7:42 am - Murugan S: IMG-20260806-WA0012.jpg (file attached)
1001 diesel 432 ltr Rs 41,277
06/08/26, 7:43 am - Murugan S: km 218460
06/08/26, 9:15 am - +91 97900 54321: TN 38 AB 1008 டீசல் 210 லி 20,066 ரூ
06/08/26, 1:05 pm - Selvam P: 1015 filled 150 14325
06/08/26, 4:40 pm - Anbu Selvan M: All drivers send bills before 6pm
07/08/26, 10:12 am - Murugan S: IMG-20260806-WA0012.jpg (file attached)
1001 diesel 432 ltr Rs 41,277
07/08/26, 11:30 am - Selvam P: 1050 diesel 200 ltr rs 19000
07/08/26, 12:10 pm - Unknown Person: diesel 100 ltr 30000`;

/* An iOS export: bracketed stamps, seconds, direction marks, <attached:>. */
const IOS = `[13/08/2026, 7:42:10 PM] Murugan S: ‎<attached: 00000012-PHOTO-2026-08-13-19-42-10.jpg>
[13/08/2026, 7:42:31 PM] Murugan S: TN29AB1001 fuel 300L @95.40
[13/08/2026, 9:01:05 PM] Ravi Kumar A: going home`;

describe('parseWhatsAppExport', () => {
  const chat = parseWhatsAppExport(ANDROID);

  it('reads an Android export and skips group notices', () => {
    expect(chat.format).toBe('android');
    expect(chat.systemLines).toBe(2);
    expect(chat.messages[0]!.sender).toBe('Murugan S');
  });

  it('joins continuation lines and lifts attachments out of the text', () => {
    const first = chat.messages[0]!;
    expect(first.attachments).toEqual(['IMG-20260806-WA0012.jpg']);
    expect(first.text).toBe('1001 diesel 432 ltr Rs 41,277');
  });

  it('reads the phone clock as IST and stores UTC', () => {
    // 06-08-2026 07:42 IST is 02:12 UTC.
    expect(chat.messages[0]!.at).toBe('2026-08-06T02:12:00.000Z');
    // 1:05 pm is 13:05, not 01:05.
    expect(chat.messages.find((m) => m.sender === 'Selvam P')!.at).toBe('2026-08-06T07:35:00.000Z');
  });

  it('reads an iOS export with seconds, brackets and direction marks', () => {
    const ios = parseWhatsAppExport(IOS);
    expect(ios.format).toBe('ios');
    expect(ios.messages).toHaveLength(3);
    expect(ios.messages[0]!.attachments).toEqual(['00000012-PHOTO-2026-08-13-19-42-10.jpg']);
    expect(ios.messages[0]!.at).toBe('2026-08-13T14:12:10.000Z');
  });

  it('decides day- or month-first from the whole file', () => {
    const us = parseWhatsAppExport('8/13/26, 19:40 - Murugan S: diesel 100 ltr\n8/06/26, 07:00 - Murugan S: hi');
    expect(us.dateOrder).toBe('mdy');
    expect(us.messages[0]!.at.slice(0, 10)).toBe('2026-08-13');
    expect(parseWhatsAppExport(ANDROID).dateOrder).toBe('dmy');
  });

  it('notices an export made without media', () => {
    const noMedia = parseWhatsAppExport('06/08/26, 7:42 am - Murugan S: <Media omitted>\n06/08/26, 7:43 am - Murugan S: 1001 diesel 200 ltr');
    expect(noMedia.messages[0]!.mediaOmitted).toBe(true);
    expect(noMedia.messages[0]!.text).toBe('');
  });
});

describe('matching', () => {
  it('matches a driver by saved name, by phone, or by a name that contains theirs', () => {
    expect(matchDriver('Murugan S', DRIVERS)).toEqual({ driverId: 'drv-001', how: 'name' });
    expect(matchDriver('+91 97900 54321', DRIVERS)).toEqual({ driverId: 'drv-002', how: 'phone' });
    expect(matchDriver('Selvam P Driver TVL', DRIVERS)).toEqual({ driverId: 'drv-003', how: 'name' });
    expect(matchDriver('Unknown Person', DRIVERS).driverId).toBeNull();
  });

  it('matches a vehicle by registration, or by a unique last four digits', () => {
    expect(matchVehicle('TN 29 AB 1001 diesel', FLEET).vehicleId).toBe('veh-001');
    expect(matchVehicle('1015 filled', FLEET)).toMatchObject({ vehicleId: 'veh-003', how: 'last_four' });
    expect(matchVehicle('1050 diesel', FLEET)).toMatchObject({ vehicleId: null, vehicleText: '1050' });
  });
});

describe('extractDieselClaims', () => {
  const claims = extractDieselClaims(parseWhatsAppExport(ANDROID), { fleet: FLEET, drivers: DRIVERS });

  it('turns only diesel messages into claims', () => {
    // Not the encryption banner, not "km 218460" on its own, not the manager's reminder.
    expect(claims.map((c) => c.line)).toEqual([3, 6, 7, 9, 11, 12]);
  });

  it('reads a labelled claim completely', () => {
    const c = claims[0]!;
    expect(c).toMatchObject({ litres: 432, amount: 41277, vehicleId: 'veh-001', driverId: 'drv-001', litresInferred: false, amountInferred: false });
    expect(c.ratePerLitre).toBeCloseTo(95.55, 2);
    expect(c.rateDerived).toBe(true);
  });

  it('reads Tamil, a phone-number sender and rupees written after the number', () => {
    const c = claims[1]!;
    expect(c).toMatchObject({ litres: 210, amount: 20066, vehicleId: 'veh-002', driverId: 'drv-002', driverMatch: 'phone' });
  });

  it('reads an unlabelled pair only because it makes a diesel price, and says so', () => {
    const c = claims[2]!;
    expect(c).toMatchObject({ litres: 150, amount: 14325, litresInferred: true, amountInferred: true, vehicleId: 'veh-003' });
    expect(c.issues.join(' ')).toMatch(/unlabelled numbers/);
    expect(c.issues).toContain('No bill photo posted with it.');
  });

  it('flags the same slip posted again, and keeps it', () => {
    const repeat = claims[3]!;
    expect(repeat.duplicateOf).toBe(claims[0]!.key);
    expect(repeat.issues[0]).toMatch(/repeat of the message on line 3/);
  });

  it('does not pick one of two vehicles that share the last four digits', () => {
    const c = claims[4]!;
    expect(c.vehicleId).toBeNull();
    expect(c.issues.join(' ')).toMatch(/"1050" does not match exactly one vehicle/);
  });

  it('will not read a number as rupees when it makes no diesel price, and says why', () => {
    const c = claims[5]!;
    expect(c.litres).toBe(100);
    expect(c.amount).toBeNull();
    expect(c.issues.join(' ')).toMatch(/30000 is written but was not read as rupees — with 100 litres it would be ₹300.00 a litre/);
    expect(c.driverId).toBeNull();
  });

  it('flags a labelled price no bunk charges', () => {
    const [c] = extractDieselClaims(parseWhatsAppExport('06/08/26, 7:42 am - Murugan S: 1001 diesel 100 ltr rs 30000'), { fleet: FLEET, drivers: DRIVERS });
    expect(c!.ratePerLitre).toBe(300);
    expect(c!.issues.join(' ')).toMatch(/outside ₹80–120/);
  });

  it('never invents a figure the message does not contain', () => {
    const chat = parseWhatsAppExport('06/08/26, 7:42 am - Murugan S: 1001 diesel filled');
    const [c] = extractDieselClaims(chat, { fleet: FLEET, drivers: DRIVERS });
    expect(c).toMatchObject({ litres: null, amount: null, ratePerLitre: null, vehicleId: 'veh-001' });
  });

  it('keeps a stable key so a re-imported export is recognised', () => {
    const again = extractDieselClaims(parseWhatsAppExport(ANDROID), { fleet: FLEET, drivers: DRIVERS });
    expect(again.map((c) => c.key)).toEqual(claims.map((c) => c.key));
  });

  it('reads an iOS claim with a stated rate', () => {
    const [c] = extractDieselClaims(parseWhatsAppExport(IOS), { fleet: FLEET, drivers: DRIVERS });
    expect(c).toMatchObject({ litres: 300, ratePerLitre: 95.4, rateDerived: false, vehicleId: 'veh-001', amount: null });
  });
});

describe('summarizeDiesel', () => {
  it('totals litres and rupees per key, largest spend first', () => {
    const rows = [
      { v: 'a', litres: 100, amount: 9500 },
      { v: 'b', litres: 50, amount: 4800 },
      { v: 'a', litres: 20.5, amount: 1950.25 },
      { v: null, litres: 5, amount: 400 },
    ];
    expect(summarizeDiesel(rows, (r) => r.v)).toEqual([
      { key: 'a', fills: 2, litres: 120.5, amount: 11450.25 },
      { key: 'b', fills: 1, litres: 50, amount: 4800 },
    ]);
  });
});
