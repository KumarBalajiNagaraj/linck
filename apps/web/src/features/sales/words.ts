import type { Receipt, Trip } from '@linck/mock';
import { words } from '../../i18n/words.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import type { CustomerGap, OrderGap } from './salesApi.js';

/**
 * The sales screens' words, in English and Tamil (LIN-23, docs/WRITING.md).
 *
 * One file for the five screens, so the desk reads one vocabulary: a load's
 * "Sale" and "Profit" on the board are the same words in its cost sheet, and
 * "Money due" on the customer list is "Money due" on the invoices page.
 *
 * Statuses (invoice, trip, order, e-way bill) come from `i18n/statusWords`.
 * Names, places, materials and numbers people typed are shown as typed.
 */

/** English needs "1 load" and "2 loads"; Tamil says லோடு for any count. */
const loads = (n: number) => `${n} ${n === 1 ? 'load' : 'loads'}`;
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/* ---------------------------------------------------------------- refusals */

/** Who holds each key, in words a person knows. */
const WHO_EN: Record<string, string> = {
  'sales.customer.read': 'the sales desk',
  'sales.customer.write': 'the sales desk',
  'sales.order.read': 'the sales desk',
  'sales.order.write': 'the sales desk',
  'sales.order.approve': 'a sales manager',
};
const WHO_TA: Record<string, string> = {
  'sales.customer.read': 'விற்பனைப் பிரிவு',
  'sales.customer.write': 'விற்பனைப் பிரிவு',
  'sales.order.read': 'விற்பனைப் பிரிவு',
  'sales.order.write': 'விற்பனைப் பிரிவு',
  'sales.order.approve': 'சேல்ஸ் மேனேஜர்',
};

/**
 * A value the API would not store, said as the fix (docs/WRITING.md rule 3).
 * `field` is the request's name for it. The API's own note is English for
 * the log and is never shown.
 */
function invalidEn(field: string): string {
  switch (field) {
    case 'name':
      return 'Type the name';
    case 'gstin':
      return 'Type the 15-letter GST no., or leave it blank';
    case 'servedFromSiteId':
    case 'siteId':
      return 'Pick our site';
    case 'creditLimit':
      return 'Type the credit limit, like 5,00,000';
    case 'paymentTermsDays':
      return 'Credit days are 0 to 365';
    case 'phone':
      return 'Phone is up to 20 digits';
    case 'contactName':
      return 'Shorten the contact name';
    case 'site':
      return 'Shorten where to deliver';
    case 'customerId':
      return 'Pick the customer again';
    case 'customerPoRef':
      return 'Type their order no.';
    case 'productCode':
      return 'Pick the material';
    case 'orderedUnits':
      return 'Type the units, like 40';
    case 'ratePerUnit':
      return 'Type the rate, like 4,825.50';
    case 'deliverBy':
      return 'Pick the deliver-by date';
    case 'deliverySite':
      return 'Type where to deliver';
    case 'reason':
      return 'Shorten the reason';
    default:
      return 'Check the details, then try again';
  }
}
function invalidTa(field: string): string {
  switch (field) {
    case 'name':
      return 'பெயர் டைப் செய்யுங்கள்';
    case 'gstin':
      return '15 எழுத்து ஜிஎஸ்டி எண் டைப் செய்யுங்கள், அல்லது காலியாக விடுங்கள்';
    case 'servedFromSiteId':
    case 'siteId':
      return 'நம் சைட்டைத் தேர்ந்தெடுங்கள்';
    case 'creditLimit':
      return 'கடன் வரம்பு டைப் செய்யுங்கள், உதா. 5,00,000';
    case 'paymentTermsDays':
      return 'கடன் நாட்கள் 0 முதல் 365 வரை';
    case 'phone':
      return 'போன் எண் 20 இலக்கங்களுக்குள்';
    case 'contactName':
      return 'தொடர்பு நபர் பெயரைச் சுருக்குங்கள்';
    case 'site':
      return 'டெலிவரி இடத்தைச் சுருக்குங்கள்';
    case 'customerId':
      return 'வாடிக்கையாளரை மீண்டும் தேர்ந்தெடுங்கள்';
    case 'customerPoRef':
      return 'அவர்கள் ஆர்டர் எண் டைப் செய்யுங்கள்';
    case 'productCode':
      return 'பொருளைத் தேர்ந்தெடுங்கள்';
    case 'orderedUnits':
      return 'யூனிட் டைப் செய்யுங்கள், உதா. 40';
    case 'ratePerUnit':
      return 'விலை டைப் செய்யுங்கள், உதா. 4,825.50';
    case 'deliverBy':
      return 'டெலிவரி கெடு தேதியைத் தேர்ந்தெடுங்கள்';
    case 'deliverySite':
      return 'டெலிவரி இடம் டைப் செய்யுங்கள்';
    case 'reason':
      return 'காரணத்தைச் சுருக்குங்கள்';
    default:
      return 'விவரங்களைச் சரிபார்த்து, மீண்டும் முயலுங்கள்';
  }
}

/** Which record a refusal is about: it says "this order" or "this customer". */
type Subject = 'customer' | 'order';

/* ------------------------------------------------------------ shared words */

export const salesWords = words({
  en: {
    eyebrow: 'Sales',
    all: 'All',
    showAll: 'Show all',
    customer: 'Customer',
    material: 'Material',
    status: 'Status',
    date: 'Date',
    rate: 'Rate',
    amount: 'Amount',
    total: 'Total',
    sold: 'Sold',
    trip: 'Trip',
    vehicle: 'Vehicle',
    units: 'units',
    tonnes: 'tonnes',
    km: 'km',
    unitsN: (q: string) => `${q} units`,
    /** How a sold quantity was counted — how much argument it will take. */
    countedBy: 'Counted by',
    basis: {
      loader_buckets: 'Bucket count',
      plant_weighbridge: 'Our weighbridge',
      customer_weighbridge: 'Customer weighbridge',
      agreed_units: 'Agreed, not weighed',
    } satisfies Record<Trip['qtyBasis'], string>,
    /**
     * Where a figure comes from, shown on hover over its time. Plain words for
     * the person; the view behind each is named in a comment where it is used.
     */
    src: {
      loads: 'Loads',
      invoices: 'Invoices',
      orders: 'Orders',
      customers: 'Customers',
      payments: 'Payments received',
      salesDesk: 'Loads, orders and invoices',
    },
    save: 'Save',
    cancel: 'Cancel',
    saving: 'Saving…',
    retry: 'Try again',
    stillNeeded: (list: string[]) => `Still needed: ${list.join(', ')}`,
    /**
     * Why a customer or an order could not be saved, read or moved: live, the
     * API's refusal, or the API not answering. `status` is an order's status
     * in words.
     */
    problem: (p: RecordProblem, subject: Subject, status: (s: string) => string): string => {
      switch (p.code) {
        case 'needs-permission':
          return `Only ${WHO_EN[p.permission] ?? 'someone else'} can do this here.`;
        case 'wrong-step':
          return `Not now — this order is "${status(p.status)}".`;
        case 'needs-reason':
          return 'Write the reason, then reject.';
        case 'gstin-used':
          return `GST no. ${p.gstin} is already on another customer.`;
        case 'gone':
          return subject === 'order' ? 'This order is no longer here.' : 'This customer is no longer here.';
        case 'invalid':
          return `${invalidEn(p.field)}.`;
        case 'signed-out':
          return 'You were signed out. Sign in again.';
        case 'offline':
          return 'Linck did not answer. Check the internet, then try again.';
        case 'server':
          return p.status > 0 ? `Linck had a problem (error ${p.status}). Try again.` : 'Linck had a problem. Try again.';
        // Not a refusal the sales desk's requests are ever given.
        case 'vehicle-already-down':
          return 'Check the details, then try again.';
      }
    },
  },
  ta: {
    eyebrow: 'விற்பனை',
    all: 'எல்லாம்',
    showAll: 'எல்லாம் காட்டு',
    customer: 'வாடிக்கையாளர்',
    material: 'பொருள்',
    status: 'நிலை',
    date: 'தேதி',
    rate: 'விலை',
    amount: 'தொகை',
    total: 'மொத்தம்',
    sold: 'விற்றது',
    trip: 'ட்ரிப்',
    vehicle: 'வண்டி',
    units: 'யூனிட்',
    tonnes: 'டன்',
    km: 'கி.மீ.',
    unitsN: (q) => `${q} யூனிட்`,
    countedBy: 'அளந்த முறை',
    basis: {
      loader_buckets: 'பக்கெட் கணக்கு',
      plant_weighbridge: 'நம் எடை மேடை',
      customer_weighbridge: 'வாடிக்கையாளர் எடை மேடை',
      agreed_units: 'பேசிய அளவு, எடை இல்லை',
    },
    src: {
      loads: 'லோடுகள்',
      invoices: 'இன்வாய்ஸ்கள்',
      orders: 'ஆர்டர்கள்',
      customers: 'வாடிக்கையாளர்கள்',
      payments: 'வந்த பணம்',
      salesDesk: 'லோடு, ஆர்டர், இன்வாய்ஸ்',
    },
    save: 'சேமி',
    cancel: 'ரத்து',
    saving: 'சேமிக்கிறது…',
    retry: 'மீண்டும் முயல்',
    stillNeeded: (list) => `இன்னும் தேவை: ${list.join(', ')}`,
    problem: (p, subject, status) => {
      switch (p.code) {
        case 'needs-permission':
          return `இதை ${WHO_TA[p.permission] ?? 'வேறொருவர்'} மட்டுமே செய்ய முடியும்.`;
        case 'wrong-step':
          return `இப்போது முடியாது — ஆர்டர் "${status(p.status)}" நிலையில் உள்ளது.`;
        case 'needs-reason':
          return 'காரணம் எழுதி, பிறகு நிராகரியுங்கள்.';
        case 'gstin-used':
          return `ஜிஎஸ்டி எண் ${p.gstin} ஏற்கனவே வேறொரு வாடிக்கையாளருக்கு உள்ளது.`;
        case 'gone':
          return subject === 'order' ? 'இந்த ஆர்டர் இப்போது இல்லை.' : 'இந்த வாடிக்கையாளர் இப்போது இல்லை.';
        case 'invalid':
          return `${invalidTa(p.field)}.`;
        case 'signed-out':
          return 'நீங்கள் வெளியேற்றப்பட்டீர்கள். மீண்டும் உள்நுழையுங்கள்.';
        case 'offline':
          return 'Linck பதில் தரவில்லை. இணையத்தைச் சரிபார்த்து, மீண்டும் முயலுங்கள்.';
        case 'server':
          return p.status > 0 ? `Linck-இல் பிழை (${p.status}). மீண்டும் முயலுங்கள்.` : 'Linck-இல் பிழை. மீண்டும் முயலுங்கள்.';
        case 'vehicle-already-down':
          return 'விவரங்களைச் சரிபார்த்து, மீண்டும் முயலுங்கள்.';
      }
    },
  },
});

/* ------------------------------------------------------------------- board */

export const boardWords = words({
  en: {
    title: 'Home',
    needsYou: 'Needs you now',
    goTo: 'Go to',
    // Each card: a label of a few words, and one line saying which rows are
    // counted. With a zero count the shell shows "None now — <definition>".
    toInvoice: { label: 'Loads to invoice', definition: 'Gone out, no invoice yet' },
    toApprove: { label: 'Orders to approve', definition: 'No loading until approved' },
    notOut: { label: 'Loads not out yet', definition: 'Loaded, or late to load' },
    overdue: { label: 'Overdue invoices', definition: 'Past due date, money not in' },
    lowStock: { label: 'Stock running low', definition: 'Below the minimum' },
    stock: 'Stock',
    customers: 'Customers',
    orders: 'Orders',
    loads: 'Loads',
    invoices: 'Invoices',
  },
  ta: {
    title: 'முகப்பு',
    needsYou: 'இப்போது கவனிக்க வேண்டியவை',
    goTo: 'செல்ல',
    toInvoice: { label: 'இன்வாய்ஸ் போடாத லோடு', definition: 'வெளியே போனது, இன்னும் இன்வாய்ஸ் இல்லை' },
    toApprove: { label: 'அனுமதிக்க வேண்டிய ஆர்டர்', definition: 'அனுமதி வரும் வரை லோடு இல்லை' },
    notOut: { label: 'இன்னும் போகாத லோடு', definition: 'ஏற்றியது, அல்லது ஏற்ற தாமதம்' },
    overdue: { label: 'தாமதமான இன்வாய்ஸ்', definition: 'கெடு தேதி தாண்டியது, பணம் வரவில்லை' },
    lowStock: { label: 'இருப்பு குறைவு', definition: 'குறைந்தபட்ச அளவுக்குக் கீழே' },
    stock: 'இருப்பு',
    customers: 'வாடிக்கையாளர்கள்',
    orders: 'ஆர்டர்கள்',
    loads: 'லோடுகள்',
    invoices: 'இன்வாய்ஸ்கள்',
  },
});

/* --------------------------------------------------------------- customers */

export const customerWords = words({
  en: {
    title: 'Customers',
    overdueInvoices: 'Overdue invoices',
    openOrders: 'Open orders',
    noneAtSite: 'No customers at this site yet.',
    noneOverdue: 'No one is overdue.',
    noneWithOrders: 'No open orders.',
    gstNo: 'GST no.',
    noGst: 'No GST number',
    contact: 'Contact',
    ourSite: 'Our site',
    creditDays: 'Credit days',
    cash: 'Cash',
    creditLimit: 'Credit limit',
    moneyDue: 'Money due',
    groups: { details: 'Details', money: 'Money', orders: 'Orders' },
    /** Live: served from a site this person is not scoped to, so its name is not theirs to read. */
    otherSite: 'Another site',
    add: 'Add customer',
    newTitle: 'New customer',
    change: 'Change',
    changeTitle: 'Change customer',
    name: 'Name',
    deliverTo: 'Deliver to',
    contactName: 'Contact name',
    phone: 'Phone',
    creditLimitRupees: 'Credit limit ₹',
    gstHint: 'Blank if they have none',
    daysHint: '0 for cash',
    needs: {
      name: 'Name',
      gstin: 'GST no.',
      ourSite: 'Our site',
      creditLimit: 'Credit limit',
      creditDays: 'Credit days',
    } satisfies Record<CustomerGap, string>,
    wrong: {
      gstin: 'Type all 15 letters and digits, or leave it blank.',
      creditDays: '0 to 365 days.',
      creditLimit: 'Type rupees, like 5,00,000.',
    },
    readAs: (v: string) => `Read as ${v}`,
    cannotChange: 'Only the sales desk at its site can change this.',
    loading: 'Getting the customers…',
    failed: 'Could not get the customers.',
  },
  ta: {
    title: 'வாடிக்கையாளர்கள்',
    overdueInvoices: 'தாமதமான இன்வாய்ஸ்',
    openOrders: 'நடப்பு ஆர்டர்',
    noneAtSite: 'இந்த சைட்டில் இன்னும் வாடிக்கையாளர் இல்லை.',
    noneOverdue: 'யாருக்கும் தாமதம் இல்லை.',
    noneWithOrders: 'நடப்பு ஆர்டர் இல்லை.',
    gstNo: 'ஜிஎஸ்டி எண்',
    noGst: 'ஜிஎஸ்டி எண் இல்லை',
    contact: 'தொடர்பு',
    ourSite: 'நம் சைட்',
    creditDays: 'கடன் நாட்கள்',
    cash: 'ரொக்கம்',
    creditLimit: 'கடன் வரம்பு',
    moneyDue: 'பாக்கி',
    groups: { details: 'விவரம்', money: 'பணம்', orders: 'ஆர்டர்' },
    otherSite: 'வேறு சைட்',
    add: 'வாடிக்கையாளர் சேர்',
    newTitle: 'புது வாடிக்கையாளர்',
    change: 'மாற்று',
    changeTitle: 'வாடிக்கையாளர் விவரம் மாற்று',
    name: 'பெயர்',
    deliverTo: 'டெலிவரி இடம்',
    contactName: 'தொடர்பு நபர்',
    phone: 'போன்',
    creditLimitRupees: 'கடன் வரம்பு ₹',
    gstHint: 'இல்லையென்றால் காலியாக விடுங்கள்',
    daysHint: 'ரொக்கத்துக்கு 0',
    needs: {
      name: 'பெயர்',
      gstin: 'ஜிஎஸ்டி எண்',
      ourSite: 'நம் சைட்',
      creditLimit: 'கடன் வரம்பு',
      creditDays: 'கடன் நாட்கள்',
    },
    wrong: {
      gstin: '15 எழுத்தும் எண்ணும் டைப் செய்யுங்கள், அல்லது காலியாக விடுங்கள்.',
      creditDays: '0 முதல் 365 நாட்கள்.',
      creditLimit: 'ரூபாய் டைப் செய்யுங்கள், உதா. 5,00,000.',
    },
    readAs: (v) => `${v} எனப் படித்தது`,
    cannotChange: 'இதை அதன் சைட்டின் விற்பனைப் பிரிவு மட்டுமே மாற்ற முடியும்.',
    loading: 'வாடிக்கையாளர்களை எடுக்கிறது…',
    failed: 'வாடிக்கையாளர்களை எடுக்க முடியவில்லை.',
  },
});

/* ------------------------------------------------------------------ orders */

export const orderWords = words({
  en: {
    title: 'Orders',
    noneAtSite: 'No orders at this site yet.',
    noneHere: 'None here now.',
    approve: 'Approve',
    reject: 'Reject',
    managerApproves: 'A sales manager approves this.',
    order: 'Order',
    deliverTo: 'Deliver to',
    perUnit: (rate: string) => `${rate} / unit`,
    ordered: 'Ordered',
    sent: 'Sent',
    deliverBy: 'Deliver by',
    taken: 'Order taken',
    takenBy: 'Taken by',
    approveToLoad: (units: string) => `Approve it to start loading ${units} units.`,
    rejectTitle: 'Reject this order?',
    rejectYes: 'Yes, reject',
    rejectWhat: (units: string, material: string, amount: string) => `${units} units of ${material} · ${amount}`,
    rejectNote: 'You cannot undo this. They must send a new order.',
    /** Live: the API keeps why an order was turned down, and refuses one without a reason. */
    reason: 'Reason (needed)',
    add: 'Add order',
    newTitle: 'New order',
    theirRef: 'Their order no.',
    pickCustomer: 'Pick the customer',
    unitsLabel: 'Units',
    rateLabel: 'Rate ₹ / unit',
    needs: {
      customer: 'Customer',
      ref: 'Their order no.',
      material: 'Material',
      units: 'Units',
      rate: 'Rate',
      deliverBy: 'Deliver by',
      deliverTo: 'Deliver to',
      ourSite: 'Our site',
    } satisfies Record<OrderGap, string>,
    wrong: {
      units: 'Type units, like 40.',
      rate: 'Type rupees, like 4,825.50.',
      deliverBy: 'Pick today or a later day.',
    },
    valueIs: (amount: string) => `Amount ${amount}`,
    loading: 'Getting the orders…',
    failed: 'Could not get the orders.',
  },
  ta: {
    title: 'ஆர்டர்கள்',
    noneAtSite: 'இந்த சைட்டில் இன்னும் ஆர்டர் இல்லை.',
    noneHere: 'இப்போது இதில் எதுவும் இல்லை.',
    approve: 'அனுமதி',
    reject: 'நிராகரி',
    managerApproves: 'இதை சேல்ஸ் மேனேஜர் அனுமதிப்பார்.',
    order: 'ஆர்டர்',
    deliverTo: 'டெலிவரி இடம்',
    perUnit: (rate) => `யூனிட்டுக்கு ${rate}`,
    ordered: 'ஆர்டர் அளவு',
    sent: 'அனுப்பியது',
    deliverBy: 'டெலிவரி கெடு',
    taken: 'ஆர்டர் எடுத்தது',
    takenBy: 'எடுத்தவர்',
    approveToLoad: (units) => `${units} யூனிட் லோடு ஏற்ற முதலில் அனுமதி தேவை.`,
    rejectTitle: 'இந்த ஆர்டரை நிராகரிக்கவா?',
    rejectYes: 'ஆம், நிராகரி',
    rejectWhat: (units, material, amount) => `${material} ${units} யூனிட் · ${amount}`,
    rejectNote: 'இதை மாற்ற முடியாது. அவர்கள் புது ஆர்டர் தர வேண்டும்.',
    reason: 'காரணம் (தேவை)',
    add: 'ஆர்டர் சேர்',
    newTitle: 'புது ஆர்டர்',
    theirRef: 'அவர்கள் ஆர்டர் எண்',
    pickCustomer: 'வாடிக்கையாளரைத் தேர்ந்தெடுங்கள்',
    unitsLabel: 'யூனிட்',
    rateLabel: 'யூனிட்டுக்கு விலை ₹',
    needs: {
      customer: 'வாடிக்கையாளர்',
      ref: 'அவர்கள் ஆர்டர் எண்',
      material: 'பொருள்',
      units: 'யூனிட்',
      rate: 'விலை',
      deliverBy: 'டெலிவரி கெடு',
      deliverTo: 'டெலிவரி இடம்',
      ourSite: 'நம் சைட்',
    },
    wrong: {
      units: 'யூனிட் டைப் செய்யுங்கள், உதா. 40.',
      rate: 'ரூபாய் டைப் செய்யுங்கள், உதா. 4,825.50.',
      deliverBy: 'இன்று அல்லது பிறகு ஒரு நாளைத் தேர்ந்தெடுங்கள்.',
    },
    valueIs: (amount) => `தொகை ${amount}`,
    loading: 'ஆர்டர்களை எடுக்கிறது…',
    failed: 'ஆர்டர்களை எடுக்க முடியவில்லை.',
  },
});

/* ------------------------------------------------------------------- loads */

export const loadWords = words({
  en: {
    title: 'Loads',
    loadsToday: (n: number) => `${loads(n)} today`,
    today: 'Today',
    yesterday: 'Yesterday',
    sentOut: 'Units sent out today',
    soldNotWeight: 'Sold count, not weight',
    salesToday: 'Sales today',
    profit: (amount: string) => `Profit ${amount}`,
    loss: (amount: string) => `Loss ${amount}`,
    returnedLoads: 'Returned loads',
    spentNothingEarned: (cost: string) => `${cost} spent, ₹0 earned`,
    rateChangedAtGate: 'Rate changed at gate',
    loadsN: (n: number) => loads(n),
    belowRate: (units: string) => `${units} units at a lower rate`,
    whereNow: 'Where loads are now',
    barSummary: (n: number, parts: string) => `${loads(n)} today: ${parts}.`,
    profitByCustomer: 'Profit by customer',
    todayAfterCosts: 'Today, after costs',
    noSaleLoads: 'No sale loads today.',
    lossSummary: (k: number, n: number, name: string, amount: string) =>
      `${k} of ${n} customers at a loss. Worst: ${name}, ${amount}.`,
    profitSummary: (name: string, amount: string) => `All customers in profit. Best: ${name}, ${amount}.`,
    tapForLoads: 'Pick a name to see their loads below.',
    weightDiff: 'Weight difference',
    weighbridgeVsSold: 'Weighbridge against sold',
    nothingWeighed: 'Nothing weighed today.',
    scatterSummary: (f: number, n: number, tol: number) => `${f} of ${n} weighed loads off by over ${tol}%.`,
    unitsSold: 'units sold',
    diffPct: 'difference %',
    loaderHint: 'All dots on one side? Check the loader.',
    notOut: 'Not out yet',
    toInvoice: 'To invoice',
    rateChanged: 'Rate changed',
    weightOff: 'Weight differs',
    ownUse: 'Own use',
    weightOffN: (n: number, tol: number) => `${loads(n)}: weight off by over ${tol}%.`,
    showThem: 'Show them',
    loadsTodayTitle: 'Loads today',
    openForCost: 'Open a load to see costs',
    noLoadsHere: 'No loads here.',
    showAllLoads: 'Show all loads',
    loadedAt: 'Loaded at',
    weight: 'Weight',
    difference: 'Difference',
    sale: 'Sale',
    profitCol: 'Profit',
    ewb: 'E-way bill',
    groups: { trip: 'Trip', load: 'Load', weight: 'Weighbridge', money: 'Money' },
    noVehicle: 'No vehicle',
    noDriver: 'No driver',
    viewOnly: 'You can only view this.',
    markAs: (status: string) => `Mark ${status.toLowerCase()}`,
    weightOk: (weight: string) => `Weight ${weight} OK`,
    rateOk: (rate: string) => `Rate ${rate} OK`,
    cancelLoad: 'Cancel load',
    waitingForYou: 'Waiting for you',
    load: 'Load',
    deliverTo: 'Deliver to',
    notNoted: 'Not noted',
    vehicleDriver: 'Vehicle and driver',
    notWeighed: 'Not weighed',
    distance: 'Distance',
    bookedAt: 'Booked at',
    weightOffNote: (tol: number) => `Weight off by over ${tol}%. Do not hold the invoice.`,
    earnedSpent: 'Earned and spent',
    ratePerUnit: 'Rate per unit',
    materialCost: 'Material cost',
    diesel: 'Diesel',
    driverBatta: 'Driver batta',
    batta: 'Batta',
    toll: 'Toll',
    tripCost: 'Trip cost',
    costPerUnit: 'Cost per unit',
    noQuantity: 'No quantity',
    whereMoneyWent: 'Where the money went',
    moneySummary: (sale: string, material: number, trip: number, profit: string) =>
      `Sale ${sale}: material ${material}%, trip ${trip}%, profit ${profit}.`,
    nothingEarned: (cost: string) => `₹0 earned, ${cost} spent.`,
    notIncluded: 'Tyres, repairs and EMI not included.',
    returnedNote: (cost: string) => `Came back. ₹0 earned, ${cost} spent.`,
    cancelledNote: (cost: string) => `Cancelled. ${cost} spent. Material back in stock.`,
    ownUseNote: 'Own use. Not a sale, no invoice needed.',
    rateChangedNote: (rate: string, checked: boolean) =>
      `Rate changed at gate: ${rate} a unit. ${checked ? 'Checked.' : 'Not checked yet.'}`,
    papers: 'Papers',
    invoice: 'Invoice',
    noInvoiceYet: 'No invoice yet',
    cancelTitle: 'Cancel this load?',
    cancelYes: 'Yes, cancel load',
    cancelWhat: (trip: string, cost: string, units: string, out: boolean) =>
      `${trip}: ${cost} already spent${out ? ', vehicle is out' : ''}. ${units} units go back to stock. You cannot undo this.`,
  },
  ta: {
    title: 'லோடுகள்',
    loadsToday: (n) => `இன்று ${n} லோடு`,
    today: 'இன்று',
    yesterday: 'நேற்று',
    sentOut: 'இன்று அனுப்பிய யூனிட்',
    soldNotWeight: 'விற்ற அளவு, எடை அல்ல',
    salesToday: 'இன்றைய விற்பனை',
    profit: (amount) => `லாபம் ${amount}`,
    loss: (amount) => `நஷ்டம் ${amount}`,
    returnedLoads: 'திரும்பிய லோடு',
    spentNothingEarned: (cost) => `${cost} செலவு, வருமானம் ₹0`,
    rateChangedAtGate: 'கேட்டில் விலை மாற்றம்',
    loadsN: (n) => `${n} லோடு`,
    belowRate: (units) => `${units} யூனிட் குறைந்த விலையில்`,
    whereNow: 'லோடுகள் இப்போது எங்கே',
    barSummary: (n, parts) => `இன்று ${n} லோடு: ${parts}.`,
    profitByCustomer: 'வாடிக்கையாளர் வாரியாக லாபம்',
    todayAfterCosts: 'இன்று, செலவு போக',
    noSaleLoads: 'இன்று விற்பனை லோடு இல்லை.',
    lossSummary: (k, n, name, amount) => `${n} வாடிக்கையாளரில் ${k} பேருக்கு நஷ்டம். அதிகம்: ${name}, ${amount}.`,
    profitSummary: (name, amount) => `எல்லா வாடிக்கையாளருக்கும் லாபம். அதிகம்: ${name}, ${amount}.`,
    tapForLoads: 'பெயரை அழுத்தினால் அவர்களின் லோடுகள் கீழே வரும்.',
    weightDiff: 'எடை வித்தியாசம்',
    weighbridgeVsSold: 'எடை மேடையும் விற்ற அளவும்',
    nothingWeighed: 'இன்று எதுவும் எடை போடவில்லை.',
    scatterSummary: (f, n, tol) => `எடை போட்ட ${n} லோடில் ${f} லோடுக்கு ${tol}%-க்கு மேல் வித்தியாசம்.`,
    unitsSold: 'விற்ற யூனிட்',
    diffPct: 'வித்தியாசம் %',
    loaderHint: 'எல்லா புள்ளிகளும் ஒரே பக்கமா? லோடரைச் சரிபாருங்கள்.',
    notOut: 'இன்னும் போகவில்லை',
    toInvoice: 'இன்வாய்ஸ் போடாதவை',
    rateChanged: 'விலை மாற்றம்',
    weightOff: 'எடை வித்தியாசம்',
    ownUse: 'சொந்த உபயோகம்',
    weightOffN: (n, tol) => `${n} லோடு: எடை ${tol}%-க்கு மேல் வித்தியாசம்.`,
    showThem: 'காட்டு',
    loadsTodayTitle: 'இன்றைய லோடுகள்',
    openForCost: 'செலவு பார்க்க லோடைத் திறங்கள்',
    noLoadsHere: 'இதில் லோடு இல்லை.',
    showAllLoads: 'எல்லா லோடும் காட்டு',
    loadedAt: 'ஏற்றிய சைட்',
    weight: 'எடை',
    difference: 'வித்தியாசம்',
    sale: 'விற்பனை',
    profitCol: 'லாபம்',
    ewb: 'இ-வே பில்',
    groups: { trip: 'ட்ரிப்', load: 'லோடு', weight: 'எடை மேடை', money: 'பணம்' },
    noVehicle: 'வண்டி இல்லை',
    noDriver: 'டிரைவர் இல்லை',
    viewOnly: 'இதைப் பார்க்க மட்டுமே முடியும்.',
    markAs: (status) => `${status} எனக் குறி`,
    weightOk: (weight) => `எடை ${weight} சரி`,
    rateOk: (rate) => `விலை ${rate} சரி`,
    // The sheet is this one load, so "cancel" is enough; the dialog names it.
    cancelLoad: 'ரத்து செய்',
    waitingForYou: 'உங்களுக்காக காத்திருக்கிறது',
    load: 'லோடு',
    deliverTo: 'டெலிவரி இடம்',
    notNoted: 'குறிக்கவில்லை',
    vehicleDriver: 'வண்டி, டிரைவர்',
    notWeighed: 'எடை போடவில்லை',
    distance: 'தூரம்',
    bookedAt: 'பதிவு நேரம்',
    weightOffNote: (tol) => `எடை ${tol}%-க்கு மேல் வித்தியாசம். இன்வாய்ஸை நிறுத்த வேண்டாம்.`,
    earnedSpent: 'வரவு செலவு',
    ratePerUnit: 'யூனிட் விலை',
    materialCost: 'பொருள் செலவு',
    diesel: 'டீசல்',
    driverBatta: 'டிரைவர் பேட்டா',
    batta: 'பேட்டா',
    toll: 'டோல்',
    tripCost: 'ட்ரிப் செலவு',
    costPerUnit: 'யூனிட் செலவு',
    noQuantity: 'அளவு இல்லை',
    whereMoneyWent: 'பணம் எங்கே போனது',
    moneySummary: (sale, material, trip, profit) => `விற்பனை ${sale}: பொருள் ${material}%, ட்ரிப் ${trip}%, லாபம் ${profit}.`,
    nothingEarned: (cost) => `வருமானம் ₹0, செலவு ${cost}.`,
    notIncluded: 'டயர், ரிப்பேர், மாதத் தவணை இதில் இல்லை.',
    returnedNote: (cost) => `லோடு திரும்பியது. வருமானம் ₹0, செலவு ${cost}.`,
    cancelledNote: (cost) => `ரத்து செய்தது. செலவு ${cost}. பொருள் மீண்டும் இருப்பில்.`,
    ownUseNote: 'சொந்த உபயோகம். விற்பனை அல்ல, இன்வாய்ஸ் தேவையில்லை.',
    rateChangedNote: (rate, checked) =>
      `கேட்டில் விலை மாற்றம்: யூனிட்டுக்கு ${rate}. ${checked ? 'சரிபார்த்தது.' : 'இன்னும் சரிபார்க்கவில்லை.'}`,
    papers: 'ஆவணங்கள்',
    invoice: 'இன்வாய்ஸ்',
    noInvoiceYet: 'இன்னும் இன்வாய்ஸ் இல்லை',
    cancelTitle: 'இந்த லோடை ரத்து செய்யவா?',
    cancelYes: 'ஆம், லோடை ரத்து செய்',
    cancelWhat: (trip, cost, units, out) =>
      `${trip}: ஏற்கனவே ${cost} செலவு${out ? ', வண்டி வெளியே உள்ளது' : ''}. ${units} யூனிட் மீண்டும் இருப்பில் சேரும். இதை மாற்ற முடியாது.`,
  },
});

/* ---------------------------------------------------------------- invoices */

export const invoiceWords = words({
  en: {
    title: 'Invoices',
    year: (fy: string) => `Year ${fy}`,
    download: 'Download for CA',
    moneyDue: 'Money due',
    openN: (n: number) => `${n} open ${n === 1 ? 'invoice' : 'invoices'}`,
    pastDueN: (n: number) => `${n} ${n === 1 ? 'invoice' : 'invoices'} past due date`,
    toCheckN: (n: number) => `${n} waiting to be checked`,
    daysToPay: 'Days to get paid',
    daysN: (d: string) => `${d} days`,
    avgTillChecked: 'Average, till payment is checked',
    dueByDays: 'Money due, by days late',
    buckets: { notDue: 'Not yet due', d30: '1–30 days', d60: '31–60 days', over60: 'Over 60 days' },
    checkedOnly: 'Checked money only',
    withUnchecked: 'Add unchecked money',
    ageingSummary: (total: string, overSixty: string) => `${total} due. ${overSixty} over 60 days.`,
    last14: 'Last 14 days',
    moneyReceived: 'Money received (checked)',
    trendSummary: (received: string, billed: string, short: number) =>
      `${received} a day received, ${billed} a day billed. ${short} of 14 days short.`,
    received: 'Received',
    billedPerDay: (billed: string) => `Billed ${billed}/day`,
    underLine: 'Under the dashed line: less came in than billed.',
    dueByCustomer: 'Money due by customer',
    noMoneyDue: 'No money due.',
    topSummary: (name: string, amount: string, pct: number) => `${name} owes ${amount}, ${pct}% of all money due.`,
    markHint: 'Dashed mark: overdue part. Pick a name to see their invoices below.',
    openForDetails: 'Open an invoice to see details.',
    noInvoicesHere: 'No invoices here.',
    invoiceNo: 'Invoice no.',
    beforeGst: 'Before GST',
    gst: 'GST',
    checked: 'Checked',
    notChecked: 'Not checked',
    due: 'Due',
    groups: { invoice: 'Invoice', amount: 'Amount', received: 'Money received' },
    lateDays: (d: number) => `+${days(d)}`,
    dated: (date: string) => `Date ${date}`,
    check: (amount: string) => `Check ${amount}`,
    closeInvoice: 'Close invoice',
    sendReminder: 'Send reminder',
    reminderSent: 'Reminder sent',
    steps: 'Steps',
    blocking: {
      closed: (total: string) => `Closed. ${total} received and checked.`,
      draft: 'Draft. Not sent to the customer yet.',
      reported: (who: string, amount: string, date: string) => `${who} noted ${amount} paid on ${date}. Not checked yet.`,
      someone: 'Someone',
      allChecked: 'All money checked. You can close it now.',
      partly: (received: string, total: string, due: string, lateDays: number) =>
        `${received} of ${total} received. ${due} still due${lateDays > 0 ? `, ${days(lateDays)} late` : ''}.`,
      nothing: (due: string, lateDays: number) => `No payment yet. ${due} due${lateDays > 0 ? `, ${days(lateDays)} late` : ''}.`,
    },
    paidBy: (method: string) => `Paid by ${method}`,
    noBankRef: 'No bank reference',
    methods: {
      cash: 'Cash',
      neft: 'NEFT',
      rtgs: 'RTGS',
      imps: 'IMPS',
      upi: 'UPI',
      cheque: 'Cheque',
    } satisfies Record<Receipt['method'], string>,
    reminderNote: (customer: string, time: string) => `Reminder sent to ${customer} at ${time}.`,
    collectionSummary: (checked: string, total: string, unchecked: string | null) =>
      `${checked} of ${total} checked${unchecked ? `, ${unchecked} not checked` : ''}.`,
    invoiceAmount: 'Invoice amount',
    gstAt: (pct: number) => `GST ${pct}%`,
    receivedChecked: 'Received, checked',
    receivedNotChecked: 'Received, not checked',
    datesLine: (site: string, date: string, due: string) => `${site} · Date ${date} · Due ${due}`,
    papers: 'Papers',
    eInvoiceNo: 'E-invoice no.',
    ewbs: 'E-way bills',
    loads: 'Loads',
    notNeeded: 'Not needed',
    loadsN: (n: number) => `Loads (${n})`,
    noLoads: 'No loads on this invoice.',
    closeTitle: 'Close this invoice?',
    closeYes: 'Yes, close',
    closeWhat: (number: string, total: string) => `${number} · ${total}.`,
    closeNote: 'Close only if all the money is in the bank. You cannot reopen it here.',
  },
  ta: {
    title: 'இன்வாய்ஸ்கள்',
    year: (fy) => `ஆண்டு ${fy}`,
    download: 'ஆடிட்டருக்கு டவுன்லோடு',
    moneyDue: 'பாக்கி',
    openN: (n) => `திறந்த இன்வாய்ஸ் ${n}`,
    pastDueN: (n) => `கெடு தாண்டிய இன்வாய்ஸ் ${n}`,
    toCheckN: (n) => `${n} சரிபார்க்க காத்திருக்கிறது`,
    daysToPay: 'பணம் வர ஆகும் நாட்கள்',
    daysN: (d) => `${d} நாள்`,
    avgTillChecked: 'சராசரி, பணம் சரிபார்க்கும் வரை',
    dueByDays: 'தாமத நாட்கள்படி பாக்கி',
    buckets: { notDue: 'கெடு வரவில்லை', d30: '1–30 நாள்', d60: '31–60 நாள்', over60: '60 நாளுக்கு மேல்' },
    checkedOnly: 'சரிபார்த்த பணம் மட்டும்',
    withUnchecked: 'சரிபார்க்காத பணமும் சேர்த்து',
    ageingSummary: (total, overSixty) => `பாக்கி ${total}. 60 நாளுக்கு மேல் ${overSixty}.`,
    last14: 'கடந்த 14 நாள்',
    moneyReceived: 'வந்த பணம் (சரிபார்த்தது)',
    trendSummary: (received, billed, short) =>
      `நாளுக்கு வந்தது ${received}, இன்வாய்ஸ் ${billed}. 14 நாளில் ${short} நாள் குறைவாக வந்தது.`,
    received: 'வந்தது',
    billedPerDay: (billed) => `இன்வாய்ஸ் ${billed}/நாள்`,
    underLine: 'கோட்டுக்குக் கீழே: இன்வாய்ஸை விட குறைவாக வந்தது.',
    dueByCustomer: 'வாடிக்கையாளர் வாரியாக பாக்கி',
    noMoneyDue: 'பாக்கி இல்லை.',
    topSummary: (name, amount, pct) => `${name} தர வேண்டியது ${amount}. மொத்தத்தில் ${pct}%.`,
    markHint: 'கோடிட்ட குறி: தாமதமான பகுதி. பெயரை அழுத்தினால் அவர்களின் இன்வாய்ஸ்கள் கீழே வரும்.',
    openForDetails: 'விவரம் பார்க்க இன்வாய்ஸைத் திறங்கள்.',
    noInvoicesHere: 'இதில் இன்வாய்ஸ் இல்லை.',
    invoiceNo: 'இன்வாய்ஸ் எண்',
    beforeGst: 'ஜிஎஸ்டி இல்லாமல்',
    gst: 'ஜிஎஸ்டி',
    checked: 'சரிபார்த்தது',
    notChecked: 'சரிபார்க்காதது',
    due: 'பாக்கி',
    groups: { invoice: 'இன்வாய்ஸ்', amount: 'தொகை', received: 'வந்த பணம்' },
    lateDays: (d) => `+${d} நாள்`,
    dated: (date) => `தேதி ${date}`,
    check: (amount) => `${amount} சரிபார்`,
    closeInvoice: 'இன்வாய்ஸை முடி',
    sendReminder: 'நினைவூட்டு',
    reminderSent: 'நினைவூட்டியது',
    steps: 'நிலைகள்',
    blocking: {
      closed: (total) => `முடிந்தது. ${total} வந்தது, சரிபார்த்தது.`,
      draft: 'வரைவு. இன்னும் வாடிக்கையாளருக்கு அனுப்பவில்லை.',
      reported: (who, amount, date) => `${date} அன்று ${amount} வந்ததாக ${who} குறித்தார். இன்னும் சரிபார்க்கவில்லை.`,
      someone: 'ஒருவர்',
      allChecked: 'எல்லா பணமும் சரிபார்த்தது. இப்போது முடிக்கலாம்.',
      partly: (received, total, due, lateDays) =>
        `${total}-ல் ${received} வந்தது. இன்னும் ${due} வர வேண்டும்${lateDays > 0 ? `, ${lateDays} நாள் தாமதம்` : ''}.`,
      nothing: (due, lateDays) => `இன்னும் பணம் வரவில்லை. ${due} வர வேண்டும்${lateDays > 0 ? `, ${lateDays} நாள் தாமதம்` : ''}.`,
    },
    paidBy: (method) => `${method} மூலம் வந்தது`,
    noBankRef: 'வங்கி எண் இல்லை',
    methods: {
      cash: 'ரொக்கம்',
      neft: 'NEFT',
      rtgs: 'RTGS',
      imps: 'IMPS',
      upi: 'UPI',
      cheque: 'காசோலை',
    },
    reminderNote: (customer, time) => `நினைவூட்டியது: ${customer}, ${time}.`,
    collectionSummary: (checked, total, unchecked) =>
      `${total}-ல் ${checked} சரிபார்த்தது${unchecked ? `, ${unchecked} சரிபார்க்கவில்லை` : ''}.`,
    invoiceAmount: 'இன்வாய்ஸ் தொகை',
    gstAt: (pct) => `ஜிஎஸ்டி ${pct}%`,
    receivedChecked: 'வந்தது, சரிபார்த்தது',
    receivedNotChecked: 'வந்தது, சரிபார்க்கவில்லை',
    datesLine: (site, date, due) => `${site} · தேதி ${date} · கெடு ${due}`,
    papers: 'ஆவணங்கள்',
    eInvoiceNo: 'இ-இன்வாய்ஸ் எண்',
    ewbs: 'இ-வே பில்கள்',
    loads: 'லோடுகள்',
    notNeeded: 'தேவையில்லை',
    loadsN: (n) => `லோடுகள் (${n})`,
    noLoads: 'இந்த இன்வாய்ஸில் லோடு இல்லை.',
    closeTitle: 'இந்த இன்வாய்ஸை முடிக்கவா?',
    closeYes: 'ஆம், முடி',
    closeWhat: (number, total) => `${number} · ${total}.`,
    closeNote: 'எல்லா பணமும் வங்கியில் வந்திருந்தால் மட்டும் முடியுங்கள். இங்கே மீண்டும் திறக்க முடியாது.',
  },
});

/* ------------------------------------------------ types for column builders */

export type SalesText = (typeof salesWords)['en'];
export type CustomerText = (typeof customerWords)['en'];
export type OrderText = (typeof orderWords)['en'];
export type LoadText = (typeof loadWords)['en'];
export type InvoiceText = (typeof invoiceWords)['en'];
