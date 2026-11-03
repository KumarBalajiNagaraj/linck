import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { can, formatDate, GST_STATES } from '@linck/domain';
import type { PlInvoiceDetail, PlInvoicePatch } from '@linck/mock';
import { Button, ConfirmModal, EmptyState, Modal, PageHeader, Section } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { now } from '../expenses/bills.js';
import { sheetPath } from './plStore.js';
import { CTRL, FIELD_BOX } from './PlParts.js';
import { useInvoice, useInvoiceMoves } from './invoices.js';
import { INVOICE_CANCEL, INVOICE_READ, INVOICE_WRITE, invoicesBase, RECEIVE, type InvoiceProblem } from './invoiceStore.js';
import { inrSigned, invoiceProblemText, stateName } from './invoiceText.js';
import { InvoiceStamp } from './InvoiceStamp.js';
import { invoiceWords } from './invoiceWords.js';
import { InvoicePrint, TaxInvoice } from './TaxInvoice.js';
import { sheetWords } from './words.js';

/**
 * One trip invoice (LIN-27): the tax invoice as it prints, and what may still
 * be done with it. A draft can be told its place of supply, addresses and a
 * note, then issued (it takes its number) or deleted; an issued one can only
 * be cancelled, with a reason, and printed; its money received is counted
 * against it from the payments on its trips.
 */
export function InvoicePage() {
  const w = useWords(invoiceWords);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const base = invoicesBase(pathname);
  const { invoiceId } = useParams({ strict: false }) as { invoiceId?: string };
  const { persona } = useApp();
  const read = useInvoice(invoiceId);
  const moves = useInvoiceMoves();
  const detail = read.data;
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<'issue' | 'delete' | 'cancel' | null>(null);
  const [printing, setPrinting] = useState(false);
  const closePrint = useCallback(() => setPrinting(false), []);
  useEffect(() => setProblem(null), [invoiceId]);

  // Live only: on its way, or not read for a reason other than its not being there.
  if (read.state === 'loading') return <EmptyState fact={w.page.loading} />;
  if (read.state === 'failed' && read.problem && read.problem.code !== 'invoice-gone' && read.problem.code !== 'needs-permission') {
    return <EmptyState fact={w.page.failed} because={invoiceProblemText(read.problem, w)} action={{ label: w.retry, onClick: read.retry }} />;
  }
  if (!detail || !can(persona.grants, INVOICE_READ, { siteId: detail.siteId })) {
    return (
      <div className="pl-screen">
        <PageHeader eyebrow={w.page.eyebrow} title={w.page.notFound} actions={<Button onClick={() => void navigate({ to: base })}>{w.page.back}</Button>} />
        <EmptyState fact={w.page.notFound} because={w.page.notFoundWhy} action={{ label: w.page.back, onClick: () => void navigate({ to: base }) }} />
      </div>
    );
  }

  const id = detail.id;
  const at = { siteId: detail.siteId };
  const canWrite = can(persona.grants, INVOICE_WRITE, at);
  const canCancel = can(persona.grants, INVOICE_CANCEL, at);
  const canReceive = can(persona.grants, RECEIVE, at);
  /** A move's answer: the refusal shown under the header, or nothing. True when it went through. */
  const done = async (answer: Promise<InvoiceProblem | null>): Promise<boolean> => {
    const refused = await answer;
    setProblem(refused ? invoiceProblemText(refused, w) : null);
    return refused === null;
  };
  const title = detail.invoiceNumber ? w.page.title(detail.invoiceNumber) : w.page.draftTitle;
  const by =
    detail.status === 'cancelled' && detail.cancelledBy && detail.cancelledAt
      ? w.page.cancelledBy(detail.cancelledBy, formatDate(detail.cancelledAt))
      : detail.issuedBy && detail.issuedAt
        ? w.page.issuedBy(detail.issuedBy, formatDate(detail.issuedAt))
        : w.page.made(detail.createdBy, formatDate(detail.createdAt));
  const note = detail.status === 'draft' ? w.page.draftNote : detail.status === 'issued' ? w.page.issuedNote : w.page.cancelledNote(detail.cancelReason ?? '');

  return (
    <div className="pl-screen pb-6">
      <PageHeader
        eyebrow={w.page.eyebrow}
        title={title}
        meta={
          <span className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            <InvoiceStamp row={detail} />
            <span>{by}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => void navigate({ to: base })}>{w.page.back}</Button>
            <Button onClick={() => setPrinting(true)}>{w.page.print}</Button>
            {detail.status === 'draft' && canWrite && (
              <>
                <Button variant="destructive" onClick={() => setAsking('delete')}>
                  {w.page.deleteDraft}
                </Button>
                <Button variant="primary" onClick={() => setAsking('issue')}>
                  {w.page.issue}
                </Button>
              </>
            )}
            {detail.status === 'issued' && canCancel && (
              <Button variant="destructive" onClick={() => setAsking('cancel')}>
                {w.page.cancel}
              </Button>
            )}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 px-4 py-4 md:px-6">
          <p className="pb-3 text-[13px]" style={{ color: problem ? 'var(--status-critical)' : 'var(--text-secondary)' }} role={problem ? 'alert' : undefined}>
            {problem ?? note}
          </p>
          <TaxInvoice invoice={detail} />
        </div>
        <aside className="min-w-0 lg:self-start" style={{ borderLeft: '1px solid var(--border-subtle)' }}>
          {detail.status === 'draft' && canWrite && <DraftForm key={id} invoice={detail} onSave={(patch) => done(moves.patch.run({ id, patch }))} />}
          <TaxNote invoice={detail} />
          <Money
            invoice={detail}
            canReceive={canReceive}
            busy={moves.match.busy || moves.unmatch.busy}
            onMatch={(paymentId) => void done(moves.match.run({ id, paymentId }))}
            onUndo={(receiptId) => void done(moves.unmatch.run({ id, receiptId }))}
          />
          <Trips invoice={detail} />
        </aside>
      </div>

      <ConfirmModal
        open={asking === 'issue'}
        onClose={() => setAsking(null)}
        onConfirm={() => void done(moves.issue.run(id))}
        title={w.page.confirmIssue.title}
        consequence={w.page.confirmIssue.consequence(detail.seller.gstin)}
        confirmLabel={w.page.confirmIssue.yes}
        backLabel={w.page.confirmIssue.back}
      />
      <ConfirmModal
        open={asking === 'delete'}
        onClose={() => setAsking(null)}
        onConfirm={() => {
          void done(moves.remove.run(id)).then((gone) => {
            if (gone) void navigate({ to: base });
          });
        }}
        title={w.page.confirmDelete.title}
        consequence={w.page.confirmDelete.consequence}
        confirmLabel={w.page.confirmDelete.yes}
        backLabel={w.page.confirmDelete.back}
        destructive
      />
      <CancelModal
        open={asking === 'cancel'}
        number={detail.invoiceNumber ?? ''}
        onClose={() => setAsking(null)}
        onCancel={(reason) => void done(moves.cancel.run({ id, reason }))}
      />
      {printing && <InvoicePrint invoice={detail} printedOn={formatDate(now())} onClose={closePrint} />}
    </div>
  );
}

const STATE_CODES = Object.keys(GST_STATES).sort();

/** What a draft may still be told before it is issued. */
function DraftForm({ invoice, onSave }: { invoice: PlInvoiceDetail; onSave: (patch: PlInvoicePatch) => Promise<boolean> }) {
  const w = useWords(invoiceWords);
  const [pos, setPos] = useState(invoice.placeOfSupply);
  const [billTo, setBillTo] = useState(invoice.buyer.address);
  const [shipTo, setShipTo] = useState(invoice.shipTo?.address ?? '');
  const [notes, setNotes] = useState(invoice.notes);
  const [saved, setSaved] = useState(false);
  const patch: PlInvoicePatch = {
    ...(pos !== invoice.placeOfSupply ? { placeOfSupply: pos } : {}),
    ...(billTo.trim() !== invoice.buyer.address ? { buyerAddress: billTo } : {}),
    ...(shipTo.trim() !== (invoice.shipTo?.address ?? '') ? { shipToAddress: shipTo } : {}),
    ...(notes.trim() !== invoice.notes ? { notes } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  const label = (text: string) => (
    <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
      {text}
    </span>
  );
  return (
    <Section caption={w.page.edit.title}>
      <div className="flex flex-col gap-3 px-4 pb-4 md:px-6">
        <label className="flex flex-col gap-1">
          {label(w.page.edit.placeOfSupply)}
          <select className={CTRL} style={FIELD_BOX} value={pos} onChange={(e) => (setPos(e.target.value), setSaved(false))}>
            {STATE_CODES.map((code) => (
              <option key={code} value={code}>
                {`${stateName(w, code)} (${code})`}
              </option>
            ))}
          </select>
          <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
            {w.page.pos[pos === invoice.placeOfSupply ? invoice.posBasis : 'chosen']}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          {label(w.page.edit.billTo)}
          <textarea className="min-h-[64px] w-full px-2 py-1.5 text-[14px]" style={FIELD_BOX} maxLength={300} value={billTo} onChange={(e) => (setBillTo(e.target.value), setSaved(false))} />
        </label>
        <label className="flex flex-col gap-1">
          {label(w.page.edit.shipTo)}
          <textarea className="min-h-[64px] w-full px-2 py-1.5 text-[14px]" style={FIELD_BOX} maxLength={300} value={shipTo} onChange={(e) => (setShipTo(e.target.value), setSaved(false))} />
        </label>
        <label className="flex flex-col gap-1">
          {label(w.page.edit.notes)}
          <textarea className="min-h-[48px] w-full px-2 py-1.5 text-[14px]" style={FIELD_BOX} maxLength={500} value={notes} onChange={(e) => (setNotes(e.target.value), setSaved(false))} />
        </label>
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!changed} onClick={() => void onSave(patch).then(setSaved)}>
            {w.page.edit.save}
          </Button>
          {saved && !changed && (
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {w.page.edit.saved}
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}

function TaxNote({ invoice }: { invoice: PlInvoiceDetail }) {
  const w = useWords(invoiceWords);
  return (
    <p className="px-4 pt-5 text-[13px] md:px-6" style={{ color: 'var(--text-secondary)' }}>
      {w.page.tax[invoice.supplyType]} · {stateName(w, invoice.placeOfSupply)}
    </p>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[14px]">
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className={`num tabular-nums ${strong ? 'font-semibold' : ''}`}>{inrSigned(value)}</span>
    </div>
  );
}

/** What the invoice has received, from which payments on its trips, and what is still due. */
function Money({
  invoice,
  canReceive,
  busy,
  onMatch,
  onUndo,
}: {
  invoice: PlInvoiceDetail;
  canReceive: boolean;
  /** Live: a match on its way; the buttons wait. Never in the demo. */
  busy: boolean;
  onMatch: (paymentId: string | null) => void;
  onUndo: (receiptId: string) => void;
}) {
  const w = useWords(invoiceWords);
  const modes = useWords(sheetWords).modes;
  const m = w.page.money;
  const where = (r: { tripNumber: string | null; sheetNumber: string }) => (r.tripNumber ? m.onTrip(r.tripNumber) : m.onSheet(r.sheetNumber));
  const due = invoice.status === 'issued' && !invoice.due.startsWith('-') && invoice.due !== '0.00';
  return (
    <Section caption={m.title}>
      <div className="flex flex-col px-4 pb-4 md:px-6">
        <Figure label={m.total} value={invoice.status === 'cancelled' ? '0.00' : invoice.total} />
        <Figure label={m.received} value={invoice.received} />
        <Figure label={m.due} value={invoice.due} strong />
        {invoice.status === 'draft' && (
          <p className="pt-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
            {m.afterIssue}
          </p>
        )}
        {invoice.status === 'cancelled' && (
          <p className="pt-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
            {m.cancelled}
          </p>
        )}
        {invoice.status === 'issued' && (
          <>
            <p className="pt-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {m.matched}
            </p>
            {invoice.receipts.length === 0 && (
              <p className="py-1 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                {m.none}
              </p>
            )}
            <ul className="flex flex-col">
              {invoice.receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-[13px]" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <span className="min-w-0">
                    <span className="num tabular-nums font-semibold">{inrSigned(r.amount)}</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {' · '}
                      {formatDate(r.paidOn)} · {modes[r.mode]}
                      {r.reference ? ` ${r.reference}` : ''} · {where(r)}
                    </span>
                    {r.amount !== r.paymentAmount && (
                      <span className="block" style={{ color: 'var(--text-tertiary)' }}>
                        {m.of(inrSigned(r.amount), inrSigned(r.paymentAmount))}
                      </span>
                    )}
                    <span className="block" style={{ color: 'var(--text-tertiary)' }}>
                      {m.by(r.matchedBy)}
                    </span>
                  </span>
                  {canReceive && (
                    <Button disabled={busy} onClick={() => onUndo(r.id)}>
                      {m.undo}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {invoice.unmatched.length > 0 && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {m.unmatched}
                  </span>
                  {canReceive && due && (
                    <Button disabled={busy} onClick={() => onMatch(null)}>
                      {m.matchAll}
                    </Button>
                  )}
                </div>
                <ul className="flex flex-col">
                  {invoice.unmatched.map((u) => (
                    <li key={u.paymentId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-[13px]" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <span className="min-w-0">
                        <span className="num tabular-nums">{inrSigned(u.paymentAmount)}</span>
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {' · '}
                          {formatDate(u.paidOn)} · {modes[u.mode]}
                          {u.reference ? ` ${u.reference}` : ''} · {where(u)}
                        </span>
                        {u.free !== u.paymentAmount && (
                          <span className="block" style={{ color: 'var(--text-tertiary)' }}>
                            {m.free(inrSigned(u.free))}
                          </span>
                        )}
                      </span>
                      {canReceive && due && (
                        <Button disabled={busy} onClick={() => onMatch(u.paymentId)}>
                          {m.match}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="pt-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {m.ruleNote}
            </p>
          </>
        )}
      </div>
    </Section>
  );
}

/** The trips it bills, each a way back to its trip sheet. */
function Trips({ invoice }: { invoice: PlInvoiceDetail }) {
  const w = useWords(invoiceWords);
  const seen = new Map<string, { tripNumber: string; date: string; sheetId: string | null; sheetNumber: string }>();
  for (const l of invoice.lines) if (!seen.has(l.tripNumber)) seen.set(l.tripNumber, { tripNumber: l.tripNumber, date: l.tripDate, sheetId: l.sheetId, sheetNumber: l.sheetNumber });
  return (
    <Section caption={w.page.trips}>
      <ul className="flex flex-col px-4 pb-6 md:px-6">
        {[...seen.values()].map((t) => (
          <li key={t.tripNumber} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-[13px]" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <span>
              <span className="font-id">{t.tripNumber}</span>
              <span style={{ color: 'var(--text-tertiary)' }}> · {formatDate(t.date)}</span>
            </span>
            {t.sheetId ? (
              <Link to={sheetPath(t.sheetId)} className="underline" style={{ color: 'var(--brand)' }}>
                {t.sheetNumber}
              </Link>
            ) : (
              <span style={{ color: 'var(--text-tertiary)' }}>{t.sheetNumber}</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Cancel with a reason, kept on the record. */
function CancelModal({ open, number, onClose, onCancel }: { open: boolean; number: string; onClose: () => void; onCancel: (reason: string) => void }) {
  const w = useWords(invoiceWords);
  const c = w.page.confirmCancel;
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={c.title}
      footer={
        <>
          <Button onClick={onClose}>{c.back}</Button>
          <Button
            variant="destructive"
            disabled={!reason.trim()}
            onClick={() => {
              // A refusal shows on the page, under the header.
              onCancel(reason.trim());
              onClose();
            }}
          >
            {c.yes}
          </Button>
        </>
      }
    >
      <p className="font-serif text-[14px] italic" style={{ color: 'var(--text-primary)' }}>
        {c.consequence(number)}
      </p>
      <label className="mt-4 flex flex-col gap-1">
        <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {c.reason}
        </span>
        <input className={CTRL} style={FIELD_BOX} autoFocus maxLength={200} placeholder={c.reasonHint} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
    </Modal>
  );
}
