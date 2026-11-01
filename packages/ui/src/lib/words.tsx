import { createContext, useContext } from 'react';
import type { Provenance } from '@linck/tokens';

/**
 * The few words the design system prints itself — a close button, a cancel,
 * the time a figure is from. The app passes them in its user's language
 * through `UiWordsProvider`; without one, they are English.
 */
export interface UiWords {
  close: string;
  cancel: string;
  /**
   * The way out of a confirmation. Not "Cancel": beside "Yes, cancel the
   * load" that reads as the action itself.
   */
  goBack: string;
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
  /** Hover text on a hatched value that Linck read off a paper or a photo. */
  provisional: {
    confirmed: string;
    unconfirmed: string;
    corrected: (original: string) => string;
    /**
     * The same, for a value a person typed — a gate rate, a reported payment —
     * which makes no claim about who read what.
     */
    typed: { confirmed: string; unconfirmed: string; corrected: (original: string) => string };
  };
  /** Hover text on a row's rail: where its figures came from. */
  provenance: Record<Provenance, string>;
  /** How sure a machine reading is, out of three. */
  confidence: (level: 1 | 2 | 3) => string;
  /** The confidence meter, read aloud: "How sure: 2 of 3". */
  confidenceOutOf: (level: 1 | 2 | 3) => string;
  unaccounted: string;
  /** Words the charts draw beside their figures. */
  chart: {
    /** A share against its usual share: "+2.1 vs usual". */
    vsUsual: (drift: string) => string;
    /** The far end of a target gauge: "target 1,200". */
    target: (value: string) => string;
    /** A heat-grid cell nobody filled in. */
    notRecorded: string;
  };
}

export const ENGLISH_UI_WORDS: UiWords = {
  close: 'Close',
  cancel: 'Cancel',
  goBack: 'Go back',
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
    typed: {
      confirmed: 'Checked',
      unconfirmed: 'Not checked yet',
      corrected: (original) => `Was ${original}. Changed by hand.`,
    },
  },
  provenance: {
    human: 'Typed by a person',
    proposed: 'Read by Linck, not checked yet',
    confirmed: 'Read by Linck, checked by a person',
    overridden: 'Corrected by hand',
    device: 'Came in by itself',
  },
  confidence: (level) => (level === 3 ? 'Sure' : level === 2 ? 'Fairly sure' : 'Not sure — check it'),
  confidenceOutOf: (level) => `How sure: ${level} of 3`,
  unaccounted: 'Unaccounted',
  chart: {
    vsUsual: (drift) => `${drift} vs usual`,
    target: (value) => `target ${value}`,
    notRecorded: 'not recorded',
  },
};

const UiWordsContext = createContext<UiWords>(ENGLISH_UI_WORDS);

export const UiWordsProvider = UiWordsContext.Provider;

export function useUiWords(): UiWords {
  return useContext(UiWordsContext);
}
