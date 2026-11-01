import { words } from '../../i18n/words.js';

/**
 * The words of the industry news screen (LIN-10), in English and Tamil.
 *
 * The news itself is not here. On the server a model writes each item's two
 * lines in both languages, and a headline no model rewrote is shown as the
 * paper printed it. Only the screen's own words are here — and the sample,
 * which is the product's own made-up example, plainly marked as not news.
 */

interface SampleItem {
  /** Stands where a real item shows the headline as printed. */
  title: string;
  line: string;
  why: string;
}

export const industryNewsWords = words({
  en: {
    eyebrow: 'Overview',
    title: 'Industry news',
    intro: 'News from our customers’ trade, last 2 weeks.',
    /** Hover on the as-of dot. */
    source: 'Google News',
    refresh: 'Refresh',
    showSample: 'Show sample',
    hideSample: 'Hide sample',
    loading: 'Getting news…',
    refreshing: 'Getting news… this can take a minute.',
    aiWrote: 'AI wrote these lines. Read the news before you act.',
    aiOff: 'AI summary is off. These are the top headlines.',
    aiFailed: 'AI summary did not work this time. These are the top headlines.',
    stale: 'This news is over a week old. Tap Refresh.',
    nextRefresh: (time: string) => `You can refresh again after ${time}.`,
    nothingYet: 'No news yet.',
    nothingYetHow: 'Tap Refresh to get this week’s news.',
    nothingToShow: 'No news to show.',
    noneThisTime: 'No news this time.',
    why: 'Why it matters:',
    read: 'Read',
    newTab: '(opens in a new tab)',
    problem: {
      signIn: 'Sign in to see industry news.',
      notAllowed: 'Ask your admin to give you access.',
      unreachable: 'Cannot reach Linck. Try again later.',
      status: (status: number) => `Server error (${status}). Try again later.`,
      tooSoon: (time: string | null) =>
        time ? `Already refreshed this hour. Try again after ${time}.` : 'Already refreshed this hour. Try again later.',
      running: 'News is being fetched now. Wait a minute.',
      noNews: 'Could not get the news just now. Try again in a few minutes.',
    },
    sample: {
      stamp: 'Sample — not real news',
      banner: 'Sample — not real news.',
      source: 'Linck sample',
      items: [
        {
          title: 'Sample headline: builders plan more flats near Chennai',
          line: 'Builders near Chennai plan more apartment blocks.',
          why: 'More M-Sand and blue metal orders.',
        },
        {
          title: 'Sample headline: a new road job goes to tender',
          line: 'A new road project is out for tender.',
          why: 'Road contractors will need GSB and WMM.',
        },
        {
          title: 'Sample headline: cement price goes up a little',
          line: 'Cement prices went up a little this month.',
          why: 'Builders may slow down. Watch the orders.',
        },
        {
          title: 'Sample headline: heavy rain expected next week',
          line: 'Heavy rain is expected next week.',
          why: 'Sites may stop work. Plan loads and stock.',
        },
      ] as SampleItem[],
    },
  },
  ta: {
    eyebrow: 'மேலோட்டம்',
    title: 'தொழில் செய்திகள்',
    intro: 'நம் வாடிக்கையாளர்களின் தொழில் செய்திகள், கடந்த 2 வாரம்.',
    source: 'கூகுள் நியூஸ்',
    refresh: 'புதுப்பி',
    showSample: 'மாதிரி காட்டு',
    hideSample: 'மாதிரியை மூடு',
    loading: 'செய்திகள் வருகின்றன…',
    refreshing: 'செய்திகள் வருகின்றன… ஒரு நிமிடம் ஆகலாம்.',
    aiWrote: 'இந்த வரிகளை ஏஐ எழுதியது. செயல்படும் முன் செய்தியைப் படியுங்கள்.',
    aiOff: 'ஏஐ சுருக்கம் ஆஃப் செய்யப்பட்டுள்ளது. இவை முக்கியத் தலைப்புச் செய்திகள்.',
    aiFailed: 'இம்முறை ஏஐ சுருக்கம் வேலை செய்யவில்லை. இவை முக்கியத் தலைப்புச் செய்திகள்.',
    stale: 'இந்தச் செய்திகள் ஒரு வாரத்துக்கு மேல் பழையவை. புதுப்பி-ஐ அழுத்துங்கள்.',
    nextRefresh: (time) => `${time}-க்குப் பிறகு மீண்டும் புதுப்பிக்கலாம்.`,
    nothingYet: 'இன்னும் செய்திகள் இல்லை.',
    nothingYetHow: 'இந்த வாரச் செய்திகளைப் பெற புதுப்பி-ஐ அழுத்துங்கள்.',
    nothingToShow: 'காட்ட செய்திகள் இல்லை.',
    noneThisTime: 'இம்முறை செய்திகள் இல்லை.',
    why: 'ஏன் முக்கியம்:',
    read: 'படி',
    newTab: '(புதிய டேபில் திறக்கும்)',
    problem: {
      signIn: 'தொழில் செய்திகளைப் பார்க்க உள்நுழையுங்கள்.',
      notAllowed: 'அனுமதி தர உங்கள் அட்மினிடம் கேளுங்கள்.',
      unreachable: 'Linck-ஐ அணுக முடியவில்லை. பிறகு முயலுங்கள்.',
      status: (status) => `சர்வர் பிழை (${status}). பிறகு முயலுங்கள்.`,
      tooSoon: (time) =>
        time
          ? `இந்த மணி நேரத்தில் ஏற்கனவே புதுப்பித்தது. ${time}-க்குப் பிறகு முயலுங்கள்.`
          : 'இந்த மணி நேரத்தில் ஏற்கனவே புதுப்பித்தது. பிறகு முயலுங்கள்.',
      running: 'செய்திகள் இப்போது வருகின்றன. ஒரு நிமிடம் காத்திருங்கள்.',
      noNews: 'இப்போது செய்திகளைப் பெற முடியவில்லை. சில நிமிடங்களில் மீண்டும் முயலுங்கள்.',
    },
    sample: {
      stamp: 'மாதிரி — உண்மைச் செய்தி அல்ல',
      banner: 'மாதிரி — உண்மைச் செய்தி அல்ல.',
      source: 'Linck மாதிரி',
      items: [
        {
          title: 'மாதிரித் தலைப்பு: சென்னை அருகே அதிக வீடுகள் கட்டத் திட்டம்',
          line: 'சென்னை அருகே கட்டுநர்கள் அதிக அடுக்குமாடி வீடுகள் கட்டத் திட்டமிடுகிறார்கள்.',
          why: 'எம்-சாண்ட், ஜல்லி ஆர்டர்கள் கூடும்.',
        },
        {
          title: 'மாதிரித் தலைப்பு: புதிய சாலைப் பணிக்கு டெண்டர்',
          line: 'புதிய சாலைப் பணிக்கு டெண்டர் விடப்பட்டது.',
          why: 'சாலை ஒப்பந்ததாரர்களுக்கு GSB, WMM தேவைப்படும்.',
        },
        {
          title: 'மாதிரித் தலைப்பு: சிமெண்ட் விலை சிறிது உயர்வு',
          line: 'இந்த மாதம் சிமெண்ட் விலை சிறிது உயர்ந்தது.',
          why: 'கட்டுமானம் மெதுவாகலாம். ஆர்டர்களைக் கவனியுங்கள்.',
        },
        {
          title: 'மாதிரித் தலைப்பு: அடுத்த வாரம் கனமழை',
          line: 'அடுத்த வாரம் கனமழை எதிர்பார்க்கப்படுகிறது.',
          why: 'சைட்டுகளில் வேலை நிற்கலாம். லோடு, இருப்பைத் திட்டமிடுங்கள்.',
        },
      ],
    },
  },
});

export type IndustryNewsText = typeof industryNewsWords.en;
