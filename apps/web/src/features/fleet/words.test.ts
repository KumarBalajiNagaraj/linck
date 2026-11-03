import { describe, expect, it } from 'vitest';
import { statusWords } from '../../i18n/statusWords.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import { breakdownWords } from './words.js';

/*
 * Every refusal the API can send about a breakdown, in the words the register
 * shows, in both languages (docs/WRITING.md: plain, short, and say what to do).
 */

const status = (lang: 'en' | 'ta') => (s: string) => statusWords[lang].breakdown[s as keyof (typeof statusWords)['en']['breakdown']] ?? s;
const en = (p: RecordProblem) => breakdownWords.en.problem(p, status('en'));
const ta = (p: RecordProblem) => breakdownWords.ta.problem(p, status('ta'));

const EVERY: RecordProblem[] = [
  { code: 'needs-permission', permission: 'fleet.vehicle.write' },
  { code: 'needs-permission', permission: 'fleet.breakdown.read' },
  { code: 'needs-permission', permission: 'something.new' },
  { code: 'wrong-step', status: 'resolved', action: 'resolve' },
  { code: 'wrong-step', status: 'resolved', action: 'update' },
  { code: 'vehicle-already-down', vehicle: 'TN 38 AL 1050' },
  { code: 'gone' },
  { code: 'invalid', field: 'vehicleId', reason: '' },
  { code: 'invalid', field: 'location', reason: 'cannot be emptied' },
  { code: 'invalid', field: 'cause', reason: '' },
  { code: 'invalid', field: 'reportedBy', reason: 'cannot be emptied' },
  { code: 'invalid', field: 'reportedAt', reason: 'in the future' },
  { code: 'invalid', field: 'reportedAt', reason: '' },
  { code: 'invalid', field: 'resolvedAt', reason: 'in the future' },
  { code: 'invalid', field: 'resolvedAt', reason: 'before the breakdown was reported' },
  { code: 'invalid', field: 'resolvedAt', reason: '' },
  { code: 'invalid', field: 'repairCost', reason: '' },
  { code: 'invalid', field: 'siteId', reason: 'no such site' },
  { code: 'invalid', field: 'status', reason: '' },
  { code: 'invalid', field: 'driverId', reason: '' },
  { code: 'invalid', field: 'somethingElse', reason: '' },
  { code: 'signed-out' },
  { code: 'offline' },
  { code: 'server', status: 503 },
  { code: 'server', status: 0 },
  { code: 'needs-reason', action: 'reject' },
  { code: 'gstin-used', gstin: '33AACCA1234K1Z5' },
];

const TAMIL = /[஀-௿]/;

describe("a refused breakdown, in the register's own words", () => {
  it('words every problem in English and in Tamil, never as a code', () => {
    for (const p of EVERY) {
      const [e, t] = [en(p), ta(p)];
      expect(e, p.code).toMatch(/\S/);
      expect(t, p.code).toMatch(TAMIL);
      for (const text of [e, t]) {
        expect(text, p.code).not.toMatch(/undefined|null|\[object/);
        expect(text, p.code).not.toMatch(/fleet\.|wrong-step|already-down|vehicleId|reportedAt|resolvedAt|somethingElse|in the future/);
      }
    }
  });

  it('says who may do it, by what they do', () => {
    expect(en({ code: 'needs-permission', permission: 'fleet.vehicle.write' })).toBe('Only the fleet manager can do this here.');
    expect(ta({ code: 'needs-permission', permission: 'fleet.vehicle.write' })).toBe('இதை ஃப்ளீட் மேனேஜர் மட்டுமே செய்ய முடியும்.');
  });

  it('says a breakdown was fixed meanwhile', () => {
    expect(en({ code: 'wrong-step', status: 'resolved', action: 'resolve' })).toBe('Not now — this breakdown is "Fixed".');
    expect(ta({ code: 'wrong-step', status: 'resolved', action: 'resolve' })).toBe('இப்போது முடியாது — பழுது "சரியானது" நிலையில் உள்ளது.');
  });

  it('names the vehicle already down, as it was written', () => {
    expect(en({ code: 'vehicle-already-down', vehicle: 'TN 38 AL 1050' })).toBe('TN 38 AL 1050 is already down. Mark that one fixed first.');
    expect(ta({ code: 'vehicle-already-down', vehicle: 'TN 38 AL 1050' })).toBe('TN 38 AL 1050 ஏற்கனவே பழுதில் உள்ளது. முதலில் அதைச் சரியானதாகக் குறியுங்கள்.');
  });

  it('names the fix for a time the API would not take', () => {
    expect(en({ code: 'invalid', field: 'reportedAt', reason: 'in the future' })).toBe('Time cannot be after now.');
    expect(en({ code: 'invalid', field: 'resolvedAt', reason: 'before the breakdown was reported' })).toBe('It cannot be fixed before it broke down.');
    expect(en({ code: 'invalid', field: 'location', reason: 'cannot be emptied' })).toBe('Type where it is.');
    expect(ta({ code: 'invalid', field: 'resolvedAt', reason: 'in the future' })).toBe('நேரம் இப்போதைக்குப் பிறகு இருக்கக்கூடாது.');
  });

  it('has the form words in both languages', () => {
    const e = breakdownWords.en;
    const t = breakdownWords.ta;
    for (const key of Object.keys(e.needs) as (keyof typeof e.needs)[]) expect(t.needs[key]).toMatch(TAMIL);
    for (const key of Object.keys(e.wrong) as (keyof typeof e.wrong)[]) expect(t.wrong[key]).toMatch(TAMIL);
    expect(e.stillNeeded(['Vehicle', 'Where'])).toBe('Still needed: Vehicle, Where');
  });
});
