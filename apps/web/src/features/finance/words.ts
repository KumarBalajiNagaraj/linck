import type { Receipt } from '@linck/mock';
import { words } from '../../i18n/words.js';

/**
 * The words of the "Check payments" screen (LIN-23), in English and Tamil.
 *
 * A payment that came in is "a payment" in English and "வரவு" in Tamil — the
 * word a passbook prints against money in, and the half of "வரவு செலவு" every
 * accounts clerk already says. "Receipt" is never used (docs/WRITING.md).
 */

/** Why Linck put an invoice forward as the likely match. Worded from the engine's reason. */
export type MatchReason = 'utrExact' | 'amountAndCustomer' | 'oldestOpen';

export const verifyWords = words({
  en: {
    eyebrow: 'Accounts',
    title: 'Check payments',
    rule: 'Check each payment with the bank. You cannot check one you added.',
    /** Hover on the as-of dot: where the figures come from. */
    source: 'Payments added',

    payments: (n: number) => (n === 1 ? '1 payment' : `${n} payments`),
    paymentsByYou: (n: number, mine: number) => `${n === 1 ? '1 payment' : `${n} payments`} · ${mine} by you`,
    days: (n: number) => (n === 1 ? '1 day' : `${n} days`),
    ago: (n: number) => (n === 0 ? 'Today' : n === 1 ? '1 day ago' : `${n} days ago`),
    late: (n: number) => `+${n} ${n === 1 ? 'day' : 'days'}`,

    tiles: {
      waiting: 'Waiting to check',
      checkedToday: 'Checked today',
      oldest: 'Waiting longest',
      noneWaiting: 'None waiting',
    },

    method: { cash: 'Cash', neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI', cheque: 'Cheque' } satisfies Record<
      Receipt['method'],
      string
    >,

    age: {
      title: 'Days waiting',
      today: 'Today',
      oneToThree: '1–3 days',
      fourToSeven: '4–7 days',
      over: (n: number) => `Over ${n} days`,
      summary: (total: string, old: string, n: number) => `${total} waiting. ${old} for over ${n} days.`,
      darker: 'Darker means older.',
    },

    how: {
      title: 'How it was paid',
      summary: (pct: number, total: string) => `Cash is ${pct}% of ${total}.`,
      cashNote: 'Cash has no bank record. Check the bank deposit slip.',
    },

    chips: {
      all: 'All',
      utr: 'UTR matches',
      cash: 'Cash',
      over: (n: number) => `Over ${n} days`,
      mine: 'Added by you',
    },

    strip: {
      match: (n: number) => (n === 1 ? '1 payment matches the bank exactly.' : `${n} payments match the bank exactly.`),
      yours: (n: number) => `You added ${n}. Someone else must check ${n === 1 ? 'it' : 'them'}.`,
      checkAll: (n: number) => (n === 1 ? 'Check it' : `Check all ${n}`),
      nothing: 'Nothing to check',
    },

    queue: {
      title: 'Waiting to check',
      hint: 'Open a payment to check it.',
      allChecked: 'All payments are checked.',
      noneHere: 'None here.',
      showAll: 'Show all',
    },

    checked: {
      title: 'Checked today',
      none: 'None checked today.',
    },

    col: {
      date: 'Date',
      reference: 'UTR / cheque no.',
      how: 'How paid',
      customer: 'Customer',
      amount: 'Amount',
      likelyInvoice: 'Likely invoice',
      invoice: 'Invoice',
      addedBy: 'Added by',
      checkedBy: 'Checked by',
      status: 'Status',
    },

    reason: {
      utrExact: 'UTR and amount match',
      amountAndCustomer: 'Amount and customer match',
      oldestOpen: 'Oldest unpaid invoice, amount close',
    } satisfies Record<MatchReason, string>,

    stamp: {
      waiting: 'Waiting',
      youAdded: 'You added it',
      checked: 'Checked',
      justNow: 'Just now',
    },

    sheet: {
      cash: 'Cash',
      check: 'Check payment',
      after: 'After this, the money counts as received.',
      yours: 'You added this. Someone else must check.',
      checkedBy: (name: string) => `Checked by ${name}.`,

      payment: 'Payment',
      date: 'Date',
      amount: 'Amount',
      how: 'How paid',
      chequeNo: 'Cheque no.',
      utrNo: 'UTR no.',
      addedBy: 'Added by',
      checkedByLabel: 'Checked by',
      checkedOn: 'Checked on',

      likelyInvoice: 'Likely invoice',
      noInvoice: 'No matching invoice found.',
      invoice: 'Invoice',
      status: 'Status',
      total: 'Total',
      dueBefore: 'Due before this',
      why: (reason: string) => `Why: ${reason}`,
      noReason: 'not given',
      barChecked: 'Checked',
      barThis: 'This payment',
      barDue: 'Still due',
      barSummary: (checked: string, total: string, amount: string) => `${checked} of ${total} checked. This payment: ${amount}.`,

      others: (n: number) => `Other unpaid invoices (${n})`,
      noOthers: 'No other unpaid invoice.',
      dated: (date: string, due: string) => `Date ${date} · Due ${due}`,
      rightInvoice: 'Make sure the money goes to the right invoice.',
    },

    confirm: {
      titleOne: 'Is this payment correct?',
      titleMany: (n: number) => `Are these ${n} payments correct?`,
      yesOne: 'Yes, correct',
      yesMany: (n: number) => `Yes, all ${n} correct`,
      one: (amount: string, name: string) => `${amount}, added by ${name}.`,
      many: (n: number, total: string) => `${n} payments, ${total} in all.`,
      noInvoice: 'No invoice linked. Nothing closes.',
      closes: (n: number) => (n === 1 ? 'Closes 1 invoice.' : `Closes ${n} invoices.`),
      noneCloses: 'No invoice closes. Some money still due.',
      fullyPaid: 'fully paid',
      stillDue: (amount: string) => `${amount} still due`,
    },
  },
  ta: {
    eyebrow: 'கணக்கு',
    title: 'பணம் சரிபார்',
    rule: 'ஒவ்வொரு வரவையும் வங்கியுடன் சரிபாருங்கள். நீங்கள் சேர்த்ததை நீங்களே சரிபார்க்க முடியாது.',
    source: 'சேர்த்த வரவுகள்',

    payments: (n) => (n === 1 ? '1 வரவு' : `${n} வரவுகள்`),
    paymentsByYou: (n, mine) => `${n === 1 ? '1 வரவு' : `${n} வரவுகள்`} · உங்களால் ${mine}`,
    days: (n) => (n === 1 ? '1 நாள்' : `${n} நாட்கள்`),
    ago: (n) => (n === 0 ? 'இன்று' : `${n} நாள் முன்`),
    late: (n) => `+${n} நாள்`,

    tiles: {
      waiting: 'சரிபார்க்கக் காத்திருக்கிறது',
      checkedToday: 'இன்று சரிபார்த்தது',
      oldest: 'அதிக நாள் காத்திருப்பது',
      noneWaiting: 'எதுவும் காத்திருக்கவில்லை',
    },

    method: { cash: 'ரொக்கம்', neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI', cheque: 'செக்' },

    age: {
      title: 'காத்திருக்கும் நாட்கள்',
      today: 'இன்று',
      oneToThree: '1–3 நாள்',
      fourToSeven: '4–7 நாள்',
      over: (n) => `${n} நாளுக்கு மேல்`,
      summary: (total, old, n) => `${total} காத்திருக்கிறது. ${n} நாளுக்கு மேல்: ${old}.`,
      darker: 'அடர் நிறம் என்றால் பழையது.',
    },

    how: {
      title: 'பணம் வந்த வழி',
      summary: (pct, total) => `${total}-இல் ரொக்கம் ${pct}%.`,
      cashNote: 'ரொக்கத்துக்கு வங்கிப் பதிவு இல்லை. வங்கியில் கட்டிய சீட்டைப் பாருங்கள்.',
    },

    chips: {
      all: 'எல்லாம்',
      utr: 'UTR பொருந்துகிறது',
      cash: 'ரொக்கம்',
      over: (n) => `${n} நாளுக்கு மேல்`,
      mine: 'நீங்கள் சேர்த்தவை',
    },

    strip: {
      match: (n) =>
        n === 1 ? '1 வரவு வங்கியுடன் சரியாகப் பொருந்துகிறது.' : `${n} வரவுகள் வங்கியுடன் சரியாகப் பொருந்துகின்றன.`,
      yours: (n) =>
        n === 1
          ? 'இதில் 1 நீங்கள் சேர்த்தது. அதை வேறு ஒருவர் சரிபார்க்க வேண்டும்.'
          : `இதில் ${n} நீங்கள் சேர்த்தவை. அவற்றை வேறு ஒருவர் சரிபார்க்க வேண்டும்.`,
      checkAll: (n) => (n === 1 ? 'சரிபார்' : `${n}-ஐயும் சரிபார்`),
      nothing: 'சரிபார்க்க எதுவும் இல்லை',
    },

    queue: {
      title: 'சரிபார்க்கக் காத்திருக்கிறது',
      hint: 'சரிபார்க்க ஒரு வரவைத் திறங்கள்.',
      allChecked: 'எல்லா வரவுகளும் சரிபார்த்தாகிவிட்டது.',
      noneHere: 'இங்கே எதுவும் இல்லை.',
      showAll: 'எல்லாம் காட்டு',
    },

    checked: {
      title: 'இன்று சரிபார்த்தது',
      none: 'இன்று எதுவும் சரிபார்க்கவில்லை.',
    },

    col: {
      date: 'தேதி',
      reference: 'UTR / செக் எண்',
      how: 'வந்த வழி',
      customer: 'வாடிக்கையாளர்',
      amount: 'தொகை',
      likelyInvoice: 'பொருந்தும் இன்வாய்ஸ்',
      invoice: 'இன்வாய்ஸ்',
      addedBy: 'சேர்த்தவர்',
      checkedBy: 'சரிபார்த்தவர்',
      status: 'நிலை',
    },

    reason: {
      utrExact: 'UTR, தொகை பொருந்துகிறது',
      amountAndCustomer: 'தொகை, வாடிக்கையாளர் பொருந்துகிறது',
      oldestOpen: 'பழைய பாக்கி இன்வாய்ஸ், தொகை கிட்டத்தட்ட சரி',
    },

    stamp: {
      waiting: 'காத்திருக்கிறது',
      youAdded: 'நீங்கள் சேர்த்தது',
      checked: 'சரிபார்த்தது',
      justNow: 'இப்போது',
    },

    sheet: {
      cash: 'ரொக்கம்',
      check: 'வரவைச் சரிபார்',
      after: 'இதன் பிறகு இந்தப் பணம் கணக்கில் சேரும்.',
      yours: 'நீங்கள் சேர்த்தது. வேறு ஒருவர் சரிபார்க்க வேண்டும்.',
      checkedBy: (name) => `சரிபார்த்தவர்: ${name}.`,

      payment: 'பண விவரம்',
      date: 'தேதி',
      amount: 'தொகை',
      how: 'வந்த வழி',
      chequeNo: 'செக் எண்',
      utrNo: 'UTR எண்',
      addedBy: 'சேர்த்தவர்',
      checkedByLabel: 'சரிபார்த்தவர்',
      checkedOn: 'சரிபார்த்த நேரம்',

      likelyInvoice: 'பொருந்தும் இன்வாய்ஸ்',
      noInvoice: 'பொருந்தும் இன்வாய்ஸ் இல்லை.',
      invoice: 'இன்வாய்ஸ்',
      status: 'நிலை',
      total: 'மொத்தம்',
      dueBefore: 'இதற்கு முன் பாக்கி',
      why: (reason) => `காரணம்: ${reason}`,
      noReason: 'சொல்லப்படவில்லை',
      barChecked: 'சரிபார்த்தது',
      barThis: 'இந்தப் பணம்',
      barDue: 'பாக்கி',
      barSummary: (checked, total, amount) => `${total}-இல் ${checked} சரிபார்த்தது. இந்தப் பணம்: ${amount}.`,

      others: (n) => `மற்ற பாக்கி இன்வாய்ஸ்கள் (${n})`,
      noOthers: 'வேறு பாக்கி இன்வாய்ஸ் இல்லை.',
      dated: (date, due) => `தேதி ${date} · கடைசி தேதி ${due}`,
      rightInvoice: 'சரியான இன்வாய்ஸுக்குப் பணம் போகிறதா எனப் பாருங்கள்.',
    },

    confirm: {
      titleOne: 'இந்த வரவு சரியா?',
      titleMany: (n) => `இந்த ${n} வரவுகளும் சரியா?`,
      yesOne: 'ஆம், சரி',
      yesMany: (n) => `ஆம், ${n}-உம் சரி`,
      one: (amount, name) => `${amount} — சேர்த்தவர் ${name}.`,
      many: (n, total) => `${n} வரவுகள், மொத்தம் ${total}.`,
      noInvoice: 'இன்வாய்ஸ் இணைக்கவில்லை. எதுவும் முடியாது.',
      closes: (n) => `இதனால் ${n} இன்வாய்ஸ் முடியும்.`,
      noneCloses: 'இதனால் எந்த இன்வாய்ஸும் முடியாது. இன்னும் பாக்கி உள்ளது.',
      fullyPaid: 'முழுப் பணமும் வந்தது',
      stillDue: (amount) => `பாக்கி ${amount}`,
    },
  },
});
