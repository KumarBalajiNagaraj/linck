import { words } from '../../i18n/words.js';

/**
 * The words of What's coming (LIN-9), in English and Tamil.
 *
 * Every heads-up is one line with its numbers, and a few words under it on
 * what it is based on. Nothing here says "AI", "predicts" or "model": the
 * screen is arithmetic on the company's own sales, and it says so — including
 * what it does not know yet (market prices, news).
 *
 * Customer, site and material names are shown as typed.
 */

/** "↑ 12%" — the arrow carries the direction, the number the size. */
const arrow = (pct: number) => (pct === 0 ? '0%' : `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}%`);

export const aheadWords = words({
  en: {
    eyebrow: 'Overview',
    title: "What's coming",
    source: 'Daily sales',
    basis: (months: number) => `From ${months} months of your sales`,
    notIncluded: 'Market prices and news are not in this yet.',

    tiles: {
      expected: (month: string) => `Units expected in ${month}`,
      range: (low: string, high: string) => `${low} to ${high}`,
      lastYear: (month: string) => `${month} last year`,
      change: (pct: number) => `This year: ${arrow(pct)} (last 3 months)`,
      noChange: 'Too little record to compare',
      value: (month: string) => `Sales expected in ${month}`,
      atRates: "At the last 3 months' rates",
    },

    watch: {
      title: 'Watch out',
      caption: 'From your own sales',
      none: 'Nothing to watch out for now.',
      kinds: { stock: 'Stock', customer: 'Customer', demand: 'Demand', season: 'Season' },
      days: (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`,
      stockShort: (material: string, site: string | null, days: number): string =>
        `${material}${site ? ` at ${site}` : ''} may run short ${days === 0 ? 'today' : `in ${days} ${days === 1 ? 'day' : 'days'}`}.`,
      stockBasis: 'Stock now against expected sales. New crushing not counted.',
      stopped: (name: string, days: number) => `${name} has not ordered for ${days} days.`,
      usedTo: (gap: number): string => (gap <= 1 ? 'They used to order every day.' : `They used to order every ${gap} days.`),
      stoppedBasis: 'From their orders',
      less: (name: string, pct: number) => `${name} is buying ${pct}% less than usual.`,
      lessBasis: 'Last 30 days against the 3 months before',
      rising: (material: string, pct: number) => `${material} demand is up ${pct}% on last year.`,
      risingBasis: 'Last 3 months against the same weeks last year',
      seasonLow: (month: string, pct: number, rain: boolean): string =>
        `${rain ? 'Rain months ahead.' : 'A slow month ahead.'} Last ${month}, sales were ${pct}% below normal.`,
      seasonHigh: (month: string, pct: number) => `A busy month ahead. Last ${month}, sales were ${pct}% above normal.`,
      seasonBasis: "From last year's sales",
    },

    table: {
      title: (month: string) => `${month}, by material`,
      caption: 'Units expected, and how low or high',
      material: 'Material',
      expected: 'Expected',
      range: 'Low to high',
      change: 'Change',
      rangeCell: (low: string, high: string) => `${low} – ${high}`,
    },

    how: {
      title: 'How it is worked out',
      rule: (month: string, change: string) => `${month} last year × this year's change (${change} over the last 3 months).`,
      ruleNoChange: (month: string) => `${month} last year, as it was. Too little record to measure this year's change.`,
      ruleRecent: (days: number) => `No record from last year, so: the last 3 months' daily average × ${days} days.`,
      perMaterial: 'Each material is worked out the same way, with its own range.',
      checked: (n: number, method: number, naive: number) =>
        `Tried on ${n} past months: off by ${method}% on average. "Same as last month" was off by ${naive}%.`,
      range: (pct: number, held: number, of: number) => `Range: ±${pct}%. It held in ${held} of ${of} past months.`,
      plainRange: (pct: number) => `Range: ±${pct}%. Too few past months to check.`,
    },

    empty: 'No sales here.',
    emptyWhy: 'Sales are made at the crushers.',
  },
  ta: {
    eyebrow: 'மேலோட்டம்',
    title: 'வரப்போவது',
    source: 'தினசரி விற்பனை',
    basis: (months) => `உங்கள் ${months} மாத விற்பனைப் பதிவிலிருந்து`,
    notIncluded: 'சந்தை விலையும் செய்திகளும் இதில் இன்னும் இல்லை.',

    tiles: {
      expected: (month) => `${month}: எதிர்பார்க்கும் யூனிட்`,
      range: (low, high) => `${low} முதல் ${high} வரை`,
      lastYear: (month) => `கடந்த ஆண்டு ${month}`,
      change: (pct) => `இந்த ஆண்டு: ${arrow(pct)} (கடந்த 3 மாதம்)`,
      noChange: 'ஒப்பிடப் போதிய பதிவு இல்லை',
      value: (month) => `${month}: எதிர்பார்க்கும் விற்பனை`,
      atRates: 'கடந்த 3 மாத விலையில்',
    },

    watch: {
      title: 'கவனிக்க',
      caption: 'உங்கள் விற்பனைப் பதிவிலிருந்து',
      none: 'இப்போது கவனிக்க எதுவும் இல்லை.',
      kinds: { stock: 'இருப்பு', customer: 'வாடிக்கையாளர்', demand: 'தேவை', season: 'பருவம்' },
      days: (n) => `${n} நாள்`,
      stockShort: (material, site, days) =>
        `${site ? `${site}-இல் ` : ''}${material} ${days === 0 ? 'இன்றே' : `${days} நாளில்`} தீரலாம்.`,
      stockBasis: 'இப்போதைய இருப்பும் எதிர்பார்க்கும் விற்பனையும். புதிய உற்பத்தி சேர்க்கவில்லை.',
      stopped: (name, days) => `${name} ${days} நாளாக ஆர்டர் தரவில்லை.`,
      usedTo: (gap) => (gap <= 1 ? 'முன்பு தினமும் வாங்கினார்கள்.' : `முன்பு ${gap} நாளுக்கு ஒருமுறை வாங்கினார்கள்.`),
      stoppedBasis: 'அவர்களின் ஆர்டர்களிலிருந்து',
      less: (name, pct) => `${name} வழக்கத்தை விட ${pct}% குறைவாக வாங்குகிறார்கள்.`,
      lessBasis: 'கடந்த 30 நாள், அதற்கு முந்தைய 3 மாதத்துடன்',
      rising: (material, pct) => `${material} தேவை கடந்த ஆண்டை விட ${pct}% அதிகம்.`,
      risingBasis: 'கடந்த 3 மாதம், கடந்த ஆண்டின் அதே வாரங்களுடன்',
      seasonLow: (month, pct, rain) =>
        `${rain ? 'மழைக் காலம் வருகிறது.' : 'மந்தமான மாதம் வருகிறது.'} கடந்த ${month} மாதத்தில் விற்பனை வழக்கத்தை விட ${pct}% குறைவு.`,
      seasonHigh: (month, pct) => `விற்பனை கூடும் மாதம் வருகிறது. கடந்த ${month} மாதத்தில் விற்பனை வழக்கத்தை விட ${pct}% அதிகம்.`,
      seasonBasis: 'கடந்த ஆண்டு விற்பனைப்படி',
    },

    table: {
      title: (month) => `${month}, பொருள் வாரியாக`,
      caption: 'எதிர்பார்க்கும் யூனிட், குறைந்தது முதல் அதிகம் வரை',
      material: 'பொருள்',
      expected: 'எதிர்பார்ப்பு',
      range: 'குறைந்தது – அதிகம்',
      change: 'மாற்றம்',
      rangeCell: (low, high) => `${low} – ${high}`,
    },

    how: {
      title: 'எப்படிக் கணக்கிட்டது',
      rule: (month, change) => `கடந்த ஆண்டு ${month} விற்பனை × இந்த ஆண்டின் மாற்றம் (கடந்த 3 மாதத்தில் ${change}).`,
      ruleNoChange: (month) => `கடந்த ஆண்டு ${month} விற்பனை அப்படியே. இந்த ஆண்டின் மாற்றத்தைக் கணக்கிடப் போதிய பதிவு இல்லை.`,
      ruleRecent: (days) => `கடந்த ஆண்டு பதிவு இல்லை; ஆகவே கடந்த 3 மாத தினசரி சராசரி × ${days} நாள்.`,
      perMaterial: 'ஒவ்வொரு பொருளும் இதே முறையில், அதன் சொந்த வரம்புடன் கணக்கிட்டது.',
      checked: (n, method, naive) =>
        `கடந்த ${n} மாதங்களில் சோதித்தது: சராசரியாக ${method}% வித்தியாசம். "கடந்த மாதம் போலவே" என்று சொன்னால் ${naive}% வித்தியாசம்.`,
      range: (pct, held, of) => `வரம்பு: ±${pct}%. கடந்த ${of} மாதங்களில் ${held} மாதம் இதற்குள் இருந்தது.`,
      plainRange: (pct) => `வரம்பு: ±${pct}%. சோதிக்கப் போதிய மாதங்கள் இல்லை.`,
    },

    empty: 'இங்கே விற்பனை இல்லை.',
    emptyWhy: 'விற்பனை கிரஷர்களில் மட்டும் நடக்கிறது.',
  },
});

export type AheadText = typeof aheadWords.en;

/** For the arrow on a change, shared with the screen. */
export { arrow as changeArrow };
