import type { PlTotals } from '@linck/domain';
import { Chip, KpiTile, TileRow } from '@linck/ui';
import { useInrCompact } from '../../i18n/format.js';
import { useWords } from '../../i18n/words.js';
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
}: {
  value: FilterState;
  onChange: (next: FilterState) => void;
  vehicles?: { id: string; label: string }[] | undefined;
  customers?: { id: string; label: string }[] | undefined;
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

/** The four tiles above a list or report: sales, profit, what the road cost, what is due. */
export function PlTiles({ total, asOf }: { total: PlTotals; asOf: string }) {
  const w = useWords(plWords);
  const inr = useInrCompact();
  const loss = negative(total.net);
  const stamp = { asOf, source: w.title, freshness: 'live' as const };
  return (
    <TileRow className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile eyebrow={w.tiles.sales} value={inr(total.sales)} delta={{ text: w.tiles.trips(total.trips) }} {...stamp} />
      <KpiTile
        eyebrow={loss ? w.tiles.loss : w.tiles.profit}
        value={inr(loss ? total.net.slice(1) : total.net)}
        hero
        delta={{
          text: total.profitPct === null ? w.tiles.noSales : w.tiles.ofSales(total.profitPct.toFixed(2)),
          tone: loss ? 'critical' : 'neutral',
        }}
        {...stamp}
      />
      <KpiTile
        eyebrow={w.tiles.enRoute}
        value={inr(total.totalEnRoute)}
        delta={{ text: w.tiles.km(total.distanceKm.toLocaleString('en-IN'), total.mileageKmpl === null ? null : total.mileageKmpl.toFixed(2)) }}
        {...stamp}
      />
      <KpiTile
        eyebrow={w.tiles.customerDue}
        value={inr(total.customerDue)}
        delta={{ text: `${w.tiles.vendorDue}: ${inr(total.vendorDue)}`, tone: negative(total.vendorDue) ? 'neutral' : 'neutral' }}
        {...stamp}
      />
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
