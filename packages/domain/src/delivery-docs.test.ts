import { describe, expect, it } from 'vitest';
import {
  classifyDeliveryDocument,
  crossCheckDeliveryDocuments,
  extractDeliveryDocument,
  normalizeAmount,
  normalizeDate,
  normalizeMaterial,
  normalizeVehicle,
  UNCLEAR,
  type ComparedField,
  type CrossCheckResult,
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
const check = (...texts: string[]) => crossCheckDeliveryDocuments(texts.map((text, i) => ({ id: `p${i}`, text })));

describe('classification', () => {
  it('tells the three papers apart by their own words, not their layout', () => {
    expect(classifyDeliveryDocument(DC).type).toBe('delivery_challan');
    expect(classifyDeliveryDocument(RECEIVED).type).toBe('material_received');
    expect(classifyDeliveryDocument(MEMO).type).toBe('delivery_memo');
    expect(classifyDeliveryDocument(DC).confidence).toBe(3);
  });

  it('refuses to guess when the text says nothing', () => {
    expect(classifyDeliveryDocument('Thank you for your business').type).toBe('unknown');
  });

  it('needs more than one stray word, and knows other papers when it sees them', () => {
    // GSTIN alone once made a tax invoice a DC "at 100%".
    const invoice = classifyDeliveryDocument('ANNAI TYRES\nGSTIN: 33AAACA1234B1Z5\nTAX INVOICE\nTyre 10.00-20');
    expect(invoice.type).toBe('unknown');
    expect(invoice.note).toMatch(/tax invoice/);
    expect(classifyDeliveryDocument('WEIGHMENT SLIP\nGross Wt: 68.10\nTare Wt: 17.35').type).toBe('unknown');
    expect(classifyDeliveryDocument('SRI MURUGAN FUELS\nCASH MEMO\nHSD 120 L').type).toBe('unknown');
    expect(classifyDeliveryDocument('Printed by GSTIN portal').type).toBe('unknown');
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
    expect(normalizeDate('3?.3.26').normalized).toBe(UNCLEAR);
  });

  it('reads day-first dates in the forms Indian paper uses', () => {
    expect(normalizeDate('13.3.26').normalized).toBe('2026-03-13');
    expect(normalizeDate('13-03-2026 09:47 am').normalized).toBe('2026-03-13');
    expect(normalizeDate('13 Mar 2026').normalized).toBe('2026-03-13');
    expect(normalizeDate('31.02.26').normalized).toBe(UNCLEAR);
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
    expect(bare.note).toMatch(/No unit written/);
    expect(normalizeAmount('50750', { paperUnit: 'kg' }).amount).toBe(50.75);
    expect(normalizeAmount('50750', { labelUnit: 'kg' }).amount).toBe(50.75);
    expect(normalizeAmount('50750 (Kg)').amount).toBe(50.75);
    expect(normalizeAmount('50.75', { paperUnit: 'MT' }).note).toMatch(/as the paper's other weights are/);
  });

  it('marks a garbled or impossible weight UNCLEAR rather than reading part of it', () => {
    expect(normalizeAmount('50..75 MT').normalized).toBe(UNCLEAR);
    expect(normalizeAmount('50..75 MT').raw).toBe('50..75 MT');
    expect(normalizeAmount('68.10 17.35 50.75').normalized).toBe(UNCLEAR);
    expect(normalizeAmount('50750 MT').normalized).toBe(UNCLEAR);
    expect(normalizeAmount('subject to 2% variation').normalized).toBe(UNCLEAR);
    expect(normalizeAmount('1 Load').normalized).toBe(UNCLEAR);
  });

  it('treats one product under three trade names as one product', () => {
    expect(normalizeMaterial('12 MM Jelly').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('VSI 12 MM').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('12mm blue metal').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('M-Sand').normalized).toBe('M-SAND');
  });

  it('does not make aggregate out of a size alone', () => {
    expect(normalizeMaterial('12 MM TMT Bar').normalized).toBe('TMT BAR 12MM');
    expect(normalizeMaterial('20 MM').normalized).toBe('20MM');
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
    expect(extractDeliveryDocument('dc', DC).netCheck.status).toBe('OK');
    const wrong = extractDeliveryDocument('dc', DC.replace('Net Qty: 50.75 MT', 'Net Qty: 52.75 MT'));
    expect(wrong.netCheck.status).toBe('MISMATCH');
    expect(wrong.netCheck.calculated).toBe(50.75);
    // 40 kg is not "as written".
    const close = extractDeliveryDocument('dc', DC.replace('Net Qty: 50.75 MT', 'Net Qty: 50.71 MT'));
    expect(close.netCheck.status).toBe('MISMATCH');
    expect(close.netCheck.differenceKg).toBe(-40);
    expect(close.netCheck.explanation).toMatch(/40 kg less/);
    // No floating-point doubt: 85.45 − 17.35 is 68.10 exactly.
    const round = extractDeliveryDocument('dc', DC.replace('Full Qty: 68.10 MT', 'Full Qty: 85.45 MT').replace('Net Qty: 50.75 MT', 'Net Qty: 68.10 MT'));
    expect(round.netCheck.status).toBe('OK');
  });

  it('never fills a blank from elsewhere', () => {
    const r = extractDeliveryDocument('rcv', RECEIVED);
    expect(r.fields.tareWeight).toBeUndefined();
    expect(r.netCheck.status).toBe('NOT_POSSIBLE');
    // "Load Wt 50" under "Net Wt 50.75" is a misread or a mis-write; say so.
    expect(r.netCheck.implausible).toBe(true);
    // "Customer Signature" is a signature box, not a party called Signature.
    expect(r.fields.party?.raw).toBe('GMS - Muthukadu');
    expect(r.fields.documentNumber?.normalized).toBe('013');
  });

  it('reads a bare number in the unit the same paper weighs in', () => {
    const r = extractDeliveryDocument('rcv', RECEIVED);
    expect(r.fields.grossWeight?.unit).toBe('MT');
    expect(r.fields.grossWeight?.note).toMatch(/No unit written/);
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
    expect(r.comparisons.find((c) => c.field === 'party')!.explanation).toMatch(/JSR Blue Metal/);
    expect(r.overall).toBe('PARTIALLY MATCHED');
    expect(r.explanations.some((e) => /Load Wt|net .* more than the gross/i.test(e))).toBe(true);
  });

  it('matches cleanly when everything agrees', () => {
    const r = check(DC, CLEAN_MEMO, CLEAN_RECEIVED);
    expect(r.explanations).toEqual([]);
    expect(r.overall).toBe('MATCHED');
    expect(r.mismatchCount).toBe(0);
    expect(status(r, 'party')).toBe('MATCH');
  });

  it('calls a different truck a mismatch and says why, even with only a full stop between labels', () => {
    const r = check(DC, MEMO.replace('Supplier: JSR Blue Metal\nLorry No. TN 22 EH 9857', 'Supplier: JSR Blue Metal Lorry No. TN 22 EH 9587'));
    expect(status(r, 'vehicle')).toBe('MISMATCH');
    expect(r.overall).toBe('MISMATCHED');
    expect(r.explanations[0]).toMatch(/TN22EH9587/);
    expect(r.explanations[0]).toMatch(/TN22EH9857/);
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
    expect(r.explanations.filter((e) => /30 MT/.test(e))).toHaveLength(1);
  });

  it('allows one weighbridge step between papers, to the kilogram', () => {
    const r = check(DC.replace('Full Qty: 68.10 MT', 'Full Qty: 85.45 MT').replace('Net Qty: 50.75 MT', 'Net Qty: 68.10 MT'), CLEAN_RECEIVED.replace('Load Wt 68.10', 'Load Wt 85.50').replace('Net Wt 50.75 MT', 'Net Wt 68.15 MT'));
    expect(status(r, 'netWeight')).toBe('MATCH');
    expect(r.comparisons.find((c) => c.field === 'netWeight')!.explanation).toMatch(/50 kg apart/);
  });

  it('reports an unreadable value as UNCLEAR, not as a match', () => {
    const r = check(DC, RECEIVED.replace('Vehicle No. TN22EH9857', 'Vehicle No. [illegible]'));
    expect(status(r, 'vehicle')).toBe('UNCLEAR');
    expect(r.overall).toBe('PARTIALLY MATCHED');
  });

  it('compares units with CFT at 100 CFT a unit, and does not pretend to weigh a volume', () => {
    const units = check('Delivery Challan\nTruck #: TN 22 EH 9857\nQuantity: 2 Units', 'Delivery Memo\nLorry No. TN 22 EH 9857\nQuantity Recd: 200 CFT');
    expect(status(units, 'quantity')).toBe('MATCH');
    const mixed = check('Delivery Challan\nTruck #: TN 22 EH 9857\nQuantity: 2 Units', 'Delivery Memo\nLorry No. TN 22 EH 9857\nQuantity Recd: 9.9 MT');
    expect(status(mixed, 'quantity')).toBe('UNCLEAR');
    expect(mixed.overall).not.toBe('MISMATCHED');
  });

  it('does not match a steel bar with jelly, or a size that one paper leaves out', () => {
    const bar = check(DC.replace('Item: VSI 12 MM', 'Item: 12 MM TMT Bar'), CLEAN_MEMO);
    expect(status(bar, 'material')).toBe('MISMATCH');
    const sizeless = check(DC.replace('Item: VSI 12 MM', 'Item: Blue Metal'), CLEAN_MEMO);
    expect(status(sizeless, 'material')).toBe('MISSING');
  });

  it('allows a day either side for a load that crosses midnight, and no more', () => {
    const nextDay = check(DC, CLEAN_MEMO.replace('Date: 13.3.26', 'Date: 14.3.26'), CLEAN_RECEIVED);
    expect(status(nextDay, 'date')).toBe('MATCH');
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
    expect(titlesOnly.explanations.length).toBeGreaterThan(0);
    const oneField = check('Delivery Challan\nTruck #: TN 22 EH 9857', 'Delivery Memo\nLorry No. TN 22 EH 9857');
    expect(oneField.overall).toBe('PARTIALLY MATCHED');
  });

  it('counts a missing paper, a repeated paper and an unread paper as missing information', () => {
    const twoOnly = check(DC, CLEAN_MEMO);
    expect(twoOnly.missingTypes).toEqual(['material_received']);
    expect(twoOnly.overall).toBe('PARTIALLY MATCHED');
    const twice = check(DC, DC, CLEAN_MEMO, CLEAN_RECEIVED);
    expect(twice.explanations.some((e) => /2 papers read as Delivery Challan\/DC/.test(e))).toBe(true);
    const photo = crossCheckDeliveryDocuments([
      { id: 'a', text: DC },
      { id: 'b', text: CLEAN_MEMO },
      { id: 'c', text: '', name: 'IMG_0412.jpg' },
    ]);
    expect(photo.overall).toBe('PARTIALLY MATCHED');
    expect(photo.explanations.some((e) => /IMG_0412\.jpg/.test(e))).toBe(true);
  });

  it('names papers by what they are, and by name where two share a type', () => {
    const r = crossCheckDeliveryDocuments([
      { id: '1', name: 'image.jpg', text: DC },
      { id: '2', name: 'image.jpg', text: MEMO.replace('TN 22 EH 9857', 'TN 22 EH 9587') },
    ]);
    expect(r.documents.map((d) => d.type)).toEqual(['delivery_challan', 'delivery_memo']);
    expect(r.explanations[0]).toMatch(/Delivery Challan\/DC says/);
    expect(r.explanations[0]).toMatch(/Delivery Memo says/);
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
