import { decimal, formatDate, type PlTotals } from '@linck/domain';
import type { PlMonthRow, PlVehicleRow } from '@linck/mock';
import { EmptyState, ProportionBar, Section } from '@linck/ui';
import { useInrCompact } from '../../i18n/format.js';
import { useWords } from '../../i18n/words.js';
import { costShares, perUnit, type Attention, type CostShare, type CustomerPlRow } from './insights.js';
import { inrExact, useChangeLine, type Comparison } from './PlParts.js';
import { plWords } from './words.js';

/**
 * Profit reports → Summary: the owner's four questions on one screen, before
 * any table. Am I making money (the tiles above), where does each ₹100 of a
 * sale go, which vehicles and customers earn it, and what should I look at
 * today. Every bar and line is a way into the trips behind it.
 */

const neg = (m: string) => decimal.isNegative(decimal.dec(m));
const num = (m: string) => decimal.toNumber(decimal.dec(m));

const SHARE_TONE: Record<CostShare['key'], string> = {
  purchase: 'var(--chart-5)',
  diesel: 'var(--chart-4)',
  batta: 'var(--chart-3)',
  road: 'var(--chart-2)',
  profit: 'var(--brand)',
};

export interface SummaryActions {
  vehicle: (vehicleId: string) => void;
  customer: (partyId: string) => void;
  month: (month: string) => void;
  losses: () => void;
  tab: (tab: 'vehicles' | 'customersPl' | 'customers' | 'months') => void;
}

export function PlSummary({
  total,
  previous,
  vehicles,
  customers,
  months,
  attention,
  monthLabel,
  go,
}: {
  total: PlTotals;
  previous: Comparison | null;
  vehicles: PlVehicleRow[];
  customers: CustomerPlRow[];
  months: PlMonthRow[];
  attention: Attention[];
  monthLabel: (month: string) => string;
  go: SummaryActions;
}) {
  const w = useWords(plWords);
  if (decimal.isZero(decimal.dec(total.sales)) && total.trips === 0) {
    return <EmptyState fact={w.noRows} because={w.noneMatchWhy} />;
  }
  return (
    <div className="pb-10">
      <div className="grid grid-cols-1 gap-x-10 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <WhereItWent total={total} />
        <WorthALook items={attention} go={go} />
      </div>
      <UnitStrip total={total} previous={previous} />
      <MonthBars rows={months} monthLabel={monthLabel} onPick={go.month} />
      <div className="grid grid-cols-1 gap-x-10 xl:grid-cols-2">
        <Ranked
          title={w.sum.vehiclesTitle}
          rows={vehicles.map((v) => ({
            id: v.vehicleId,
            name: v.registrationNumber,
            sub: v.vehicleModel,
            trips: v.trips,
            net: v.net,
            pct: v.profitPct,
          }))}
          onPick={go.vehicle}
          onAll={() => go.tab('vehicles')}
        />
        <Ranked
          title={w.sum.customersTitle}
          rows={customers.map((c) => ({
            id: c.partyId,
            name: c.name,
            sub: null,
            trips: c.trips,
            net: c.net,
            pct: c.profitPct,
          }))}
          onPick={go.customer}
          onAll={() => go.tab('customersPl')}
        />
      </div>
    </div>
  );
}

/** Each ₹100 of sales, as a ladder of five lines and one bar: what everyone reads first on a P&L, without the accounting. */
function WhereItWent({ total }: { total: PlTotals }) {
  const w = useWords(plWords);
  const inr = useInrCompact();
  const shares = costShares(total);
  const profit = shares.find((s) => s.key === 'profit')!;
  if (profit.per100 === null) {
    return (
      <Section title={w.sum.whereTitle}>
        <p className="px-6 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
          {w.sum.noSale}
        </p>
      </Section>
    );
  }
  const loss = profit.per100 < 0;
  const max = Math.max(100, ...shares.map((s) => Math.abs(s.per100 ?? 0)));
  return (
    <Section caption={w.sum.whereCaption} title={w.sum.whereTitle}>
      <div className="px-6">
        {!loss && (
          <ProportionBar
            summary={w.sum.whereSummary(profit.per100.toFixed(1))}
            height={28}
            showLabels={false}
            segments={shares.map((s) => ({
              label: w.sum.share[s.key],
              value: Math.max(0, s.per100 ?? 0),
              tone: SHARE_TONE[s.key],
            }))}
          />
        )}
        <dl className="mt-3 flex flex-col">
          {shares.map((s) => {
            const isProfit = s.key === 'profit';
            const red = isProfit && loss;
            const pct = s.per100 ?? 0;
            return (
              <div
                key={s.key}
                className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 py-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_5.5rem_6.5rem]"
                style={
                  isProfit
                    ? {
                        borderTop: '1px solid var(--border-default)',
                        marginTop: 4,
                        paddingTop: 10,
                      }
                    : undefined
                }
              >
                <dt
                  className={`flex items-center gap-2 text-[14px] ${isProfit ? 'font-semibold' : ''}`}
                  style={{
                    color: red ? 'var(--status-critical)' : 'var(--text-primary)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{
                      background: red ? 'var(--status-critical)' : SHARE_TONE[s.key],
                    }}
                  />
                  {isProfit && loss ? w.sum.lossShare : w.sum.share[s.key]}
                </dt>
                <div className="h-2 min-w-0 rounded-[2px]" style={{ background: 'var(--surface-sunken)' }} aria-hidden="true">
                  <div
                    className="h-2 rounded-[2px]"
                    style={{
                      width: `${(Math.abs(pct) / max) * 100}%`,
                      background: red ? 'var(--status-critical)' : SHARE_TONE[s.key],
                    }}
                  />
                </div>
                <dd
                  className={`num text-right text-[15px] tabular-nums ${isProfit ? 'font-semibold' : ''}`}
                  style={{
                    color: red ? 'var(--status-critical)' : 'var(--text-primary)',
                  }}
                >
                  {red ? `(${w.sum.of100(Math.abs(pct).toFixed(1))})` : w.sum.of100(pct.toFixed(1))}
                </dd>
                <dd className="num hidden text-right text-[13px] tabular-nums sm:block" style={{ color: 'var(--text-secondary)' }}>
                  {inr(s.amount.startsWith('-') ? s.amount.slice(1) : s.amount)}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </Section>
  );
}

/** Per trip and per km, against the last period where there is one: the figures a fleet owner quotes a rate from. */
function UnitStrip({ total, previous }: { total: PlTotals; previous: Comparison | null }) {
  const w = useWords(plWords);
  const changeLine = useChangeLine();
  const now = perUnit(total);
  const before = previous ? perUnit(previous.totals) : null;
  const cells: {
    label: string;
    value: string | null;
    before: string | null;
  }[] = [
    {
      label: w.sum.perTrip,
      value: now.profitPerTrip,
      before: before?.profitPerTrip ?? null,
    },
    {
      label: w.sum.perKm,
      value: now.profitPerKm,
      before: before?.profitPerKm ?? null,
    },
    {
      label: w.sum.salesPerKm,
      value: now.salesPerKm,
      before: before?.salesPerKm ?? null,
    },
    {
      label: w.sum.dieselPerKm,
      value: now.dieselPerKm,
      before: before?.dieselPerKm ?? null,
    },
  ];
  return (
    <Section title={w.sum.unitTitle}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-6 md:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label} className="min-w-0">
            <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {c.label}
            </p>
            <p
              className="num text-[20px] tabular-nums"
              style={{
                color: c.value && neg(c.value) ? 'var(--status-critical)' : 'var(--text-primary)',
              }}
            >
              {c.value === null ? '—' : neg(c.value) ? `(${inrExact(c.value)})` : inrExact(c.value)}
            </p>
            {c.value !== null && c.before !== null && previous ? (
              <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {changeLine(c.value, c.before, previous.against).text}
              </p>
            ) : null}
          </div>
        ))}
        <div className="min-w-0">
          <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
            {w.sum.mileage}
          </p>
          <p className="num text-[20px] tabular-nums">{total.mileageKmpl === null ? '—' : w.sum.kmpl(total.mileageKmpl.toFixed(2))}</p>
          {previous?.totals.mileageKmpl != null && total.mileageKmpl !== null ? (
            <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {`${total.mileageKmpl >= previous.totals.mileageKmpl ? '▲' : '▼'} ${Math.abs(total.mileageKmpl - previous.totals.mileageKmpl).toFixed(2)} ${previous.against}`}
            </p>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/** The plain-language list: one line each, numbers first, and a way to the rows behind it. */
function WorthALook({ items, go }: { items: Attention[]; go: SummaryActions }) {
  const w = useWords(plWords);
  const inr = useInrCompact();
  const abs = (m: string) => inr(m.startsWith('-') ? m.slice(1) : m);
  const line = (a: Attention): { text: string; tone: 'critical' | 'attention'; onClick: () => void } => {
    switch (a.kind) {
      case 'lossTrips':
        return {
          text: w.sum.lossTrips(a.count, abs(a.amount)),
          tone: 'critical',
          onClick: go.losses,
        };
      case 'lossVehicle':
        return {
          text: w.sum.lossVehicle(a.name, abs(a.amount)),
          tone: 'critical',
          onClick: () => go.vehicle(a.vehicleId),
        };
      case 'lowMileage':
        return {
          text: w.sum.lowMileage(a.name, a.kmpl.toFixed(2), a.fleetKmpl.toFixed(2)),
          tone: 'attention',
          onClick: () => go.vehicle(a.vehicleId),
        };
      case 'lossCustomer':
        return {
          text: w.sum.lossCustomer(a.name, abs(a.amount)),
          tone: 'critical',
          onClick: () => go.customer(a.partyId),
        };
      case 'thinCustomer':
        return {
          text: w.sum.thinCustomer(a.name, a.pct.toFixed(1), a.fleetPct.toFixed(1)),
          tone: 'attention',
          onClick: () => go.customer(a.partyId),
        };
      case 'bigDue':
        return {
          text: w.sum.bigDue(a.name, inr(a.due), formatDate(a.since)),
          tone: 'attention',
          onClick: () => go.tab('customers'),
        };
      case 'marginDown':
        return {
          text: w.sum.marginDown(a.now.toFixed(2), a.before.toFixed(2)),
          tone: 'attention',
          onClick: () => go.tab('months'),
        };
    }
  };
  return (
    <Section title={w.sum.attentionTitle}>
      {items.length === 0 ? (
        <div className="px-6">
          <p className="text-[14px]" style={{ color: 'var(--text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--status-ready)' }}>
              ✓{' '}
            </span>
            {w.sum.allGood}
          </p>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {w.sum.allGoodWhy}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col px-3">
          {items.map((a, i) => {
            const l = line(a);
            const colour = l.tone === 'critical' ? 'var(--status-critical)' : 'var(--status-attention)';
            return (
              <li key={`${a.kind}-${i}`}>
                <button type="button" onClick={l.onClick} className="flex min-h-11 w-full items-center gap-3 rounded-[var(--r-1)] px-3 py-2 text-left hover:bg-[var(--surface-selected)]">
                  {/* A mark and a colour, never colour alone (docs/WRITING.md rule 6). */}
                  <span aria-hidden="true" className="w-4 shrink-0 text-center text-[13px]" style={{ color: colour }}>
                    {l.tone === 'critical' ? '▼' : '!'}
                  </span>
                  <span className="min-w-0 flex-1 text-[14px]" style={{ color: 'var(--text-primary)' }}>
                    {l.text}
                  </span>
                  <span className="shrink-0 text-[13px]" style={{ color: 'var(--brand)' }}>
                    {w.sum.see} →
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/**
 * Profit per month as columns either side of a zero line: a loss month hangs
 * below it, red, with its figure in brackets. A column is a button, so a
 * month is a tap away from its trips.
 */
function MonthBars({ rows, monthLabel, onPick }: { rows: PlMonthRow[]; monthLabel: (m: string) => string; onPick: (month: string) => void }) {
  const w = useWords(plWords);
  const inr = useInrCompact();
  if (rows.length === 0) return null;
  const values = rows.map((r) => num(r.net));
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const H = 150;
  const best = rows.reduce((a, b) => (num(b.net) > num(a.net) ? b : a));
  return (
    <Section caption={w.sum.trendCaption} title={w.sum.trendTitle}>
      <div className="overflow-x-auto px-6 pb-1">
        <p className="sr-only">{w.sum.trendSummary(monthLabel(best.month), inr(best.net))}</p>
        <div className="flex min-w-max items-stretch gap-2 sm:min-w-0">
          {rows.map((r) => {
            const v = num(r.net);
            const loss = v < 0;
            const h = (Math.abs(v) / span) * H;
            return (
              <button
                key={r.month}
                type="button"
                onClick={() => onPick(r.month)}
                className="group flex min-w-[64px] flex-1 flex-col items-center rounded-[var(--r-1)] px-1 pt-1 hover:bg-[var(--surface-selected)]"
                aria-label={`${monthLabel(r.month)}: ${loss ? w.tiles.loss : w.tiles.profit} ${inr(loss ? r.net.slice(1) : r.net)}`}
              >
                <div className="relative w-full" style={{ height: (top / span) * H + 18 }}>
                  {!loss && (
                    <>
                      <span
                        className="num absolute inset-x-0 text-center text-[12px] tabular-nums"
                        style={{
                          bottom: h + 2,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {inr(r.net)}
                      </span>
                      <span className="absolute bottom-0 left-1/2 w-3/5 max-w-[44px] -translate-x-1/2 rounded-t-[2px]" style={{ height: h, background: 'var(--brand)' }} />
                    </>
                  )}
                </div>
                <div className="w-full" style={{ borderTop: '1px solid var(--border-strong)' }} />
                <div
                  className="relative w-full"
                  style={{
                    height: (-bottom / span) * H + (bottom < 0 ? 18 : 0),
                  }}
                >
                  {loss && (
                    <>
                      <span
                        className="absolute left-1/2 top-0 w-3/5 max-w-[44px] -translate-x-1/2 rounded-b-[2px]"
                        style={{
                          height: h,
                          background: 'var(--status-critical)',
                        }}
                      />
                      <span className="num absolute inset-x-0 text-center text-[12px] tabular-nums" style={{ top: h + 2, color: 'var(--status-critical)' }}>
                        ({inr(r.net.slice(1))})
                      </span>
                    </>
                  )}
                </div>
                <span className="mt-1 text-[12px]" style={{ color: 'var(--text-primary)' }}>
                  {monthLabel(r.month)}
                </span>
                <span className="num pb-1 text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                  {r.profitPct === null ? '—' : `${r.profitPct.toFixed(1)}%`}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

const TOP = 6;

/**
 * Best first, worst last, with a bar either side of zero: the leaderboard
 * that says which truck or customer to want more of. The worst are kept in
 * view even when the list is cut, because they are the point.
 */
function Ranked({
  title,
  rows,
  onPick,
  onAll,
}: {
  title: string;
  rows: {
    id: string;
    name: string;
    sub: string | null;
    trips: number;
    net: string;
    pct: number | null;
  }[];
  onPick: (id: string) => void;
  onAll: () => void;
}) {
  const w = useWords(plWords);
  const inr = useInrCompact();
  if (rows.length === 0) return null;
  const shown = rows.length <= TOP ? rows : [...rows.slice(0, TOP - 2), ...rows.slice(-2)];
  const most = Math.max(1, ...rows.map((r) => Math.abs(num(r.net))));
  const anyLoss = rows.some((r) => neg(r.net));
  return (
    <Section
      caption={w.sum.tapHint}
      title={title}
      actions={
        rows.length > shown.length ? (
          <button type="button" onClick={onAll} className="min-h-11 text-[13px]" style={{ color: 'var(--brand)' }}>
            {w.sum.seeAll(rows.length)} →
          </button>
        ) : undefined
      }
    >
      <ol className="flex flex-col px-3">
        {shown.map((r, i) => {
          const loss = neg(r.net);
          const width = (Math.abs(num(r.net)) / most) * 100;
          const gap = rows.length > shown.length && i === TOP - 2;
          return (
            <li
              key={r.id}
              style={
                gap
                  ? {
                      borderTop: '1px dashed var(--border-default)',
                      marginTop: 4,
                      paddingTop: 4,
                    }
                  : undefined
              }
            >
              <button
                type="button"
                onClick={() => onPick(r.id)}
                className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-[var(--r-1)] px-3 py-1.5 text-left hover:bg-[var(--surface-selected)] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_6.5rem]"
              >
                <span className="col-start-1 row-start-1 min-w-0">
                  <span className="block truncate text-[14px]" style={{ color: 'var(--text-primary)' }}>
                    {r.name}
                  </span>
                  <span className="block truncate text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {w.sum.rowLine(w.tiles.trips(r.trips), r.pct === null ? null : r.pct.toFixed(1))}
                  </span>
                </span>
                <span className="col-span-2 col-start-1 row-start-2 flex h-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1" aria-hidden="true">
                  {anyLoss && (
                    <span className="flex w-1/4 justify-end">
                      {loss && (
                        <span
                          className="h-2 rounded-l-[2px]"
                          style={{
                            width: `${width}%`,
                            background: 'var(--status-critical)',
                          }}
                        />
                      )}
                    </span>
                  )}
                  <span className="flex flex-1" style={anyLoss ? { borderLeft: '1px solid var(--border-strong)' } : undefined}>
                    {!loss && (
                      <span
                        className="h-2 rounded-r-[2px]"
                        style={{
                          width: `${width}%`,
                          background: 'var(--brand)',
                        }}
                      />
                    )}
                  </span>
                </span>
                <span
                  className="num col-start-2 row-start-1 text-right text-[14px] tabular-nums sm:col-start-3"
                  style={{
                    color: loss ? 'var(--status-critical)' : 'var(--text-primary)',
                  }}
                >
                  {loss ? `(${inr(r.net.slice(1))})` : inr(r.net)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
