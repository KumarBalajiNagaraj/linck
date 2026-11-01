import { create } from 'zustand';
import { useApp } from '../shell/store.js';
import { API_BASE, apiFetch, problemCode, whenSignedOut } from './api.js';
import { fetchSession, SessionError, sessionToAppState } from './session.js';

/**
 * LIVE MODE'S SIGN-IN: who is signed in, and the ways in and out.
 *
 * Nothing here runs in the demo. Live, the app boots into `checking`, asks
 * `GET /me/session`, and becomes `signed-in` (the router mounts) or
 * `signed-out` (the sign-in screen, with the reason the last attempt failed).
 * There is no state in which the shell shows without a session behind it.
 */

/**
 * Why the person is looking at the sign-in screen, as the screen words it
 * (auth/words.ts). The first six are the API's own codes (app/api/auth.py);
 * the rest are what this app makes of everything else.
 */
export type SignInProblem =
  | 'not_registered'
  | 'account_stopped'
  | 'domain_not_allowed'
  | 'email_unverified'
  | 'registered_twice'
  | 'google_off'
  /** They pressed Cancel at Google. */
  | 'cancelled'
  /** The trip to Google and back took too long, or came back to another tab. */
  | 'expired'
  | 'google_failed'
  /** Signed in, then the session ended: it ran out, or was signed out elsewhere. */
  | 'signed_out'
  | 'unreachable'
  | 'dev_off'
  | 'email_wrong';

const API_CODES: readonly SignInProblem[] = [
  'not_registered',
  'account_stopped',
  'domain_not_allowed',
  'email_unverified',
  'registered_twice',
  'google_off',
];

/** The `?error=` the API's Google callback sends the browser back with. */
export function problemFrom(code: string | null): SignInProblem | null {
  if (!code) return null;
  if ((API_CODES as readonly string[]).includes(code)) return code as SignInProblem;
  if (code === 'access_denied') return 'cancelled';
  if (code === 'expired' || code === 'state_mismatch') return 'expired';
  return 'google_failed';
}

export type AuthState =
  | { status: 'checking' }
  | { status: 'signed-in' }
  | { status: 'signed-out'; problem: SignInProblem | null }
  /** The API did not answer, or answered with a fault: say so, and offer to try again. */
  | { status: 'unreachable' };

export const useAuth = create<AuthState>(() => ({ status: 'checking' }));

const SIGN_IN_PATH = '/sign-in';

function onSignInPage(): boolean {
  return window.location.pathname === SIGN_IN_PATH;
}

whenSignedOut(() => {
  if (useAuth.getState().status === 'signed-in') useAuth.setState({ status: 'signed-out', problem: 'signed_out' }, true);
});

/** Ask the API who is signed in, and show the app or the sign-in screen accordingly. */
export async function startSession(): Promise<void> {
  useAuth.setState({ status: 'checking' }, true);
  try {
    const payload = await fetchSession();
    useApp.getState().applySession(sessionToAppState(payload));
    useAuth.setState({ status: 'signed-in' }, true);
  } catch (err) {
    if (err instanceof SessionError && (err.status === 401 || err.status === 403)) {
      // 403 is the one refusal /me/session has: the person was stood down
      // after signing in (app/api/deps.py), so their session is no good.
      const problem = err.status === 403 ? 'account_stopped' : onSignInPage() ? problemFrom(errorParam()) : null;
      useAuth.setState({ status: 'signed-out', problem }, true);
      return;
    }
    useAuth.setState({ status: 'unreachable' }, true);
  }
}

function errorParam(): string | null {
  return new URLSearchParams(window.location.search).get('error');
}

/**
 * Google, by way of the API: the browser leaves for Google and the API's
 * callback brings it back to `next`, signed in, or to `/sign-in?error=` with
 * the reason. `next` is where the person was going, so a link opened while
 * signed out lands where it pointed; from the sign-in page itself, home.
 */
export function googleSignInUrl(): string {
  const next = onSignInPage() ? '/' : `${window.location.pathname}${window.location.search}`;
  return `${API_BASE}/auth/google/login?${new URLSearchParams({ next }).toString()}`;
}

/**
 * The API's local-only `/auth/dev-login`: an email, believed. It exists only
 * on an API running with LINCK_ENVIRONMENT=local and no Google client (404
 * anywhere else), and this app offers it only in a development build.
 */
export async function devSignIn(email: string): Promise<SignInProblem | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/dev-login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() }),
    });
  } catch {
    return 'unreachable';
  }
  if (res.status === 404) return 'dev_off';
  if (res.status === 422) return 'email_wrong';
  if (res.status === 403) return problemFrom(await problemCode(res)) ?? 'not_registered';
  if (!res.ok) return 'unreachable';
  await startSession();
  return null;
}

/**
 * End the session on the server, then start this page again at the sign-in
 * screen. A reload rather than a state change, so nothing the last person
 * opened stays in this tab's memory for the next one: on a shared desk at a
 * weighbridge, that is the point of signing out. Resolves false, and leaves
 * the person signed in, only if the API could not be reached to sign them out.
 */
export async function signOut(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  window.location.replace(SIGN_IN_PATH);
  return true;
}

/** How often a tab coming back into view re-checks the session, at most. */
const RECHECK_MS = 5 * 60 * 1000;

/**
 * Notice a session that ended while the tab sat in the background: an
 * hour-long session lapses between two looks at a screen that reads no API.
 * Coming back to the tab asks `/me/session` again, through `apiFetch`, which
 * renews it, or signs out a session that is gone; a 403 means the account
 * was stopped meanwhile.
 */
export function watchSession(): void {
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || useAuth.getState().status !== 'signed-in') return;
    if (Date.now() - lastCheck < RECHECK_MS) return;
    lastCheck = Date.now();
    void apiFetch('/me/session').then(
      (res) => {
        if (res.status === 403) useAuth.setState({ status: 'signed-out', problem: 'account_stopped' }, true);
      },
      () => undefined,
    );
  });
}
