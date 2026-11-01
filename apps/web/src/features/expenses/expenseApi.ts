import { businessDate, type ActionInput, type BillAction, type BillNotice, type BillStatus, type PaymentRecord, type WorkflowProblem } from '@linck/domain';
import type { BillCaptureRecord, ExpenseBill } from '@linck/mock';
import { API_BASE, apiFetch } from '../../auth/api.js';

/**
 * THE EXPENSE BILLS ON THE API, for live mode (VITE_API_URL set).
 *
 *   GET   /expenses                   every bill this person may read, newest first
 *   POST  /expenses/attachments       a scan of a bill ──▶ its id
 *   POST  /expenses                   a bill, keyed or from that scan and what was read off it
 *   PATCH /expenses/{id}              a correction, while nobody has signed it
 *   POST  /expenses/{id}/actions      one move along the approval chain
 *   POST  /expenses/actions/batch     one move for many bills
 *   POST  /whatsapp/imports           WhatsApp slips taken in as bills, each once
 *
 * (apps/api/app/api/expenses.py, whatsapp_imports.py.) The API answers in the
 * screens' own ExpenseBill shape, field for field, so `billFromApi` changes one
 * thing: the scan's address. The API gives it relative to itself, and it must
 * go through the API's base like every other request — `/api` in production,
 * behind Vercel's rewrite — never as a bare `/expenses/...` path, which would
 * be this app's own origin.
 *
 * The server applies the approval chain's rules itself and is the authority.
 * Every way a request can fail comes back here as a `BillProblem`: the API's
 * own refusal code where it gave one, else what this end can tell. The screen
 * words it (words.ts `problem`).
 *
 * No React here: these are plain functions, and the tests call them directly.
 */

/** Why a bill could not be read, saved or moved. Worded by the screen, never shown as a code. */
export type BillProblem =
  | WorkflowProblem
  /** The bill is not there: deleted from under us, or another company's. */
  | { code: 'bill-gone' }
  /** A value the API would not store. `field` is the request's name for it. */
  | { code: 'invalid'; field: string; reason: string }
  | { code: 'too-big' }
  | { code: 'wrong-file' }
  | { code: 'empty-file' }
  /** A second signature, refused even with a note: the company does not allow one. */
  | { code: 'signed-already' }
  /** The session ended and could not be renewed. The sign-in screen follows. */
  | { code: 'signed-out' }
  /** The API did not answer at all. */
  | { code: 'offline' }
  /** The API answered with a fault, or with something this app cannot read. */
  | { code: 'server'; status: number };

/** A refusal from the API, carried as the problem it means. */
export class BillRefused extends Error {
  constructor(readonly problem: BillProblem) {
    super(problem.code);
    this.name = 'BillRefused';
  }
}

/** Anything thrown on the way, as the problem a person is shown. */
export function problemOf(err: unknown): BillProblem {
  return err instanceof BillRefused ? err.problem : { code: 'server', status: 0 };
}

/* ------------------------------------------------------------ the mapping */

/**
 * ExpenseBillOut (apps/api/app/schemas/expenses.py). It is ExpenseBill already;
 * the type is restated so the mapping below names every field it carries over.
 */
export type ApiBill = ExpenseBill;

/** An address the API gave relative to itself, through the API's base. */
export function throughApi(base: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

export function billFromApi(row: ApiBill, base: string = API_BASE): ExpenseBill {
  const bill: ExpenseBill = {
    id: row.id,
    desk: row.desk,
    billNumber: row.billNumber,
    kind: row.kind,
    billDate: row.billDate,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    vendor: row.vendor,
    description: row.description,
    litres: row.litres,
    amount: row.amount,
    status: row.status,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt,
    siteId: row.siteId,
    provenance: row.provenance,
    attachment: row.attachment ? { ...row.attachment, url: throughApi(base, row.attachment.url) } : null,
    capture: row.capture,
    submittedById: row.submittedById ?? null,
    history: row.history ?? [],
    payment: row.payment ?? null,
  };
  // Absent, not undefined, on a bill that did not come in on WhatsApp — as the API sends it.
  if (row.source) bill.source = row.source;
  return bill;
}

/** The bills after a move: the changed ones replaced, new ones first. */
export function withBills(old: readonly ExpenseBill[], changed: readonly ExpenseBill[]): ExpenseBill[] {
  const fresh = new Map(changed.map((b) => [b.id, b] as const));
  const known = new Set(old.map((b) => b.id));
  return [...changed.filter((b) => !known.has(b.id)), ...old.map((b) => fresh.get(b.id) ?? b)];
}

/* ------------------------------------------------------------- refusals */

const STATUSES: readonly string[] = ['submitted', 'validated', 'approved', 'passed', 'paid', 'rejected', 'deleted'];
const ACTIONS: readonly string[] = ['validate', 'approve', 'pass', 'pay', 'reject', 'send_back', 'delete', 'restore'];

/** The API's refusal, `{"detail": {"problem": {"code": ...}}}`, as a problem this app words. */
function knownProblem(p: Record<string, unknown>, status: number): BillProblem {
  const text = (key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);
  switch (p.code) {
    case 'wrong-step': {
      // A correction refused once the bill is signed says `action: "correct"`;
      // the words name only the status, so any action is taken.
      const at = text('status');
      return at && STATUSES.includes(at) ? { code: 'wrong-step', status: at as BillStatus, action: (text('action') ?? 'validate') as BillAction } : server(status);
    }
    case 'needs-permission': {
      const permission = text('permission');
      return permission ? { code: 'needs-permission', permission } : server(status);
    }
    case 'only-step-owner':
      return { code: 'only-step-owner', step: (text('step') ?? 'validate') as BillAction };
    case 'needs-reason': {
      const action = text('action');
      return action && ACTIONS.includes(action) ? { code: 'needs-reason', action: action as BillAction } : server(status);
    }
    case 'utr-used':
      return { code: 'utr-used', utr: text('utr') ?? '' };
    case 'only-desk-deletes':
    case 'second-signature':
    case 'needs-payment':
    case 'bad-utr':
    case 'future-payment-date':
    case 'batch-second-signature':
      return { code: p.code };
    case 'bill-gone':
    case 'not-found':
      return { code: 'bill-gone' };
    case 'invalid':
      return { code: 'invalid', field: text('field') ?? '', reason: text('reason') ?? '' };
    case 'too-big':
      return { code: 'too-big' };
    case 'wrong-file':
      return { code: 'wrong-file' };
    case 'empty':
      return { code: 'empty-file' };
    default:
      return server(status);
  }
}

const server = (status: number): BillProblem => ({ code: 'server', status });

/** Why the API said no, from its response. */
export async function readProblem(res: Response): Promise<BillProblem> {
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
    // FastAPI's own check of the request's shape: [{loc: ["body", "amount"], ...}].
    const loc = (detail[0] as { loc?: unknown } | undefined)?.loc;
    const field = Array.isArray(loc) ? [...loc].reverse().find((part): part is string => typeof part === 'string' && part !== 'body') : undefined;
    return { code: 'invalid', field: field ?? '', reason: '' };
  }
  if (res.status === 404) return { code: 'bill-gone' };
  if (res.status === 413) return { code: 'too-big' };
  if (res.status === 415) return { code: 'wrong-file' };
  return server(res.status);
}

/* ------------------------------------------------------------- requests */

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

async function call<T>(path: string, init: RequestInit, read: (body: unknown) => T): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch (err) {
    // An aborted read (the screen went away) is not "offline": let it through as itself.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new BillRefused({ code: 'offline' });
  }
  if (!res.ok) throw new BillRefused(await readProblem(res));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new BillRefused(server(res.status));
  }
  return read(body);
}

/** The most bills one read brings, newest first: the API's own ceiling. */
export const BILLS_PER_READ = 2000;

export function fetchBills(signal?: AbortSignal): Promise<ExpenseBill[]> {
  return call(`/expenses?limit=${BILLS_PER_READ}`, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) }, (body) =>
    (body as ApiBill[]).map((row) => billFromApi(row)),
  );
}

export function postAction(billId: string, action: BillAction, input: ActionInput = {}): Promise<ExpenseBill> {
  const body = {
    action,
    note: input.note ?? null,
    ...(action === 'pay' && input.payment ? { payment: paymentBody(input.payment) } : {}),
  };
  return call(`/expenses/${encodeURIComponent(billId)}/actions`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, (b) =>
    billFromApi(b as ApiBill),
  );
}

/** What a batch did: the bills after the move, and the rupees moved. */
export interface BatchDone {
  done: ExpenseBill[];
  totalPaise: number;
}

export function postBatch(action: BillAction, ids: string[], payment?: PaymentRecord): Promise<BatchDone> {
  const body = { action, ids, ...(action === 'pay' && payment ? { payment: paymentBody(payment) } : {}) };
  return call('/expenses/actions/batch', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, (b) => {
    const out = b as { eligible: ApiBill[]; totalPaise: number };
    return { done: out.eligible.map((row) => billFromApi(row)), totalPaise: out.totalPaise };
  });
}

const paymentBody = (p: PaymentRecord) => ({ utr: p.utr, paidOn: p.paidOn, mode: p.mode });

/** A stored scan, before it is put on a bill. */
export interface StoredScan {
  id: string;
  fileName: string;
  mimeType: string;
  sizeKb: number;
}

export function uploadScan(file: File, desk: ExpenseBill['desk']): Promise<StoredScan> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('desk', desk);
  return call('/expenses/attachments', { method: 'POST', body: form }, (b) => b as StoredScan);
}

export function postBill(body: NewBillBody): Promise<ExpenseBill> {
  return call('/expenses', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, (b) => billFromApi(b as ApiBill));
}

export function patchBill(billId: string, body: CorrectionBody): Promise<ExpenseBill> {
  return call(`/expenses/${encodeURIComponent(billId)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, (b) =>
    billFromApi(b as ApiBill),
  );
}

/* ---------------------------------------------------------- what is sent */

/** One field of what capture read, as the API takes it: it works out the corrections itself. */
interface CaptureFieldBody {
  key: string;
  label: string;
  captured: string | null;
  confidence: 1 | 2 | 3 | null;
  value: string;
}

export interface CaptureBody {
  engine: string;
  capturedAt: string;
  fields: CaptureFieldBody[];
  warnings: BillNotice[];
}

/** ExpenseBillIn: a new bill. Who raised it, its status and provenance are the server's to say. */
export interface NewBillBody {
  desk: ExpenseBill['desk'];
  siteId: string;
  kind: ExpenseBill['kind'];
  billNumber: string;
  /** The bill's calendar date, YYYY-MM-DD. */
  billDate: string;
  vendor: string;
  description: string;
  vehicleId: string | null;
  driverId: string | null;
  litres: number | null;
  amount: string;
  attachmentId: string | null;
  capture: CaptureBody | null;
}

/** CorrectionIn. A field left out stays as it is. */
export interface CorrectionBody {
  billNumber?: string;
  billDate?: string;
  vendor?: string;
  litres?: number | null;
  amount?: string;
}

/** The API's limit on any one value read off a slip (CaptureFieldIn, the notices). */
const MAX_TEXT = 200;
const clip = (text: string) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);

/**
 * What capture read, as the API takes it. A reading's text is cut to the
 * API's limit, so one long line of a blurred photo cannot stop the bill
 * being saved; the words the person checked are the bill's own fields.
 */
export function captureBody(capture: BillCaptureRecord): CaptureBody {
  return {
    engine: capture.engine,
    capturedAt: capture.capturedAt,
    fields: capture.fields.map((f) => ({
      key: f.key,
      label: f.label.slice(0, 60) || f.key,
      captured: f.captured === null ? null : clip(f.captured),
      confidence: f.captured === null ? null : f.confidence,
      value: clip(f.value),
    })),
    warnings: capture.warnings.slice(0, 50).map((w) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(w)) out[k] = typeof v === 'string' ? clip(v) : v;
      return out as BillNotice;
    }),
  };
}

/** A bill the upload sheet made, as `POST /expenses` takes it, with its scan's id. */
export function newBillBody(bill: ExpenseBill, attachmentId: string | null): NewBillBody {
  return {
    desk: bill.desk,
    siteId: bill.siteId,
    kind: bill.kind,
    billNumber: bill.billNumber,
    // The IST calendar date the bill carries, not the UTC date of IST midnight.
    billDate: businessDate(bill.billDate),
    vendor: bill.vendor,
    description: bill.description,
    vehicleId: bill.vehicleId,
    driverId: bill.driverId,
    litres: bill.litres,
    amount: bill.amount,
    attachmentId,
    capture: bill.capture ? captureBody(bill.capture) : null,
  };
}

/** A correction, from the fields the detail sheet changed. What capture read stays the server's. */
export function correctionBody(patch: Partial<ExpenseBill>): CorrectionBody {
  const body: CorrectionBody = {};
  if (patch.billNumber !== undefined) body.billNumber = patch.billNumber;
  if (patch.billDate !== undefined) body.billDate = businessDate(patch.billDate);
  if (patch.vendor !== undefined) body.vendor = patch.vendor;
  if (patch.litres !== undefined) body.litres = patch.litres;
  if (patch.amount !== undefined) body.amount = patch.amount;
  return body;
}

/* ------------------------------------------------------------- WhatsApp */

/** ClaimIn (apps/api/app/schemas/whatsapp_imports.py): one slip, and the bill it becomes. */
export interface ImportClaimBody {
  claimKey: string;
  sender: string;
  postedAt: string;
  message: string;
  attachments: string[];
  bill: {
    siteId: string;
    vehicleId: string;
    driverId: string | null;
    billNumber: string;
    billDate: string;
    vendor: string;
    litres: number | null;
    amount: string;
    submittedBy: string;
    submittedById: string;
    attachmentId: string | null;
    capture: CaptureBody | null;
  };
}

export interface ImportBody {
  source: 'inbox' | 'export';
  via: string;
  inboxMessageIds: string[];
  claims: ImportClaimBody[];
}

/** What an import did: the bills it made, and the slips that were already in. */
export interface ImportDone {
  imported: ExpenseBill[];
  skipped: { claimKey: string; reason: Record<string, unknown> }[];
}

export function postImport(body: ImportBody): Promise<ImportDone> {
  return call('/whatsapp/imports', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, (b) => {
    const out = b as { imported: ApiBill[]; skipped: ImportDone['skipped'] };
    return { imported: out.imported.map((row) => billFromApi(row)), skipped: out.skipped };
  });
}
