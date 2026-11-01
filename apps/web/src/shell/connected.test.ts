import { describe, expect, it } from 'vitest';
import { connectionOf } from './connected.js';
import { WORKSPACES } from './nav-manifest.js';
import { shellWords } from './words.js';

describe('which live screens say "sample data"', () => {
  it('leaves the screens on the API without the banner', () => {
    for (const route of ['/fleet/expenses', '/stores/expenses', '/finance/expenses', '/overview/expenses', '/fleet/diesel-summary', '/fleet/whatsapp', '/overview/industry']) {
      expect(connectionOf(route), route).toBe('api');
    }
  });

  it('marks the fleet board as sample data but for its bills', () => {
    expect(connectionOf('/fleet/board')).toBe('bills');
  });

  it('marks every other menu page, and any page it has never heard of, as sample data', () => {
    const others = WORKSPACES.flatMap((ws) => ws.items.map((i) => i.route)).filter((r) => connectionOf(r) === 'sample');
    expect(others).toContain('/overview');
    expect(others).toContain('/fleet/vehicles');
    expect(others).toContain('/sales/invoices');
    expect(connectionOf('/fleet/pl/sheets/$sheetId')).toBe('sample');
  });

  it('says so in both languages', () => {
    expect(shellWords.en.sample.lead).toBe('Sample data.');
    expect(shellWords.en.sample.notConnected).toBe('This screen is not connected to your company yet.');
    for (const text of Object.values(shellWords.ta.sample)) expect(text).toMatch(/[஀-௿]/);
  });
});
