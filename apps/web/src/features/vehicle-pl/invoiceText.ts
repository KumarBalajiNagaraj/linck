import { decimal, GST_STATES } from '@linck/domain';
import { INVOICE_CANCEL, INVOICE_READ, RECEIVE, type InvoiceProblem } from './invoiceStore.js';
import type { invoiceWords } from './invoiceWords.js';
import { inrExact } from './PlParts.js';

export type InvoiceWords = (typeof invoiceWords)['en'];

/** A state as the reader names it: Tamil Nadu, or தமிழ்நாடு. */
export const stateName = (w: InvoiceWords, code: string | null | undefined): string => (code ? w.state(code, GST_STATES[code] ?? '') : '');

/** A refusal from the invoice rules (the API's problem codes), in the reader's words. */
export function invoiceProblemText(p: InvoiceProblem, w: InvoiceWords): string {
  switch (p.code) {
    case 'needs-permission':
      return p.permission === INVOICE_CANCEL ? w.errors.cancel : p.permission === RECEIVE ? w.errors.receive : p.permission === INVOICE_READ ? w.errors.read : w.errors.write;
    case 'invalid':
      return p.field === 'reason' ? w.errors.reason : p.field === 'placeOfSupply' ? w.errors.placeOfSupply : p.field === 'amount' ? w.errors.amount : w.errors.invalid;
    case 'trip-not-for-customer':
    case 'sale-not-gst':
    case 'sale-no-hsn':
      return w.errors[p.code](p.tripNumber);
    case 'sale-on-invoice':
      return w.errors[p.code](p.tripNumber, p.status === 'draft' ? null : p.invoiceNumber);
    case 'sale-billed-outside':
      return w.errors[p.code](p.tripNumber, p.invoiceNumber);
    case 'site-no-gstin':
      return w.errors[p.code](p.siteName);
    case 'buyer-gstins-differ':
      return w.errors[p.code](p.gstins.join(', '));
    case 'places-differ':
      return w.errors[p.code](p.states.map((s) => stateName(w, s)).join(', '));
    case 'too-much': {
      const most = decimal.cmp(decimal.dec(p.free), decimal.dec(p.due)) < 0 ? p.free : p.due;
      return w.errors[p.code](inrExact(most));
    }
    case 'seller-gstin-wrong':
      return w.errors[p.code](p.gstin);
    case 'server':
      return w.errors.server(p.status);
    default:
      return w.errors[p.code];
  }
}

/** ₹1,23,456.00, a refund or a round-off down with a minus sign. */
export function inrSigned(value: string): string {
  return value.startsWith('-') ? `−${inrExact(value.slice(1))}` : inrExact(value);
}

/** 1,23,456.00: the figure alone, as an invoice's columns print it under a ₹ heading. */
export function grouped(value: string): string {
  const text = inrSigned(value);
  return text.replace('₹', '');
}
