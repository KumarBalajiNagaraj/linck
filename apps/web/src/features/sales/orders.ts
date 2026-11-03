import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { can } from '@linck/domain';
import { PURCHASE_ORDERS, type PurchaseOrder } from '@linck/mock';
import { LIVE } from '../../auth/api.js';
import { demoRecords, keepRecords, rereadRecords, useLiveRecords, type Records } from '../../shell/liveRecords.js';
import { problemOf, type RecordProblem } from '../../shell/recordApi.js';
import { useApp } from '../../shell/store.js';
import type { Move } from '../expenses/bills.js';
import { CUSTOMERS, decideOrder, fetchOrders, ORDERS, postOrder, type Decision, type OrderBody } from './salesApi.js';

/**
 * WHERE THE ORDERS COME FROM — picked once, here, by the mode the app was
 * built in (auth/api.ts), as expenses/bills.ts picks the bills.
 *
 *   DEMO: the sample orders, @linck/mock, as they have always been. A
 *     decision lasts as long as the screen that took it, and is never
 *     written back: leave the orders screen and the order waits again.
 *   LIVE: `GET /purchase-orders` through one cache (shell/liveRecords.ts),
 *     and each decision a request. The API decides who may approve, and
 *     refuses an order that has been decided meanwhile; the screen shows why.
 *
 * Every hook has one shape in both modes. A move answers with why it did not
 * go through, or null. The demo has no way to take an order, so
 * `useAddOrder` is null there and the screen offers none.
 */

/** Orders a sales manager still has to look at, or that are loading now. Not done, not turned down. */
export const OPEN_ORDER: readonly PurchaseOrder['status'][] = ['pending_approval', 'approved', 'part_dispatched'];

/** Orders at one site, or every site: the list the orders screen shows and the sales board counts. */
export function ordersAt(orders: readonly PurchaseOrder[], siteId: string | null): PurchaseOrder[] {
  return siteId ? orders.filter((p) => p.siteId === siteId) : [...orders];
}

export interface DecideArgs {
  order: PurchaseOrder;
  decision: Decision;
  /** Required to reject. */
  reason?: string;
}

export interface OrderBook extends Records<PurchaseOrder> {
  /** Approve or reject one order waiting approval. */
  decide: Move<DecideArgs, RecordProblem | null>;
  /** Rejecting asks why. The API keeps the reason and refuses a rejection without one; the demo never asked. */
  reasonToReject: boolean;
}

function useDemoOrders(): OrderBook {
  /** Decisions taken on this screen, not written back. */
  const [decided, setDecided] = useState<Record<string, PurchaseOrder['status']>>({});
  const rows = useMemo(() => PURCHASE_ORDERS.map((p) => (decided[p.id] ? { ...p, status: decided[p.id]! } : p)), [decided]);
  return {
    ...demoRecords(rows),
    reasonToReject: false,
    decide: {
      busy: false,
      run: async ({ order, decision }) => {
        setDecided((d) => ({ ...d, [order.id]: decision === 'approve' ? 'approved' : 'rejected' }));
        return null;
      },
    },
  };
}

function useLiveOrders(): OrderBook {
  const persona = useApp((s) => s.persona);
  const client = useQueryClient();
  const list = useLiveRecords(ORDERS, persona.key, can(persona.grants, 'sales.order.read'), fetchOrders);
  const mutation = useMutation({ mutationFn: ({ order, decision, reason }: DecideArgs) => decideOrder(order.id, decision, reason ?? null) });
  return {
    ...list,
    reasonToReject: true,
    decide: {
      busy: mutation.isPending,
      run: async (args) => {
        try {
          keepRecords(client, ORDERS, persona.key, [await mutation.mutateAsync(args)]);
          return null;
        } catch (err) {
          // Decided by someone else meanwhile, say: read again, so the screen shows where it is.
          rereadRecords(client, ORDERS);
          return problemOf(err);
        }
      },
    },
  };
}

/** Every order this person may read, at every site; screens cut it to the scope with `ordersAt`. */
export const useOrders: () => OrderBook = LIVE ? useLiveOrders : useDemoOrders;

function useLiveAddOrder(): Move<OrderBody, RecordProblem | null> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({ mutationFn: postOrder });
  return {
    busy: mutation.isPending,
    run: async (body) => {
      try {
        keepRecords(client, ORDERS, who, [await mutation.mutateAsync(body)]);
        return null;
      } catch (err) {
        const problem = problemOf(err);
        if (problem.code !== 'gone') return problem;
        // The only record an order is made against is its customer: gone from the list since it was read.
        rereadRecords(client, CUSTOMERS);
        return { code: 'invalid', field: 'customerId', reason: 'not found' };
      }
    },
  };
}

/** Taking an order as the customer gave it. Null in the demo, which has only its sample orders. */
export const useAddOrder: () => Move<OrderBody, RecordProblem | null> | null = LIVE ? useLiveAddOrder : () => null;
