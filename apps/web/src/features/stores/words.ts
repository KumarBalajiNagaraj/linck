import { formatQty } from '@linck/domain';
import type { Indent } from '@linck/mock';
import { words } from '../../i18n/words.js';

/**
 * The words of the material requests screen (LIN-23), in English and Tamil.
 *
 * "Indent" is the stores word for a request for material. It is not said on
 * screen: the glossary word is "Material request" / பொருள் கோரிக்கை.
 * What people typed — item names, who asked, the machine or vehicle it is
 * for, units like "nos" — is shown as typed and never passes through here.
 */

/** Item code prefixes carry the stores category; anything else is "Other". */
export const CATEGORY_CODES = ['SP', 'CN', 'TY'] as const;
export type CategoryCode = (typeof CATEGORY_CODES)[number] | 'other';

export const indentWords = words({
  en: {
    eyebrow: 'Stores',
    title: 'Material requests',
    ask: 'Ask for material',

    urgency: { breakdown: 'Breakdown', urgent: 'Urgent', routine: 'Normal' } satisfies Record<Indent['urgency'], string>,
    category: { SP: 'Spares', CN: 'Supplies', TY: 'Tyres', other: 'Other' } satisfies Record<CategoryCode, string>,

    /** How long a request has waited. */
    wait: (hours: number) => (hours < 1 ? 'Under 1 hour' : hours < 24 ? plural(Math.round(hours), 'hour') : `${formatQty(hours / 24, 1)} days`),
    /** The oldest request's age: hours under a day, days after. */
    age: (hours: number) => (hours >= 24 ? `${formatQty(hours / 24, 1)} days` : plural(Math.round(hours), 'hour')),

    tiles: {
      waiting: 'Waiting approval',
      worth: (amount: string) => `Worth ${amount}`,
      breakdown: 'Breakdown, waiting',
      stopped: 'Work stopped until approved',
      nothingStopped: 'Nothing stopped',
      oldest: 'Oldest waiting',
      late: 'Late — follow up',
      approved: 'Approved amount',
      approvedNote: 'Approved or given',
    },

    ageing: {
      caption: 'Open requests',
      title: 'Waiting time',
      all: 'All',
      buckets: ['Under 4 hours', '4–12 hours', '12–24 hours', 'Over a day'] as [string, string, string, string],
      count: (n: number) => plural(n, 'request'),
      summary: (open: number, overADay: number) => `Open: ${open}. Over a day: ${overADay}.`,
      none: 'No open requests here.',
    },

    spend: {
      title: 'Approved amount',
      bySite: 'By site',
      byType: 'By type',
      stopped: (label: string) => `${label} · stopped`,
      summary: (top: string, amount: string, stopped: string[]) =>
        `Most: ${top}, ${amount}.${stopped.length > 0 ? ` Stopped: ${stopped.join(', ')}.` : ''}`,
      none: 'No requests.',
      legend: 'Bar = approved. Dashes = waiting. Choose a bar to see its requests.',
    },

    filters: {
      open: 'Open',
      fleet: 'Open for vehicles',
      breakdown: 'Breakdown',
      low: 'Low stock',
      all: 'All',
      clear: 'clear',
    },
    viewOnly: 'You can only view. You cannot approve.',

    columns: {
      request: 'Request',
      urgency: 'Urgency',
      waiting: 'Waiting',
      item: 'Item',
      for: 'For',
      wanted: 'Wanted',
      inStock: 'In stock',
      /** Under the stock figure: the reorder level it is measured against. */
      min: (n: string) => `min ${n}`,
      amount: 'Amount',
      status: 'Status',
    },

    empty: {
      group: (label: string) => `Nothing for ${label} here.`,
      allSites: 'Show all sites',
      allTypes: 'Show all types',
      nothing: 'Nothing to show.',
      showAll: 'Show all',
    },

    sheet: {
      waited: (hours: number) => `+${hours}h`,
      asked: (when: string) => `Asked ${when}`,
      approve: 'Approve',
      reject: 'Reject',
      waiting: (wait: string) => `Waiting ${wait}`,
      markGiven: 'Mark as given',
      done: (status: string) => `${status}. Nothing to do.`,
      viewOnly: 'You can only view this.',

      request: 'Request',
      urgency: 'Urgency',
      askedBy: 'Asked by',
      askedOn: 'Asked on',
      waitingFor: 'Waiting',
      site: 'Site',
      type: 'Type',
      for: 'For',
      general: 'General stores',

      item: 'Item',
      itemCode: 'Item code',
      wanted: 'Wanted',
      estimate: 'Estimate',
      rate: (uom: string) => `Rate / ${uom}`,

      stock: 'Stock',
      inStock: 'In stock',
      minimum: 'Minimum stock',
      shortBy: 'Short by',
      noStock: (forWhat: string | null) => `No stock. ${forWhat ?? 'The work'} waits for this.`,
      lowStock: 'Stock is low. Order more.',
      enough: 'Enough stock. This can wait.',

      alsoFor: (asset: string) => `Also for ${asset}`,
      noOthers: 'No other requests.',
    },

    reject: {
      title: 'Reject this request?',
      confirm: 'Reject',
      asked: (by: string, qty: string, uom: string, item: string, amount: string) =>
        `${by} asked for ${qty} ${uom} of ${item}. About ${amount}.`,
      stopped: (asset: string | null) => `${asset ?? 'The machine'} is stopped. It stays stopped if you reject.`,
      noStock: 'No stock. The work waits until someone asks again.',
      inStock: (qty: string, uom: string) => `${qty} ${uom} in stock. Nothing stops today.`,
    },
  },
  ta: {
    eyebrow: 'ஸ்டோர்ஸ்',
    title: 'பொருள் கோரிக்கைகள்',
    ask: 'பொருள் கேள்',

    urgency: { breakdown: 'பழுது', urgent: 'அவசரம்', routine: 'சாதாரணம்' },
    category: { SP: 'ஸ்பேர்ஸ்', CN: 'நுகர்பொருட்கள்', TY: 'டயர்', other: 'மற்றவை' },

    wait: (hours) =>
      hours < 1 ? '1 மணி நேரத்துக்குள்' : hours < 24 ? `${Math.round(hours)} மணி நேரம்` : `${formatQty(hours / 24, 1)} நாள்`,
    age: (hours) => (hours >= 24 ? `${formatQty(hours / 24, 1)} நாள்` : `${Math.round(hours)} மணி நேரம்`),

    tiles: {
      waiting: 'அனுமதிக்குக் காத்திருப்பவை',
      worth: (amount) => `மதிப்பு ${amount}`,
      breakdown: 'பழுது, காத்திருப்பவை',
      stopped: 'அனுமதி வரும் வரை வேலை நிற்கும்',
      nothingStopped: 'எதுவும் நிற்கவில்லை',
      oldest: 'அதிக நேரம் காத்திருப்பது',
      late: 'தாமதம் — கவனியுங்கள்',
      approved: 'அனுமதித்த தொகை',
      approvedNote: 'அனுமதித்தது அல்லது கொடுத்தது',
    },

    ageing: {
      caption: 'திறந்த கோரிக்கைகள்',
      title: 'காத்திருக்கும் நேரம்',
      all: 'எல்லாம்',
      buckets: ['0–4 மணி', '4–12 மணி', '12–24 மணி', '1 நாளுக்கு மேல்'],
      count: (n) => `${n} கோரிக்கை`,
      summary: (open, overADay) => `திறந்தவை: ${open}. ஒரு நாளுக்கு மேல்: ${overADay}.`,
      none: 'இங்கே திறந்த கோரிக்கை இல்லை.',
    },

    spend: {
      title: 'அனுமதித்த தொகை',
      bySite: 'சைட் வாரியாக',
      byType: 'வகை வாரியாக',
      stopped: (label) => `${label} · நிற்கிறது`,
      summary: (top, amount, stopped) =>
        `அதிகம்: ${top}, ${amount}.${stopped.length > 0 ? ` நிற்கிறது: ${stopped.join(', ')}.` : ''}`,
      none: 'கோரிக்கை இல்லை.',
      legend: 'பட்டை = அனுமதித்தது. கோடு = காத்திருப்பது. பட்டையை அழுத்தினால் அதன் கோரிக்கைகள் வரும்.',
    },

    filters: {
      open: 'திறந்தவை',
      fleet: 'திறந்தவை — வண்டிகள்',
      breakdown: 'பழுது',
      low: 'இருப்பு குறைவு',
      all: 'எல்லாம்',
      clear: 'அழி',
    },
    viewOnly: 'பார்க்க மட்டும் முடியும். அனுமதிக்க முடியாது.',

    columns: {
      request: 'கோரிக்கை',
      urgency: 'அவசர நிலை',
      waiting: 'காத்திருப்பு',
      item: 'பொருள்',
      for: 'எதற்கு',
      wanted: 'தேவை',
      inStock: 'இருப்பு',
      min: (n) => `குறைந்தபட்சம் ${n}`,
      amount: 'தொகை',
      status: 'நிலை',
    },

    empty: {
      group: (label) => `${label} — இங்கே எதுவும் இல்லை.`,
      allSites: 'எல்லா சைட்டும் காட்டு',
      allTypes: 'எல்லா வகையும் காட்டு',
      nothing: 'காட்ட எதுவும் இல்லை.',
      showAll: 'எல்லாம் காட்டு',
    },

    sheet: {
      waited: (hours) => `+${hours} மணி`,
      asked: (when) => `கேட்டது ${when}`,
      approve: 'அனுமதி',
      reject: 'நிராகரி',
      waiting: (wait) => `காத்திருப்பு: ${wait}`,
      markGiven: 'கொடுத்ததாகப் பதிவு செய்',
      done: (status) => `${status}. செய்ய எதுவும் இல்லை.`,
      viewOnly: 'நீங்கள் பார்க்க மட்டுமே முடியும்.',

      request: 'கோரிக்கை',
      urgency: 'அவசர நிலை',
      askedBy: 'கேட்டவர்',
      askedOn: 'கேட்ட நேரம்',
      waitingFor: 'காத்திருப்பு',
      site: 'சைட்',
      type: 'வகை',
      for: 'எதற்கு',
      general: 'பொது ஸ்டோர்',

      item: 'பொருள்',
      itemCode: 'பொருள் எண்',
      wanted: 'தேவை',
      estimate: 'தோராயத் தொகை',
      rate: (uom) => `விலை / ${uom}`,

      stock: 'இருப்பு',
      inStock: 'இருப்பு',
      minimum: 'குறைந்தபட்ச இருப்பு',
      shortBy: 'குறைவு',
      noStock: (forWhat) => `இருப்பு இல்லை. ${forWhat ?? 'வேலை'} இதற்காகக் காத்திருக்கிறது.`,
      lowStock: 'இருப்பு குறைவு. மேலும் ஆர்டர் செய்யுங்கள்.',
      enough: 'போதுமான இருப்பு உள்ளது. இது காத்திருக்கலாம்.',

      alsoFor: (asset) => `${asset} — மற்ற கோரிக்கைகள்`,
      noOthers: 'வேறு கோரிக்கை இல்லை.',
    },

    reject: {
      title: 'இந்தக் கோரிக்கையை நிராகரிக்கவா?',
      confirm: 'நிராகரி',
      asked: (by, qty, uom, item, amount) => `${by} கேட்டது: ${item}, ${qty} ${uom}. சுமார் ${amount}.`,
      stopped: (asset) => `${asset ?? 'இயந்திரம்'} நிற்கிறது. நிராகரித்தால் நின்றபடியே இருக்கும்.`,
      noStock: 'இருப்பு இல்லை. மீண்டும் கேட்கும் வரை வேலை நிற்கும்.',
      inStock: (qty, uom) => `${qty} ${uom} இருப்பு உள்ளது. இன்று எதுவும் நிற்காது.`,
    },
  },
});

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
