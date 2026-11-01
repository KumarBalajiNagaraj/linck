import { useMemo, useState } from 'react';
import { can, formatDate, formatINR, formatQty } from '@linck/domain';
import { PO_STATUS_FAMILY, PRODUCTS, purchaseOrdersForSite, type PurchaseOrder } from '@linck/mock';
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
  MoneyCell,
  Note,
  PageHeader,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  type Column,
} from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { orderWords, salesWords, type OrderText, type SalesText } from './words.js';

/**
 * The customer purchase-order database ("Orders" on screen).
 *
 * Every sales order a customer has raised against us, from taken-on-the-phone
 * to fully dispatched. Approval is the gate: rate and credit are checked here,
 * once, so the loader is never the place a price gets argued.
 */

type View = 'all' | PurchaseOrder['status'];
const VIEWS: readonly View[] = ['all', 'pending_approval', 'approved', 'part_dispatched', 'fulfilled', 'rejected'];

/** Material names are the product's own names (M-Sand, 20mm Aggregate) and are not translated. */
const productLabel = (code: string) => PRODUCTS.find((p) => p.code === code)?.label ?? code;

type StatusText = (typeof statusWords)['en'];

export function PurchaseOrderDatabase() {
  const { persona, siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Decisions taken in this session, not yet written back. */
  const [decided, setDecided] = useState<Record<string, PurchaseOrder['status']>>({});
  const [confirmReject, setConfirmReject] = useState(false);
  const t = useWords(orderWords);
  const s = useWords(salesWords);
  const status = useWords(statusWords);
  const columns = useMemo(() => orderColumns(t, s, status), [t, s, status]);

  const mayApprove = can(persona.grants, 'sales.order.approve', { siteId: siteScope });

  const all = useMemo(
    () => purchaseOrdersForSite(siteScope).map((p) => (decided[p.id] ? { ...p, status: decided[p.id]! } : p)),
    [siteScope, decided],
  );
  const rows = view === 'all' ? all : all.filter((p) => p.status === view);
  const selected = selectedId ? (all.find((p) => p.id === selectedId) ?? null) : null;

  const countOf = (st: PurchaseOrder['status']) => all.filter((p) => p.status === st).length;

  return (
    <>
      <PageHeader
        eyebrow={s.eyebrow}
        title={t.title}
        // From sales.purchase_orders.
        meta={<AsOfStamp asOf="14:42" source={s.src.orders} freshness="live" />}
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
            all.length === 0 ? (
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
                <Button variant="primary" onClick={() => setDecided((d) => ({ ...d, [selected.id]: 'approved' }))}>
                  {t.approve}
                </Button>
                <Button variant="destructive" onClick={() => setConfirmReject(true)}>
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
          cannot be reopened here; the customer raises a new order. */}
      <ConfirmModal
        open={confirmReject && selected !== null}
        onClose={() => setConfirmReject(false)}
        onConfirm={() => {
          if (selected) setDecided((d) => ({ ...d, [selected.id]: 'rejected' }));
          setConfirmReject(false);
        }}
        title={t.rejectTitle}
        destructive
        confirmLabel={t.rejectYes}
        consequence={
          selected ? (
            <>
              <p>
                {selected.customerName} · {selected.customerPoRef}
              </p>
              <p>
                {t.rejectWhat(
                  formatQty(selected.orderedUnits, 0),
                  productLabel(selected.productCode),
                  formatINR(selected.value, { decimals: 0 }),
                )}
              </p>
              <p className="mt-2">{t.rejectNote}</p>
            </>
          ) : null
        }
      />
    </>
  );
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
