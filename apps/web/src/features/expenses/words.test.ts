import { describe, expect, it } from 'vitest';
import type { BillProblem } from './expenseApi.js';
import { expenseWords } from './words.js';

/*
 * Every refusal the API can send for a bill, in the words the screen shows,
 * in both languages (docs/WRITING.md: plain, short, and say what to do).
 */

const status = (s: string) => ({ submitted: 'Waiting to be checked', validated: 'Checked', approved: 'Approved' })[s] ?? s;
const en = (p: BillProblem) => expenseWords.en.problem(p, status);
const ta = (p: BillProblem) => expenseWords.ta.problem(p, status);

const EVERY: BillProblem[] = [
  { code: 'wrong-step', status: 'approved', action: 'approve' },
  { code: 'needs-permission', permission: 'finance.expense.approve' },
  { code: 'needs-permission', permission: 'fleet.expense.upload' },
  { code: 'only-step-owner', step: 'approve' },
  { code: 'only-desk-deletes' },
  { code: 'second-signature' },
  { code: 'needs-reason', action: 'reject' },
  { code: 'needs-payment' },
  { code: 'bad-utr' },
  { code: 'utr-used', utr: 'HDFC00ABCDEF1234' },
  { code: 'future-payment-date' },
  { code: 'batch-second-signature' },
  { code: 'bill-gone' },
  { code: 'invalid', field: 'amount', reason: 'must be more than zero' },
  { code: 'invalid', field: 'billDate', reason: 'after today' },
  { code: 'invalid', field: 'somethingElse', reason: '' },
  { code: 'too-big' },
  { code: 'wrong-file' },
  { code: 'empty-file' },
  { code: 'signed-already' },
  { code: 'signed-out' },
  { code: 'offline' },
  { code: 'server', status: 503 },
  { code: 'server', status: 0 },
];

const TAMIL = /[஀-௿]/;

describe('a refused move, in the screen\'s own words', () => {
  it('words every problem in English and in Tamil, never as a code', () => {
    for (const p of EVERY) {
      const [e, t] = [en(p), ta(p)];
      expect(e, p.code).toMatch(/\S/);
      expect(t, p.code).toMatch(TAMIL);
      for (const text of [e, t]) {
        expect(text, p.code).not.toMatch(/undefined|null|\[object/);
        // No permission keys, codes or field names on screen (docs/WRITING.md rule 2).
        expect(text, p.code).not.toMatch(/\.expense\.|wrong-step|needs-|billDate|somethingElse/);
      }
    }
  });

  it('says who may take a step, by what they do', () => {
    expect(en({ code: 'needs-permission', permission: 'finance.expense.approve' })).toBe('Only the director can do this here.');
    expect(en({ code: 'needs-permission', permission: 'fleet.expense.upload' })).toBe('Only the fleet desk can do this here.');
    expect(ta({ code: 'needs-permission', permission: 'finance.expense.pay' })).toBe('இதை கணக்காளர் மட்டுமே செய்ய முடியும்.');
  });

  it('says where a bill has got to when it moved on meanwhile', () => {
    expect(en({ code: 'wrong-step', status: 'approved', action: 'approve' })).toBe('Not now — this bill is "Approved".');
  });

  it('names the fix for a value the API would not take', () => {
    expect(en({ code: 'invalid', field: 'billDate', reason: 'after today' })).toBe('Date cannot be after today.');
    expect(en({ code: 'invalid', field: 'billDate', reason: 'not a date' })).toBe('Pick the bill date.');
    expect(en({ code: 'invalid', field: 'litres', reason: 'a diesel bill needs litres' })).toBe('A diesel bill needs litres.');
    expect(en({ code: 'invalid', field: 'vehicleId', reason: 'required' })).toBe('Type the vehicle number.');
    expect(en({ code: 'invalid', field: 'attachmentId', reason: 'already on another bill' })).toBe('Add the photo again.');
    expect(en({ code: 'invalid', field: 'somethingElse', reason: '' })).toBe('Check the details, then try again.');
    expect(ta({ code: 'invalid', field: 'billDate', reason: 'after today' })).toBe('தேதி இன்றைக்குப் பிறகு இருக்கக்கூடாது.');
  });

  it('keeps the UTR a person typed, and the error number a fault carries', () => {
    expect(en({ code: 'utr-used', utr: 'HDFC00ABCDEF1234' })).toBe('UTR HDFC00ABCDEF1234 is already used.');
    expect(ta({ code: 'utr-used', utr: 'HDFC00ABCDEF1234' })).toContain('HDFC00ABCDEF1234');
    expect(en({ code: 'server', status: 503 })).toBe('Linck had a problem (error 503). Try again.');
    expect(ta({ code: 'server', status: 503 })).toContain('503');
    expect(en({ code: 'server', status: 0 })).toBe('Linck had a problem. Try again.');
  });

  it('tells a person refused a second signature outright that someone else must sign', () => {
    expect(en({ code: 'signed-already' })).toBe('You signed this already. Someone else must do it.');
    // Not the demo's "write why": writing why would not help.
    expect(en({ code: 'signed-already' })).not.toContain('Write why');
  });
});
