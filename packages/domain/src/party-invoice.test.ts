import { describe, expect, it } from 'vitest';
import fixtures from './party-invoice.fixtures.json';
import { saleFigures } from './vehicle-pl.js';
import {
  amountInWords,
  GST_STATES,
  invoiceDue,
  invoiceFigures,
  invoiceKind,
  invoiceNumber,
  isInvoiceNumber,
  lineFigures,
  matchReceipts,
  moneyStatus,
  placeOfSupply,
  roundToRupee,
  stateOfGstin,
  supplyType,
  type InvoiceFigures,
  type InvoiceLineInput,
  type PlaceOfSupply,
  type ReceiptCandidate,
  type SupplyType,
} from './party-invoice.js';

/*
 * The golden figures live in party-invoice.fixtures.json, worked by hand, and
 * apps/api/tests/test_party_invoice_domain.py runs the Python rules over the
 * same file. A rule changed on one side only fails one of the two suites.
 */

describe('party invoice golden fixtures', () => {
  for (const c of fixtures.invoices) {
    it(c.name, () => {
      expect(invoiceFigures(c.lines as unknown as InvoiceLineInput[], c.supply as SupplyType)).toEqual(c.expect as unknown as InvoiceFigures);
    });
  }

  it('rounds a total to the rupee, half away from zero, and says what that added', () => {
    for (const c of fixtures.rounding) expect(roundToRupee(c.amount)).toEqual(c.expect);
  });

  it('says an amount in words the Indian way', () => {
    for (const c of fixtures.words) expect(amountInWords(c.amount)).toBe(c.expect);
  });

  for (const c of fixtures.placeOfSupply) {
    it(`place of supply: ${c.name}`, () => {
      const pos = placeOfSupply(c.input);
      expect(pos).toEqual(c.expect as unknown as PlaceOfSupply);
      if ('stateCode' in pos) expect(supplyType(c.input.sellerState, pos.stateCode)).toBe(c.supply);
    });
  }

  it("reads a GSTIN's state from its first two digits", () => {
    for (const c of fixtures.gstinStates) expect(stateOfGstin(c.gstin)).toBe(c.expect);
  });

  it('numbers PREFIX/26-27/0001, at most 16 characters of letters, digits, "-" and "/"', () => {
    for (const c of fixtures.numbers) {
      const n = invoiceNumber(c.prefix, c.financialYear, c.serial);
      expect(n).toBe(c.expect);
      expect(isInvoiceNumber(n)).toBe(c.valid);
    }
    for (const c of fixtures.invoiceNumberShapes) expect(isInvoiceNumber(c.value)).toBe(c.valid);
  });

  for (const c of fixtures.matching) {
    it(`money received: ${c.name}`, () => {
      expect(matchReceipts(c.due, c.candidates as ReceiptCandidate[])).toEqual(c.expect);
    });
  }

  it('says what an invoice has received: due, part paid, paid', () => {
    for (const c of fixtures.money) {
      expect(moneyStatus(c.total, c.received)).toBe(c.status);
      expect(invoiceDue(c.total, c.received)).toBe(c.due);
    }
  });
});

describe('party invoice rules', () => {
  const line: InvoiceLineInput = { id: 'l', quantity: '6.5', rate: '4200.00', transport: '2500.00', gstRatePct: '5', hsnCode: '2517' };

  it("bills the trip's own taxable value: the invoice and the trip page agree on AV", () => {
    const sale = saleFigures({ id: 's', customerId: 'c', quantity: line.quantity, rate: line.rate, transport: line.transport ?? null, gstBilled: true, gstRatePct: line.gstRatePct });
    const billed = lineFigures(line, 'intra');
    expect(billed.amount).toBe(sale.amount);
    expect(billed.taxable).toBe(sale.taxable);
  });

  it('charges the same total tax either way on a round figure; only the split changes', () => {
    const intra = lineFigures(line, 'intra');
    const inter = lineFigures(line, 'inter');
    expect(intra.cgst).toBe(intra.sgst);
    expect(intra.igst).toBe('0.00');
    expect(inter.cgst).toBe('0.00');
    expect(inter.igst).toBe('1490.00');
    expect(intra.total).toBe(inter.total);
  });

  it('is intra-state only when the place of supply is the seller’s own state', () => {
    expect(supplyType('33', '33')).toBe('intra');
    expect(supplyType('33', '29')).toBe('inter');
    expect(supplyType('29', '33')).toBe('inter');
  });

  it('is B2B exactly when the buyer has a GSTIN', () => {
    expect(invoiceKind('33AABCU9603R1ZU')).toBe('b2b');
    expect(invoiceKind(null)).toBe('b2c');
    expect(invoiceKind('')).toBe('b2c');
  });

  it("never rounds off more than half a rupee, and the round-off is the total's own line", () => {
    for (let paise = 0; paise < 100; paise++) {
      const amount = `1234.${String(paise).padStart(2, '0')}`;
      const { total, roundOff } = roundToRupee(amount);
      expect(total.endsWith('.00')).toBe(true);
      expect(Math.abs(Number(roundOff))).toBeLessThanOrEqual(0.5);
      expect((Number(total) * 100 - Number(roundOff) * 100).toFixed(0)).toBe(String(123400 + paise));
    }
  });

  it('never matches more than is due or more than a payment has free', () => {
    const matched = matchReceipts('1000.00', [
      { paymentId: 'a', onTrip: true, paidOn: '2026-08-01', free: '600.00' },
      { paymentId: 'b', onTrip: false, paidOn: '2026-07-01', free: '600.00' },
    ]);
    expect(matched).toEqual([
      { paymentId: 'a', amount: '600.00' },
      { paymentId: 'b', amount: '400.00' },
    ]);
  });

  it('knows Tamil Nadu by its code, and leaves out the codes no state uses now', () => {
    expect(GST_STATES['33']).toBe('Tamil Nadu');
    expect(GST_STATES['25']).toBeUndefined();
    expect(GST_STATES['28']).toBeUndefined();
  });
});
