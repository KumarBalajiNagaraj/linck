import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ageing,
  ageBucket,
  enteredStatusAt,
  exceptionsIn,
  formatDate,
  formatDateTime,
  formatINR,
  STAGES,
  summarizeExpenses,
  totalOf,
  type ExpenseLine,
  type ExpenseStage,
} from '@linck/domain';
import { expensesForSite, NOW, SITES, VEHICLES, type ExpenseBill } from '@linck/mock';
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
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { useInrCompact } from '../../i18n/format.js';
import { useApp } from '../../shell/store.js';
import { useViewParam } from '../../shell/useViewParam.js';
import { BatchBar, BillHistory, ChainActions } from '../expenses/ApprovalChain.js';
import { useExpenses } from '../expenses/expenseStore.js';
import { expenseWords } from '../expenses/words.js';

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
 * here is approved there, and the other way round. In plain words, English
 * or Tamil (LIN-23).
 */

const GROUPS = ['type', 'site', 'vehicle', 'desk'] as const;
type Group = (typeof GROUPS)[number];

const rupees = (paise: number) => formatINR(paise / 100);
const money = (paise: number) => (paise / 100).toFixed(2);

const keyOf: Record<Group, (b: ExpenseBill) => string | null> = {
  type: (b) => b.kind,
  site: (b) => b.siteId,
  // Stores bills are against no vehicle: they drop out of this view, and the
  // footnote says so.
  vehicle: (b) => b.vehicleId ?? null,
  desk: (b) => b.desk,
};

/** Routes are plain strings here, as in the command palette. */
const BILLS_ROUTE: string = '/finance/expenses';

/** Whole days a bill has waited at its current step. */
const daysWaited = (b: ExpenseBill) => Math.floor((NOW.getTime() - Date.parse(enteredStatusAt(b))) / 86_400_000);

export function ExpenseApprovals() {
  const { siteScope, density } = useApp();
  const navigate = useNavigate();
  const bills = useExpenses((s) => s.bills);
  const [group, setGroup] = useViewParam(GROUPS, 'type');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const t = useWords(expenseWords);
  const a = t.approvals;
  const status = useWords(statusWords);
  const inr = useInrCompact();
  const compact = (paise: number) => inr(paise / 100);

  const scoped = useMemo(() => expensesForSite(siteScope, null, bills), [siteScope, bills]);
  const total = useMemo(() => totalOf(scoped), [scoped]);
  const lines = useMemo(() => summarizeExpenses(scoped, keyOf[group]), [scoped, group]);
  const waiting = useMemo(
    () => scoped.filter((b) => b.status === 'validated').sort((x, y) => Date.parse(enteredStatusAt(x)) - Date.parse(enteredStatusAt(y))),
    [scoped],
  );
  const ages = useMemo(() => ageing(scoped, 'validated', NOW), [scoped]);
  const exceptions = useMemo(() => exceptionsIn(scoped), [scoped]);
  const oldest = waiting[0];
  const overAWeek = ages.find((b) => b.label === 'over-7')!;
  const selected = selectedId ? (scoped.find((b) => b.id === selectedId) ?? null) : null;
  const stage = (s: ExpenseStage) => total.stages[s];

  const labelOf: Record<Group, (key: string) => string> = {
    type: (k) => status.expenseKind[k as ExpenseBill['kind']] ?? k,
    site: (k) => SITES.find((s) => s.id === k)?.name ?? k,
    vehicle: (k) => VEHICLES.find((v) => v.id === k)?.displayReg ?? k,
    desk: (k) => (k === 'fleet' || k === 'stores' ? t.deskName(k) : k),
  };

  const lineColumns: Column<ExpenseLine>[] = [
    {
      key: 'key',
      header: a.groupHead[group],
      sticky: true,
      type: group === 'vehicle' ? 'id' : 'text',
      render: (l) => (group === 'vehicle' ? <IdCell>{labelOf.vehicle(l.key)}</IdCell> : labelOf[group](l.key)),
    },
    { key: 'bills', header: a.billsCol, type: 'num', width: 80, render: (l) => l.bills },
    ...STAGES.map(
      (s): Column<ExpenseLine> => ({
        key: s,
        header: a.stages[s],
        unit: '₹',
        type: 'money',
        width: 140,
        group: a.stageGroup,
        render: (l) => (l.stages[s].paise > 0 ? <MoneyCell value={money(l.stages[s].paise)} /> : null),
      }),
    ),
    { key: 'total', header: a.total, unit: '₹', type: 'money', width: 140, render: (l) => <MoneyCell value={money(l.totalPaise)} /> },
    {
      key: 'litres',
      header: a.dieselCol,
      unit: 'L',
      type: 'num',
      width: 100,
      render: (l) => (l.litres > 0 ? <QuantityCell value={l.litres} decimals={1} /> : null),
    },
    {
      key: 'rejected',
      header: a.rejectedCol,
      unit: '₹',
      type: 'money',
      width: 120,
      render: (l) => (l.rejected.count > 0 ? <MoneyCell value={money(l.rejected.paise)} /> : null),
    },
  ];

  const waitingColumns: Column<ExpenseBill>[] = [
    {
      key: 'bill',
      header: a.columns.bill,
      type: 'id',
      sticky: true,
      width: 150,
      render: (b) => <Stacked primary={<IdCell>{b.billNumber || '–'}</IdCell>} secondary={formatDate(b.billDate)} />,
    },
    { key: 'kind', header: a.columns.type, width: 90, render: (b) => status.expenseKind[b.kind] },
    { key: 'vendor', header: a.columns.shop, render: (b) => <Stacked primary={b.vendor || '–'} secondary={b.description || undefined} /> },
    { key: 'site', header: a.columns.site, width: 170, render: (b) => SITES.find((s) => s.id === b.siteId)?.name ?? b.siteId },
    { key: 'amount', header: a.columns.amount, unit: '₹', type: 'money', width: 120, render: (b) => <MoneyCell value={b.amount} /> },
    {
      key: 'waited',
      header: a.columns.waiting,
      width: 120,
      render: (b) => {
        const days = daysWaited(b);
        return ageBucket(enteredStatusAt(b), NOW) === 'over-7' ? <StatusStamp status="critical" label={a.ageCap(days)} /> : a.ageCap(days);
      },
    },
    {
      key: 'flag',
      header: a.columns.twice,
      width: 130,
      render: (b) => ((b.history ?? []).some((e) => e.exception) ? <StatusStamp status="attention" label={a.twiceStamp} /> : null),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.desk.overview}
        title={a.title}
        meta={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AsOfStamp asOf="14:42" source="expense_bills" freshness="live" />
            <span className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
              {a.meta(total.bills, rupees(total.totalPaise))}
              {total.litres > 0 ? ` · ${a.diesel(total.litres.toLocaleString('en-IN'))}` : ''}
              {total.rejected.count > 0 ? ` · ${a.rejected(total.rejected.count, compact(total.rejected.paise))}` : ''}
            </span>
          </span>
        }
        actions={<Button onClick={() => void navigate({ to: BILLS_ROUTE })}>{a.allBills}</Button>}
      />

      <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
        <KpiTile
          eyebrow={a.tiles.forYou}
          hero
          value={compact(stage('director').paise)}
          title={rupees(stage('director').paise)}
          delta={{
            text: stage('director').count === 0 ? a.tiles.nothing : a.tiles.waiting(stage('director').count, oldest ? a.age(daysWaited(oldest)) : '–'),
            tone: overAWeek.count > 0 ? 'critical' : stage('director').count > 0 ? 'attention' : 'neutral',
          }}
          asOfInHeader
        />
        <KpiTile
          eyebrow={a.tiles.notChecked}
          value={compact(stage('desk').paise)}
          title={rupees(stage('desk').paise)}
          delta={{ text: a.tiles.bills(stage('desk').count) }}
          asOfInHeader
        />
        <KpiTile
          eyebrow={a.tiles.withAccounts}
          value={compact(stage('accounts').paise)}
          title={rupees(stage('accounts').paise)}
          delta={{ text: a.tiles.toPay(stage('accounts').count) }}
          asOfInHeader
        />
        <KpiTile
          eyebrow={a.tiles.paid}
          value={compact(stage('paid').paise)}
          title={rupees(stage('paid').paise)}
          delta={{ text: a.tiles.bills(stage('paid').count) }}
          asOfInHeader
        />
      </TileRow>

      <BatchBar key={siteScope ?? 'all'} bills={waiting} status="validated" />

      <div className="grid grid-cols-1 gap-x-8 px-6 pt-6 xl:grid-cols-[2fr_1fr]">
        <Section caption={a.oldestFirst} title={a.toApprove}>
          <DataTable
            density={density}
            columns={waitingColumns}
            rows={waiting}
            rowKey={(b) => b.id}
            selectedKey={selectedId ?? undefined}
            onRowClick={(b) => setSelectedId(b.id)}
            rail={(b) => ({ status: ageBucket(enteredStatusAt(b), NOW) === 'over-7' ? 'critical' : 'attention', provenance: b.provenance })}
            empty={<EmptyState fact={a.nothingForYou} />}
          />
        </Section>
        <Section caption={a.howLong} title={a.waitingTime}>
          <AgeingBar
            summary={a.ageSummary(stage('director').count, rupees(stage('director').paise), overAWeek.count)}
            buckets={ages.map((b) => ({ label: a.buckets[b.label], value: b.paise / 100 }))}
            format={inr}
          />
          <p className="mt-2 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
            {a.countedFrom}
          </p>
        </Section>
      </div>

      <Section
        caption={a.whereMoney}
        title={a.summaryTitle}
        actions={
          <span className="flex flex-wrap gap-2">
            {GROUPS.map((g) => (
              <Chip key={g} active={group === g} onClick={() => setGroup(g)}>
                {a.groups[g]}
              </Chip>
            ))}
          </span>
        }
      >
        <DataTable density={density} columns={lineColumns} rows={lines} rowKey={(l) => l.key} empty={<EmptyState fact={a.noBills} />} />
        <p className="mt-2 px-6 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
          {a.footnote(rupees(total.totalPaise), total.bills - total.rejected.count)}
          {group === 'vehicle' ? ` ${a.noVehicleNote}` : ''}
        </p>
      </Section>

      <Section caption={a.signedTwiceCaption} title={a.signedTwiceTitle}>
        {exceptions.length === 0 ? (
          <Note>{a.nobodyTwice}</Note>
        ) : (
          <ul className="flex flex-col gap-2 px-6 text-[14px]">
            {exceptions.map(({ bill, event }, i) => (
              <li key={`${bill.id}-${i}`} className="flex flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusStamp status="attention" label={a.twiceStamp} />
                  <button type="button" className="font-id" style={{ color: 'var(--brand)' }} onClick={() => setSelectedId(bill.id)}>
                    {bill.billNumber || bill.id}
                  </button>
                  <span>
                    {t.done(event.action, event.by)} · {formatDateTime(event.at)} · {formatINR(bill.amount)}
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
        title={selected ? `${status.expenseKind[selected.kind]} · ${selected.vendor || '–'}` : ''}
        identifier={selected?.billNumber}
      >
        {selected ? (
          <>
            <ChainActions key={selected.id} bill={selected} />
            <SheetSection caption={t.detail.bill}>
              <DetailGrid>
                <Detail label={t.detail.fields.amount!}>
                  <MoneyCell value={selected.amount} />
                </Detail>
                <Detail label={t.detail.fields.billDate!}>{formatDate(selected.billDate)}</Detail>
                <Detail label={a.columns.site}>{SITES.find((s) => s.id === selected.siteId)?.name ?? selected.siteId}</Detail>
                {selected.vehicleId ? (
                  <Detail label={t.detail.fields.vehicle!}>{VEHICLES.find((v) => v.id === selected.vehicleId)?.displayReg ?? '–'}</Detail>
                ) : null}
                {selected.litres !== null ? (
                  <Detail label={t.detail.fields.litres!}>
                    <QuantityCell value={selected.litres} decimals={1} uom="L" />
                  </Detail>
                ) : null}
                <Detail label={t.detail.fields.whatFor!}>{selected.description || status.expenseKind[selected.kind]}</Detail>
              </DetailGrid>
              {selected.attachment ? (
                <a href={selected.attachment.url} target="_blank" rel="noreferrer" className="mt-2 block text-[14px]" style={{ color: 'var(--brand)' }}>
                  {a.openPhoto}
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
