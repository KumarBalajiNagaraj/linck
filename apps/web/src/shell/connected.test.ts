import { describe, expect, it } from 'vitest';
import { connectionOf } from './connected.js';
import { WORKSPACES } from './nav-manifest.js';
import { shellWords } from './words.js';

const TAMIL = /[஀-௿]/;

describe('which live screens say "sample data"', () => {
  it('leaves the screens on the API without the banner', () => {
    for (const route of [
      '/fleet/expenses',
      '/stores/expenses',
      '/finance/expenses',
      '/overview/expenses',
      '/fleet/diesel-summary',
      '/fleet/whatsapp',
      '/overview/industry',
      '/sales/customers',
      '/sales/orders',
      '/fleet/breakdowns',
      '/fleet/pl',
      '/fleet/pl/new',
      '/fleet/pl/sheets/$sheetId',
      '/overview/pl',
      '/finance/pl',
      '/fleet/pl/invoices',
      '/fleet/pl/invoices/$invoiceId',
      '/finance/invoices',
      '/finance/invoices/$invoiceId',
    ]) {
      expect(connectionOf(route), route).toBe('api');
    }
  });

  it('marks each board as sample data but for the counts that are the API\'s', () => {
    expect(connectionOf('/fleet/board')).toEqual({ except: ['bills', 'breakdowns'] });
    expect(connectionOf('/sales/board')).toEqual({ except: ['orders'] });
  });

  it('marks every other menu page, and any page it has never heard of, as sample data', () => {
    const others = WORKSPACES.flatMap((ws) => ws.items.map((i) => i.route)).filter((r) => connectionOf(r) === 'sample');
    expect(others).toContain('/overview');
    expect(others).toContain('/fleet/vehicles');
    expect(others).toContain('/sales/invoices');
    expect(others).toContain('/sales/dispatch');
    // Sales' own invoice ledger is not the trip invoices: still sample data.
    expect(connectionOf('/sales/invoices')).toBe('sample');
  });

  it('says so in both languages', () => {
    const en = shellWords.en.sample;
    const ta = shellWords.ta.sample;
    expect(en.lead).toBe('Sample data.');
    expect(en.notConnected).toBe('This screen is not connected to your company yet.');
    for (const text of [ta.lead, ta.notConnected, ta.restNotConnected, ...Object.values(ta.parts)]) expect(text).toMatch(TAMIL);
  });

  it('names exactly what is real on a board', () => {
    const en = shellWords.en.sample;
    const ta = shellWords.ta.sample;
    expect(en.except([en.parts.bills])).toBe('Sample data, except the bills.');
    expect(en.except([en.parts.bills, en.parts.breakdowns])).toBe('Sample data, except the bills and breakdowns.');
    expect(en.except([en.parts.orders])).toBe('Sample data, except the orders.');
    expect(en.except(['a', 'b', 'c'])).toBe('Sample data, except the a, b and c.');
    expect(ta.except([ta.parts.bills, ta.parts.breakdowns])).toBe('பில்கள், பழுதுகள் தவிர, மற்றவை மாதிரி விவரங்கள்.');
    expect(ta.except([ta.parts.orders])).toBe('ஆர்டர்கள் தவிர, மற்றவை மாதிரி விவரங்கள்.');
  });
});
