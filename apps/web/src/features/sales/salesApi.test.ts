import { describe, expect, it } from 'vitest';
import { buildGstin } from '@linck/domain';
import type { Customer } from '@linck/mock';
import {
  customerBody,
  customerDraft,
  customerFromApi,
  customerGaps,
  customerPatch,
  orderBody,
  orderDraft,
  orderFromApi,
  orderGaps,
  type ApiCustomer,
  type ApiOrder,
} from './salesApi.js';

/** A customer exactly as `GET /customers` sends it (apps/api/tests/test_sales_api.py CUSTOMER_KEYS). */
function apiCustomer(over: Partial<ApiCustomer> = {}): ApiCustomer {
  return {
    id: '0b6f3c5e-6d1a-4a8e-9c2b-7e5d4f3a2b10',
    name: 'Casagrand Builder',
    site: 'Sholinganallur Phase 2',
    gstin: buildGstin('33', 'AACCA1234K'),
    contactName: 'Arun Prakash',
    phone: '9840012345',
    creditLimit: '2500000.00',
    paymentTermsDays: 30,
    servedFromSiteId: '5b1d6c0e-91a4-4f3e-8a77-0c2b3e4d5f60',
    ...over,
  };
}

/** An order exactly as `GET /purchase-orders` sends it (PURCHASE_ORDER_KEYS). */
function apiOrder(over: Partial<ApiOrder> = {}): ApiOrder {
  return {
    id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    number: 'SO/26-27/001',
    customerPoRef: 'PO-CAS-7781',
    receivedOn: '2026-11-01T05:12:09Z',
    deliverBy: '2026-11-07T18:30:00Z',
    customerId: '0b6f3c5e-6d1a-4a8e-9c2b-7e5d4f3a2b10',
    customerName: 'Casagrand Builder',
    deliverySite: 'Sholinganallur Phase 2',
    siteId: '5b1d6c0e-91a4-4f3e-8a77-0c2b3e4d5f60',
    productCode: 'MSAND',
    orderedUnits: 40,
    dispatchedUnits: 0,
    ratePerUnit: '4825.50',
    value: '193020.00',
    status: 'pending_approval',
    takenBy: 'Vetrivel S',
    ...over,
  };
}

const PLANT = '5b1d6c0e-91a4-4f3e-8a77-0c2b3e4d5f60';
const OTHER = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';

describe('a customer and an order from the API, as the screens read them', () => {
  it('keeps every field of a customer as the API sends it', () => {
    const row = apiCustomer();
    expect(customerFromApi(row)).toEqual(row);
    expect(customerFromApi(apiCustomer({ gstin: null })).gstin).toBeNull();
  });

  it('keeps every field of an order as the API sends it', () => {
    const row = apiOrder({ status: 'part_dispatched', dispatchedUnits: 12.5 });
    expect(orderFromApi(row)).toEqual(row);
  });
});

describe('the customer form', () => {
  const blank = customerDraft(null, PLANT);

  it('starts a new customer at the site given, with nothing else filled', () => {
    expect(blank).toEqual({ name: '', site: '', gstin: '', contactName: '', phone: '', creditLimit: '', paymentTermsDays: '', servedFromSiteId: PLANT });
    expect(customerGaps(blank, [PLANT])).toEqual(['name']);
  });

  it('asks for a real GST number or none, and our site, and readable terms', () => {
    const good = buildGstin('33', 'AACCA1234K');
    const bad = good.slice(0, 14) + (good[14] === '0' ? '1' : '0');
    const d = { ...blank, name: 'Casagrand' };
    expect(customerGaps({ ...d, gstin: bad }, [PLANT])).toEqual(['gstin']);
    expect(customerGaps({ ...d, gstin: good.toLowerCase() }, [PLANT])).toEqual([]);
    expect(customerGaps(d, [OTHER])).toEqual(['ourSite']);
    expect(customerGaps({ ...d, paymentTermsDays: '400' }, [PLANT])).toEqual(['creditDays']);
    expect(customerGaps({ ...d, paymentTermsDays: '-1' }, [PLANT])).toEqual(['creditDays']);
    expect(customerGaps({ ...d, creditLimit: '12.500,00' }, [PLANT])).toEqual(['creditLimit']);
  });

  it('sends a new customer with the GST number in capitals, a blank one as none, and the terms as numbers', () => {
    const good = buildGstin('33', 'AACCA1234K');
    expect(
      customerBody({ ...blank, name: '  Casagrand  ', gstin: ` ${good.toLowerCase()} `, creditLimit: '25,00,000', paymentTermsDays: '30', phone: ' 98400 12345 ' }),
    ).toEqual({
      name: 'Casagrand',
      site: '',
      gstin: good,
      contactName: '',
      phone: '98400 12345',
      creditLimit: '2500000.00',
      paymentTermsDays: 30,
      servedFromSiteId: PLANT,
    });
    // A walk-in counter customer: no GST number, no credit.
    expect(customerBody({ ...blank, name: 'Counter sale' })).toMatchObject({ gstin: null, creditLimit: '0.00', paymentTermsDays: 0 });
  });

  it('sends a change of only the fields that changed', () => {
    const before: Customer = customerFromApi(apiCustomer());
    const same = customerBody(customerDraft(before, PLANT));
    expect(customerPatch(before, same)).toEqual({});
    const after = customerBody({ ...customerDraft(before, PLANT), creditLimit: '30,00,000.50', paymentTermsDays: '45', gstin: '' });
    expect(customerPatch(before, after)).toEqual({ creditLimit: '3000000.50', paymentTermsDays: 45, gstin: null });
    expect(customerPatch(before, { ...same, servedFromSiteId: OTHER })).toEqual({ servedFromSiteId: OTHER });
  });
});

describe('the order form', () => {
  const customers = [customerFromApi(apiCustomer()), customerFromApi(apiCustomer({ id: 'no-site', name: 'Walk-in', site: '' }))];
  const today = '2026-11-01';
  const ctx = { customers, sites: [PLANT], products: ['MSAND', 'AGG20'], today };
  const filled = {
    ...orderDraft(PLANT, today),
    customerId: customers[0]!.id,
    customerPoRef: ' PO-CAS-7781 ',
    productCode: 'MSAND',
    units: '40',
    rate: '4,825.50',
    deliverBy: '2026-11-08',
  };

  it('starts blank at the site given, to be delivered today', () => {
    expect(orderDraft(PLANT, today)).toEqual({ customerId: '', customerPoRef: '', productCode: '', units: '', rate: '', deliverBy: today, deliverySite: '', siteId: PLANT });
    expect(orderGaps(orderDraft(PLANT, today), ctx)).toEqual(['customer', 'ref', 'material', 'units', 'rate']);
    expect(orderGaps(filled, ctx)).toEqual([]);
  });

  it('refuses what the API or the database would: no units, no rate, a day gone, a site not ours', () => {
    expect(orderGaps({ ...filled, units: '0' }, ctx)).toEqual(['units']);
    expect(orderGaps({ ...filled, units: '12.3456' }, ctx)).toEqual(['units']);
    // The database refuses a rate of nothing outright (rate_positive).
    expect(orderGaps({ ...filled, rate: '0' }, ctx)).toEqual(['rate']);
    expect(orderGaps({ ...filled, deliverBy: '2026-10-31' }, ctx)).toEqual(['deliverBy']);
    expect(orderGaps({ ...filled, deliverBy: '' }, ctx)).toEqual(['deliverBy']);
    expect(orderGaps({ ...filled, productCode: 'GOLD' }, ctx)).toEqual(['material']);
    expect(orderGaps({ ...filled, siteId: OTHER }, ctx)).toEqual(['ourSite']);
  });

  it('asks where to deliver only for a customer with no usual site', () => {
    expect(orderGaps({ ...filled, customerId: 'no-site' }, ctx)).toEqual(['deliverTo']);
    expect(orderGaps({ ...filled, customerId: 'no-site', deliverySite: 'Kelambakkam' }, ctx)).toEqual([]);
  });

  it('sends the order with its day as IST midnight, units as a number and the rate in rupees', () => {
    expect(orderBody(filled)).toEqual({
      customerPoRef: 'PO-CAS-7781',
      deliverBy: '2026-11-07T18:30:00.000Z',
      customerId: customers[0]!.id,
      siteId: PLANT,
      productCode: 'MSAND',
      orderedUnits: 40,
      ratePerUnit: '4825.50',
    });
    // Left blank, "deliver to" is not sent, and the API names the customer's usual site.
    expect(orderBody(filled)).not.toHaveProperty('deliverySite');
    expect(orderBody({ ...filled, deliverySite: ' Kelambakkam ', units: '12.5' })).toMatchObject({ deliverySite: 'Kelambakkam', orderedUnits: 12.5 });
    // Who took it, its number, value and status are the server's to say.
    for (const key of ['number', 'value', 'status', 'takenBy', 'receivedOn']) expect(orderBody(filled)).not.toHaveProperty(key);
  });
});
