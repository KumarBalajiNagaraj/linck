/**
 * The API, and the one setting that says whether there is one.
 *
 * `VITE_API_URL` unset (or blank) is the DEMO: the persona switcher, mock data
 * and no sign-in, which is what the Vercel deployment has always been. Set, the
 * app is LIVE: `/api` in production, through Vercel's rewrite to the API
 * (docs/DEPLOY.md), or `http://localhost:8000` on a laptop. Live, nothing
 * renders until `GET /me/session` has said who is signed in (auth/LiveApp.tsx).
 *
 * The session is an HttpOnly cookie the API sets, so every request goes with
 * `credentials: 'include'` and no token ever passes through this code. The
 * session lasts an hour and its refresh cookie a month, so a 401 in the middle
 * of the day means "renew", not "sign in": `apiFetch` renews once and sends the
 * request again, and only if that fails is the person sent to sign in.
 */

const configured = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').trim();

/** Live: the API's base URL, without a trailing slash. Null is the demo. */
export const LIVE_API: string | null = configured ? configured.replace(/\/+$/, '') : null;

export const LIVE = LIVE_API !== null;

/**
 * Where requests go. In the demo, the few screens that already read the API
 * (the WhatsApp inbox, industry news) try a local one, as they always have,
 * and say so on screen when it is not there.
 */
export const API_BASE = LIVE_API ?? 'http://localhost:8000';

type Renewal = 'renewed' | 'refused' | 'offline';

/** Renewals that succeeded in this tab. A request sent before the latest one only needs sending again. */
let renewals = 0;
let renewing: Promise<Renewal> | null = null;
let onSignedOut: (() => void) | null = null;

/** Called once, by the auth store: what to do when the session is gone for good. */
export function whenSignedOut(listener: () => void): void {
  onSignedOut = listener;
}

/**
 * Renew the session once, however many requests failed at the same moment.
 *
 * Each renewal spends the refresh token and sets a new one, and the API treats
 * an old one coming back as a stolen cookie: it signs every copy out
 * (app/core/security.py, rotate_session). Two tabs renewing at once would send
 * the same token twice, so the renewal also holds a lock across every tab of
 * this site; whichever goes second sends the newer cookie the first one set.
 */
function renew(seen: number): Promise<Renewal> {
  if (renewals !== seen) return Promise.resolve('renewed');
  renewing ??= acrossTabs(async (): Promise<Renewal> => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!res.ok) return res.status === 401 ? 'refused' : 'offline';
      renewals += 1;
      return 'renewed';
    } catch {
      return 'offline';
    }
  }).finally(() => {
    renewing = null;
  });
  return renewing;
}

function acrossTabs<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? (locks.request('linck.session-renewal', task) as Promise<T>) : task();
}

/**
 * A request to the API, renewing the session once on a 401.
 *
 * With `signOutOn401`, a 401 that survives the renewal ends the session in the
 * app, and the sign-in screen replaces whatever was open. The boot passes
 * false: before anyone has signed in there is nobody to sign out. A renewal
 * that could not reach the API changes nothing, so a dropped connection never
 * signs anyone out; the 401 goes back to the screen, which says what it can.
 */
export async function apiRequest(path: string, init: RequestInit = {}, signOutOn401 = true): Promise<Response> {
  const send = () => fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  if (!LIVE) return send();

  const seen = renewals;
  const first = await send();
  if (first.status !== 401) return first;

  const renewal = await renew(seen);
  if (renewal === 'offline') return first;
  const again = renewal === 'renewed' ? await send() : first;
  if (again.status === 401 && signOutOn401) onSignedOut?.();
  return again;
}

/** Every screen's way to the API. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return apiRequest(path, init, true);
}

/** The code in the API's refusal shape, `{"detail": {"problem": {"code": ...}}}`. */
export async function problemCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { detail?: { problem?: { code?: unknown } } };
    const code = body.detail?.problem?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}
