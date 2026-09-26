import { describe, expect, it } from 'vitest';
import { captureExpenseBill, parseBillDate, parseRegistration, parseRupees } from './bill-capture.js';

const BUNK = `SAKTHI FUELS
IOCL Dealer, GST Road, Karapakkam
GSTIN: 33ABCDE1234F1Z5
CASH BILL
Bill No: BK/48213        Date: 06/08/2026
Vehicle No: TN 29 AB 1001
Product: HSD (Diesel)
Rate/Ltr: 95.55
Volume: 432.00 L
Amount: Rs. 41,277.60`;

const REPAIR = `Sri Ganesh Auto Works
No 12, Poonamallee High Road
TAX INVOICE
Invoice No. SGA/2026/311
Invoice Date: 12-Aug-2026
Vehicle: TN38AL1050
Clutch overhaul labour      6,500.00
Clutch plate Qty 1          9,800.00
Sub Total                  16,300.00
CGST 9%                     1,467.00
SGST 9%                     1,467.00
Grand Total             ₹ 19,234.00`;

describe('primitives', () => {
  it('reads rupees in Indian grouping', () => {
    expect(parseRupees('Rs. 1,04,800.50')).toBe(104800.5);
    expect(parseRupees('₹ 19,234.00')).toBe(19234);
  });
  it('reads bill dates day-first', () => {
    expect(parseBillDate('06/08/2026')).toBe('2026-08-06');
    expect(parseBillDate('12-Aug-2026')).toBe('2026-08-12');
    expect(parseBillDate('31/02/2026')).toBeNull();
  });
  it('reads registrations however spaced', () => {
    expect(parseRegistration('TN 29 AB 1001')).toBe('TN29AB1001');
  });
});

describe('diesel bunk slip', () => {
  const c = captureExpenseBill(BUNK);
  it('captures every ledger field', () => {
    expect(c.fields.kind?.value).toBe('diesel');
    expect(c.fields.billNumber?.value).toBe('BK/48213');
    expect(c.fields.billDate?.value).toBe('2026-08-06');
    expect(c.fields.vehicle?.value).toBe('TN29AB1001');
    expect(c.fields.litres?.value).toBe('432');
    expect(c.fields.rate?.value).toBe('95.55');
    expect(c.fields.amount?.value).toBe('41277.60');
    expect(c.fields.gstin?.value).toBe('33ABCDE1234F1Z5');
    expect(c.fields.vendor?.value).toBe('SAKTHI FUELS');
    expect(c.warnings).toEqual([]);
  });
  it('flags a total that litres × rate does not support', () => {
    const bad = captureExpenseBill(BUNK.replace('41,277.60', '44,277.60'));
    expect(bad.fields.amount?.confidence).toBe(1);
    expect(bad.warnings[0]).toMatch(/Litres × rate/);
  });
  it('never scores a field high off a line the OCR doubted', () => {
    const doubted = captureExpenseBill(BUNK, [95, 95, 95, 95, 95, 95, 95, 95, 95, 40]);
    expect(doubted.fields.amount?.confidence).toBe(1);
  });
});

describe('repair invoice', () => {
  const c = captureExpenseBill(REPAIR);
  it('takes the grand total, not the subtotal or a line item', () => {
    expect(c.fields.amount?.value).toBe('19234.00');
  });
  it('does not read a parts quantity as litres', () => {
    expect(c.fields.kind?.value).toBe('repair');
    expect(c.fields.litres).toBeUndefined();
  });
  it('reads a named-month date and an unspaced registration', () => {
    expect(c.fields.billDate?.value).toBe('2026-08-12');
    expect(c.fields.vehicle?.value).toBe('TN38AL1050');
    expect(c.fields.billNumber?.value).toBe('SGA/2026/311');
  });
});

describe('nothing to read', () => {
  it('leaves blanks blank and says so', () => {
    const c = captureExpenseBill('smudged paper');
    expect(c.fields.amount).toBeUndefined();
    expect(c.warnings).toContain('No total could be read — key the amount from the paper.');
  });
});

describe('unreadable values', () => {
  it('says a labelled date could not be read instead of guessing one', () => {
    const c = captureExpenseBill(BUNK.replace('Date: 06/08/2026', 'Date: 07/68/2026'));
    expect(c.fields.billDate).toBeUndefined();
    expect(c.warnings.some((w) => w.includes('The date is on the bill but could not be read') && w.includes('07/68/2026'))).toBe(true);
  });
});
