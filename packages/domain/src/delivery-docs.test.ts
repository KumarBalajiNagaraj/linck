import { describe, expect, it } from 'vitest';
import {
  classifyDeliveryDocument,
  crossCheckDeliveryDocuments,
  extractDeliveryDocument,
  materialParts,
  normalizeAmount,
  normalizeDate,
  normalizeMaterial,
  normalizeVehicle,
  paperName,
  UNCLEAR,
  type ComparedField,
  type CrossCheckResult,
  type FieldFinding,
} from './delivery-docs.js';

/*
 * The three papers from one real load, as OCR returns them: a crusher's
 * printed DC, a transporter's handwritten received challan, and a builder's
 * handwritten delivery memo. Three layouts, three vocabularies.
 */
const DC = `OM SAKTHI ENTERPRISES
GSTIN/UIN #: 33AAFFO0815G1ZL
Delivery Challan
Date: 13-03-2026 09:47 am
DC/Ref #: 6630
OUTGOING TRIP
Party: NEW RAJ AGENCIES
Loading: OMS CRUSHER
UnLoading: PARTY SITE
Transport:
Truck #: TN 22 EH 9857
Item: VSI 12 MM
HSN/SAC: 0
Empty Qty: 17.35 MT
Full Qty: 68.10 MT
Net Qty: 50.75 MT
Payment Mode Credit`;

const RECEIVED = `NEW RAJ AGENCIES
(Building Material Suppliers)
MATERIAL RECEIVED CHALLAN
No. 013 Date: 13.3.26
Vehicle No. TN22EH9857
Party: GMS - Muthukadu
Place:
Material: 12 MM Jelly
In time........Out time........
Measurement
Load Wt 50 Empty Wt
Net Wt 50.75 MT
Customer Signature Driver Signature`;

const MEMO = `GMS ELEGANT BUILDERS (I) PVT LTD, ERODE
DELIVERY MEMO FOR BULK MATERIALS
No. 1648
Project Site: MCC
P.O. No. 9784, 9785, 9786
Date: 13.3.26
Supplier: JSR Blue Metal
Lorry No. TN 22 EH 9857
Description: 12 MM Jelly
UOM MT
Quantity Recd: 50.75 MT
Location of Unloading: RMC Plant`;

/** The same load with every paper in order: the chain of parties closes and the weights add up. */
const CLEAN_RECEIVED = `NEW RAJ AGENCIES
MATERIAL RECEIVED CHALLAN
No. 013 Date: 13.3.26
Vehicle No. TN22EH9857
Party: GMS - Muthukadu
Material: 12 MM Jelly
Load Wt 68.10 Empty Wt 17.35
Net Wt 50.75 MT`;

const CLEAN_MEMO = MEMO.replace('Supplier: JSR Blue Metal', 'Supplier: New Raj Agencies');

const status = (r: CrossCheckResult, field: ComparedField) => r.comparisons.find((c) => c.field === field)!.status;
const finding = (r: CrossCheckResult, field: ComparedField) => r.comparisons.find((c) => c.field === field)!.finding;
const check = (...texts: string[]) => crossCheckDeliveryDocuments(texts.map((text, i) => ({ id: `p${i}`, text })));
/** The values a finding quotes, as compared, in paper order. */
const quoted = (f: FieldFinding | null | undefined) => (f && 'values' in f ? f.values.map((v) => v.value.normalized) : []);

describe('classification', () => {
  it('tells the three papers apart by their own words, not their layout', () => {
    expect(classifyDeliveryDocument(DC).type).toBe('delivery_challan');
    expect(classifyDeliveryDocument(RECEIVED).type).toBe('material_received');
    expect(classifyDeliveryDocument(MEMO).type).toBe('delivery_memo');
    expect(classifyDeliveryDocument(DC).confidence).toBe(3);
  });

  it('refuses to guess when the text says nothing', () => {
    const blank = classifyDeliveryDocument('Thank you for your business');
    expect(blank.type).toBe('unknown');
    expect(blank.note).toEqual({ code: 'no-delivery-words' });
    expect(classifyDeliveryDocument(DC).note).toBeNull();
  });

  it('needs more than one stray word, and knows other papers when it sees them', () => {
    // GSTIN alone once made a tax invoice a DC "at 100%".
    const invoice = classifyDeliveryDocument('ANNAI TYRES\nGSTIN: 33AAACA1234B1Z5\nTAX INVOICE\nTyre 10.00-20');
    expect(invoice.type).toBe('unknown');
    expect(invoice.note).toEqual({ code: 'other-paper', paper: 'tax-invoice' });
    const slip = classifyDeliveryDocument('WEIGHMENT SLIP\nGross Wt: 68.10\nTare Wt: 17.35');
    expect(slip.type).toBe('unknown');
    expect(slip.note).toEqual({ code: 'other-paper', paper: 'weighbridge-slip' });
    expect(classifyDeliveryDocument('SRI MURUGAN FUELS\nCASH MEMO\nHSD 120 L').type).toBe('unknown');
    const stray = classifyDeliveryDocument('Printed by GSTIN portal');
    expect(stray.type).toBe('unknown');
    expect(stray.note).toEqual({ code: 'weak', type: 'delivery_challan', evidence: ['GSTIN'] });
  });
});

describe('normalization', () => {
  it('reads a registration however it is spaced', () => {
    expect(normalizeVehicle('TN 22 EH 9857').normalized).toBe('TN22EH9857');
    expect(normalizeVehicle('tn-22-eh-9857').normalized).toBe('TN22EH9857');
    expect(normalizeVehicle('TN22EH9857').normalized).toBe('TN22EH9857');
  });

  it('marks what cannot be read as UNCLEAR and keeps the raw text', () => {
    const v = normalizeVehicle('TN 22 E? 98');
    expect(v.normalized).toBe(UNCLEAR);
    expect(v.raw).toBe('TN 22 E? 98');
    expect(v.note).toEqual({ code: 'marked-unreadable' });
    expect(normalizeDate('3?.3.26').normalized).toBe(UNCLEAR);
    expect(normalizeVehicle('TN 22 EH 9857 / TN 22 EH 9587').note).toEqual({ code: 'two-registrations', found: ['TN22EH9857', 'TN22EH9587'] });
  });

  it('reads day-first dates in the forms Indian paper uses', () => {
    expect(normalizeDate('13.3.26').normalized).toBe('2026-03-13');
    expect(normalizeDate('13-03-2026 09:47 am').normalized).toBe('2026-03-13');
    expect(normalizeDate('13 Mar 2026').normalized).toBe('2026-03-13');
    expect(normalizeDate('31.02.26').normalized).toBe(UNCLEAR);
    expect(normalizeDate('31.02.26').note).toEqual({ code: 'no-such-date' });
  });

  it('reads full month names, and refuses a year with a digit missing', () => {
    expect(normalizeDate('13 March 2026').normalized).toBe('2026-03-13');
    expect(normalizeDate('13 June 2026').normalized).toBe('2026-06-13');
    expect(normalizeDate('13th January 2026').normalized).toBe('2026-01-13');
    expect(normalizeDate('13-Sept-26').normalized).toBe('2026-09-13');
    expect(normalizeDate('13.03.202').normalized).toBe(UNCLEAR);
  });

  it('brings weights to tonnes and leaves volumes alone', () => {
    expect(normalizeAmount('50.75 MT').amount).toBe(50.75);
    expect(normalizeAmount('50,750 kg').amount).toBe(50.75);
    expect(normalizeAmount('50,750.00 Kg').amount).toBe(50.75);
    expect(normalizeAmount('1,234.5 kg').amount).toBe(1.235);
    expect(normalizeAmount('50,75 MT').amount).toBe(50.75);
    expect(normalizeAmount('1.68 CFT').unit).toBe('CFT');
    expect(normalizeAmount('2 Units').unit).toBe('UNIT');
  });

  it('says what it assumed for a bare number, and takes the paper unit as written', () => {
    const bare = normalizeAmount('50');
    expect(bare.unit).toBe('MT');
    expect(bare.note).toEqual({ code: 'read-as-tonnes' });
    expect(normalizeAmount('50750').note).toEqual({ code: 'read-as-kg', figure: 50750 });
    expect(normalizeAmount('50750', { paperUnit: 'kg' }).amount).toBe(50.75);
    expect(normalizeAmount('50750', { labelUnit: 'kg' }).amount).toBe(50.75);
    expect(normalizeAmount('50750', { labelUnit: 'kg' }).note).toEqual({ code: 'written-in-kg' });
    expect(normalizeAmount('50750 (Kg)').amount).toBe(50.75);
    expect(normalizeAmount('50.75', { paperUnit: 'MT' }).note).toEqual({ code: 'unit-from-paper', unit: 'MT' });
  });

  it('marks a garbled or impossible weight UNCLEAR rather than reading part of it', () => {
    expect(normalizeAmount('50..75 MT').normalized).toBe(UNCLEAR);
    expect(normalizeAmount('50..75 MT').raw).toBe('50..75 MT');
    expect(normalizeAmount('50..75 MT').note).toEqual({ code: 'bad-number', token: '50..75' });
    expect(normalizeAmount('68.10 17.35 50.75').note).toEqual({ code: 'many-numbers' });
    expect(normalizeAmount('50750 MT').normalized).toBe(UNCLEAR);
    expect(normalizeAmount('50750 MT').note).toEqual({ code: 'not-a-load', tonnes: 50750 });
    expect(normalizeAmount('subject to 2% variation').note).toEqual({ code: 'percentage' });
    expect(normalizeAmount('1 Load').normalized).toBe(UNCLEAR);
    expect(normalizeAmount('1 Load').note).toEqual({ code: 'not-a-unit', word: 'Load' });
  });

  it('treats one product under three trade names as one product', () => {
    expect(normalizeMaterial('12 MM Jelly').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('VSI 12 MM').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('12mm blue metal').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('M-Sand').normalized).toBe('M-SAND');
    expect(materialParts('AGGREGATE 12MM')).toEqual({ kind: 'AGGREGATE', name: 'AGGREGATE', size: '12MM' });
    expect(materialParts('RIVER SAND')).toEqual({ kind: 'RIVER SAND', name: 'RIVER SAND', size: null });
  });

  it('does not make aggregate out of a size alone', () => {
    expect(normalizeMaterial('12 MM TMT Bar').normalized).toBe('TMT BAR 12MM');
    expect(normalizeMaterial('12 MM TMT Bar').note).toEqual({ code: 'material-unknown' });
    expect(materialParts('TMT BAR 12MM')).toEqual({ kind: null, name: 'TMT BAR', size: '12MM' });
    expect(normalizeMaterial('20 MM').normalized).toBe('20MM');
    expect(normalizeMaterial('20 MM').note).toEqual({ code: 'size-only' });
  });
});

describe('extraction', () => {
  it('pulls every field it can find off a printed challan', () => {
    const d = extractDeliveryDocument('dc', DC);
    expect(d.fields.documentNumber?.normalized).toBe('6630');
    expect(d.fields.vehicle?.normalized).toBe('TN22EH9857');
    expect(d.fields.date?.normalized).toBe('2026-03-13');
    expect(d.fields.party?.raw).toBe('NEW RAJ AGENCIES');
    expect(d.fields.issuer?.raw).toBe('OM SAKTHI ENTERPRISES');
    expect(d.fields.grossWeight?.amount).toBe(68.1);
    expect(d.fields.tareWeight?.amount).toBe(17.35);
    expect(d.fields.netWeight?.amount).toBe(50.75);
    expect(d.fields.loadingLocation?.raw).toBe('OMS CRUSHER');
    expect(d.fields.unloadingLocation?.raw).toBe('PARTY SITE');
  });

  it('reads each letterhead as the issuer, past taglines and titles', () => {
    expect(extractDeliveryDocument('rcv', RECEIVED).fields.issuer?.raw).toBe('NEW RAJ AGENCIES');
    expect(extractDeliveryDocument('memo', MEMO).fields.issuer?.raw).toBe('GMS ELEGANT BUILDERS (I) PVT LTD, ERODE');
  });

  it('checks net = gross − tare on the paper itself, to the kilogram', () => {
    const dc = extractDeliveryDocument('dc', DC).netCheck;
    expect(dc.status).toBe('OK');
    expect(dc.finding).toEqual({ code: 'adds-up', grossKg: 68100, tareKg: 17350, netKg: 50750 });
    const wrong = extractDeliveryDocument('dc', DC.replace('Net Qty: 50.75 MT', 'Net Qty: 52.75 MT'));
    expect(wrong.netCheck.status).toBe('MISMATCH');
    expect(wrong.netCheck.calculated).toBe(50.75);
    // 40 kg is not "as written": the paper says 40 kg less than gross − tare.
    const close = extractDeliveryDocument('dc', DC.replace('Net Qty: 50.75 MT', 'Net Qty: 50.71 MT'));
    expect(close.netCheck.status).toBe('MISMATCH');
    expect(close.netCheck.differenceKg).toBe(-40);
    expect(close.netCheck.finding).toEqual({
      code: 'does-not-add-up',
      grossKg: 68100,
      tareKg: 17350,
      calculatedKg: 50750,
      statedKg: 50710,
      differenceKg: -40,
    });
    // No floating-point doubt: 85.45 − 17.35 is 68.10 exactly.
    const round = extractDeliveryDocument('dc', DC.replace('Full Qty: 68.10 MT', 'Full Qty: 85.45 MT').replace('Net Qty: 50.75 MT', 'Net Qty: 68.10 MT'));
    expect(round.netCheck.status).toBe('OK');
  });

  it('never fills a blank from elsewhere', () => {
    const r = extractDeliveryDocument('rcv', RECEIVED);
    expect(r.fields.tareWeight).toBeUndefined();
    expect(r.netCheck.status).toBe('NOT_POSSIBLE');
    expect(r.netCheck.finding).toEqual({ code: 'no-gross-or-tare', gross: 'read', tare: 'absent' });
    // "Load Wt 50" under "Net Wt 50.75" is a misread or a mis-write; say so.
    expect(r.netCheck.implausible).toBe(true);
    expect(r.netCheck.conflicts).toEqual([{ code: 'net-above-gross', netKg: 50750, grossKg: 50000 }]);
    // "Customer Signature" is a signature box, not a party called Signature.
    expect(r.fields.party?.raw).toBe('GMS - Muthukadu');
    expect(r.fields.documentNumber?.normalized).toBe('013');
  });

  it('reads a bare number in the unit the same paper weighs in', () => {
    const r = extractDeliveryDocument('rcv', RECEIVED);
    expect(r.fields.grossWeight?.unit).toBe('MT');
    expect(r.fields.grossWeight?.note).toEqual({ code: 'unit-from-paper', unit: 'MT' });
  });

  it('keeps kg as kg for a bare figure, and never takes a unit from the quantity', () => {
    const slip = extractDeliveryDocument('dc', 'Delivery Challan\nEmpty Qty: 17350 Kg\nFull Qty: 68100 Kg\nNet Qty: 50750');
    expect(slip.fields.netWeight?.amount).toBe(50.75);
    expect(slip.netCheck.status).toBe('OK');
    const memo = extractDeliveryDocument('memo', 'Delivery Memo\nQuantity Recd: 2 Units\nNet Wt: 50.75');
    expect(memo.fields.netWeight?.unit).toBe('MT');
    expect(memo.fields.quantity?.unit).toBe('UNIT');
  });

  it('reads a unit printed beside the label', () => {
    const slip = extractDeliveryDocument('dc', 'Delivery Challan\nGross Wt (Kg): 68100\nTare Wt (Kg): 17350\nNet Wt (Kg): 50750');
    expect(slip.fields.netWeight?.amount).toBe(50.75);
    expect(slip.fields.netWeight?.raw).toBe('50750');
    expect(slip.netCheck.status).toBe('OK');
  });

  it('keeps the PO numbers out of the memo number', () => {
    expect(extractDeliveryDocument('memo', MEMO).fields.documentNumber?.normalized).toBe('1648');
  });

  it('does not take a letterhead "No." for the paper number', () => {
    const rcv = extractDeliveryDocument(
      'rcv',
      RECEIVED.replace('(Building Material Suppliers)', 'H.O: Plot No.7, Ganapathy Nagar, 100 Ft. Road\nB.O: No.21, Main Road'),
    );
    expect(rcv.fields.documentNumber?.normalized).toBe('013');
    const memo = extractDeliveryDocument('memo', MEMO.replace('No. 1648', 'Cell No. 98427 12345\nNo. 1648'));
    expect(memo.fields.documentNumber?.normalized).toBe('1648');
    const gst = extractDeliveryDocument('rcv', RECEIVED.replace('(Building Material Suppliers)', 'GST No. 33ABCDE1234F1Z5'));
    expect(gst.fields.documentNumber?.normalized).toBe('013');
  });

  it('takes the load date, not a purchase-order date', () => {
    const memo = extractDeliveryDocument('memo', MEMO.replace('Date: 13.3.26', 'P.O. Date: 01.03.26\nDate: 13.3.26'));
    expect(memo.fields.date?.normalized).toBe('2026-03-13');
  });

  it('splits two labels on one line when a full stop is the only separator', () => {
    const memo = extractDeliveryDocument('memo', 'Delivery Memo\nSupplier: JSR Blue Metal Lorry No. TN 22 EH 9587 Date: 13.3.26');
    expect(memo.fields.party?.raw).toBe('JSR Blue Metal');
    expect(memo.fields.vehicle?.normalized).toBe('TN22EH9587');
    expect(memo.fields.date?.normalized).toBe('2026-03-13');
  });

  it('reads both weights off "Load Wt 68.10 Empty Wt 17.35"', () => {
    const r = extractDeliveryDocument('rcv', CLEAN_RECEIVED);
    expect(r.fields.grossWeight?.amount).toBe(68.1);
    expect(r.fields.tareWeight?.amount).toBe(17.35);
    expect(r.netCheck.status).toBe('OK');
  });

  it('is not fooled by a footer that uses a label word', () => {
    const dc = extractDeliveryDocument('dc', `${DC}\nGoods once sold will not be taken back.\nReceived the above material in good condition`);
    expect(dc.fields.material?.raw).toBe('VSI 12 MM');
    const net = extractDeliveryDocument('dc', `${DC}\nNet weight subject to 2% variation`);
    expect(net.fields.netWeight?.amount).toBe(50.75);
  });

  it('reads a weight block laid out as columns', () => {
    const d = extractDeliveryDocument('dc', 'Delivery Challan\nGross Wt    Tare Wt    Net Wt\n68.10       17.35      50.75');
    expect(d.fields.grossWeight?.amount).toBe(68.1);
    expect(d.fields.tareWeight?.amount).toBe(17.35);
    expect(d.fields.netWeight?.amount).toBe(50.75);
    expect(d.netCheck.status).toBe('OK');
    const squeezed = extractDeliveryDocument('dc', 'Delivery Challan\nGross Wt Tare Wt Net Wt\n68.10 17.35 50.75');
    expect(squeezed.fields.netWeight?.amount).toBe(50.75);
    const ragged = extractDeliveryDocument('dc', 'Delivery Challan\nGross Wt    Tare Wt    Net Wt\n68.10   50.75');
    expect(ragged.fields.netWeight?.normalized).toBe(UNCLEAR);
  });

  it('does not take a heading for the value of the label above it', () => {
    const d = extractDeliveryDocument('dc', 'Delivery Challan\nUnloading:\nOUTGOING TRIP\nTruck #: TN 22 EH 9857');
    expect(d.fields.unloadingLocation).toBeUndefined();
  });

  it('keeps an untyped paper in the result as unread', () => {
    const d = extractDeliveryDocument('photo', '   ', { name: 'IMG_0412.jpg' });
    expect(d.unread).toBe(true);
    expect(d.name).toBe('IMG_0412.jpg');
  });
});

describe('cross-check', () => {
  it('agrees on the load the three papers describe, and says what it could not settle', () => {
    const r = check(DC, MEMO, RECEIVED);
    expect(status(r, 'vehicle')).toBe('MATCH');
    expect(status(r, 'date')).toBe('MATCH');
    expect(status(r, 'material')).toBe('MATCH');
    // The memo's "Quantity Recd" is the weight it received; the DC's and the
    // transporter's net weights are their quantities.
    expect(status(r, 'netWeight')).toBe('MATCH');
    expect(status(r, 'quantity')).toBe('MATCH');
    // The memo names JSR Blue Metal as its supplier; neither other paper was issued by them.
    expect(status(r, 'party')).toBe('MISMATCH');
    expect(finding(r, 'party')).toMatchObject({ code: 'party-not-issuer', breaks: [{ docId: 'p1', party: 'JSR Blue Metal' }] });
    expect(r.overall).toBe('PARTIALLY MATCHED');
    // "Load Wt 50" under "Net Wt 50.75 MT": the transporter's net is more than its gross.
    expect(r.issues).toContainEqual(
      expect.objectContaining({ code: 'net', docId: 'p2', conflicts: [{ code: 'net-above-gross', netKg: 50750, grossKg: 50000 }] }),
    );
  });

  it('matches cleanly when everything agrees', () => {
    const r = check(DC, CLEAN_MEMO, CLEAN_RECEIVED);
    expect(r.issues).toEqual([]);
    expect(r.overall).toBe('MATCHED');
    expect(r.mismatchCount).toBe(0);
    expect(status(r, 'party')).toBe('MATCH');
    expect(finding(r, 'party')?.code).toBe('party-linked');
  });

  it('calls a different truck a mismatch and says why, even with only a full stop between labels', () => {
    const r = check(DC, MEMO.replace('Supplier: JSR Blue Metal\nLorry No. TN 22 EH 9857', 'Supplier: JSR Blue Metal Lorry No. TN 22 EH 9587'));
    expect(status(r, 'vehicle')).toBe('MISMATCH');
    expect(r.overall).toBe('MISMATCHED');
    const first = r.issues[0];
    expect(first).toMatchObject({ code: 'field', field: 'vehicle', status: 'MISMATCH', finding: { code: 'differs' } });
    expect(quoted(first?.code === 'field' ? first.finding : null)).toEqual(['TN22EH9857', 'TN22EH9587']);
  });

  it('calls a net weight off by more than the tolerance a mismatch', () => {
    const r = check(DC, RECEIVED.replace('Net Wt 50.75 MT', 'Net Wt 48.20 MT'));
    expect(status(r, 'netWeight')).toBe('MISMATCH');
    expect(r.overall).toBe('MISMATCHED');
  });

  it('flags a short delivery on the memo, once', () => {
    const r = check(DC, MEMO.replace('Quantity Recd: 50.75 MT', 'Quantity Recd: 30.00 MT'), RECEIVED);
    expect(status(r, 'netWeight')).toBe('MISMATCH');
    expect(status(r, 'quantity')).toBe('MISMATCH');
    expect(r.overall).toBe('MISMATCHED');
    expect(r.issues.filter((i) => i.code === 'field' && quoted(i.finding).includes('30 MT'))).toHaveLength(1);
  });

  it('allows one weighbridge step between papers, to the kilogram', () => {
    const r = check(DC.replace('Full Qty: 68.10 MT', 'Full Qty: 85.45 MT').replace('Net Qty: 50.75 MT', 'Net Qty: 68.10 MT'), CLEAN_RECEIVED.replace('Load Wt 68.10', 'Load Wt 85.50').replace('Net Wt 50.75 MT', 'Net Wt 68.15 MT'));
    expect(status(r, 'netWeight')).toBe('MATCH');
    expect(finding(r, 'netWeight')).toEqual({
      code: 'close-enough',
      pairs: [{ docIds: ['p0', 'p1'], note: { code: 'kg-apart', kg: 50 } }],
      allowance: { code: 'kg', kg: 50 },
    });
  });

  it('reports an unreadable value as UNCLEAR, not as a match', () => {
    const r = check(DC, RECEIVED.replace('Vehicle No. TN22EH9857', 'Vehicle No. [illegible]'));
    expect(status(r, 'vehicle')).toBe('UNCLEAR');
    expect(finding(r, 'vehicle')).toEqual({ code: 'unreadable', docIds: ['p1'], note: { code: 'marked-unreadable' } });
    expect(r.overall).toBe('PARTIALLY MATCHED');
  });

  it('compares units with CFT at 100 CFT a unit, and does not pretend to weigh a volume', () => {
    const units = check('Delivery Challan\nTruck #: TN 22 EH 9857\nQuantity: 2 Units', 'Delivery Memo\nLorry No. TN 22 EH 9857\nQuantity Recd: 200 CFT');
    expect(status(units, 'quantity')).toBe('MATCH');
    expect(finding(units, 'quantity')).toEqual({
      code: 'close-enough',
      pairs: [{ docIds: ['p0', 'p1'], note: { code: 'same-volume', cft: 200 } }],
      allowance: null,
    });
    const mixed = check('Delivery Challan\nTruck #: TN 22 EH 9857\nQuantity: 2 Units', 'Delivery Memo\nLorry No. TN 22 EH 9857\nQuantity Recd: 9.9 MT');
    expect(status(mixed, 'quantity')).toBe('UNCLEAR');
    expect(finding(mixed, 'quantity')?.code).toBe('weight-and-volume');
    expect(mixed.overall).not.toBe('MISMATCHED');
  });

  it('does not match a steel bar with jelly, or a size that one paper leaves out', () => {
    const bar = check(DC.replace('Item: VSI 12 MM', 'Item: 12 MM TMT Bar'), CLEAN_MEMO);
    expect(status(bar, 'material')).toBe('MISMATCH');
    const sizeless = check(DC.replace('Item: VSI 12 MM', 'Item: Blue Metal'), CLEAN_MEMO);
    expect(status(sizeless, 'material')).toBe('MISSING');
    expect(finding(sizeless, 'material')).toMatchObject({ code: 'size-on-one-paper', size: '12MM' });
  });

  it('allows a day either side for a load that crosses midnight, and no more', () => {
    const nextDay = check(DC, CLEAN_MEMO.replace('Date: 13.3.26', 'Date: 14.3.26'), CLEAN_RECEIVED);
    expect(status(nextDay, 'date')).toBe('MATCH');
    expect(finding(nextDay, 'date')).toMatchObject({ code: 'close-enough', allowance: { code: 'days', days: 1 } });
    expect(nextDay.overall).toBe('MATCHED');
    const week = check(DC, CLEAN_MEMO.replace('Date: 13.3.26', 'Date: 20.3.26'), CLEAN_RECEIVED);
    expect(status(week, 'date')).toBe('MISMATCH');
    expect(week.overall).toBe('MISMATCHED');
  });

  it('matches party names on whole words, not fragments', () => {
    const r = check(
      'RAJA TRADERS\nDelivery Challan\nParty: RAJ\nTruck #: TN 22 EH 9857',
      'RAJ\nDelivery Memo\nSupplier: RAJA TRADERS\nLorry No. TN 22 EH 9857',
    );
    // RAJ issued the memo and names RAJA TRADERS, who issued the DC: that link holds.
    // The DC names RAJ as its party, and RAJ issued the memo: that holds too.
    expect(status(r, 'party')).toBe('MATCH');
    const wrong = check('RAJA TRADERS\nDelivery Challan\nParty: RAJ\nTruck #: TN 22 EH 9857', 'RAJESH\nDelivery Memo\nSupplier: RAJA TRADERS\nLorry No. TN 22 EH 9857');
    expect(status(wrong, 'party')).toBe('MISMATCH');
  });

  it('never calls papers MATCHED when nothing was compared', () => {
    const titlesOnly = check('DELIVERY CHALLAN\nOM SAKTHI ENTERPRISES', 'DELIVERY MEMO\nGMS ELEGANT BUILDERS');
    expect(titlesOnly.overall).toBe('PARTIALLY MATCHED');
    expect(titlesOnly.issues.length).toBeGreaterThan(0);
    expect(titlesOnly.issues).toContainEqual({ code: 'field', field: 'vehicle', status: 'MISSING', finding: { code: 'on-no-paper' } });
    expect(titlesOnly.issues).toContainEqual({ code: 'no-weights-anywhere' });
    const oneField = check('Delivery Challan\nTruck #: TN 22 EH 9857', 'Delivery Memo\nLorry No. TN 22 EH 9857');
    expect(oneField.overall).toBe('PARTIALLY MATCHED');
  });

  it('counts a missing paper, a repeated paper and an unread paper as missing information', () => {
    const twoOnly = check(DC, CLEAN_MEMO);
    expect(twoOnly.missingTypes).toEqual(['material_received']);
    expect(twoOnly.overall).toBe('PARTIALLY MATCHED');
    expect(twoOnly.issues).toContainEqual({ code: 'papers-missing', types: ['material_received'] });
    const twice = check(DC, DC, CLEAN_MEMO, CLEAN_RECEIVED);
    expect(twice.issues).toContainEqual({ code: 'same-type-twice', type: 'delivery_challan', docIds: ['p0', 'p1'] });
    const photo = crossCheckDeliveryDocuments([
      { id: 'a', text: DC },
      { id: 'b', text: CLEAN_MEMO },
      { id: 'c', text: '', name: 'IMG_0412.jpg' },
    ]);
    expect(photo.overall).toBe('PARTIALLY MATCHED');
    expect(photo.issues).toContainEqual({ code: 'no-text', docId: 'c' });
    expect(paperName(photo.documents[2]!, photo.documents)).toEqual({ code: 'name', name: 'IMG_0412.jpg' });
    const one = check(DC);
    expect(one.issues).toContainEqual({ code: 'too-few-papers' });
  });

  it('names papers by what they are, and by name where two share a type', () => {
    const r = crossCheckDeliveryDocuments([
      { id: '1', name: 'image.jpg', text: DC },
      { id: '2', name: 'image.jpg', text: MEMO.replace('TN 22 EH 9857', 'TN 22 EH 9587') },
    ]);
    expect(r.documents.map((d) => d.type)).toEqual(['delivery_challan', 'delivery_memo']);
    // The finding points at each paper by id; the paper's name says what it is.
    expect(r.issues[0]).toMatchObject({ code: 'field', field: 'vehicle', finding: { code: 'differs', values: [{ docId: '1' }, { docId: '2' }] } });
    expect(r.documents.map((d) => paperName(d, r.documents))).toEqual([
      { code: 'type', type: 'delivery_challan' },
      { code: 'type', type: 'delivery_memo' },
    ]);
    const twice = check(DC, DC, CLEAN_MEMO);
    expect(paperName(twice.documents[1]!, twice.documents)).toEqual({ code: 'type-and-name', type: 'delivery_challan', name: 'p1' });
    const stray = crossCheckDeliveryDocuments([
      { id: 'x', name: 'scan.txt', text: 'Thank you for your business' },
      { id: 'y', text: DC },
    ]);
    expect(paperName(stray.documents[0]!, stray.documents)).toEqual({ code: 'name', name: 'scan.txt' });
    expect(stray.issues).toContainEqual({ code: 'unknown-paper', docId: 'x', note: { code: 'no-delivery-words' } });
  });

  it('counts each disagreement once for the stamp', () => {
    const r = check(DC.replace('Net Qty: 50.75 MT', 'Net Qty: 52.75 MT'), CLEAN_MEMO.replace('TN 22 EH 9857', 'TN 22 EH 9587'), CLEAN_RECEIVED);
    // Vehicle, net weight (DC 52.75 against 50.75), and the DC's own arithmetic.
    expect(r.overall).toBe('MISMATCHED');
    expect(r.mismatchCount).toBe(3);
  });
});

describe('label strength', () => {
  it('prefers the specific unloading label over a generic site', () => {
    expect(extractDeliveryDocument('memo', MEMO).fields.unloadingLocation?.raw).toBe('RMC Plant');
  });
});
