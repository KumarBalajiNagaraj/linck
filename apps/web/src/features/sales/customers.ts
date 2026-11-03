import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { can } from '@linck/domain';
import { CUSTOMERS_MASTER, invoicesForSite, isInvoiceOverdue, purchaseOrdersForSite, SITES, tripsForSite, type Customer } from '@linck/mock';
import { LIVE } from '../../auth/api.js';
import { demoRecords, keepRecords, rereadRecords, useLiveRecords, type Records } from '../../shell/liveRecords.js';
import { problemOf, type RecordProblem } from '../../shell/recordApi.js';
import { useApp } from '../../shell/store.js';
import { useSites, type Move } from '../expenses/bills.js';
import { OPEN_ORDER, ordersAt, useOrders } from './orders.js';
import { CUSTOMERS, fetchCustomers, ORDERS, patchCustomer, postCustomer, type CustomerBody, type CustomerPatchBody } from './salesApi.js';

/**
 * WHERE THE CUSTOMERS COME FROM — picked once, here, by the mode, as
 * expenses/bills.ts picks the bills.
 *
 *   DEMO: the sample customer master, with what each owes from the sample
 *     invoices, exactly as the customer screen has always shown it.
 *   LIVE: `GET /customers` through one cache (shell/liveRecords.ts), and an
 *     added or changed customer a request. Invoices are not on the API yet,
 *     so live there is no money due to show and none is made up: the rows
 *     say `outstanding: null`, and the screen leaves those columns out.
 *
 * The demo has no way to add or change a customer, so those moves are null
 * there and the screen offers neither.
 */

/** Every customer this person may read. The master is read org-wide: "served from" is a fact about them, not a filter. */
export const useCustomers: () => Records<Customer> = LIVE ? useLiveCustomers : () => demoRecords(CUSTOMERS_MASTER);

function useLiveCustomers(): Records<Customer> {
  const persona = useApp((s) => s.persona);
  return useLiveRecords(CUSTOMERS, persona.key, can(persona.grants, 'sales.customer.read'), fetchCustomers);
}

/* ------------------------------------------------------------ the rows */

/** One row of the customer screen. */
export interface CustomerRow {
  customer: Customer;
  /** What they owe on invoices sent. Null where invoices are not known (live, until they are on the API). */
  outstanding: number | null;
  overdueCount: number | null;
  /** Orders waiting approval or loading. Null where this person cannot read orders. */
  openOrders: number | null;
  /** The site they are served from. Null live for a site this person is not scoped to. */
  siteName: string | null;
}

export interface CustomerRows extends Records<CustomerRow> {
  /** Money due and overdue invoices are known. */
  dues: boolean;
  /** Open orders are known. */
  orderCounts: boolean;
}

/**
 * The demo, as it has always been: at a site, the customers with a load, an
 * invoice or an order there, so a customer counted on the sales board is
 * always findable here.
 */
function useDemoCustomerRows(siteScope: string | null): CustomerRows {
  const rows = useMemo<CustomerRow[]>(() => {
    const invoices = invoicesForSite(siteScope);
    const orders = purchaseOrdersForSite(siteScope);
    const trips = tripsForSite(siteScope);
    const active = new Set([...invoices, ...orders, ...trips].map((x) => x.customerId));
    return CUSTOMERS_MASTER.filter((c) => siteScope === null || active.has(c.id)).map((c) => {
      const theirs = invoices.filter((i) => i.customerId === c.id && i.status !== 'draft' && i.status !== 'closed');
      return {
        customer: c,
        outstanding: theirs.reduce((s, i) => s + Number.parseFloat(i.balanceDue), 0),
        overdueCount: theirs.filter(isInvoiceOverdue).length,
        openOrders: orders.filter((p) => p.customerId === c.id && OPEN_ORDER.includes(p.status)).length,
        siteName: SITES.find((s) => s.id === c.servedFromSiteId)?.name ?? '–',
      };
    });
  }, [siteScope]);
  return { ...demoRecords(rows), dues: true, orderCounts: true };
}

/**
 * Live, loads and invoices are not on the API, so at a site the list is the
 * customers served from it and those with an order there. A customer just
 * added is served from a site, so it is never lost from its own site's list.
 */
function useLiveCustomerRows(siteScope: string | null): CustomerRows {
  const customers = useCustomers();
  const orders = useOrders();
  const sites = useSites();
  const grants = useApp((s) => s.persona.grants);
  const orderCounts = can(grants, 'sales.order.read');
  const rows = useMemo<CustomerRow[]>(() => {
    const here = ordersAt(orders.rows, siteScope);
    const active = new Set(here.map((p) => p.customerId));
    return customers.rows
      .filter((c) => siteScope === null || c.servedFromSiteId === siteScope || active.has(c.id))
      .map((c) => ({
        customer: c,
        outstanding: null,
        overdueCount: null,
        openOrders: orderCounts ? here.filter((p) => p.customerId === c.id && OPEN_ORDER.includes(p.status)).length : null,
        siteName: sites.find((s) => s.id === c.servedFromSiteId)?.name ?? null,
      }));
  }, [customers.rows, orders.rows, siteScope, sites, orderCounts]);
  // Both lists are needed for a row: the screen waits for, or fails on, either.
  const waiting = [customers, ...(orderCounts ? [orders] : [])];
  const failed = waiting.find((l) => l.state === 'failed');
  return {
    rows,
    asOf: customers.asOf,
    state: failed ? 'failed' : waiting.some((l) => l.state === 'loading') ? 'loading' : 'ready',
    problem: failed?.problem ?? null,
    retry: () => waiting.forEach((l) => l.retry()),
    dues: false,
    orderCounts,
  };
}

/** The customer screen's rows at a scope. */
export const useCustomerRows: (siteScope: string | null) => CustomerRows = LIVE ? useLiveCustomerRows : useDemoCustomerRows;

/* --------------------------------------------------------------- moves */

function useLiveAddCustomer(): Move<CustomerBody, RecordProblem | null> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({ mutationFn: postCustomer });
  return {
    busy: mutation.isPending,
    run: async (body) => {
      try {
        keepRecords(client, CUSTOMERS, who, [await mutation.mutateAsync(body)]);
        return null;
      } catch (err) {
        return problemOf(err);
      }
    },
  };
}

/** A new customer, served from one of our sites. Null in the demo. */
export const useAddCustomer: () => Move<CustomerBody, RecordProblem | null> | null = LIVE ? useLiveAddCustomer : () => null;

export interface ChangeArgs {
  customer: Customer;
  /** Only what changed. */
  patch: CustomerPatchBody;
}

function useLiveChangeCustomer(): Move<ChangeArgs, RecordProblem | null> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({ mutationFn: ({ customer, patch }: ChangeArgs) => patchCustomer(customer.id, patch) });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        keepRecords(client, CUSTOMERS, who, [await mutation.mutateAsync(args)]);
        // An order carries its customer's name as the API reads it now.
        if (args.patch.name !== undefined) rereadRecords(client, ORDERS);
        return null;
      } catch (err) {
        rereadRecords(client, CUSTOMERS);
        return problemOf(err);
      }
    },
  };
}

/** A change to a customer, field by field. Null in the demo. */
export const useChangeCustomer: () => Move<ChangeArgs, RecordProblem | null> | null = LIVE ? useLiveChangeCustomer : () => null;
