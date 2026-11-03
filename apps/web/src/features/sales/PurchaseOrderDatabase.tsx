import { useMemo, useState } from 'react';
import { can, formatDate, formatINR, formatQty } from '@linck/domain';
import { PO_STATUS_FAMILY, type PurchaseOrder } from '@linck/mock';
import {
  AsOfStamp,
  Button,
  Chip,
  ConfirmModal,
  DataTable,
  Detail,
  DetailGrid,
  EmptyState,
  IdCell,
  Modal,
  MoneyCell,
  Note,
  PageHeader,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  useUiWords,
  type Column,
} from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { Busy, FIELD_STYLE, Refusal } from '../../shell/Field.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { OrderSheet, productLabel, useOrderProblem } from './OrderSheet.js';
import { ordersAt, useAddOrder, useOrders, type OrderBook } from './orders.js';
import type { Decision } from './salesApi.js';
import { orderWords, salesWords, type OrderText, type SalesText } from './words.js';

/**
 * The customer purchase-order database ("Orders" on screen).
 *
 * Every sales order a customer has raised against us, from taken-on-the-phone
 * to fully dispatched. Approval is the gate: rate and credit are checked here,
 * once, so the loader is never the place a price gets argued.
 *
 * LIVE (VITE_API_URL set) the orders are the API's (orders.ts): the sales
 * desk takes an order here, and the decision is a request the API checks
 * again — who may approve at the order's site, and that it is still waiting.
 * Rejecting asks why, because the API keeps the reason.
 */

type View = 'all' | PurchaseOrder['status'];
const VIEWS: readonly View[] = ['all', 'pending_approval', 'approved', 'part_dispatched', 'fulfilled', 'rejected'];

type StatusText = (typeof statusWords)['en'];

export function PurchaseOrderDatabase() {
  const { persona, siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [adding, setAdding] = useState(false);
  /** Live: why the API refused a decision, kept in view once the order has moved on. */
  const [refused, setRefused] = useState<{ id: string; problem: RecordProblem } | null>(null);
  const t = useWords(orderWords);
  const s = useWords(salesWords);
  const status = useWords(statusWords);
  const say = useOrderProblem();
  const columns = useMemo(() => orderColumns(t, s, status), [t, s, status]);
  const book = useOrders();
  const add = useAddOrder();

  const all = useMemo(() => ordersAt(book.rows, siteScope), [book.rows, siteScope]);
  const rows = view === 'all' ? all : all.filter((p) => p.status === view);
  const selected = selectedId ? (all.find((p) => p.id === selectedId) ?? null) : null;
  // At the order's site, as the API checks it.
  const mayApprove = selected !== null && can(persona.grants, 'sales.order.approve', { siteId: selected.siteId });
  const mayAdd = add !== null && can(persona.grants, 'sales.order.write', { siteId: siteScope }) && can(persona.grants, 'sales.customer.read');

  const countOf = (st: PurchaseOrder['status']) => all.filter((p) => p.status === st).length;

  const decide = (order: PurchaseOrder, decision: Decision, reason?: string) => {
    setRefused(null);
    void book.decide.run({ order, decision, ...(reason ? { reason } : {}) }).then((no) => setRefused(no ? { id: order.id, problem: no } : null));
  };

  return (
    <>
      <PageHeader
        eyebrow={s.eyebrow}
        title={t.title}
        // From sales.purchase_orders.
        meta={<AsOfStamp asOf={book.asOf} source={s.src.orders} freshness="live" />}
        actions={
          mayAdd ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              {t.add}
            </Button>
          ) : undefined
        }
      />
      <div id="list" className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={all.length}>
          {s.all}
        </Chip>
        {VIEWS.filter((v): v is PurchaseOrder['status'] => v !== 'all').map((st) => (
          <Chip key={st} active={view === st} onClick={() => setView(st)} count={countOf(st)}>
            {status.order[st]}
          </Chip>
        ))}
      </div>
      <Section>
        <DataTable
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          selectedKey={selectedId ?? undefined}
          onRowClick={(p) => setSelectedId(p.id)}
          isDormant={(p) => p.status === 'rejected'}
          rail={(p) => ({
            status: PO_STATUS_FAMILY[p.status],
            fillRatio: p.orderedUnits > 0 ? p.dispatchedUnits / p.orderedUnits : 0,
          })}
          empty={
            book.state !== 'ready' ? (
              <OrdersNotHere book={book} />
            ) : all.length === 0 ? (
              <EmptyState fact={t.noneAtSite} />
            ) : (
              <EmptyState fact={t.noneHere} action={{ label: s.showAll, onClick: () => setView('all') }} />
            )
          }
        />
      </Section>
      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        title={selected?.number ?? ''}
        identifier={selected ? `${selected.customerName} · ${selected.customerPoRef}` : undefined}
        // On a phone the sheet header sets the stamp on its own row under the
        // order number, so the number keeps the full width.
        {...(selected ? { status: { family: PO_STATUS_FAMILY[selected.status], label: status.order[selected.status] } } : {})}
        footer={
          selected?.status === 'pending_approval' ? (
            mayApprove ? (
              <>
                <Button variant="primary" onClick={() => decide(selected, 'approve')} disabled={book.decide.busy}>
                  {t.approve}
                </Button>
                <Button variant="destructive" onClick={() => setConfirmReject(true)} disabled={book.decide.busy}>
                  {t.reject}
                </Button>
              </>
            ) : (
              <span className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                {t.managerApproves}
              </span>
            )
          ) : null
        }
      >
        {selected ? (
          <>
            {/* Live, a refused decision re-reads the orders, and the order has often been
                decided meanwhile: the reason stays, above where the order now is. */}
            {refused?.id === selected.id ? <Refusal text={say(refused.problem)} /> : null}
            {book.decide.busy ? <Busy text={s.saving} /> : null}
            <SheetSection caption={t.order}>
              <DetailGrid>
                <Detail label={s.customer}>{selected.customerName}</Detail>
                <Detail label={t.deliverTo}>{selected.deliverySite}</Detail>
                <Detail label={s.material}>{productLabel(selected.productCode)}</Detail>
                <Detail label={s.rate}>{t.perUnit(formatINR(selected.ratePerUnit, { decimals: 0 }))}</Detail>
                <Detail label={t.ordered}>
                  <QuantityCell value={selected.orderedUnits} decimals={0} uom={s.units} />
                </Detail>
                <Detail label={t.sent}>
                  <QuantityCell value={selected.dispatchedUnits} decimals={0} uom={s.units} />
                </Detail>
                <Detail label={s.amount}>
                  <MoneyCell value={selected.value} accounting={false} decimals={0} />
                </Detail>
                <Detail label={t.deliverBy}>{formatDate(selected.deliverBy)}</Detail>
              </DetailGrid>
            </SheetSection>
            <SheetSection caption={t.taken}>
              <DetailGrid>
                <Detail label={s.date}>{formatDate(selected.receivedOn)}</Detail>
                <Detail label={t.takenBy}>{selected.takenBy}</Detail>
              </DetailGrid>
              {/* Nothing can be loaded against an order until it is approved. */}
              {selected.status === 'pending_approval' ? <Note>{t.approveToLoad(formatQty(selected.orderedUnits, 0))}</Note> : null}
            </SheetSection>
          </>
        ) : null}
      </SideSheet>

      {/* Rejecting is the one move on this screen with no way back from it, so
          it names the customer, the units and the money before it happens. It
          cannot be reopened here; the customer raises a new order. Live it
          asks why as well, because the API keeps the reason with the order. */}
      {book.reasonToReject ? (
        <RejectWithReason
          order={confirmReject ? selected : null}
          busy={book.decide.busy}
          onClose={() => setConfirmReject(false)}
          onConfirm={(order, reason) => {
            decide(order, 'reject', reason);
            setConfirmReject(false);
          }}
        />
      ) : (
        <ConfirmModal
          open={confirmReject && selected !== null}
          onClose={() => setConfirmReject(false)}
          onConfirm={() => {
            if (selected) decide(selected, 'reject');
            setConfirmReject(false);
          }}
          title={t.rejectTitle}
          destructive
          confirmLabel={t.rejectYes}
          consequence={selected ? <RejectConsequence order={selected} /> : null}
        />
      )}
      {adding ? <OrderSheet onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** Who, what and how much, before an order is turned down for good. */
function RejectConsequence({ order }: { order: PurchaseOrder }) {
  const t = useWords(orderWords);
  return (
    <>
      <p>
        {order.customerName} · {order.customerPoRef}
      </p>
      <p>{t.rejectWhat(formatQty(order.orderedUnits, 0), productLabel(order.productCode), formatINR(order.value, { decimals: 0 }))}</p>
      <p className="mt-2">{t.rejectNote}</p>
    </>
  );
}

/** Live: the same question, and the reason the API keeps. "Yes, reject" waits for one. */
function RejectWithReason({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: PurchaseOrder | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (order: PurchaseOrder, reason: string) => void;
}) {
  const t = useWords(orderWords);
  const ui = useUiWords();
  const [reason, setReason] = useState('');
  const close = () => {
    setReason('');
    onClose();
  };
  return (
    <Modal
      open={order !== null}
      onClose={close}
      title={t.rejectTitle}
      footer={
        <>
          <Button onClick={close}>{ui.goBack}</Button>
          <Button
            variant="destructive"
            disabled={!reason.trim() || busy}
            onClick={() => {
              if (!order) return;
              onConfirm(order, reason.trim());
              setReason('');
            }}
          >
            {t.rejectYes}
          </Button>
        </>
      }
    >
      {order ? (
        <div className="text-[15px]" style={{ color: 'var(--text-primary)' }}>
          <RejectConsequence order={order} />
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {t.reason}
            </span>
            <textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} rows={3} className="w-full p-2 text-[14px]" style={FIELD_STYLE} />
          </label>
        </div>
      ) : null}
    </Modal>
  );
}

/** Live only: the orders are on their way, or could not be read. */
function OrdersNotHere({ book }: { book: OrderBook }) {
  const t = useWords(orderWords);
  const s = useWords(salesWords);
  const say = useOrderProblem();
  if (book.state === 'loading') return <EmptyState fact={t.loading} />;
  return <EmptyState fact={t.failed} {...(book.problem ? { because: say(book.problem) } : {})} action={{ label: s.retry, onClick: book.retry }} />;
}

/**
 * No column groups: "Order" over the order number and "Material" over the
 * material column only repeated their own headers, and on a phone card they
 * printed the same word twice in a row.
 */
function orderColumns(t: OrderText, s: SalesText, status: StatusText): Column<PurchaseOrder>[] {
  return [
    {
      key: 'number',
      header: t.order,
      type: 'id',
      sticky: true,
      width: 170,
      render: (p) => <Stacked primary={<IdCell>{p.number}</IdCell>} secondary={p.customerPoRef} />,
    },
    {
      key: 'status',
      header: s.status,
      type: 'status',
      width: 200,
      render: (p) => <StatusStamp status={PO_STATUS_FAMILY[p.status]} label={status.order[p.status]} />,
    },
    {
      key: 'customer',
      header: s.customer,
      render: (p) => <Stacked primary={p.customerName} secondary={p.deliverySite} />,
    },
    { key: 'material', header: s.material, render: (p) => productLabel(p.productCode) },
    {
      key: 'ordered',
      header: t.ordered,
      unit: s.units,
      type: 'num',
      width: 120,
      render: (p) => <QuantityCell value={p.orderedUnits} decimals={0} />,
    },
    {
      key: 'dispatched',
      header: t.sent,
      unit: s.units,
      type: 'num',
      width: 120,
      render: (p) => <QuantityCell value={p.dispatchedUnits} decimals={0} />,
    },
    {
      key: 'value',
      header: s.amount,
      unit: '₹',
      type: 'money',
      width: 130,
      render: (p) => <MoneyCell value={p.value} decimals={0} />,
    },
    { key: 'deliverBy', header: t.deliverBy, width: 120, render: (p) => formatDate(p.deliverBy) },
  ];
}
