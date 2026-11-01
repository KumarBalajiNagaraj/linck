import { ENGLISH_UI_WORDS, type UiWords } from '@linck/ui';
import { words } from './words.js';

/** The design system's own words — close, cancel, the time a figure is from. */
export const uiWords = words<UiWords>({
  en: ENGLISH_UI_WORDS,
  ta: {
    close: 'மூடு',
    cancel: 'ரத்து',
    confirm: 'உறுதி செய்',
    apply: 'பயன்படுத்து',
    dismiss: 'வேண்டாம்',
    noValue: 'மதிப்பு இல்லை',
    typeToConfirm: ['உறுதி செய்ய', 'என டைப் செய்யுங்கள்'],
    updatedAt: (time) => `${time} நிலவரம்`,
    freshness: {
      live: 'நேரலை',
      materialised: 'குறித்த நேரத்தில் புதுப்பிக்கப்படும்',
      stale: 'பழைய தகவல் — புதுப்பிக்கப்படவில்லை',
      source: (source) => `மூலம்: ${source}`,
    },
    provisional: {
      confirmed: 'Linck படித்தது, ஒருவர் சரிபார்த்தார்',
      unconfirmed: 'Linck படித்தது, இன்னும் சரிபார்க்கவில்லை',
      corrected: (original) => `Linck படித்தது ${original}. கையால் திருத்தப்பட்டது.`,
    },
    confidence: (level) => (level === 3 ? 'உறுதி' : level === 2 ? 'ஓரளவு உறுதி' : 'உறுதி இல்லை — சரிபாருங்கள்'),
    unaccounted: 'கணக்கில் வராதது',
  },
});
