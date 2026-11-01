import { createContext, useContext } from 'react';

/**
 * The few words the design system prints itself — a close button, a cancel,
 * the time a figure is from. The app passes them in its user's language
 * through `UiWordsProvider`; without one, they are English.
 */
export interface UiWords {
  close: string;
  cancel: string;
  confirm: string;
  apply: string;
  dismiss: string;
  /** Read aloud for an empty cell. */
  noValue: string;
  /** "Type DELETE to confirm", around the phrase. */
  typeToConfirm: [before: string, after: string];
  /** The time a figure is from, as shown under it. */
  updatedAt: (time: string) => string;
  /** Hover text on the as-of dot, with where the figure comes from. */
  freshness: { live: string; materialised: string; stale: string; source: (source: string) => string };
  provisional: { confirmed: string; unconfirmed: string; corrected: (original: string) => string };
  /** How sure a machine reading is, out of three. */
  confidence: (level: 1 | 2 | 3) => string;
  unaccounted: string;
}

export const ENGLISH_UI_WORDS: UiWords = {
  close: 'Close',
  cancel: 'Cancel',
  confirm: 'Confirm',
  apply: 'Apply',
  dismiss: 'Dismiss',
  noValue: 'No value',
  typeToConfirm: ['Type', 'to confirm'],
  updatedAt: (time) => `Updated ${time}`,
  freshness: {
    live: 'Live',
    materialised: 'Updated on a schedule',
    stale: 'Old — not updated in time',
    source: (source) => `From: ${source}`,
  },
  provisional: {
    confirmed: 'Read by Linck, checked by a person',
    unconfirmed: 'Read by Linck, not checked yet',
    corrected: (original) => `Linck read ${original}. Corrected by hand.`,
  },
  confidence: (level) => (level === 3 ? 'Sure' : level === 2 ? 'Fairly sure' : 'Not sure — check it'),
  unaccounted: 'Unaccounted',
};

const UiWordsContext = createContext<UiWords>(ENGLISH_UI_WORDS);

export const UiWordsProvider = UiWordsContext.Provider;

export function useUiWords(): UiWords {
  return useContext(UiWordsContext);
}
