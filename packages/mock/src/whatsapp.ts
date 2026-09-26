import { DRIVERS, VEHICLES } from './data.js';

/**
 * TWO DAYS OF DIESEL SLIPS ON WHATSAPP, for trying the import without a phone.
 *
 * Most drivers cannot read or write, so most of what arrives is a photo of
 * the bunk's slip and nothing else. A few type a line; one posts the same
 * photo twice; one slip is too blurred to read; one number is not on the
 * roster; the fleet manager's own reminder is in there too. Every rule the
 * import applies meets at least one message here.
 *
 * Built from the seeded roster and fleet, so every driver, phone and
 * registration is a real row. `slips` stands in for the photos: the text an
 * OCR pass returns for each, keyed by the file name the chat refers to.
 */

const driver = (n: number) => DRIVERS[n - 1]!;
const vehicleOf = (n: number) => VEHICLES.find((v) => v.driverId === driver(n).id)!;
const lastFour = (n: number) => vehicleOf(n).registrationNumber.slice(-4);
/** How WhatsApp shows a number that is not saved in the exporting phone. */
const unsaved = (phone: string) => `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`;
const rupees = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Bunk {
  name: string;
  lines: string[];
  prefix: string;
}

const SAKTHI: Bunk = { name: 'SAKTHI FUELS', lines: ['IOCL Dealer, GST Road, Karapakkam', 'GSTIN: 33ABCDE1234F1Z5'], prefix: 'BK' };
const BALAJI: Bunk = { name: 'BALAJI FUEL POINT', lines: ['HP Dealer, Tiruvallur High Road', 'GSTIN: 33AAHFB5521K1Z2'], prefix: 'HPB' };
const MURUGAN: Bunk = { name: 'SRI MURUGAN FUELS', lines: ['BPCL Dealer, Sriperumbudur', 'GSTIN: 33AAGFS7741M1ZQ'], prefix: 'SMF' };

function slip(bunk: Bunk, no: number, date: string, vehicle: number | string, rate: number, litres: number): string {
  const reg = typeof vehicle === 'number' ? vehicleOf(vehicle).displayReg : vehicle;
  return [
    bunk.name,
    ...bunk.lines,
    'CASH BILL',
    `Bill No: ${bunk.prefix}/${no}        Date: ${date}`,
    `Vehicle No: ${reg}`,
    'Product: HSD (Diesel)',
    `Rate/Ltr: ${rate.toFixed(2)}`,
    `Volume: ${litres.toFixed(2)} L`,
    `Amount: Rs. ${rupees(Math.round(litres * rate * 100) / 100)}`,
  ].join('\n');
}

const photo = (file: string) => `${file} (file attached)`;
const at = (date: string, time: string, who: string, body: string) => `${date}, ${time} - ${who}: ${body}`;

const FLEET_MANAGER = 'Anbu Selvan M';

const lines = [
  '06/08/26, 6:30 am - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
  `06/08/26, 6:31 am - ${FLEET_MANAGER} added ${driver(7).name}`,
  at('06/08/26', '7:42 am', driver(1).name, photo('IMG-20260806-WA0012.jpg')),
  at('06/08/26', '8:05 am', driver(2).name, photo('IMG-20260806-WA0015.jpg')),
  at('06/08/26', '9:10 am', unsaved(driver(3).phone), photo('IMG-20260806-WA0021.jpg')),
  at('06/08/26', '11:20 am', FLEET_MANAGER, 'Diesel bills without photo will not be paid. Send the slip photo every time.'),
  at('06/08/26', '1:02 pm', driver(4).name, `${photo('IMG-20260806-WA0027.jpg')}\n${lastFour(4)} diesel 180 ltr 17199`),
  at('06/08/26', '4:45 pm', driver(6).name, `${photo('IMG-20260806-WA0033.jpg')}\ndiesel ${lastFour(6)} 250 lt Rs 25,440`),
  at('07/08/26', '7:15 am', driver(1).name, photo('IMG-20260806-WA0012.jpg')),
  at('07/08/26', '8:30 am', driver(7).name, photo('IMG-20260807-WA0040.jpg')),
  at('07/08/26', '2:20 pm', '+91 98410 22871', photo('IMG-20260807-WA0047.jpg')),
  at('07/08/26', '6:40 pm', driver(9).name, photo('IMG-20260807-WA0052.jpg')),
  at('08/08/26', '9:30 am', driver(11).name, photo('IMG-20260808-WA0058.jpg')),
  at('08/08/26', '12:55 pm', driver(2).name, 'Sir diesel filled'),
];

export const WHATSAPP_DEMO = {
  fileName: 'WhatsApp Chat with KBM Drivers - Diesel.txt',
  group: 'KBM Drivers - Diesel',
  /** The fleet manager exports the chat, and is in it: never read as a driver. */
  importer: FLEET_MANAGER,
  chatText: lines.join('\n'),
  slips: {
    'IMG-20260806-WA0012.jpg': slip(SAKTHI, 48213, '06/08/2026', 1, 95.55, 432),
    'IMG-20260806-WA0015.jpg': slip(BALAJI, 60433, '06/08/2026', 2, 95.62, 310),
    'IMG-20260806-WA0021.jpg': slip(SAKTHI, 48230, '06/08/2026', 3, 95.55, 200),
    'IMG-20260806-WA0027.jpg': slip(SAKTHI, 48251, '06/08/2026', 4, 95.55, 180),
    // The driver wrote Rs 25,440; the bunk charged for 250 L at 95.55.
    'IMG-20260806-WA0033.jpg': slip(MURUGAN, 7712, '06/08/2026', 6, 95.55, 250),
    // Photographed at an angle in the cab: nothing on it reads.
    'IMG-20260807-WA0040.jpg': 'S A K T H I   F U E\n8i11 N0 :  8K/4S2l3\nV0lume :  l5O.O\nAm0unt : R5. l4,3?2',
    'IMG-20260807-WA0047.jpg': slip(BALAJI, 60488, '07/08/2026', vehicleOf(12).displayReg, 95.5, 300),
    'IMG-20260807-WA0052.jpg': slip(BALAJI, 60502, '07/08/2026', 9, 95.5, 220),
    'IMG-20260808-WA0058.jpg': slip(SAKTHI, 48344, '08/08/2026', 11, 95.55, 205),
  } as Record<string, string>,
};
