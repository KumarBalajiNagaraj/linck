import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { can, decimal, formatDate, saleFigures } from '@linck/domain';
import type { PlInvoiceTripRow, PlSaleInvoice, PlSheetRecord } from '@linck/mock';
import { Button, Section } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useMakeInvoice, useSheetTripsToInvoice } from './invoices.js';
import { INVOICE_READ, INVOICE_WRITE, invoicePath } from './invoiceStore.js';
import { invoiceProblemText } from './invoiceText.js';
import { invoiceWords } from './invoiceWords.js';
import { inrExact } from './PlParts.js';
import { usePlMasters } from './sheets.js';

interface Row {
  key: string;
  tripId: string;
  tripNumber: string;
  date: string;
  customerId: string;
  customerName: string;
  total: string;
  /** The draft or issued invoices its lines to this customer are on. */
  invoices: PlSaleInvoice[];
  /** Its lines to this customer no live invoice bills yet, if any. */
  free: PlInvoiceTripRow | null;
}

/**
 * The trip sheet's invoices (LIN-27): each trip's sales to each customer, the
 * invoice they are on, and a pick for those not invoiced yet — one customer's
 * trips at a time — to make the invoice from. The sheet is at one site, so
 * every pick here bills under one GSTIN.
 */
export function SheetInvoices({ record, invoiced }: { record: PlSheetRecord; invoiced: Map<string, PlSaleInvoice> }) {
  const w = useWords(invoiceWords);
  const { persona } = useApp();
  const navigate = useNavigate();
  const parties = usePlMasters().data.parties;
  const toInvoice = useSheetTripsToInvoice(record).data;
  const make = useMakeInvoice();
  const [picked, setPicked] = useState<{ customerId: string; tripIds: string[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const readable = can(persona.grants, INVOICE_READ, { siteId: record.siteId });
  const writable = can(persona.grants, INVOICE_WRITE, { siteId: record.siteId });

  const rows = useMemo<Row[]>(() => {
    const live = invoiced;
    const free = new Map(toInvoice.map((r) => [`${r.tripId}:${r.customerId}`, r]));
    const names = new Map(parties.map((p) => [p.id, p.name]));
    const out: Row[] = [];
    const trips = [...record.trips].sort((a, b) => (a.date === b.date ? a.tripNumber.localeCompare(b.tripNumber) : a.date < b.date ? -1 : 1));
    for (const trip of trips) {
      for (const customerId of [...new Set(trip.sales.map((s) => s.customerId))]) {
        const sales = trip.sales.filter((s) => s.customerId === customerId);
        const on = new Map<string, PlSaleInvoice>();
        for (const s of sales) {
          const inv = live.get(s.id);
          if (inv) on.set(inv.id, inv);
        }
        const total = sales
          .map((s) => saleFigures({ id: s.id, customerId, quantity: s.quantity, rate: s.rate, transport: s.transport ?? null, gstBilled: s.gstBilled, gstRatePct: s.gstRatePct }).total)
          .reduce((a, b) => decimal.toFixed(decimal.add(decimal.dec(a), decimal.dec(b)), 2), '0.00');
        out.push({
          key: `${trip.id}:${customerId}`,
          tripId: trip.id,
          tripNumber: trip.tripNumber,
          date: trip.date,
          customerId,
          customerName: names.get(customerId) ?? '',
          total,
          invoices: [...on.values()],
          free: free.get(`${trip.id}:${customerId}`) ?? null,
        });
      }
    }
    return out;
  }, [invoiced, toInvoice, parties, record]);

  if (!readable || rows.length === 0) return null;

  const pickable = (r: Row) => writable && r.free !== null && r.free.blocked === null && (!picked || picked.customerId === r.customerId);
  const isPicked = (r: Row) => Boolean(picked && picked.customerId === r.customerId && picked.tripIds.includes(r.tripId));
  const toggle = (r: Row) => {
    setProblem(null);
    if (isPicked(r)) {
      const tripIds = picked!.tripIds.filter((id) => id !== r.tripId);
      setPicked(tripIds.length ? { customerId: r.customerId, tripIds } : null);
    } else if (pickable(r)) {
      setPicked({ customerId: r.customerId, tripIds: [...(picked?.tripIds ?? []), r.tripId] });
    }
  };
  const pickedRows = rows.filter(isPicked);
  const pickedTotal = pickedRows.map((r) => r.free?.total ?? '0.00').reduce((a, b) => decimal.toFixed(decimal.add(decimal.dec(a), decimal.dec(b)), 2), '0.00');
  const makeIt = async () => {
    if (!picked) return;
    const result = await make.run({ customerId: picked.customerId, tripIds: picked.tripIds });
    if (!result.ok) {
      setProblem(invoiceProblemText(result.problem, w));
      return;
    }
    setPicked(null);
    void navigate({ to: invoicePath(result.id) });
  };

  return (
    <Section caption={w.sheet.section}>
      <div className="px-4 md:px-6">
        {writable && rows.some((r) => r.free && r.free.blocked === null) && (
          <p className="py-2 font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
            {w.sheet.hint}
          </p>
        )}
        <ul className="flex flex-col">
          {rows.map((r) => {
            const canPick = pickable(r) || isPicked(r);
            return (
              <li
                key={r.key}
                className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 py-2 md:grid-cols-[44px_minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.8fr)]"
                style={{ borderTop: '1px solid var(--border-subtle)' }}
              >
                <span className="row-span-2 flex h-11 w-11 items-center justify-center md:row-span-1">
                  {writable && r.free && r.free.blocked === null && (
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      aria-label={`${w.col.pick} ${r.tripNumber}`}
                      checked={isPicked(r)}
                      disabled={!canPick}
                      onChange={() => toggle(r)}
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-col text-[14px]">
                  <span className="font-id">{r.tripNumber}</span>
                  <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                    {formatDate(r.date)}
                  </span>
                </span>
                <span className="col-start-2 min-w-0 truncate text-[14px] md:col-start-auto">{r.customerName}</span>
                <span className="col-start-2 text-[13px] md:col-start-auto md:text-right">
                  <span className="num tabular-nums">{inrExact(r.total)}</span>
                </span>
                <span className="col-start-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[13px] md:col-start-auto">
                  {r.invoices.map((inv) => (
                    <Link key={inv.id} to={invoicePath(inv.id)} className="underline" style={{ color: 'var(--brand)' }}>
                      {inv.status === 'draft' || !inv.number ? w.sheet.onDraft : w.sheet.onInvoice(inv.number)}
                    </Link>
                  ))}
                  {r.free && r.free.blocked && <span style={{ color: 'var(--text-tertiary)' }}>{w.blocked[r.free.blocked]}</span>}
                  {r.free && !r.free.blocked && <span style={{ color: 'var(--text-secondary)' }}>{w.sheet.notYet}</span>}
                  {picked && r.free && !r.free.blocked && picked.customerId !== r.customerId && <span style={{ color: 'var(--text-tertiary)' }}>{w.otherCustomer}</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {writable && (picked || problem || rows.some(pickable)) && (
          <div className="flex flex-wrap items-center gap-2 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <span className="min-w-0 flex-1 text-[13px]" style={{ color: problem ? 'var(--status-critical)' : 'var(--text-secondary)' }}>
              {problem ?? (picked ? w.picked(pickedRows.length, inrExact(pickedTotal)) : '')}
            </span>
            {picked && <Button onClick={() => { setPicked(null); setProblem(null); }}>{w.clear}</Button>}
            <Button variant="primary" disabled={!picked || make.busy} onClick={() => void makeIt()}>
              {w.makeInvoice}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
