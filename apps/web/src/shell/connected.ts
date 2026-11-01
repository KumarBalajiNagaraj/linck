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

export type Connection =
  /** On the API: the company's own data. */
  | 'api'
  /** Sample data, but for its bill counts, which are the API's. */
  | 'bills'
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
  // LIN-10: the news digest is built on the server.
  '/overview/industry': 'api',
  // The fleet board's "bills to check" is the API's; its other counts are not yet.
  '/fleet/board': 'bills',
};

export function connectionOf(route: string): Connection {
  return CONNECTED[route] ?? 'sample';
}
