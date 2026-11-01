import { words } from '../../i18n/words.js';

/**
 * The words of the production screens (LIN-23): the stock board and the shift
 * entry, in English and Tamil.
 *
 * A trade "unit" is 100 cubic feet — what customers order and pay for. Tonnes
 * are worked out from it. Both are product words and are translated here;
 * product names (M-Sand, 20mm Aggregate), product codes, site, crusher and
 * operator names are data and are shown as they are.
 */

/** The figure-and-unit words both screens use, so a tonne is a tonne everywhere. */
export const unitWords = words({
  en: {
    units: (n: string) => `${n} units`,
    unit: 'units',
    tonnes: (n: string) => `${n} tonnes`,
    tonne: 'tonnes',
    hour: 'hours',
    days: (n: string) => `${n} days`,
    daysAgo: (n: number) => `${n} days ago`,
  },
  ta: {
    units: (n) => `${n} யூனிட்`,
    unit: 'யூனிட்',
    tonnes: (n) => `${n} டன்`,
    tonne: 'டன்',
    hour: 'மணி',
    days: (n) => `${n} நாள்`,
    daysAgo: (n) => `${n} நாள் முன்`,
  },
});

/* ------------------------------------------------------------- stock board */

export const stockWords = words({
  en: {
    eyebrow: 'Production',
    title: 'Stock',

    filters: {
      all: 'All',
      low: 'Low stock',
      gap: 'Count difference',
      stale: (days: number) => `Not counted in ${days} days`,
    },

    tiles: {
      made: 'Made today',
      madeNote: 'All shifts',
      sent: 'Sent today',
      trips: (n: number) => `${n} ${n === 1 ? 'trip' : 'trips'} on the way`,
      net: 'Made minus sent',
      up: 'Stock went up. Check it is there.',
      even: 'Made and sent are equal.',
      down: 'More sent than made. Check stock today.',
      gap: 'Count difference',
      gapNote: (n: number, tolerance: number) => `${n} ${n === 1 ? 'product' : 'products'} off by over ${tolerance} units`,
    },

    starving: (product: string, site: string, short: string) =>
      `${product} at ${site}: ${short} units below minimum. Nothing made today.`,
    showLow: 'Show low stock',

    bars: {
      caption: 'Bar = stock. Dashes = minimum.',
      title: 'Stock vs minimum',
      allAbove: (n: number) => `All ${n} above minimum.`,
      someBelow: (low: number, total: number, worst: string, short: string) =>
        `${low} of ${total} below minimum. ${worst} is short by ${short} units.`,
      pick: 'Choose a bar to see its in and out.',
      none: 'Nothing to show.',
    },

    flow: {
      title: (product: string) => `${product}: in and out today`,
      titleNone: 'In and out today',
      opening: 'Opening',
      made: 'Made',
      sent: 'Sent',
      closing: 'Closing',
      promised: 'Promised',
      canSell: 'Can sell',
      summary: (product: string, opening: string, made: string, sent: string, canSell: string) =>
        `${product}: opening ${opening}, made ${made}, sent ${sent}, can sell ${canSell}.`,
      promisedNote: 'Promised is not sent yet.',
      none: 'Choose a product.',
    },

    mix: {
      caption: 'Units you can sell',
      title: 'What is in stock',
      other: 'Other',
      summary: (label: string, pct: number) => `${label} is the biggest: ${pct}%.`,
      empty: 'No stock.',
      note: 'Promised units are not in this.',
    },

    trend: {
      caption: 'All sites',
      title: 'Stock up or down, 14 days',
      series: 'Change',
      summary: (down: number) => `Last 14 days: stock went down on ${down} ${down === 1 ? 'day' : 'days'}.`,
      note: 'Marked days: more sent than made.',
    },

    table: {
      caption: '1 unit = 100 cubic feet',
      title: 'Stock by product',
      footnote: 'Tonnes are worked out, not weighed.',
      promisedHere: (n: string) => `${n} units promised on this screen.`,
      empty: 'Nothing here.',
      showAll: 'Show all',
    },

    columns: {
      product: 'Product',
      site: 'Site',
      canSell: 'Can sell',
      tonnes: 'Tonnes',
      perUnit: 'Tonnes per unit',
      made: 'Made today',
      sent: 'Sent today',
      promised: 'Promised',
      daysLeft: 'Days left',
      gap: 'Count difference',
      counted: 'Last counted',
      status: 'Status',
      checkIt: 'Check it',
    },

    status: { critical: 'None left', attention: 'Low', ready: 'Can sell' },

    sheet: {
      counted: (date: string) => `Counted ${date}`,
      viewOnly: 'You can only view.',
      less: '1 unit less',
      more: '1 unit more',
      promise: (n: number) => `Promise ${n}`,
      promiseUnits: (n: number) => `Promise ${n} units`,
      release: 'Release',
      tooMuch: 'More than in stock.',

      stock: 'Stock',
      canSellNow: 'Can sell now',
      total: 'Total stock',
      promised: 'Promised',
      inTonnes: 'In tonnes',
      minimum: 'Minimum',
      daysLeft: 'Days left',
      nothingSent: 'Nothing sent today',

      tonnes: 'Tonnes',
      oneUnit: '1 unit',
      cubicFeet: '100 cubic feet',
      perUnit: 'Tonnes per unit',
      sum: 'Sum',
      noFactor: 'No tonnes per unit set for this product.',
      worked: 'Worked out, not weighed.',

      today: 'In and out today',

      count: 'Count',
      lastCounted: 'Last counted',
      gap: 'Count difference',
      short: (n: string) => `${n} units short. Find out why.`,
      over: (n: string) => `${n} units extra. Find out why.`,
      matches: 'Matches the last count.',
      stale: (days: number) => `Counted ${days} days ago. Check the pile before a big order.`,

      promiseCaption: 'Promise',
      promiseNote: 'A promise holds units for a customer. Nothing is sent.',
    },

    belowMin: {
      title: 'Go below minimum?',
      canSell: (product: string, n: string) => `${product}: ${n} units can be sold now.`,
      after: (left: string, min: string) => `After this: ${left}. Minimum: ${min}.`,
      empty: 'The pile will be empty.',
      below: (n: string) => `${n} units below minimum.`,
      stale: (days: number) => `Last counted ${days} days ago.`,
    },

    release: {
      title: 'Release promised units?',
      confirm: 'Release',
      body: (n: string, product: string) => `${n} units of ${product} go back on sale. Tell the customer if needed.`,
    },
  },
  ta: {
    eyebrow: 'உற்பத்தி',
    title: 'இருப்பு',

    filters: {
      all: 'எல்லாம்',
      low: 'இருப்பு குறைவு',
      gap: 'அளவு வித்தியாசம்',
      stale: (days) => `${days} நாளாக அளக்கவில்லை`,
    },

    tiles: {
      made: 'இன்று உற்பத்தி',
      madeNote: 'எல்லா ஷிப்ட்டும்',
      sent: 'இன்று அனுப்பியது',
      trips: (n) => `${n} ட்ரிப் வழியில்`,
      net: 'உற்பத்தி − அனுப்பியது',
      up: 'இருப்பு கூடியது. நேரில் உள்ளதா பாருங்கள்.',
      even: 'உற்பத்தியும் அனுப்பியதும் சமம்.',
      down: 'உற்பத்தியை விட அதிகம் அனுப்பியது. இன்றே இருப்பைச் சரிபாருங்கள்.',
      gap: 'அளவு வித்தியாசம்',
      gapNote: (n, tolerance) => `${n} பொருட்களில் ${tolerance} யூனிட்டுக்கு மேல் வித்தியாசம்`,
    },

    starving: (product, site, short) =>
      `${site} — ${product}: குறைந்தபட்சத்தை விட ${short} யூனிட் குறைவு. இன்று உற்பத்தி இல்லை.`,
    showLow: 'குறைவானவை காட்டு',

    bars: {
      caption: 'பட்டை = இருப்பு. கோடு = குறைந்தபட்சம்.',
      title: 'இருப்பும் குறைந்தபட்சமும்',
      allAbove: (n) => `${n} பொருட்களும் குறைந்தபட்சத்துக்கு மேல்.`,
      someBelow: (low, total, worst, short) =>
        `${total}-இல் ${low} குறைந்தபட்சத்துக்குக் கீழ். ${worst}: ${short} யூனிட் குறைவு.`,
      pick: 'வந்தது, போனது பார்க்க ஒரு பட்டையை அழுத்துங்கள்.',
      none: 'காட்ட எதுவும் இல்லை.',
    },

    flow: {
      title: (product) => `${product}: இன்று வந்தது, போனது`,
      titleNone: 'இன்று வந்தது, போனது',
      opening: 'தொடக்கம்',
      made: 'உற்பத்தி',
      sent: 'அனுப்பியது',
      closing: 'மீதம்',
      promised: 'ஒதுக்கியது',
      canSell: 'விற்கலாம்',
      summary: (product, opening, made, sent, canSell) =>
        `${product}: தொடக்கம் ${opening}, உற்பத்தி ${made}, அனுப்பியது ${sent}, விற்கலாம் ${canSell}.`,
      promisedNote: 'ஒதுக்கியது இன்னும் அனுப்பவில்லை.',
      none: 'ஒரு பொருளைத் தேர்ந்தெடுங்கள்.',
    },

    mix: {
      caption: 'விற்கக்கூடிய யூனிட்',
      title: 'இருப்பில் என்ன உள்ளது',
      other: 'மற்றவை',
      summary: (label, pct) => `${label} அதிகம்: ${pct}%.`,
      empty: 'இருப்பு இல்லை.',
      note: 'ஒதுக்கிய யூனிட் இதில் இல்லை.',
    },

    trend: {
      caption: 'எல்லா சைட்',
      title: '14 நாளில் இருப்பு கூடியதா, குறைந்ததா',
      series: 'மாற்றம்',
      summary: (down) => `கடந்த 14 நாளில் ${down} நாள் இருப்பு குறைந்தது.`,
      note: 'குறித்த நாட்கள்: உற்பத்தியை விட அதிகம் அனுப்பியது.',
    },

    table: {
      caption: '1 யூனிட் = 100 கன அடி',
      title: 'பொருள் வாரியாக இருப்பு',
      footnote: 'டன் கணக்கிட்டது; எடை போடவில்லை.',
      promisedHere: (n) => `இந்தத் திரையில் ${n} யூனிட் ஒதுக்கியது.`,
      empty: 'இங்கே எதுவும் இல்லை.',
      showAll: 'எல்லாம் காட்டு',
    },

    columns: {
      product: 'பொருள்',
      site: 'சைட்',
      canSell: 'விற்கலாம்',
      tonnes: 'டன்',
      perUnit: 'யூனிட்டுக்கு டன்',
      made: 'இன்று உற்பத்தி',
      sent: 'இன்று அனுப்பியது',
      promised: 'ஒதுக்கியது',
      daysLeft: 'மீதி நாள்',
      gap: 'அளவு வித்தியாசம்',
      counted: 'கடைசியாக அளந்தது',
      status: 'நிலை',
      checkIt: 'சரிபாருங்கள்',
    },

    status: { critical: 'இருப்பு இல்லை', attention: 'குறைவு', ready: 'விற்கலாம்' },

    sheet: {
      counted: (date) => `அளந்தது ${date}`,
      viewOnly: 'பார்க்க மட்டும் முடியும்.',
      less: '1 யூனிட் குறை',
      more: '1 யூனிட் கூட்டு',
      promise: (n) => `${n} ஒதுக்கு`,
      promiseUnits: (n) => `${n} யூனிட் ஒதுக்கு`,
      release: 'விடுவி',
      tooMuch: 'இருப்பை விட அதிகம்.',

      stock: 'இருப்பு',
      canSellNow: 'இப்போது விற்கலாம்',
      total: 'மொத்த இருப்பு',
      promised: 'ஒதுக்கியது',
      inTonnes: 'டன்னில்',
      minimum: 'குறைந்தபட்சம்',
      daysLeft: 'மீதி நாள்',
      nothingSent: 'இன்று அனுப்பவில்லை',

      tonnes: 'டன் கணக்கு',
      oneUnit: '1 யூனிட்',
      cubicFeet: '100 கன அடி',
      perUnit: 'யூனிட்டுக்கு டன்',
      sum: 'கணக்கு',
      noFactor: 'இந்தப் பொருளுக்கு யூனிட்டுக்கு டன் அளவு இல்லை.',
      worked: 'கணக்கிட்டது; எடை போடவில்லை.',

      today: 'இன்று வந்தது, போனது',

      count: 'அளவீடு',
      lastCounted: 'கடைசியாக அளந்தது',
      gap: 'அளவு வித்தியாசம்',
      short: (n) => `${n} யூனிட் குறைவு. காரணம் கண்டுபிடியுங்கள்.`,
      over: (n) => `${n} யூனிட் அதிகம். காரணம் கண்டுபிடியுங்கள்.`,
      matches: 'கடைசி அளவுடன் பொருந்துகிறது.',
      stale: (days) => `${days} நாள் முன் அளந்தது. பெரிய ஆர்டருக்கு முன் குவியலைப் பாருங்கள்.`,

      promiseCaption: 'ஒதுக்கீடு',
      promiseNote: 'ஒதுக்கினால் வாடிக்கையாளருக்காக யூனிட் வைக்கப்படும். எதுவும் அனுப்பப்படாது.',
    },

    belowMin: {
      title: 'குறைந்தபட்சத்துக்குக் கீழே போகவா?',
      canSell: (product, n) => `${product}: இப்போது ${n} யூனிட் விற்கலாம்.`,
      after: (left, min) => `இதற்குப் பின்: ${left}. குறைந்தபட்சம்: ${min}.`,
      empty: 'குவியல் காலியாகும்.',
      below: (n) => `குறைந்தபட்சத்தை விட ${n} யூனிட் குறைவு.`,
      stale: (days) => `${days} நாள் முன் அளந்தது.`,
    },

    release: {
      title: 'ஒதுக்கிய யூனிட்டை விடுவிக்கவா?',
      confirm: 'விடுவி',
      body: (n, product) => `${product} ${n} யூனிட் மீண்டும் விற்பனைக்கு வரும். தேவைப்பட்டால் வாடிக்கையாளரிடம் சொல்லுங்கள்.`,
    },
  },
});

/* ------------------------------------------------------------- shift entry */

/**
 * Why a crusher stopped. The stored value stays the English code — it is what
 * the run record and every report key on — and the screen words it. A reason
 * typed some other way is shown as typed.
 */
export const DOWNTIME_REASONS = [
  'Belt slip',
  'Power outage — TNEB',
  'Jaw plate change',
  'Feeder jam',
  'Cone liner wear',
  'No boulder at feed hopper',
] as const;
export type DowntimeReason = (typeof DOWNTIME_REASONS)[number];

export const shiftWords = words({
  en: {
    eyebrow: 'Production',
    title: 'Add shift',
    clear: 'Clear products',
    save: 'Save shift',

    shift: 'Shift',
    date: 'Date',
    day: 'Day',
    night: 'Night',
    dayHours: 'Day · 6 am – 6 pm',
    nightHours: 'Night · 6 pm – 6 am',
    dayMark: 'D',
    nightMark: 'N',
    crusher: 'Crusher',
    operator: 'Operator',
    hoursRun: 'Hours run',
    hoursStopped: 'Hours stopped',
    whyStopped: 'Why stopped',
    chooseWhy: 'Choose why it stopped.',
    didNotStop: 'Did not stop',
    choose: 'Choose',
    reasons: {
      'Belt slip': 'Belt slip',
      'Power outage — TNEB': 'Power cut — TNEB',
      'Jaw plate change': 'Jaw plate change',
      'Feeder jam': 'Feeder jam',
      'Cone liner wear': 'Cone liner worn',
      'No boulder at feed hopper': 'No stone at hopper',
    } satisfies Record<DowntimeReason, string>,
    stoneIn: 'Stone in',
    stoneHelp: 'Add up the weighbridge slips.',

    productOut: 'Product out',
    product: 'Product',
    addProduct: 'Add product',
    fill: 'Fill',
    fillOffer: (tonnes: string) => `Fill ${tonnes} tonnes with the usual split? Check each one after.`,
    share: (pct: string, usual: number | undefined) => (usual === undefined ? `${pct}%` : `${pct}% · usually ${usual}%`),
    delete: 'Delete',
    flowHint: 'Type the tonnes to see the split.',
    flowSummary: (stoneIn: string, out: string, gap: string, pct: string) =>
      `${stoneIn} tonnes in, ${out} tonnes out. Gap ${gap} (${pct}%).`,

    missing: 'Missing',
    extra: 'Extra',
    ok: 'OK',
    notOk: 'Not OK',
    typeStoneFirst: 'Type stone in first.',
    normal: 'Gap is normal.',
    missingLine: (tonnes: string, loads: string) => `${tonnes} tonnes missing, about ${loads} loads. Check the slips.`,
    moreOut: 'More out than in. A slip may be missing.',

    trend: {
      title: 'Last 14 shifts',
      series: 'Gap %',
      note: (band: number) => `Shaded = normal (±${band}%). D = day, N = night.`,
      allIn: (n: number, band: number) => `All ${n} shifts within ±${band}%.`,
      someOut: (out: number, n: number, band: number, worst: string) => `${out} of ${n} shifts over ±${band}%. Worst: ${worst}%.`,
    },

    past: {
      title: 'Past shifts',
      all: 'All',
      allOk: 'All shifts are OK.',
      none: 'No shifts at this site.',
    },

    columns: {
      date: 'Date',
      shift: 'Shift',
      crusher: 'Crusher',
      operator: 'Operator',
      ran: 'Hours run',
      stopped: 'Hours stopped',
      why: 'Why stopped',
      stoneIn: 'Stone in',
      productOut: 'Product out',
      gap: 'Gap',
    },

    sheet: {
      title: (shift: string, date: string) => `${shift} shift · ${date}`,
      use: 'Use these figures',
      checkAfter: 'Check each figure after.',

      shift: 'Shift',
      site: 'Site',
      entered: 'How entered',
      suggested: 'Suggested, not checked',
      typed: 'Typed by hand',
      suggestedNote: 'Not in stock until someone checks it.',

      hours: 'Hours',
      ran: 'Ran',
      stopped: 'Stopped',
      notGiven: 'Not given',
      stoppedNote: (pct: string, tonnes: string) => `Stopped ${pct}% of the shift. About ${tonnes} tonnes less.`,

      split: 'How the stone split',
      products: (n: number) => `Products (${n})`,
      share: (pct: string, usual: number | undefined) => (usual === undefined ? `${pct}%` : `${pct}% (usually ${usual}%)`),

      balance: 'In and out',
      missingNote: (tonnes: string, loads: string) => `${tonnes} tonnes missing, about ${loads} loads. Check the gate book first.`,
    },

    confirm: {
      title: 'Figures do not match. Save anyway?',
      save: 'Save as typed',
      inOut: (stoneIn: string, out: string) => `${stoneIn} tonnes in, ${out} tonnes out.`,
      missing: (tonnes: string, pct: string, loads: string) => `${tonnes} tonnes missing (${pct}%), about ${loads} loads.`,
      extra: (tonnes: string, pct: string) => `${tonnes} tonnes more out than in (${pct}%). A slip may be missing.`,
      kept: 'It will be saved as typed. The manager will see it.',
    },
  },
  ta: {
    eyebrow: 'உற்பத்தி',
    title: 'ஷிப்ட் சேர்',
    clear: 'பொருட்களை அழி',
    save: 'ஷிப்ட் சேமி',

    shift: 'ஷிப்ட்',
    date: 'தேதி',
    day: 'பகல்',
    night: 'இரவு',
    dayHours: 'பகல் · காலை 6 – மாலை 6',
    nightHours: 'இரவு · மாலை 6 – காலை 6',
    dayMark: 'ப',
    nightMark: 'இ',
    crusher: 'கிரஷர்',
    operator: 'ஆப்பரேட்டர்',
    hoursRun: 'ஓடிய நேரம் (மணி)',
    hoursStopped: 'நின்ற நேரம் (மணி)',
    whyStopped: 'நின்ற காரணம்',
    chooseWhy: 'நின்ற காரணத்தைத் தேர்ந்தெடுங்கள்.',
    didNotStop: 'நிற்கவில்லை',
    choose: 'தேர்ந்தெடுங்கள்',
    reasons: {
      'Belt slip': 'பெல்ட் வழுக்கல்',
      'Power outage — TNEB': 'மின் தடை — TNEB',
      'Jaw plate change': 'ஜா பிளேட் மாற்றம்',
      'Feeder jam': 'ஃபீடர் அடைப்பு',
      'Cone liner wear': 'கோன் லைனர் தேய்மானம்',
      'No boulder at feed hopper': 'ஹாப்பரில் கல் இல்லை',
    },
    stoneIn: 'கல் உள்ளே',
    stoneHelp: 'எடை மேடை சீட்டுகளைக் கூட்டுங்கள்.',

    productOut: 'பொருள் வெளியே',
    product: 'பொருள்',
    addProduct: 'பொருள் சேர்',
    fill: 'நிரப்பு',
    fillOffer: (tonnes) => `${tonnes} டன்னை வழக்கமான பங்கில் நிரப்பவா? பிறகு ஒவ்வொன்றையும் சரிபாருங்கள்.`,
    share: (pct, usual) => (usual === undefined ? `${pct}%` : `${pct}% · வழக்கம் ${usual}%`),
    delete: 'நீக்கு',
    flowHint: 'பங்கைப் பார்க்க டன் அளவுகளை டைப் செய்யுங்கள்.',
    flowSummary: (stoneIn, out, gap, pct) => `${stoneIn} டன் உள்ளே, ${out} டன் வெளியே. வித்தியாசம் ${gap} (${pct}%).`,

    missing: 'குறைவு',
    extra: 'அதிகம்',
    ok: 'சரி',
    notOk: 'சரியில்லை',
    typeStoneFirst: 'முதலில் கல் உள்ளே அளவை டைப் செய்யுங்கள்.',
    normal: 'வித்தியாசம் சாதாரணம்.',
    missingLine: (tonnes, loads) => `${tonnes} டன் குறைவு, சுமார் ${loads} லோடு. சீட்டுகளைச் சரிபாருங்கள்.`,
    moreOut: 'உள்ளே போனதை விட வெளியே அதிகம். ஒரு சீட்டு விடுபட்டிருக்கலாம்.',

    trend: {
      title: 'கடைசி 14 ஷிப்ட்',
      series: 'வித்தியாசம் %',
      note: (band) => `நிழல் = சாதாரணம் (±${band}%). ப = பகல், இ = இரவு.`,
      allIn: (n, band) => `${n} ஷிப்ட்டும் ±${band}%-க்குள்.`,
      someOut: (out, n, band, worst) => `${n}-இல் ${out} ஷிப்ட் ±${band}%-ஐத் தாண்டியது. அதிகபட்சம்: ${worst}%.`,
    },

    past: {
      title: 'முந்தைய ஷிப்ட்கள்',
      all: 'எல்லாம்',
      allOk: 'எல்லா ஷிப்ட்டும் சரி.',
      none: 'இந்த சைட்டில் ஷிப்ட் இல்லை.',
    },

    columns: {
      date: 'தேதி',
      shift: 'ஷிப்ட்',
      crusher: 'கிரஷர்',
      operator: 'ஆப்பரேட்டர்',
      ran: 'ஓடிய மணி',
      stopped: 'நின்ற மணி',
      why: 'நின்ற காரணம்',
      stoneIn: 'கல் உள்ளே',
      productOut: 'பொருள் வெளியே',
      gap: 'வித்தியாசம்',
    },

    sheet: {
      title: (shift, date) => `${shift} ஷிப்ட் · ${date}`,
      use: 'இந்த அளவுகளைப் பயன்படுத்து',
      checkAfter: 'பிறகு ஒவ்வொன்றையும் சரிபாருங்கள்.',

      shift: 'ஷிப்ட்',
      site: 'சைட்',
      entered: 'எப்படி பதிவானது',
      suggested: 'பரிந்துரை, சரிபார்க்கவில்லை',
      typed: 'கையால் டைப் செய்தது',
      suggestedNote: 'யாராவது சரிபார்க்கும் வரை இருப்பில் சேராது.',

      hours: 'நேரம்',
      ran: 'ஓடியது',
      stopped: 'நின்றது',
      notGiven: 'சொல்லவில்லை',
      stoppedNote: (pct, tonnes) => `ஷிப்ட்டில் ${pct}% நேரம் நின்றது. சுமார் ${tonnes} டன் குறைவு.`,

      split: 'கல் எப்படிப் பிரிந்தது',
      products: (n) => `பொருட்கள் (${n})`,
      share: (pct, usual) => (usual === undefined ? `${pct}%` : `${pct}% (வழக்கம் ${usual}%)`),

      balance: 'உள்ளே, வெளியே',
      missingNote: (tonnes, loads) => `${tonnes} டன் குறைவு, சுமார் ${loads} லோடு. முதலில் கேட் பதிவேட்டைப் பாருங்கள்.`,
    },

    confirm: {
      title: 'அளவுகள் பொருந்தவில்லை. இருந்தாலும் சேமிக்கவா?',
      save: 'டைப் செய்தபடி சேமி',
      inOut: (stoneIn, out) => `${stoneIn} டன் உள்ளே, ${out} டன் வெளியே.`,
      missing: (tonnes, pct, loads) => `${tonnes} டன் குறைவு (${pct}%), சுமார் ${loads} லோடு.`,
      extra: (tonnes, pct) => `உள்ளே போனதை விட ${tonnes} டன் அதிகம் வெளியே (${pct}%). ஒரு சீட்டு விடுபட்டிருக்கலாம்.`,
      kept: 'டைப் செய்தபடியே சேமிக்கப்படும். மேனேஜர் பார்ப்பார்.',
    },
  },
});
