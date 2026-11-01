import { useEffect, useState } from 'react';
import { Button, Rail } from '@linck/ui';
import { LanguageSwitch } from '../i18n/LanguageSwitch.js';
import { useWords } from '../i18n/words.js';
import { Mark } from '../shell/Mark.js';
import { devSignIn, googleSignInUrl, startSession, type SignInProblem } from './auth.js';
import { signInWords } from './words.js';

/**
 * THE SIGN-IN SCREEN. Live mode only, and the only screen there is until
 * someone is signed in.
 *
 * One thing to do, as one big button: sign in with Google. Everyone uses the
 * same door, the director and the driver alike, because nobody signs in who
 * was not registered first; the API matches the Google account to that
 * registration, and the line above the button says plainly why it did not.
 *
 * In a development build only, a developer sign-in under it: an email, sent
 * to the API's local-only `/auth/dev-login`, so the whole flow can be tried
 * without a Google client.
 */
export function SignIn({ problem }: { problem: SignInProblem | null }) {
  const t = useWords(signInWords);
  const [shown, setShown] = useState(problem);
  const [leaving, setLeaving] = useState(false);
  const offline = shown === 'unreachable' && problem === 'unreachable';

  // Back from Google's account picker, the browser may restore this page as it
  // was left: the button greyed out, saying Google is opening. Wake it up.
  useEffect(() => {
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) setLeaving(false);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  return (
    <AuthFrame>
      <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {t.welcome}
      </p>
      <h1 className="font-serif text-[28px] leading-tight" style={{ color: 'var(--text-primary)' }}>
        {t.title}
      </h1>
      <p className="mt-1 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
        {t.lead}
      </p>

      {shown ? <ProblemLine problem={shown} /> : null}

      {offline ? (
        // The API did not answer at all: Google would bring them back to the
        // same silence, so the one thing to offer is asking again.
        <Button variant="primary" className="mt-6 h-[52px]! w-full justify-center! text-[16px]" onClick={() => void startSession()}>
          {t.retry}
        </Button>
      ) : (
        <button
          type="button"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            window.location.assign(googleSignInUrl());
          }}
          className="mt-6 flex h-[52px] w-full items-center justify-center gap-3 px-4 text-[16px] font-medium disabled:opacity-60"
          style={{
            background: 'var(--surface)',
            color: 'var(--text-primary)',
            borderRadius: 'var(--r-1)',
            boxShadow: 'inset 0 0 0 1px var(--border-strong), var(--e1)',
          }}
        >
          <GoogleG />
          {leaving ? t.toGoogle : t.google}
        </button>
      )}

      {import.meta.env.DEV ? <DevSignIn onProblem={setShown} /> : null}
    </AuthFrame>
  );
}

/** The frame of every signed-out screen: the mark, the language switch, one column. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col" style={{ background: 'var(--surface-base)' }}>
      <header
        className="flex h-[52px] shrink-0 items-center justify-between gap-2 px-4"
        style={{ borderBottom: '1px solid var(--border-strong)' }}
      >
        <span className="flex items-center gap-2 pl-1">
          <Mark />
          <span className="font-serif text-[18px] tracking-tight" style={{ color: 'var(--text-primary)' }}>
            Linck
          </span>
        </span>
        {/* Before anything else: a Tamil reader must be able to switch on a
            screen they cannot read yet, and this is the first one. */}
        <LanguageSwitch />
      </header>
      <main className="flex flex-1 justify-center px-4 pb-12 pt-12 sm:pt-20">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>
    </div>
  );
}

/** The app asking the API who is signed in. Usually gone before it is read. */
export function Opening() {
  const t = useWords(signInWords);
  return (
    <AuthFrame>
      <p className="font-serif text-[18px]" style={{ color: 'var(--text-secondary)' }} aria-live="polite">
        {t.opening}
      </p>
    </AuthFrame>
  );
}

/** What happened, then what to do: a word, a mark and a colour, never colour alone. */
function ProblemLine({ problem }: { problem: SignInProblem }) {
  const t = useWords(signInWords);
  const [what, todo] = t.problem[problem];
  return (
    <div role="alert" className="relative mt-5 py-0.5 pl-4">
      <Rail status="attention" />
      <p className="text-[15px] leading-snug" style={{ color: 'var(--text-primary)' }}>
        <span aria-hidden="true" className="mr-1.5 text-[11px]" style={{ color: 'var(--status-attention)' }}>
          ▲
        </span>
        {what}
      </p>
      <p className="mt-0.5 text-[14px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
        {todo}
      </p>
    </div>
  );
}

function DevSignIn({ onProblem }: { onProblem: (problem: SignInProblem | null) => void }) {
  const t = useWords(signInWords);
  const [email, setEmail] = useState('');
  const [working, setWorking] = useState(false);

  return (
    <form
      className="mt-10 pt-5"
      style={{ borderTop: '1px solid var(--border-subtle)' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (working) return;
        setWorking(true);
        onProblem(null);
        void devSignIn(email).then((problem) => {
          // On success the app replaces this screen; only a refusal comes back here.
          setWorking(false);
          onProblem(problem);
        });
      }}
    >
      <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {t.dev.title}
      </p>
      <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        {t.dev.hint}
      </p>
      <label className="mt-3 flex flex-col gap-1">
        <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {t.dev.email}
        </span>
        <input
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 w-full px-3 text-[15px]"
          style={{
            background: 'var(--surface)',
            color: 'var(--text-primary)',
            borderRadius: 'var(--r-1)',
            boxShadow: 'inset 0 0 0 1px var(--border-strong)',
          }}
        />
      </label>
      <Button type="submit" className="mt-3 w-full justify-center!" disabled={working}>
        {working ? t.dev.working : t.dev.button}
      </Button>
    </form>
  );
}

/** Google's "G", so the button is found by people who do not read the words on it. */
function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
