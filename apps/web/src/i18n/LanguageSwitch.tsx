import { LANGUAGES, useLang } from './lang.js';

/**
 * One tap to the other language. The button is labelled with the language it
 * switches TO, written in that language — a Tamil reader looking at an English
 * screen sees "தமிழ்", which they can read, and nothing else they must.
 */
export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { lang, setLang } = useLang();
  const other = LANGUAGES.find((l) => l.key !== lang)!;
  return (
    <button
      type="button"
      onClick={() => setLang(other.key)}
      lang={other.key === 'ta' ? 'ta' : 'en'}
      aria-label={other.key === 'ta' ? 'தமிழில் காட்டு — Show in Tamil' : 'Show in English — ஆங்கிலத்தில் காட்டு'}
      className={`flex h-11 shrink-0 items-center px-2 text-[14px] font-medium md:h-9 md:px-2.5 ${className}`}
      style={{
        color: 'var(--brand)',
        borderRadius: 'var(--r-1)',
        boxShadow: 'inset 0 0 0 1px var(--brand)',
      }}
    >
      {/* On a phone, "EN" is enough to find English; "தமிழ்" is always spelled
          out, because that is the word a Tamil reader is looking for. */}
      <span className="md:hidden">{other.key === 'en' ? 'EN' : other.name}</span>
      <span className="hidden md:inline">{other.name}</span>
    </button>
  );
}
