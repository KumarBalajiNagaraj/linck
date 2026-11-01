import { useLang, type Lang } from './lang.js';

/**
 * A screen's words, in English and in Tamil.
 *
 * Each feature keeps its own words next to its code:
 *
 *   const text = words({
 *     en: { title: 'Expenses', waiting: (n: number) => `${n} waiting` },
 *     ta: { title: 'செலவுகள்', waiting: (n) => `${n} காத்திருக்கின்றன` },
 *   });
 *   const t = useWords(text);
 *
 * The Tamil side must have every key the English side has, with the same
 * shape, or the build fails — a screen can never show a missing word. A
 * sentence with a number or a name in it is a function, so each language can
 * put the number where its own grammar wants it.
 *
 * Only the product's own words go here. What people typed — vendor names,
 * remarks, a driver's message — is shown as they typed it.
 */

export interface Words<T> {
  en: T;
  ta: T;
}

export function words<T>(both: { en: T; ta: NoInfer<T> }): Words<T> {
  return both;
}

/** The words in the language the person chose. Re-renders when they switch. */
export function useWords<T>(text: Words<T>): T {
  const lang = useLang((s) => s.lang);
  return text[lang];
}

/** For code outside a component. Does not re-render on its own. */
export function wordsNow<T>(text: Words<T>, lang: Lang = useLang.getState().lang): T {
  return text[lang];
}
