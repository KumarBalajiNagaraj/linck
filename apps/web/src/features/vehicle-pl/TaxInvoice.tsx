import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { formatDate } from '@linck/domain';
import type { PlInvoiceDetail } from '@linck/mock';
import { Button } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { grouped, stateName, type InvoiceWords } from './invoiceText.js';
import { invoiceWords } from './invoiceWords.js';

/**
 * The invoice as paper (LIN-27): a GST tax invoice with what CGST Rule 46
 * asks of one — the seller's and the buyer's names, addresses and GSTINs,
 * the invoice number and date, the place of supply with its state code,
 * whether tax is on reverse charge, each line's description, HSN, quantity,
 * rate, value and taxable value, the tax split at its rates, the totals, the
 * amount in words, and a signature line. A draft carries "DRAFT · NOT A TAX
 * INVOICE" across it; a cancelled one "CANCELLED", with its reason below.
 *
 * The same paper is the invoice page's preview and what prints (index.css:
 * `.inv-paper`, `@page invoice`). On a narrow screen its line table becomes
 * one block per line; on paper it is always the table, A4 portrait.
 */
/** A vehicle number stays on one line: TN 38 AB 1008, never TN 38 / AB 1008. */
const keep = (text: string) => text.replace(/ /g, '\u00a0');

export function TaxInvoice({ invoice }: { invoice: PlInvoiceDetail }) {
  const w = useWords(invoiceWords);
  const p = w.paper;
  const intra = invoice.supplyType === 'intra';
  const state = (code: string | null | undefined) => (code ? p.stateLine(stateName(w, code), code) : '—');
  const oneShipTo = Boolean(invoice.shipTo?.name);
  const mark = invoice.status === 'draft' ? p.draftMark : invoice.status === 'cancelled' ? p.cancelledMark : null;
  const pct = (n: number) => String(n);
  return (
    <article className="inv-paper" data-status={invoice.status}>
      {mark && (
        <div className="inv-mark" aria-hidden="true">
          <span>{mark}</span>
        </div>
      )}
      <header className="inv-head">
        <div className="inv-block">
          <p className="inv-label">{p.seller}</p>
          <p className="inv-name">{invoice.seller.legalName}</p>
          {invoice.seller.tradeName && <p>{invoice.seller.tradeName}</p>}
          {invoice.seller.address && <p>{invoice.seller.address}</p>}
          <p>
            {p.gstin}: <span className="inv-id">{invoice.seller.gstin}</span>
          </p>
          <p>
            {p.state}: {state(invoice.seller.stateCode)}
          </p>
        </div>
        <div className="inv-block inv-title">
          <p className="inv-doc">{p.title}</p>
          <p className="inv-label">{p.original}</p>
          <dl className="inv-meta">
            <dt>{p.invoiceNo}</dt>
            <dd className="inv-id">{invoice.invoiceNumber ?? p.onIssue}</dd>
            <dt>{p.invoiceDate}</dt>
            <dd>{invoice.invoiceDate ? formatDate(invoice.invoiceDate) : '—'}</dd>
            <dt>{p.placeOfSupply}</dt>
            <dd>{state(invoice.placeOfSupply)}</dd>
            <dt>{p.reverseCharge}</dt>
            <dd>{p.no}</dd>
          </dl>
        </div>
      </header>

      <section className="inv-parties">
        <div className="inv-block">
          <p className="inv-label">{p.billTo}</p>
          <p className="inv-name2">{invoice.buyer.name}</p>
          {invoice.buyer.address && <p>{invoice.buyer.address}</p>}
          <p>
            {p.gstin}: <span className="inv-id">{invoice.buyer.gstin ?? p.unregistered}</span>
          </p>
          {invoice.buyer.stateCode && (
            <p>
              {p.state}: {state(invoice.buyer.stateCode)}
            </p>
          )}
        </div>
        <div className="inv-block">
          <p className="inv-label">{p.shipTo}</p>
          {invoice.shipTo ? (
            <>
              <p className="inv-name2">{invoice.shipTo.name || invoice.buyer.name}</p>
              {invoice.shipTo.address && <p>{invoice.shipTo.address}</p>}
            </>
          ) : (
            <p>{p.sameAsBillTo}</p>
          )}
        </div>
      </section>

      <table className="inv-lines">
        <thead>
          <tr>
            <th>{p.col.description}</th>
            <th>{p.col.hsn}</th>
            <th className="num">{p.col.qty}</th>
            <th className="num">{p.col.rate}</th>
            <th className="num">{p.col.amount}</th>
            <th className="num">{p.col.transport}</th>
            <th className="num">{p.col.taxable}</th>
            {intra ? (
              <>
                <th className="num">{p.col.cgst}</th>
                <th className="num">{p.col.sgst}</th>
              </>
            ) : (
              <th className="num">{p.col.igst}</th>
            )}
            <th className="num">{p.col.total}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l, i) => (
            <tr key={l.id}>
              <td className="inv-desc" data-label={p.col.description}>
                <span className="inv-strong">
                  {i + 1}. {l.description}
                </span>
                <span className="inv-sub">
                  {[p.lineTrip(l.tripNumber, formatDate(l.tripDate)), p.lineVehicle(keep(l.registrationNumber)), l.challanNumber ? p.lineDc(l.challanNumber) : null, !oneShipTo && l.location ? l.location : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </td>
              <td data-label={p.col.hsn}>{l.hsnCode}</td>
              <td className="num" data-label={p.col.qty}>
                <span>
                  {l.quantity}
                  <span className="inv-sub">{l.unit}</span>
                </span>
              </td>
              <td className="num" data-label={p.col.rate}>
                {grouped(l.rate)}
              </td>
              <td className="num" data-label={p.col.amount}>
                {grouped(l.amount)}
              </td>
              <td className="num" data-label={p.col.transport}>
                {grouped(l.transport)}
              </td>
              <td className="num" data-label={p.col.taxable}>
                {grouped(l.taxable)}
              </td>
              {intra ? (
                <>
                  <td className="num" data-label={p.col.cgst}>
                    <span>
                      {grouped(l.cgst)}
                      <span className="inv-sub">{p.col.rateOf(pct(l.cgstPct))}</span>
                    </span>
                  </td>
                  <td className="num" data-label={p.col.sgst}>
                    <span>
                      {grouped(l.sgst)}
                      <span className="inv-sub">{p.col.rateOf(pct(l.sgstPct))}</span>
                    </span>
                  </td>
                </>
              ) : (
                <td className="num" data-label={p.col.igst}>
                  <span>
                    {grouped(l.igst)}
                    <span className="inv-sub">{p.col.rateOf(pct(l.igstPct))}</span>
                  </span>
                </td>
              )}
              <td className="num inv-strong" data-label={p.col.total}>
                {grouped(l.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="inv-foot">
        <div className="inv-block">
          <p className="inv-label">{p.inWords}</p>
          <p className="inv-words" lang="en-IN">
            {invoice.words}
          </p>
          {invoice.notes && (
            <p className="inv-notes">
              <span className="inv-label">{p.notes}: </span>
              {invoice.notes}
            </p>
          )}
        </div>
        <dl className="inv-totals">
          <dt>{p.taxableTotal}</dt>
          <dd>{grouped(invoice.taxable)}</dd>
          {intra ? (
            <>
              <dt>{p.col.cgst}</dt>
              <dd>{grouped(invoice.cgst)}</dd>
              <dt>{p.col.sgst}</dt>
              <dd>{grouped(invoice.sgst)}</dd>
            </>
          ) : (
            <>
              <dt>{p.col.igst}</dt>
              <dd>{grouped(invoice.igst)}</dd>
            </>
          )}
          <dt>{p.beforeRounding}</dt>
          <dd>{grouped(invoice.beforeRounding)}</dd>
          <dt>{p.roundOff}</dt>
          <dd>{grouped(invoice.roundOff)}</dd>
          <dt className="inv-grand">{p.grandTotal}</dt>
          <dd className="inv-grand">₹{grouped(invoice.total)}</dd>
        </dl>
      </section>
      <HsnTable invoice={invoice} p={p} intra={intra} />

      {invoice.irn && (
        <p className="inv-small">
          {p.irn}: <span className="inv-id">{invoice.irn}</span>
          {invoice.irnAckNumber ? ` · ${p.ack(invoice.irnAckNumber, invoice.irnAckDate ? formatDate(invoice.irnAckDate) : '')}` : ''}
        </p>
      )}

      <footer className="inv-sign">
        <p className="inv-small">{p.declaration}</p>
        <div className="inv-signbox">
          <p>{p.forSeller(invoice.seller.legalName)}</p>
          <p className="inv-signline">{p.signatory}</p>
        </div>
      </footer>
      {invoice.status === 'cancelled' && invoice.cancelledAt && (
        <p className="inv-cancelled">{p.cancelledLine(formatDate(invoice.cancelledAt), invoice.cancelReason ?? '')}</p>
      )}
    </article>
  );
}

function HsnTable({ invoice, p, intra }: { invoice: PlInvoiceDetail; p: InvoiceWords['paper']; intra: boolean }) {
  return (
    <table className="inv-hsn">
      <caption className="inv-label">{p.byHsn}</caption>
      <thead>
        <tr>
          <th>{p.col.hsn}</th>
          <th className="num">{p.col.taxable}</th>
          <th className="num">{p.col.gstRate}</th>
          {intra ? (
            <>
              <th className="num">{p.col.cgst}</th>
              <th className="num">{p.col.sgst}</th>
            </>
          ) : (
            <th className="num">{p.col.igst}</th>
          )}
          <th className="num">{p.totalTax}</th>
        </tr>
      </thead>
      <tbody>
        {invoice.byHsn.map((r) => (
          <tr key={`${r.hsnCode}:${r.gstRatePct}`}>
            <td>{r.hsnCode ?? '—'}</td>
            <td className="num">{grouped(r.taxable)}</td>
            <td className="num">{r.gstRatePct}</td>
            {intra ? (
              <>
                <td className="num">{grouped(r.cgst)}</td>
                <td className="num">{grouped(r.sgst)}</td>
              </>
            ) : (
              <td className="num">{grouped(r.igst)}</td>
            )}
            <td className="num">{grouped(r.tax)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * "PDF / Print": the paper alone over the page, as LIN-22's print view lays
 * its tables (index.css hides the app under `body.inv-printing`), and the
 * print dialog once it is on screen. Save as PDF is the dialog's own choice.
 */
export function InvoicePrint({ invoice, printedOn, onClose }: { invoice: PlInvoiceDetail; printedOn: string; onClose: () => void }) {
  const w = useWords(invoiceWords);
  useEffect(() => {
    document.body.classList.add('inv-printing');
    const timer = window.setTimeout(() => window.print(), 250);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('inv-printing');
    };
  }, [onClose]);
  return createPortal(
    <div className="inv-print" role="dialog" aria-modal="true" aria-label={w.print}>
      <div className="inv-print-bar">
        <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {w.paper.printedOn(printedOn)}
        </span>
        <span className="flex gap-2">
          <Button variant="primary" onClick={() => window.print()}>
            {w.paper.printNow}
          </Button>
          <Button onClick={onClose}>{w.paper.close}</Button>
        </span>
      </div>
      <TaxInvoice invoice={invoice} />
    </div>,
    document.body,
  );
}
