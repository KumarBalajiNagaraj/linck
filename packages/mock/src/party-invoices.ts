import { buildGstin } from '@linck/domain';
import { SITES } from './data.js';

/**
 * Party invoices' demo data (LIN-27): who sells, from where.
 *
 * An invoice's seller is the GST registration of the site its trips' sheets
 * are at (core.gst_registrations behind core.sites in the API). The two
 * crushers bill under their own companies, each with its own number series;
 * the quarry has no registration of its own, so a trip kept there cannot be
 * invoiced until one is set. The GSTINs carry the real check character
 * (buildGstin), so the screens show what the GST portal would accept.
 *
 * The invoices themselves are not data here: the demo store makes them from
 * the trip sheets by the same rules a person's clicks follow
 * (apps/web/src/features/vehicle-pl/invoiceStore.ts).
 */

export interface PlSellerRegistration {
  id: string;
  /** The sites that sell under it. */
  siteIds: string[];
  legalName: string;
  tradeName: string;
  gstin: string;
  /** Where its numbers start: KBM/26-27/0001. */
  prefix: string;
  /** The place of business, as the invoice prints it. */
  address: string;
}

export const PL_SELLERS: PlSellerRegistration[] = [
  {
    id: 'gst-kbm',
    siteIds: ['site-krp', 'site-wsp'],
    legalName: 'Karapakkam Blue Metals Pvt Ltd',
    tradeName: 'KBM Blue Metals',
    gstin: buildGstin('33', 'AABCK4521P'),
    prefix: 'KBM',
    address: 'S.No. 112/4, Karapakkam Main Road, Karapakkam, Chennai - 600097',
  },
  {
    id: 'gst-tal',
    siteIds: ['site-tvl'],
    legalName: 'Thiruvallur Aggregates LLP',
    tradeName: '',
    gstin: buildGstin('33', 'AAGCT9182M'),
    prefix: 'TAL',
    address: 'Plot 7, SIDCO Industrial Estate, Kakkalur, Thiruvallur - 602003',
  },
];

export function sellerOfSite(siteId: string): PlSellerRegistration | null {
  return PL_SELLERS.find((s) => s.siteIds.includes(siteId)) ?? null;
}

export function siteName(siteId: string): string {
  return SITES.find((s) => s.id === siteId)?.name ?? siteId;
}
