import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ageing,
  ageBucket,
  ACTION_LABEL,
  enteredStatusAt,
  exceptionsIn,
  formatDate,
  formatDateTime,
  formatINR,
  formatINRCompact,
  STAGE_LABEL,
  STAGES,
  summarizeExpenses,
  totalOf,
  type ExpenseLine,
  type ExpenseStage,
} from '@linck/domain';
import { EXPENSE_KIND_LABEL, expensesForSite, NOW, SITES, VEHICLES, type ExpenseBill } from '@linck/mock';
import {
  AgeingBar,
  AsOfStamp,
  Button,
  Chip,
  DataTable,
  Detail,
  DetailGrid,
  EmptyState,
  IdCell,
  KpiTile,
  MoneyCell,
  Note,
  PageHeader,
  QuantityCell,
  Section,
  SheetSection,
  SideSheet,
  Stacked,
  StatusStamp,
  TileRow,
  type Column,
} from '@linck/ui';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { BatchBar, BillHistory, ChainActions } from '../expenses/ApprovalChain.js';
import { useExpenses } from '../expenses/expenseStore.js';

/**
 * THE DIRECTOR'S EXPENSE DASHBOARD (LIN-15).
 *
 * The summary of every expense bill, fleet and stores, by where it stands in
 * the approval chain: with the desk that raised it, awaiting the director,
 * with accounts, paid. The director's own queue leads — what waits on them,
 * for how long, with "Approve all" one click away — then where the money
 * goes, by type, site, vehicle or desk, and every second signature anyone
 * has made.
 *
 * It reads the same live bill store as the registers, so a bill approved
 * here is approved there, and the other way round.
 */

const GROUPS = ['type', 'site', 'vehicle', 'desk'] as const;
type Group = (typeof GROUPS)[number];

const GROUP_LABEL: Record<Group, string> = { type: 'By type', site: 'By site', vehicle: 'By vehicle', desk: 'By desk' };

const rupees = (paise: number) => formatINR(paise / 100);
const compact = (paise: number) => formatINRCompact(paise / 100);
const money = (paise: number) => (paise / 100).toFixed(2);

const keyOf: Record<Group, (b: ExpenseBill) => string | null> = {
  type: (b) => b.kind,
  site: (b) => b.siteId,
  // Stores bills are against no vehicle: they drop out of this view, and the
  // caption says so.
  vehicle: (b) => b.vehicleId ?? null,
  desk: (b) => b.desk,
};

const labelOf: Record<Group, (key: string) => string> = {
  type: (k) => EXPENSE_KIND_LABEL[k as ExpenseBill['kind']] ?? k,
  site: (k) => SITES.find((s) => s.id === k)?.name ?? k,
  vehicle: (k) => VEHICLES.find((v) => v.id === k)?.displayReg ?? k,
  desk: (k) => (k === 'fleet' ? 'Fleet' : k === 'stores' ? 'Stores' : k),
};

/** Routes are plain strings here, as in the command palette. */
const BILLS_ROUTE: string = '/finance/expenses';

const waitedFor = (b: ExpenseBill) => {
  const days = Math.floor((NOW.getTime() - Date.parse(enteredStatusAt(b))) / 86_400_000);
  return days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`;
};

export function ExpenseApprovals() {
  const { siteScope, density } = useApp();
  const navigate = useNavigate();
  const bills = useExpenses((s) => s.bills);
  const [group, setGroup] = useViewParam(GROUPS, 'type');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scoped = useMemo(() => expensesForSite(siteScope, null, bills), [siteScope, bills]);
  const total = useMemo(() => totalOf(scoped), [scoped]);
  const lines = useMemo(() => summarizeExpenses(scoped, keyOf[group]), [scoped, group]);
  const waiting = useMemo(
    () => scoped.filter((b) => b.status === 'validated').sort((a, b) => Date.parse(enteredStatusAt(a)) - Date.parse(enteredStatusAt(b))),
    [scoped],
  );
  const ages = useMemo(() => ageing(scoped, 'validated', NOW), [scoped]);
  const exceptions = useMemo(() => exceptionsIn(scoped), [scoped]);
  const oldest = waiting[0];
  const overAWeek = ages.find((a) => a.label === 'Over a week')!;
  const selected = selectedId ? (scoped.find((b) => b.id === selectedId) ?? null) : null;
  const stage = (s: ExpenseStage) => total.stages[s];

  const lineColumns: Column<ExpenseLine>[] = [
    {
      key: 'key',
      header: GROUP_LABEL[group].replace('By ', '').replace(/^./, (c) => c.toUpperCase()),
      sticky: true,
      type: group === 'vehicle' ? 'id' : 'text',
      render: (l) => (group === 'vehicle' ? <IdCell>{labelOf.vehicle(l.key)}</IdCell> : labelOf[group](l.key)),
    },
    { key: 'bills', header: 'Bills', type: 'num', width: 70, render: (l) => l.bills },
    ...STAGES.map(
      (s): Column<ExpenseLine> => ({
        key: s,
        header: STAGE_LABEL[s],
        unit: '₹',
        type: 'money',
        width: 140,
        group: 'Where it stands',
        render: (l) => (l.stages[s].paise > 0 ? <MoneyCell value={money(l.stages[s].paise)} /> : null),
      }),
    ),
    { key: 'total', header: 'Total', unit: '₹', type: 'money', width: 140, render: (l) => <MoneyCell value={money(l.totalPaise)} /> },
    {
      key: 'litres',
      header: 'Diesel',
      unit: 'L',
      type: 'num',
      width: 100,
      render: (l) => (l.litres > 0 ? <QuantityCell value={l.litres} decimals={1} /> : null),
    },
    {
      key: 'rejected',
      header: 'Rejected',
      unit: '₹',
      type: 'money',
      width: 120,
      render: (l) => (l.rejected.count > 0 ? <MoneyCell value={money(l.rejected.paise)} /> : null),
    },
  ];

  const waitingColumns: Column<ExpenseBill>[] = [
    {
      key: 'bill',
      header: 'Bill',
      type: 'id',
      sticky: true,
      width: 150,
      render: (b) => <Stacked primary={<IdCell>{b.billNumber || '–'}</IdCell>} secondary={formatDate(b.billDate)} />,
    },
    { key: 'kind', header: 'Type', width: 90, render: (b) => EXPENSE_KIND_LABEL[b.kind] },
    { key: 'vendor', header: 'Vendor', render: (b) => <Stacked primary={b.vendor || '–'} secondary={b.description} /> },
    { key: 'site', header: 'Site', width: 170, render: (b) => SITES.find((s) => s.id === b.siteId)?.name ?? b.siteId },
    { key: 'amount', header: 'Amount', unit: '₹', type: 'money', width: 120, render: (b) => <MoneyCell value={b.amount} /> },
    {
      key: 'waited',
      header: 'Waiting',
      width: 110,
      render: (b) => {
        const bucket = ageBucket(enteredStatusAt(b), NOW);
        return bucket === 'Over a week' ? <StatusStamp status="critical" label={waitedFor(b)} /> : waitedFor(b);
      },
    },
    {
      key: 'flag',
      header: 'Signed twice',
      width: 110,
      render: (b) => ((b.history ?? []).some((e) => e.exception) ? <StatusStamp status="attention" label="Exception" /> : null),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Expense approvals"
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source="expense_bills" freshness="live" />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {total.bills} bills · {rupees(total.totalPaise)} in the chain
              {total.litres > 0 ? ` · ${total.litres.toLocaleString('en-IN')} L of diesel` : ''}
              {total.rejected.count > 0 ? ` · ${total.rejected.count} rejected (${compact(total.rejected.paise)}), not counted` : ''}
            </span>
          </span>
        }
        actions={<Button onClick={() => void navigate({ to: BILLS_ROUTE })}>Open expense bills</Button>}
      />

      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <KpiTile
          eyebrow="Awaiting your approval"
          hero
          value={compact(stage('director').paise)}
          title={rupees(stage('director').paise)}
          delta={{
            text:
              stage('director').count === 0
                ? 'Nothing waits on you'
                : `${stage('director').count} bills · oldest ${oldest ? waitedFor(oldest).toLowerCase() : '–'}`,
            tone: overAWeek.count > 0 ? 'critical' : stage('director').count > 0 ? 'attention' : 'neutral',
          }}
          asOf="14:42"
          source="expense_bills"
        />
        <KpiTile
          eyebrow="With the desk, not yet validated"
          value={compact(stage('desk').paise)}
          title={rupees(stage('desk').paise)}
          delta={{ text: `${stage('desk').count} bills with fleet and stores` }}
          asOf="14:42"
          source="expense_bills"
        />
        <KpiTile
          eyebrow="Approved, with accounts"
          value={compact(stage('accounts').paise)}
          title={rupees(stage('accounts').paise)}
          delta={{ text: `${stage('accounts').count} bills to pass and pay` }}
          asOf="14:42"
          source="expense_bills"
        />
        <KpiTile
          eyebrow="Paid"
          value={compact(stage('paid').paise)}
          title={rupees(stage('paid').paise)}
          delta={{ text: `${stage('paid').count} bills` }}
          asOf="14:42"
          source="expense_bills"
        />
      </TileRow>

      <BatchBar key={siteScope ?? 'all'} bills={waiting} status="validated" />

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-6 xl:grid-cols-[2fr_1fr]">
        <Section caption="Your queue, oldest first" title="Bills awaiting your approval">
          <DataTable
            density={density}
            columns={waitingColumns}
            rows={waiting}
            rowKey={(b) => b.id}
            selectedKey={selectedId ?? undefined}
            onRowClick={(b) => setSelectedId(b.id)}
            rail={(b) => ({ status: ageBucket(enteredStatusAt(b), NOW) === 'Over a week' ? 'critical' : 'attention', provenance: b.provenance })}
            empty={<EmptyState fact="Nothing waits on you." because="Every validated bill here has been approved, sent back or rejected." />}
          />
        </Section>
        <Section caption="How long it has waited" title="Your queue by age">
          <AgeingBar
            summary={`${stage('director').count} bills, ${rupees(stage('director').paise)}, awaiting approval; ${overAWeek.count} of them for over a week.`}
            buckets={ages.map((a) => ({ label: a.label, value: a.paise / 100 }))}
            format={(v) => formatINRCompact(v)}
          />
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            Counted from when the desk validated each bill, or from when it was raised where Linck has no record of the validation.
          </p>
        </Section>
      </div>

      <Section
        caption="Where the money goes"
        title="Summary of expenses"
        actions={
          <span className="flex flex-wrap gap-2">
            {GROUPS.map((g) => (
              <Chip key={g} active={group === g} onClick={() => setGroup(g)}>
                {GROUP_LABEL[g]}
              </Chip>
            ))}
          </span>
        }
      >
        <DataTable
          density={density}
          columns={lineColumns}
          rows={lines}
          rowKey={(l) => l.key}
          empty={<EmptyState fact="No expense bills here." because="Nothing has been raised at this site yet." />}
        />
        <p className="mt-2 px-6 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          Total {rupees(total.totalPaise)} across {total.bills - total.rejected.count} bills. Rejected bills are shown apart and left out of every
          total; deleted bills are not counted.
          {group === 'vehicle' ? ' Stores bills are against no vehicle and are not in this view.' : ''}
        </p>
      </Section>

      <Section caption="Four eyes" title="Second signatures">
        {exceptions.length === 0 ? (
          <Note>Nobody has signed the same bill twice.</Note>
        ) : (
          <ul className="flex flex-col gap-2 px-6 text-[13px]">
            {exceptions.map(({ bill, event }, i) => (
              <li key={`${bill.id}-${i}`} className="flex flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusStamp status="attention" label="Exception" />
                  <button type="button" className="font-id" style={{ color: 'var(--brand)' }} onClick={() => setSelectedId(bill.id)}>
                    {bill.billNumber || bill.id}
                  </button>
                  <span>
                    {ACTION_LABEL[event.action]} by {event.by} · {formatDateTime(event.at)} · {formatINR(bill.amount)}
                  </span>
                </span>
                {event.note ? <span style={{ color: 'var(--text-secondary)' }}>“{event.note}”</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        width="form"
        title={selected ? `${EXPENSE_KIND_LABEL[selected.kind]} · ${selected.vendor || '–'}` : ''}
        identifier={selected?.billNumber}
      >
        {selected ? (
          <>
            <ChainActions key={selected.id} bill={selected} />
            <SheetSection caption="Bill">
              <DetailGrid>
                <Detail label="Amount">
                  <MoneyCell value={selected.amount} />
                </Detail>
                <Detail label="Bill date">{formatDate(selected.billDate)}</Detail>
                <Detail label="Site">{SITES.find((s) => s.id === selected.siteId)?.name ?? selected.siteId}</Detail>
                {selected.vehicleId ? <Detail label="Vehicle">{VEHICLES.find((v) => v.id === selected.vehicleId)?.displayReg ?? '–'}</Detail> : null}
                {selected.litres !== null ? (
                  <Detail label="Litres">
                    <QuantityCell value={selected.litres} decimals={1} uom="L" />
                  </Detail>
                ) : null}
                <Detail label="What for">{selected.description}</Detail>
              </DetailGrid>
              {selected.attachment ? (
                <a href={selected.attachment.url} target="_blank" rel="noreferrer" className="mt-2 block text-[13px]" style={{ color: 'var(--brand)' }}>
                  Open the scan ({selected.attachment.fileName})
                </a>
              ) : null}
            </SheetSection>
            <BillHistory bill={selected} />
          </>
        ) : null}
      </SideSheet>
    </>
  );
}
