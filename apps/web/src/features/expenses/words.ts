import type { BillAction, BillNotice, ImportOutcome, PaymentMode, PlanReason, WorkflowProblem } from '@linck/domain';
import { words } from '../../i18n/words.js';

/**
 * Every word on the expense screens — the registers, adding a bill, the
 * approval chain, WhatsApp slips, the diesel report and the director's
 * approvals — in English and in Tamil (LIN-23, docs/WRITING.md).
 *
 * Domain code hands over codes; these functions word them.
 */

type Desk = 'fleet' | 'stores' | null;
type CaptureField = 'billDate' | 'vehicle' | 'litres' | 'rate' | 'billNumber';

/** Who holds each key, in words a person knows. */
const WHO_EN: Record<string, string> = {
  'fleet.expense.validate': 'the fleet manager',
  'stores.expense.validate': 'the fleet manager at the workshop',
  'finance.expense.approve': 'the director',
  'finance.expense.pass': 'accounts',
  'finance.expense.pay': 'accounts',
};
const WHO_TA: Record<string, string> = {
  'fleet.expense.validate': 'ஃப்ளீட் மேனேஜர்',
  'stores.expense.validate': 'வொர்க்ஷாப் ஃப்ளீட் மேனேஜர்',
  'finance.expense.approve': 'இயக்குநர்',
  'finance.expense.pass': 'கணக்காளர்',
  'finance.expense.pay': 'கணக்காளர்',
};

const ACTION_EN: Record<BillAction, string> = {
  validate: 'Check',
  approve: 'Approve',
  pass: 'Pass for payment',
  pay: 'Mark paid',
  reject: 'Reject',
  send_back: 'Send back',
  delete: 'Delete',
  restore: 'Restore',
};
const ACTION_TA: Record<BillAction, string> = {
  validate: 'சரிபார்',
  approve: 'அனுமதி',
  pass: 'பணம் கொடுக்க அனுமதி',
  pay: 'பணம் கொடுத்ததாகக் குறி',
  reject: 'நிராகரி',
  send_back: 'திருப்பி அனுப்பு',
  delete: 'நீக்கு',
  restore: 'மீண்டும் சேர்',
};
const DONE_EN: Record<BillAction, string> = {
  validate: 'Checked',
  approve: 'Approved',
  pass: 'Passed for payment',
  pay: 'Marked paid',
  reject: 'Rejected',
  send_back: 'Sent back',
  delete: 'Deleted',
  restore: 'Restored',
};
const DONE_TA: Record<BillAction, string> = {
  validate: 'சரிபார்த்தார்',
  approve: 'அனுமதித்தார்',
  pass: 'பணம் கொடுக்க அனுமதித்தார்',
  pay: 'பணம் கொடுத்ததாகக் குறித்தார்',
  reject: 'நிராகரித்தார்',
  send_back: 'திருப்பி அனுப்பினார்',
  delete: 'நீக்கினார்',
  restore: 'மீண்டும் சேர்த்தார்',
};

const FIELD_EN: Record<CaptureField, string> = {
  billDate: 'date',
  vehicle: 'vehicle number',
  litres: 'litres',
  rate: 'rate',
  billNumber: 'bill number',
};
const FIELD_TA: Record<CaptureField, string> = {
  billDate: 'தேதி',
  vehicle: 'வண்டி எண்',
  litres: 'லிட்டர்',
  rate: 'விலை',
  billNumber: 'பில் எண்',
};

const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('-');

const en = {
  desk: { fleet: 'Fleet', stores: 'Stores', finance: 'Accounts', overview: 'Overview' },
  deskName: (d: Desk): string => (d === 'fleet' ? 'Fleet' : d === 'stores' ? 'Stores' : 'Accounts'),
  bills: (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`,
  action: ACTION_EN,
  done: (action: BillAction, who: string) => `${DONE_EN[action]} by ${who}`,

  /** Why a move cannot be made. `status` is the bill's status in words. */
  problem: (p: WorkflowProblem | { code: 'bill-gone' }, status: (s: string) => string): string => {
    switch (p.code) {
      case 'wrong-step':
        return `Not now — this bill is "${status(p.status)}".`;
      case 'needs-permission':
        return `Only ${WHO_EN[p.permission] ?? 'someone else'} can do this here.`;
      case 'only-step-owner':
        return 'Only the person at this step can reject it.';
      case 'only-desk-deletes':
        return 'Only the desk that added it can delete it.';
      case 'second-signature':
        return 'You signed this already. Write why.';
      case 'needs-reason':
        return `${ACTION_EN[p.action]}: write a reason.`;
      case 'needs-payment':
        return 'Type the UTR and the date.';
      case 'bad-utr':
        return 'UTR is 6 to 22 letters or digits.';
      case 'utr-used':
        return `UTR ${p.utr} is already used.`;
      case 'future-payment-date':
        return 'Date cannot be after today.';
      case 'batch-second-signature':
        return 'You signed it already — do it alone.';
      case 'bill-gone':
        return 'This bill is no longer here.';
    }
  },

  /** A reading's warning, or a WhatsApp claim's issue. */
  notice: (n: BillNotice): string => {
    switch (n.code) {
      case 'litres-rate-mismatch':
        return `Litres × rate = ${rupee(n.expected)}, but the total says ${rupee(n.stated)}.`;
      case 'unreadable':
        return `Could not read the ${FIELD_EN[n.field]} ("${n.text}"). Type it.`;
      case 'no-total':
        return 'Could not read the total. Type it.';
      case 'no-bill-number':
        return 'Could not read the bill number.';
      case 'rate-out-of-band':
        return `${rupee(n.rate)} a litre is not between ₹${n.min} and ₹${n.max}. Check the figures.`;
      case 'inferred': {
        const parts = [n.litres !== null ? `${n.litres} as litres` : null, n.amount !== null ? `${n.amount} as rupees` : null].filter(Boolean);
        return `Guessed ${parts.join(' and ')} from numbers with no units. Check the slip.`;
      }
      case 'no-litres':
        return 'No litres given.';
      case 'no-amount':
        return n.near !== null && n.litres
          ? `No rupees given. ${n.near} is written — with ${n.litres} L that is ${rupee(n.near / n.litres)} a litre.`
          : 'No rupees given.';
      case 'no-photo':
        return 'No bill photo.';
      case 'photo-only':
        return 'Only a photo — the figures come from the slip.';
      case 'media-omitted':
        return 'The chat was saved without photos.';
      case 'no-vehicle':
        return 'No vehicle number.';
      case 'vehicle-unmatched':
        return `"${n.text}" does not match one vehicle.`;
      case 'not-own-fill':
        return `${n.sender} is not sending their own fill.`;
      case 'not-a-driver':
        return `${n.sender} is not on the driver list.`;
      case 'no-fill':
        return 'Says diesel, but no litres, rupees or photo.';
      case 'same-photo-as-line':
        return `Same photo as message ${n.line}.`;
      case 'same-figures-as-line':
        return `Same vehicle, litres and rupees as message ${n.line}.`;
      case 'slip-litres-differ':
        return `Message says ${n.message} L, slip says ${n.slip} L. Slip used.`;
      case 'slip-amount-differ':
        return `Message says ${rupee(n.message)}, slip says ${rupee(n.slip)}. Slip used.`;
      case 'slip-names-other-vehicle':
        return `The slip shows another vehicle: ${n.slip}.`;
      case 'slip-vehicle-unknown':
        return `The slip shows ${n.slip} — not our vehicle.`;
      case 'slip-unreadable':
        return 'Could not read the slip. Look at the photo, or ask for a clearer one.';
    }
  },

  /** Why a WhatsApp claim is not being added. */
  reason: (r: PlanReason): string => {
    switch (r.code) {
      case 'already-imported':
        return `Already added on ${day(r.on)}.`;
      case 'photo-in-linck':
        return `Same photo as bill ${r.bill}.`;
      case 'same-photo-again':
        return r.line !== null ? `Same photo as message ${r.line}.` : 'Same photo again.';
      case 'bill-in-linck':
        return `Bill ${r.billNumber} from ${r.vendor} is already here.`;
      case 'no-fill':
        return 'No litres, rupees or photo.';
      case 'needs-details':
        return `Needs ${[r.vehicle ? 'the vehicle' : null, r.amount ? 'the rupees' : null].filter(Boolean).join(' and ')}.`;
    }
  },

  register: {
    title: 'Expenses',
    financeTitle: 'Expense bills',
    addBill: 'Add bill',
    waitingForYou: (n: number, amount: string) => (n === 0 ? 'Nothing waiting for you' : `For you: ${n} ${n === 1 ? 'bill' : 'bills'} · ${amount}`),
    all: 'All',
    corrected: 'Corrected by hand',
    noBills: 'No bills here yet.',
    noneInList: 'No bills in this list.',
    showAll: 'Show all',
    columns: {
      bill: 'Bill',
      status: 'Status',
      type: 'Type',
      shop: 'Shop',
      photo: 'Photo',
      pdf: 'PDF',
      vehicle: 'Vehicle',
      driver: 'Driver',
      litres: 'Litres',
      amount: 'Amount',
      addedBy: 'Added by',
      groupBill: 'Bill',
      groupFor: 'For',
      groupAmount: 'Amount',
    },
  },

  detail: {
    photo: 'Photo',
    openFile: (name: string, kb: number) => `Open ${name} (${kb} KB)`,
    photoAlt: (bill: string) => `Photo of bill ${bill}`,
    noPhoto: 'No photo for this bill.',
    readFromPhoto: 'Read from the photo',
    field: 'Field',
    photoSays: 'Photo says',
    saved: 'Saved',
    notRead: 'not read',
    correctedBy: (who: string) => `corrected by ${who}`,
    readBy: 'Read by Linck',
    correctTitle: 'Correct',
    correct: 'Correct it',
    save: 'Save',
    cancel: 'Cancel',
    bill: 'Bill',
    fields: {
      kind: 'Type',
      billNumber: 'Bill number',
      billDate: 'Bill date',
      vendor: 'Shop',
      vehicle: 'Vehicle',
      litres: 'Litres',
      amount: 'Amount',
      amountRupees: 'Amount ₹',
      rate: 'Rate',
      gstin: 'GSTIN',
      whatFor: 'What for',
      addedBy: 'Added by',
    } as Record<string, string>,
    errors: {
      amount: 'Type the total, like 12,500.00',
      litres: 'Type the litres, like 120.45',
      dieselLitres: 'A diesel bill needs litres',
      date: 'Pick the bill date',
      futureDate: 'Date cannot be after today',
      blank: 'Type the bill number and shop',
    },
  },

  upload: {
    title: (desk: 'fleet' | 'stores'): string => (desk === 'fleet' ? 'Add a fleet bill' : 'Add a stores bill'),
    submit: 'Send for checking',
    stillNeeded: (list: string[]) => `Still needed: ${list.join(', ')}`,
    bookedTo: (site: string) => `Saved to ${site}. Next: check, then director, then accounts.`,
    needs: {
      photo: 'Photo',
      billNumber: 'Bill number',
      billDate: 'Bill date',
      vendor: 'Shop',
      amount: 'Amount',
      litres: 'Litres',
      vehicle: 'Vehicle',
      site: 'Site',
    },
    tapToAdd: 'Tap to take a photo or pick a file',
    fileTypes: (mb: number) => `JPG, PNG or PDF · up to ${mb} MB`,
    pdfAttached: 'PDF added',
    cannotShow: 'Added, but cannot be shown here',
    photoAria: 'Bill photo',
    photoAlt: 'Bill photo',
    wrongFile: 'Use a JPG, PNG or PDF photo of the bill.',
    tooBig: (mb: number) => `File is over ${mb} MB. Take the photo again.`,
    reading: (pct: number) => `Reading the bill… ${pct}%`,
    read: 'Read. Check each filled box against the paper.',
    failed: 'Could not read this photo. Type the details.',
    pdf: 'PDFs are not read yet. Type the details, or paste the text.',
    textRead: (pasted: boolean): string => (pasted ? 'Text from the pasted bill' : 'Text read from the photo'),
    pasteInstead: 'Paste the bill text instead',
    pasteHere: 'Paste the bill text here',
    pasteAria: 'Bill text',
    readText: 'Read this text',
    whatTheBillSays: 'What the bill says',
    vehicleOptional: 'Vehicle (if any)',
    amountTotal: 'Total ₹ (with GST)',
    readAs: (v: string) => `Read as ${v}`,
    fromPhoto: 'from photo',
    correctedFrom: (v: string) => `corrected — photo said ${v}`,
    photoSaid: (v: string, why: string) => `photo said ${v} — ${why}`,
    notYourVehicle: 'not one of your vehicles',
    notThisDesk: 'not a type this desk adds',
    note: 'Type what the paper says. A wrong bill is rejected at checking.',
  },

  chain: {
    nextStep: 'Next step',
    notYours: (action: string, why: string) => `${action} — not your step. ${why}`,
    yourStep: 'Your step',
    signedTwice: 'You signed this already. Write why — the director will see it.',
    reasonMust: 'Reason (needed)',
    noteOptional: 'Note (if any)',
    cancel: 'Cancel',
    paidBy: 'Paid by',
    utr: 'UTR / ref. no.',
    chequeNo: 'Cheque number',
    paidOn: 'Paid on',
    modes: { NEFT: 'NEFT', RTGS: 'RTGS', IMPS: 'IMPS', UPI: 'UPI', Cheque: 'Cheque', Cash: 'Cash' } satisfies Record<PaymentMode, string> as Record<PaymentMode, string>,
    history: 'History',
    addedBy: (who: string, when: string, whatsapp: boolean) => `Added by ${who} · ${when}${whatsapp ? ' · WhatsApp' : ''}`,
    twice: 'Signed twice',
    noHistory: 'Older bill — no history kept.',
    paid: (mode: string, utr: string | null, on: string) => `Paid by ${mode}${utr ? ` · UTR ${utr}` : ''} · ${on}`,
    waitingHere: (n: number, amount: string, litres: number) =>
      `${n} ${n === 1 ? 'bill' : 'bills'} for you · ${amount}${litres > 0 ? ` · ${litres.toLocaleString('en-IN')} L` : ''}`,
    oneByOne: (n: number) => ` · ${n} to do one by one`,
    doAll: (action: string, n: number, amount: string) => `${action} all ${n} · ${amount}`,
    doneAll: (n: number, amount: string) => `Done: ${n} ${n === 1 ? 'bill' : 'bills'} · ${amount}`,
    confirmTitle: (action: string, n: number) => `${action}: ${n} ${n === 1 ? 'bill' : 'bills'}`,
    confirmBody: (n: number, amount: string, litres: number) =>
      `${n} ${n === 1 ? 'bill' : 'bills'} · ${amount}${litres > 0 ? ` · ${litres.toLocaleString('en-IN')} L diesel` : ''}. Each is saved under your name.`,
    oneTransfer: 'One payment: the same UTR goes on every bill.',
    leftOut: 'Left out:',
  },

  whatsapp: {
    title: 'WhatsApp bills',
    fetch: 'Get from WhatsApp',
    importChat: 'Add chat file',
    demo: 'Try demo',
    note: 'Drivers just send a photo of the diesel slip to the WhatsApp number. Linck reads it.',
    collecting: 'Getting messages…',
    readingSlip: (i: number, n: number) => `Reading slip ${i} of ${n}…`,
    couldNotRead: 'Could not read that file.',
    added: (n: number, amount: string) => `${n} ${n === 1 ? 'bill' : 'bills'} · ${amount} added. They wait to be checked in Expenses.`,
    inbox: { signIn: 'Sign in to get WhatsApp bills.', status: (s: number) => `Server error (${s}).`, unreachable: 'Cannot reach Linck. Add the chat file instead.' },
    archive: { tooBig: 'This file is too big for a chat file.', noChat: 'No chat found. In WhatsApp use "Export chat" and pick the .zip.' },
    businessNumber: 'WhatsApp number',
    demoSuffix: '(demo)',
    from: (via: string) => `From: ${via}`,
    outcome: {
      add: 'Ready',
      needs_details: 'Needs details',
      repeat: 'Repeat',
      already_imported: 'Already added',
      already_in_linck: 'Already here',
      no_fill: 'No diesel',
    } satisfies Record<ImportOutcome, string>,
    leftOutStamp: 'Left out',
    toCheckCount: (n: number) => `${n} to check`,
    columns: { sent: 'Sent by', result: 'Result', vehicle: 'Vehicle', litres: 'Litres', amount: 'Amount', bunk: 'Bunk · bill', toCheck: 'To check' },
    more: (n: number) => ` (+${n} more)`,
    chips: { all: 'All', ready: 'Ready', needs: 'Needs details', left: 'Not added' },
    noDiesel: 'No diesel messages here.',
    noneInList: 'Nothing in this list.',
    showAll: 'Show all',
    readyLine: (n: number, amount: string, litres: number) => `${n} ${n === 1 ? 'bill' : 'bills'} ready · ${amount} · ${litres.toLocaleString('en-IN')} L`,
    readySub: 'Linck read these. They will be checked next.',
    addN: (n: number) => `Add ${n} ${n === 1 ? 'bill' : 'bills'}`,
    nothingYet: 'No slips yet.',
    nothingYetHow: 'Get them from WhatsApp, add a chat file, or try the demo.',
    confirmTitle: 'Add these diesel bills',
    confirmBody: (n: number, litres: number, amount: string) =>
      `${n} ${n === 1 ? 'bill' : 'bills'} · ${litres.toLocaleString('en-IN')} L · ${amount}. They go to the fleet desk to be checked.`,
    confirmRest: 'Repeats and incomplete ones stay here.',
    sent: 'What the driver sent',
    slipAlt: 'Slip photo from WhatsApp',
    photoNotInFile: 'The photo is not in this file.',
    noPhoto: 'No photo — words only.',
    noWords: 'No words with it.',
    read: 'What Linck read',
    driver: 'Driver',
    notOnList: (sender: string) => `Not on the list (${sender})`,
    perLitre: '₹ a litre',
    bunk: 'Bunk',
    slip: 'Slip',
    slipRead: 'Read',
    slipNotRead: 'Not read',
    fromSlip: (parts: string[]) => `From the slip: ${parts.join(', ')}`,
    slipParts: { litres: 'litres', amount: 'rupees', vehicle: 'vehicle' },
    toCheck: 'To check',
    fix: 'Fix details',
    notKnown: 'Not known',
    leaveOut: 'Leave out',
    putBack: 'Put back',
  },

  summary: {
    title: 'Diesel report',
    meta: (fills: number, litres: string, amount: string) => `${fills} fills · ${litres} L · ${amount}`,
    notChecked: (amount: string) => `${amount} not checked yet`,
    dated: (from: string, to: string) => `${from} to ${to}`,
    byVehicle: 'By vehicle',
    byDriver: 'By driver',
    vehicle: 'Vehicle',
    driver: 'Driver',
    fills: 'Fills',
    litres: 'Litres',
    amount: 'Amount',
    perLitre: 'Per litre',
    notCheckedCol: 'Not checked',
    noVehicle: 'No vehicle',
    driverNotKnown: 'Driver not known',
    none: 'No diesel bills here.',
  },

  approvals: {
    title: 'Approve bills',
    allBills: 'All bills',
    meta: (n: number, amount: string) => `${n} ${n === 1 ? 'bill' : 'bills'} · ${amount}`,
    diesel: (litres: string) => `${litres} L diesel`,
    rejected: (n: number, amount: string) => `${n} rejected (${amount}), not counted`,
    tiles: {
      forYou: 'For you to approve',
      nothing: 'Nothing waiting',
      waiting: (n: number, oldest: string) => `${n} ${n === 1 ? 'bill' : 'bills'} · oldest ${oldest}`,
      notChecked: 'Not checked yet',
      withAccounts: 'With accounts',
      toPay: (n: number) => `${n} to pay`,
      paid: 'Paid',
      bills: (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`,
    },
    age: (days: number) => (days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`),
    ageCap: (days: number) => (days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`),
    buckets: { 'under-1': 'Under a day', '1-3': '1–3 days', '3-7': '3–7 days', 'over-7': 'Over a week' },
    oldestFirst: 'Oldest first',
    toApprove: 'Bills to approve',
    howLong: 'How long',
    waitingTime: 'Waiting time',
    ageSummary: (n: number, amount: string, overWeek: number) => `${n} bills, ${amount}, waiting. ${overWeek} over a week.`,
    countedFrom: 'Counted from when the bill was checked.',
    whereMoney: 'Where the money goes',
    summaryTitle: 'Expense summary',
    groups: { type: 'By type', site: 'By site', vehicle: 'By vehicle', desk: 'By desk' },
    groupHead: { type: 'Type', site: 'Site', vehicle: 'Vehicle', desk: 'Desk' },
    stageGroup: 'Where it is',
    stages: { desk: 'To check', director: 'With director', accounts: 'With accounts', paid: 'Paid' },
    billsCol: 'Bills',
    total: 'Total',
    dieselCol: 'Diesel',
    rejectedCol: 'Rejected',
    footnote: (amount: string, n: number) => `Total ${amount} · ${n} ${n === 1 ? 'bill' : 'bills'}. Rejected and deleted bills not counted.`,
    noVehicleNote: 'Stores bills have no vehicle.',
    columns: { bill: 'Bill', type: 'Type', shop: 'Shop', site: 'Site', amount: 'Amount', waiting: 'Waiting', twice: 'Signed twice' },
    twiceStamp: 'Twice',
    nothingForYou: 'Nothing waiting for you.',
    noBills: 'No bills here yet.',
    signedTwiceCaption: 'Signed twice',
    signedTwiceTitle: 'Same person signed twice',
    nobodyTwice: 'Nobody signed a bill twice.',
    openPhoto: 'Open photo',
  },
};

const ta: typeof en = {
  desk: { fleet: 'வண்டிகள்', stores: 'ஸ்டோர்ஸ்', finance: 'கணக்கு', overview: 'மேலோட்டம்' },
  deskName: (d) => (d === 'fleet' ? 'வண்டிகள்' : d === 'stores' ? 'ஸ்டோர்ஸ்' : 'கணக்கு'),
  bills: (n) => `${n} பில்${n === 1 ? '' : 'கள்'}`,
  action: ACTION_TA,
  done: (action, who) => `${who} ${DONE_TA[action]}`,

  problem: (p, status) => {
    switch (p.code) {
      case 'wrong-step':
        return `இப்போது முடியாது — பில் "${status(p.status)}" நிலையில் உள்ளது.`;
      case 'needs-permission':
        return `இதை ${WHO_TA[p.permission] ?? 'வேறொருவர்'} மட்டுமே செய்ய முடியும்.`;
      case 'only-step-owner':
        return 'இந்த நிலையில் உள்ளவர் மட்டுமே நிராகரிக்க முடியும்.';
      case 'only-desk-deletes':
        return 'சேர்த்த பிரிவு மட்டுமே நீக்க முடியும்.';
      case 'second-signature':
        return 'நீங்கள் ஏற்கனவே கையெழுத்திட்டீர்கள். காரணம் எழுதுங்கள்.';
      case 'needs-reason':
        return `${ACTION_TA[p.action]}: காரணம் எழுதுங்கள்.`;
      case 'needs-payment':
        return 'UTR, தேதி டைப் செய்யுங்கள்.';
      case 'bad-utr':
        return 'UTR என்பது 6 முதல் 22 எழுத்து அல்லது எண்.';
      case 'utr-used':
        return `UTR ${p.utr} ஏற்கனவே பயன்படுத்தப்பட்டது.`;
      case 'future-payment-date':
        return 'தேதி இன்றைக்குப் பிறகு இருக்கக்கூடாது.';
      case 'batch-second-signature':
        return 'ஏற்கனவே கையெழுத்திட்டீர்கள் — தனியாகச் செய்யுங்கள்.';
      case 'bill-gone':
        return 'இந்த பில் இப்போது இல்லை.';
    }
  },

  notice: (n) => {
    switch (n.code) {
      case 'litres-rate-mismatch':
        return `லிட்டர் × விலை = ${rupee(n.expected)}, ஆனால் மொத்தம் ${rupee(n.stated)}.`;
      case 'unreadable':
        return `${FIELD_TA[n.field]} படிக்க முடியவில்லை ("${n.text}"). டைப் செய்யுங்கள்.`;
      case 'no-total':
        return 'மொத்தம் படிக்க முடியவில்லை. டைப் செய்யுங்கள்.';
      case 'no-bill-number':
        return 'பில் எண் படிக்க முடியவில்லை.';
      case 'rate-out-of-band':
        return `லிட்டருக்கு ${rupee(n.rate)} — ₹${n.min}–₹${n.max} இடையில் இல்லை. எண்களைச் சரிபாருங்கள்.`;
      case 'inferred': {
        const parts = [n.litres !== null ? `${n.litres} லிட்டர்` : null, n.amount !== null ? `₹${n.amount}` : null].filter(Boolean);
        return `அலகு இல்லாத எண்களிலிருந்து ஊகித்தது: ${parts.join(', ')}. சீட்டைச் சரிபாருங்கள்.`;
      }
      case 'no-litres':
        return 'லிட்டர் இல்லை.';
      case 'no-amount':
        return n.near !== null && n.litres
          ? `தொகை இல்லை. ${n.near} என எழுதியுள்ளது — ${n.litres} லிட்டருக்கு அது லிட்டருக்கு ${rupee(n.near / n.litres)}.`
          : 'தொகை இல்லை.';
      case 'no-photo':
        return 'பில் போட்டோ இல்லை.';
      case 'photo-only':
        return 'போட்டோ மட்டும் — எண்கள் சீட்டிலிருந்து.';
      case 'media-omitted':
        return 'போட்டோ இல்லாமல் சாட் சேமிக்கப்பட்டது.';
      case 'no-vehicle':
        return 'வண்டி எண் இல்லை.';
      case 'vehicle-unmatched':
        return `"${n.text}" எந்த ஒரு வண்டியுடனும் பொருந்தவில்லை.`;
      case 'not-own-fill':
        return `${n.sender} தன் டீசல் பற்றி அனுப்பவில்லை.`;
      case 'not-a-driver':
        return `${n.sender} டிரைவர் பட்டியலில் இல்லை.`;
      case 'no-fill':
        return 'டீசல் என்கிறது, ஆனால் லிட்டர், தொகை, போட்டோ எதுவும் இல்லை.';
      case 'same-photo-as-line':
        return `செய்தி ${n.line}-இல் உள்ள அதே போட்டோ.`;
      case 'same-figures-as-line':
        return `செய்தி ${n.line} போலவே அதே வண்டி, லிட்டர், தொகை.`;
      case 'slip-litres-differ':
        return `செய்தியில் ${n.message} லி., சீட்டில் ${n.slip} லி. சீட்டின் எண் எடுக்கப்பட்டது.`;
      case 'slip-amount-differ':
        return `செய்தியில் ${rupee(n.message)}, சீட்டில் ${rupee(n.slip)}. சீட்டின் எண் எடுக்கப்பட்டது.`;
      case 'slip-names-other-vehicle':
        return `சீட்டில் வேறு வண்டி: ${n.slip}.`;
      case 'slip-vehicle-unknown':
        return `சீட்டில் ${n.slip} — நம் வண்டி இல்லை.`;
      case 'slip-unreadable':
        return 'சீட்டைப் படிக்க முடியவில்லை. போட்டோவைப் பாருங்கள், அல்லது தெளிவான போட்டோ கேளுங்கள்.';
    }
  },

  reason: (r) => {
    switch (r.code) {
      case 'already-imported':
        return `${day(r.on)} அன்றே சேர்த்தது.`;
      case 'photo-in-linck':
        return `பில் ${r.bill}-இன் அதே போட்டோ.`;
      case 'same-photo-again':
        return r.line !== null ? `செய்தி ${r.line}-இன் அதே போட்டோ.` : 'அதே போட்டோ மீண்டும்.';
      case 'bill-in-linck':
        return `${r.vendor} பில் ${r.billNumber} ஏற்கனவே உள்ளது.`;
      case 'no-fill':
        return 'லிட்டர், தொகை, போட்டோ இல்லை.';
      case 'needs-details':
        return `${[r.vehicle ? 'வண்டி' : null, r.amount ? 'தொகை' : null].filter(Boolean).join(', ')} தேவை.`;
    }
  },

  register: {
    title: 'செலவுகள்',
    financeTitle: 'செலவு பில்கள்',
    addBill: 'பில் சேர்',
    waitingForYou: (n, amount) => (n === 0 ? 'உங்களுக்காக எதுவும் இல்லை' : `உங்களுக்கு: ${n} பில்${n === 1 ? '' : 'கள்'} · ${amount}`),
    all: 'எல்லாம்',
    corrected: 'கையால் திருத்தியவை',
    noBills: 'இங்கு இன்னும் பில்கள் இல்லை.',
    noneInList: 'இந்தப் பட்டியலில் பில்கள் இல்லை.',
    showAll: 'எல்லாம் காட்டு',
    columns: {
      bill: 'பில்',
      status: 'நிலை',
      type: 'வகை',
      shop: 'கடை',
      photo: 'போட்டோ',
      pdf: 'PDF',
      vehicle: 'வண்டி',
      driver: 'டிரைவர்',
      litres: 'லிட்டர்',
      amount: 'தொகை',
      addedBy: 'சேர்த்தவர்',
      groupBill: 'பில்',
      groupFor: 'எதற்கு',
      groupAmount: 'தொகை',
    },
  },

  detail: {
    photo: 'போட்டோ',
    openFile: (name, kb) => `${name} திற (${kb} KB)`,
    photoAlt: (bill) => `பில் ${bill} போட்டோ`,
    noPhoto: 'இந்த பில்லுக்கு போட்டோ இல்லை.',
    readFromPhoto: 'போட்டோவிலிருந்து படித்தது',
    field: 'விவரம்',
    photoSays: 'போட்டோவில்',
    saved: 'சேமித்தது',
    notRead: 'படிக்கவில்லை',
    correctedBy: (who) => `${who} திருத்தினார்`,
    readBy: 'Linck படித்தது',
    correctTitle: 'திருத்து',
    correct: 'திருத்து',
    save: 'சேமி',
    cancel: 'ரத்து',
    bill: 'பில்',
    fields: {
      kind: 'வகை',
      billNumber: 'பில் எண்',
      billDate: 'பில் தேதி',
      vendor: 'கடை',
      vehicle: 'வண்டி',
      litres: 'லிட்டர்',
      amount: 'தொகை',
      amountRupees: 'தொகை ₹',
      rate: 'விலை',
      gstin: 'GSTIN',
      whatFor: 'எதற்கு',
      addedBy: 'சேர்த்தவர்',
    },
    errors: {
      amount: 'மொத்தம் டைப் செய்யுங்கள், உதா. 12,500.00',
      litres: 'லிட்டர் டைப் செய்யுங்கள், உதா. 120.45',
      dieselLitres: 'டீசல் பில்லுக்கு லிட்டர் தேவை',
      date: 'பில் தேதியைத் தேர்ந்தெடுங்கள்',
      futureDate: 'தேதி இன்றைக்குப் பிறகு இருக்கக்கூடாது',
      blank: 'பில் எண்ணும் கடையும் டைப் செய்யுங்கள்',
    },
  },

  upload: {
    title: (desk) => (desk === 'fleet' ? 'வண்டி பில் சேர்' : 'ஸ்டோர்ஸ் பில் சேர்'),
    submit: 'சரிபார்க்க அனுப்பு',
    stillNeeded: (list) => `இன்னும் தேவை: ${list.join(', ')}`,
    bookedTo: (site) => `${site}-க்கு சேமிக்கப்படும். அடுத்து: சரிபார்ப்பு, இயக்குநர், கணக்காளர்.`,
    needs: {
      photo: 'போட்டோ',
      billNumber: 'பில் எண்',
      billDate: 'பில் தேதி',
      vendor: 'கடை',
      amount: 'தொகை',
      litres: 'லிட்டர்',
      vehicle: 'வண்டி',
      site: 'சைட்',
    },
    tapToAdd: 'போட்டோ எடுக்க அல்லது ஃபைல் தேர்ந்தெடுக்கத் தொடுங்கள்',
    fileTypes: (mb) => `JPG, PNG அல்லது PDF · ${mb} MB வரை`,
    pdfAttached: 'PDF சேர்த்தது',
    cannotShow: 'சேர்த்தது, ஆனால் இங்கு காட்ட முடியாது',
    photoAria: 'பில் போட்டோ',
    photoAlt: 'பில் போட்டோ',
    wrongFile: 'பில்லின் JPG, PNG அல்லது PDF போட்டோவைச் சேருங்கள்.',
    tooBig: (mb) => `ஃபைல் ${mb} MB-க்கு மேல். மீண்டும் போட்டோ எடுங்கள்.`,
    reading: (pct) => `பில்லைப் படிக்கிறது… ${pct}%`,
    read: 'படித்தது. நிரப்பிய ஒவ்வொன்றையும் பேப்பருடன் சரிபாருங்கள்.',
    failed: 'இந்த போட்டோவைப் படிக்க முடியவில்லை. விவரங்களை டைப் செய்யுங்கள்.',
    pdf: 'PDF இன்னும் படிக்கப்படுவதில்லை. விவரங்களை டைப் செய்யுங்கள், அல்லது உரையை ஒட்டுங்கள்.',
    textRead: (pasted) => (pasted ? 'ஒட்டிய பில்லின் உரை' : 'போட்டோவிலிருந்து படித்த உரை'),
    pasteInstead: 'பில் உரையை ஒட்டு',
    pasteHere: 'பில் உரையை இங்கே ஒட்டுங்கள்',
    pasteAria: 'பில் உரை',
    readText: 'இந்த உரையைப் படி',
    whatTheBillSays: 'பில்லில் உள்ளது',
    vehicleOptional: 'வண்டி (இருந்தால்)',
    amountTotal: 'மொத்தம் ₹ (GST உட்பட)',
    readAs: (v) => `${v} எனப் படித்தது`,
    fromPhoto: 'போட்டோவிலிருந்து',
    correctedFrom: (v) => `திருத்தியது — போட்டோவில் ${v}`,
    photoSaid: (v, why) => `போட்டோவில் ${v} — ${why}`,
    notYourVehicle: 'உங்கள் வண்டி இல்லை',
    notThisDesk: 'இந்தப் பிரிவு சேர்க்கும் வகை இல்லை',
    note: 'பேப்பரில் உள்ளதை டைப் செய்யுங்கள். தவறான பில் சரிபார்ப்பில் நிராகரிக்கப்படும்.',
  },

  chain: {
    nextStep: 'அடுத்த படி',
    notYours: (action, why) => `${action} — உங்கள் படி இல்லை. ${why}`,
    yourStep: 'உங்கள் படி',
    signedTwice: 'நீங்கள் ஏற்கனவே கையெழுத்திட்டீர்கள். காரணம் எழுதுங்கள் — இயக்குநர் பார்ப்பார்.',
    reasonMust: 'காரணம் (தேவை)',
    noteOptional: 'குறிப்பு (இருந்தால்)',
    cancel: 'ரத்து',
    paidBy: 'எப்படி கொடுத்தது',
    utr: 'UTR / குறிப்பு எண்',
    chequeNo: 'காசோலை எண்',
    paidOn: 'கொடுத்த தேதி',
    modes: { NEFT: 'NEFT', RTGS: 'RTGS', IMPS: 'IMPS', UPI: 'UPI', Cheque: 'காசோலை', Cash: 'ரொக்கம்' },
    history: 'வரலாறு',
    addedBy: (who, when, whatsapp) => `${who} சேர்த்தார் · ${when}${whatsapp ? ' · வாட்ஸ்அப்' : ''}`,
    twice: 'இரு முறை கையெழுத்து',
    noHistory: 'பழைய பில் — வரலாறு இல்லை.',
    paid: (mode, utr, on) => `${mode} மூலம் கொடுத்தது${utr ? ` · UTR ${utr}` : ''} · ${on}`,
    waitingHere: (n, amount, litres) =>
      `உங்களுக்கு ${n} பில்${n === 1 ? '' : 'கள்'} · ${amount}${litres > 0 ? ` · ${litres.toLocaleString('en-IN')} லி.` : ''}`,
    oneByOne: (n) => ` · ${n} தனித்தனியாக`,
    doAll: (action, n, amount) => `எல்லா ${n}-க்கும் ${action} · ${amount}`,
    doneAll: (n, amount) => `முடிந்தது: ${n} பில்${n === 1 ? '' : 'கள்'} · ${amount}`,
    confirmTitle: (action, n) => `${action}: ${n} பில்${n === 1 ? '' : 'கள்'}`,
    confirmBody: (n, amount, litres) =>
      `${n} பில்${n === 1 ? '' : 'கள்'} · ${amount}${litres > 0 ? ` · ${litres.toLocaleString('en-IN')} லி. டீசல்` : ''}. ஒவ்வொன்றும் உங்கள் பெயரில் சேமிக்கப்படும்.`,
    oneTransfer: 'ஒரே பணம்: ஒவ்வொரு பில்லிலும் அதே UTR.',
    leftOut: 'விடுபட்டவை:',
  },

  whatsapp: {
    title: 'வாட்ஸ்அப் பில்கள்',
    fetch: 'வாட்ஸ்அப்பிலிருந்து எடு',
    importChat: 'சாட் ஃபைல் சேர்',
    demo: 'டெமோ பார்',
    note: 'டிரைவர்கள் டீசல் சீட்டின் போட்டோவை வாட்ஸ்அப் எண்ணுக்கு அனுப்பினால் போதும். Linck படிக்கும்.',
    collecting: 'செய்திகளை எடுக்கிறது…',
    readingSlip: (i, n) => `சீட்டு ${i} / ${n} படிக்கிறது…`,
    couldNotRead: 'அந்த ஃபைலைப் படிக்க முடியவில்லை.',
    added: (n, amount) => `${n} பில்${n === 1 ? '' : 'கள்'} · ${amount} சேர்த்தது. செலவுகளில் சரிபார்க்கக் காத்திருக்கின்றன.`,
    inbox: {
      signIn: 'வாட்ஸ்அப் பில்கள் பெற உள்நுழையுங்கள்.',
      status: (s) => `சர்வர் பிழை (${s}).`,
      unreachable: 'Linck-ஐ அணுக முடியவில்லை. சாட் ஃபைலைச் சேருங்கள்.',
    },
    archive: { tooBig: 'சாட் ஃபைலுக்கு இது மிகப் பெரியது.', noChat: 'சாட் இல்லை. வாட்ஸ்அப்பில் "Export chat" செய்து .zip-ஐத் தேர்ந்தெடுங்கள்.' },
    businessNumber: 'வாட்ஸ்அப் எண்',
    demoSuffix: '(டெமோ)',
    from: (via) => `${via} இலிருந்து`,
    outcome: {
      add: 'தயார்',
      needs_details: 'விவரம் தேவை',
      repeat: 'மீண்டும் வந்தது',
      already_imported: 'ஏற்கனவே சேர்த்தது',
      already_in_linck: 'ஏற்கனவே உள்ளது',
      no_fill: 'டீசல் இல்லை',
    },
    leftOutStamp: 'விடப்பட்டது',
    toCheckCount: (n) => `${n} சரிபார்க்க`,
    columns: { sent: 'அனுப்பியவர்', result: 'நிலை', vehicle: 'வண்டி', litres: 'லிட்டர்', amount: 'தொகை', bunk: 'பங்க் · பில்', toCheck: 'சரிபார்க்க' },
    more: (n) => ` (+${n} மேலும்)`,
    chips: { all: 'எல்லாம்', ready: 'தயார்', needs: 'விவரம் தேவை', left: 'சேர்க்காதவை' },
    noDiesel: 'இங்கு டீசல் செய்திகள் இல்லை.',
    noneInList: 'இந்தப் பட்டியலில் எதுவும் இல்லை.',
    showAll: 'எல்லாம் காட்டு',
    readyLine: (n, amount, litres) => `${n} பில்${n === 1 ? '' : 'கள்'} தயார் · ${amount} · ${litres.toLocaleString('en-IN')} லி.`,
    readySub: 'இவற்றை Linck படித்தது. அடுத்து சரிபார்க்கப்படும்.',
    addN: (n) => `${n} பில்${n === 1 ? '' : 'கள்'} சேர்`,
    nothingYet: 'இன்னும் சீட்டுகள் இல்லை.',
    nothingYetHow: 'வாட்ஸ்அப்பிலிருந்து எடுங்கள், சாட் ஃபைல் சேருங்கள், அல்லது டெமோ பாருங்கள்.',
    confirmTitle: 'இந்த டீசல் பில்களைச் சேர்',
    confirmBody: (n, litres, amount) =>
      `${n} பில்${n === 1 ? '' : 'கள்'} · ${litres.toLocaleString('en-IN')} லி. · ${amount}. சரிபார்க்க வண்டிப் பிரிவுக்குச் செல்லும்.`,
    confirmRest: 'மீண்டும் வந்தவையும் முழுமையில்லாதவையும் இங்கேயே இருக்கும்.',
    sent: 'டிரைவர் அனுப்பியது',
    slipAlt: 'வாட்ஸ்அப் சீட்டு போட்டோ',
    photoNotInFile: 'இந்த ஃபைலில் போட்டோ இல்லை.',
    noPhoto: 'போட்டோ இல்லை — எழுத்து மட்டும்.',
    noWords: 'எழுத்து எதுவும் இல்லை.',
    read: 'Linck படித்தது',
    driver: 'டிரைவர்',
    notOnList: (sender) => `பட்டியலில் இல்லை (${sender})`,
    perLitre: 'லிட்டர் விலை ₹',
    bunk: 'பங்க்',
    slip: 'சீட்டு',
    slipRead: 'படித்தது',
    slipNotRead: 'படிக்கவில்லை',
    fromSlip: (parts) => `சீட்டிலிருந்து: ${parts.join(', ')}`,
    slipParts: { litres: 'லிட்டர்', amount: 'தொகை', vehicle: 'வண்டி' },
    toCheck: 'சரிபார்க்க',
    fix: 'விவரம் சரிசெய்',
    notKnown: 'தெரியவில்லை',
    leaveOut: 'விட்டுவிடு',
    putBack: 'மீண்டும் சேர்',
  },

  summary: {
    title: 'டீசல் அறிக்கை',
    meta: (fills, litres, amount) => `${fills} முறை · ${litres} லி. · ${amount}`,
    notChecked: (amount) => `${amount} இன்னும் சரிபார்க்கவில்லை`,
    dated: (from, to) => `${from} முதல் ${to} வரை`,
    byVehicle: 'வண்டி வாரியாக',
    byDriver: 'டிரைவர் வாரியாக',
    vehicle: 'வண்டி',
    driver: 'டிரைவர்',
    fills: 'முறை',
    litres: 'லிட்டர்',
    amount: 'தொகை',
    perLitre: 'லிட்டருக்கு',
    notCheckedCol: 'சரிபார்க்கவில்லை',
    noVehicle: 'வண்டி இல்லை',
    driverNotKnown: 'டிரைவர் தெரியவில்லை',
    none: 'இங்கு டீசல் பில்கள் இல்லை.',
  },

  approvals: {
    title: 'பில் அனுமதி',
    allBills: 'எல்லா பில்களும்',
    meta: (n, amount) => `${n} பில்${n === 1 ? '' : 'கள்'} · ${amount}`,
    diesel: (litres) => `${litres} லி. டீசல்`,
    rejected: (n, amount) => `${n} நிராகரிப்பு (${amount}), கணக்கில் இல்லை`,
    tiles: {
      forYou: 'நீங்கள் அனுமதிக்க வேண்டியவை',
      nothing: 'எதுவும் காத்திருக்கவில்லை',
      waiting: (n, oldest) => `${n} பில்${n === 1 ? '' : 'கள்'} · பழையது ${oldest}`,
      notChecked: 'இன்னும் சரிபார்க்கவில்லை',
      withAccounts: 'கணக்காளரிடம்',
      toPay: (n) => `${n} கொடுக்க வேண்டும்`,
      paid: 'பணம் கொடுத்தது',
      bills: (n) => `${n} பில்${n === 1 ? '' : 'கள்'}`,
    },
    age: (days) => (days === 0 ? 'இன்று' : `${days} நாள்`),
    ageCap: (days) => (days === 0 ? 'இன்று' : `${days} நாள்`),
    buckets: { 'under-1': '1 நாளுக்குள்', '1-3': '1–3 நாள்', '3-7': '3–7 நாள்', 'over-7': 'ஒரு வாரத்துக்கு மேல்' },
    oldestFirst: 'பழையது முதலில்',
    toApprove: 'அனுமதிக்க வேண்டிய பில்கள்',
    howLong: 'எவ்வளவு நாள்',
    waitingTime: 'காத்திருப்பு நேரம்',
    ageSummary: (n, amount, overWeek) => `${n} பில்கள், ${amount}, காத்திருக்கின்றன. ${overWeek} ஒரு வாரத்துக்கு மேல்.`,
    countedFrom: 'சரிபார்த்த நேரத்திலிருந்து கணக்கு.',
    whereMoney: 'பணம் எங்கே போகிறது',
    summaryTitle: 'செலவு சுருக்கம்',
    groups: { type: 'வகை வாரியாக', site: 'சைட் வாரியாக', vehicle: 'வண்டி வாரியாக', desk: 'பிரிவு வாரியாக' },
    groupHead: { type: 'வகை', site: 'சைட்', vehicle: 'வண்டி', desk: 'பிரிவு' },
    stageGroup: 'எங்கே உள்ளது',
    stages: { desk: 'சரிபார்க்க', director: 'இயக்குநரிடம்', accounts: 'கணக்காளரிடம்', paid: 'கொடுத்தது' },
    billsCol: 'பில்கள்',
    total: 'மொத்தம்',
    dieselCol: 'டீசல்',
    rejectedCol: 'நிராகரிப்பு',
    footnote: (amount, n) => `மொத்தம் ${amount} · ${n} பில்${n === 1 ? '' : 'கள்'}. நிராகரித்த, நீக்கிய பில்கள் கணக்கில் இல்லை.`,
    noVehicleNote: 'ஸ்டோர்ஸ் பில்களுக்கு வண்டி இல்லை.',
    columns: { bill: 'பில்', type: 'வகை', shop: 'கடை', site: 'சைட்', amount: 'தொகை', waiting: 'காத்திருப்பு', twice: 'இரு முறை கையெழுத்து' },
    twiceStamp: 'இரு முறை',
    nothingForYou: 'உங்களுக்காக எதுவும் காத்திருக்கவில்லை.',
    noBills: 'இங்கு இன்னும் பில்கள் இல்லை.',
    signedTwiceCaption: 'இரு முறை கையெழுத்து',
    signedTwiceTitle: 'ஒரே நபர் இரு முறை கையெழுத்து',
    nobodyTwice: 'யாரும் ஒரு பில்லில் இரு முறை கையெழுத்திடவில்லை.',
    openPhoto: 'போட்டோ திற',
  },
};

export const expenseWords = words({ en, ta });
