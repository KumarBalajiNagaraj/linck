import { create } from 'zustand';

/**
 * The language the screens speak: English or Tamil.
 *
 * A choice made once and kept, so it is remembered in this browser. Storage
 * can be blocked (a private window, a locked-down office machine); then the
 * choice still holds for the session and simply is not remembered.
 */

export type Lang = 'en' | 'ta';

/** Each language named in itself, so a Tamil reader finds "தமிழ்" without reading English. */
export const LANGUAGES: readonly { key: Lang; name: string }[] = [
  { key: 'en', name: 'English' },
  { key: 'ta', name: 'தமிழ்' },
];

const STORAGE_KEY = 'linck.lang';

function remembered(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ta' ? 'ta' : 'en';
  } catch {
    return 'en';
  }
}

/** Screen readers and the browser's own hyphenation and font choice follow `lang`. */
function mark(lang: Lang) {
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'ta' ? 'ta' : 'en-IN';
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export const useLang = create<LangState>((set) => {
  const lang = remembered();
  mark(lang);
  return {
    lang,
    setLang: (next) => {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not remembered, but still switched.
      }
      mark(next);
      set({ lang: next });
    },
  };
});
