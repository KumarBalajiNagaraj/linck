import { useMemo, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { can, decimal, formatDate } from '@linck/domain';
import { NOW, SITES, type PlInvoiceRow, type PlInvoiceStatus, type PlInvoiceTripRow } from '@linck/mock';
import { Button, Chip, DataTable, EmptyState, IdCell, KpiTile, MoneyCell, PageHeader, Stacked, TileRow, type Column } from '@linck/ui';
import { useInrCompact } from '../../i18n/format.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { downloadXlsx, PrintView, type ReportSheet } from './exporters.js';
import { INVOICE_WRITE, invoicePath, invoicesBase, FINANCE_INVOICES_PATH, listInvoices, tripsToInvoice, useInvoices, useInvoiceWorld, type InvoiceFilter } from './invoiceStore.js';
import { InvoiceStamp } from './InvoiceStamp.js';
import { inrSigned, invoiceProblemText, type InvoiceWords } from './invoiceText.js';
import { invoiceWords } from './invoiceWords.js';
import { CTRL, FIELD_BOX, PERIODS, periodRange, type PeriodKey } from './PlParts.js';
import { sheetPath } from './plStore.js';
import { plWords } from './words.js';

const VIEWS = ['invoices', 'toInvoice'] as const;
const STATUSES: (PlInvoiceStatus | 'all')[] = ['all', 'draft', 'issued', 'cancelled'];
const MONEY = ['all', 'due', 'paid'] as const;

interface Filter {
  period: PeriodKey | 'custom';
  from: string;
  to: string;
  q: string;
  customerId: string;
  status: PlInvoiceStatus | 'all';
  money: (typeof MONEY)[number];
  ready: boolean;
}

const NO_FILTER: Filter = { period: 'all', from: '', to: '', q: '', customerId: '', status: 'all', money: 'all', ready: true };

const sum = (xs: readonly string[]) => decimal.toFixed(decimal.sum(xs.map((x) => decimal.dec(x))), 2);

/**
 * Trip invoices (LIN-27), in Fleet beside the trip sheets and in Accounts:
 * every invoice made from the trips this person reaches — drafts first, then
 * the latest issued — searched and filtered, with what each has received;
 * and the trips still to invoice, to pick one customer's from and make one.
 */
export function InvoiceList() {
  const w = useWords(invoiceWords);
  const pw = useWords(plWords);
  const inr = useInrCompact();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const base = invoicesBase(pathname);
  const { persona } = useApp();
  const world = useInvoiceWorld();
  const make = useInvoices((s) => s.make);
  const [view, setView] = useViewParam(VIEWS, 'invoices');
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [picked, setPicked] = useState<PlInvoiceTripRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [printing, setPrinting] = useState<ReportSheet[] | null>(null);

  const f: InvoiceFilter = {
    status: filter.status === 'all' ? null : filter.status,
    money: filter.money === 'all' ? null : filter.money,
    customerId: filter.customerId || null,
    from: filter.from || null,
    to: filter.to || null,
    q: filter.q,
  };
  const list = useMemo(() => listInvoices(world, persona.grants, f), [world, persona.grants, f.status, f.money, f.customerId, f.from, f.to, f.q]);
  const all = useMemo(() => listInvoices(world, persona.grants, {}), [world, persona.grants]);
  const trips = useMemo(
    () => tripsToInvoice(world, persona.grants, { customerId: filter.customerId || null, from: filter.from || null, to: filter.to || null, q: filter.q }),
    [world, persona.grants, filter.customerId, filter.from, filter.to, filter.q],
  );
  const ready = trips.filter((r) => r.blocked === null);
  const blocked = trips.filter((r) => r.blocked !== null);
  const shownTrips = filter.ready ? ready : blocked;

  const customers = useMemo(
    () =>
      world.parties
        .filter((p) => p.roles.includes('customer'))
        .map((p) => ({ id: p.id, label: p.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [world.parties],
  );

  const issued = list.rows.filter((r) => r.status === 'issued');
  const drafts = list.rows.filter((r) => r.status === 'draft');
  const pct = (part: string, whole: string) => {
    const n = decimal.toNumber(decimal.dec(whole));
    return n > 0 ? ((decimal.toNumber(decimal.dec(part)) / n) * 100).toFixed(0) : '0';
  };
  const stamp = { asOf: formatDate(NOW), source: w.tiles.source, freshness: 'live' as const };

  /* ------------------------------------------------------- picking trips */

  const writable = (siteId: string) => can(persona.grants, INVOICE_WRITE, { siteId });
  const first = picked[0];
  const isPicked = (r: PlInvoiceTripRow) => picked.some((x) => x.tripId === r.tripId && x.customerId === r.customerId);
  const why = (r: PlInvoiceTripRow): string | null => {
    if (!first || isPicked(r)) return null;
    if (r.siteId !== first.siteId) return w.otherSite;
    if (r.customerId !== first.customerId) return w.otherCustomer;
    return null;
  };
  const pickable = (r: PlInvoiceTripRow) => r.blocked === null && writable(r.siteId) && why(r) === null;
  const toggle = (r: PlInvoiceTripRow) => {
    setProblem(null);
    if (isPicked(r)) setPicked(picked.filter((x) => !(x.tripId === r.tripId && x.customerId === r.customerId)));
    else if (pickable(r)) setPicked([...picked, r]);
  };
  const makeIt = () => {
    if (!first) return;
    const result = make(first.customerId, picked.map((r) => r.tripId), { name: persona.name, grants: persona.grants });
    if (!result.ok) {
      setProblem(invoiceProblemText(result.problem, w));
      return;
    }
    setPicked([]);
    void navigate({ to: invoicePath(result.id, base) });
  };

  /* ------------------------------------------------------------ columns */

  const invoiceColumns: Column<PlInvoiceRow>[] = [
    {
      key: 'invoice',
      header: w.col.invoice,
      type: 'id',
      sticky: true,
      render: (r) => <Stacked primary={<IdCell>{r.invoiceNumber ?? w.draftNo}</IdCell>} secondary={formatDate(r.invoiceDate ?? r.createdAt)} />,
    },
    {
      key: 'customer',
      header: w.col.customer,
      render: (r) => <Stacked primary={r.buyerName} secondary={[r.buyerGstin ?? w.noGstin, r.supplyType === 'inter' ? w.igst : null].filter(Boolean).join(' · ')} />,
    },
    {
      key: 'trips',
      header: w.col.trips,
      render: (r) => <Stacked primary={w.tripsN(r.tripNumbers.length)} secondary={r.tripNumbers[0] ? `${r.tripNumbers[0]}${r.tripNumbers.length > 1 ? ` ${w.more(r.tripNumbers.length - 1)}` : ''}` : ''} />,
    },
    { key: 'taxable', header: w.col.taxable, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.taxable} /> },
    { key: 'total', header: w.col.total, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.total} /> },
    { key: 'received', header: w.col.received, type: 'money', unit: '₹', render: (r) => (r.status === 'issued' ? <MoneyCell value={r.received} /> : '—') },
    { key: 'due', header: w.col.due, type: 'money', unit: '₹', render: (r) => (r.status === 'issued' ? <MoneyCell value={r.due} /> : '—') },
    { key: 'status', header: w.col.status, type: 'status', render: (r) => <InvoiceStamp row={r} /> },
  ];
  const tripColumns: Column<PlInvoiceTripRow>[] = [
    {
      key: 'trip',
      header: w.col.trip,
      type: 'id',
      sticky: true,
      render: (r) => (
        <span className="flex items-center gap-2.5">
          {r.blocked === null && writable(r.siteId) && (
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0"
              aria-label={`${w.col.pick} ${r.tripNumber}`}
              checked={isPicked(r)}
              disabled={!isPicked(r) && !pickable(r)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggle(r)}
            />
          )}
          <Stacked
            primary={<IdCell>{r.tripNumber}</IdCell>}
            secondary={
              <span>
                {formatDate(r.tripDate)} ·{' '}
                <Link to={sheetPath(r.sheetId)} className="underline" onClick={(e) => e.stopPropagation()}>
                  {r.sheetNumber}
                </Link>
              </span>
            }
          />
        </span>
      ),
    },
    { key: 'vehicle', header: w.col.vehicle, render: (r) => <Stacked primary={r.registrationNumber} secondary={SITES.find((s) => s.id === r.siteId)?.name ?? ''} /> },
    { key: 'customer', header: w.col.customer, render: (r) => <Stacked primary={r.customerName} secondary={r.customerGstin ?? w.noGstin} /> },
    { key: 'material', header: w.col.material, render: (r) => r.materials.join(', ') },
    { key: 'total', header: w.col.sale, type: 'money', unit: '₹', render: (r) => <MoneyCell value={r.total} /> },
  ];
  // Why a trip cannot be invoiced, or cannot join the trips picked: said only where there is something to say.
  if (!filter.ready || picked.length > 0)
    tripColumns.push({
      key: 'status',
      header: w.col.status,
      render: (r) =>
        r.blocked ? (
          <Stacked primary={w.blocked[r.blocked]} secondary={r.outsideInvoiceNumber ? w.outsideNo(r.outsideInvoiceNumber) : ''} />
        ) : (
          <span style={{ color: 'var(--text-tertiary)' }}>{why(r) ?? ''}</span>
        ),
    });

  /* ------------------------------------------------------------- export */

  const subtitle = filter.from || filter.to ? w.periodLine(filter.from ? formatDate(filter.from) : '…', filter.to ? formatDate(filter.to) : '…') : w.allDates;
  const register = (): ReportSheet => registerSheet(w, list.rows, subtitle);

  const emptyInvoices =
    all.rows.length === 0 ? (
      <EmptyState fact={w.noInvoices} because={w.noInvoicesWhy} action={{ label: w.tabs.toInvoice, onClick: () => setView('toInvoice') }} />
    ) : (
      <EmptyState fact={w.noneMatch} because={w.noneMatchWhy} action={{ label: w.showAll, onClick: () => setFilter(NO_FILTER) }} />
    );
  const emptyTrips =
    filter.q || filter.from || filter.to || filter.customerId ? (
      <EmptyState fact={w.noTripsMatch} because={w.noneMatchWhy} action={{ label: w.showAll, onClick: () => setFilter(NO_FILTER) }} />
    ) : (
      <EmptyState fact={w.noTrips} />
    );

  const pickPeriod = (period: PeriodKey) => setFilter({ ...filter, period, ...periodRange(period) });
  const pickedTotal = sum(picked.map((r) => r.total));

  return (
    <div className="pl-screen pb-24 md:pb-6">
      <PageHeader
        eyebrow={base === FINANCE_INVOICES_PATH ? w.financeEyebrow : w.eyebrow}
        title={w.title}
        actions={
          view === 'invoices' ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => downloadXlsx(`trip-invoices-${formatDate(NOW)}`, [register()])}>{w.excel}</Button>
              <Button onClick={() => setPrinting([register()])}>{w.print}</Button>
            </div>
          ) : undefined
        }
      />
      <div className="flex gap-1.5 px-4 pt-3 md:px-6">
        {VIEWS.map((v) => (
          <Chip key={v} active={view === v} onClick={() => setView(v)} count={v === 'invoices' ? list.rows.length : ready.length}>
            {w.tabs[v]}
          </Chip>
        ))}
      </div>

      <div className="flex flex-col gap-2 px-4 py-3 md:px-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <Chip key={p} active={filter.period === p} onClick={() => pickPeriod(p)}>
              {pw.period[p]}
            </Chip>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-end">
          <label className="col-span-2 flex min-w-0 flex-col gap-1 md:w-[300px]">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {w.search}
            </span>
            <input type="search" className={CTRL} style={FIELD_BOX} placeholder={view === 'invoices' ? w.searchHint : w.tripSearchHint} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 md:w-[150px]">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {w.from}
            </span>
            <input type="date" className={CTRL} style={FIELD_BOX} value={filter.from} onChange={(e) => setFilter({ ...filter, period: 'custom', from: e.target.value })} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 md:w-[150px]">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {w.to}
            </span>
            <input type="date" className={CTRL} style={FIELD_BOX} value={filter.to} onChange={(e) => setFilter({ ...filter, period: 'custom', to: e.target.value })} />
          </label>
          <label className="col-span-2 flex min-w-0 flex-col gap-1 md:w-[240px]">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {w.customer}
            </span>
            <select className={CTRL} style={FIELD_BOX} value={filter.customerId} onChange={(e) => setFilter({ ...filter, customerId: e.target.value })}>
              <option value="">{w.allCustomers}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {view === 'invoices' ? (
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map((s) => (
              <Chip key={s} active={filter.status === s} onClick={() => setFilter({ ...filter, status: s, money: s === 'issued' || s === 'all' ? filter.money : 'all' })}>
                {s === 'all' ? w.all : w.status[s]}
              </Chip>
            ))}
            <span className="w-2" aria-hidden="true" />
            {MONEY.map((m) => (
              <Chip key={m} active={filter.money === m} onClick={() => setFilter({ ...filter, money: m, status: m === 'all' ? filter.status : 'issued' })}>
                {m === 'all' ? w.anyMoney : w.money[m]}
              </Chip>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={filter.ready} onClick={() => setFilter({ ...filter, ready: true })} count={ready.length}>
              {w.ready}
            </Chip>
            <Chip active={!filter.ready} onClick={() => setFilter({ ...filter, ready: false })} count={blocked.length}>
              {w.cannot}
            </Chip>
          </div>
        )}
      </div>

      {view === 'invoices' ? (
        <>
          <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
            <KpiTile eyebrow={w.tiles.invoiced} value={inr(list.total.total)} title={inrSigned(list.total.total)} delta={{ text: w.tiles.invoices(issued.length) }} {...stamp} />
            <KpiTile
              eyebrow={w.tiles.received}
              value={inr(list.total.received)}
              title={inrSigned(list.total.received)}
              delta={{ text: w.tiles.ofInvoiced(pct(list.total.received, list.total.total)) }}
              {...stamp}
            />
            <KpiTile eyebrow={w.tiles.due} value={inr(list.total.due)} title={inrSigned(list.total.due)} hero delta={{ text: w.tiles.invoices(issued.filter((r) => r.moneyStatus !== 'paid').length) }} {...stamp} />
            <KpiTile eyebrow={w.tiles.drafts} value={inr(sum(drafts.map((r) => r.total)))} title={inrSigned(sum(drafts.map((r) => r.total)))} delta={{ text: w.tiles.waiting(drafts.length) }} {...stamp} />
          </TileRow>
          <DataTable
            columns={invoiceColumns}
            rows={list.rows}
            rowKey={(r) => r.id}
            isDormant={(r) => r.status === 'cancelled'}
            onRowClick={(r) => void navigate({ to: invoicePath(r.id, base) })}
            empty={emptyInvoices}
          />
        </>
      ) : (
        <>
          <DataTable columns={tripColumns} rows={shownTrips} rowKey={(r) => `${r.tripId}:${r.customerId}`} onRowClick={toggle} isDormant={(r) => r.blocked !== null} empty={emptyTrips} />
          {(picked.length > 0 || problem) && (
            <div
              className="pl-savebar fixed inset-x-0 z-30 flex flex-wrap items-center gap-2 px-4 py-2 md:sticky md:bottom-0 md:px-6"
              style={{ bottom: 'calc(60px + env(safe-area-inset-bottom))', background: 'var(--surface)', borderTop: '1px solid var(--border-subtle)' }}
            >
              <span className="min-w-0 flex-1 text-[13px]" style={{ color: problem ? 'var(--status-critical)' : 'var(--text-secondary)' }} role={problem ? 'alert' : undefined}>
                {problem ?? `${first?.customerName ?? ''} · ${w.picked(picked.length, inrSigned(pickedTotal))}`}
              </span>
              <Button
                onClick={() => {
                  setPicked([]);
                  setProblem(null);
                }}
              >
                {w.clear}
              </Button>
              <Button variant="primary" disabled={picked.length === 0} onClick={makeIt}>
                {w.makeInvoice}
              </Button>
            </div>
          )}
        </>
      )}
      {printing && <PrintView sheets={printing} printedOn={formatDate(NOW)} onClose={() => setPrinting(null)} />}
    </div>
  );
}

/** The invoice register, as Excel and the print view take it: one row an invoice. */
function registerSheet(w: InvoiceWords, rows: readonly PlInvoiceRow[], subtitle: string): ReportSheet {
  const issued = rows.filter((r) => r.status === 'issued');
  return {
    name: w.register,
    title: w.register,
    subtitle,
    columns: [
      { header: w.col.invoice, kind: 'text' },
      { header: w.date, kind: 'date' },
      { header: w.col.customer, kind: 'text' },
      { header: w.paper.gstin, kind: 'text' },
      { header: w.paper.placeOfSupply, kind: 'text' },
      { header: w.col.taxable, kind: 'money' },
      { header: w.col.gst, kind: 'money' },
      { header: w.col.total, kind: 'money' },
      { header: w.col.received, kind: 'money' },
      { header: w.col.due, kind: 'money' },
      { header: w.col.status, kind: 'text' },
    ],
    rows: rows.map((r) => [
      r.invoiceNumber ?? w.draftNo,
      r.invoiceDate ?? r.createdAt.slice(0, 10),
      r.buyerName,
      r.buyerGstin ?? '',
      r.placeOfSupply,
      r.taxable,
      r.tax,
      r.total,
      r.status === 'issued' ? r.received : null,
      r.status === 'issued' ? r.due : null,
      r.status === 'issued' ? w.money[r.moneyStatus ?? 'due'] : w.status[r.status],
    ]),
    total: [w.total, null, null, null, null, sum(issued.map((r) => r.taxable)), sum(issued.map((r) => r.tax)), sum(issued.map((r) => r.total)), sum(issued.map((r) => r.received)), sum(issued.map((r) => r.due)), null],
  };
}
