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

export const STATUS_LABEL: Record<BillStatus, string> = {
  submitted: 'Awaiting validation',
  validated: 'Awaiting director',
  approved: 'Awaiting accounts',
  passed: 'Passed for payment',
  paid: 'Paid',
  rejected: 'Rejected',
  deleted: 'Deleted',
};

export const ACTION_LABEL: Record<BillAction, string> = {
  validate: 'Validate',
  approve: 'Approve',
  pass: 'Pass for payment',
  pay: 'Record payment',
  reject: 'Reject',
  send_back: 'Send back',
  delete: 'Delete',
  restore: 'Restore',
};

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
  /** False with a reason when the person cannot take it at all. */
  allowed: boolean;
  reason: string | null;
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
  const add = (action: BillAction, allowed: boolean, reason: string | null, needsNote: boolean, exception = false) =>
    opts.push({ action, allowed, reason, needsNote: needsNote || exception, exception });

  const step = STEP[bill.status];
  if (step) {
    const permission = step.permission(bill);
    const may = actor.can(permission, bill.siteId);
    const repeat = may && wouldRepeat(bill, actor, step.action);
    add(step.action, may, may ? null : `Needs ${permission} at this site.`, false, repeat);
    add('reject', may, may ? null : `Only whoever can ${ACTION_LABEL[step.action].toLowerCase()} it can reject it now.`, true);
    if (PREVIOUS[bill.status]) add('send_back', may, may ? null : `Needs ${permission} at this site.`, true);
  }
  if (bill.status === 'submitted') {
    const mayDelete = actor.can(`${bill.desk}.expense.upload`, bill.siteId) || actor.can(`${bill.desk}.expense.validate`, bill.siteId);
    add('delete', mayDelete, mayDelete ? null : 'Only the desk that raises these bills can delete one.', true);
  }
  if (bill.status === 'deleted') {
    const may = actor.can(`${bill.desk}.expense.validate`, bill.siteId);
    add('restore', may, may ? null : `Needs ${bill.desk}.expense.validate at this site.`, false);
  }
  return opts;
}

export interface ActionInput {
  note?: string | null;
  payment?: PaymentRecord;
  /** UTRs already used on other payments; a bank reference is never reused. */
  usedUtrs?: ReadonlySet<string>;
}

export class WorkflowError extends Error {}

const UTR = /^[A-Z0-9]{6,22}$/;

/** The bill after `action`, or a WorkflowError saying why it cannot be taken. */
export function applyAction<B extends WorkflowBill>(bill: B, action: BillAction, actor: Actor, at: string, input: ActionInput = {}): B {
  const option = availableActions(bill, actor).find((o) => o.action === action);
  if (!option) throw new WorkflowError(`A bill that is ${STATUS_LABEL[bill.status].toLowerCase()} cannot be ${pastTense(action)}.`);
  if (!option.allowed) throw new WorkflowError(option.reason ?? 'Not allowed.');
  const note = input.note?.trim() || null;
  if (option.needsNote && !note) {
    throw new WorkflowError(
      option.exception
        ? `You have already signed this bill. Signing it again needs a note saying why, and is shown to the director.`
        : `${ACTION_LABEL[action]} needs a reason.`,
    );
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
      if (!p) throw new WorkflowError('Record the UTR, the date and how it was paid.');
      const utr = p.utr.trim().toUpperCase();
      if (p.mode !== 'Cash' && !UTR.test(utr)) throw new WorkflowError('The UTR is 6 to 22 letters and digits, as the bank shows it.');
      if (p.mode !== 'Cash' && input.usedUtrs?.has(utr)) throw new WorkflowError(`UTR ${utr} is already recorded against another payment.`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.paidOn) || p.paidOn > at.slice(0, 10)) throw new WorkflowError('The payment date cannot be after today.');
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

function pastTense(action: BillAction): string {
  return {
    validate: 'validated',
    approve: 'approved',
    pass: 'passed for payment',
    pay: 'paid',
    reject: 'rejected',
    send_back: 'sent back',
    delete: 'deleted',
    restore: 'restored',
  }[action];
}

export interface BatchPlan<B extends WorkflowBill> {
  action: BillAction;
  eligible: B[];
  skipped: { bill: B; reason: string }[];
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
  const skipped: { bill: B; reason: string }[] = [];
  for (const bill of bills) {
    const o = availableActions(bill, actor).find((x) => x.action === action);
    if (!o) skipped.push({ bill, reason: `It is ${STATUS_LABEL[bill.status].toLowerCase()}.` });
    else if (!o.allowed) skipped.push({ bill, reason: o.reason ?? 'Not allowed.' });
    else if (o.exception) skipped.push({ bill, reason: 'You already signed it; it needs your note, one at a time.' });
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
