/**
 * INDUSTRY NEWS (LIN-10) — the API client for the owner's news screen.
 *
 *   GET  /insights/industry           the newest digest, and whether it is a week old
 *   POST /insights/industry/refresh   build a new one; at most once an hour per company
 *
 * The digest is built on the server: Google News headlines, and — when a model
 * is set up there — one plain line and one "why it matters" line about each,
 * in English and Tamil. Every link is one the news feed gave; the server drops
 * anything else, and this file checks again before a link is ever shown.
 */

import { apiFetch } from '../../auth/api.js';

/** One line in each of the screen's languages. */
export interface Both {
  en: string;
  ta: string;
}

export interface DigestItem {
  /** The headline as the paper printed it, in English. */
  title: string;
  source: string;
  publishedAt: string;
  link: string;
  /** Null when no model wrote the lines: then the headline is the whole item. */
  summary: Both | null;
  why: Both | null;
}

/** summarised: a model wrote the lines. ai_off: none is set up. ai_failed: it did not answer usably. */
export type DigestStatus = 'summarised' | 'ai_off' | 'ai_failed';

export interface IndustryDigest {
  id: string;
  createdAt: string;
  status: DigestStatus;
  model: string | null;
  headlinesRead: number;
  items: DigestItem[];
}

export interface IndustryNews {
  digest: IndustryDigest | null;
  /** No digest from the last 7 days. */
  stale: boolean;
  /** When Refresh will next be accepted; null means now. */
  nextRefreshAt: string | null;
}

/** Why the news could not be had. Worded by the screen, in the reader's language. */
export type NewsProblem =
  | { kind: 'sign-in' }
  | { kind: 'not-allowed' }
  | { kind: 'too-soon'; nextRefreshAt: string | null }
  | { kind: 'running' }
  | { kind: 'no-news' }
  | { kind: 'status'; status: number }
  | { kind: 'unreachable' };

export class NewsUnavailable extends Error {
  constructor(readonly problem: NewsProblem) {
    super(problem.kind);
  }
}

export function fetchIndustryNews(): Promise<IndustryNews> {
  return call('/insights/industry', { credentials: 'include' });
}

export function refreshIndustryNews(): Promise<IndustryNews> {
  return call('/insights/industry/refresh', { method: 'POST', credentials: 'include' });
}

/** The link if it is plain http(s), else null — so nothing else ever becomes a tap target. */
export function safeLink(link: string): string | null {
  try {
    const url = new URL(link);
    const plain = (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    return plain ? url.href : null;
  } catch {
    return null;
  }
}

async function call(path: string, init: RequestInit): Promise<IndustryNews> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch {
    throw new NewsUnavailable({ kind: 'unreachable' });
  }
  if (res.ok) {
    try {
      return readNews(await res.json());
    } catch {
      throw new NewsUnavailable({ kind: 'status', status: res.status });
    }
  }
  if (res.status === 401) throw new NewsUnavailable({ kind: 'sign-in' });
  if (res.status === 403) throw new NewsUnavailable({ kind: 'not-allowed' });
  if (res.status === 502) throw new NewsUnavailable({ kind: 'no-news' });
  if (res.status === 429) {
    const problem = await problemOf(res);
    if (problem?.code === 'refresh-running') throw new NewsUnavailable({ kind: 'running' });
    const next = typeof problem?.nextRefreshAt === 'string' ? problem.nextRefreshAt : null;
    throw new NewsUnavailable({ kind: 'too-soon', nextRefreshAt: next });
  }
  throw new NewsUnavailable({ kind: 'status', status: res.status });
}

/** `{"detail": {"problem": {"code": ...}}}`, the API's refusal shape. */
async function problemOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as { detail?: { problem?: Record<string, unknown> } };
    return body.detail?.problem ?? null;
  } catch {
    return null;
  }
}

/** The response, with any item whose link is not plain http(s) left out. */
function readNews(body: unknown): IndustryNews {
  const news = body as IndustryNews;
  const digest = news.digest
    ? { ...news.digest, items: (news.digest.items ?? []).filter((item) => safeLink(item.link) !== null) }
    : null;
  return { digest, stale: news.stale === true, nextRefreshAt: news.nextRefreshAt ?? null };
}
