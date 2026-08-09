import { PRODUCTS, VEHICLES } from './data.js';
import { between, makeRng, NOW } from './seed.js';

/**
 * History.
 *
 * Every chart in the product needs a past, and the screens must agree about
 * it: the executive's revenue trend and the sales board's lane trend have to be
 * the same numbers or the MD stops trusting both. So the series live here, are
 * generated once from a fixed seed, and are read rather than recomputed.
 *
 * In the real system each of these is a view named on the chart's as-of stamp
 * (`v_dispatch_daily`, `v_fleet_uptime_daily`, …), which is why the shapes here
 * are day-grained rows rather than pre-bucketed chart input.
 */

const rng = makeRng(77213);

export interface DailyPoint {
  /** IST calendar date, YYYY-MM-DD. */
  date: string;
  label: string;
  revenue: number;
  margin: number;
  dispatchedUnits: number;
  producedUnits: number;
  uptimePct: number;
  /** Loads that came back loaded. Zero revenue, full cost. */
  returnedLoads: number;
  collectedVerified: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function istDate(daysAgo: number): { iso: string; label: string; weekday: number } {
  const d = new Date(NOW.getTime() - daysAgo * 86_400_000 + 330 * 60_000);
  const iso = d.toISOString().slice(0, 10);
  const day = d.getUTCDate();
  return { iso, label: `${String(day).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`, weekday: d.getUTCDay() };
}

/** 30 days, oldest first. */
export const DAILY: DailyPoint[] = Array.from({ length: 30 }, (_, i) => {
  const daysAgo = 29 - i;
  const { iso, label, weekday } = istDate(daysAgo);

  // Sunday is a half day at the plant and the lorries mostly stand — without
  // this the trend looks like a random walk instead of a working week.
  const sunday = weekday === 0;
  const seasonal = sunday ? 0.28 : 1;

  const dispatched = Math.round(between(rng, 150, 215, 1) * seasonal * 10) / 10;
  const produced = Math.round((dispatched + between(rng, -18, 42, 1)) * 10) / 10;
  const revenue = Math.round(dispatched * between(rng, 5600, 6700, 0));
  const margin = Math.round(revenue * between(rng, 0.26, 0.41, 3));

  return {
    date: iso,
    label,
    revenue,
    margin,
    dispatchedUnits: dispatched,
    producedUnits: produced,
    uptimePct: Math.round((sunday ? between(rng, 38, 52, 1) : between(rng, 58, 79, 1)) * 10) / 10,
    returnedLoads: rng() > 0.72 ? Math.floor(between(rng, 1, 4)) : 0,
    collectedVerified: Math.round(revenue * between(rng, 0.4, 1.5, 3)),
  };
});

export const LAST_14 = DAILY.slice(-14);

/**
 * Per-vehicle km/l history, tank to tank.
 *
 * Only full-tank fills produce a usable reading, so these are sparse by
 * construction — six to nine points a month per vehicle, not thirty. A chart
 * that pretends otherwise is inventing data.
 */
export interface MileagePoint {
  vehicleId: string;
  date: string;
  label: string;
  kmpl: number;
}

export const MILEAGE: MileagePoint[] = VEHICLES.flatMap((v) => {
  if (v.lastKmpl === null) return [];
  // A vehicle whose latest reading is well under benchmark got there over a
  // fortnight, not overnight — the drift is the signal worth plotting.
  const drifting = v.lastKmpl < v.benchmarkKmpl * 0.86;
  const count = Math.floor(between(rng, 6, 10));
  return Array.from({ length: count }, (_, i) => {
    const daysAgo = Math.round(((count - 1 - i) / count) * 28);
    const { iso, label } = istDate(daysAgo);
    const progress = i / Math.max(1, count - 1);
    const base = drifting ? v.benchmarkKmpl - (v.benchmarkKmpl - v.lastKmpl!) * progress : v.benchmarkKmpl;
    return {
      vehicleId: v.id,
      date: iso,
      label,
      kmpl: Math.round((base + between(rng, -0.22, 0.22, 2)) * 100) / 100,
    };
  });
});

export function mileageFor(vehicleId: string): MileagePoint[] {
  return MILEAGE.filter((m) => m.vehicleId === vehicleId);
}

/**
 * Product mix over the last 30 days, in trade units — what the business
 * actually sold, not what it produced.
 */
export const PRODUCT_MIX: { code: string; label: string; units: number }[] = PRODUCTS.map((p, i) => ({
  code: p.code,
  label: p.label,
  units: Math.round(between(rng, i < 3 ? 900 : 200, i < 3 ? 2600 : 900, 0)),
})).sort((a, b) => b.units - a.units);

/**
 * Driver attendance, 28 days × the first 14 drivers — enough to show the shape
 * without turning the screen into a wall.
 */
export type AttendanceMark = 'present' | 'on_trip' | 'rest' | 'absent' | 'leave' | null;

export interface AttendanceCell {
  driverId: string;
  driverName: string;
  date: string;
  label: string;
  mark: AttendanceMark;
}

export function attendanceGrid(driverIds: string[], days = 28): AttendanceCell[] {
  const grid = makeRng(4451);
  const out: AttendanceCell[] = [];
  for (const id of driverIds) {
    for (let d = days - 1; d >= 0; d--) {
      const { iso, label, weekday } = istDate(d);
      const roll = grid();
      // Older than three weeks, attendance was often simply not written down.
      // That gap is real and the grid shows it as blank rather than as present.
      const mark: AttendanceMark =
        d > 21 && roll > 0.72
          ? null
          : weekday === 0
            ? roll > 0.55
              ? 'rest'
              : 'present'
            : roll > 0.93
              ? 'absent'
              : roll > 0.88
                ? 'leave'
                : roll > 0.42
                  ? 'on_trip'
                  : 'present';
      out.push({ driverId: id, driverName: id, date: iso, label, mark });
    }
  }
  return out;
}

/** Downtime causes over 30 days, biggest first — a Pareto of what stops trucks. */
export const DOWNTIME_CAUSES = [
  { label: 'Tyre burst / puncture', hours: 148 },
  { label: 'No load allotted', hours: 121 },
  { label: 'Scheduled service', hours: 96 },
  { label: 'Gearbox & clutch', hours: 74 },
  { label: 'Driver unavailable', hours: 61 },
  { label: 'Electrical', hours: 38 },
  { label: 'Document expired', hours: 27 },
  { label: 'Hydraulics', hours: 19 },
];
