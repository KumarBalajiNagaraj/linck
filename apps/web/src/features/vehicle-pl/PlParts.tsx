import { useCallback } from 'react';
import type { PlTotals } from '@linck/domain';
import { Chip, KpiTile, TileRow } from '@linck/ui';
import { useInrCompact } from '../../i18n/format.js';
import { useWords } from '../../i18n/words.js';
import { change, type PreviousRange } from './insights.js';
import { todayIso } from './plStore.js';
import { plWords } from './words.js';

/** The form controls' look, as the fuel entry screen has it: 44px on touch, 34px with a mouse. */
export const CTRL = 'h-11 w-full min-w-0 px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[14px]';
export const FIELD_BOX: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

export type PeriodKey = 'all' | 'thisMonth' | 'lastMonth' | 'last3' | 'fy';
export const PERIODS: PeriodKey[] = ['all', 'thisMonth', 'lastMonth', 'last3', 'fy'];

export interface FilterState {
  period: PeriodKey | 'custom';
  from: string;
  to: string;
  q: string;
  vehicleId: string;
  customerId: string;
}

export const NO_FILTER: FilterState = { period: 'all', from: '', to: '', q: '', vehicleId: '', customerId: '' };

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** A period's first and last day, against the business date of today. */
export function periodRange(key: PeriodKey, today = todayIso()): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  if (key === 'thisMonth') return { from: iso(y, m - 1, 1), to: today };
  if (key === 'lastMonth') return { from: iso(y, m - 2, 1), to: iso(y, m - 1, 0) };
  if (key === 'last3') return { from: iso(y, m - 3, 1), to: today };
  if (key === 'fy') return { from: iso(m >= 4 ? y : y - 1, 3, 1), to: today };
  return { from: '', to: '' };
}

export function FilterBar({
  value,
  onChange,
  vehicles,
  customers,
  extra,
}: {
  value: FilterState;
  onChange: (next: FilterState) => void;
  vehicles?: { id: string; label: string }[] | undefined;
  customers?: { id: string; label: string }[] | undefined;
  /** A toggle that belongs with the period chips: "Losses only". */
  extra?: React.ReactNode;
}) {
  const w = useWords(plWords);
  const pickPeriod = (period: PeriodKey) => onChange({ ...value, period, ...periodRange(period) });
  return (
    <div className="flex flex-col gap-2 px-4 py-3 md:px-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="flex flex-wrap gap-1.5">
        {PERIODS.map((p) => (
          <Chip key={p} active={value.period === p} onClick={() => pickPeriod(p)}>
            {w.period[p]}
          </Chip>
        ))}
        {extra ? (
          <>
            <span aria-hidden="true" className="mx-1 w-px self-stretch" style={{ background: 'var(--border-default)' }} />
            {extra}
          </>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-end">
        <label className="col-span-2 flex min-w-0 flex-col gap-1 md:w-[300px]">
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {w.search}
          </span>
          <input
            type="search"
            className={CTRL}
            style={FIELD_BOX}
            placeholder={w.searchHint}
            value={value.q}
            onChange={(e) => onChange({ ...value, q: e.target.value })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 md:w-[150px]">
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {w.from}
          </span>
          <input type="date" className={CTRL} style={FIELD_BOX} value={value.from} onChange={(e) => onChange({ ...value, period: 'custom', from: e.target.value })} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 md:w-[150px]">
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {w.to}
          </span>
          <input type="date" className={CTRL} style={FIELD_BOX} value={value.to} onChange={(e) => onChange({ ...value, period: 'custom', to: e.target.value })} />
        </label>
        {vehicles && (
          <label className="flex min-w-0 flex-col gap-1 md:w-[190px]">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {w.col.vehicle}
            </span>
            <select className={CTRL} style={FIELD_BOX} value={value.vehicleId} onChange={(e) => onChange({ ...value, vehicleId: e.target.value })}>
              <option value="">{w.allVehicles}</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {customers && (
          <label className="flex min-w-0 flex-col gap-1 md:w-[220px]">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {w.col.customer}
            </span>
            <select className={CTRL} style={FIELD_BOX} value={value.customerId} onChange={(e) => onChange({ ...value, customerId: e.target.value })}>
              <option value="">{w.allCustomers}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

const negative = (money: string) => money.startsWith('-');

/** The words for the period before: "vs same days last month". */
export function useAgainst() {
  const w = useWords(plWords);
  return useCallback((p: PreviousRange) => (p.key === 'daysBefore' ? w.against.daysBefore(p.days) : w.against[p.key]), [w]);
}

/** The period to compare with, and the words that name it ("vs same days last month"). */
export interface Comparison {
  totals: PlTotals;
  against: string;
}

/**
 * "▲ ₹2.10 L (12.3%) vs same days last month". The arrow is the mark, so a
 * rise and a fall read apart without colour; a fall in profit alone spends
 * the attention colour, because that is the figure the owner acts on.
 */
export function useChangeLine() {
  const w = useWords(plWords);
  const inr = useInrCompact();
  return (now: string, before: string, against: string): { text: string; fell: boolean } => {
    const c = change(now, before);
    if (c.direction === 'same') return { text: w.same(against), fell: false };
    const arrow = c.direction === 'up' ? '▲' : '▼';
    const amount = inr(c.delta.startsWith('-') ? c.delta.slice(1) : c.delta);
    return { text: w.changeLine(arrow, amount, c.pct === null ? null : Math.abs(c.pct).toFixed(1), against), fell: c.direction === 'down' };
  };
}

/** The four tiles above a list or report: sales, profit, what the road cost, what is due — each set against the last period where there is one. */
export function PlTiles({ total, asOf, previous }: { total: PlTotals; asOf: string; previous?: Comparison | null | undefined }) {
  const w = useWords(plWords);
  const inr = useInrCompact();
  const changeLine = useChangeLine();
  const loss = negative(total.net);
  const stamp = { asOf, source: w.title, freshness: 'live' as const };
  const salesChange = previous ? changeLine(total.sales, previous.totals.sales, previous.against) : null;
  const profitChange = previous ? changeLine(total.net, previous.totals.net, previous.against) : null;
  const ofSales = total.profitPct === null ? w.tiles.noSales : w.tiles.ofSales(total.profitPct.toFixed(2));
  return (
    <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile eyebrow={w.tiles.sales} value={inr(total.sales)} delta={{ text: salesChange ? `${w.tiles.trips(total.trips)} · ${salesChange.text}` : w.tiles.trips(total.trips) }} {...stamp} />
      <KpiTile
        eyebrow={loss ? w.tiles.loss : w.tiles.profit}
        value={inr(loss ? total.net.slice(1) : total.net)}
        hero
        delta={{
          text: profitChange ? `${ofSales} · ${profitChange.text}` : ofSales,
          tone: loss ? 'critical' : profitChange?.fell ? 'attention' : 'neutral',
        }}
        {...stamp}
      />
      <KpiTile
        eyebrow={w.tiles.enRoute}
        value={inr(total.totalEnRoute)}
        delta={{ text: w.tiles.km(total.distanceKm.toLocaleString('en-IN'), total.mileageKmpl === null ? null : total.mileageKmpl.toFixed(2)) }}
        {...stamp}
      />
      <KpiTile eyebrow={w.tiles.customerDue} value={inr(total.customerDue)} delta={{ text: `${w.tiles.vendorDue}: ${inr(total.vendorDue)}` }} {...stamp} />
    </TileRow>
  );
}

/** ₹10,800.00 with the Indian grouping, exact to the paisa. */
export function inrExact(value: string): string {
  const [whole = '0', frac = '00'] = value.replace('-', '').split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `₹${rest ? `${rest},${last3}` : last3}.${frac.padEnd(2, '0')}`;
}

/** A money figure as the accounting columns write it: a loss in brackets, red. Exact unless `compact`. */
export function Signed({ value, strong, compact }: { value: string; strong?: boolean; compact?: boolean }) {
  const inr = useInrCompact();
  const loss = negative(value);
  const text = compact ? inr(loss ? value.slice(1) : value) : inrExact(value);
  return (
    <span className={`num tabular-nums ${strong ? 'font-semibold' : ''}`} style={{ color: loss ? 'var(--status-critical)' : undefined }}>
      {loss ? `(${text})` : text}
    </span>
  );
}
