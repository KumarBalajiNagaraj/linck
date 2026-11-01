import type { TrendGrain, TrendPeriod } from '@linck/domain';
import { words } from '../../i18n/words.js';

/**
 * The words of Sales trends (LIN-7), in English and Tamil.
 *
 * Customer, site and material names are shown as typed. A change is always
 * "on last year" — the screen compares one way only, so it never has to say
 * which way.
 */

/** "↑ 12%" — the arrow carries the direction, the number the size. */
const arrow = (pct: number) => `${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct)}%`;

/** Only part of the period has a year-earlier record: how much was compared. */
export interface ComparedPart {
  count: number;
  grain: TrendGrain;
}

const partEn = (part: ComparedPart) => `${part.count} ${part.grain === 'month' ? 'months' : part.grain === 'week' ? 'weeks' : 'days'}`;
const partTa = (part: ComparedPart) => `${part.count} ${part.grain === 'month' ? 'மாதங்களை' : part.grain === 'week' ? 'வாரங்களை' : 'நாட்களை'}`;
const onLastYearEn = (part: ComparedPart | null) => (part === null ? 'on last year' : `on the same ${partEn(part)} last year`);
const thanLastYearTa = (part: ComparedPart | null) => (part === null ? 'கடந்த ஆண்டை விட' : `கடந்த ஆண்டின் அதே ${partTa(part)} விட`);

export const trendWords = words({
  en: {
    eyebrow: 'Overview',
    title: 'Sales trends',
    source: 'Daily sales',
    periods: { '30d': '30 days', '3m': '3 months', '12m': '12 months' } satisfies Record<TrendPeriod, string>,
    span: (from: string, to: string) => `${from} to ${to}`,
    againstDays: 'Against the same days last year',
    againstMonths: 'Against the same months last year',

    /** The change on last year, for a tile. */
    change: (pct: number, part: ComparedPart | null): string =>
      pct === 0 ? 'Same as last year' : `${arrow(pct)} ${onLastYearEn(part)}`,
    noRecord: 'No record last year',

    tiles: { sales: 'Sales', units: 'Units sold', rate: 'Rate per unit' },
    unitsN: (q: string) => `${q} units`,

    only: 'Only:',
    showAll: 'Show all',
    clear: (name: string) => `${name} ×`,

    overTime: {
      title: 'Over time',
      byDay: 'By day',
      byWeek: 'By week',
      byMonth: 'By month',
      amount: 'Amount',
      units: 'Units',
      thisYear: 'This year',
      lastYear: 'Last year',
      sales: (pct: number, part: ComparedPart | null): string =>
        pct === 0 ? 'Sales same as last year.' : `Sales ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% ${onLastYearEn(part)}.`,
      unitsLine: (pct: number, part: ComparedPart | null): string =>
        pct === 0 ? 'Units same as last year.' : `Units ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% ${onLastYearEn(part)}.`,
      nothingToCompare: 'Nothing from last year to compare.',
      weekTo: (date: string) => `Week to ${date}`,
      point: (when: string, now: string) => `${when}: ${now}`,
      pointLastYear: (before: string) => `last year ${before}`,
      noRecordBefore: (month: string) => `No sales record before ${month}.`,
      sundays: 'Dips are Sundays.',
    },

    customers: {
      title: 'By customer',
      caption: 'Pick a name to see only their sales.',
      customer: 'Customer',
      sales: 'Sales',
      share: 'Share',
      trend: 'Trend',
      status: 'Status',
      isNew: 'New',
      stopped: 'Stopped',
      fell: 'Big drop',
      days: (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`,
      lastBought: (date: string) => `Last bought ${date}`,
      stoppedN: (n: number) => `${n} stopped buying`,
      fellN: (n: number) => `${n} fell sharply`,
      top: (name: string, pct: number) => `Biggest: ${name}, ${pct}% of sales.`,
    },

    materials: {
      title: 'By material',
      caption: 'Pick a material to see only it.',
      material: 'Material',
      units: 'Units',
      sales: 'Sales',
      share: 'Share',
      isNew: 'New',
      top: (name: string, pct: number) => `${name} sold most: ${pct}% of units.`,
      unitNote: '1 unit = 100 cubic feet.',
    },

    empty: 'No sales here.',
    emptyWhy: 'Sales are made at the crushers.',
  },
  ta: {
    eyebrow: 'மேலோட்டம்',
    title: 'விற்பனைப் போக்கு',
    source: 'தினசரி விற்பனை',
    periods: { '30d': '30 நாள்', '3m': '3 மாதம்', '12m': '12 மாதம்' },
    span: (from, to) => `${from} முதல் ${to} வரை`,
    againstDays: 'கடந்த ஆண்டின் அதே நாட்களுடன் ஒப்பீடு',
    againstMonths: 'கடந்த ஆண்டின் அதே மாதங்களுடன் ஒப்பீடு',

    change: (pct, part) => (pct === 0 ? 'கடந்த ஆண்டைப் போலவே' : `${thanLastYearTa(part)} ${arrow(pct)}`),
    noRecord: 'கடந்த ஆண்டு பதிவு இல்லை',

    tiles: { sales: 'விற்பனை', units: 'விற்ற யூனிட்', rate: 'யூனிட் விலை' },
    unitsN: (q) => `${q} யூனிட்`,

    only: 'இவை மட்டும்:',
    showAll: 'எல்லாம் காட்டு',
    clear: (name) => `${name} ×`,

    overTime: {
      title: 'காலப்போக்கில்',
      byDay: 'நாள் வாரியாக',
      byWeek: 'வாரம் வாரியாக',
      byMonth: 'மாதம் வாரியாக',
      amount: 'தொகை',
      units: 'யூனிட்',
      thisYear: 'இந்த ஆண்டு',
      lastYear: 'கடந்த ஆண்டு',
      sales: (pct, part) =>
        pct === 0
          ? 'விற்பனை கடந்த ஆண்டைப் போலவே.'
          : `${thanLastYearTa(part)} விற்பனை ${Math.abs(pct)}% ${pct > 0 ? 'அதிகம்' : 'குறைவு'}.`,
      unitsLine: (pct, part) =>
        pct === 0
          ? 'யூனிட் கடந்த ஆண்டைப் போலவே.'
          : `${thanLastYearTa(part)} யூனிட் ${Math.abs(pct)}% ${pct > 0 ? 'அதிகம்' : 'குறைவு'}.`,
      nothingToCompare: 'ஒப்பிட கடந்த ஆண்டு விவரம் இல்லை.',
      weekTo: (date) => `${date} வரை வாரம்`,
      point: (when, now) => `${when}: ${now}`,
      pointLastYear: (before) => `கடந்த ஆண்டு ${before}`,
      noRecordBefore: (month) => `${month}-க்கு முன் விற்பனைப் பதிவு இல்லை.`,
      sundays: 'குறைந்த நாட்கள் ஞாயிறு.',
    },

    customers: {
      title: 'வாடிக்கையாளர் வாரியாக',
      caption: 'பெயரை அழுத்தினால் அவர்களின் விற்பனை மட்டும் வரும்.',
      customer: 'வாடிக்கையாளர்',
      sales: 'விற்பனை',
      share: 'பங்கு',
      trend: 'போக்கு',
      status: 'நிலை',
      isNew: 'புதியவர்',
      stopped: 'ஆர்டர் இல்லை',
      fell: 'பெரிய சரிவு',
      days: (n) => `${n} நாள்`,
      lastBought: (date) => `கடைசியாக வாங்கியது ${date}`,
      stoppedN: (n) => (n === 1 ? '1 வாடிக்கையாளர் வாங்குவதை நிறுத்தினார்' : `${n} வாடிக்கையாளர்கள் வாங்குவதை நிறுத்தினர்`),
      fellN: (n) => (n === 1 ? '1 வாடிக்கையாளர் பெரிதும் குறைத்தார்' : `${n} வாடிக்கையாளர்கள் பெரிதும் குறைத்தனர்`),
      top: (name, pct) => `அதிகம்: ${name}, விற்பனையில் ${pct}%.`,
    },

    materials: {
      title: 'பொருள் வாரியாக',
      caption: 'பொருளை அழுத்தினால் அது மட்டும் வரும்.',
      material: 'பொருள்',
      units: 'யூனிட்',
      sales: 'விற்பனை',
      share: 'பங்கு',
      isNew: 'புதியது',
      top: (name, pct) => `அதிகம் விற்றது ${name}: யூனிட்டில் ${pct}%.`,
      unitNote: '1 யூனிட் = 100 கன அடி.',
    },

    empty: 'இங்கே விற்பனை இல்லை.',
    emptyWhy: 'விற்பனை கிரஷர்களில் மட்டும் நடக்கிறது.',
  },
});

export type TrendText = typeof trendWords.en;
