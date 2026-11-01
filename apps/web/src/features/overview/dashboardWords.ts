import { words } from '../../i18n/words.js';

/**
 * The words of the owner's dashboard (LIN-23), in English and Tamil.
 *
 * Named for the dashboard, so the bill-approval screen in the same folder can
 * keep a words file of its own.
 */

/** Why a vehicle stood. Worded from the fleet's downtime causes in ExecutiveDashboard. */
export type DowntimeCause = 'tyre' | 'noLoad' | 'service' | 'gearbox' | 'noDriver' | 'electrical' | 'documents' | 'hydraulics';

export const dashboardWords = words({
  en: {
    eyebrow: 'Overview',
    title: 'Dashboard',
    today: 'Today',
    sinceApril: 'Since 1 April',

    /** Hover on each as-of dot: where the figure comes from, in plain words. */
    // Where the page's figures come from, on hover over its one "Updated"
    // stamp. The tiles share the header's time and do not repeat it.
    source: {
      daily: 'Daily totals',
    },

    tiles: {
      cash: 'Money in bank',
      cashUp: (amount: string) => `↑ ${amount} from last week`,
      due: 'Money due',
      overdue: (n: number, amount: string) => `${n} ${n === 1 ? 'invoice' : 'invoices'} overdue · ${amount}`,
      toCheck: (n: number) => `${n} to check`,
      vehicles: 'Vehicles running',
      vehiclesBreakup: (down: number, noWork: number, inService: number) =>
        `${down} breakdown · ${noWork} no work · ${inService} in service`,
    },

    last14: 'Last 14 days',

    sales: {
      title: 'Sales',
      series: 'Sales',
      summary: (average: string) => `Average ${average} a day.`,
      note: 'Dips are Sundays. Ask about a weekday dip.',
    },

    profit: {
      title: 'Profit %',
      series: 'Profit',
      target: (pct: number) => `Target ${pct}%`,
      summary: (min: string, max: string) => `Between ${min}% and ${max}%.`,
      note: 'After diesel, batta and toll.',
    },

    material: {
      title: 'Made and sent today',
      made: 'Made',
      sent: 'Sent',
      ownUse: 'Own use',
      returned: 'Returned',
      inStock: 'In stock',
      summary: (made: string, sent: string, left: string) => `Made ${made} units, sent ${sent}, ${left} left.`,
      unitNote: 'In units. 1 unit = 100 cubic feet.',
      invoiced: 'Invoiced',
      notInvoiced: 'No invoice yet',
      invoicedSummary: (invoiced: string, sent: string, none: string) =>
        `${invoiced} of ${sent} units sent have an invoice. ${none} have none yet.`,
      creditNote: 'Credit customers get invoices every 2 weeks.',
    },

    due: {
      caption: 'By days late',
      title: 'Money due',
      notLate: 'Not due yet',
      bucket: (range: string) => `${range} days`,
      summary: (total: string, late: string) => `${total} due. ${late} is late.`,
      darker: 'Darker means older.',
    },

    downtime: {
      caption: 'Hours, last 30 days',
      title: 'Why vehicles stopped',
      summary: (cause: string, hours: number) => `Most hours lost: ${cause}, ${hours} hours.`,
      salesNotRepair: (cause: string) => `“${cause}” is a sales problem, not a repair.`,
      cause: {
        tyre: 'Tyre burst / puncture',
        noLoad: 'No load',
        service: 'Planned service',
        gearbox: 'Gearbox & clutch',
        noDriver: 'No driver',
        electrical: 'Electrical',
        documents: 'Documents expired',
        hydraulics: 'Hydraulics',
      } satisfies Record<DowntimeCause, string>,
    },

    sold: {
      caption: 'Last 30 days, in units',
      title: 'What sold',
      summary: (product: string, pct: number) => `${product} sold most: ${pct}%.`,
    },

    risk: {
      title: 'Documents and vehicles',
      expired: 'Documents expired',
      stopVehicle: (n: number) => `${n} of them stop a vehicle`,
      expiring: 'Expire in 30 days',
      expiringWhat: 'Insurance, FC, permit',
      offRoad: 'Vehicles off road',
      offRoadCost: 'No income, still paying EMI',
      urgent: 'Urgent',
      soon: 'Soon',
      ok: 'OK',
      watch: 'Watch',
    },

    invoices: {
      title: 'Invoices to watch',
      invoice: 'Invoice',
      customer: 'Customer',
      total: 'Total',
      paidChecked: 'Paid, checked',
      due: 'Due',
      status: 'Status',
    },
    late: (n: number) => `+${n} ${n === 1 ? 'day' : 'days'}`,

    stock: {
      title: 'Stock now',
      product: 'Product',
      inStock: 'In stock',
      tonnes: 'Tonnes',
      madeToday: 'Made today',
      sentToday: 'Sent today',
      countGap: 'Count gap',
      low: 'Low stock',
      enough: 'Enough',
    },
    units: 'units',
    tonnesUnit: 'tonnes',

    invoiceSheet: {
      dated: (date: string) => `Date ${date}`,
      amount: 'Amount',
      withoutGst: 'Without GST',
      gst: 'GST 5%',
      total: 'Total',
      due: 'Due',
      payment: 'Payment',
      checked: 'Checked',
      notChecked: 'Not checked',
      barSummary: (checked: string, total: string) => `${checked} of ${total} checked.`,
      paidNotChecked: (amount: string) => `${amount} paid, not checked yet.`,
      allPaid: 'All paid and checked. You can close it.',
      partPaid: (checked: string, due: string, daysLate: number) =>
        `${checked} checked, ${due} still due${daysLate > 0 ? `, ${daysLate} ${daysLate === 1 ? 'day' : 'days'} late` : ''}.`,
      nothingYet: 'No money received yet.',
      gstPapers: 'GST papers',
      eInvoice: 'e-Invoice no.',
      ewb: 'e-Way bills',
      loads: (n: number) => `Loads (${n})`,
      noLoads: 'No loads linked.',
      load: (qty: string, product: string) => `${qty} units · ${product}`,
    },

    stockSheet: {
      stock: 'Stock',
      inStock: 'In stock',
      inTonnes: 'In tonnes',
      minimum: 'Minimum',
      lasts: 'Lasts',
      nothingSent: 'Nothing sent today',
      days: (n: string) => `${n} days`,
      today: 'Today',
      start: 'Start',
      made: 'Made',
      sent: 'Sent',
      now: 'Now',
      summary: (start: string, made: string, sent: string) => `Start ${start}, made ${made}, sent ${sent}.`,
      lastCount: 'Last count',
      countedOn: 'Counted on',
      gap: (units: string, short: boolean) => `${units} units ${short ? 'short' : 'extra'} since the last count. Measure again.`,
      matches: 'Matches the last count.',
      oneUnit: '1 unit',
      conversion: (tonnes: string) => `100 cubic feet = ${tonnes} tonnes`,
    },
  },
  ta: {
    eyebrow: 'மேலோட்டம்',
    title: 'டாஷ்போர்டு',
    today: 'இன்று',
    sinceApril: 'ஏப்ரல் 1 முதல்',

    source: {
      daily: 'தினசரி கணக்கு',
    },

    tiles: {
      cash: 'வங்கியில் உள்ள பணம்',
      cashUp: (amount) => `கடந்த வாரத்தை விட ↑ ${amount}`,
      due: 'பாக்கி',
      overdue: (n, amount) => `${n} இன்வாய்ஸ் தாமதம் · ${amount}`,
      toCheck: (n) => `${n} சரிபார்க்க வேண்டும்`,
      vehicles: 'ஓடும் நிலையில் வண்டிகள்',
      vehiclesBreakup: (down, noWork, inService) => `பழுது ${down} · வேலை இல்லை ${noWork} · சர்வீஸில் ${inService}`,
    },

    last14: 'கடந்த 14 நாள்',

    sales: {
      title: 'விற்பனை',
      series: 'விற்பனை',
      summary: (average) => `ஒரு நாளுக்குச் சராசரி ${average}.`,
      note: 'குறைந்த நாட்கள் ஞாயிறு. வார நாளில் குறைந்தால் கேளுங்கள்.',
    },

    profit: {
      title: 'லாபம் %',
      series: 'லாபம்',
      target: (pct) => `இலக்கு ${pct}%`,
      summary: (min, max) => `${min}% முதல் ${max}% வரை.`,
      note: 'டீசல், பேட்டா, டோல் கழித்து.',
    },

    material: {
      title: 'இன்று உற்பத்தி, அனுப்பியது',
      made: 'உற்பத்தி',
      sent: 'அனுப்பியது',
      ownUse: 'சொந்த உபயோகம்',
      returned: 'திரும்பியது',
      inStock: 'இருப்பு',
      summary: (made, sent, left) => `உற்பத்தி ${made} யூனிட், அனுப்பியது ${sent}, மீதம் ${left}.`,
      unitNote: 'யூனிட்டில். 1 யூனிட் = 100 கன அடி.',
      invoiced: 'இன்வாய்ஸ் போட்டது',
      notInvoiced: 'இன்னும் இன்வாய்ஸ் இல்லை',
      invoicedSummary: (invoiced, sent, none) =>
        `அனுப்பிய ${sent} யூனிட்டில் ${invoiced}-க்கு இன்வாய்ஸ் உள்ளது. ${none}-க்கு இன்னும் இல்லை.`,
      creditNote: 'கடன் வாடிக்கையாளர்களுக்கு 2 வாரத்துக்கு ஒருமுறை இன்வாய்ஸ்.',
    },

    due: {
      caption: 'தாமத நாட்கள் வாரியாக',
      title: 'பாக்கி',
      notLate: 'தாமதம் இல்லை',
      bucket: (range) => `${range} நாள்`,
      summary: (total, late) => `மொத்தம் ${total} வர வேண்டும். ${late} தாமதம்.`,
      darker: 'அடர் நிறம் என்றால் பழையது.',
    },

    downtime: {
      caption: 'மணி நேரம், கடந்த 30 நாள்',
      title: 'வண்டிகள் ஏன் நின்றன',
      summary: (cause, hours) => `அதிக நேரம் போனது: ${cause}, ${hours} மணி நேரம்.`,
      salesNotRepair: (cause) => `“${cause}” ரிப்பேர் அல்ல, விற்பனைப் பிரச்சினை.`,
      cause: {
        tyre: 'டயர் வெடிப்பு / பஞ்சர்',
        noLoad: 'லோடு இல்லை',
        service: 'திட்டமிட்ட சர்வீஸ்',
        gearbox: 'கியர்பாக்ஸ், கிளட்ச்',
        noDriver: 'டிரைவர் இல்லை',
        electrical: 'எலக்ட்ரிகல்',
        documents: 'ஆவணம் காலாவதி',
        hydraulics: 'ஹைட்ராலிக்',
      },
    },

    sold: {
      caption: 'கடந்த 30 நாள், யூனிட்டில்',
      title: 'என்ன விற்றது',
      summary: (product, pct) => `அதிகம் விற்றது ${product}: ${pct}%.`,
    },

    risk: {
      title: 'ஆவணங்கள், வண்டிகள்',
      expired: 'காலாவதியான ஆவணங்கள்',
      stopVehicle: (n) => `இதில் ${n} வண்டியை நிறுத்தும்`,
      expiring: '30 நாளில் காலாவதி',
      expiringWhat: 'இன்சூரன்ஸ், FC, பர்மிட்',
      offRoad: 'நிறுத்தப்பட்ட வண்டிகள்',
      offRoadCost: 'வருமானம் இல்லை, தவணை கட்டுகிறோம்',
      urgent: 'அவசரம்',
      soon: 'விரைவில்',
      ok: 'சரி',
      watch: 'கவனி',
    },

    invoices: {
      title: 'கவனிக்க வேண்டிய இன்வாய்ஸ்கள்',
      invoice: 'இன்வாய்ஸ்',
      customer: 'வாடிக்கையாளர்',
      total: 'மொத்தம்',
      paidChecked: 'சரிபார்த்த பணம்',
      due: 'பாக்கி',
      status: 'நிலை',
    },
    late: (n) => `+${n} நாள்`,

    stock: {
      title: 'இப்போது இருப்பு',
      product: 'பொருள்',
      inStock: 'இருப்பு',
      tonnes: 'டன்',
      madeToday: 'இன்று உற்பத்தி',
      sentToday: 'இன்று அனுப்பியது',
      countGap: 'அளவு வித்தியாசம்',
      low: 'இருப்பு குறைவு',
      enough: 'போதுமானது',
    },
    units: 'யூனிட்',
    tonnesUnit: 'டன்',

    invoiceSheet: {
      dated: (date) => `தேதி ${date}`,
      amount: 'தொகை',
      withoutGst: 'ஜிஎஸ்டி இல்லாமல்',
      gst: 'ஜிஎஸ்டி 5%',
      total: 'மொத்தம்',
      due: 'பாக்கி',
      payment: 'பணம் வரவு',
      checked: 'சரிபார்த்தது',
      notChecked: 'சரிபார்க்கவில்லை',
      barSummary: (checked, total) => `${total}-இல் ${checked} சரிபார்த்தது.`,
      paidNotChecked: (amount) => `${amount} வந்தது, இன்னும் சரிபார்க்கவில்லை.`,
      allPaid: 'முழுப் பணமும் வந்து சரிபார்த்தது. இன்வாய்ஸை முடிக்கலாம்.',
      partPaid: (checked, due, daysLate) =>
        `${checked} சரிபார்த்தது, பாக்கி ${due}${daysLate > 0 ? `, ${daysLate} நாள் தாமதம்` : ''}.`,
      nothingYet: 'இன்னும் பணம் வரவில்லை.',
      gstPapers: 'ஜிஎஸ்டி ஆவணங்கள்',
      eInvoice: 'இ-இன்வாய்ஸ் எண்',
      ewb: 'இ-வே பில்கள்',
      loads: (n) => `லோடுகள் (${n})`,
      noLoads: 'லோடு எதுவும் இணைக்கவில்லை.',
      load: (qty, product) => `${qty} யூனிட் · ${product}`,
    },

    stockSheet: {
      stock: 'இருப்பு',
      inStock: 'இருப்பு',
      inTonnes: 'டன்னில்',
      minimum: 'குறைந்தபட்சம்',
      lasts: 'எத்தனை நாள் வரும்',
      nothingSent: 'இன்று எதுவும் அனுப்பவில்லை',
      days: (n) => `${n} நாள்`,
      today: 'இன்று',
      start: 'தொடக்கம்',
      made: 'உற்பத்தி',
      sent: 'அனுப்பியது',
      now: 'இப்போது',
      summary: (start, made, sent) => `தொடக்கம் ${start}, உற்பத்தி ${made}, அனுப்பியது ${sent}.`,
      lastCount: 'கடைசி அளவு',
      countedOn: 'அளந்த தேதி',
      gap: (units, short) => `கடைசி அளவீட்டை விட ${units} யூனிட் ${short ? 'குறைவு' : 'அதிகம்'}. மீண்டும் அளவிடுங்கள்.`,
      matches: 'கடைசி அளவீட்டுடன் சரியாக உள்ளது.',
      oneUnit: '1 யூனிட்',
      conversion: (tonnes) => `100 கன அடி = ${tonnes} டன்`,
    },
  },
});
