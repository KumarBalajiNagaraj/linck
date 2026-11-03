/**
 * Which screens read and write the company's own data, in live mode.
 *
 * Live (VITE_API_URL set), a signed-in person must never read the demo's
 * sample numbers as their company's. Every screen not listed here still
 * renders @linck/mock, so the router puts the sample-data banner at its top
 * (router.tsx, SampleBanner.tsx). A screen comes off the banner by being
 * added here in the same change that puts it on the API — and a new screen
 * gets the banner without anyone remembering to ask for it.
 *
 * Keyed by the router's own path, so screens outside the menu are covered too.
 * The demo shows no banner anywhere: all of it is sample data, and it says so
 * by being the demo.
 */

/** A count on a board that is the API's while the rest of the board is not. */
export type RealPart = 'bills' | 'breakdowns' | 'orders';

export type Connection =
  /** On the API: the company's own data. */
  | 'api'
  /** Sample data, but for the counts named, which are the API's. */
  | { except: readonly RealPart[] }
  /** Sample data. */
  | 'sample';

const CONNECTED: Readonly<Record<string, Connection>> = {
  // The expense chain (LIN-21): upload, read, check, approve, pass, pay.
  '/fleet/expenses': 'api',
  '/stores/expenses': 'api',
  '/finance/expenses': 'api',
  '/overview/expenses': 'api',
  '/fleet/diesel-summary': 'api',
  '/fleet/whatsapp': 'api',
  // LIN-21: customers, their orders and the breakdown register. A customer's
  // money due comes from invoices, which are not on the API yet: live, the
  // customer screen leaves it out rather than show the sample figure.
  '/sales/customers': 'api',
  '/sales/orders': 'api',
  '/fleet/breakdowns': 'api',
  // LIN-21: the vehicle P&L — trip sheets, their trips and lines, and the
  // profit reports — on /vehicle-pl.
  '/fleet/pl': 'api',
  '/fleet/pl/new': 'api',
  '/fleet/pl/sheets/$sheetId': 'api',
  '/overview/pl': 'api',
  '/finance/pl': 'api',
  // LIN-21: the trip invoices made from those trips (LIN-27), on /vehicle-pl/invoices.
  '/fleet/pl/invoices': 'api',
  '/fleet/pl/invoices/$invoiceId': 'api',
  '/finance/invoices': 'api',
  '/finance/invoices/$invoiceId': 'api',
  // LIN-10: the news digest is built on the server.
  '/overview/industry': 'api',
  // The boards: these counts are the API's; their other counts are not yet.
  '/fleet/board': { except: ['bills', 'breakdowns'] },
  '/sales/board': { except: ['orders'] },
};

export function connectionOf(route: string): Connection {
  return CONNECTED[route] ?? 'sample';
}
