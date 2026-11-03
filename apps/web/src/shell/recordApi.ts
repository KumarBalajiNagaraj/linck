import { apiFetch } from '../auth/api.js';

/**
 * THE DESK RECORDS ON THE API, for live mode (VITE_API_URL set): how a request
 * goes, and how a refusal comes back as a problem the screen words.
 *
 *   /customers         features/sales/salesApi.ts
 *   /purchase-orders   features/sales/salesApi.ts
 *   /breakdowns        features/fleet/breakdownApi.ts
 *
 * The three routers (apps/api/app/api/customers.py, purchase_orders.py,
 * breakdowns.py) refuse in one vocabulary, `{"detail": {"problem": {"code":
 * ...}}}` (app/api/problems.py), so they share this reading of it. The expense
 * chain has its own, in features/expenses/expenseApi.ts: its refusals are the
 * approval chain's.
 *
 * The server applies the rules and decides. A screen offers only what it
 * expects the API to allow, and shows the API's refusal, in words, when it
 * does not. A code is never shown; the screen's words.ts says what it means.
 *
 * No React here: plain functions, called directly by the tests.
 */

/** Why a record could not be read, saved or moved. Worded by the screen, never shown as a code. */
export type RecordProblem =
  /** Not this person's to do, at this site. `permission` says whose it is. */
  | { code: 'needs-permission'; permission: string }
  /** Not now: the record has moved on. `status` is where it is now. */
  | { code: 'wrong-step'; status: RecordStatus; action: string }
  /** Rejecting needs a reason. */
  | { code: 'needs-reason'; action: string }
  /** Another customer of this company already has the GST number. */
  | { code: 'gstin-used'; gstin: string }
  /** The vehicle already has a breakdown that is not fixed. */
  | { code: 'vehicle-already-down'; vehicle: string }
  /** The record is not there: removed, or another company's (the API says the same for both). */
  | { code: 'gone' }
  /** A value the API would not store. `field` is the request's name for it; `reason` only picks the fix. */
  | { code: 'invalid'; field: string; reason: string }
  /** The session ended and could not be renewed. The sign-in screen follows. */
  | { code: 'signed-out' }
  /** The API did not answer at all. */
  | { code: 'offline' }
  /** The API answered with a fault, or with something this app cannot read. */
  | { code: 'server'; status: number };

/** Every status a "not now" can name: an order's or a breakdown's. */
const STATUSES = ['pending_approval', 'approved', 'part_dispatched', 'fulfilled', 'rejected', 'open', 'in_workshop', 'resolved'] as const;
export type RecordStatus = (typeof STATUSES)[number];

/** A refusal from the API, carried as the problem it means. `problem` is what shell/queryClient.ts reads to decide on a retry. */
export class RecordRefused extends Error {
  constructor(readonly problem: RecordProblem) {
    super(problem.code);
    this.name = 'RecordRefused';
  }
}

/** Anything thrown on the way, as the problem a person is shown. */
export function problemOf(err: unknown): RecordProblem {
  return err instanceof RecordRefused ? err.problem : { code: 'server', status: 0 };
}

const server = (status: number): RecordProblem => ({ code: 'server', status });

/** The API's own refusal, as a problem this app words. A known code with values it cannot word is a fault, not half a sentence. */
function knownProblem(p: Record<string, unknown>, status: number): RecordProblem {
  const text = (key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);
  switch (p.code) {
    case 'needs-permission': {
      const permission = text('permission');
      return permission ? { code: 'needs-permission', permission } : server(status);
    }
    case 'wrong-step': {
      const at = text('status');
      return at && (STATUSES as readonly string[]).includes(at) ? { code: 'wrong-step', status: at as RecordStatus, action: text('action') ?? '' } : server(status);
    }
    case 'needs-reason':
      return { code: 'needs-reason', action: text('action') ?? '' };
    case 'gstin-used':
      return { code: 'gstin-used', gstin: text('gstin') ?? '' };
    case 'vehicle-already-down':
      return { code: 'vehicle-already-down', vehicle: text('vehicle') ?? '' };
    case 'not-found':
      return { code: 'gone' };
    case 'invalid':
      return { code: 'invalid', field: text('field') ?? '', reason: text('reason') ?? '' };
    default:
      return server(status);
  }
}

/** Why the API said no, from its response. */
export async function readProblem(res: Response): Promise<RecordProblem> {
  if (res.status === 401) return { code: 'signed-out' };
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    // Not JSON: a proxy's error page, say. The status is all there is.
  }
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
  const problem = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as { problem?: unknown }).problem : undefined;
  if (problem && typeof problem === 'object' && typeof (problem as { code?: unknown }).code === 'string') {
    return knownProblem(problem as Record<string, unknown>, res.status);
  }
  if (res.status === 422 && Array.isArray(detail)) {
    // FastAPI's own check of the request's shape: [{loc: ["body", "creditLimit"], ...}].
    const loc = (detail[0] as { loc?: unknown } | undefined)?.loc;
    const field = Array.isArray(loc) ? [...loc].reverse().find((part): part is string => typeof part === 'string' && part !== 'body') : undefined;
    return { code: 'invalid', field: field ?? '', reason: '' };
  }
  if (res.status === 404) return { code: 'gone' };
  return server(res.status);
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** A JSON request. */
export function sendJson(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/** A read, cancelled when the screen goes. */
export function readJson(signal?: AbortSignal): RequestInit {
  return { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) };
}

/** One request, through the API's base and its session renewal (auth/api.ts); a refusal is thrown as its problem. */
export async function call<T>(path: string, init: RequestInit, read: (body: unknown) => T): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch (err) {
    // An aborted read (the screen went away) is not "offline": let it through as itself.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new RecordRefused({ code: 'offline' });
  }
  if (!res.ok) throw new RecordRefused(await readProblem(res));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RecordRefused(server(res.status));
  }
  return read(body);
}

/** The records after a write: the changed ones replaced in place, new ones first. */
export function withRecords<T extends { id: string }>(old: readonly T[], changed: readonly T[]): T[] {
  const fresh = new Map(changed.map((r) => [r.id, r] as const));
  const known = new Set(old.map((r) => r.id));
  return [...changed.filter((r) => !known.has(r.id)), ...old.map((r) => fresh.get(r.id) ?? r)];
}
