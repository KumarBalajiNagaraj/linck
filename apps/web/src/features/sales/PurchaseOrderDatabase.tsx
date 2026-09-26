import { useMemo, useState } from 'react';
import { can, formatQty } from '@linck/domain';
import {
  PO_STATUS_FAMILY,
  PO_STATUS_LABEL,
  PRODUCTS,
  purchaseOrdersForSite,
  type PurchaseOrder,
} from '@linck/mock';
import {
  AsOfStamp,
  Button,
  Chip,
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
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';

/**
 * The customer purchase-order database.
 *
 * Every sales order a customer has raised against us, from taken-on-the-phone
 * to fully dispatched. Approval is the gate: rate and credit are checked here,
 * once, so the loader is never the place a price gets argued.
 */

type View = 'all' | PurchaseOrder['status'];
const VIEWS: readonly View[] = ['all', 'pending_approval', 'approved', 'part_dispatched', 'fulfilled', 'rejected'];

const productLabel = (code: string) => PRODUCTS.find((p) => p.code === code)?.label ?? code;

export function PurchaseOrderDatabase() {
  const { persona, siteScope, density } = useApp();
  const [view, setView] = useViewParam(VIEWS, 'all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Decisions taken in this session, not yet written back. */
  const [decided, setDecided] = useState<Record<string, PurchaseOrder['status']>>({});

  const mayApprove = can(persona.grants, 'sales.order.approve', { siteId: siteScope });

  const all = useMemo(
    () => purchaseOrdersForSite(siteScope).map((p) => (decided[p.id] ? { ...p, status: decided[p.id]! } : p)),
    [siteScope, decided],
  );
  const rows = view === 'all' ? all : all.filter((p) => p.status === view);
  const selected = selectedId ? (all.find((p) => p.id === selectedId) ?? null) : null;

  const countOf = (s: PurchaseOrder['status']) => all.filter((p) => p.status === s).length;

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Purchase orders"
        meta={<AsOfStamp asOf="14:42" source="sales.purchase_orders" freshness="live" />}
      />
      <div className="flex flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Chip active={view === 'all'} onClick={() => setView('all')} count={all.length}>
          All orders
        </Chip>
        {VIEWS.filter((v): v is PurchaseOrder['status'] => v !== 'all').map((s) => (
          <Chip key={s} active={view === s} onClick={() => setView(s)} count={countOf(s)}>
            {PO_STATUS_LABEL[s]}
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
            <EmptyState
              fact="No purchase orders match this view."
              because="Nothing at this site is in that state right now."
              action={{ label: 'Show all orders', onClick: () => setView('all') }}
            />
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
        {...(selected
          ? { status: { family: PO_STATUS_FAMILY[selected.status], label: PO_STATUS_LABEL[selected.status] } }
          : {})}
        footer={
          selected?.status === 'pending_approval' ? (
            mayApprove ? (
              <>
                <Button variant="primary" onClick={() => setDecided((d) => ({ ...d, [selected.id]: 'approved' }))}>
                  Approve order
                </Button>
                <Button variant="destructive" onClick={() => setDecided((d) => ({ ...d, [selected.id]: 'rejected' }))}>
                  Reject
                </Button>
              </>
            ) : (
              <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                Awaiting sign-off from a sales manager.
              </span>
            )
          ) : null
        }
      >
        {selected ? (
          <>
            <SheetSection caption="Order">
              <DetailGrid>
                <Detail label="Customer">{selected.customerName}</Detail>
                <Detail label="Deliver to">{selected.deliverySite}</Detail>
                <Detail label="Material">{productLabel(selected.productCode)}</Detail>
                <Detail label="Rate">
                  <MoneyCell value={selected.ratePerUnit} decimals={0} /> / unit
                </Detail>
                <Detail label="Ordered">
                  <QuantityCell value={selected.orderedUnits} decimals={0} uom="units" />
                </Detail>
                <Detail label="Dispatched">
                  <QuantityCell value={selected.dispatchedUnits} decimals={0} uom="units" />
                </Detail>
                <Detail label="Order value">
                  <MoneyCell value={selected.value} decimals={0} />
                </Detail>
                <Detail label="Deliver by">{selected.deliverBy.slice(0, 10)}</Detail>
              </DetailGrid>
            </SheetSection>
            <SheetSection caption="Taken">
              <DetailGrid>
                <Detail label="Received">{selected.receivedOn.slice(0, 10)}</Detail>
                <Detail label="Taken by">{selected.takenBy}</Detail>
              </DetailGrid>
              {selected.status === 'pending_approval' ? (
                <Note>
                  Nothing can be loaded against this order until it is approved. {formatQty(selected.orderedUnits, 0)} units
                  are waiting on the decision.
                </Note>
              ) : null}
            </SheetSection>
          </>
        ) : null}
      </SideSheet>
    </>
  );
}

const columns: Column<PurchaseOrder>[] = [
  {
    key: 'number',
    header: 'Order',
    type: 'id',
    sticky: true,
    width: 170,
    group: 'Order',
    render: (p) => <Stacked primary={<IdCell>{p.number}</IdCell>} secondary={p.customerPoRef} />,
  },
  {
    key: 'status',
    header: 'Status',
    type: 'status',
    width: 170,
    group: 'Order',
    render: (p) => <StatusStamp status={PO_STATUS_FAMILY[p.status]} label={PO_STATUS_LABEL[p.status]} />,
  },
  {
    key: 'customer',
    header: 'Customer',
    group: 'Order',
    render: (p) => <Stacked primary={p.customerName} secondary={p.deliverySite} />,
  },
  { key: 'material', header: 'Material', group: 'Material', render: (p) => productLabel(p.productCode) },
  {
    key: 'ordered',
    header: 'Ordered',
    unit: 'units',
    type: 'num',
    width: 96,
    group: 'Material',
    render: (p) => <QuantityCell value={p.orderedUnits} decimals={0} />,
  },
  {
    key: 'dispatched',
    header: 'Dispatched',
    unit: 'units',
    type: 'num',
    width: 110,
    group: 'Material',
    render: (p) => <QuantityCell value={p.dispatchedUnits} decimals={0} />,
  },
  {
    key: 'value',
    header: 'Value',
    unit: '₹',
    type: 'money',
    width: 130,
    group: 'Money',
    render: (p) => <MoneyCell value={p.value} decimals={0} />,
  },
  { key: 'deliverBy', header: 'Deliver by', width: 110, group: 'Dates', render: (p) => p.deliverBy.slice(0, 10) },
];
