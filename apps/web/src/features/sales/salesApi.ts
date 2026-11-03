import { isValidGstin, parseTypedAmount } from '@linck/domain';
import type { Customer, PurchaseOrder } from '@linck/mock';
import { call, readJson, sendJson } from '../../shell/recordApi.js';

/**
 * THE CUSTOMERS AND THEIR ORDERS ON THE API, for live mode (VITE_API_URL set).
 *
 *   GET   /customers                     every customer, read org-wide
 *   POST  /customers                     a new one, served from one of our sites
 *   PATCH /customers/{id}                a change, field by field
 *   GET   /purchase-orders               every order at the sites this person may read, newest first
 *   POST  /purchase-orders               an order as taken: numbered, waiting on approval
 *   POST  /purchase-orders/{id}/approve  the decision that lets it load
 *   POST  /purchase-orders/{id}/reject   turned down, with the reason; final
 *
 * (apps/api/app/api/customers.py, purchase_orders.py.) The API answers in the
 * screens' own Customer and PurchaseOrder shapes, field for field, so the
 * mapping below only names every field it carries over. What the forms send
 * is worked out here from what was typed, read as strictly as a bill's
 * figures: "1,50,000" is a lakh and a half, and a figure that cannot be read
 * is a gap in the form, never a guess.
 *
 * Refusals come back as shell/recordApi.ts's RecordProblem; the screens word
 * them (words.ts `problem`). No React here: the tests call these directly.
 */

/** The two lists' names in the cache (shell/liveRecords.ts). */
export const CUSTOMERS = 'customers';
export const ORDERS = 'purchase-orders';

/** CustomerOut (apps/api/app/schemas/sales.py). It is Customer already; restated so the mapping names every field. */
export type ApiCustomer = Customer;

/** PurchaseOrderOut. It is PurchaseOrder already, with `status` a plain string the database holds to the five. */
export type ApiOrder = Omit<PurchaseOrder, 'status'> & { status: string };

export function customerFromApi(row: ApiCustomer): Customer {
  return {
    id: row.id,
    name: row.name,
    site: row.site,
    gstin: row.gstin,
    contactName: row.contactName,
    phone: row.phone,
    creditLimit: row.creditLimit,
    paymentTermsDays: row.paymentTermsDays,
    servedFromSiteId: row.servedFromSiteId,
  };
}

export function orderFromApi(row: ApiOrder): PurchaseOrder {
  return {
    id: row.id,
    number: row.number,
    customerPoRef: row.customerPoRef,
    receivedOn: row.receivedOn,
    deliverBy: row.deliverBy,
    customerId: row.customerId,
    customerName: row.customerName,
    deliverySite: row.deliverySite,
    siteId: row.siteId,
    productCode: row.productCode,
    orderedUnits: row.orderedUnits,
    dispatchedUnits: row.dispatchedUnits,
    ratePerUnit: row.ratePerUnit,
    value: row.value,
    status: row.status as PurchaseOrder['status'],
    takenBy: row.takenBy,
  };
}

/* ------------------------------------------------------------- requests */

export function fetchCustomers(signal?: AbortSignal): Promise<Customer[]> {
  return call('/customers', readJson(signal), (body) => (body as ApiCustomer[]).map(customerFromApi));
}

export function postCustomer(body: CustomerBody): Promise<Customer> {
  return call('/customers', sendJson('POST', body), (b) => customerFromApi(b as ApiCustomer));
}

export function patchCustomer(customerId: string, body: CustomerPatchBody): Promise<Customer> {
  return call(`/customers/${encodeURIComponent(customerId)}`, sendJson('PATCH', body), (b) => customerFromApi(b as ApiCustomer));
}

export function fetchOrders(signal?: AbortSignal): Promise<PurchaseOrder[]> {
  return call('/purchase-orders', readJson(signal), (body) => (body as ApiOrder[]).map(orderFromApi));
}

export function postOrder(body: OrderBody): Promise<PurchaseOrder> {
  return call('/purchase-orders', sendJson('POST', body), (b) => orderFromApi(b as ApiOrder));
}

export type Decision = 'approve' | 'reject';

/** DecisionIn: a reason is required to reject, and kept with the decision either way. */
export function decideOrder(orderId: string, decision: Decision, reason: string | null): Promise<PurchaseOrder> {
  return call(`/purchase-orders/${encodeURIComponent(orderId)}/${decision}`, sendJson('POST', { reason: reason?.trim() || null }), (b) =>
    orderFromApi(b as ApiOrder),
  );
}

/* ------------------------------------------------------ the customer form */

/** The customer form, as typed. */
export interface CustomerDraft {
  name: string;
  /** Where their lorries usually go: the default delivery site named on orders. */
  site: string;
  /** Blank for a walk-in customer, who is billed without one. */
  gstin: string;
  contactName: string;
  phone: string;
  /** Rupees, as typed. Blank is no credit. */
  creditLimit: string;
  /** Days, as typed. Blank or 0 is cash. */
  paymentTermsDays: string;
  servedFromSiteId: string;
}

/** What a customer draft still needs, by what the person must fix. Worded by the screen. */
export type CustomerGap = 'name' | 'gstin' | 'ourSite' | 'creditLimit' | 'creditDays';

/** CustomerIn. */
export interface CustomerBody {
  name: string;
  site: string;
  gstin: string | null;
  contactName: string;
  phone: string;
  creditLimit: string;
  paymentTermsDays: number;
  servedFromSiteId: string;
}

/** CustomerPatch: only what changed. `gstin: null` makes a customer walk-in. */
export type CustomerPatchBody = Partial<CustomerBody>;

/** The form for a new customer at a site, or for changing one. */
export function customerDraft(customer: Customer | null, siteId: string): CustomerDraft {
  return customer
    ? {
        name: customer.name,
        site: customer.site,
        gstin: customer.gstin ?? '',
        contactName: customer.contactName,
        phone: customer.phone,
        creditLimit: customer.creditLimit,
        paymentTermsDays: String(customer.paymentTermsDays),
        servedFromSiteId: customer.servedFromSiteId,
      }
    : { name: '', site: '', gstin: '', contactName: '', phone: '', creditLimit: '', paymentTermsDays: '', servedFromSiteId: siteId };
}

const gstinOf = (typed: string) => typed.trim().toUpperCase();
const creditLimitOf = (typed: string) => (typed.trim() === '' ? 0 : parseTypedAmount(typed));
const creditDaysOf = (typed: string): number | null => {
  const t = typed.trim();
  if (t === '') return 0;
  return /^\d{1,3}$/.test(t) && Number(t) <= 365 ? Number(t) : null;
};

/** What stops the draft being saved, in the form's order. `sites` are where this person may add or keep a customer. */
export function customerGaps(d: CustomerDraft, sites: readonly string[]): CustomerGap[] {
  const gaps: CustomerGap[] = [];
  if (!d.name.trim()) gaps.push('name');
  const gstin = gstinOf(d.gstin);
  if (gstin && !isValidGstin(gstin)) gaps.push('gstin');
  if (!sites.includes(d.servedFromSiteId)) gaps.push('ourSite');
  if (creditDaysOf(d.paymentTermsDays) === null) gaps.push('creditDays');
  if (creditLimitOf(d.creditLimit) === null) gaps.push('creditLimit');
  return gaps;
}

/** A draft with no gaps, as `POST /customers` takes it. */
export function customerBody(d: CustomerDraft): CustomerBody {
  const gstin = gstinOf(d.gstin);
  return {
    name: d.name.trim(),
    site: d.site.trim(),
    gstin: gstin || null,
    contactName: d.contactName.trim(),
    phone: d.phone.trim(),
    creditLimit: (creditLimitOf(d.creditLimit) ?? 0).toFixed(2),
    paymentTermsDays: creditDaysOf(d.paymentTermsDays) ?? 0,
    servedFromSiteId: d.servedFromSiteId,
  };
}

/** The fields a change touched, as `PATCH /customers/{id}` takes them. Nothing sent is nothing changed. */
export function customerPatch(before: Customer, after: CustomerBody): CustomerPatchBody {
  const patch: CustomerPatchBody = {};
  if (after.name !== before.name) patch.name = after.name;
  if (after.site !== before.site) patch.site = after.site;
  if (after.gstin !== before.gstin) patch.gstin = after.gstin;
  if (after.contactName !== before.contactName) patch.contactName = after.contactName;
  if (after.phone !== before.phone) patch.phone = after.phone;
  // Compared as rupees: "2500000" and "2500000.00" are the same limit.
  if (Number(after.creditLimit) !== Number(before.creditLimit)) patch.creditLimit = after.creditLimit;
  if (after.paymentTermsDays !== before.paymentTermsDays) patch.paymentTermsDays = after.paymentTermsDays;
  if (after.servedFromSiteId !== before.servedFromSiteId) patch.servedFromSiteId = after.servedFromSiteId;
  return patch;
}

/* --------------------------------------------------------- the order form */

/** The order form, as typed. */
export interface OrderDraft {
  customerId: string;
  /** The customer's own order number, as written on their paper. */
  customerPoRef: string;
  productCode: string;
  /** Units (100 cubic feet), as typed. */
  units: string;
  /** Rupees a unit, as typed. */
  rate: string;
  /** The calendar date, YYYY-MM-DD. */
  deliverBy: string;
  /** Where the lorry goes. Blank is the customer's usual site. */
  deliverySite: string;
  siteId: string;
}

export type OrderGap = 'customer' | 'ref' | 'material' | 'units' | 'rate' | 'deliverBy' | 'deliverTo' | 'ourSite';

/** PurchaseOrderIn. Who took it, its number, its value and its status are the server's to say. */
export interface OrderBody {
  customerPoRef: string;
  deliverBy: string;
  customerId: string;
  deliverySite?: string;
  siteId: string;
  productCode: string;
  orderedUnits: number;
  ratePerUnit: string;
}

export function orderDraft(siteId: string, today: string): OrderDraft {
  return { customerId: '', customerPoRef: '', productCode: '', units: '', rate: '', deliverBy: today, deliverySite: '', siteId };
}

/** Units: more than none, at most three decimals, as the API keeps them. */
export const unitsOf = (typed: string): number | null => {
  const n = parseTypedAmount(typed, 3);
  return n !== null && n > 0 && n < 1_000_000_000 ? n : null;
};
/** A rate: more than nothing. The database refuses a free order outright. */
export const rateOf = (typed: string): number | null => {
  const n = parseTypedAmount(typed);
  return n !== null && n > 0 ? n : null;
};

/** IST midnight of a calendar date, as the API carries a day. */
const istMidnight = (day: string) => new Date(`${day}T00:00:00+05:30`).toISOString();
const isDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00+05:30`));

export function orderGaps(
  d: OrderDraft,
  { customers, sites, products, today }: { customers: readonly Customer[]; sites: readonly string[]; products: readonly string[]; today: string },
): OrderGap[] {
  const customer = customers.find((c) => c.id === d.customerId);
  const gaps: OrderGap[] = [];
  if (!customer) gaps.push('customer');
  if (!d.customerPoRef.trim()) gaps.push('ref');
  if (!products.includes(d.productCode)) gaps.push('material');
  if (unitsOf(d.units) === null) gaps.push('units');
  if (rateOf(d.rate) === null) gaps.push('rate');
  // A lorry promised for a day already gone is a typing slip.
  if (!isDay(d.deliverBy) || d.deliverBy < today) gaps.push('deliverBy');
  if (customer && !d.deliverySite.trim() && !customer.site.trim()) gaps.push('deliverTo');
  if (!sites.includes(d.siteId)) gaps.push('ourSite');
  return gaps;
}

/** A draft with no gaps, as `POST /purchase-orders` takes it. */
export function orderBody(d: OrderDraft): OrderBody {
  const deliverySite = d.deliverySite.trim();
  return {
    customerPoRef: d.customerPoRef.trim(),
    deliverBy: istMidnight(d.deliverBy),
    customerId: d.customerId,
    // Left out, the API names the customer's usual site.
    ...(deliverySite ? { deliverySite } : {}),
    siteId: d.siteId,
    productCode: d.productCode,
    orderedUnits: unitsOf(d.units) ?? 0,
    ratePerUnit: (rateOf(d.rate) ?? 0).toFixed(2),
  };
}
