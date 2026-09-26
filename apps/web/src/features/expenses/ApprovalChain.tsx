import { useState } from 'react';
import {
  ACTION_LABEL,
  availableActions,
  businessDate,
  formatDateTime,
  formatINR,
  planBatch,
  type BillAction,
  type PaymentMode,
  type PaymentRecord,
} from '@linck/domain';
import { NOW, type ExpenseBill } from '@linck/mock';
import { Button, Modal, Note, Rail, SheetSection, StatusStamp } from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { actorFor, useExpenses } from './expenseStore.js';

/**
 * THE APPROVAL CHAIN, ON SCREEN (LIN-14).
 *
 * One bill: the moves this person may make on it, with the amount in the
 * button, a reason box where one is owed, and the payment's UTR where
 * accounts records it. Every move lands in the bill's history below.
 *
 * Many bills: "Approve all" (or validate, pass, pay) for everything in the
 * current step that this person may sign without an exception — the confirm
 * box states the count, the exact rupees and litres, and every bill left out
 * with its reason.
 */

const MODES: PaymentMode[] = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Cash'];
const FIELD_CLASS = 'h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[13px]';
const FIELD_STYLE: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

/** The one signing move a bill in each status waits on. */
export const STEP_ACTION: Partial<Record<ExpenseBill['status'], BillAction>> = {
  submitted: 'validate',
  validated: 'approve',
  approved: 'pass',
  passed: 'pay',
};

const PRIMARY: BillAction[] = ['validate', 'approve', 'pass', 'pay', 'restore'];
const rupees = (paise: number) => formatINR(paise / 100);

function PaymentFields({ value, onChange }: { value: PaymentRecord; onChange: (p: PaymentRecord) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
          Paid by
        </span>
        <select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as PaymentMode })} className={FIELD_CLASS} style={FIELD_STYLE}>
          {MODES.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
          {value.mode === 'Cheque' ? 'Cheque number' : 'UTR'}
        </span>
        <input
          value={value.utr}
          onChange={(e) => onChange({ ...value, utr: e.target.value })}
          disabled={value.mode === 'Cash'}
          className={`${FIELD_CLASS} font-id`}
          style={FIELD_STYLE}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
          Paid on
        </span>
        <input type="date" max={businessDate(NOW)} value={value.paidOn} onChange={(e) => onChange({ ...value, paidOn: e.target.value })} className={FIELD_CLASS} style={FIELD_STYLE} />
      </label>
    </div>
  );
}

const blankPayment = (): PaymentRecord => ({ utr: '', paidOn: businessDate(NOW), mode: 'NEFT' });

/** The moves this person may make on one bill. */
export function ChainActions({ bill }: { bill: ExpenseBill }) {
  const { persona } = useApp();
  const act = useExpenses((s) => s.act);
  const actor = actorFor(persona);
  const options = availableActions(bill, actor);
  const [pending, setPending] = useState<BillAction | null>(null);
  const [note, setNote] = useState('');
  const [payment, setPayment] = useState<PaymentRecord>(blankPayment);
  const [problem, setProblem] = useState<string | null>(null);

  const allowed = options.filter((o) => o.allowed);
  if (allowed.length === 0) {
    const waiting = options.find((o) => PRIMARY.includes(o.action));
    return waiting ? (
      <SheetSection caption="Next step">
        <Note>
          {ACTION_LABEL[waiting.action]} is someone else&apos;s step. {waiting.reason}
        </Note>
      </SheetSection>
    ) : null;
  }

  const chosen = options.find((o) => o.action === pending) ?? null;
  const submit = () => {
    if (!chosen) return;
    const why = act(bill.id, chosen.action, actor, { note, ...(chosen.action === 'pay' ? { payment } : {}) });
    setProblem(why);
    if (!why) {
      setPending(null);
      setNote('');
    }
  };
  const amount = formatINR(bill.amount);

  return (
    <SheetSection caption="Your step">
      <div className="flex flex-wrap gap-2">
        {allowed.map((o) => (
          <Button
            key={o.action}
            variant={PRIMARY.includes(o.action) ? 'primary' : o.action === 'reject' || o.action === 'delete' ? 'destructive' : 'secondary'}
            onClick={() => {
              setProblem(null);
              if (!o.needsNote && o.action !== 'pay') {
                setProblem(act(bill.id, o.action, actor));
                return;
              }
              setPending(o.action);
            }}
          >
            {PRIMARY.includes(o.action) && o.action !== 'restore' ? `${ACTION_LABEL[o.action]} ${amount}` : ACTION_LABEL[o.action]}
          </Button>
        ))}
      </div>
      {chosen ? (
        <div className="mt-3 flex flex-col gap-3">
          {chosen.exception ? (
            <p className="relative pl-3 text-[13px]" style={{ color: 'var(--status-attention)' }}>
              <Rail status="attention" />
              You have already signed this bill. You can still {ACTION_LABEL[chosen.action].toLowerCase()} it, with a note saying why; the
              director sees it as an exception.
            </p>
          ) : null}
          {chosen.action === 'pay' ? <PaymentFields value={payment} onChange={setPayment} /> : null}
          {chosen.needsNote || chosen.action === 'pay' ? (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
                {chosen.needsNote ? 'Reason (required)' : 'Note (optional)'}
              </span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full p-2 text-[14px]" style={FIELD_STYLE} />
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button variant={chosen.action === 'reject' || chosen.action === 'delete' ? 'destructive' : 'primary'} onClick={submit}>
              {ACTION_LABEL[chosen.action]}
            </Button>
            <Button onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {problem ? (
        <p className="relative mt-2 pl-3 text-[12px]" style={{ color: 'var(--status-critical)' }}>
          <Rail status="critical" />
          {problem}
        </p>
      ) : null}
    </SheetSection>
  );
}

/** Every move on the bill, oldest first, as recorded. */
export function BillHistory({ bill }: { bill: ExpenseBill }) {
  const events = bill.history ?? [];
  return (
    <SheetSection caption="History">
      <ol className="flex flex-col gap-2 text-[13px]">
        <li style={{ color: 'var(--text-secondary)' }}>
          Raised by {bill.submittedBy} · {formatDateTime(bill.submittedAt)}
          {bill.source ? ` · on WhatsApp (${bill.source.via})` : ''}
        </li>
        {events.map((e, i) => (
          <li key={i} className="flex flex-col">
            <span className="flex flex-wrap items-center gap-2">
              <span style={{ color: 'var(--text-primary)' }}>
                {ACTION_LABEL[e.action]} by {e.by}
              </span>
              <span style={{ color: 'var(--text-tertiary)' }}>{formatDateTime(e.at)}</span>
              {e.exception ? <StatusStamp status="attention" label="Second signature" /> : null}
            </span>
            {e.note ? <span style={{ color: 'var(--text-secondary)' }}>“{e.note}”</span> : null}
          </li>
        ))}
        {events.length === 0 && bill.status !== 'submitted' ? (
          <li style={{ color: 'var(--text-tertiary)' }}>Signed before Linck kept a history for it.</li>
        ) : null}
      </ol>
      {bill.payment ? (
        <p className="mt-2 text-[13px]" style={{ color: 'var(--text-primary)' }}>
          Paid {bill.payment.mode}
          {bill.payment.utr ? <> · UTR <span className="font-id">{bill.payment.utr}</span></> : null} · {bill.payment.paidOn.split('-').reverse().join('-')}
        </p>
      ) : null}
    </SheetSection>
  );
}

/**
 * "Do this step for all of them": everything in the current step that this
 * person may sign cleanly, with the exact amount, and what is left out.
 */
export function BatchBar({ bills, status }: { bills: ExpenseBill[]; status: ExpenseBill['status'] | null }) {
  const { persona } = useApp();
  const actMany = useExpenses((s) => s.actMany);
  const allBills = useExpenses((s) => s.bills);
  const [open, setOpen] = useState(false);
  const [payment, setPayment] = useState<PaymentRecord>(blankPayment);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const action = status ? STEP_ACTION[status] : undefined;
  if (!action) return done ? <p className="px-6 pt-2 text-[13px]" style={{ color: 'var(--status-ready)' }}>{done}</p> : null;

  const actor = actorFor(persona);
  const plan = planBatch(bills, action, actor);
  if (plan.eligible.length === 0 && !done) return null;

  const confirm = () => {
    if (action === 'pay') {
      const utr = payment.utr.trim().toUpperCase();
      const clash = allBills.some((b) => b.payment?.utr === utr);
      if (payment.mode !== 'Cash' && (!/^[A-Z0-9]{6,22}$/.test(utr) || clash)) {
        setProblem(clash ? `UTR ${utr} is already recorded against another payment.` : 'The UTR is 6 to 22 letters and digits, as the bank shows it.');
        return;
      }
    }
    const n = actMany(plan, actor, action === 'pay' ? { payment } : {});
    setDone(`${n} bills ${action === 'pay' ? 'paid' : action === 'pass' ? 'passed for payment' : `${action}d`}, ${rupees(plan.totalPaise)} in all.`);
    setProblem(null);
    setOpen(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3" style={{ background: 'var(--surface-sunken)', borderBottom: '1px solid var(--border-subtle)' }}>
        <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
          {done ?? (
            <>
              {plan.eligible.length} bills here wait on you · {rupees(plan.totalPaise)}
              {plan.litres > 0 ? ` · ${plan.litres.toLocaleString('en-IN')} L` : ''}
              {plan.skipped.length > 0 ? ` · ${plan.skipped.length} left for one at a time` : ''}
            </>
          )}
        </span>
        {plan.eligible.length > 0 ? (
          <Button variant="primary" onClick={() => setOpen(true)}>
            {ACTION_LABEL[action]} all {plan.eligible.length} · {rupees(plan.totalPaise)}
          </Button>
        ) : null}
      </div>
      {/* A plain modal, not ConfirmModal: a bad UTR must keep the box open with the reason. */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${ACTION_LABEL[action]} ${plan.eligible.length} bills`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={confirm}>
              {ACTION_LABEL[action]} {plan.eligible.length} · {rupees(plan.totalPaise)}
            </Button>
          </>
        }
      >
        <div className="text-[14px]" style={{ color: 'var(--text-primary)' }}>
            <span className="block">
              {plan.eligible.length} bills, {rupees(plan.totalPaise)}
              {plan.litres > 0 ? `, ${plan.litres.toLocaleString('en-IN')} litres of diesel` : ''}, move on together. Each is logged in its own
              history under your name.
            </span>
            {action === 'pay' ? (
              <span className="mt-3 block">
                <PaymentFields value={payment} onChange={setPayment} />
                <span className="mt-1 block text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  One transfer: the same reference is recorded on every bill in it.
                </span>
              </span>
            ) : null}
            {problem ? (
              <span className="mt-2 block text-[12px]" style={{ color: 'var(--status-critical)' }}>
                {problem}
              </span>
            ) : null}
            {plan.skipped.length > 0 ? (
              <span className="mt-3 block" style={{ color: 'var(--text-tertiary)' }}>
                Left out: {plan.skipped.map((s) => `${s.bill.billNumber || s.bill.id} — ${s.reason}`).join('; ')}
              </span>
            ) : null}
        </div>
      </Modal>
    </>
  );
}
