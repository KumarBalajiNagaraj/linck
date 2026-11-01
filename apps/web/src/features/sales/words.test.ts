import { describe, expect, it } from 'vitest';
import { statusWords } from '../../i18n/statusWords.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import { salesWords } from './words.js';

/*
 * Every refusal the API can send about a customer or an order, in the words
 * the screen shows, in both languages (docs/WRITING.md: plain, short, and say
 * what to do).
 */

const orderStatus = (lang: 'en' | 'ta') => (s: string) => statusWords[lang].order[s as keyof (typeof statusWords)['en']['order']] ?? s;
const en = (p: RecordProblem, subject: 'customer' | 'order' = 'order') => salesWords.en.problem(p, subject, orderStatus('en'));
const ta = (p: RecordProblem, subject: 'customer' | 'order' = 'order') => salesWords.ta.problem(p, subject, orderStatus('ta'));

const EVERY: RecordProblem[] = [
  { code: 'needs-permission', permission: 'sales.customer.write' },
  { code: 'needs-permission', permission: 'sales.order.write' },
  { code: 'needs-permission', permission: 'sales.order.approve' },
  { code: 'needs-permission', permission: 'sales.customer.read' },
  { code: 'needs-permission', permission: 'something.new' },
  { code: 'wrong-step', status: 'approved', action: 'reject' },
  { code: 'wrong-step', status: 'rejected', action: 'approve' },
  { code: 'needs-reason', action: 'reject' },
  { code: 'gstin-used', gstin: '33AACCA1234K1Z5' },
  { code: 'gone' },
  ...[
    'name',
    'gstin',
    'servedFromSiteId',
    'creditLimit',
    'paymentTermsDays',
    'phone',
    'contactName',
    'site',
    'customerId',
    'customerPoRef',
    'productCode',
    'orderedUnits',
    'ratePerUnit',
    'deliverBy',
    'deliverySite',
    'siteId',
    'reason',
    'somethingElse',
  ].map((field): RecordProblem => ({ code: 'invalid', field, reason: 'cannot be emptied' })),
  { code: 'signed-out' },
  { code: 'offline' },
  { code: 'server', status: 500 },
  { code: 'server', status: 0 },
  { code: 'vehicle-already-down', vehicle: 'TN38AL1050' },
];

const TAMIL = /[஀-௿]/;

describe("a refused customer or order, in the screen's own words", () => {
  it('words every problem in English and in Tamil, never as a code', () => {
    for (const p of EVERY) {
      for (const subject of ['customer', 'order'] as const) {
        const [e, t] = [en(p, subject), ta(p, subject)];
        expect(e, p.code).toMatch(/\S/);
        expect(t, p.code).toMatch(TAMIL);
        for (const text of [e, t]) {
          expect(text, p.code).not.toMatch(/undefined|null|\[object/);
          // No permission keys, codes or field names on screen (docs/WRITING.md rule 2).
          expect(text, p.code).not.toMatch(/sales\.|wrong-step|needs-|gstin-used|customerPoRef|servedFromSiteId|somethingElse|pending_approval/);
        }
      }
    }
  });

  it('says who may do it, by what they do', () => {
    expect(en({ code: 'needs-permission', permission: 'sales.order.approve' })).toBe('Only a sales manager can do this here.');
    expect(en({ code: 'needs-permission', permission: 'sales.customer.write' })).toBe('Only the sales desk can do this here.');
    expect(ta({ code: 'needs-permission', permission: 'sales.order.approve' })).toBe('இதை சேல்ஸ் மேனேஜர் மட்டுமே செய்ய முடியும்.');
  });

  it('says where an order has got to when it was decided meanwhile', () => {
    expect(en({ code: 'wrong-step', status: 'approved', action: 'reject' })).toBe('Not now — this order is "Approved".');
    expect(ta({ code: 'wrong-step', status: 'rejected', action: 'approve' })).toBe('இப்போது முடியாது — ஆர்டர் "நிராகரித்தது" நிலையில் உள்ளது.');
  });

  it('keeps the GST number a person typed, and names what is gone', () => {
    expect(en({ code: 'gstin-used', gstin: '33AACCA1234K1Z5' }, 'customer')).toBe('GST no. 33AACCA1234K1Z5 is already on another customer.');
    expect(ta({ code: 'gstin-used', gstin: '33AACCA1234K1Z5' }, 'customer')).toContain('33AACCA1234K1Z5');
    expect(en({ code: 'gone' }, 'customer')).toBe('This customer is no longer here.');
    expect(en({ code: 'gone' }, 'order')).toBe('This order is no longer here.');
  });

  it('names the fix for a value the API would not take', () => {
    expect(en({ code: 'invalid', field: 'gstin', reason: 'not a valid GSTIN' })).toBe('Type the 15-letter GST no., or leave it blank.');
    expect(en({ code: 'invalid', field: 'deliverySite', reason: 'required: the customer has no default delivery site' })).toBe('Type where to deliver.');
    expect(en({ code: 'invalid', field: 'customerId', reason: 'not found' })).toBe('Pick the customer again.');
    expect(en({ code: 'invalid', field: 'somethingElse', reason: '' })).toBe('Check the details, then try again.');
    expect(ta({ code: 'invalid', field: 'orderedUnits', reason: '' })).toBe('யூனிட் டைப் செய்யுங்கள், உதா. 40.');
  });

  it('asks for the reason a rejection needs', () => {
    expect(en({ code: 'needs-reason', action: 'reject' })).toBe('Write the reason, then reject.');
    expect(ta({ code: 'needs-reason', action: 'reject' })).toBe('காரணம் எழுதி, பிறகு நிராகரியுங்கள்.');
  });

  it('says the API did not answer, or had a fault, with its number', () => {
    expect(en({ code: 'offline' })).toBe('Linck did not answer. Check the internet, then try again.');
    expect(en({ code: 'server', status: 500 })).toBe('Linck had a problem (error 500). Try again.');
    expect(ta({ code: 'server', status: 500 })).toContain('500');
    expect(en({ code: 'signed-out' })).toBe('You were signed out. Sign in again.');
  });
});
