import type { PlProblem } from './plStore.js';
import type { sheetWords } from './words.js';

/**
 * A trip sheet's refusals in the reader's words: the demo store's (plStore.ts)
 * and, live, the API's (plApi.ts), which share one vocabulary. No React here,
 * so the tests word every refusal directly.
 */

export type SheetWords = (typeof sheetWords)['en'];

/** A refused value's reason, as the rules give it (store and API alike), to the words for its fix. */
const REASON: Record<string, keyof SheetWords['errors']> = {
  required: 'required',
  'must be more than zero': 'positive',
  'after today': 'afterToday',
  "outside the sheet's dates": 'outsideDates',
  'before the start date': 'beforeStart',
  'less than the start km': 'kmOrder',
  'required on a GST bill': 'gstin',
  'not one of your GST rates': 'notRate',
  'that GST rate is switched off': 'rateOff',
  'not a customer of this trip': 'notOnTrip',
  'not a vendor of this trip': 'notOnTrip',
  'no longer in use': 'notInUse',
  'required for maintenance, and only there': 'maintenanceKind',
  'say what the maintenance was': 'describe',
  // The API's own checks of a value's shape (app/schemas/vehicle_pl.py).
  'not a valid GSTIN': 'badGstin',
  'at most 1 decimal places': 'decimals',
  'at most 2 decimal places': 'decimals',
  'at most three decimal places': 'decimals',
};

export function problemText(p: PlProblem, w: SheetWords): string {
  switch (p.code) {
    case 'invalid': {
      const k = REASON[p.reason] ?? 'other';
      const v = w.errors[k];
      return typeof v === 'string' ? v : w.errors.other;
    }
    case 'diesel-other-vehicle':
    case 'diesel-bill-void':
    case 'diesel-same-bill':
    case 'diesel-bill-exists':
      return w.errors[p.code](p.billNumber);
    case 'diesel-bill-on-sheet':
      return w.errors[p.code](p.billNumber, p.sheetNumber);
    case 'diesel-linked-elsewhere':
      return w.errors[p.code](p.sheetNumber);
    case 'not-paid-in-full':
      return w.errors[p.code](`₹${p.due}`);
    case 'sale-invoiced':
      return w.errors[p.code](p.tripNumber, p.status === 'draft' ? null : p.invoiceNumber);
    case 'gstin-used':
      return w.errors[p.code](p.gstin);
    case 'server':
      return w.errors.server(p.status);
    default:
      return w.errors[p.code];
  }
}

/** The field a refusal is about, as the page names it ("trips[0].sales[1].rate"), if it is about one. */
export const problemField = (p: PlProblem | null): string | null => (p && 'field' in p && p.field !== undefined ? p.field : null);
