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

describe('classification', () => {
  it('tells the three documents apart by their own words, not their layout', () => {
    expect(classifyDeliveryDocument(DC).type).toBe('delivery_challan');
    expect(classifyDeliveryDocument(RECEIVED).type).toBe('material_received');
    expect(classifyDeliveryDocument(MEMO).type).toBe('delivery_memo');
  });

  it('refuses to guess when the text says nothing', () => {
    expect(classifyDeliveryDocument('Thank you for your business').type).toBe('unknown');
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

  it('brings weights to tonnes and leaves CFT alone', () => {
    expect(normalizeAmount('50.75 MT').amount).toBe(50.75);
    expect(normalizeAmount('50,750 kg').amount).toBe(50.75);
    expect(normalizeAmount('1.68 CFT').unit).toBe('CFT');
    expect(normalizeAmount('50').unit).toBeUndefined();
    expect(normalizeAmount('50', 'MT').unit).toBe('MT');
  });

  it('treats one product under three trade names as one product', () => {
    expect(normalizeMaterial('12 MM Jelly').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('VSI 12 MM').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('12mm blue metal').normalized).toBe('AGGREGATE 12MM');
    expect(normalizeMaterial('M-Sand').normalized).toBe('M-SAND');
  });
});

describe('extraction', () => {
  it('pulls every field it can find off a printed challan', () => {
    const d = extractDeliveryDocument('dc', DC);
    expect(d.fields.documentNumber?.normalized).toBe('6630');
    expect(d.fields.vehicle?.normalized).toBe('TN22EH9857');
    expect(d.fields.date?.normalized).toBe('2026-03-13');
    expect(d.fields.party?.raw).toBe('NEW RAJ AGENCIES');
    expect(d.fields.grossWeight?.amount).toBe(68.1);
    expect(d.fields.tareWeight?.amount).toBe(17.35);
    expect(d.fields.netWeight?.amount).toBe(50.75);
    expect(d.fields.loadingLocation?.raw).toBe('OMS CRUSHER');
    expect(d.fields.unloadingLocation?.raw).toBe('PARTY SITE');
  });

  it('checks net = gross − tare on the document itself', () => {
    expect(extractDeliveryDocument('dc', DC).netCheck.status).toBe('OK');
    const wrong = extractDeliveryDocument('dc', DC.replace('Net Qty: 50.75 MT', 'Net Qty: 52.75 MT'));
    expect(wrong.netCheck.status).toBe('MISMATCH');
    expect(wrong.netCheck.calculated).toBe(50.75);
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

  it('reads a bare number in the unit the same document uses', () => {
    const r = extractDeliveryDocument('rcv', RECEIVED);
    expect(r.fields.grossWeight?.unit).toBe('MT');
    expect(r.fields.grossWeight?.note).toMatch(/No unit written/);
  });

  it('keeps the PO numbers out of the memo number', () => {
    expect(extractDeliveryDocument('memo', MEMO).fields.documentNumber?.normalized).toBe('1648');
  });
});

describe('cross-check', () => {
  const docs = [
    { id: 'dc.jpg', text: DC },
    { id: 'memo.jpg', text: MEMO },
    { id: 'received.jpg', text: RECEIVED },
  ];

  it('agrees on the load the three papers describe', () => {
    const r = crossCheckDeliveryDocuments(docs);
    const status = Object.fromEntries(r.comparisons.map((c) => [c.field, c.status]));
    expect(status['vehicle']).toBe('MATCH');
    expect(status['date']).toBe('MATCH');
    expect(status['material']).toBe('MATCH');
    expect(status['netWeight']).toBe('MATCH');
    // Three different parties in one chain is honest paper, and still a difference.
    expect(status['party']).toBe('MISMATCH');
    // Only the memo writes a quantity separately from the net weight.
    expect(status['quantity']).toBe('MISSING');
    expect(r.overall).toBe('PARTIALLY MATCHED');
    expect(r.explanations.length).toBeGreaterThan(0);
  });

  it('calls a different truck a mismatch and says why', () => {
    const r = crossCheckDeliveryDocuments([
      { id: 'dc', text: DC },
      { id: 'memo', text: MEMO.replace('TN 22 EH 9857', 'TN 22 EH 9587') },
    ]);
    expect(r.comparisons.find((c) => c.field === 'vehicle')?.status).toBe('MISMATCH');
    expect(r.overall).toBe('MISMATCHED');
    expect(r.explanations[0]).toMatch(/TN22EH9587/);
    expect(r.explanations[0]).toMatch(/TN22EH9857/);
  });

  it('calls a net weight off by more than the tolerance a mismatch', () => {
    const r = crossCheckDeliveryDocuments([
      { id: 'dc', text: DC },
      { id: 'rcv', text: RECEIVED.replace('Net Wt 50.75 MT', 'Net Wt 48.20 MT') },
    ]);
    expect(r.comparisons.find((c) => c.field === 'netWeight')?.status).toBe('MISMATCH');
    expect(r.overall).toBe('MISMATCHED');
  });

  it('reports an unreadable value as UNCLEAR, not as a match', () => {
    const r = crossCheckDeliveryDocuments([
      { id: 'dc', text: DC },
      { id: 'rcv', text: RECEIVED.replace('Vehicle No. TN22EH9857', 'Vehicle No. [illegible]') },
    ]);
    expect(r.comparisons.find((c) => c.field === 'vehicle')?.status).toBe('UNCLEAR');
    expect(r.overall).toBe('PARTIALLY MATCHED');
  });

  it('matches cleanly when everything agrees', () => {
    const second = DC.replace('Delivery Challan', 'Material Received Challan').replace('DC/Ref #: 6630', 'No. 88');
    const r = crossCheckDeliveryDocuments([
      { id: 'a', text: DC },
      { id: 'b', text: second },
    ]);
    expect(r.overall).toBe('MATCHED');
    expect(r.explanations).toEqual([]);
  });
});

describe('label strength', () => {
  it('prefers the specific unloading label over a generic site', () => {
    expect(extractDeliveryDocument('memo', MEMO).fields.unloadingLocation?.raw).toBe('RMC Plant');
  });
});
