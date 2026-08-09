import { describe, expect, it } from 'vitest';
import { formatAccounting, formatINR, formatINRCompact } from './money.js';
import { businessDate, daysUntil, fiscalQuarter, fiscalYearOf, fyRange } from './date.js';
import { can, resolveHome, type Grants } from './permissions.js';
import { CFT_PER_UNIT, freezeQuantity, tonnesToUnits, unitsToTonnes, weighbridgeVariancePct } from './uom.js';

describe('money', () => {
  it('groups in lakhs and crores, not thousands', () => {
    expect(formatINR('1234567.89')).toBe('₹12,34,567.89');
  });

  it('compacts against explicit thresholds', () => {
    expect(formatINRCompact(12_300_000)).toBe('₹1.23 Cr');
    expect(formatINRCompact(450_000)).toBe('₹4.50 L');
    expect(formatINRCompact(85_000)).toBe('₹85.0 K');
  });

  it('renders negatives in accounting parentheses', () => {
    expect(formatAccounting(-12450)).toBe('(12,450.00)');
  });

  it('renders an unknown value as an en dash, never as zero', () => {
    expect(formatINR('')).toBe('–');
  });
});

describe('uom', () => {
  it('treats the unit of 100 CFT as the trade unit', () => {
    expect(CFT_PER_UNIT).toBe(100);
  });

  it('uses the as-loaded trade density, not the loose stockpile density', () => {
    // The bug this guards: 22-24 cft/tonne is the stockpile figure. Billing a
    // 35 t load at that density instead of the ~20 cft/tonne trade figure
    // overstates quantity by ~15% on every single load.
    expect(unitsToTonnes(1, 'MSAND')).toBeCloseTo(4.95, 2);
    expect(tonnesToUnits(35, 'MSAND')).toBeCloseTo(7.07, 2);
  });

  it('freezes trade, statutory and conversion together', () => {
    const q = freezeQuantity(7, 'unit', 'MSAND');
    expect(q.tradeUom).toBe('unit');
    // CFT is not a valid GST UQC, so the statutory line must be MTS.
    expect(q.statutoryUqc).toBe('MTS');
    expect(q.statutoryQty).toBeCloseTo(34.65, 2);
    expect(q.conversionFactorUsed).toBe(4.95);
  });

  it('computes weighbridge variance as a signed percentage', () => {
    expect(weighbridgeVariancePct(34.65, 7, 'MSAND')).toBeCloseTo(0, 5);
    expect(weighbridgeVariancePct(36, 7, 'MSAND')).toBeGreaterThan(0);
  });
});

describe('dates', () => {
  it('assigns a late-night IST dispatch to the IST day, not the UTC day', () => {
    // 23:40 IST on 8 Aug is 18:10 UTC on 8 Aug — same day. But 00:30 IST on
    // 9 Aug is 19:00 UTC on 8 Aug, and naive toISOString() would file it
    // under the 8th.
    expect(businessDate('2026-08-08T19:00:00Z')).toBe('2026-08-09');
    expect(businessDate('2026-08-08T18:10:00Z')).toBe('2026-08-08');
  });

  it('runs the financial year April to March', () => {
    expect(fiscalYearOf('2026-08-08T00:00:00Z')).toBe('2026-27');
    expect(fiscalYearOf('2026-03-31T00:00:00Z')).toBe('2025-26');
    expect(fyRange('2026-27')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });

  it('starts Q1 in April', () => {
    expect(fiscalQuarter('2026-05-02T00:00:00Z')).toBe(1);
    expect(fiscalQuarter('2026-01-02T00:00:00Z')).toBe(4);
  });

  it('reports expiry as a signed day count', () => {
    expect(daysUntil('2026-08-18T00:00:00Z', '2026-08-08T06:00:00Z')).toBe(10);
    expect(daysUntil('2026-08-01T00:00:00Z', '2026-08-08T06:00:00Z')).toBe(-7);
  });
});

describe('permissions', () => {
  const grants: Grants = {
    'fleet.board.read': { orgWide: false, siteIds: ['site-krp'] },
    'executive.dashboard.read': { orgWide: true, siteIds: [] },
  };

  it('honours site scope', () => {
    expect(can(grants, 'fleet.board.read', { siteId: 'site-krp' })).toBe(true);
    expect(can(grants, 'fleet.board.read', { siteId: 'site-tvl' })).toBe(false);
  });

  it('lets an org-wide grant cover every site', () => {
    expect(can(grants, 'executive.dashboard.read', { siteId: 'site-tvl' })).toBe(true);
  });

  it('denies an ungranted permission outright', () => {
    expect(can(grants, 'finance.receipt.verify')).toBe(false);
  });

  it('sends a user to the highest-priority home they can reach', () => {
    expect(resolveHome(grants)).toBe('/overview');
    expect(resolveHome({ 'fleet.board.read': { orgWide: true, siteIds: [] } })).toBe('/fleet/board');
  });
});
