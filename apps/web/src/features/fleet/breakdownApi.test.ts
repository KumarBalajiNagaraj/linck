import { describe, expect, it } from 'vitest';
import {
  breakdownFromApi,
  changeBody,
  changeDraft,
  changeGaps,
  downAt,
  instantOf,
  istMinute,
  reportBody,
  reportDraft,
  reportGaps,
  resolveBody,
  resolveDraft,
  resolveGaps,
  type ApiBreakdown,
} from './breakdownApi.js';

/** A breakdown exactly as `GET /breakdowns` sends it (apps/api/app/schemas/fleet.py BreakdownOut). */
function apiBreakdown(over: Partial<ApiBreakdown> = {}): ApiBreakdown {
  return {
    id: '3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b',
    number: 'BD/26-27/001',
    vehicleId: 'TN38AL1050',
    driverId: null,
    reportedAt: '2026-11-01T03:30:00Z',
    reportedBy: 'Driver on the phone',
    location: 'GST Road, Chengalpattu',
    cause: 'Clutch plate gone',
    status: 'open',
    resolvedAt: null,
    downtimeHours: 5.5,
    repairCost: null,
    siteId: '5b1d6c0e-91a4-4f3e-8a77-0c2b3e4d5f60',
    ...over,
  };
}

const PLANT = '5b1d6c0e-91a4-4f3e-8a77-0c2b3e4d5f60';
const OTHER = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';
/** 01-11-2026 14:35 IST. */
const NOW = new Date('2026-11-01T09:05:30Z');

describe('a breakdown from the API, as the register reads it', () => {
  it('keeps every field as the API sends it, the site it is booked to included', () => {
    const row = apiBreakdown({ status: 'resolved', resolvedAt: '2026-11-01T08:00:00Z', repairCost: '12500.00', driverId: 'drv-07' });
    expect(breakdownFromApi(row)).toEqual(row);
  });

  it('counts the vehicles down at a site: every breakdown not fixed, there', () => {
    const list = [
      breakdownFromApi(apiBreakdown({ id: 'a' })),
      breakdownFromApi(apiBreakdown({ id: 'b', status: 'in_workshop' })),
      breakdownFromApi(apiBreakdown({ id: 'c', status: 'resolved', resolvedAt: '2026-11-01T08:00:00Z' })),
      breakdownFromApi(apiBreakdown({ id: 'd', siteId: OTHER })),
    ];
    expect(downAt(list, PLANT)).toBe(2);
    expect(downAt(list, OTHER)).toBe(1);
    expect(downAt(list, null)).toBe(3);
  });
});

describe('times, typed in IST and kept as instants', () => {
  it('shows an instant as its IST date and minute, and reads it back', () => {
    expect(istMinute(NOW)).toBe('2026-11-01T14:35');
    expect(istMinute('2026-10-31T20:15:00Z')).toBe('2026-11-01T01:45');
    expect(instantOf('2026-11-01T14:35')).toBe('2026-11-01T09:05:00.000Z');
    expect(instantOf('2026-11-01')).toBeNull();
    expect(instantOf('')).toBeNull();
  });
});

describe('adding a breakdown', () => {
  const blank = reportDraft(PLANT, NOW);
  const filled = { ...blank, vehicle: 'tn 38 al 1050', cause: ' Clutch plate gone ', location: ' GST Road ' };

  it('starts at now, at the site given, open', () => {
    expect(blank).toEqual({ vehicle: '', cause: '', location: '', reportedAt: '2026-11-01T14:35', reportedBy: '', status: 'open', siteId: PLANT });
    expect(reportGaps(blank, [PLANT], NOW)).toEqual(['vehicle', 'cause', 'location']);
    expect(reportGaps(filled, [PLANT], NOW)).toEqual([]);
  });

  it('refuses a time after now and a site that is not this person\'s to write', () => {
    expect(reportGaps({ ...filled, reportedAt: '2026-11-01T15:00' }, [PLANT], NOW)).toEqual(['when']);
    expect(reportGaps({ ...filled, reportedAt: 'soon' }, [PLANT], NOW)).toEqual(['when']);
    expect(reportGaps(filled, [OTHER], NOW)).toEqual(['site']);
  });

  it('sends the vehicle as its registration, and leaves the time and the teller to the server when untouched', () => {
    expect(reportBody(filled, blank.reportedAt)).toEqual({
      siteId: PLANT,
      vehicleId: 'TN38AL1050',
      location: 'GST Road',
      cause: 'Clutch plate gone',
      status: 'open',
    });
    expect(reportBody({ ...filled, reportedAt: '2026-11-01T06:10', reportedBy: ' Murugan S ', status: 'in_workshop' }, blank.reportedAt)).toMatchObject({
      reportedAt: '2026-11-01T00:40:00.000Z',
      reportedBy: 'Murugan S',
      status: 'in_workshop',
    });
    // No driver: the API keeps a driver as a roster's id, and there is no roster on it yet.
    expect(reportBody(filled, blank.reportedAt)).not.toHaveProperty('driverId');
  });
});

describe('changing a breakdown', () => {
  const open = breakdownFromApi(apiBreakdown());
  const fixed = breakdownFromApi(apiBreakdown({ status: 'resolved', resolvedAt: '2026-11-01T08:00:00Z', repairCost: '12500.00' }));

  it('sends only what changed', () => {
    const d = changeDraft(open);
    expect(d).toEqual({ cause: 'Clutch plate gone', location: 'GST Road, Chengalpattu', reportedAt: '2026-11-01T09:00', reportedBy: 'Driver on the phone', status: 'open', repairCost: '' });
    expect(changeBody(open, d)).toEqual({});
    expect(changeBody(open, { ...d, status: 'in_workshop', repairCost: '4,500' })).toEqual({ status: 'in_workshop', repairCost: '4500.00' });
    expect(changeBody(open, { ...d, reportedAt: '2026-11-01T08:30' })).toEqual({ reportedAt: '2026-11-01T03:00:00.000Z' });
  });

  it('never empties who told it, and never sends a time it cannot read', () => {
    const d = changeDraft(open);
    expect(changeBody(open, { ...d, reportedBy: '  ' })).toEqual({});
    expect(changeGaps(open, { ...d, cause: ' ' }, NOW)).toEqual(['cause']);
    expect(changeGaps(open, { ...d, reportedAt: '2026-11-02T09:00' }, NOW)).toEqual(['when']);
    expect(changeGaps(open, { ...d, repairCost: '12.500,00' }, NOW)).toEqual(['repairCost']);
  });

  it('keeps a fixed breakdown closed but for its repair cost, which can also be cleared', () => {
    const d = changeDraft(fixed);
    expect(changeBody(fixed, { ...d, cause: 'Something else', status: 'open' })).toEqual({});
    expect(changeBody(fixed, { ...d, repairCost: '13,250' })).toEqual({ repairCost: '13250.00' });
    expect(changeBody(fixed, { ...d, repairCost: '12500' })).toEqual({});
    expect(changeBody(fixed, { ...d, repairCost: '' })).toEqual({ repairCost: null });
    // Its old report time is not checked again: only the cost is open.
    expect(changeGaps(fixed, { ...d, cause: '' }, NOW)).toEqual([]);
  });
});

describe('marking a breakdown fixed', () => {
  const open = breakdownFromApi(apiBreakdown());

  it('offers now, and sends nothing the server would not otherwise say', () => {
    const d = resolveDraft(open, NOW);
    expect(d).toEqual({ resolvedAt: '2026-11-01T14:35', repairCost: '' });
    expect(resolveGaps(open, d, NOW, d.resolvedAt)).toEqual([]);
    expect(resolveBody(d, d.resolvedAt)).toEqual({});
    expect(resolveBody({ resolvedAt: '2026-11-01T13:00', repairCost: '12,500' }, d.resolvedAt)).toEqual({
      resolvedAt: '2026-11-01T07:30:00.000Z',
      repairCost: '12500.00',
    });
  });

  it('refuses a typed fix after now or before it broke down, as the API would', () => {
    const offered = '2026-11-01T14:35';
    expect(resolveGaps(open, { resolvedAt: '2026-11-01T15:00', repairCost: '' }, NOW, offered)).toEqual(['fixedAt']);
    expect(resolveGaps(open, { resolvedAt: '2026-11-01T08:00', repairCost: '' }, NOW, offered)).toEqual(['fixedBeforeDown']);
    expect(resolveGaps(open, { resolvedAt: '2026-11-01T09:00', repairCost: '' }, NOW, offered)).toEqual([]);
    expect(resolveGaps(open, { resolvedAt: '2026-11-01T14:00', repairCost: 'lots' }, NOW, offered)).toEqual(['repairCost']);
  });

  it('never holds "now" against a breakdown reported this very minute', () => {
    // Reported at 14:35:20; the form offers 14:35, which is not sent: the API's now stands.
    const justNow = breakdownFromApi(apiBreakdown({ reportedAt: '2026-11-01T09:05:20Z' }));
    const d = resolveDraft(justNow, NOW);
    expect(resolveGaps(justNow, d, NOW, d.resolvedAt)).toEqual([]);
    expect(resolveBody(d, d.resolvedAt)).toEqual({});
  });
});
