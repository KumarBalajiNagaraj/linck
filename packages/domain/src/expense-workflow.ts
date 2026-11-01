/**
 * THE EXPENSE BILL APPROVAL CHAIN (LIN-14).
 *
 *   submitted ──validate──▶ validated ──approve──▶ approved ──pass──▶ passed ──pay──▶ paid
 *   (fleet or stores desk)   (fleet manager)        (director)         (accounts)       (accounts, UTR)
 *
 * plus: reject (with a reason, at any unpaid step), send back one step (with
 * a note), delete (only before anyone has signed, with a reason — the bill
 * stays on record as deleted), and restore a deleted bill.
 *
 * Rules kept here, once, so every screen and the API agree:
 *   - Each move needs exactly one permission, at the bill's site.
 *   - Every move is appended to the bill's history, which is never edited.
 *   - FOUR EYES: nobody should sign the same bill twice. A second signature
 *     by the same person goes through only with a written note, and is
 *     marked as an exception the director sees. A bulk action never carries
 *     an exception — such bills are left out of the batch, and it says why.
 *     (Accounts passing and then paying is one job, and is not an exception.)
 *   - Money is counted in whole paise.
 *
 * Pure functions: the caller supplies the clock and who is acting.
 */

export type BillStatus = 'submitted' | 'validated' | 'approved' | 'passed' | 'paid' | 'rejected' | 'deleted';
export type BillAction = 'validate' | 'approve' | 'pass' | 'pay' | 'reject' | 'send_back' | 'delete' | 'restore';
export type PaymentMode = 'NEFT' | 'RTGS' | 'IMPS' | 'UPI' | 'Cheque' | 'Cash';

export interface BillEvent {
  action: BillAction;
  from: BillStatus;
  to: BillStatus;
  /** Who acted — compared by id, shown by name. */
  byId: string;
  by: string;
  at: string;
  note: string | null;
  /** A second signature by someone who already signed this bill. */
  exception: boolean;
}

export interface PaymentRecord {
  utr: string;
  paidOn: string;
  mode: PaymentMode;
}

/** What the workflow needs of a bill. */
export interface WorkflowBill {
  id: string;
  status: BillStatus;
  desk: 'fleet' | 'stores';
  siteId: string;
  amount: string;
  litres: number | null;
  /** Who raised it; a driver on WhatsApp, or the manager who uploaded it. */
  submittedById?: string | null;
  submittedBy: string;
  history?: BillEvent[];
  payment?: PaymentRecord | null;
}

export interface Actor {
  id: string;
  name: string;
  /** Whether this person holds `permission` at `siteId`. */
  can: (permission: string, siteId: string) => boolean;
}

/**
 * Why a move cannot be made, or what it still needs, as a code and its values.
 * The screen words it in the reader's language (docs/WRITING.md).
 */
export type WorkflowProblem =
  /** The bill is not at a status this move applies to. */
  | { code: 'wrong-step'; status: BillStatus; action: BillAction }
  /** The person lacks `permission` at the bill's site. */
  | { code: 'needs-permission'; permission: string }
  /** Only whoever can take the current step can reject the bill now. */
  | { code: 'only-step-owner'; step: BillAction }
  /** Only the desk that raises these bills can delete one. */
  | { code: 'only-desk-deletes' }
  /** This person already signed the bill: a note is needed, and it is flagged. */
  | { code: 'second-signature' }
  | { code: 'needs-reason'; action: BillAction }
  | { code: 'needs-payment' }
  | { code: 'bad-utr' }
  | { code: 'utr-used'; utr: string }
  | { code: 'future-payment-date' }
  /** Left out of a batch: already signed by this person, so it goes one at a time. */
  | { code: 'batch-second-signature' };

/** The one signing step each status waits on, and the key it needs. */
const STEP: Partial<Record<BillStatus, { action: BillAction; to: BillStatus; permission: (b: WorkflowBill) => string }>> = {
  submitted: { action: 'validate', to: 'validated', permission: (b) => `${b.desk}.expense.validate` },
  validated: { action: 'approve', to: 'approved', permission: () => 'finance.expense.approve' },
  approved: { action: 'pass', to: 'passed', permission: () => 'finance.expense.pass' },
  passed: { action: 'pay', to: 'paid', permission: () => 'finance.expense.pay' },
};

const PREVIOUS: Partial<Record<BillStatus, BillStatus>> = { validated: 'submitted', approved: 'validated', passed: 'approved' };

/** The signing moves: the ones the four-eyes rule counts. */
const SIGNING: readonly BillAction[] = ['validate', 'approve', 'pass', 'pay'];

/**
 * Who has signed the bill as it stands: its submitter, then each signing move
 * still in force. Sending back one step undoes the last signature; restoring
 * a deleted bill starts it afresh. The history keeps every one regardless.
 */
export function signersOf(bill: WorkflowBill): { id: string; action: BillAction | 'submit' }[] {
  const chain: { id: string; action: BillAction }[] = [];
  for (const e of bill.history ?? []) {
    if (SIGNING.includes(e.action)) chain.push({ id: e.byId, action: e.action });
    else if (e.action === 'send_back') chain.pop();
    else if (e.action === 'restore') chain.length = 0;
  }
  return [...(bill.submittedById ? [{ id: bill.submittedById, action: 'submit' as const }] : []), ...chain];
}

export interface ActionOption {
  action: BillAction;
  /** False with the problem when the person cannot take it at all. */
  allowed: boolean;
  problem: WorkflowProblem | null;
  /** A note is required: rejecting, deleting, sending back, or any exception. */
  needsNote: boolean;
  /** Taking it would be a second signature by the same person. */
  exception: boolean;
}

function wouldRepeat(bill: WorkflowBill, actor: Actor, action: BillAction): boolean {
  const signers = signersOf(bill);
  // Accounts passes and pays as one job: paying after passing is not a second opinion being skipped.
  if (action === 'pay') return signers.some((s) => s.id === actor.id && s.action !== 'pass');
  return signers.some((s) => s.id === actor.id);
}

export function availableActions(bill: WorkflowBill, actor: Actor): ActionOption[] {
  const opts: ActionOption[] = [];
  const add = (action: BillAction, allowed: boolean, problem: WorkflowProblem | null, needsNote: boolean, exception = false) =>
    opts.push({ action, allowed, problem: allowed ? null : problem, needsNote: needsNote || exception, exception });

  const step = STEP[bill.status];
  if (step) {
    const permission = step.permission(bill);
    const may = actor.can(permission, bill.siteId);
    const repeat = may && wouldRepeat(bill, actor, step.action);
    add(step.action, may, { code: 'needs-permission', permission }, false, repeat);
    add('reject', may, { code: 'only-step-owner', step: step.action }, true);
    if (PREVIOUS[bill.status]) add('send_back', may, { code: 'needs-permission', permission }, true);
  }
  if (bill.status === 'submitted') {
    const mayDelete = actor.can(`${bill.desk}.expense.upload`, bill.siteId) || actor.can(`${bill.desk}.expense.validate`, bill.siteId);
    add('delete', mayDelete, { code: 'only-desk-deletes' }, true);
  }
  if (bill.status === 'deleted') {
    const permission = `${bill.desk}.expense.validate`;
    const may = actor.can(permission, bill.siteId);
    add('restore', may, { code: 'needs-permission', permission }, false);
  }
  return opts;
}

export interface ActionInput {
  note?: string | null;
  payment?: PaymentRecord;
  /** UTRs already used on other payments; a bank reference is never reused. */
  usedUtrs?: ReadonlySet<string>;
}

export class WorkflowError extends Error {
  constructor(readonly problem: WorkflowProblem) {
    // The message is for logs; people read the problem, worded by the screen.
    super(`${problem.code} ${JSON.stringify(problem)}`);
  }
}

const UTR = /^[A-Z0-9]{6,22}$/;

/** The bill after `action`, or a WorkflowError saying why it cannot be taken. */
export function applyAction<B extends WorkflowBill>(bill: B, action: BillAction, actor: Actor, at: string, input: ActionInput = {}): B {
  const option = availableActions(bill, actor).find((o) => o.action === action);
  if (!option) throw new WorkflowError({ code: 'wrong-step', status: bill.status, action });
  if (!option.allowed) throw new WorkflowError(option.problem ?? { code: 'wrong-step', status: bill.status, action });
  const note = input.note?.trim() || null;
  if (option.needsNote && !note) {
    throw new WorkflowError(option.exception ? { code: 'second-signature' } : { code: 'needs-reason', action });
  }

  let to: BillStatus;
  let payment = bill.payment ?? null;
  switch (action) {
    case 'validate':
    case 'approve':
    case 'pass':
      to = STEP[bill.status]!.to;
      break;
    case 'pay': {
      const p = input.payment;
      if (!p) throw new WorkflowError({ code: 'needs-payment' });
      const utr = p.utr.trim().toUpperCase();
      if (p.mode !== 'Cash' && !UTR.test(utr)) throw new WorkflowError({ code: 'bad-utr' });
      if (p.mode !== 'Cash' && input.usedUtrs?.has(utr)) throw new WorkflowError({ code: 'utr-used', utr });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.paidOn) || p.paidOn > at.slice(0, 10)) throw new WorkflowError({ code: 'future-payment-date' });
      payment = { ...p, utr };
      to = 'paid';
      break;
    }
    case 'reject':
      to = 'rejected';
      break;
    case 'send_back':
      to = PREVIOUS[bill.status]!;
      break;
    case 'delete':
      to = 'deleted';
      break;
    case 'restore':
      to = 'submitted';
      break;
  }
  const event: BillEvent = { action, from: bill.status, to, byId: actor.id, by: actor.name, at, note, exception: option.exception };
  return { ...bill, status: to, payment, history: [...(bill.history ?? []), event] };
}


export interface BatchPlan<B extends WorkflowBill> {
  action: BillAction;
  eligible: B[];
  skipped: { bill: B; problem: WorkflowProblem }[];
  /** Whole paise. */
  totalPaise: number;
  litres: number;
}

/**
 * What a bulk action would do, before it is done. Only bills the person may
 * take the action on WITHOUT an exception go in; everything else is listed
 * with its reason, so "approve all" never quietly includes a bill someone
 * signed twice, and never quietly drops one either.
 */
export function planBatch<B extends WorkflowBill>(bills: readonly B[], action: BillAction, actor: Actor): BatchPlan<B> {
  const eligible: B[] = [];
  const skipped: { bill: B; problem: WorkflowProblem }[] = [];
  for (const bill of bills) {
    const o = availableActions(bill, actor).find((x) => x.action === action);
    if (!o) skipped.push({ bill, problem: { code: 'wrong-step', status: bill.status, action } });
    else if (!o.allowed) skipped.push({ bill, problem: o.problem ?? { code: 'wrong-step', status: bill.status, action } });
    else if (o.exception) skipped.push({ bill, problem: { code: 'batch-second-signature' } });
    else eligible.push(bill);
  }
  return {
    action,
    eligible,
    skipped,
    totalPaise: eligible.reduce((s, b) => s + Math.round(Number.parseFloat(b.amount) * 100), 0),
    litres: eligible.reduce((s, b) => s + Math.round((b.litres ?? 0) * 100), 0) / 100,
  };
}

/** Every exception in the history of these bills: the director's list of second signatures. */
export function exceptionsIn<B extends WorkflowBill>(bills: readonly B[]): { bill: B; event: BillEvent }[] {
  return bills.flatMap((bill) => (bill.history ?? []).filter((e) => e.exception).map((event) => ({ bill, event })));
}
